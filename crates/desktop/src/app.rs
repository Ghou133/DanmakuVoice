//! Application orchestration shared by the local WebView commands and tray.
//! The engine owns rules, credentials, live packets and the single playback FIFO.
#[path = "broadcast.rs"]
mod broadcast;
use crate::embedded_ffmpeg;
use crate::local_service::{self, Endpoint, Health, Kind, LocalServices};
use crate::overlay::{AssetLoader, OverlayHub, OverlayServer};
use base64::Engine;
use danmakuvoice_engine::{
    audio::{self, AudioOutput},
    bilibili::{BiliAccountProfile, BiliSession, QrChallenge, QrLoginClient, QrPoll, RoomState},
    diagnostics,
    legacy::{self, LegacyPreview},
    live::{
        LIVE_RECENT_EVENT_LIMIT, LiveController, LiveEventOutcome, LiveSnapshot, ProcessedLiveEvent,
    },
    migration::{self, LegacyImportOptions},
    model::{EventKind, LiveEvent, Provider, VoiceBinding, VoicePreset},
    playback::{PlaybackExecutor, PreparedPlayback},
    rules::{RulePreview, RuleSet},
    scheduler::{self, JobOrigin, QueueSnapshot, SchedulerHandle, SpeechJob},
    storage::{
        ConnectionSettings, DataStore, DesktopPreferences, OverlayNames, OverlaySettings,
        ServiceConnection,
    },
    tts::{
        dobao::{self, DEFAULT_VOICE_ID},
        dobao_auth::{DoubaoQrAuth, QrSession as DoubaoSession, QrStatus, QrVisual},
        dots::{DotsClient, DotsConfig},
        fish::{self, FishClient, FishConfig, FishPlaybackSettings},
    },
    voice_library::{ReferenceProfile, scan_sovits_models},
};
use qrcode::{Color, QrCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

pub struct LaunchOptions {
    pub data_dir: PathBuf,
    pub disable_network: bool,
}

impl LaunchOptions {
    pub fn default_data_dir() -> Result<PathBuf, String> {
        std::env::var_os("LOCALAPPDATA")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|path| path.join("DanmakuVoice"))
            .ok_or_else(|| "无法找到 Windows AppData 目录，请检查用户环境".into())
    }

    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let mut directory = None;
        let mut disable_network = false;
        while let Some(arg) = args.next() {
            if arg == "--data-dir" {
                if directory.is_some() {
                    return Err("--data-dir 只能提供一次".into());
                }
                let value = args.next().ok_or("--data-dir 缺少目录")?;
                if value.is_empty() {
                    return Err("数据目录不能为空".into());
                }
                directory = Some(PathBuf::from(value));
            } else if arg == "--disable-network" {
                disable_network = true;
            } else {
                return Err(format!("不支持的参数：{}", arg.to_string_lossy()));
            }
        }
        if disable_network && directory.is_none() {
            return Err("离线测试必须用 --data-dir 指定独立目录，不能使用日常配置".into());
        }
        let directory = directory.map_or_else(Self::default_data_dir, Ok)?;
        Ok(Self {
            data_dir: if directory.is_absolute() {
                directory
            } else {
                std::env::current_dir().map_err(display)?.join(directory)
            },
            disable_network,
        })
    }
}

#[derive(Clone)]
pub struct Application(Arc<Mutex<Controller>>);

struct ReconfigurationGuard(Application);

impl Drop for ReconfigurationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.reconfiguring = false;
        }
    }
}

