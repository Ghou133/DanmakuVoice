#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod embedded_ffmpeg;
mod local_service;
mod resources;
#[cfg(windows)]
mod startup;
mod updates;

use app::Application;
use danmakuvoice_engine::tts::fish;
use serde_json::Value;
use std::{
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

#[derive(Debug)]
struct MissingWebView2Runtime;

#[derive(Default)]
struct StartupWindowState {
    page_loaded: bool,
    native_ready: bool,
    shown: bool,
}

fn show_startup_window(
    window: &tauri::WebviewWindow,
    state: &Arc<Mutex<StartupWindowState>>,
) -> tauri::Result<()> {
    let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
    if state.page_loaded && state.native_ready && !state.shown {
        window.show()?;
        state.shown = true;
    }
    Ok(())
}

fn is_app_origin(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

impl std::fmt::Display for MissingWebView2Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("未检测到可用的 Microsoft Edge WebView2 Runtime")
    }
}

impl std::error::Error for MissingWebView2Runtime {}

// The bundled page installs its exit listener before the initial snapshot.
// A close during WebView startup (or a reload) has no listener to receive an
// emitted event, so that narrow interval needs a native shutdown path.
#[derive(Clone, Default)]
struct ExitBridge(Arc<Mutex<ExitBridgeState>>);

#[derive(Default)]
struct ExitBridgeState {
    page_generation: u64,
    frontend_ready: bool,
    next_request_id: u64,
    pending: ExitPending,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum ExitPending {
    #[default]
    None,
    Frontend(u64),
    Finishing(u64),
    Native(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitRoute {
    Frontend(u64),
    Native(u64),
    Pending,
}

impl ExitBridge {
    fn page_started(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.page_generation = state.page_generation.wrapping_add(1);
        state.frontend_ready = false;
        if matches!(state.pending, ExitPending::Frontend(_)) {
            state.pending = ExitPending::None;
        }
    }

    fn page_generation(&self) -> u64 {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .page_generation
    }

    fn frontend_ready_if(&self, generation: u64) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.page_generation == generation {
            state.frontend_ready = true;
        }
    }

    fn begin_request(&self) -> ExitRoute {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.pending != ExitPending::None {
            return ExitRoute::Pending;
        }
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let id = state.next_request_id;
        if state.frontend_ready {
            state.pending = ExitPending::Frontend(id);
            ExitRoute::Frontend(id)
        } else {
            state.pending = ExitPending::Native(id);
            ExitRoute::Native(id)
        }
    }

    fn accept_frontend_result(&self, id: u64, saved: bool) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.pending != ExitPending::Frontend(id) {
            return false;
        }
        state.pending = if saved {
            ExitPending::Finishing(id)
        } else {
            ExitPending::None
        };
        true
    }

    fn expire_frontend_request(&self, id: u64) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.pending == ExitPending::Frontend(id) {
            state.pending = ExitPending::None;
            true
        } else {
            false
        }
    }

    fn abort_request(&self, id: u64) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if matches!(
            state.pending,
            ExitPending::Frontend(value)
                | ExitPending::Finishing(value)
                | ExitPending::Native(value)
                if value == id
        ) {
            state.pending = ExitPending::None;
        }
    }
}

#[tauri::command]
async fn snapshot(
    state: tauri::State<'_, Application>,
    exit_bridge: tauri::State<'_, ExitBridge>,
    config_revision: Option<u64>,
) -> Result<Value, String> {
    let generation = exit_bridge.page_generation();
    let state = state.inner().clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || state.snapshot_since(config_revision))
            .await
            .map_err(|_| "无法读取程序状态".to_string())??;
    exit_bridge.frontend_ready_if(generation);
    Ok(snapshot)
}

#[tauri::command]
async fn check_update(
    state: tauri::State<'_, Application>,
    updates: tauri::State<'_, updates::UpdateChecker>,
) -> Result<updates::UpdateInfo, String> {
    updates.check(state.network_disabled()?).await
}

#[tauri::command]
fn ui_activity(window: tauri::WebviewWindow) -> bool {
    resources::active(&window)
}

