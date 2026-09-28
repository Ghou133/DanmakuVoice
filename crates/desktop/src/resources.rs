//! Only the UI becomes idle in the background; the Rust live/audio tasks continue.
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{Emitter, Manager, WebviewWindow};

pub struct ResourcePolicy(AtomicU8);

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self(AtomicU8::new(2))
    }
}

pub fn active(window: &WebviewWindow) -> bool {
    let state = window.state::<ResourcePolicy>().0.load(Ordering::Relaxed);
    if state < 2 {
        return state == 1;
    }
    query_active(window)
}

fn query_active(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    let focused = window.hwnd().is_ok_and(|handle| {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GA_ROOTOWNER, GetAncestor, GetForegroundWindow,
        };
        // SAFETY: Read-only window identity queries; no window handle is retained.
        unsafe { GetAncestor(GetForegroundWindow(), GA_ROOTOWNER) == handle.0 }
    });
    #[cfg(not(windows))]
    let focused = window.is_focused().unwrap_or(false);
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true) && focused
}

pub fn apply(window: &WebviewWindow, focused: Option<bool>) {
    // Focused events can precede the dispatcher's cached is_focused value.
    // Their explicit value is authoritative, including native titlebar focus.
    let foreground = focused.unwrap_or_else(|| query_active(window));
    let policy = window.state::<ResourcePolicy>();
    if policy.0.swap(u8::from(foreground), Ordering::Relaxed) == u8::from(foreground) {
        return;
    }
    let _ = window.emit("resource-mode", foreground);
    danmakuvoice_engine::diagnostics::record(
        danmakuvoice_engine::diagnostics::DiagnosticCode::UiActivity,
        Some(u64::from(foreground)),
    );
    #[cfg(windows)]
    let _ = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
        };
        use windows_core::Interface;
        // SAFETY: Tauri runs this closure on the owning WebView UI thread. We
        // query an optional supported interface; old runtimes retain normal behavior.
        unsafe {
            if let Ok(core) = webview.controller().CoreWebView2()
                && let Ok(memory) = core.cast::<ICoreWebView2_19>()
            {
                let level = if foreground {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                };
                let applied = memory.SetMemoryUsageTargetLevel(level).is_ok();
                danmakuvoice_engine::diagnostics::record(
                    danmakuvoice_engine::diagnostics::DiagnosticCode::UiMemoryTarget,
                    Some(if applied { u64::from(!foreground) } else { 2 }),
                );
            }
        }
    });
}

/// Await WebView2's actual completion, rather than treating an enqueued clear as success.
pub async fn clear_browsing_data(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::sync::{Arc, Mutex};
        use webview2_com::{
            ClearBrowsingDataCompletedHandler,
            Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2Profile2},
        };
        use windows_core::Interface;
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let sender = Arc::new(Mutex::new(Some(sender)));
        window
            .with_webview(move |platform| {
                let callback_sender = sender.clone();
                // SAFETY: The closure and COM completion run on the WebView UI thread.
                let result = unsafe {
                    (|| -> windows_core::Result<()> {
                        let core = platform.controller().CoreWebView2()?;
                        let profile = core
                            .cast::<ICoreWebView2_13>()?
                            .Profile()?
                            .cast::<ICoreWebView2Profile2>()?;
                        let callback =
                            ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                                if let Ok(mut slot) = callback_sender.lock()
                                    && let Some(sender) = slot.take()
                                {
                                    let _ = sender.send(result.map_err(|error| error.to_string()));
                                }
                                Ok(())
                            }));
                        profile.ClearBrowsingDataAll(&callback)
                    })()
                };
                if let Err(error) = result
                    && let Ok(mut slot) = sender.lock()
                    && let Some(sender) = slot.take()
                {
                    let _ = sender.send(Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(30), receiver)
            .await
            .map_err(|_| "网页缓存清除尚未完成，请稍后重试".to_owned())?
            .map_err(|_| "网页缓存清除回调已关闭".to_owned())?
            .map_err(|error| format!("无法清除网页缓存：{error}"))
    }
    #[cfg(not(windows))]
    {
        window
            .clear_all_browsing_data()
            .map_err(|error| error.to_string())
    }
}