#[derive(Default, Serialize)]
struct QrView {
    provider: Option<&'static str>,
    status: &'static str,
    image_data_url: Option<String>,
    message: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct DesktopPaths {
    dots_dir: Option<PathBuf>,
    gpt_sovits_dir: Option<PathBuf>,
}

struct Controller {
    store: DataStore,
    prefs: DesktopPreferences,
    local_services: LocalServices,
    network_disabled: bool,
    status: String,
    status_error: bool,
    bili_user_id: Option<u64>,
    bili_profile: Option<BiliAccountProfile>,
    bili_profile_epoch: u64,
    broadcast: broadcast::BroadcastState,
    qr: QrView,
    qr_generation: u64,
    qr_cancel: CancellationToken,
    qr_busy: bool,
    qr_last_poll: Option<Instant>,
    bili_qr: Option<Arc<AsyncMutex<QrChallenge>>>,
    doubao_qr: Option<Arc<AsyncMutex<DoubaoSession>>>,
    doubao_connection: Option<String>,
    live: Option<Arc<LiveController>>,
    last_live: LiveSnapshot,
    /// Chat kept on screen while only the speech switch restarts the live session.
    carried_events: Vec<LiveEvent>,
    connecting: bool,
    live_receive_only: bool,
    generation: u64,
    live_generation: u64,
    start_cancel: CancellationToken,
    audition_cancel: CancellationToken,
    activity_gate: Arc<AsyncMutex<()>>,
    stopping: bool,
    pending_stops: usize,
    reconfiguring: bool,
    audition_starting: bool,
    scheduler: Option<SchedulerHandle>,
    audio: Option<AudioOutput>,
    resume_live_after_default_device_change: bool,
    default_device_resume_epoch: u64,
    explicit_stop_epoch: u64,
    startup_connection_attempted: bool,
    devices: Value,
    // Settings change through dispatch; polling only needs to clone their
    // last serialized view, then overlay the live in-memory runtime state.
    config_snapshot: Option<Value>,
    config_revision: u64,
    migration: Option<(PathBuf, LegacyPreview)>,
    overlay_settings: OverlaySettings,
    overlay_hub: Arc<OverlayHub>,
    overlay_server: Option<OverlayServer>,
    overlay_error: Option<String>,
    overlay_assets: Option<AssetLoader>,
}

/// Progress of the overlay feed between ticks. Only live results after the
/// moment a page connected are sent; older chat stays in the app.
#[derive(Default)]
pub struct OverlayCursor {
    controller: usize,
    last: Option<ProcessedLiveEvent>,
    primed: bool,
}

impl Application {
    fn begin_reconfiguration(&self) -> Result<ReconfigurationGuard, String> {
        let mut state = self.lock()?;
        if state.reconfiguring {
            return Err("正在应用设置，请稍候".into());
        }
        state.reconfiguring = true;
        Ok(ReconfigurationGuard(self.clone()))
    }
    pub fn new(data_dir: PathBuf, network_disabled: bool) -> Result<Self, String> {
        let store = DataStore::open(&data_dir).map_err(display)?;
        let prefs = store.load_desktop_preferences().map_err(display)?;
        // A damaged overlay record must not stop the app; it reverts to off.
        let overlay_settings = store.load_overlay_settings().unwrap_or_default();
        let overlay_hub = OverlayHub::new();
        overlay_hub.set_config(overlay_config(&overlay_settings));
        let bili_session = store.load_bili_session().ok().flatten();
        let bili_user_id = bili_session.as_ref().map(BiliSession::user_id);
        let bili_profile = bili_session
            .as_ref()
            .and_then(BiliSession::profile)
            .cloned();
        let paths = std::fs::read(data_dir.join("desktop-paths.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DesktopPaths>(&bytes).ok())
            .unwrap_or_default();
        let local_services = LocalServices::new(paths.dots_dir, paths.gpt_sovits_dir);
        // Prepare the built-in decoder on first launch. Audio setup retries if
        // a transient filesystem error prevented this optional warm-up.
        let _ = embedded_ffmpeg::ensure(&data_dir);
        let _ = diagnostics::init(&data_dir);
        let app = Self(Arc::new(Mutex::new(Controller {
            store,
            prefs,
            local_services,
            network_disabled,
            status: String::new(),
            status_error: false,
            bili_user_id,
            bili_profile,
            bili_profile_epoch: 0,
            broadcast: broadcast::BroadcastState::default(),
            qr: QrView {
                status: "idle",
                ..Default::default()
            },
            qr_generation: 0,
            qr_cancel: CancellationToken::new(),
            qr_busy: false,
            qr_last_poll: None,
            bili_qr: None,
            doubao_qr: None,
            doubao_connection: None,
            live: None,
            last_live: LiveSnapshot::default(),
            carried_events: Vec::new(),
            connecting: false,
            live_receive_only: false,
            generation: 0,
            live_generation: 0,
            start_cancel: CancellationToken::new(),
            audition_cancel: CancellationToken::new(),
            activity_gate: Arc::new(AsyncMutex::new(())),
            stopping: false,
            pending_stops: 0,
            reconfiguring: false,
            audition_starting: false,
            scheduler: None,
            audio: None,
            resume_live_after_default_device_change: false,
            default_device_resume_epoch: 0,
            explicit_stop_epoch: 0,
            startup_connection_attempted: false,
            devices: devices_json(),
            config_snapshot: None,
            config_revision: 0,
            migration: None,
            overlay_settings,
            overlay_hub,
            overlay_server: None,
            overlay_error: None,
            overlay_assets: None,
        })));
        app.lock()?.ensure_first_default(None)?;
        app.lock()?.ensure_overlay_token()?;
        Ok(app)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Controller>, String> {
        self.0
            .lock()
            .map_err(|_| "应用状态无法访问，请重新启动".into())
    }

    pub fn data_dir(&self) -> Result<PathBuf, String> {
        Ok(self.lock()?.store.data_dir().to_owned())
    }

    /// The encrypted session carries a small display cache. Refresh only once
    /// at launch/login; failure never blocks room lookup, reception or playback.
    pub async fn refresh_bili_profile(&self) {
        let _ = self
            .refresh_bili_profile_with(|session| async move {
                let client = QrLoginClient::new().map_err(display)?;
                tokio::time::timeout(Duration::from_secs(5), client.account_profile(&session))
                    .await
                    .map_err(|_| "账号资料请求超时".to_owned())?
                    .map_err(display)
            })
            .await;
    }

    async fn refresh_bili_profile_with<F, Fut>(&self, lookup: F) -> Result<(), String>
    where
        F: FnOnce(BiliSession) -> Fut,
        Fut: std::future::Future<Output = Result<BiliAccountProfile, String>>,
    {
        let (epoch, mut session) = {
            let state = self.lock()?;
            if state.network_disabled {
                return Ok(());
            }
            let Some(session) = state.store.load_bili_session().map_err(display)? else {
                return Ok(());
            };
            (state.bili_profile_epoch, session)
        };
        let profile = lookup(session.clone()).await?;
        session.set_profile(profile).map_err(display)?;
        let mut state = self.lock()?;
        if state.bili_profile_epoch != epoch || state.bili_user_id != Some(session.user_id()) {
            return Ok(());
        }
        if state.bili_profile.as_ref() != session.profile() {
            state.store.save_bili_session(&session).map_err(display)?;
            state.bili_profile = session.profile().cloned();
        }
        Ok(())
    }

    fn require_network(&self) -> Result<(), String> {
        if self.lock()?.network_disabled {
            Err("这是离线测试窗口。请关闭此窗口后直接打开正式程序。".into())
        } else {
            Ok(())
        }
    }

    /// A changed Windows default device invalidates the CPAL stream and its
    /// sample format. Rebuild the shared playback queue, then reconnect the
    /// live listener once an output device is available again. Explicit user
    /// disconnects clear the pending reconnect in `stop`.
    pub async fn reconcile_default_output(&self) {
        let change_epoch = match self.lock() {
            Ok(state) => (state.prefs.output == audio::OutputSelection::Default
                && !state.reconfiguring
                && !state.stopping
                && !state.connecting
                && !state.audition_starting
                && state.audio.as_ref().is_some_and(|output| {
                    output.writer.disconnected() || output.default_device_changed()
                }))
            .then_some(state.explicit_stop_epoch),
            Err(_) => return,
        };
        if let Some(observed_epoch) = change_epoch {
            let Ok(transition) = self.begin_reconfiguration() else {
                return;
            };
            let was_live = self
                .lock()
                .ok()
                .and_then(|state| {
                    (!state.stopping && state.explicit_stop_epoch == observed_epoch).then(|| {
                        state
                            .live
                            .as_ref()
                            .is_some_and(|live| live.snapshot().running)
                    })
                })
                .unwrap_or(false);
            if self
                .lock()
                .is_ok_and(|state| state.stopping || state.explicit_stop_epoch != observed_epoch)
            {
                return;
            }
            if let Err(error) = self.stop(true).await {
                if let Ok(mut state) = self.lock() {
                    state.status = format!("切换默认输出设备失败：{error}");
                    state.status_error = true;
                }
                return;
            }
            if let Ok(mut state) = self.lock() {
                state.audio = None;
                state.scheduler = None;
                state.devices = devices_json();
                state.config_snapshot = None;
                state.resume_live_after_default_device_change =
                    was_live && state.explicit_stop_epoch == observed_epoch;
                state.default_device_resume_epoch = observed_epoch;
                state.status = if was_live {
                    "系统默认输出设备已变化或中断，正在恢复直播播报".into()
                } else {
                    "系统默认输出设备已变化或中断，下次播报将使用新设备".into()
                };
                state.status_error = false;
            }
            drop(transition);
        }
        let resume_epoch = self
            .lock()
            .map(|state| {
                (state.resume_live_after_default_device_change
                    && state.explicit_stop_epoch == state.default_device_resume_epoch
                    && state.prefs.output == audio::OutputSelection::Default
                    && !state.reconfiguring
                    && !state.stopping
                    && !state.connecting)
                    .then_some(state.default_device_resume_epoch)
            })
            .ok()
            .flatten();
        let Some(resume_epoch) = resume_epoch else {
            return;
        };
        if !audio::default_output_available() {
            if let Ok(mut state) = self.lock() {
                state.status = "系统默认输出设备不可用，等待设备恢复 [DV-A01]".into();
                state.status_error = true;
            }
            return;
        }
        // Opening the new output before reconnecting avoids repeated B站
        // connection attempts while a device exists but its driver is not
        // yet able to start a CPAL stream.
        if let Ok(mut state) = self.lock() {
            if state.explicit_stop_epoch != resume_epoch
                || !state.resume_live_after_default_device_change
            {
                return;
            }
            if let Err(error) = state.ensure_audio() {
                state.status = format!("默认输出设备尚未就绪：{error}");
                state.status_error = true;
                return;
            }
            state.resume_live_after_default_device_change = false;
        }
        match self
            .connect_with_intent(None, None, Some(resume_epoch))
            .await
        {
            Ok(()) => {
                if let Ok(mut state) = self.lock() {
                    state.status.clear();
                    state.status_error = false;
                }
            }
            Err(error) => {
                if let Ok(mut state) = self.lock() {
                    state.resume_live_after_default_device_change = state
                        .audio
                        .as_ref()
                        .is_some_and(|output| output.writer.disconnected());
                    state.status = format!("默认输出设备已恢复，但重新连接直播失败：{error}");
                    state.status_error = true;
                }
            }
        }
        if self
            .lock()
            .is_ok_and(|state| state.explicit_stop_epoch != resume_epoch)
        {
            // An explicit Stop may have raced with the device reconnect. It
            // must win even if the network connection completed afterward.
            let _ = self.stop(true).await;
        }
    }

    pub fn snapshot(&self) -> Result<Value, String> {
        self.snapshot_since(None)
    }

    /// The host supplies embedded fonts once the WebView assets exist, then
    /// the overlay starts if the user enabled it earlier.
    pub async fn start_overlay(&self, assets: AssetLoader) {
        if let Ok(mut state) = self.lock() {
            state.overlay_assets = Some(assets);
        }
        let _ = self.apply_overlay().await;
    }

    /// Start or stop the loopback server to match the saved switch.
    async fn apply_overlay(&self) -> Result<(), String> {
        let (enabled, port, hub, assets) = {
            let state = self.lock()?;
            (
                state.overlay_settings.enabled,
                state.overlay_settings.port,
                state.overlay_hub.clone(),
                state.overlay_assets.clone(),
            )
        };
        if !enabled {
            let mut state = self.lock()?;
            state.overlay_server = None;
            state.overlay_error = None;
            return Ok(());
        }
        if self.lock()?.overlay_server.is_some() {
            return Ok(());
        }
        let Some(assets) = assets else {
            // Commands can run before the window finished setup; start_overlay
            // applies the saved switch as soon as the assets are available.
            return Ok(());
        };
        let bound = OverlayServer::bind(port, hub, assets).await;
        let mut state = self.lock()?;
        if !state.overlay_settings.enabled {
            return Ok(());
        }
        match bound {
            Ok(server) => {
                if server.port() != state.overlay_settings.port {
                    let mut settings = state.overlay_settings.clone();
                    settings.port = server.port();
                    state
                        .store
                        .save_overlay_settings(&settings)
                        .map_err(display)?;
                    state.overlay_settings = settings;
                }
                state.overlay_server = Some(server);
                state.overlay_error = None;
                Ok(())
            }
            Err(error) => {
                state.overlay_error = Some(error.clone());
                Err(error)
            }
        }
    }

    async fn save_overlay(&self, payload: &Value) -> Result<(), String> {
        let edited: OverlaySettings = parse(payload.get("settings").ok_or("缺少叠加层设置")?)?;
        {
            let mut state = self.lock()?;
            let merged = state.overlay_settings.with_edits_from(&edited);
            state
                .store
                .save_overlay_settings(&merged)
                .map_err(display)?;
            state.overlay_hub.set_config(overlay_config(&merged));
            state.overlay_settings = merged;
        }
        self.apply_overlay().await
    }

    /// Feed connected overlay pages. Runs for the app lifetime but does no
    /// work while the overlay is off or no OBS page is connected.
    pub async fn run_overlay_feed(&self) {
        let mut cursor = OverlayCursor::default();
        let mut interval = tokio::time::interval(Duration::from_millis(150));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if self.overlay_tick(&mut cursor).is_err() {
                return;
            }
        }
    }

    pub(crate) fn overlay_tick(&self, cursor: &mut OverlayCursor) -> Result<(), String> {
        let (hub, settings, live, current, writer, tts, connecting) = {
            let state = self.lock()?;
            if state.overlay_server.is_none() || !state.overlay_hub.has_clients() {
                cursor.primed = false;
                return Ok(());
            }
            (
                state.overlay_hub.clone(),
                state.overlay_settings.clone(),
                state.live.clone(),
                state
                    .scheduler
                    .as_ref()
                    .and_then(|scheduler| scheduler.state().borrow().current.clone()),
                state.audio.as_ref().map(|audio| audio.writer.clone()),
                state.prefs.tts_enabled,
                state.connecting,
            )
        };
        let snapshot = live.as_ref().map(|live| live.snapshot());
        let connection = if connecting {
            "connecting"
        } else {
            snapshot
                .as_ref()
                .filter(|snapshot| snapshot.running)
                .map_or("stopped", |snapshot| room_state(&snapshot.room_state).0)
        };
        hub.set_status(json!({
            "connection": connection,
            "tts": tts,
            "words": snapshot.as_ref().map_or(0, |snapshot| snapshot.received),
        }));
        let key = live.as_ref().map_or(0, |live| Arc::as_ptr(live) as usize);
        if key != cursor.controller {
            cursor.controller = key;
            cursor.last = None;
            if cursor.primed {
                hub.clear_items();
            }
        }
        if let Some(snapshot) = &snapshot {
            let results = &snapshot.recent_results;
            let start = overlay_feed_start(
                results,
                cursor.primed.then_some(cursor.last.as_ref()),
                now_ms(),
                u64::from(settings.linger_seconds) * 1000,
            );
            for result in &results[start..] {
                if let Some(item) = overlay_item(result, &settings) {
                    hub.publish_item(item);
                }
            }
            cursor.last = results.last().cloned();
        }
        cursor.primed = true;
        let reading = current
            .filter(|job| job.origin == JobOrigin::Live)
            .map(|job| {
                let progress = writer
                    .as_ref()
                    .map(|writer| writer.progress())
                    .filter(|progress| progress.job_id == job.id)
                    .unwrap_or_default();
                json!({
                    "job_id": job.id,
                    "played_ms": progress.played_ms,
                    "queued_ms": progress.queued_ms,
                    "chars": job.preview.final_text.chars().count(),
                })
            })
            .unwrap_or(Value::Null);
        hub.set_reading(reading);
        Ok(())
    }

    pub fn network_disabled(&self) -> Result<bool, String> {
        Ok(self.lock()?.network_disabled)
    }

    pub fn snapshot_since(&self, known_revision: Option<u64>) -> Result<Value, String> {
        let mut state = self.lock()?;
        state.local_services.dots.process_exited();
        state.local_services.gpt_sovits.process_exited();
        if state.config_snapshot.is_none() {
            for kind in [Kind::Dots, Kind::GptSovits] {
                if let Ok(endpoint) = state.local_service_endpoint(kind, None) {
                    state
                        .local_services
                        .get_mut(kind)
                        .observe_endpoint(&endpoint);
                }
            }

            let connections = state.store.connections().map_err(display)?;
            let fish_audio_settings = connections
                .iter()
                .filter(|connection| connection.settings.provider() == Provider::FishAudio)
                .map(|connection| {
                    state
                        .store
                        .fish_audio_settings(&connection.id)
                        .map(|settings| (connection.id.clone(), settings))
                        .map_err(display)
                })
                .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
            let bindings: Vec<Value> = state
                .store
                .binding_records()
                .map_err(display)?
                .into_iter()
                .map(|r| json!({"id":r.id,"binding":r.binding}))
                .collect();
            let voices: Vec<Value> = dobao::voice_catalog()
                .iter()
                .map(|v| json!({"id":v.id,"name":v.name}))
                .collect();
            #[cfg(windows)]
            let startup_enabled = std::env::current_exe()
                .ok()
                .and_then(|exe| crate::startup::is_enabled(&exe, state.store.data_dir()).ok())
                .unwrap_or(false);
            #[cfg(not(windows))]
            let startup_enabled = false;
            state.config_snapshot = Some(json!({
                "app_version": env!("CARGO_PKG_VERSION"),
                "update_channel": if crate::package::installed_root()?.is_some() { "store" } else { "github" },
                "connections":connections,
                "fish_audio_settings":fish_audio_settings,
                "presets":state.store.presets().map_err(display)?,
                "bindings":bindings,"assets":state.store.assets().map_err(display)?,
                "rules":state.store.load_rules().map_err(display)?,
                "live_settings":state.store.load_live_settings().map_err(display)?,
                "devices":state.devices,"doubao_voices":voices,"startup_enabled":startup_enabled,
            }));
            state.config_revision = state.config_revision.wrapping_add(1);
        }
        let config = state
            .config_snapshot
            .as_ref()
            .expect("initialized snapshot");
        let room = config["live_settings"]["room_id"].as_u64();
        let config_unchanged = known_revision == Some(state.config_revision);
        let mut snapshot = if config_unchanged {
            json!({})
        } else {
            config.clone()
        };
        let live = state
            .live
            .as_ref()
            .map(|live| live.snapshot())
            .unwrap_or_else(|| state.last_live.clone());
        // Between a speech-mode stop and the restarted session, the stopped
        // session's events are already part of the carried chat.
        let events = if state.live.is_none() && !state.carried_events.is_empty() {
            state.carried_events.clone()
        } else {
            carried_chat(&state.carried_events, &live.recent_events)
        };
        let queue = state
            .scheduler
            .as_ref()
            .map(|s| s.state().borrow().clone())
            .unwrap_or_default();
        let (live_state, live_message) = room_state(&live.room_state);
        let device_lost = state
            .audio
            .as_ref()
            .is_some_and(|a| a.writer.disconnected());
        let status_message = if device_lost {
            "输出设备已断开，请在设置中重新应用设备 [DV-A07]".to_owned()
        } else if state.status_error {
            danmakuvoice_engine::error_codes::tag(&state.status, "DV-X00")
        } else {
            state.status.clone()
        };
        let dynamic = json!({
            "config_revision": state.config_revision,
            "config_unchanged": config_unchanged,
            "onboarding_done":state.prefs.onboarding_done,
            "setup":{"mode":if state.prefs.authenticated {"account"} else {"anonymous"},"uid":state.prefs.broadcaster_uid,"room_id":room,"tts_enabled":state.prefs.tts_enabled},
            "account":{"user_id":state.bili_user_id,"name":state.bili_profile.as_ref().map(|p| &p.name),"avatar_url":state.bili_profile.as_ref().and_then(|p| p.avatar_url.as_deref())}, "qr":state.qr,
            "live":{"running":live.running,"connecting":state.connecting,"room_id":live.room_id.or(room),"state":if state.connecting {"connecting"} else {live_state},"message":live_message,"received":live.received,"events":events,"errors":live.errors,"no_voice":live.no_voice},
            "queue":queue_json(&queue), "preferences":state.prefs,
            "status":{"error":state.status_error || device_lost,"message":status_message},
            "data_dir":state.store.data_dir(),
            "network_disabled":state.network_disabled,
            "overlay":state.overlay_view()
        });
        snapshot["broadcast"] = state.broadcast.view();
        let Value::Object(dynamic) = dynamic else {
            unreachable!("dynamic snapshot is an object")
        };
        snapshot
            .as_object_mut()
            .expect("configuration object")
            .extend(dynamic);
        snapshot["local_services"] = json!({
            "dots": state.local_services.dots.view(),
            "gpt_sovits": state.local_services.gpt_sovits.view(),
        });
        Ok(snapshot)
    }

    pub async fn dispatch(&self, action: &str, payload: Value) -> Result<Value, String> {
        let observation_only =
            action == "local_services.check" && bool_field(&payload, "automatic", false);
        if matches!(action, "queue.stop" | "live.disconnect") {
            let mut state = self.lock()?;
            state.explicit_stop_epoch = state.explicit_stop_epoch.wrapping_add(1);
        }
        if matches!(
            action,
            "queue.stop"
                | "live.disconnect"
                | "live.connect"
                | "live.save"
                | "onboarding.anonymous"
                | "onboarding.finish"
                | "onboarding.reset"
                | "bili.use_account"
                | "bili.logout"
        ) {
            self.lock()?.carried_events.clear();
        }
        let result = self.execute(action, payload).await.map_err(|error| {
            danmakuvoice_engine::error_codes::tag(
                error,
                danmakuvoice_engine::error_codes::command_code(action),
            )
        });
        {
            let mut state = self.lock()?;
            // Failed actions may have written a partial result before an
            // error. Never retain a pre-dispatch configuration in that case.
            if !observation_only {
                if command_changes_configuration(action) {
                    state.config_snapshot = None;
                }
                match &result {
                    Ok(_) => {
                        state.status.clear();
                        state.status_error = false;
                    }
                    Err(error) => {
                        state.status = error.clone();
                        state.status_error = true;
                    }
                }
            }
        }
        let operation = result?;
        let mut snapshot = self.snapshot()?;
        if !operation.is_null() {
            snapshot["result"] = operation;
        }
        Ok(snapshot)
    }

    async fn execute(&self, action: &str, mut payload: Value) -> Result<Value, String> {
        if self.lock()?.reconfiguring
            && !matches!(
                action,
                "queue.stop" | "live.disconnect" | "bili.qr.cancel" | "doubao.qr.cancel"
            )
        {
            return Err("正在应用设置，请稍候".into());
        }
        match action {
            action if action.starts_with("bili.broadcast.") => {
                return self.broadcast_command(action, &payload).await;
            }
            "data.clear" => {
                confirmed(&payload)?;
                return self.clear_data().await;
            }
            "bili.qr.begin" => self.begin_bili().await?,
            "bili.qr.poll" => self.poll_bili().await?,
            "bili.use_account" => self.use_account().await?,
            "local_services.save" => self.save_local_directory(&payload).await?,
            "local_services.check" => self.check_local_service(&payload).await?,
            "local_services.start" => self.start_local_service(&payload).await?,
            "local_services.stop" => self.stop_local_service(&payload)?,
            "fish.connect" => return self.connect_fish(&mut payload).await,
            "fish.voice.lookup" => return self.lookup_fish_voice(&payload).await,
            "presets.default" | "references.save" => {
                self.execute_local(action, payload)?;
                let app = self.clone();
                tokio::spawn(async move { app.auto_start_preferred_service().await });
            }
            "dots.voice.save" => {
                let result = self.execute_local(action, payload)?;
                let app = self.clone();
                tokio::spawn(async move { app.auto_start_preferred_service().await });
                return Ok(result);
            }
            "doubao.qr.begin" => {
                self.begin_doubao(payload.get("connection_id").and_then(Value::as_str))
                    .await?
            }
            "doubao.qr.poll" => self.poll_doubao().await?,
            "bili.qr.cancel" | "doubao.qr.cancel" => self.lock()?.cancel_qr(),
            "onboarding.anonymous" => self.anonymous(&payload).await?,
            "onboarding.finish" => {
                let enabled = bool_field(&payload, "tts_enabled", true);
                let connect = bool_field(&payload, "connect", true);
                {
                    let mut state = self.lock()?;
                    if state
                        .store
                        .load_live_settings()
                        .map_err(display)?
                        .room_id
                        .is_none()
                    {
                        return Err("请先扫码或填写主播 UID".into());
                    }
                    if enabled {
                        state.validate_default_voice()?;
                    }
                    state.prefs.tts_enabled = enabled;
                    state.save_preferences()?;
                    state.cancel_qr();
                }
                if connect {
                    self.connect(None).await?;
                }
                let mut state = self.lock()?;
                if connect
                    && !state
                        .live
                        .as_ref()
                        .is_some_and(|live| live.snapshot().running)
                {
                    return Err("直播间连接已取消，请重新点击开始接收".into());
                }
                state.prefs.onboarding_done = true;
                state.save_preferences()?;
            }
            "onboarding.reset" => {
                let _transition = self.begin_reconfiguration()?;
                self.stop(false).await?;
                let mut state = self.lock()?;
                state.prefs.onboarding_done = false;
                state.save_preferences()?;
                state.cancel_qr();
            }
            "live.connect" => {
                self.connect(payload.get("authenticated").and_then(Value::as_bool))
                    .await?
            }
            "live.disconnect" => self.stop(false).await?,
            "queue.stop" => self.stop(true).await?,
            "queue.jump" => {
                let id = payload
                    .get("id")
                    .and_then(|value| {
                        value
                            .as_u64()
                            .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
                    })
                    .ok_or("播报编号无效")?;
                let scheduler = self.lock()?.scheduler.clone();
                let jumped = match scheduler {
                    Some(s) => s.jump_to(id).await.map_err(display)?,
                    None => false,
                };
                if !jumped {
                    return Err("这条弹幕已经读过或不在待读列表中".into());
                }
            }
            "queue.skip" | "queue.clear" => {
                let scheduler = self.lock()?.scheduler.clone();
                if let Some(s) = scheduler {
                    if action == "queue.skip" {
                        s.skip_current().await.map_err(display)?;
                    } else {
                        s.clear_pending().await.map_err(display)?;
                    }
                }
            }
            "bili.logout" => {
                confirmed(&payload)?;
                self.lock()?.broadcast.invalidate();
                self.stop(false).await?;
                let mut state = self.lock()?;
                state.cancel_qr();
                state.store.clear_bili_session().map_err(display)?;
                state.broadcast.invalidate();
                state.bili_user_id = None;
                state.bili_profile = None;
                state.bili_profile_epoch = state.bili_profile_epoch.wrapping_add(1);
                state.prefs.authenticated = false;
                state.save_preferences()?;
            }
            "connections.clear_credential" => {
                confirmed(&payload)?;
                let _transition = self.begin_reconfiguration()?;
                self.stop(true).await?;
                self.lock()?
                    .store
                    .clear_connection_credential(required_str(&payload, "id")?)
                    .map_err(display)?;
            }
            "connections.probe" => return self.probe(required_str(&payload, "id")?).await,
            "audition" => self.audition(&payload, false).await?,
            "audio.test" => self.audition(&payload, true).await?,
            "preferences.save" => self.preferences(&payload).await?,
            "overlay.save" => self.save_overlay(&payload).await?,
            "overlay.token.reset" => {
                let mut state = self.lock()?;
                let mut settings = state.overlay_settings.clone();
                settings.token = new_overlay_token();
                state
                    .store
                    .save_overlay_settings(&settings)
                    .map_err(display)?;
                state.overlay_hub.set_token(&settings.token);
                state.overlay_settings = settings;
            }
            "overlay.test" => {
                let state = self.lock()?;
                if state.overlay_server.is_none() {
                    return Err("请先启用 OBS 叠加层".into());
                }
                let kind = payload
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("danmaku");
                state
                    .overlay_hub
                    .publish_item(overlay_demo_item(kind, &state.overlay_settings)?);
            }
            "migration.apply" => {
                confirmed(&payload)?;
                let _transition = self.begin_reconfiguration()?;
                self.stop(true).await?;
                return self.execute_local(action, payload);
            }
            _ => return self.execute_local(action, payload),
        }
        Ok(Value::Null)
    }

    fn execute_local(&self, action: &str, mut payload: Value) -> Result<Value, String> {
        let mut state = self.lock()?;
        match action {
            "live.save" => {
                if state.connecting || state.live.as_ref().is_some_and(|l| l.snapshot().running) {
                    return Err("请先断开直播间再更改房间".into());
                }
                let mut settings = state.store.load_live_settings().map_err(display)?;
                if payload.get("room_id").is_some() {
                    settings.room_id = Some(positive_id(&payload["room_id"])?);
                }
                if let Some(merge) = payload.get("gift_merge") {
                    settings.gift_merge = parse(merge)?;
                }
                state.store.save_live_settings(&settings).map_err(display)?;
                state.prefs.authenticated =
                    bool_field(&payload, "authenticated", state.prefs.authenticated);
                state.save_preferences()?;
            }
            "connections.save" => {
                let mut connection: ServiceConnection = parse(&payload["connection"])?;
                if connection.id.trim().is_empty() {
                    connection.id = Uuid::new_v4().to_string();
                }
                if connection.name.trim().is_empty() {
                    return Err("请填写连接名称".into());
                }
                let secret = payload
                    .get_mut("credential")
                    .map(Value::take)
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .map(Zeroizing::new);
                if let Some(secret) = secret.as_ref().filter(|s| !s.trim().is_empty())
                    && connection.settings.provider() == Provider::Doubao
                {
                    dobao::validate_cookie_header(secret).map_err(display)?;
                }
                if secret.as_ref().is_some_and(|s| !s.trim().is_empty())
                    && connection.settings.provider() == Provider::FishAudio
                {
                    return Err("请使用 Fish Audio 登录入口验证 API Key".into());
                }
                state
                    .store
                    .save_connection_with_credential(
                        &connection,
                        secret
                            .as_ref()
                            .filter(|s| !s.trim().is_empty())
                            .map(|s| s.as_bytes()),
                    )
                    .map_err(display)?;
                if connection.settings.provider() == Provider::Doubao
                    && state
                        .store
                        .connections()
                        .map_err(display)?
                        .iter()
                        .any(|saved| saved.id == connection.id && saved.has_credential)
                {
                    state.ensure_doubao_default(&connection.id)?;
                } else {
                    state.ensure_first_default(None)?;
                }
                return Ok(json!({"id":connection.id}));
            }
            "connections.delete" => {
                confirmed(&payload)?;
                state
                    .store
                    .delete_connection(required_str(&payload, "id")?)
                    .map_err(display)?;
            }
            "presets.save" => {
                let mut preset: VoicePreset = parse(&payload["preset"])?;
                if preset.id.trim().is_empty() {
                    preset.id = Uuid::new_v4().to_string();
                }
                if preset.name.trim().is_empty() || preset.voice_id.trim().is_empty() {
                    return Err("请填写预设名称与音色".into());
                }
                if !preset.speed.is_finite()
                    || !(0.5..=2.0).contains(&preset.speed)
                    || !preset.volume.is_finite()
                    || !(0.0..=2.0).contains(&preset.volume)
                {
                    return Err("语速须在 0.5–2，音量须在 0–2 之间".into());
                }
                if preset.provider == Provider::Doubao {
                    preset.voice_id =
                        dobao::normalize_voice_id(&preset.voice_id).map_err(display)?;
                }
                state.store.save_preset(&preset).map_err(display)?;
                state.ensure_first_default(Some(&preset.id))?;
                return Ok(json!({"id":preset.id}));
            }
            "fish.voice.save" => {
                let preset = state
                    .store
                    .save_fish_voice(
                        required_str(&payload, "connection_id")?,
                        required_str(&payload, "id_or_url")?,
                        required_str(&payload, "name")?,
                    )
                    .map_err(display)?;
                state.ensure_first_default(Some(&preset.id))?;
                return serde_json::to_value(preset).map_err(display);
            }
            "fish.voices.restore_builtin" => {
                let created = state
                    .store
                    .restore_builtin_fish_voices(required_str(&payload, "connection_id")?)
                    .map_err(display)?;
                state.ensure_first_default(None)?;
                return serde_json::to_value(created).map_err(display);
            }
            "fish.settings.get" => {
                let settings = state
                    .store
                    .fish_audio_settings(required_str(&payload, "connection_id")?)
                    .map_err(display)?;
                return serde_json::to_value(settings).map_err(display);
            }
            "fish.settings.save" => {
                let settings: FishPlaybackSettings = parse(&payload["settings"])?;
                state
                    .store
                    .save_fish_audio_settings(required_str(&payload, "connection_id")?, &settings)
                    .map_err(display)?;
            }
            "dots.voice.save" => {
                let mut preset: VoicePreset = parse(&payload["preset"])?;
                let profile: ReferenceProfile = parse(&payload["profile"])?;
                if preset.id.trim().is_empty() {
                    preset.id = Uuid::new_v4().to_string();
                }
                if preset.provider != Provider::Dots || preset.name.trim().is_empty() {
                    return Err("请填写 dots.tts 音色名称".into());
                }
                if !preset.speed.is_finite()
                    || !(0.5..=2.0).contains(&preset.speed)
                    || !preset.volume.is_finite()
                    || !(0.0..=2.0).contains(&preset.volume)
                {
                    return Err("语速须在 0.5–2，音量须在 0–2 之间".into());
                }
                state
                    .store
                    .save_dots_voice_with_preference(
                        &preset,
                        &profile,
                        bool_field(&payload, "make_preferred", false),
                    )
                    .map_err(display)?;
                state.ensure_first_default(Some(&preset.id))?;
                return Ok(json!({"id":preset.id}));
            }
            "presets.delete" => {
                confirmed(&payload)?;
                state
                    .store
                    .delete_preset(required_str(&payload, "id")?)
                    .map_err(display)?;
            }
            "presets.default" => {
                let id = payload.get("id").and_then(Value::as_str);
                let presets = state.store.presets().map_err(display)?;
                let selected = id
                    .map(|id| {
                        presets
                            .iter()
                            .find(|preset| preset.id == id)
                            .ok_or("声音预设不存在")
                    })
                    .transpose()?;
                let mut rules = state.store.load_rules().map_err(display)?;
                if let Some(preset) = selected
                    && rules.default_preset_id.as_deref() != Some(preset.id.as_str())
                    && matches!(preset.provider, Provider::Doubao | Provider::FishAudio)
                {
                    let connected =
                        state
                            .store
                            .connections()
                            .map_err(display)?
                            .into_iter()
                            .any(|connection| {
                                connection.id == preset.connection_id && connection.has_credential
                            });
                    if !connected {
                        return Err(match preset.provider {
                            Provider::Doubao => "请先扫码连接豆包，再设为首选声音",
                            Provider::FishAudio => "请先连接 Fish Audio 账号，再设为首选声音",
                            _ => unreachable!(),
                        }
                        .into());
                    }
                }
                rules.default_preset_id = id.map(str::to_owned);
                rules.default_preset_explicitly_cleared = id.is_none();
                if let Some(preset) = selected {
                    rules
                        .preferred_presets
                        .insert(preset.provider, preset.id.clone());
                }
                state.store.save_rules(&rules).map_err(display)?;
            }
            "bindings.save" => {
                let binding: VoiceBinding = parse(&payload["binding"])?;
                if binding.enabled
                    && !binding.user_id.is_some_and(|id| id > 0)
                    && binding.user_name.is_none()
                {
                    return Err("启用用户绑定前须填写观众 UID 或名称".into());
                }
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                state.store.save_binding(&id, &binding).map_err(display)?;
                return Ok(json!({"id":id}));
            }
            "bindings.delete" => {
                confirmed(&payload)?;
                state
                    .store
                    .delete_binding(required_str(&payload, "id")?)
                    .map_err(display)?;
            }
            "rules.save" => {
                let mut rules: RuleSet = parse(&payload["rules"])?;
                let prior = state.store.load_rules().map_err(display)?;
                if payload["rules"]["events"]
                    .get("filter_bilibili_emoticons")
                    .is_none()
                {
                    rules.events.filter_bilibili_emoticons = prior.events.filter_bilibili_emoticons;
                }
                if payload["rules"].get("preferred_presets").is_none() {
                    rules.preferred_presets = prior.preferred_presets.clone();
                }
                rules.default_preset_explicitly_cleared =
                    if rules.default_preset_id == prior.default_preset_id {
                        prior.default_preset_explicitly_cleared
                    } else {
                        rules.default_preset_id.is_none()
                    };
                if rules.default_preset_id != prior.default_preset_id
                    && let Some(id) = &rules.default_preset_id
                    && let Some(preset) = state
                        .store
                        .presets()
                        .map_err(display)?
                        .into_iter()
                        .find(|preset| &preset.id == id)
                {
                    rules
                        .preferred_presets
                        .insert(preset.provider, preset.id.clone());
                }
                state.store.save_rules(&rules).map_err(display)?;
            }
            "rules.preview" => {
                let preview = state.preview(&payload)?;
                return Ok(preview_json(&preview));
            }
            "models.scan" => {
                let path = absolute_path(required_str(&payload, "path")?)?;
                return serde_json::to_value(scan_sovits_models(&path).map_err(display)?)
                    .map_err(display);
            }
            "references.save" => {
                let profile: ReferenceProfile = parse(&payload["profile"])?;
                state
                    .store
                    .save_reference_profile(&profile)
                    .map_err(display)?;
                state.ensure_first_default(None)?;
            }
            "references.list" => {
                let connection_id = required_str(&payload, "connection_id")?;
                let profiles = state
                    .store
                    .reference_profiles(connection_id)
                    .map_err(display)?;
                let records: Vec<_> = profiles
                    .into_iter()
                    .map(|profile| json!({"profile":profile}))
                    .collect();
                return Ok(Value::Array(records));
            }
            "assets.import" => {
                let path = absolute_path(required_str(&payload, "path")?)?;
                let name = required_str(&payload, "name")?;
                let asset = state.store.import_asset(&path, name).map_err(display)?;
                return serde_json::to_value(asset).map_err(display);
            }
            "assets.replace" => {
                confirmed(&payload)?;
                let path = absolute_path(required_str(&payload, "path")?)?;
                state
                    .store
                    .replace_asset(required_str(&payload, "id")?, &path)
                    .map_err(display)?;
            }
            "assets.delete" => {
                confirmed(&payload)?;
                state
                    .store
                    .delete_asset(required_str(&payload, "id")?)
                    .map_err(display)?;
            }
            "devices.refresh" => state.devices = devices_json(),
            "startup.set" => {
                if state.network_disabled {
                    return Err("离线测试窗口不能设置开机启动，请在正式程序中设置".into());
                }
                #[cfg(windows)]
                crate::startup::set_enabled(
                    &std::env::current_exe().map_err(display)?,
                    state.store.data_dir(),
                    bool_field(&payload, "enabled", false),
                )
                .map_err(display)?;
                #[cfg(not(windows))]
                return Err("此版本仅支持 Windows 开机启动".into());
            }
            "configuration.export" => {
                let path = absolute_path(required_str(&payload, "path")?)?;
                let export = state.store.export_configuration().map_err(display)?;
                let bytes = serde_json::to_vec_pretty(&export).map_err(display)?;
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(display)?;
                file.write_all(&bytes).map_err(display)?;
                file.sync_all().map_err(display)?;
                return Ok(json!({"path":path}));
            }
            "migration.preview" => {
                let path = absolute_path(required_str(&payload, "path")?)?;
                let preview = legacy::preview_legacy_config_file(&path).map_err(display)?;
                let result = serde_json::to_value(&preview).map_err(display)?;
                state.migration = Some((path, preview));
                return Ok(result);
            }
            "migration.cancel" => state.migration = None,
            "migration.apply" => {
                confirmed(&payload)?;
                if state.connecting
                    || state.audition_starting
                    || state.live.is_some()
                    || state
                        .scheduler
                        .as_ref()
                        .is_some_and(|s| s.state().borrow().accepting)
                {
                    return Err("播放活动已改变，请停止全部后重新确认导入".into());
                }
                let (path, preview) = state
                    .migration
                    .as_ref()
                    .cloned()
                    .ok_or("请先预览旧配置并核对选择")?;
                let v = &payload["options"];
                let options = LegacyImportOptions {
                    import_rules: bool_field(v, "import_rules", false),
                    import_live_settings: bool_field(v, "import_live_settings", false),
                    selected_sound_ids: v
                        .get("selected_sound_ids")
                        .map(parse)
                        .transpose()?
                        .unwrap_or_default(),
                    import_connections: bool_field(v, "import_connections", false),
                    import_pending_bindings: bool_field(v, "import_pending_bindings", false),
                    replace_existing_rules: bool_field(v, "replace_existing_rules", false),
                    replace_existing_live_settings: bool_field(
                        v,
                        "replace_existing_live_settings",
                        false,
                    ),
                };
                let report = migration::apply_confirmed_legacy_import(
                    &mut state.store,
                    &path,
                    &preview,
                    &options,
                )
                .map_err(display)?;
                state.ensure_first_default(None)?;
                state.migration = None;
                return Ok(
                    json!({"backup_path":report.backup_path,"rules_imported":report.rules_imported,"live_settings_imported":report.live_settings_imported,"sounds_imported":report.sounds_imported,"connections_created":report.connections_created,"presets_created":report.presets_created,"pending_bindings_created":report.pending_bindings_created,"excluded":report.excluded}),
                );
            }
            _ => return Err("不支持的操作".into()),
        }
        state.status = String::new();
        state.status_error = false;
        Ok(Value::Null)
    }
}

impl Controller {
    fn local_service_endpoint(
        &self,
        kind: Kind,
        connection_id: Option<&str>,
    ) -> Result<String, String> {
        let state = self;
        let rules = state.store.load_rules().map_err(display)?;
        let provider = match kind {
            Kind::Dots => Provider::Dots,
            Kind::GptSovits => Provider::GptSovits,
        };
        let presets = state.store.presets().map_err(display)?;
        // Match the voice shown by the service card, including older rules
        // without a remembered preset and deleted remembered voices.
        let selected_connection = presets
            .iter()
            .find(|preset| {
                preset.provider == provider
                    && rules.preferred_presets.get(&provider) == Some(&preset.id)
            })
            .or_else(|| {
                presets.iter().find(|preset| {
                    preset.provider == provider
                        && rules.default_preset_id.as_ref() == Some(&preset.id)
                })
            })
            .or_else(|| presets.iter().find(|preset| preset.provider == provider))
            .map(|preset| preset.connection_id.clone());
        let selected_connection = connection_id.map(str::to_owned).or(selected_connection);
        let mut fallback = None;
        for connection in state.store.connections().map_err(display)? {
            let endpoint = match (kind, connection.settings) {
                (Kind::Dots, ConnectionSettings::Dots { endpoint, .. })
                | (Kind::GptSovits, ConnectionSettings::GptSovits { endpoint, .. }) => endpoint,
                _ => continue,
            };
            if selected_connection.as_ref() == Some(&connection.id) {
                return Ok(endpoint);
            }
            if fallback.is_none() {
                fallback = Some(endpoint);
            }
        }
        if connection_id.is_some() {
            return Err("本地服务连接不存在或类型不一致".into());
        }
        fallback.ok_or_else(|| "请先保存本地服务连接".into())
    }

    fn save_desktop_paths(&self) -> Result<(), String> {
        let paths = DesktopPaths {
            dots_dir: self.local_services.dots.directory.clone(),
            gpt_sovits_dir: self.local_services.gpt_sovits.directory.clone(),
        };
        let bytes = serde_json::to_vec(&paths).map_err(display)?;
        let target = self.store.data_dir().join("desktop-paths.json");
        let temporary = self
            .store
            .data_dir()
            .join(format!("desktop-paths-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(display)?;
            file.write_all(&bytes).map_err(display)?;
            file.sync_all().map_err(display)?;
            std::fs::rename(&temporary, target).map_err(display)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn save_preferences(&mut self) -> Result<(), String> {
        self.config_snapshot = None;
        self.store
            .save_desktop_preferences(&self.prefs)
            .map_err(display)
    }

    fn cancel_qr(&mut self) {
        self.qr_cancel.cancel();
        self.qr_cancel = CancellationToken::new();
        self.qr_generation = self.qr_generation.wrapping_add(1);
        self.qr = QrView {
            status: "idle",
            ..Default::default()
        };
        self.bili_qr = None;
        self.doubao_qr = None;
        self.doubao_connection = None;
        self.qr_busy = false;
        self.qr_last_poll = None;
    }

    fn begin_qr(&mut self, provider: &'static str) -> (u64, CancellationToken) {
        self.cancel_qr();
        self.qr.provider = Some(provider);
        self.qr.status = "waiting";
        self.qr.message = "正在获取二维码".into();
        self.qr_busy = true;
        (self.qr_generation, self.qr_cancel.clone())
    }

    fn qr_poll_ready(&mut self, provider: &str) -> bool {
        if self.qr.provider != Some(provider)
            || self.qr_busy
            || self
                .qr_last_poll
                .is_some_and(|p| p.elapsed() < Duration::from_secs(2))
        {
            return false;
        }
        self.qr_busy = true;
        self.qr_last_poll = Some(Instant::now());
        true
    }

    fn validate_default_voice(&self) -> Result<(), String> {
        let rules = self.store.load_rules().map_err(display)?;
        let presets = self.store.presets().map_err(display)?;
        let Some(id) = rules.default_preset_id else {
            // The engine can play a managed sound clip without a TTS preset.
            // Explicit UID or name bindings can select a voice independently
            // of the default. Imported legacy names do not count here.
            let bound_voice = self
                .store
                .bindings()
                .map_err(display)?
                .iter()
                .any(|binding| {
                    binding.enabled
                        && binding.platform == "bilibili"
                        && (binding.user_id.is_some_and(|user_id| user_id > 0)
                            || binding
                                .user_name
                                .as_deref()
                                .is_some_and(|name| binding.matches_explicit_name(name)))
                        && presets.iter().any(|preset| preset.id == binding.preset_id)
                });
            return if rules.sounds.is_empty() && !bound_voice {
                Err("请先选择默认声音、用户声音绑定或关键词音效，或关闭播报".into())
            } else {
                Ok(())
            };
        };
        let preset = presets
            .iter()
            .find(|p| p.id == id)
            .ok_or("默认声音已不存在")?;
        if matches!(preset.provider, Provider::Doubao | Provider::FishAudio) {
            let connection = self
                .store
                .connections()
                .map_err(display)?
                .into_iter()
                .find(|c| c.id == preset.connection_id)
                .ok_or("默认声音连接不存在")?;
            if !connection.has_credential {
                return Err("默认声音还未登录，请扫码后继续".into());
            }
        }
        Ok(())
    }

    fn ensure_overlay_token(&mut self) -> Result<(), String> {
        if self.overlay_settings.token.is_empty() {
            let mut settings = self.overlay_settings.clone();
            settings.token = new_overlay_token();
            self.store
                .save_overlay_settings(&settings)
                .map_err(display)?;
            self.overlay_settings = settings;
        }
        self.overlay_hub.set_token(&self.overlay_settings.token);
        Ok(())
    }

    fn overlay_view(&self) -> Value {
        let settings = &self.overlay_settings;
        let port = self
            .overlay_server
            .as_ref()
            .map_or(settings.port, OverlayServer::port);
        json!({
            "settings": settings,
            "running": self.overlay_server.is_some(),
            "port": port,
            "url": format!("http://127.0.0.1:{port}/overlay?token={}", settings.token),
            "error": self.overlay_error,
            "clients": self.overlay_hub.clients(),
        })
    }

    fn ensure_first_default(&mut self, preferred_id: Option<&str>) -> Result<(), String> {
        let mut rules = self.store.load_rules().map_err(display)?;
        if rules.default_preset_explicitly_cleared {
            return Ok(());
        }
        let presets = self.store.presets().map_err(display)?;
        // A selected preset remains the user's choice even while its service
        // is offline. Only a missing/deleted selection needs repair.
        if let Some(preset) = rules
            .default_preset_id
            .as_ref()
            .and_then(|id| presets.iter().find(|preset| &preset.id == id))
        {
            if rules.preferred_presets.get(&preset.provider) != Some(&preset.id) {
                rules
                    .preferred_presets
                    .insert(preset.provider, preset.id.clone());
                self.store.save_rules(&rules).map_err(display)?;
            }
            return Ok(());
        }
        let mut candidates = presets.iter().collect::<Vec<_>>();
        if let Some(id) = preferred_id
            && let Some(index) = candidates.iter().position(|preset| preset.id == id)
        {
            let preferred = candidates.remove(index);
            candidates.insert(0, preferred);
        }
        let mut device = None;
        for preset in candidates {
            // A connection alone, or a cloud voice without login, is not a
            // playable first choice. Use the same prepare gate as audition.
            if preset.provider == Provider::Doubao {
                let has_credential =
                    self.store
                        .connections()
                        .map_err(display)?
                        .iter()
                        .any(|connection| {
                            connection.id == preset.connection_id && connection.has_credential
                        });
                if !has_credential {
                    continue;
                }
                if device.is_none() {
                    device = Some(self.store.load_or_create_dobao_device().map_err(display)?);
                }
            }
            let preview = RulePreview::voice_audition(preset.clone(), "试听").map_err(display)?;
            if PreparedPlayback::from_store(&self.store, &preview, device.as_ref()).is_ok() {
                rules.default_preset_id = Some(preset.id.clone());
                rules
                    .preferred_presets
                    .insert(preset.provider, preset.id.clone());
                self.store.save_rules(&rules).map_err(display)?;
                break;
            }
        }
        Ok(())
    }

    fn ensure_doubao_default(&mut self, connection_id: &str) -> Result<(), String> {
        self.config_snapshot = None;
        let presets = self.store.presets().map_err(display)?;
        let existing = presets
            .iter()
            .find(|p| p.connection_id == connection_id && p.provider == Provider::Doubao);
        let id = if let Some(preset) = existing {
            preset.id.clone()
        } else {
            let preset = VoicePreset {
                id: Uuid::new_v4().to_string(),
                name: "温柔桃子".into(),
                connection_id: connection_id.into(),
                provider: Provider::Doubao,
                voice_id: DEFAULT_VOICE_ID.into(),
                speed: 1.0,
                volume: 1.0,
                sovits: None,
            };
            self.store.save_preset(&preset).map_err(display)?;
            preset.id
        };
        self.ensure_first_default(Some(&id))
    }

    fn ensure_audio(&mut self) -> Result<SchedulerHandle, String> {
        if self.audio.as_ref().is_some_and(|a| a.writer.disconnected()) {
            return Err("输出设备已断开，请在设置中重新应用设备 [DV-A07]".into());
        }
        if let Some(scheduler) = &self.scheduler {
            return Ok(scheduler.clone());
        }
        let ffmpeg = embedded_ffmpeg::ensure(self.store.data_dir())?;
        let output =
            AudioOutput::open(&self.prefs.output, self.prefs.playback_volume()).map_err(display)?;
        let executor = PlaybackExecutor::new(output.writer.clone(), &ffmpeg).map_err(display)?;
        let scheduler = scheduler::spawn(Arc::new(executor));
        self.audio = Some(output);
        self.scheduler = Some(scheduler.clone());
        Ok(scheduler)
    }

    fn preferred_local_service(&self) -> Result<Option<(Kind, String)>, String> {
        let Some(default_id) = self.store.load_rules().map_err(display)?.default_preset_id else {
            return Ok(None);
        };
        let Some(preset) = self
            .store
            .presets()
            .map_err(display)?
            .into_iter()
            .find(|preset| preset.id == default_id)
        else {
            return Ok(None);
        };
        let kind = match preset.provider {
            Provider::Dots => Kind::Dots,
            Provider::GptSovits => Kind::GptSovits,
            _ => return Ok(None),
        };
        let connection = self
            .store
            .connections()
            .map_err(display)?
            .into_iter()
            .find(|connection| connection.id == preset.connection_id)
            .ok_or("首选声音的服务连接不存在")?;
        let endpoint = match connection.settings {
            ConnectionSettings::Dots { endpoint, .. }
            | ConnectionSettings::GptSovits { endpoint, .. } => endpoint,
            _ => return Err("首选声音的服务类型不一致".into()),
        };
        Ok(Some((kind, endpoint)))
    }

    fn preview(&self, payload: &Value) -> Result<RulePreview, String> {
        let event: LiveEvent = parse(&payload["event"])?;
        let rules = self.store.load_rules().map_err(display)?;
        rules
            .preview(
                &event,
                &self.store.presets().map_err(display)?,
                &self.store.bindings().map_err(display)?,
            )
            .map_err(display)
    }
}

impl Application {
    async fn use_account(&self) -> Result<(), String> {
        self.use_account_with_lookup(|session| async move {
            let client = QrLoginClient::new().map_err(display)?;
            client.own_room_id(&session).await.map_err(display)
        })
        .await
    }

    async fn use_account_with_lookup<F, Fut>(&self, lookup: F) -> Result<(), String>
    where
        F: FnOnce(BiliSession) -> Fut,
        Fut: std::future::Future<Output = Result<u64, String>>,
    {
        self.require_network()?;
        let (generation, cancel, session, uid) = {
            let mut state = self.lock()?;
            let session = state
                .store
                .load_bili_session()
                .map_err(display)?
                .ok_or("请先扫码登录 B 站账号")?;
            state.cancel_qr();
            let uid = session.user_id();
            state.bili_user_id = Some(uid);
            (state.qr_generation, state.qr_cancel.clone(), session, uid)
        };
        let room = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = lookup(session) => result?,
        };
        self.commit_room_resolution(generation, &cancel, uid, room, true)
            .await?;
        Ok(())
    }

    async fn commit_room_resolution(
        &self,
        generation: u64,
        cancel: &CancellationToken,
        uid: u64,
        room: u64,
        authenticated: bool,
    ) -> Result<bool, String> {
        {
            let state = self.lock()?;
            if state.qr_generation != generation || cancel.is_cancelled() {
                return Ok(false);
            }
        }
        let _transition = self.begin_reconfiguration()?;
        self.stop(false).await?;
        let mut state = self.lock()?;
        if state.qr_generation != generation || cancel.is_cancelled() {
            return Ok(false);
        }
        let mut settings = state.store.load_live_settings().map_err(display)?;
        settings.room_id = Some(room);
        state.store.save_live_settings(&settings).map_err(display)?;
        state.prefs.broadcaster_uid = Some(uid);
        state.prefs.authenticated = authenticated;
        state.save_preferences()?;
        state.status.clear();
        state.status_error = false;
        Ok(true)
    }

    async fn anonymous(&self, payload: &Value) -> Result<(), String> {
        let uid = positive_id(&payload["uid"])?;
        self.require_network()?;
        let (generation, cancel) = {
            let mut state = self.lock()?;
            state.cancel_qr();
            (state.qr_generation, state.qr_cancel.clone())
        };
        let client = QrLoginClient::new().map_err(display)?;
        let room = tokio::select! {
            _=cancel.cancelled()=>return Ok(()),
            result=client.room_id_for_uid(uid,None)=>result.map_err(display)?,
        };
        self.commit_room_resolution(generation, &cancel, uid, room, false)
            .await?;
        Ok(())
    }

    async fn begin_bili(&self) -> Result<(), String> {
        self.require_network()?;
        let (generation, cancel) = self.lock()?.begin_qr("bilibili");
        let client = QrLoginClient::new().map_err(display)?;
        let result = tokio::select! {_=cancel.cancelled()=>return Ok(()),result=client.begin()=>result.map_err(display)};
        let mut state = self.lock()?;
        if state.qr_generation != generation {
            return Ok(());
        }
        state.qr_busy = false;
        match result {
            Ok(challenge) => {
                state.qr.image_data_url = Some(qr_url_png(challenge.qr_url())?);
                state.qr.message = "使用哔哩哔哩扫码登录".into();
                state.bili_qr = Some(Arc::new(AsyncMutex::new(challenge)));
            }
            Err(error) => {
                state.qr.message = error.clone();
                state.qr.status = "expired";
                return Err(error);
            }
        }
        Ok(())
    }

    async fn poll_bili(&self) -> Result<(), String> {
        self.require_network()?;
        let (generation, cancel, challenge) = {
            let mut state = self.lock()?;
            if state.bili_qr.is_none() || !state.qr_poll_ready("bilibili") {
                return Ok(());
            }
            (
                state.qr_generation,
                state.qr_cancel.clone(),
                state.bili_qr.clone().expect("checked QR"),
            )
        };
        let client = QrLoginClient::new().map_err(display)?;
        let result = tokio::select! {
            _=cancel.cancelled()=>return Ok(()),
            result=async {let mut challenge=challenge.lock().await;client.poll(&mut challenge).await}=>result.map_err(display),
        };
        if let Ok(QrPoll::Complete(session)) = result {
            {
                let mut state = self.lock()?;
                if state.qr_generation != generation || cancel.is_cancelled() {
                    return Ok(());
                }
                state.store.save_bili_session(&session).map_err(display)?;
                state.broadcast.invalidate();
                state.bili_user_id = Some(session.user_id());
                state.bili_profile = None;
                state.bili_profile_epoch = state.bili_profile_epoch.wrapping_add(1);
                state.qr.image_data_url = None;
                state.qr.message = "登录成功，正在寻找直播间".into();
                state.bili_qr = None;
            }
            let application = self.clone();
            tokio::spawn(async move {
                application.refresh_bili_profile().await;
            });
            let room = tokio::select! {_=cancel.cancelled()=>return Ok(()),result=client.own_room_id(&session)=>result.map_err(display)};
            match room {
                Ok(room) => {
                    if !self
                        .commit_room_resolution(generation, &cancel, session.user_id(), room, true)
                        .await?
                    {
                        return Ok(());
                    }
                    let mut state = self.lock()?;
                    state.qr_busy = false;
                    state.qr.status = "complete";
                    state.qr.message = "登录成功".into();
                    state.status.clear();
                    state.status_error = false;
                }
                Err(error) => {
                    let mut state = self.lock()?;
                    if state.qr_generation != generation || cancel.is_cancelled() {
                        return Ok(());
                    }
                    state.qr_busy = false;
                    state.qr.status = "expired";
                    state.qr.message =
                        "登录成功，但未找到本账号直播间；可以在下方填写主播 UID".into();
                    return Err(error);
                }
            }
            return Ok(());
        }
        let mut state = self.lock()?;
        if state.qr_generation != generation {
            return Ok(());
        }
        state.qr_busy = false;
        match result {
            Ok(QrPoll::WaitingForScan) => {
                state.qr.status = "waiting";
                state.qr.message = "使用哔哩哔哩扫码登录".into();
            }
            Ok(QrPoll::WaitingForConfirmation) => {
                state.qr.status = "scanned";
                state.qr.message = "请在手机上确认登录".into();
            }
            Ok(QrPoll::Expired) => {
                state.qr.status = "expired";
                state.qr.message = "二维码已过期，点击刷新".into();
                state.qr.image_data_url = None;
                state.bili_qr = None;
            }
            Err(error) => {
                state.qr.message = error.clone();
                return Err(error);
            }
            Ok(QrPoll::Complete(_)) => unreachable!(),
        }
        Ok(())
    }

    async fn begin_doubao(&self, requested_id: Option<&str>) -> Result<(), String> {
        self.require_network()?;
        let (generation, cancel) = {
            let mut state = self.lock()?;
            let connections = state.store.connections().map_err(display)?;
            let id = if let Some(id) = requested_id {
                if !connections
                    .iter()
                    .any(|c| c.id == id && c.settings.provider() == Provider::Doubao)
                {
                    return Err("豆包连接不存在".into());
                }
                id.to_owned()
            } else {
                connections
                    .iter()
                    .find(|c| c.settings.provider() == Provider::Doubao)
                    .map(|c| c.id.clone())
                    .unwrap_or_else(|| Uuid::new_v4().to_string())
            };
            let token = state.begin_qr("doubao");
            state.doubao_connection = Some(id);
            token
        };
        let auth = DoubaoQrAuth::new().map_err(display)?;
        let result = auth.start_qr_login(&cancel).await.map_err(display);
        let mut state = self.lock()?;
        if state.qr_generation != generation || cancel.is_cancelled() {
            return Ok(());
        }
        state.qr_busy = false;
        match result {
            Ok(session) => {
                state.qr.image_data_url = Some(qr_visual_png(session.qr_visual())?);
                state.qr.message = "使用豆包扫码，开启弹幕朗读".into();
                state.doubao_qr = Some(Arc::new(AsyncMutex::new(session)));
            }
            Err(error) => {
                state.qr.status = "expired";
                state.qr.message = error.clone();
                return Err(error);
            }
        }
        Ok(())
    }

    async fn poll_doubao(&self) -> Result<(), String> {
        self.require_network()?;
        let (generation, cancel, session) = {
            let mut state = self.lock()?;
            if state.doubao_qr.is_none() || !state.qr_poll_ready("doubao") {
                return Ok(());
            }
            (
                state.qr_generation,
                state.qr_cancel.clone(),
                state.doubao_qr.clone().expect("checked QR"),
            )
        };
        let auth = DoubaoQrAuth::new().map_err(display)?;
        let (result, cookie) = {
            let mut session = session.lock().await;
            let result = auth
                .poll_qr_login(&mut session, &cancel)
                .await
                .map_err(display);
            let cookie = if matches!(result, Ok(QrStatus::Confirmed)) {
                Some(session.take_confirmed_cookie().map_err(display)?)
            } else {
                None
            };
            (result, cookie)
        };
        let mut state = self.lock()?;
        if state.qr_generation != generation || cancel.is_cancelled() {
            return Ok(());
        }
        state.qr_busy = false;
        match result {
            Ok(QrStatus::Waiting) => {
                state.qr.status = "waiting";
                state.qr.message = "使用豆包扫码，开启弹幕朗读".into();
            }
            Ok(QrStatus::Scanned) => {
                state.qr.status = "scanned";
                state.qr.message = "请在手机上确认登录".into();
            }
            Ok(QrStatus::Expired | QrStatus::Consumed) => {
                state.qr.status = "expired";
                state.qr.message = "二维码已过期，点击刷新".into();
                state.qr.image_data_url = None;
                state.doubao_qr = None;
            }
            Ok(QrStatus::Confirmed) => {
                let id = state
                    .doubao_connection
                    .clone()
                    .ok_or("豆包连接已更改，请重新扫码")?;
                let connection = doubao_connection_for_login(&state.store, &id)?;
                let cookie = cookie.ok_or("扫码尚未确认")?;
                if !save_confirmed_doubao_credential(
                    &mut state.store,
                    &connection,
                    cookie.as_bytes(),
                    &cancel,
                    dobao::DoubaoClient::resume_after_confirmed_login,
                )? {
                    return Ok(());
                }
                state.store.load_or_create_dobao_device().map_err(display)?;
                state.ensure_doubao_default(&id)?;
                state.qr.status = "complete";
                state.qr.message = "豆包已连接".into();
                state.qr.image_data_url = None;
                state.doubao_qr = None;
                state.status.clear();
                state.status_error = false;
            }
            Err(error) => {
                state.qr.message = error.clone();
                return Err(error);
            }
        }
        Ok(())
    }

    /// One startup attempt; window focus and page reloads must never reconnect
    /// a room the user has deliberately disconnected.
    pub async fn auto_connect_saved_room(&self) {
        let epoch = {
            let Ok(mut state) = self.lock() else { return };
            if state.startup_connection_attempted {
                return;
            }
            state.startup_connection_attempted = true;
            if state.network_disabled
                || !state.prefs.onboarding_done
                || state.explicit_stop_epoch != 0
                || state
                    .store
                    .load_live_settings()
                    .ok()
                    .and_then(|s| s.room_id)
                    .is_none()
            {
                return;
            }
            state.explicit_stop_epoch
        };
        if let Err(error) = self
            .connect_with_intent(None, Some(epoch), Some(epoch))
            .await
            && let Ok(mut state) = self.lock()
            && state.explicit_stop_epoch == epoch
            && !state.stopping
            && !state
                .live
                .as_ref()
                .is_some_and(|live| live.snapshot().running)
        {
            state.status = format!("自动连接未完成：{error}。请重试连接或检查直播间设置。");
            state.status_error = true;
        }
    }

    async fn connect(&self, authenticated: Option<bool>) -> Result<(), String> {
        self.connect_with_intent(authenticated, None, None).await
    }

    async fn connect_with_intent(
        &self,
        authenticated: Option<bool>,
        startup_epoch: Option<u64>,
        expected_stop_epoch: Option<u64>,
    ) -> Result<(), String> {
        self.require_network()?;
        let gate = self.lock()?.activity_gate.clone();
        let _activity = gate.lock().await;
        let (controller, scheduler, session, room, generation, cancel) = {
            let mut state = self.lock()?;
            // Automatic recovery and settings-driven restarts must not reopen
            // a listener after a newer explicit Disconnect or Stop All.
            if expected_stop_epoch.is_some_and(|epoch| state.explicit_stop_epoch != epoch) {
                return Ok(());
            }
            if startup_epoch.is_some_and(|epoch| {
                state.explicit_stop_epoch != epoch
                    || !state.prefs.onboarding_done
                    || state.stopping
                    || state.reconfiguring
            }) {
                return Ok(());
            }
            if state.connecting || state.stopping || state.reconfiguring || state.audition_starting
            {
                return Err("正在处理上一项操作，请稍候".into());
            }
            if state.live.as_ref().is_some_and(|l| l.snapshot().running) {
                return Ok(());
            }
            let room = state
                .store
                .load_live_settings()
                .map_err(display)?
                .room_id
                .ok_or("请先设置直播间")?;
            let authenticated = authenticated.unwrap_or(state.prefs.authenticated);
            let session = if authenticated {
                Some(
                    state
                        .store
                        .load_bili_session()
                        .map_err(display)?
                        .ok_or("请先扫码登录 B 站")?,
                )
            } else {
                None
            };
            let (controller, scheduler) = if state.prefs.tts_enabled {
                state.validate_default_voice()?;
                let scheduler = state.ensure_audio()?;
                let device = if state
                    .store
                    .presets()
                    .map_err(display)?
                    .iter()
                    .any(|p| p.provider == Provider::Doubao)
                {
                    Some(state.store.load_or_create_dobao_device().map_err(display)?)
                } else {
                    None
                };
                let controller =
                    LiveController::new(state.store.data_dir(), scheduler.clone(), device)
                        .map_err(display)?;
                (Arc::new(controller), Some(scheduler))
            } else {
                (
                    Arc::new(
                        LiveController::new_receive_only(state.store.data_dir())
                            .map_err(display)?,
                    ),
                    None,
                )
            };
            state.start_cancel = CancellationToken::new();
            state.live_generation = state.live_generation.wrapping_add(1);
            state.connecting = true;
            state.live_receive_only = !state.prefs.tts_enabled;
            state.live = Some(controller.clone());
            (
                controller,
                scheduler,
                session,
                room,
                state.live_generation,
                state.start_cancel.clone(),
            )
        };
        let result = async {
            if let Some(scheduler) = &scheduler {
                scheduler.start().await.map_err(display)?;
            }
            if cancel.is_cancelled() {
                return Err("连接已取消".into());
            }
            controller.start(room, session).await.map_err(display)
        }
        .await;
        let stale = {
            let state = self.lock()?;
            state.live_generation != generation || cancel.is_cancelled()
        };
        if stale {
            let _ = controller.stop().await;
            if let Some(scheduler) = scheduler {
                let _ = scheduler.stop_origin(JobOrigin::Live).await;
            }
            self.lock()?.connecting = false;
            return Ok(());
        }
        let mut state = self.lock()?;
        state.connecting = false;
        if let Err(error) = result {
            state.last_live = controller.snapshot();
            state.live = None;
            return Err(error);
        }
        state.status.clear();
        state.status_error = false;
        Ok(())
    }

    async fn clear_data(&self) -> Result<Value, String> {
        let _transition = self.begin_reconfiguration()?;
        let data_dir = self.data_dir()?;
        // Preflight every managed location before changing either storage or
        // runtime state. Explicit --data-dir may contain unrelated user files.
        let plan = DataResetPlan::inspect(&data_dir)?;
        self.lock()?.broadcast.invalidate();
        self.lock()?.cancel_qr();
        self.stop(true).await?;
        let mut state = self.lock()?;
        state.store.clear_application_data().map_err(display)?;
        state.prefs = state.store.load_desktop_preferences().map_err(display)?;
        state.overlay_server = None;
        state.overlay_error = None;
        state.overlay_settings = state.store.load_overlay_settings().unwrap_or_default();
        let overlay_config = overlay_config(&state.overlay_settings);
        state.overlay_hub.set_config(overlay_config);
        state.overlay_hub.clear_items();
        state.bili_user_id = None;
        state.bili_profile = None;
        state.bili_profile_epoch = state.bili_profile_epoch.wrapping_add(1);
        state.broadcast.invalidate();
        state.scheduler = None;
        state.audio = None;
        state.resume_live_after_default_device_change = false;
        state.last_live = LiveSnapshot::default();
        state.carried_events.clear();
        state.live_receive_only = false;
        state.migration = None;
        state.local_services.stop_owned();
        state.local_services = LocalServices::new(None, None);
        let mut removed = Vec::new();
        let mut cleanup_errors = Vec::new();
        for path in &plan.remove {
            let result = path
                .parent()
                .ok_or_else(|| "应用文件路径无效".to_owned())
                .and_then(|parent| checked_data_entry(path, parent, false))
                .and_then(|()| std::fs::remove_file(path).map_err(display));
            match result {
                Ok(()) => removed.push(plan.relative(path)),
                Err(error) => cleanup_errors.push(format!("{}：{error}", plan.relative(path))),
            }
        }
        for path in &plan.remove_dirs {
            let result = path
                .parent()
                .ok_or_else(|| "应用文件路径无效".to_owned())
                .and_then(|parent| checked_data_entry(path, parent, true))
                .and_then(|()| std::fs::remove_dir(path).map_err(display));
            if let Err(error) = result {
                cleanup_errors.push(format!("{}：{error}", plan.relative(path)));
            }
        }
        if let Err(error) = diagnostics::clear(&data_dir) {
            cleanup_errors.push(format!("运行日志：{error}"));
        }
        match std::env::current_exe() {
            Ok(executable) => match crate::startup::is_enabled(&executable, &data_dir) {
                Ok(true) => {
                    if let Err(error) = crate::startup::set_enabled(&executable, &data_dir, false) {
                        cleanup_errors.push(format!("开机启动：{error}"));
                    }
                }
                Ok(false) => {}
                Err(error) => cleanup_errors.push(format!("开机启动：{error}")),
            },
            Err(error) => cleanup_errors.push(format!("开机启动：{error}")),
        }
        if let Err(error) = state.store.purge_deleted_application_data() {
            cleanup_errors.push(format!("数据库物理清理：{error}"));
        }
        if !cleanup_errors.is_empty() {
            return Err(format!(
                "设置已清除，但后续清理未完成；请关闭其他实例后重试：{}",
                cleanup_errors.join("；")
            ));
        }
        state.status.clear();
        state.status_error = false;
        Ok(
            json!({"removed_paths":removed,"preserved_paths":plan.preserved,"webview_profile":"handled_by_host"}),
        )
    }

    async fn stop(&self, all: bool) -> Result<(), String> {
        let (scheduler, gate) = {
            let mut state = self.lock()?;
            state.resume_live_after_default_device_change = false;
            state.start_cancel.cancel();
            state.live_generation = state.live_generation.wrapping_add(1);
            if all {
                state.audition_cancel.cancel();
                state.generation = state.generation.wrapping_add(1);
            }
            state.pending_stops += 1;
            state.stopping = true;
            if all && let Some(audio) = &state.audio {
                audio.writer.cancel_active();
            }
            (state.scheduler.clone(), state.activity_gate.clone())
        };
        // Silence and close intake before waiting for network shutdown.
        let queue_result = if let Some(scheduler) = &scheduler {
            if all {
                scheduler.stop_all().await.map_err(display)
            } else {
                scheduler
                    .stop_origin(JobOrigin::Live)
                    .await
                    .map_err(display)
            }
        } else {
            Ok(())
        };
        let _activity = gate.lock().await;
        // An already-starting task could have reopened the queue after the
        // first stop. Reassert the requested scope once all starters settled.
        let settled_queue_result = if let Some(scheduler) = &scheduler {
            if all {
                scheduler.stop_all().await.map_err(display)
            } else {
                scheduler
                    .stop_origin(JobOrigin::Live)
                    .await
                    .map_err(display)
            }
        } else {
            Ok(())
        };
        let live = self.lock()?.live.clone();
        let live_result = if let Some(live) = &live {
            live.stop().await.map_err(display)
        } else {
            Ok(())
        };
        let mut state = self.lock()?;
        if let Some(live) = live {
            state.last_live = live.snapshot();
        }
        state.live = None;
        state.pending_stops -= 1;
        state.stopping = state.pending_stops != 0;
        state.connecting = false;
        if all {
            state.audition_starting = false;
        }
        queue_result.and(settled_queue_result).and(live_result)?;
        state.status.clear();
        state.status_error = false;
        Ok(())
    }

    async fn audition(&self, payload: &Value, output_test: bool) -> Result<(), String> {
        if !output_test {
            self.require_network()?;
        }
        let gate = self.lock()?.activity_gate.clone();
        let _activity = gate.lock().await;
        let (preview, prepared, scheduler, generation, cancel) = {
            let mut state = self.lock()?;
            if state.stopping || state.reconfiguring || state.audition_starting || state.connecting
            {
                return Err("正在处理上一项操作，请稍候".into());
            }
            if output_test && state.prefs.playback_volume() <= 0.0 {
                return Err("请先取消静音并调高主音量，再测试声音".into());
            }
            let (preview, prepared) = if output_test {
                PreparedPlayback::output_test()
            } else {
                let preview =
                    if let Some(preset_id) = payload.get("preset_id").and_then(Value::as_str) {
                        state
                            .store
                            .voice_audition_preview(preset_id, required_str(payload, "text")?)
                            .map_err(display)?
                    } else {
                        state.preview(payload)?
                    };
                let device = if preview
                    .voice
                    .as_ref()
                    .is_some_and(|v| v.provider == Provider::Doubao)
                {
                    Some(state.store.load_or_create_dobao_device().map_err(display)?)
                } else {
                    None
                };
                let prepared =
                    PreparedPlayback::from_store(&state.store, &preview, device.as_ref())
                        .map_err(display)?;
                (preview, prepared)
            };
            let scheduler = state.ensure_audio()?;
            state.audition_cancel = CancellationToken::new();
            state.audition_starting = true;
            (
                preview,
                prepared,
                scheduler,
                state.generation,
                state.audition_cancel.clone(),
            )
        };
        let result = async {
            if cancel.is_cancelled() {
                return Err("试听已取消".into());
            }
            scheduler.start().await.map_err(display)?;
            if cancel.is_cancelled() {
                scheduler.stop_all().await.map_err(display)?;
                return Err("试听已取消".into());
            }
            scheduler
                .submit_prepared(preview, JobOrigin::Audition, prepared)
                .await
                .map_err(|e| format!("无法加入试听队列：{e:?}"))?;
            Ok(())
        }
        .await;
        let stale = {
            let mut state = self.lock()?;
            state.audition_starting = false;
            state.generation != generation || cancel.is_cancelled()
        };
        if stale {
            scheduler.stop_all().await.map_err(display)?;
            return Ok(());
        }
        result
    }

    async fn preferences(&self, payload: &Value) -> Result<(), String> {
        // Acquire before reading the patch base or awaiting a live speech
        // change. A second settings request must not merge against old prefs
        // and later overwrite a newer save while this operation is suspended.
        let transition = self.begin_reconfiguration()?;
        let reopen_output = bool_field(payload, "reopen_output", false);
        let (prefs, device_changed, speech_changed, reconnect, stop_epoch) = {
            let state = self.lock()?;
            let mut merged = serde_json::to_value(&state.prefs).map_err(display)?;
            let patch = payload
                .get("preferences")
                .and_then(Value::as_object)
                .ok_or("设置格式无效")?;
            for (key, value) in patch {
                merged[key] = value.clone();
            }
            let prefs: DesktopPreferences = parse(&merged)?;
            prefs.validate().map_err(display)?;
            let changed = state.prefs.output != prefs.output
                || reopen_output
                || state
                    .audio
                    .as_ref()
                    .is_some_and(|a| a.writer.disconnected());
            (
                prefs.clone(),
                changed,
                state.prefs.tts_enabled != prefs.tts_enabled,
                state.live.as_ref().is_some_and(|l| l.snapshot().running),
                state.explicit_stop_epoch,
            )
        };
        // A session started with playback can switch speech on and off in
        // place: reception continues and only live speech jobs stop. Only a
        // receive-only session must restart to gain a playback scheduler.
        let hot_speech = speech_changed && reconnect && !device_changed && {
            let state = self.lock()?;
            state.live.is_some() && (!prefs.tts_enabled || !state.live_receive_only)
        };
        if hot_speech {
            if prefs.tts_enabled {
                self.lock()?.validate_default_voice()?;
            }
            let live = self.lock()?.live.clone();
            if let Some(live) = live {
                live.set_tts_enabled(prefs.tts_enabled)
                    .await
                    .map_err(display)?;
            }
        }
        if speech_changed && reconnect && !device_changed && !hot_speech {
            // Turning speech on for a receive-only session restarts it with
            // playback; keep the messages already on screen instead of clearing them.
            let mut state = self.lock()?;
            let current = state
                .live
                .as_ref()
                .map(|live| live.snapshot().recent_events)
                .unwrap_or_default();
            let carried = carried_chat(&state.carried_events, &current);
            state.carried_events = carried;
        }
        if device_changed {
            confirmed(payload)?;
            self.stop(true).await?;
        } else if speech_changed && !hot_speech {
            self.stop(false).await?;
        }
        {
            let mut state = self.lock()?;
            // Validation happens before replacing the in-memory preferences.
            state
                .store
                .save_desktop_preferences(&prefs)
                .map_err(display)?;
            state.prefs = prefs;
            if device_changed {
                state.audio = None;
                state.scheduler = None;
            }
            state.save_desktop_paths()?;
            if let Some(audio) = &state.audio {
                audio
                    .writer
                    .set_master_volume(state.prefs.playback_volume());
            }
            if reopen_output {
                state
                    .ensure_audio()
                    .map_err(|error| format!("重新连接输出设备失败：{error}"))?;
            }
        }
        drop(transition);
        if reconnect && (device_changed || (speech_changed && !hot_speech)) {
            self.connect_with_intent(None, None, Some(stop_epoch))
                .await?;
        }
        Ok(())
    }

    fn preferred_local_service(&self) -> Result<Option<(Kind, String)>, String> {
        self.lock()?.preferred_local_service()
    }

    pub async fn auto_start_preferred_service(&self) {
        if let Ok(Some((kind, endpoint))) = self.preferred_local_service() {
            self.ensure_local_service(kind, &endpoint, true, None).await;
        }
    }

    async fn save_local_directory(&self, payload: &Value) -> Result<(), String> {
        let kind = Kind::parse(required_str(payload, "provider")?)?;
        let value = payload
            .get("directory")
            .and_then(Value::as_str)
            .ok_or("请选择本地 TTS 目录")?;
        let directory = if value.trim().is_empty() {
            None
        } else {
            Some(local_service::validate_directory(
                kind,
                &absolute_path(value)?,
            )?)
        };
        let _transition = self.begin_reconfiguration()?;
        {
            let mut state = self.lock()?;
            if state.connecting || state.live.as_ref().is_some_and(|l| l.snapshot().running) {
                return Err("请先断开直播再更改本地 TTS 目录".into());
            }
            if state.scheduler.as_ref().is_some_and(|scheduler| {
                let queue = scheduler.state();
                let queue = queue.borrow();
                queue.current.is_some() || !queue.pending.is_empty()
            }) {
                return Err("请先等待播报队列结束再更改本地 TTS 目录".into());
            }
            let slot = state.local_services.get_mut(kind);
            if slot.directory == directory {
                return Ok(());
            }
            let previous = std::mem::replace(&mut slot.directory, directory);
            if let Err(error) = state.save_desktop_paths() {
                state.local_services.get_mut(kind).directory = previous;
                return Err(error);
            }
            let slot = state.local_services.get_mut(kind);
            slot.stop_owned();
            slot.resume_auto_start();
            slot.set(
                if slot.directory.is_some() {
                    "unknown"
                } else {
                    "unconfigured"
                },
                if slot.directory.is_some() {
                    "目录已保存，尚未检查服务"
                } else {
                    "尚未配置本地服务目录"
                },
            );
        }
        let app = self.clone();
        tokio::spawn(async move { app.auto_start_preferred_service().await });
        Ok(())
    }

    fn local_service_endpoint(
        &self,
        kind: Kind,
        connection_id: Option<&str>,
    ) -> Result<String, String> {
        self.lock()?.local_service_endpoint(kind, connection_id)
    }

    async fn start_local_service(&self, payload: &Value) -> Result<(), String> {
        self.require_network()?;
        let kind = Kind::parse(required_str(payload, "provider")?)?;
        let endpoint = self
            .local_service_endpoint(kind, payload.get("connection_id").and_then(Value::as_str))?;
        let generation = {
            let mut state = self.lock()?;
            let slot = state.local_services.get_mut(kind);
            slot.observe_endpoint(&endpoint);
            slot.start_manual();
            slot.generation
        };
        let app = self.clone();
        tokio::spawn(async move {
            app.ensure_local_service(kind, &endpoint, false, Some(generation))
                .await
        });
        Ok(())
    }

    fn stop_local_service(&self, payload: &Value) -> Result<(), String> {
        let kind = Kind::parse(required_str(payload, "provider")?)?;
        let mut state = self.lock()?;
        if state.scheduler.as_ref().is_some_and(|scheduler| {
            let queue = scheduler.state();
            let queue = queue.borrow();
            queue.current.is_some() || !queue.pending.is_empty()
        }) {
            return Err("请先等待播报队列结束或停止全部播报".into());
        }
        let slot = state.local_services.get_mut(kind);
        if !slot.view().owned {
            return Err("此服务不是本应用启动，无法在本应用关闭".into());
        }
        slot.stop_manual();
        Ok(())
    }

    async fn check_local_service(&self, payload: &Value) -> Result<(), String> {
        self.require_network()?;
        let kind = Kind::parse(required_str(payload, "provider")?)?;
        let endpoint = self
            .local_service_endpoint(kind, payload.get("connection_id").and_then(Value::as_str))?;
        let parsed_endpoint = Endpoint::parse(kind, &endpoint)?;
        let (generation, observation) = {
            let mut state = self.lock()?;
            let slot = state.local_services.get_mut(kind);
            slot.observe_endpoint(&endpoint);
            slot.observation = slot.observation.wrapping_add(1);
            (slot.generation, slot.observation)
        };
        let health = local_service::probe(kind, &parsed_endpoint).await;
        let mut state = self.lock()?;
        // The saved address, lifecycle, and newest observation must all still
        // match. A late probe must never resurrect a stopped/reconfigured service.
        if state
            .local_service_endpoint(kind, payload.get("connection_id").and_then(Value::as_str))?
            != endpoint
        {
            return Ok(());
        }
        let slot = state.local_services.get_mut(kind);
        if slot.generation != generation || slot.observation != observation {
            return Ok(());
        }
        slot.process_exited();
        match health {
            Health::Ready => slot.set("ready", "本地服务健康检查已就绪"),
            Health::Offline | Health::Unready | Health::Timeout
                if slot.view().owned && matches!(slot.state, "checking" | "starting") =>
            {
                slot.set("starting", "服务正在加载模型")
            }
            Health::Offline => slot.set("stopped", "本地服务尚未运行"),
            Health::Timeout => slot.set("unknown", "服务检查超时，请稍后重试"),
            Health::Unready => slot.set("failed", "本地服务已响应但模型尚未就绪"),
            Health::Foreign => slot.set("failed", "端口已占用，但不是对应的 TTS 服务"),
            Health::LegacyDots => slot.set(
                "failed",
                "已有旧版 dots 服务不支持任意参考路径；请关闭后用本应用启动",
            ),
        }
        Ok(())
    }

    async fn connect_fish(&self, payload: &mut Value) -> Result<Value, String> {
        self.connect_fish_with_verify(payload, |secret| async move {
            fish::verify_api_key(&secret, &CancellationToken::new())
                .await
                .map_err(display)
        })
        .await
    }

    async fn connect_fish_with_verify<F, Fut>(
        &self,
        payload: &mut Value,
        verify: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Zeroizing<String>) -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        self.require_network()?;
        let secret = match payload.get_mut("credential").map(Value::take) {
            Some(Value::String(value)) if !value.is_empty() => Zeroizing::new(value),
            _ => return Err("请先填写 Fish Audio API Key".into()),
        };
        if secret.trim() != secret.as_str() {
            return Err("API Key 前后不能包含空格".into());
        }
        let generation = self.lock()?.generation;
        verify(secret.clone()).await?;
        let requested_id = payload.get("connection_id").and_then(Value::as_str);
        let mut state = self.lock()?;
        // Stop All is also the boundary used by clear-data, credential removal
        // and migration. Their completed changes must win over a late login.
        if state.generation != generation || state.reconfiguring || state.stopping {
            return Err("Fish Audio 登录已取消，请重新连接账号".into());
        }
        let existing = state
            .store
            .connections()
            .map_err(display)?
            .into_iter()
            .filter(|connection| connection.settings.provider() == Provider::FishAudio)
            .find(|connection| requested_id.is_none_or(|id| id == connection.id));
        if requested_id.is_some() && existing.is_none() {
            return Err("Fish Audio 连接不存在".into());
        }
        let first_connection = existing.is_none();
        let connection = existing.unwrap_or_else(|| ServiceConnection {
            id: Uuid::new_v4().to_string(),
            name: "Fish Audio".into(),
            settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
            has_credential: false,
        });
        state
            .store
            .save_connection_with_credential(&connection, Some(secret.as_bytes()))
            .map_err(display)?;
        if first_connection {
            state
                .store
                .restore_builtin_fish_voices(&connection.id)
                .map_err(display)?;
        }
        let preferred = state
            .store
            .presets()
            .map_err(display)?
            .into_iter()
            .find(|preset| {
                preset.connection_id == connection.id && preset.voice_id == fish::DEFAULT_VOICE_ID
            })
            .map(|preset| preset.id);
        state.ensure_first_default(preferred.as_deref())?;
        state.config_snapshot = None;
        Ok(json!({"id":connection.id,"verified":true}))
    }

    async fn lookup_fish_voice(&self, payload: &Value) -> Result<Value, String> {
        self.require_network()?;
        let connection_id = required_str(payload, "connection_id")?;
        let voice_id =
            fish::normalize_voice_id(required_str(payload, "id_or_url")?).map_err(display)?;
        let secret = {
            let state = self.lock()?;
            let connection = state
                .store
                .connections()
                .map_err(display)?
                .into_iter()
                .find(|connection| connection.id == connection_id)
                .ok_or("Fish Audio 连接不存在")?;
            if connection.settings.provider() != Provider::FishAudio {
                return Err("所选连接不是 Fish Audio".into());
            }
            let protected = state
                .store
                .connection_credential(connection_id)
                .map_err(display)?
                .ok_or("请先连接 Fish Audio 账号")?;
            Zeroizing::new(protected.as_str().map_err(display)?.to_owned())
        };
        let mut config = FishConfig::new(secret.as_str(), voice_id.clone());
        config.timeout_secs = 10;
        let client = FishClient::new(config).map_err(display)?;
        let name = client
            .voice_name(&CancellationToken::new())
            .await
            .map_err(display)?;
        Ok(json!({"voice_id":voice_id,"name":name}))
    }

    async fn ensure_local_service(
        &self,
        kind: Kind,
        endpoint: &str,
        preferred_only: bool,
        requested_generation: Option<u64>,
    ) {
        let requested_endpoint = endpoint;
        let (endpoint, generation) = {
            let Ok(mut state) = self.lock() else { return };
            if state.network_disabled {
                return;
            }
            if preferred_only
                && !matches!(state.preferred_local_service(), Ok(Some((current_kind, current_endpoint))) if current_kind == kind && current_endpoint == requested_endpoint)
            {
                return;
            }
            let slot = state.local_services.get_mut(kind);
            if requested_generation.is_some_and(|value| value != slot.generation)
                || !slot.auto_start_allowed()
            {
                return;
            }
            // Validate only after the lifecycle/selection checks. A delayed
            // task for an invalid old address must not overwrite a newer
            // service state or undo an explicit Stop.
            let endpoint = match Endpoint::parse(kind, endpoint) {
                Ok(endpoint) => endpoint,
                Err(_) => {
                    slot.set("failed", "首选服务地址不是本机 HTTP 地址");
                    return;
                }
            };
            slot.observe_endpoint(requested_endpoint);
            slot.switch_endpoint(endpoint.port);
            slot.generation = slot.generation.wrapping_add(1);
            slot.set("checking", "正在检查本地服务");
            (endpoint, slot.generation)
        };
        match local_service::probe(kind, &endpoint).await {
            Health::Ready => {
                self.set_local_status(kind, Some(generation), "ready", "本地服务已就绪");
                return;
            }
            Health::Timeout => {
                self.set_local_status(
                    kind,
                    Some(generation),
                    "unknown",
                    "服务检查超时，请稍后重试",
                );
                return;
            }
            Health::Unready => {
                self.set_local_status(
                    kind,
                    Some(generation),
                    "failed",
                    "已有服务未就绪，请检查其模型状态",
                );
                return;
            }
            Health::Foreign => {
                self.set_local_status(
                    kind,
                    Some(generation),
                    "failed",
                    "端口已占用，但不是对应的 TTS 服务",
                );
                return;
            }
            Health::LegacyDots => {
                self.set_local_status(
                    kind,
                    Some(generation),
                    "failed",
                    "已有旧版 dots 服务不支持任意参考路径；请关闭后用本应用启动",
                );
                return;
            }
            Health::Offline => {}
        }
        {
            let Ok(mut state) = self.lock() else { return };
            if preferred_only
                && !matches!(state.preferred_local_service(), Ok(Some((current_kind, current_endpoint))) if current_kind == kind && current_endpoint == requested_endpoint)
            {
                return;
            }
            let data_dir = state.store.data_dir().to_path_buf();
            let slot = state.local_services.get_mut(kind);
            if slot.generation != generation || !slot.auto_start_allowed() {
                return;
            }
            if slot.directory.is_none() {
                slot.set("unconfigured", "请选择本地 TTS 安装目录");
                return;
            }
            if let Err(error) = slot.launch(kind, &endpoint, &data_dir) {
                slot.set("failed", "本地服务启动失败");
                slot.message = error;
                return;
            }
        }
        // Model initialization may compile kernels on first run. This task is
        // asynchronous and never blocks the window or retries a failed spawn.
        for _ in 0..360 {
            tokio::time::sleep(Duration::from_secs(5)).await;
            {
                let Ok(mut state) = self.lock() else { return };
                let slot = state.local_services.get_mut(kind);
                if slot.generation != generation || slot.process_exited() {
                    return;
                }
            }
            match local_service::probe(kind, &endpoint).await {
                Health::Ready => {
                    self.set_local_status(kind, Some(generation), "ready", "本地服务已就绪");
                    return;
                }
                Health::Foreign => {
                    self.set_local_status(
                        kind,
                        Some(generation),
                        "failed",
                        "端口被其他服务占用，请检查本地服务",
                    );
                    return;
                }
                Health::LegacyDots => {
                    self.set_local_status(
                        kind,
                        Some(generation),
                        "failed",
                        "已有旧版 dots 服务不支持任意参考路径；请关闭后用本应用启动",
                    );
                    return;
                }
                Health::Offline | Health::Unready | Health::Timeout => {}
            }
        }
        self.set_local_status(
            kind,
            Some(generation),
            "failed",
            "服务加载超过 30 分钟，请检查安装目录",
        );
    }

    fn set_local_status(
        &self,
        kind: Kind,
        generation: Option<u64>,
        status: &'static str,
        message: &'static str,
    ) {
        if let Ok(mut state) = self.lock() {
            let slot = state.local_services.get_mut(kind);
            if generation.is_none_or(|value| value == slot.generation) {
                slot.set(status, message);
            }
        }
    }

    pub fn stop_owned_local_services(&self) {
        if let Ok(mut state) = self.lock() {
            state.broadcast.invalidate();
            state.local_services.stop_owned();
        }
    }

    async fn probe(&self, id: &str) -> Result<Value, String> {
        self.require_network()?;
        let connection = self
            .lock()?
            .store
            .connections()
            .map_err(display)?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or("服务连接不存在")?;
        let ConnectionSettings::Dots {
            endpoint,
            timeout_secs,
        } = connection.settings
        else {
            return Err("此服务通过明确的试听操作验证；健康检查仅适用于 dots.tts".into());
        };
        let mut config = DotsConfig::new(endpoint);
        config.timeout_secs = timeout_secs;
        let client = DotsClient::new(config).map_err(display)?;
        let cancel = CancellationToken::new();
        let health = client.health(&cancel).await.map_err(display)?;
        if !health.ready {
            return Ok(
                json!({"ready":false,"status":health.status,"needs_restart":health.needs_restart,"voices":[]}),
            );
        }
        let voices = client.voices(&cancel).await.map_err(display)?;
        Ok(
            json!({"ready":health.ready,"status":health.status,"needs_restart":health.needs_restart,"voices":voices.into_iter().map(|v|json!({"name":v.name,"size_kb":v.size_kb,"has_prompt_text":v.has_prompt_text})).collect::<Vec<_>>()}),
        )
    }
}

fn doubao_connection_for_login(store: &DataStore, id: &str) -> Result<ServiceConnection, String> {
    let existing = store
        .connections()
        .map_err(display)?
        .into_iter()
        .find(|connection| connection.id == id);
    let mut connection = match existing {
        Some(connection) if connection.settings.provider() == Provider::Doubao => connection,
        Some(_) => return Err("豆包连接已更改，请重新扫码".into()),
        None => ServiceConnection {
            id: id.to_owned(),
            name: "豆包".into(),
            settings: ConnectionSettings::Doubao { timeout_secs: 30 },
            has_credential: false,
        },
    };
    // Keep newly confirmed login requests short even if an older build saved
    // a much longer timeout. Explicit shorter values remain intact.
    if let ConnectionSettings::Doubao { timeout_secs } = &mut connection.settings
        && !(1..=30).contains(timeout_secs)
    {
        *timeout_secs = 30;
    }
    Ok(connection)
}

fn save_confirmed_doubao_credential(
    store: &mut DataStore,
    connection: &ServiceConnection,
    cookie: &[u8],
    cancel: &CancellationToken,
    resume: impl FnOnce(),
) -> Result<bool, String> {
    if cancel.is_cancelled() {
        return Ok(false);
    }
    store
        .save_connection_with_credential(connection, Some(cookie))
        .map_err(display)?;
    resume();
    Ok(true)
}

fn qr_url_png(url: &str) -> Result<String, String> {
    let code = QrCode::new(url.as_bytes()).map_err(display)?;
    let width = code.width();
    let modules: Vec<bool> = code
        .to_colors()
        .into_iter()
        .map(|c| c == Color::Dark)
        .collect();
    matrix_png(width, &modules)
}
fn qr_visual_png(visual: &QrVisual) -> Result<String, String> {
    match visual {
        QrVisual::Png(bytes) => Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )),
        QrVisual::Matrix { width, modules } => matrix_png(*width, modules),
    }
}
fn matrix_png(width: usize, modules: &[bool]) -> Result<String, String> {
    if width == 0 || width > 2048 || modules.len() != width * width {
        return Err("二维码格式无效".into());
    }
    let scale = 5;
    let border = 4;
    let side = (width + border * 2) * scale;
    let mut pixels = vec![255u8; side * side];
    for y in 0..width {
        for x in 0..width {
            if modules[y * width + x] {
                for dy in 0..scale {
                    for dx in 0..scale {
                        pixels[((y + border) * scale + dy) * side + (x + border) * scale + dx] = 0;
                    }
                }
            }
        }
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, side as u32, side as u32);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(display)?;
        writer.write_image_data(&pixels).map_err(display)?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

struct DataResetPlan {
    root: PathBuf,
    remove: Vec<PathBuf>,
    remove_dirs: Vec<PathBuf>,
    preserved: Vec<String>,
}

impl DataResetPlan {
    fn inspect(data_dir: &Path) -> Result<Self, String> {
        let root = data_dir.canonicalize().map_err(display)?;
        let mut plan = Self {
            root,
            remove: Vec::new(),
            remove_dirs: Vec::new(),
            preserved: Vec::new(),
        };
        for entry in std::fs::read_dir(&plan.root).map_err(display)? {
            let path = entry.map_err(display)?.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            match name.as_ref() {
                "danmakuvoice.sqlite3"
                | "danmakuvoice.sqlite3-wal"
                | "danmakuvoice.sqlite3-shm"
                | "danmakuvoice.sqlite3-journal" => {
                    checked_data_entry(&path, &plan.root, false)?;
                }
                "desktop-paths.json" => {
                    checked_data_entry(&path, &plan.root, false)?;
                    plan.remove.push(path);
                }
                "cache" => {
                    checked_data_entry(&path, &plan.root, true)?;
                    for child in std::fs::read_dir(&path).map_err(display)? {
                        let child = child.map_err(display)?.path();
                        match child.file_name().and_then(|name| name.to_str()) {
                            Some("dots") => plan.inspect_owned_cache(&child, &path, 0)?,
                            Some("ffmpeg") => plan.inspect_embedded_ffmpeg_cache(&child, &path)?,
                            _ => plan.preserved.push(plan.relative(&child)),
                        }
                    }
                }
                "references" => {
                    // Reference audio is always an original path now. Older
                    // builds may have stored files here, so keep the entire
                    // directory when clearing application settings.
                    checked_data_entry(&path, &plan.root, true)?;
                    plan.preserved.push(plan.relative(&path));
                }
                "assets" | "backups" | "logs" => {
                    checked_data_entry(&path, &plan.root, true)?;
                    for child in std::fs::read_dir(&path).map_err(display)? {
                        let child = child.map_err(display)?.path();
                        let child_name = child.file_name().unwrap_or_default().to_string_lossy();
                        let owned = match name.as_ref() {
                            "assets" => managed_asset_name(&child_name),
                            "backups" => managed_backup_name(&child_name),
                            _ => matches!(
                                child_name.as_ref(),
                                "current.jsonl"
                                    | "previous-1.jsonl"
                                    | "previous-2.jsonl"
                                    | "previous-3.jsonl"
                                    | "previous-4.jsonl"
                            ),
                        };
                        if owned {
                            checked_data_entry(&child, &path, false)?;
                            if name != "logs" {
                                plan.remove.push(child);
                            }
                        } else {
                            plan.preserved.push(plan.relative(&child));
                        }
                    }
                }
                // The host clears WebView browsing data through its profile API.
                // Unknown directories and all their contents stay untouched.
                _ => plan.preserved.push(plan.relative(&path)),
            }
        }
        Ok(plan)
    }

    fn inspect_owned_cache(
        &mut self,
        path: &Path,
        parent: &Path,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 32 || self.remove.len() + self.remove_dirs.len() > 100_000 {
            return Err("本地 TTS 缓存目录过大，未清除任何数据".into());
        }
        checked_data_entry(path, parent, true)?;
        for entry in std::fs::read_dir(path).map_err(display)? {
            let child = entry.map_err(display)?.path();
            let metadata = std::fs::symlink_metadata(&child).map_err(display)?;
            if metadata.is_dir() {
                self.inspect_owned_cache(&child, path, depth + 1)?;
            } else {
                checked_data_entry(&child, path, false)?;
                self.remove.push(child);
            }
        }
        self.remove_dirs.push(path.to_owned());
        Ok(())
    }

    fn inspect_embedded_ffmpeg_cache(&mut self, path: &Path, parent: &Path) -> Result<(), String> {
        checked_data_entry(path, parent, true)?;
        let mut contains_unknown = false;
        for entry in std::fs::read_dir(path).map_err(display)? {
            let child = entry.map_err(display)?.path();
            let name = child.file_name().unwrap_or_default().to_string_lossy();
            let binary_hash = name
                .strip_prefix("ffmpeg-")
                .and_then(|name| name.strip_suffix(".exe"));
            let temporary_id = name
                .strip_prefix(".ffmpeg-")
                .and_then(|name| name.strip_suffix(".tmp"));
            let owned = binary_hash.is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) || temporary_id.is_some_and(|id| {
                id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
            if owned {
                checked_data_entry(&child, path, false)?;
                self.remove.push(child);
            } else {
                contains_unknown = true;
                self.preserved.push(self.relative(&child));
            }
        }
        if !contains_unknown {
            self.remove_dirs.push(path.to_owned());
        }
        Ok(())
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }
}

fn checked_data_entry(path: &Path, parent: &Path, directory: bool) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(display)?;
    let mut redirected = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        redirected |= metadata.file_attributes() & 0x400 != 0;
    }
    if redirected
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
        || path.canonicalize().map_err(display)?.parent() != Some(parent)
    {
        return Err("应用数据路径含有链接或指向其他位置，未执行清除".into());
    }
    Ok(())
}

fn managed_asset_name(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    matches!(extension, "wav" | "mp3" | "flac" | "ogg" | "aac" | "m4a")
        && Uuid::parse_str(stem).is_ok_and(|id| id.to_string() == stem)
}

fn managed_backup_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".sqlite3") else {
        return false;
    };
    let Some(at) = stem.len().checked_sub(37) else {
        return false;
    };
    if !stem.is_char_boundary(at) || !stem.is_char_boundary(at + 1) {
        return false;
    }
    let (prefix, id) = stem.split_at(at);
    let Some(id) = id.strip_prefix('-') else {
        return false;
    };
    if !Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id) {
        return false;
    }
    if let Some(stamp) = prefix.strip_prefix("before-legacy-import-") {
        return stamp.parse::<u64>().is_ok();
    }
    let parts: Vec<_> = prefix.split('-').collect();
    if let ["before", old, "to", new, stamp] = parts.as_slice() {
        let version = |text: &str| {
            text.strip_prefix('v')
                .and_then(|value| value.parse::<u32>().ok())
        };
        return version(old)
            .zip(version(new))
            .is_some_and(|(old, new)| old > 0 && new > old)
            && stamp.parse::<u64>().is_ok();
    }
    false
}