#[tauri::command]
async fn finish_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, Application>,
    exit_bridge: tauri::State<'_, ExitBridge>,
    saved: bool,
    request_id: u64,
) -> Result<(), String> {
    if !exit_bridge.accept_frontend_result(request_id, saved) {
        show_window(&app);
        return Err("退出请求已过期，请重新点击退出".into());
    }
    if !saved {
        show_window(&app);
        return Ok(());
    }
    if let Err(error) = state.dispatch("queue.stop", serde_json::json!({})).await {
        exit_bridge.abort_request(request_id);
        show_window(&app);
        return Err(error);
    }
    state.stop_owned_local_services();
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn dispatch(
    app: tauri::AppHandle,
    state: tauri::State<'_, Application>,
    action: String,
    payload: Option<Value>,
    updates: tauri::State<'_, updates::UpdateChecker>,
) -> Result<Value, String> {
    let payload = payload.unwrap_or_else(|| serde_json::json!({}));
    if action == "external.open" {
        let page = payload.get("page").and_then(Value::as_str).unwrap_or("");
        let update;
        let url = match page {
            "fish_keys" => fish::API_KEYS_URL,
            "fish_discovery" => fish::DISCOVERY_URL,
            "project" => updates::REPOSITORY,
            "releases" => updates::RELEASES,
            "update_download" => {
                update = updates.check(state.network_disabled()?).await?;
                update
                    .download_url
                    .as_deref()
                    .ok_or("暂无可下载的新版，请打开发布页面")?
            }
            _ => return Err("不支持打开此页面".into()),
        };
        open_official_page(url)?;
        return state.snapshot();
    }
    if action == "data.clear" {
        if payload.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return Err("清除应用数据需要明确确认".into());
        }
        let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
        resources::clear_browsing_data(&window).await?;
    }
    let refresh_zoom = action == "data.clear"
        || (action == "preferences.save" && payload.pointer("/preferences/scale").is_some());
    let result = state.dispatch(&action, payload).await?;
    if matches!(action.as_str(), "preferences.save" | "data.clear")
        && let Some(window) = app.get_webview_window("main")
    {
        window
            .set_theme(native_theme(&result))
            .map_err(|e| e.to_string())?;
        window
            .set_background_color(Some(background_color(
                window.theme().map_err(|e| e.to_string())?,
            )))
            .map_err(|e| e.to_string())?;
        if refresh_zoom {
            window
                .set_zoom(ui_zoom(&result))
                .map_err(|e| format!("设置已保存，但界面缩放尚未生效：{e}"))?;
        }
    }
    Ok(result)
}

#[cfg(windows)]
fn open_official_page(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        Err("无法打开官方网站，请检查默认浏览器".into())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn open_official_page(_url: &str) -> Result<(), String> {
    Err("此功能需要 Windows".into())
}

fn main() {
    if let Err(error) = run() {
        #[cfg(windows)]
        if !std::env::args_os()
            .skip(1)
            .any(|arg| arg == "--fish-key-stdin")
        {
            if error.downcast_ref::<MissingWebView2Runtime>().is_some() {
                show_missing_webview2_runtime();
            } else {
                show_startup_error(&error.to_string());
            }
        }
        eprintln!("超绝可爱弹幕姬启动失败：{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--fish-key-stdin") {
        args.remove(0);
        return configure_fish_from_stdin(app::LaunchOptions::parse(args)?);
    }
    let options = app::LaunchOptions::parse(args)?;
    let window_title = if options.disable_network {
        "超绝可爱弹幕姬 · 离线测试"
    } else {
        "超绝可爱弹幕姬"
    };
    #[cfg(windows)]
    if !webview2_runtime_available() {
        return Err(Box::new(MissingWebView2Runtime));
    }
    let state = Application::new(options.data_dir, options.disable_network)?;
    let webview_data = state.data_dir()?.join("webview");
    let initial_snapshot = state.snapshot()?;
    let theme = native_theme(&initial_snapshot);
    let zoom = ui_zoom(&initial_snapshot);
    let appearance = initial_snapshot["preferences"]["appearance"]
        .as_str()
        .unwrap_or("system");
    let theme_script = format!(
        "window.__DANMAKUVOICE_STARTUP_THEME__ = {};",
        serde_json::json!({
            "appearance": appearance,
            "session": uuid::Uuid::new_v4().to_string(),
        })
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(ExitBridge::default())
        .manage(updates::UpdateChecker::default())
        .manage(resources::ResourcePolicy::default())
        .invoke_handler(tauri::generate_handler![
            snapshot,
            dispatch,
            finish_exit,
            ui_activity,
            check_update
        ])
        .setup(move |app| {
            let exit_bridge = app.state::<ExitBridge>().inner().clone();
            let startup = Arc::new(Mutex::new(StartupWindowState::default()));
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(PathBuf::from("index.html")),
            )
            .title(window_title)
            .inner_size(1040.0, 740.0)
            .min_inner_size(780.0, 580.0)
            .theme(theme)
            .background_color(background_color(theme.unwrap_or(tauri::Theme::Dark)))
            .visible(false)
            .center()
            .data_directory(webview_data)
            .initialization_script(theme_script)
            .on_page_load({
                let exit_bridge = exit_bridge.clone();
                let startup = startup.clone();
                move |window, payload| match payload.event() {
                    tauri::webview::PageLoadEvent::Started => exit_bridge.page_started(),
                    tauri::webview::PageLoadEvent::Finished
                        if is_app_origin(payload.url())
                            && matches!(payload.url().path(), "/" | "/index.html") =>
                    {
                        startup
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .page_loaded = true;
                        if let Err(error) = show_startup_window(&window, &startup) {
                            eprintln!("无法显示启动窗口：{error}");
                        }
                    }
                    _ => {}
                }
            })
            .on_navigation(is_app_origin)
            .build()?;
            window.set_background_color(Some(background_color(window.theme()?)))?;
            window.set_zoom(zoom)?;
            startup
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .native_ready = true;
            show_startup_window(&window, &startup)?;
            let startup_fallback = startup.clone();
            let fallback_window = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                startup_fallback
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .page_loaded = true;
                if let Err(error) = show_startup_window(&fallback_window, &startup_fallback) {
                    eprintln!("无法显示启动窗口：{error}");
                }
            });
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let Some(window) = handle.get_webview_window("main") {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        request_exit(&handle, &exit_bridge);
                    }
                    if let tauri::WindowEvent::ThemeChanged(theme) = event {
                        let _ = window.set_background_color(Some(background_color(*theme)));
                    }
                    if matches!(
                        event,
                        tauri::WindowEvent::Focused(_)
                            | tauri::WindowEvent::Resized(_)
                            | tauri::WindowEvent::CloseRequested { .. }
                    ) {
                        let focused = match event {
                            tauri::WindowEvent::Focused(value) => Some(*value),
                            _ => None,
                        };
                        resources::apply(&window, focused);
                    }
                }
            });
            resources::apply(&window, None);
            install_tray(app, startup, window_title)?;
            let state = app.state::<Application>().inner().clone();
            tauri::async_runtime::spawn(async move {
                state.refresh_bili_profile().await;
            });
            let state = app.state::<Application>().inner().clone();
            tauri::async_runtime::spawn(async move {
                state.auto_start_preferred_service().await;
            });
            let state = app.state::<Application>().inner().clone();
            tauri::async_runtime::spawn(async move {
                state.auto_connect_saved_room().await;
            });
            let state = app.state::<Application>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    state.reconcile_default_output().await;
                    state.retire_unused_auto_local_services().await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Application>().stop_owned_local_services();
            }
        });
    Ok(())
}

// Local setup path for an API key already supplied to the user. Reading from
// standard input keeps the key out of command lines, source, package files and
// ordinary configuration exports. The same read-only verification and DPAPI
// save path is used by the settings UI.
fn configure_fish_from_stdin(
    options: app::LaunchOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    if options.disable_network {
        return Err("Fish Audio 登录需要联网".into());
    }
    let mut secret = Zeroizing::new(String::new());
    std::io::stdin().read_to_string(&mut secret)?;
    let key = secret.trim_end_matches(['\r', '\n']);
    if key.is_empty() {
        return Err("标准输入中没有 Fish Audio API Key".into());
    }
    let application = Application::new(options.data_dir, false)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime
        .block_on(application.dispatch("fish.connect", serde_json::json!({"credential":key})))?;
    println!("Fish Audio 已验证并在本机加密保存");
    Ok(())
}