/// Chat carried over a speech-mode restart, followed by the current session,
/// bounded like a single session's recent events.
fn carried_chat(carried: &[LiveEvent], current: &[LiveEvent]) -> Vec<LiveEvent> {
    let total = carried.len() + current.len();
    let skip = total.saturating_sub(LIVE_RECENT_EVENT_LIMIT);
    carried
        .iter()
        .chain(current.iter())
        .skip(skip)
        .cloned()
        .collect()
}

fn command_changes_configuration(action: &str) -> bool {
    !action.starts_with("bili.broadcast.")
        && !matches!(
            action,
            "bili.qr.begin"
                | "bili.qr.cancel"
                | "doubao.qr.begin"
                | "doubao.qr.cancel"
                | "live.connect"
                | "live.disconnect"
                | "queue.stop"
                | "queue.skip"
                | "queue.clear"
                | "queue.jump"
                | "audition"
                | "audio.test"
                | "rules.preview"
                | "models.scan"
                | "references.list"
                | "fish.settings.get"
                | "fish.voice.lookup"
                | "connections.probe"
                | "configuration.export"
                | "migration.preview"
                | "migration.cancel"
                | "local_services.check"
                | "local_services.start"
                | "local_services.stop"
        )
}
fn new_overlay_token() -> String {
    Uuid::new_v4().simple().to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// Render options sent to overlay pages. The token and port stay in the app.
fn overlay_config(settings: &OverlaySettings) -> Value {
    json!({
        "style": settings.style,
        "corner": settings.corner,
        "scale": settings.scale,
        "vignette": settings.vignette,
        "title": settings.title,
        "tagline": settings.tagline,
        "merge": settings.merge_duplicates,
        "linger_seconds": settings.linger_seconds,
    })
}

/// First result to send. `previous` is `None` when a page just connected:
/// then only the last few messages still on screen are replayed. Otherwise
/// it holds the last result already sent in this live session.
fn overlay_feed_start(
    results: &[ProcessedLiveEvent],
    previous: Option<Option<&ProcessedLiveEvent>>,
    now_ms: u64,
    linger_ms: u64,
) -> usize {
    let start = match previous {
        None => {
            let fresh = results
                .iter()
                .rposition(|result| now_ms.saturating_sub(result.event.observed_at_ms) > linger_ms)
                .map_or(0, |index| index + 1);
            fresh.max(results.len().saturating_sub(3))
        }
        Some(None) => 0,
        Some(Some(last)) => results
            .iter()
            .rposition(|result| result == last)
            .map(|index| index + 1)
            .unwrap_or_else(|| {
                results
                    .iter()
                    .position(|result| result.event.observed_at_ms > last.event.observed_at_ms)
                    .unwrap_or(results.len())
            }),
    };
    start.min(results.len())
}

/// A stable, non-reversible viewer key for avatar colors and grouping.
fn viewer_key(event: &LiveEvent) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match event.user_id {
        Some(id) => id.hash(&mut hasher),
        None => event.user_name.hash(&mut hasher),
    }
    format!("{:016x}", hasher.finish())
}