fn install_tray(
    app: &tauri::App,
    startup: Arc<Mutex<StartupWindowState>>,
    title: &str,
) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "断开直播并停止播报", true, None::<&str>)?;
    let exit = MenuItem::with_id(
        app,
        "exit",
        "退出并关闭本应用启动的 TTS",
        true,
        None::<&str>,
    )?;
    let force_exit = MenuItem::with_id(app, "force_exit", "强制退出…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stop, &exit, &force_exit])?;
    TrayIconBuilder::new()
        .icon(tauri::image::Image::new(
            include_bytes!("../icons/tray.rgba"),
            32,
            32,
        ))
        .tooltip(title)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event({
            let startup = startup.clone();
            move |tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    show_window_if_ready(tray.app_handle(), &startup);
                }
            }
        })
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_window_if_ready(app, &startup),
            "exit" => {
                show_window_if_ready(app, &startup);
                request_exit(app, &app.state::<ExitBridge>());
            }
            "force_exit" if confirm_force_exit() => app.exit(0),
            "stop" => {
                let handle = app.clone();
                let state = app.state::<Application>().inner().clone();
                let startup = startup.clone();
                tauri::async_runtime::spawn(async move {
                    let stopped = state.dispatch("queue.stop", serde_json::json!({})).await;
                    if stopped.is_err() {
                        show_window_if_ready(&handle, &startup);
                    }
                });
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn request_exit(app: &tauri::AppHandle, bridge: &ExitBridge) {
    match bridge.begin_request() {
        ExitRoute::Frontend(request_id) => {
            // The page flushes pending settings and calls finish_exit. An
            // unsuccessful save keeps the window open for the user's edits.
            if app
                .emit_to(
                    "main",
                    "exit-requested",
                    serde_json::json!({"request_id":request_id}),
                )
                .is_err()
            {
                bridge.abort_request(request_id);
                show_window(app);
            } else {
                // Emission success means the WebView accepted the event, not
                // that its JS listener is still alive after a reload/crash.
                // Make a later click possible without silently force exiting.
                let bridge = bridge.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    if bridge.expire_frontend_request(request_id) {
                        show_window(&app);
                    }
                });
            }
        }
        ExitRoute::Native(request_id) => {
            // Before the first snapshot, the page cannot have editable drafts.
            // Do not strand an owned TTS process when a close arrives this early.
            let app = app.clone();
            let bridge = bridge.clone();
            let state = app.state::<Application>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = state.dispatch("queue.stop", serde_json::json!({})).await {
                    bridge.abort_request(request_id);
                    show_window(&app);
                    show_exit_error(&error);
                    return;
                }
                state.stop_owned_local_services();
                app.exit(0);
            });
        }
        ExitRoute::Pending => {}
    }
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        resources::apply(&window, Some(true));
    }
}

fn show_window_if_ready(app: &tauri::AppHandle, startup: &Arc<Mutex<StartupWindowState>>) {
    if startup
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .shown
    {
        show_window(app);
    }
}

#[cfg(windows)]
fn show_exit_error(error: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let title: Vec<u16> = "超绝可爱弹幕姬无法退出\0".encode_utf16().collect();
    let message: Vec<u16> = format!(
        "停止播报失败，请重试；必要时可从托盘选择“强制退出”。\n\n{}\0",
        error.chars().take(500).collect::<String>()
    )
    .encode_utf16()
    .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}

#[cfg(not(windows))]
fn show_exit_error(error: &str) {
    eprintln!("超绝可爱弹幕姬无法退出：{error}");
}

fn native_theme(snapshot: &Value) -> Option<tauri::Theme> {
    match snapshot["preferences"]["appearance"].as_str() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    }
}

fn background_color(theme: tauri::Theme) -> tauri::window::Color {
    match theme {
        tauri::Theme::Dark => tauri::window::Color(0x14, 0x17, 0x1c, 255),
        tauri::Theme::Light => tauri::window::Color(0xf5, 0xf7, 0xfc, 255),
        _ => tauri::window::Color(0x14, 0x17, 0x1c, 255),
    }
}

fn ui_zoom(snapshot: &Value) -> f64 {
    snapshot["preferences"]["scale"]
        .as_f64()
        .filter(|scale| scale.is_finite())
        .map(|scale| scale.clamp(0.8, 1.4))
        .unwrap_or(1.0)
}

#[cfg(windows)]
fn webview2_runtime_available() -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows_core::{PCWSTR, PWSTR};
    use windows_sys::Win32::System::Com::CoTaskMemFree;

    let mut version = PWSTR::null();
    let found =
        unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }
            .is_ok()
            && !version.is_null();
    if !version.is_null() {
        unsafe { CoTaskMemFree(version.as_ptr().cast()) };
    }
    found
}