/// Copy of one processed live message for overlay pages, filtered by the
/// overlay switches. Names are removed here, not in the page.
fn overlay_item(result: &ProcessedLiveEvent, settings: &OverlaySettings) -> Option<Value> {
    let event = &result.event;
    let shown = match event.kind {
        EventKind::Danmaku => settings.show_danmaku,
        EventKind::Gift => settings.show_gift,
        EventKind::SuperChat => settings.show_super_chat,
        EventKind::Guard => settings.show_guard,
    };
    if !shown {
        return None;
    }
    let named = match settings.names {
        OverlayNames::None => false,
        OverlayNames::Special => event.kind != EventKind::Danmaku,
        OverlayNames::All => true,
    };
    Some(json!({
        "kind": event.kind,
        "viewer": viewer_key(event),
        "name": if named { event.user_name.as_str() } else { "" },
        "avatar": event.avatar_url,
        "message": event.message,
        "emotes": event.emotes,
        "sticker": event.is_bilibili_emoticon,
        "gift": event.gift_name,
        "quantity": event.quantity,
        "price": event.price_yuan,
        "guard": event.guard_name,
        "at": event.observed_at_ms,
        "job_id": match result.outcome {
            LiveEventOutcome::Enqueued { job_id } => Some(job_id),
            _ => None,
        },
    }))
}

/// Test messages appear only on overlay pages: they are not chat, never
/// enter the playback queue and never reach the B站 connection.
fn overlay_demo_item(kind: &str, settings: &OverlaySettings) -> Result<Value, String> {
    let named = settings.names != OverlayNames::None;
    let item = match kind {
        "danmaku" => json!({
            "kind": "danmaku",
            "message": "这是一条测试弹幕，OBS 里看到它就说明已经连好了",
            "demo_read_ms": 4200,
        }),
        "super_chat" => json!({
            "kind": "super_chat",
            "name": if named { "弹幕姬测试" } else { "" },
            "message": "测试醒目留言：今晚也要开开心心～",
            "price": 50,
            "demo_read_ms": 3600,
        }),
        _ => return Err("不支持的测试内容".into()),
    };
    let mut item = item;
    item["viewer"] = json!("demo");
    item["demo"] = json!(true);
    item["at"] = json!(now_ms());
    Ok(item)
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn parse<T: DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|_| "表单内容不完整或格式无效".into())
}
fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("请填写 {key}"))
}
fn bool_field(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(default)
}
fn positive_id(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| *n > 0)
        .ok_or_else(|| "UID / 房间号必须是正整数".into())
}
fn confirmed(payload: &Value) -> Result<(), String> {
    if bool_field(payload, "confirmed", false) {
        Ok(())
    } else {
        Err("请先确认此操作".into())
    }
}
fn absolute_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("请选择完整的绝对路径".into())
    }
}
fn devices_json() -> Value {
    match audio::enumerate_devices() {
        Ok(devices)=>json!(devices.into_iter().map(|d|json!({"name":d.name,"is_default":d.is_default,"selection":{"named":d.name}})).collect::<Vec<_>>()),
        Err(_)=>json!([]),
    }
}
fn preview_json(p: &RulePreview) -> Value {
    json!({"event":p.event,"filtered_reason":p.filtered_reason,"final_text":p.final_text,"parts":p.parts,"voice":p.voice,"pending_legacy_binding":p.pending_legacy_binding})
}
fn job_json(j: &SpeechJob) -> Value {
    json!({"id":j.id,"origin":if j.origin==JobOrigin::Live{"live"}else{"audition"},"text":j.preview.final_text,"user_name":j.preview.event.user_name})
}
fn queue_json(q: &QueueSnapshot) -> Value {
    json!({"accepting":q.accepting,"current":q.current.as_ref().map(job_json),"pending":q.pending.iter().map(job_json).collect::<Vec<_>>(),"history":q.history.iter().map(|h|json!({"id":h.id,"state":format!("{:?}",h.state).to_lowercase(),"detail":h.detail})).collect::<Vec<_>>()})
}
fn room_state(state: &RoomState) -> (&'static str, String) {
    match state {
        RoomState::Stopped => ("stopped", "尚未连接".into()),
        RoomState::SessionExpired { .. } => (
            "session_expired",
            "哔哩哔哩登录已失效，请重新扫码 [DV-B09]".into(),
        ),
        RoomState::Connecting { .. } => ("connecting", "正在连接".into()),
        RoomState::Connected { .. } => ("connected", "已连接，等待弹幕".into()),
        RoomState::Reconnecting { .. } => ("reconnecting", "连接中断，正在重连".into()),
    }
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