#[cfg(windows)]
fn show_missing_webview2_runtime() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_ICONINFORMATION, MB_YESNO, MessageBoxW,
    };
    let title: Vec<u16> = "超绝可爱弹幕姬需要 WebView2 Runtime\0"
        .encode_utf16()
        .collect();
    let message: Vec<u16> = "这台电脑尚未检测到可用的 Microsoft Edge WebView2 Runtime。\n\n是否打开微软官方下载页？安装后请重新启动超绝可爱弹幕姬。\0".encode_utf16().collect();
    if unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONINFORMATION,
        )
    } == IDYES
        && open_official_page("https://developer.microsoft.com/microsoft-edge/webview2/").is_err()
    {
        show_startup_error(
            "无法打开默认浏览器。请访问 developer.microsoft.com/microsoft-edge/webview2/ 下载运行时。",
        );
    }
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let title: Vec<u16> = "超绝可爱弹幕姬启动失败\0".encode_utf16().collect();
    let message: Vec<u16> = format!("{}\0", message.chars().take(600).collect::<String>())
        .encode_utf16()
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}

#[cfg(windows)]
fn confirm_force_exit() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO, MessageBoxW,
    };
    let title: Vec<u16> = "超绝可爱弹幕姬\0".encode_utf16().collect();
    let message: Vec<u16> =
        "强制退出会立即停止接收、播放和本应用启动的 TTS，未保存的设置可能丢失。确定退出？\0"
            .encode_utf16()
            .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDYES
    }
}

#[cfg(test)]
mod ui_zoom_tests {
    use super::ui_zoom;
    use serde_json::json;

    #[test]
    fn saved_ui_scale_applies_to_the_whole_webview_with_safe_bounds() {
        assert_eq!(ui_zoom(&json!({"preferences":{"scale":1.4}})), 1.4);
        assert_eq!(ui_zoom(&json!({"preferences":{"scale":0.5}})), 0.8);
        assert_eq!(ui_zoom(&json!({"preferences":{"scale":2.0}})), 1.4);
        assert_eq!(ui_zoom(&json!({"preferences":{}})), 1.0);
    }
}

#[cfg(test)]
mod exit_bridge_tests {
    use super::{ExitBridge, ExitRoute};

    #[test]
    fn closing_before_frontend_listener_uses_native_shutdown_once() {
        let bridge = ExitBridge::default();
        let ExitRoute::Native(request_id) = bridge.begin_request() else {
            panic!("page without a listener must use native shutdown");
        };
        assert_eq!(bridge.begin_request(), ExitRoute::Pending);
        bridge.abort_request(request_id);
        assert!(matches!(bridge.begin_request(), ExitRoute::Native(_)));
    }

    #[test]
    fn reload_invalidates_old_snapshot_and_allows_new_close_request() {
        let bridge = ExitBridge::default();
        let previous_page = bridge.page_generation();
        bridge.page_started();
        bridge.frontend_ready_if(previous_page);
        assert!(matches!(bridge.begin_request(), ExitRoute::Native(_)));

        let bridge = ExitBridge::default();
        let current_page = bridge.page_generation();
        bridge.frontend_ready_if(current_page);
        assert!(matches!(bridge.begin_request(), ExitRoute::Frontend(_)));
        bridge.page_started();
        assert!(matches!(bridge.begin_request(), ExitRoute::Native(_)));
    }

    #[test]
    fn cancelled_frontend_exit_can_be_requested_again() {
        let bridge = ExitBridge::default();
        bridge.frontend_ready_if(bridge.page_generation());
        let ExitRoute::Frontend(request_id) = bridge.begin_request() else {
            panic!("ready page must save through its listener");
        };
        assert!(bridge.accept_frontend_result(request_id, false));
        assert!(matches!(bridge.begin_request(), ExitRoute::Frontend(_)));
    }

    #[test]
    fn expired_request_does_not_accept_late_exit_or_clear_a_new_request() {
        let bridge = ExitBridge::default();
        bridge.frontend_ready_if(bridge.page_generation());
        let ExitRoute::Frontend(old_request) = bridge.begin_request() else {
            panic!("ready page must use its listener");
        };
        assert!(bridge.expire_frontend_request(old_request));
        assert!(!bridge.accept_frontend_result(old_request, true));
        let ExitRoute::Frontend(new_request) = bridge.begin_request() else {
            panic!("expired request must release retry entry");
        };
        assert_ne!(old_request, new_request);
        assert!(!bridge.expire_frontend_request(old_request));
        assert!(bridge.accept_frontend_result(new_request, true));
        assert!(!bridge.expire_frontend_request(new_request));
    }

    #[test]
    fn failed_native_stop_releases_pending_state_for_retry() {
        let bridge = ExitBridge::default();
        let ExitRoute::Native(request_id) = bridge.begin_request() else {
            panic!("early close must use native shutdown");
        };
        bridge.abort_request(request_id);
        assert!(matches!(bridge.begin_request(), ExitRoute::Native(_)));
    }
}
