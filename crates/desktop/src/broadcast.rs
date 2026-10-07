//! Desktop broadcast state. Polling contains no RTMP credentials; only explicit
//! user reveal/copy commands return them. Only local session observations are
//! persisted; stream credentials remain in memory.
//!
//! Optional OBS link (experimental): on go-live the push target is written to
//! OBS through obs-websocket and the stream starts; on end the OBS stream stops
//! before the room closes. The WebSocket password is DPAPI-protected in the
//! store; the stream key only travels in memory to the loopback connection.
use super::{Application, confirmed, display, qr_url_png};
use danmakuvoice_engine::{
    bilibili::{BiliError, BiliSession},
    broadcast::{BroadcastClient, BroadcastRoom, LiveArea, PushCredentials, StartBroadcast},
    obs::{self, ObsError, ObsPush, ObsSettings},
    obs_process,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Default)]
pub(super) struct BroadcastState {
    pub(super) room: Option<BroadcastRoom>,
    areas: Vec<LiveArea>,
    credentials: Option<PushCredentials>,
    face_image: Option<Zeroizing<String>>,
    busy: bool,
    epoch: u64,
    cancel: CancellationToken,
}

impl BroadcastState {
    pub(super) fn view(&self) -> Value {
        json!({"room":self.room, "areas":self.areas, "busy":self.busy,
            "has_stream_key":self.credentials.is_some(),
            "face_image":self.face_image.as_deref().map(|s| s.as_str())})
    }

    pub(super) fn invalidate(&mut self) {
        self.cancel.cancel();
        *self = Self {
            epoch: self.epoch.wrapping_add(1),
            ..Self::default()
        };
    }
}

/// Saved OBS connection and its decrypted WebSocket password, if any.
type ObsLink = (ObsSettings, Option<Zeroizing<String>>);

/// OBS operations are independent of the live room and TTS. Settings changes
/// cancel their old network work; request numbers reject older probe results.
#[derive(Default)]
pub(super) struct ObsActivity {
    epoch: u64,
    probe_request: u64,
    cancel: CancellationToken,
    source_gate: std::sync::Arc<tokio::sync::Mutex<()>>,
    recovery: ObsRecovery,
}

#[derive(Default)]
struct ObsRecovery {
    in_flight: bool,
    next_attempt: Option<tokio::time::Instant>,
    missing_since: Option<tokio::time::Instant>,
    obs_generation: u64,
    reload_attempted: bool,
    failures: u8,
}

pub(super) const OBS_RECOVERY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

impl ObsRecovery {
    fn begin(
        &mut self,
        now: tokio::time::Instant,
        health: (usize, u64),
        force: bool,
    ) -> Option<bool> {
        if health.1 != self.obs_generation || health.0 > 0 {
            self.obs_generation = health.1;
            self.missing_since = None;
            self.reload_attempted = false;
            self.failures = 0;
            self.next_attempt = None;
            if health.0 > 0 && !force {
                return None;
            }
        }
        if self.in_flight || !force && self.next_attempt.is_some_and(|next| now < next) {
            return None;
        }
        let refresh = health.0 == 0
            && !self.reload_attempted
            && now.duration_since(*self.missing_since.get_or_insert(now)) >= OBS_RECOVERY_INTERVAL;
        self.in_flight = true;
        self.next_attempt = Some(now + OBS_RECOVERY_INTERVAL);
        Some(refresh)
    }

    fn finish(&mut self, now: tokio::time::Instant, success: bool) {
        self.in_flight = false;
        self.failures = if success {
            0
        } else {
            self.failures.saturating_add(1).min(4)
        };
        let multiplier = 1u32 << self.failures.saturating_sub(1);
        // Anchor to the attempt's start, not its completion: a quick request
        // finishing just after a tick must not miss the next 15-second tick.
        let started =
            self.next_attempt.unwrap_or(now + OBS_RECOVERY_INTERVAL) - OBS_RECOVERY_INTERVAL;
        self.next_attempt = Some((started + OBS_RECOVERY_INTERVAL * multiplier).max(now));
    }
}

struct ObsRecoveryGuard(Application, u64);
impl Drop for ObsRecoveryGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock()
            && state.obs_activity.epoch == self.1
        {
            state.obs_activity.recovery.in_flight = false;
        }
    }
}

struct ObsRequest {
    epoch: u64,
    number: u64,
    cancel: CancellationToken,
}

impl super::Controller {
    fn owns_overlay_endpoint(&self) -> Result<bool, String> {
        let saved = self.store.load_overlay_settings().map_err(display)?;
        Ok(saved.enabled == self.overlay_settings.enabled
            && saved.port == self.overlay_settings.port
            && saved.token == self.overlay_settings.token)
    }

    fn pause_superseded_overlay(&mut self) {
        self.obs_status["overlay_sync"] = json!({"state":"paused","reason":"another_instance",
            "message":"叠加层已由另一个应用窗口接管 [DV-OB15]"});
    }

    pub(super) fn obs_view_status(&self) -> Value {
        let mut status = self.obs_status.clone();
        if let Some(sync) = status.get_mut("overlay_sync") {
            sync["page_connected"] = json!(self.overlay_hub.obs_health().0 > 0);
        }
        status
    }

    pub(super) fn invalidate_obs_activity(&mut self, reset_status: bool) {
        self.obs_activity.cancel.cancel();
        self.obs_activity.cancel = CancellationToken::new();
        self.obs_activity.epoch = self.obs_activity.epoch.wrapping_add(1);
        self.obs_activity.recovery = ObsRecovery::default();
        if reset_status {
            self.obs_status = json!({"state":"idle"});
        } else if let Some(status) = self.obs_status.as_object_mut() {
            status.remove("overlay_sync");
        }
    }
}

const OBS_ACTIVITY_CANCELLED: &str = "OBS 或叠加层设置已变更，请重新检测 [DV-OB14]";
const OBS_OVERLAY_LIMIT: std::time::Duration = std::time::Duration::from_secs(30);

struct BroadcastGuard(Application, u64);

impl Drop for BroadcastGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock()
            && state.broadcast.epoch == self.1
        {
            state.broadcast.busy = false;
        }
    }
}

enum Operation {
    Refreshed(BroadcastRoom, Vec<LiveArea>),
    Updated(BroadcastRoom),
    Started(BroadcastRoom, StartBroadcast),
    Stopped(BroadcastRoom),
}

impl Application {
    pub fn own_broadcast_page(&self) -> Result<String, String> {
        self.require_network()?;
        let state = self.lock()?;
        if state.bili_user_id.is_none() {
            return Err("请先扫码登录哔哩哔哩，再管理自己的直播间 [DV-B10]".into());
        }
        let room = state
            .broadcast
            .room
            .as_ref()
            .ok_or("请先加载自己的开播信息 [DV-B10]")?;
        Ok(format!("https://live.bilibili.com/{}", room.room_id))
    }

    pub(super) async fn broadcast_command(
        &self,
        action: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        if !matches!(
            action,
            "bili.broadcast.refresh"
                | "bili.broadcast.update"
                | "bili.broadcast.start"
                | "bili.broadcast.stop"
                | "bili.broadcast.credentials"
                | "bili.broadcast.forget"
        ) {
            return Err("不支持的开播管理操作 [DV-B10]".into());
        }
        if action == "bili.broadcast.forget" {
            let mut state = self.lock()?;
            let room = state.broadcast.room.take();
            let areas = std::mem::take(&mut state.broadcast.areas);
            state.broadcast.invalidate();
            state.broadcast.room = room;
            state.broadcast.areas = areas;
            return Ok(Value::Null);
        }
        if matches!(
            action,
            "bili.broadcast.start"
                | "bili.broadcast.stop"
                | "bili.broadcast.update"
                | "bili.broadcast.credentials"
        ) {
            confirmed(payload)?;
        }
        if action == "bili.broadcast.credentials" {
            let state = self.lock()?;
            if state.broadcast.busy {
                return Err("开播管理正在处理请求，请稍候 [DV-B10]".into());
            }
            return state
                .broadcast
                .credentials
                .as_ref()
                .map(|credentials| json!(credentials))
                .ok_or_else(|| "当前没有推流信息，请点击开播获取 [DV-B10]".into());
        }
        self.require_network()?;
        let (session, epoch, cancel, obs_cancel) = {
            let mut state = self.lock()?;
            if state.broadcast.busy {
                return Err("开播管理正在处理请求，请稍候 [DV-B10]".into());
            }
            let session = state
                .store
                .load_bili_session()
                .map_err(display)?
                .ok_or("请先扫码登录哔哩哔哩，再管理自己的直播间 [DV-B10]")?;
            if state.bili_user_id != Some(session.user_id()) {
                return Err("账号已变更，请重新登录后管理直播间 [DV-B10]".into());
            }
            if action == "bili.broadcast.start" {
                state.broadcast.credentials = None;
                state.broadcast.face_image = None;
            }
            state.broadcast.busy = true;
            (
                session,
                state.broadcast.epoch,
                state.broadcast.cancel.clone(),
                state.obs_activity.cancel.clone(),
            )
        };
        let _guard = BroadcastGuard(self.clone(), epoch);
        // End the OBS stream first so OBS does not keep pushing into a closed room.
        // A failure here is reported but never blocks closing the room.
        let obs_stop = if action == "bili.broadcast.stop" {
            match self.obs_link() {
                Ok(Some((settings, password))) => Some(tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("账号已变更，开播管理请求已取消；请刷新房间状态 [DV-B10]".into()),
                    _ = obs_cancel.cancelled() => Err(OBS_ACTIVITY_CANCELLED.to_owned()),
                    result = obs::stop(&settings, password.as_deref().map(|p| p.as_str())) => result.map_err(|error| error.to_string()),
                }),
                Ok(None) => None,
                // An unreadable saved password must not keep the room open.
                Err(message) => Some(Err(message)),
            }
        } else {
            None
        };
        if let Some(result) = &obs_stop
            && !obs_cancel.is_cancelled()
        {
            self.record_obs(result.as_ref().map(|_| false).map_err(String::clone))?;
        }
        // Start a local OBS first so it boots while Bilibili answers.
        let obs_launch = if action == "bili.broadcast.start" && !obs_cancel.is_cancelled() {
            match self.obs_link() {
                Ok(Some((settings, _))) => {
                    // Serialize the final launch with shutdown/settings changes.
                    // OBS is independent: once launched it must never be killed
                    // to compensate for an already cancelled request.
                    let state = self.lock()?;
                    if state.shutdown.is_cancelled()
                        || cancel.is_cancelled()
                        || obs_cancel.is_cancelled()
                    {
                        Some(Err(OBS_ACTIVITY_CANCELLED.to_owned()))
                    } else {
                        Some(launch_obs_if_needed(&settings).map_err(|error| error.to_string()))
                    }
                }
                _ => None,
            }
        } else {
            None
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("账号已变更，开播管理请求已取消；请刷新房间状态 [DV-B10]".into()),
            result = perform(action, payload, &session) => result,
        };
        let obs_push = {
            let mut state = self.lock()?;
            if state.broadcast.epoch != epoch || state.bili_user_id != Some(session.user_id()) {
                return Err("账号已变更，请重新加载自己的直播间 [DV-B10]".into());
            }
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    if matches!(error, BiliError::SessionExpired) {
                        state.broadcast.invalidate();
                    }
                    let message = display(error);
                    return Err(match obs_stop {
                        Some(Ok(_)) => format!("OBS 已停止推流，但{message}"),
                        _ => message,
                    });
                }
            };
            let mut obs_push = None;
            // start() may fill live_since from the local clock. Its live
            // transition is real, but only get_info establishes a start key.
            let authoritative_start = !matches!(&result, Operation::Started(..));
            match result {
                Operation::Refreshed(room, areas) => {
                    if room.live_status != 1 {
                        state.broadcast.credentials = None;
                    }
                    state.broadcast.room = Some(room);
                    state.broadcast.areas = areas;
                }
                Operation::Updated(mut room) => {
                    if let Some(parent) = state
                        .broadcast
                        .areas
                        .iter()
                        .find(|p| p.children.iter().any(|c| c.id == room.area_id))
                    {
                        room.parent_area_id = parent.id;
                    }
                    state.broadcast.room = Some(room);
                }
                Operation::Started(room, result) => {
                    state.broadcast.room = Some(room);
                    match result {
                        StartBroadcast::Started(credentials) => {
                            obs_push = Some((
                                Zeroizing::new(credentials.address.clone()),
                                Zeroizing::new(credentials.stream_key.clone()),
                            ));
                            state.broadcast.credentials = Some(credentials);
                            state.broadcast.face_image = None;
                        }
                        StartBroadcast::FaceVerification(url) => {
                            state.broadcast.face_image = Some(Zeroizing::new(qr_url_png(&url)?));
                        }
                    }
                }
                Operation::Stopped(room) => {
                    state.broadcast.room = Some(room);
                    state.broadcast.credentials = None;
                    state.broadcast.face_image = None;
                }
            }
            let observed_at = super::broadcast_sessions::observed_now();
            if authoritative_start {
                state.observe_broadcast_room(observed_at)?;
            } else {
                state.observe_broadcast_room_with_start_authority(observed_at, false)?;
            }
            obs_push
        };
        if let Some(result) = obs_stop {
            return Ok(json!({"obs": obs_outcome(result.map(|outcome| json!(outcome)), false)}));
        }
        let Some((server, key)) = obs_push else {
            return Ok(Value::Null);
        };
        if obs_cancel.is_cancelled() {
            return Ok(json!({"obs":obs_outcome(Err(OBS_ACTIVITY_CANCELLED.to_owned()), false)}));
        }
        // The room is open from here on; a stored-password problem is a warning too.
        let (settings, password) = match self.obs_link() {
            Ok(Some(link)) => link,
            Ok(None) => return Ok(Value::Null),
            Err(message) => {
                self.record_obs(Err(message.clone()))?;
                return Ok(json!({"obs": obs_outcome(Err(message), false)}));
            }
        };
        let launched = match obs_launch {
            Some(Err(message)) => {
                self.record_obs(Err(message.clone()))?;
                return Ok(json!({"obs": obs_outcome(Err(message), false)}));
            }
            Some(Ok(launched)) => launched,
            None => false,
        };
        if launched {
            let ready = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("账号已变更，开播管理请求已取消；请刷新房间状态 [DV-B10]".into()),
                _ = obs_cancel.cancelled() => return Ok(json!({"obs":obs_outcome(Err(OBS_ACTIVITY_CANCELLED.to_owned()), launched)})),
                ready = obs::wait_until_ready(&settings, password.as_deref().map(|p| p.as_str()), OBS_READY_LIMIT) => ready,
            };
            if let Err(error) = ready {
                let message = error.to_string();
                self.record_obs(Err(message.clone()))?;
                return Ok(json!({"obs": obs_outcome(Err(message), true)}));
            }
        }
        // The room is already open. OBS problems become a warning for the
        // person, who can still copy the push details by hand.
        let push = ObsPush {
            server: &server,
            key: &key,
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("账号已变更，开播管理请求已取消；请刷新房间状态 [DV-B10]".into()),
            _ = obs_cancel.cancelled() => Err(OBS_ACTIVITY_CANCELLED.to_owned()),
            result = obs::start(&settings, password.as_deref().map(|p| p.as_str()), &push) => result.map_err(|error| error.to_string()),
        };
        if !obs_cancel.is_cancelled() {
            self.record_obs(result.as_ref().map(|_| true).map_err(String::clone))?;
        }
        Ok(json!({"obs": obs_outcome(result.map(|outcome| json!(outcome)), launched)}))
    }

    /// Saved connection and password, whether or not the go-live link is on.
    fn obs_connection(&self) -> Result<ObsLink, String> {
        let state = self.lock()?;
        let password = if state.obs_has_password {
            state.store.load_obs_password().map_err(display)?
        } else {
            None
        };
        Ok((state.obs_settings.clone(), password))
    }

    fn begin_obs_probe(&self) -> Result<(ObsRequest, ObsLink), String> {
        let mut state = self.lock()?;
        Self::begin_obs_probe_in(&mut state)
    }

    fn begin_obs_probe_in(state: &mut super::Controller) -> Result<(ObsRequest, ObsLink), String> {
        let password = if state.obs_has_password {
            state.store.load_obs_password().map_err(display)?
        } else {
            None
        };
        state.obs_activity.probe_request = state.obs_activity.probe_request.wrapping_add(1);
        Ok((
            ObsRequest {
                epoch: state.obs_activity.epoch,
                number: state.obs_activity.probe_request,
                cancel: state.obs_activity.cancel.clone(),
            },
            (state.obs_settings.clone(), password),
        ))
    }

    fn record_probe_for(
        &self,
        request: &ObsRequest,
        result: Result<&obs::ObsProbe, &ObsError>,
    ) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.obs_activity.epoch != request.epoch
            || state.obs_activity.probe_request != request.number
            || request.cancel.is_cancelled()
        {
            return Ok(());
        }
        let overlay_sync = state.obs_status.get("overlay_sync").cloned();
        state.obs_status = match result {
            Ok(found) => json!({"state":"ok","streaming":found.streaming,
                "obs_version":found.obs_version,"websocket_version":found.websocket_version}),
            Err(error) => json!({"state":"error","message":error.to_string()}),
        };
        if let Some(sync) = overlay_sync {
            state.obs_status["overlay_sync"] = sync;
        }
        Ok(())
    }

    /// Request an immediate safe recovery after the loopback server is ready. No
    /// OBS launch, source creation, scene change or stream operation is allowed.
    pub(super) fn schedule_existing_obs_overlay(&self) {
        self.schedule_obs_overlay_recovery(true);
    }

    /// A low-frequency app-lifetime recovery. Healthy OBS pages need no probe;
    /// missing pages get at most one forced reload per disconnection episode.
    pub(super) fn schedule_obs_overlay_recovery(&self, force: bool) {
        self.schedule_obs_overlay_recovery_at(force, tokio::time::Instant::now());
    }

    pub(super) fn schedule_obs_overlay_recovery_at(&self, force: bool, now: tokio::time::Instant) {
        let attempt = (|| -> Result<Option<(u64, bool)>, String> {
            let mut state = self.lock()?;
            if state.shutdown.is_cancelled()
                || state.network_disabled
                || !state.overlay_settings.enabled
                || state.overlay_server.is_none()
                || !state.obs_settings.is_local()
            {
                return Ok(None);
            }
            let health = state.overlay_hub.obs_health();
            if !state.owns_overlay_endpoint()? {
                state.pause_superseded_overlay();
                return Ok(None);
            }
            let epoch = state.obs_activity.epoch;
            Ok(state
                .obs_activity
                .recovery
                .begin(now, health, force)
                .map(|refresh| (epoch, refresh)))
        })();
        if let Ok(Some((epoch, refresh))) = attempt {
            let app = self.clone();
            tokio::spawn(async move {
                let _guard = ObsRecoveryGuard(app.clone(), epoch);
                let result = app.put_obs_overlay_mode(true, refresh, true).await;
                if let Ok(mut state) = app.lock()
                    && state.obs_activity.epoch == epoch
                {
                    state
                        .obs_activity
                        .recovery
                        .finish(tokio::time::Instant::now(), result.is_ok());
                }
            });
        }
    }

    /// Saved OBS link and password when the link is on.
    fn obs_link(&self) -> Result<Option<ObsLink>, String> {
        if !self.lock()?.obs_settings.enabled {
            return Ok(None);
        }
        self.obs_connection().map(Some)
    }

    /// Remember the last explicit result; a success keeps known versions.
    fn record_obs(&self, result: Result<bool, String>) -> Result<(), String> {
        let mut state = self.lock()?;
        // Explicit stream actions supersede a status probe already in flight.
        state.obs_activity.probe_request = state.obs_activity.probe_request.wrapping_add(1);
        let overlay_sync = state.obs_status.get("overlay_sync").cloned();
        state.obs_status = match result {
            Ok(streaming) => {
                let mut status = json!({"state": "ok", "streaming": streaming});
                if state.obs_status["state"] == "ok" {
                    for key in ["obs_version", "websocket_version"] {
                        if let Some(value) = state.obs_status.get(key) {
                            status[key] = value.clone();
                        }
                    }
                }
                status
            }
            Err(message) => json!({"state": "error", "message": message}),
        };
        if let Some(sync) = overlay_sync {
            state.obs_status["overlay_sync"] = sync;
        }
        Ok(())
    }

    /// `settings` may hold only the fields one form edits; the rest stay as saved.
    pub(super) fn save_obs(&self, payload: &Value) -> Result<(), String> {
        let invalid = || "OBS 联动设置不完整或格式无效 [DV-S38]".to_owned();
        let edited = payload["settings"].as_object().ok_or_else(invalid)?;
        let mut state = self.lock()?;
        let mut merged = json!(state.obs_settings);
        for (key, value) in edited {
            if !["enabled", "host", "port", "auto_launch", "executable"].contains(&key.as_str()) {
                return Err(invalid());
            }
            merged[key] = value.clone();
        }
        let edited: ObsSettings = serde_json::from_value(merged).map_err(|_| invalid())?;
        let settings = ObsSettings {
            host: edited.host.trim().to_owned(),
            executable: edited
                .executable
                .map(|path| path.trim().to_owned())
                .filter(|path| !path.is_empty()),
            ..edited
        };
        state.store.save_obs_settings(&settings).map_err(display)?;
        if state.obs_settings != settings {
            state.invalidate_obs_activity(true);
        }
        state.obs_settings = settings;
        drop(state);
        // Re-detect after a choice changes, e.g. OBS was installed meanwhile.
        let detected = detect_obs();
        self.lock()?.obs_detected = detected;
        Ok(())
    }

    /// Start OBS on this computer if it is not running, wait until its
    /// WebSocket answers, then report like the connection test.
    pub(super) async fn launch_obs(&self) -> Result<Value, String> {
        self.require_network()?;
        let (request, (settings, password)) = self.begin_obs_probe()?;
        if !settings.is_local() {
            return Err("OBS 设在其他电脑上，弹幕姬只能启动本机的 OBS [DV-X18]".into());
        }
        let started = (|| -> Result<bool, ObsError> {
            if obs_process::is_running() {
                return Ok(false);
            }
            let executable = obs_process::resolve(settings.executable.as_deref())?;
            // Path detection can take time; check ownership immediately before
            // launch while holding the same lock used by shutdown.
            let state = self.lock().map_err(|_| ObsError::Protocol("应用状态"))?;
            if state.shutdown.is_cancelled()
                || request.cancel.is_cancelled()
                || state.obs_activity.epoch != request.epoch
            {
                return Err(ObsError::Protocol(OBS_ACTIVITY_CANCELLED));
            }
            obs_process::launch(&executable)?;
            Ok(true)
        })();
        let operation = async {
            match started {
                Ok(started) => {
                    let password = password.as_deref().map(|p| p.as_str());
                    match obs::wait_until_ready(&settings, password, OBS_READY_LIMIT).await {
                        Ok(()) => obs::probe(&settings, password)
                            .await
                            .map(|found| (started, found)),
                        Err(error) => Err(error),
                    }
                }
                Err(error) => Err(error),
            }
        };
        let result = tokio::select! {
            biased;
            _ = request.cancel.cancelled() => return Err(OBS_ACTIVITY_CANCELLED.into()),
            result = operation => result,
        };
        self.record_probe_for(&request, result.as_ref().map(|(_, found)| found))?;
        if result.is_ok() && !request.cancel.is_cancelled() {
            self.schedule_existing_obs_overlay();
        }
        result
            .map(|(started, found)| {
                let mut value = json!(found);
                value["launched"] = json!(started);
                value
            })
            .map_err(|error| error.to_string())
    }

    /// Put the overlay into OBS's current scene as a browser source (or
    /// update an existing one). `update_only` never creates or adds.
    pub(super) async fn add_overlay_to_obs(&self, payload: &Value) -> Result<Value, String> {
        self.put_obs_overlay(payload["update_only"].as_bool().unwrap_or(false))
            .await
    }

    /// This cannot add a source or alter scene visibility. Automatic callers
    /// also respect the endpoint most recently saved by another app instance.
    pub(super) async fn sync_existing_obs_overlay(&self, payload: &Value) -> Result<Value, String> {
        self.put_obs_overlay_mode(true, false, payload["automatic"].as_bool().unwrap_or(false))
            .await
    }

    async fn put_obs_overlay(&self, update_only: bool) -> Result<Value, String> {
        self.put_obs_overlay_mode(update_only, false, false).await
    }

    async fn put_obs_overlay_mode(
        &self,
        update_only: bool,
        refresh_disconnected: bool,
        automatic: bool,
    ) -> Result<Value, String> {
        self.require_network()?;
        let gate = self.lock()?.obs_activity.source_gate.clone();
        let _gate = gate.lock().await;
        self.require_network()?;
        let (request, (settings, password), url) = {
            let mut state = self.lock()?;
            if !state.overlay_settings.enabled || state.overlay_server.is_none() {
                return Err("请先启用 OBS 叠加层".into());
            }
            if automatic && !state.owns_overlay_endpoint()? {
                state.pause_superseded_overlay();
                return Err(obs::ObsError::OverlaySuperseded.to_string());
            }
            let url = state.overlay_view()["url"]
                .as_str()
                .map(str::to_owned)
                .ok_or("缺少叠加层设置")?;
            let (request, link) = Self::begin_obs_probe_in(&mut state)?;
            state.obs_status["overlay_sync"] = json!({"state":"syncing"});
            (request, link, url)
        };
        let hub = self.lock()?.overlay_hub.clone();
        let result = tokio::select! {
            biased;
            _ = request.cancel.cancelled() => return Err(OBS_ACTIVITY_CANCELLED.into()),
            result = tokio::time::timeout(OBS_OVERLAY_LIMIT, obs::probe_and_recover_overlay_source(
            &settings,
            password.as_deref().map(|p| p.as_str()),
            &url,
            update_only,
            refresh_disconnected,
            || hub.obs_health().0 == 0,
            || !automatic || self.lock().is_ok_and(|state| state.owns_overlay_endpoint().unwrap_or(false)),
        )) => result.unwrap_or(Err(ObsError::Timeout)),
        };
        // A source conflict is not a failed transport. Remote-address refusal
        // is also a source limitation, never proof that OBS is unreachable.
        match &result {
            Ok(found) => self.record_probe_for(&request, Ok(&found.probe))?,
            Err(ObsError::OverlayRemote | ObsError::OverlayConflict) => {}
            Err(error) => self.record_probe_for(&request, Err(error))?,
        }
        let refresh_attempted = result.as_ref().is_ok_and(|found| found.refresh_attempted)
            || refresh_disconnected && matches!(result, Err(ObsError::Timeout));
        let outcome = result.and_then(|found| found.overlay);
        let mut sync = match &outcome {
            Ok(found) if !found.found => json!({"state":"missing"}),
            Ok(found) => json!({"state":if found.updated {"updated"} else {"ready"}}),
            Err(error) => json!({"state":"error","message":error.to_string()}),
        };
        let mut state = self.lock()?;
        if state.obs_activity.epoch != request.epoch
            || request.cancel.is_cancelled()
            || state.overlay_server.is_none()
            || state.overlay_view()["url"] != url
        {
            return Err(OBS_ACTIVITY_CANCELLED.into());
        }
        state.obs_activity.recovery.reload_attempted |= refresh_attempted;
        if matches!(outcome, Err(ObsError::OverlaySuperseded)) {
            sync = json!({"state":"paused","reason":"another_instance",
                "message":ObsError::OverlaySuperseded.to_string()});
        }
        if outcome.as_ref().is_ok_and(|found| found.updated) {
            state.obs_activity.recovery.missing_since = Some(tokio::time::Instant::now());
        }
        sync["page_connected"] = json!(state.overlay_hub.obs_health().0 > 0);
        sync["refreshed"] = json!(outcome.as_ref().is_ok_and(|found| found.refreshed));
        state.obs_status["overlay_sync"] = sync;
        outcome.map(|found| json!(found)).map_err(display)
    }

    /// `{password:""}` removes the saved password.
    pub(super) fn save_obs_password(&self, payload: &Value) -> Result<(), String> {
        let password = Zeroizing::new(
            payload["password"]
                .as_str()
                .ok_or("请填写 OBS WebSocket 密码 [DV-S38]")?
                .to_owned(),
        );
        let mut state = self.lock()?;
        state.store.save_obs_password(&password).map_err(display)?;
        state.obs_has_password = !password.is_empty();
        state.invalidate_obs_activity(true);
        Ok(())
    }

    /// Explicit connection test; a successful test schedules only the existing
    /// managed source repair when the local overlay is enabled.
    pub(super) async fn test_obs(&self) -> Result<Value, String> {
        let result = self.refresh_obs_status().await;
        if result.is_ok() {
            self.schedule_existing_obs_overlay();
        }
        result
    }

    /// Read versions and streaming status. Unlike test/launch, this never
    /// schedules source repair; the caller can separately request safe sync.
    pub(super) async fn refresh_obs_status(&self) -> Result<Value, String> {
        self.require_network()?;
        let (request, (settings, password)) = self.begin_obs_probe()?;
        let result = tokio::select! {
            biased;
            _ = request.cancel.cancelled() => return Err(OBS_ACTIVITY_CANCELLED.into()),
            result = tokio::time::timeout(OBS_OVERLAY_LIMIT,
                obs::probe(&settings, password.as_deref().map(|p| p.as_str()))) => result.unwrap_or(Err(ObsError::Timeout)),
        };
        self.record_probe_for(&request, result.as_ref())?;
        result
            .map(|found| json!(found))
            .map_err(|error| error.to_string())
    }

    /// Read the current OBS profile's streaming bitrate for the details panel.
    /// It is returned to this caller only, never saved into app configuration.
    pub(super) async fn get_obs_bitrate(&self) -> Result<Value, String> {
        self.require_network()?;
        let cancel = self.lock()?.obs_activity.cancel.clone();
        let (settings, password) = self.obs_connection()?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(OBS_ACTIVITY_CANCELLED.into()),
            result = obs::bitrate(&settings, password.as_deref().map(|p| p.as_str())) => result.map(|found| json!(found)).map_err(display),
        }
    }

    /// An explicit save persists the video target for the next OBS stream.
    /// Running outputs are allowed and their encoder is left untouched. Serialize
    /// with go-live so our own stream start cannot race this profile edit.
    pub(super) async fn set_obs_bitrate(&self, payload: &Value) -> Result<Value, String> {
        self.require_network()?;
        let bitrate = payload["bitrate_kbps"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or("OBS 码率设置：视频码率须为 100–100000 Kbps 的整数 [DV-OB11]")?;
        obs::validate_bitrate(bitrate).map_err(display)?;
        let (epoch, cancel, obs_cancel) = {
            let mut state = self.lock()?;
            if state.broadcast.busy {
                return Err("开播管理正在处理请求，请稍候 [DV-B10]".into());
            }
            state.broadcast.busy = true;
            (
                state.broadcast.epoch,
                state.broadcast.cancel.clone(),
                state.obs_activity.cancel.clone(),
            )
        };
        let _guard = BroadcastGuard(self.clone(), epoch);
        let (settings, password) = self.obs_connection()?;
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("账号或设置已变更，OBS 码率请求已取消；请重新读取 [DV-OB11]".into()),
            _ = obs_cancel.cancelled() => return Err(OBS_ACTIVITY_CANCELLED.into()),
            result = obs::set_bitrate(&settings, password.as_deref().map(|p| p.as_str()), bitrate) => result,
        };
        result
            .map(|found| json!(found))
            .map_err(|error| error.to_string())
    }
}

/// How long a just-started OBS may take to load plugins and open its WebSocket.
const OBS_READY_LIMIT: std::time::Duration = std::time::Duration::from_secs(45);

fn obs_outcome(result: Result<Value, String>, launched: bool) -> Value {
    match result {
        Ok(outcome) => json!({"outcome": outcome, "launched": launched}),
        Err(error) => json!({"error": error, "launched": launched}),
    }
}

/// `Ok(true)` when OBS was started now; `Ok(false)` when it was not needed
/// (switched off, OBS on another computer, or already running).
fn launch_obs_if_needed(settings: &ObsSettings) -> Result<bool, ObsError> {
    if !settings.auto_launch || !settings.is_local() || obs_process::is_running() {
        return Ok(false);
    }
    obs_process::launch(&obs_process::resolve(settings.executable.as_deref())?)?;
    Ok(true)
}

/// Installed OBS for display in settings, as a plain path string.
pub(super) fn detect_obs() -> Option<String> {
    obs_process::find_installed().map(|path| path.to_string_lossy().into_owned())
}

async fn perform(
    action: &str,
    payload: &Value,
    session: &BiliSession,
) -> Result<Operation, BiliError> {
    let client = BroadcastClient::new()?;
    match action {
        "bili.broadcast.refresh" => {
            let room = client.own_room(session).await?;
            Ok(Operation::Refreshed(room, client.areas().await?))
        }
        "bili.broadcast.update" => {
            let title = payload["title"]
                .as_str()
                .ok_or(BiliError::Protocol("请填写直播标题"))?;
            let area = payload["area_id"]
                .as_u64()
                .ok_or(BiliError::Protocol("请选择直播子分区"))?;
            Ok(Operation::Updated(
                client.update(session, title, area).await?,
            ))
        }
        "bili.broadcast.start" => {
            let area = payload["area_id"]
                .as_u64()
                .ok_or(BiliError::Protocol("请选择直播子分区"))?;
            let (room, result) = client.start(session, area).await?;
            Ok(Operation::Started(room, result))
        }
        "bili.broadcast.stop" => Ok(Operation::Stopped(client.stop(session).await?)),
        _ => unreachable!("validated action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::Message;

    const OLD_OVERLAY_URL: &str =
        "http://127.0.0.1:47822/overlay?token=0123456789abcdef0123456789abcdef";

    /// Test-only v5 protocol peer. It uses an isolated ephemeral loopback port
    /// and has no access to credentials, OBS processes or the production store.
    struct ObsFixture {
        port: u16,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        first_version: Arc<tokio::sync::Notify>,
        release_version: Arc<tokio::sync::Notify>,
        task: tokio::task::JoinHandle<()>,
        browser_streams: Arc<Mutex<Vec<tokio::net::TcpStream>>>,
    }

    impl Drop for ObsFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn obs_fixture(source: Option<(&str, &str)>, pause_first_version: bool) -> ObsFixture {
        obs_fixture_at(0, source, pause_first_version).await
    }

    async fn obs_fixture_at(
        port: u16,
        source: Option<(&str, &str)>,
        pause_first_version: bool,
    ) -> ObsFixture {
        obs_fixture_rendered(port, source, pause_first_version, false, true).await
    }

    async fn obs_fixture_rendered(
        port: u16,
        source: Option<(&str, &str)>,
        pause_first_version: bool,
        render_browser: bool,
        source_active: bool,
    ) -> ObsFixture {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let source = Arc::new(Mutex::new(source.map(|(kind, url)|
            json!({"inputKind":kind,"inputSettings":{"url":url,"width":1280,"height":720}}))));
        let browser_streams = Arc::new(Mutex::new(Vec::new()));
        let first_version = Arc::new(tokio::sync::Notify::new());
        let release_version = Arc::new(tokio::sync::Notify::new());
        let pause = Arc::new(std::sync::atomic::AtomicBool::new(pause_first_version));
        let task = tokio::spawn({
            let requests = requests.clone();
            let first_version = first_version.clone();
            let release_version = release_version.clone();
            let browser_streams = browser_streams.clone();
            async move {
                let mut peers = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        result = listener.accept() => {
                            let (stream, _) = result.unwrap();
                            let requests = requests.clone();
                            let source = source.clone();
                            let pause = pause.clone();
                            let first_version = first_version.clone();
                            let release_version = release_version.clone();
                            let browser_streams = browser_streams.clone();
                            peers.spawn(async move {
                                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                                socket.send(Message::text(json!({"op":0,"d":{"obsWebSocketVersion":"5.5.2","rpcVersion":1}}).to_string())).await.unwrap();
                                while let Some(Ok(Message::Text(text))) = socket.next().await {
                                    let message: Value = serde_json::from_str(text.as_str()).unwrap();
                                    let data = &message["d"];
                                    if message["op"] == 1 {
                                        assert_eq!(data["eventSubscriptions"], 0);
                                        if socket.send(Message::text(json!({"op":2,"d":{"negotiatedRpcVersion":1}}).to_string())).await.is_err() {break;}
                                        continue;
                                    }
                                    let kind = data["requestType"].as_str().unwrap();
                                    let payload = data["requestData"].clone();
                                    requests.lock().unwrap().push((kind.into(), payload.clone()));
                                    if kind == "GetVersion" && pause.swap(false, std::sync::atomic::Ordering::SeqCst) {
                                        first_version.notify_one();
                                        release_version.notified().await;
                                    }
                                    let (code, response) = match kind {
                                        "GetVersion" => (100,json!({"obsVersion":"31.0.0","obsWebSocketVersion":"5.5.2"})),
                                        "GetStreamStatus" => (100,json!({"outputActive":false,"outputReconnecting":false})),
                                        "GetVideoSettings" => (100,json!({"baseWidth":1280,"baseHeight":720})),
                                        "GetCurrentProgramScene" => (100,json!({"currentProgramSceneName":"fixture scene"})),
                                        "GetInputSettings" => {
                                            let found = source.lock().unwrap().clone();
                                            found.map_or((600,Value::Null), |value| (100,value))
                                        }
                                        "SetInputSettings" => {
                                            assert_eq!(payload["inputName"], obs::OVERLAY_SOURCE_NAME);
                                            assert_eq!(payload["overlay"], true);
                                            let mut source = source.lock().unwrap();
                                            let found = source.as_mut().unwrap();
                                            for (key,value) in payload["inputSettings"].as_object().unwrap() {found["inputSettings"][key] = value.clone();}
                                            (100,Value::Null)
                                        }
                                        "CreateInput" => {
                                            *source.lock().unwrap() = Some(json!({"inputKind":payload["inputKind"],"inputSettings":payload["inputSettings"]}));
                                            (100,Value::Null)
                                        }
                                        "GetSceneItemId" => (100,json!({"sceneItemId":7})),
                                        "GetSceneItemEnabled" => (100,json!({"sceneItemEnabled":true})),
                                        "GetSourceActive" => (100,json!({"videoActive":source_active,"videoShowing":source_active})),
                                        "PressInputPropertiesButton" => {
                                            assert_eq!(payload["inputName"],obs::OVERLAY_SOURCE_NAME);
                                            assert_eq!(payload["propertyName"],"refreshnocache");
                                            (100,Value::Null)
                                        }
                                        other => panic!("unexpected request {other}"),
                                    };
                                    if render_browser && ["SetInputSettings","PressInputPropertiesButton"].contains(&kind) {
                                        let address = source.lock().unwrap().as_ref().unwrap()["inputSettings"]["url"].as_str().unwrap().to_owned();
                                        browser_streams.lock().unwrap().clear();
                                        let stream = connect_fixture_overlay(&address,true).await;
                                        browser_streams.lock().unwrap().push(stream);
                                    }
                                    if socket.send(Message::text(json!({"op":7,"d":{"requestType":kind,"requestId":data["requestId"],"requestStatus":{"result":code==100,"code":code},"responseData":response}}).to_string())).await.is_err() {break;}
                                }
                            });
                        }
                        Some(result) = peers.join_next() => {result.unwrap();}
                    }
                }
            }
        });
        ObsFixture {
            port,
            requests,
            first_version,
            release_version,
            task,
            browser_streams,
        }
    }

    async fn connect_fixture_overlay(address: &str, obs: bool) -> tokio::net::TcpStream {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let address = url::Url::parse(address).unwrap();
        let port = address.port().unwrap();
        let token = address
            .query_pairs()
            .find(|(key, _)| key == "token")
            .unwrap()
            .1
            .to_string();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let user_agent = if obs {
            "Mozilla/5.0 Fixture OBS/0.0"
        } else {
            "Mozilla/5.0 Fixture browser preview"
        };
        stream.write_all(format!("GET /overlay/events?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: {user_agent}\r\n\r\n").as_bytes()).await.unwrap();
        let mut received = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !String::from_utf8_lossy(&received).contains("event: hello") {
                let mut buffer = [0u8; 4096];
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0, "fixture page must receive SSE hello");
                received.extend_from_slice(&buffer[..count]);
            }
        })
        .await
        .unwrap();
        stream
    }

    async fn install_test_overlay(app: &Application) {
        let hub = app.lock().unwrap().overlay_hub.clone();
        let assets: crate::overlay::AssetLoader = Arc::new(|_| None);
        let server = crate::overlay::OverlayServer::bind(0, hub, assets)
            .await
            .unwrap();
        let mut state = app.lock().unwrap();
        state.overlay_settings.enabled = true;
        state.overlay_settings.port = server.port();
        state.overlay_server = Some(server);
        let settings = state.overlay_settings.clone();
        state.store.save_overlay_settings(&settings).unwrap();
    }

    async fn wait_for_overlay_sync(app: &Application, expected: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if app.snapshot().unwrap()["obs"]["status"]["overlay_sync"]["state"] == expected {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    fn isolated(network_disabled: bool) -> (tempfile::TempDir, Application) {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), network_disabled).unwrap();
        (directory, app)
    }

    fn add_credentials(app: &Application) {
        let session = BiliSession::from_secret_payload(
            br#"{"user_id":42,"sessdata":"fictional-session","bili_jct":"fictional-csrf"}"#,
        )
        .unwrap();
        let mut state = app.lock().unwrap();
        state.store.save_bili_session(&session).unwrap();
        state.bili_user_id = Some(42);
        state.broadcast.room = Some(BroadcastRoom {
            room_id: 123,
            title: "fictional room".into(),
            parent_area_id: 2,
            area_id: 86,
            live_status: 1,
            live_since: Some(1_791_028_805),
        });
        state.broadcast.credentials = Some(PushCredentials {
            address: "rtmp://live-push.bilivideo.com/live/".into(),
            stream_key: "fictional-private-stream-key".into(),
        });
    }

    #[tokio::test]
    async fn snapshots_exports_and_disk_exclude_stream_credentials() {
        let (directory, app) = isolated(true);
        add_credentials(&app);
        let snapshot = app.snapshot().unwrap();
        assert!(snapshot["broadcast"]["has_stream_key"].as_bool().unwrap());
        assert!(
            !snapshot
                .to_string()
                .contains("fictional-private-stream-key")
        );
        let revealed = app
            .dispatch("bili.broadcast.credentials", json!({"confirmed":true}))
            .await
            .unwrap();
        assert_eq!(
            revealed["result"]["stream_key"],
            "fictional-private-stream-key"
        );
        assert!(
            !app.snapshot()
                .unwrap()
                .to_string()
                .contains("fictional-private-stream-key")
        );
        assert!(
            app.dispatch("bili.broadcast.credentials", json!({}))
                .await
                .is_err()
        );
        let exported =
            serde_json::to_string(&app.lock().unwrap().store.export_configuration().unwrap())
                .unwrap();
        assert!(!exported.contains("fictional-private-stream-key"));
        app.dispatch("bili.broadcast.forget", json!({}))
            .await
            .unwrap();
        assert!(
            app.dispatch("bili.broadcast.credentials", json!({"confirmed":true}))
                .await
                .is_err()
        );
        drop(app);
        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_file() {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert!(
                    !bytes
                        .windows(b"fictional-private-stream-key".len())
                        .any(|w| w == b"fictional-private-stream-key")
                );
            }
        }
        let reopened = Application::new(directory.path().to_path_buf(), true).unwrap();
        assert_eq!(
            reopened.snapshot().unwrap()["broadcast"]["has_stream_key"],
            false
        );
    }

    #[tokio::test]
    async fn offline_missing_login_confirmation_and_busy_block_requests() {
        let (_directory, offline) = isolated(true);
        for action in ["refresh", "update", "start", "stop"] {
            let error = offline
                .dispatch(
                    &format!("bili.broadcast.{action}"),
                    json!({"confirmed":true}),
                )
                .await
                .unwrap_err();
            assert!(error.contains("离线测试窗口"), "{error}");
        }
        let (_directory, app) = isolated(false);
        assert!(
            app.dispatch("bili.broadcast.refresh", json!({}))
                .await
                .unwrap_err()
                .contains("请先扫码登录")
        );
        assert!(
            app.dispatch("bili.broadcast.start", json!({}))
                .await
                .is_err()
        );
        assert!(
            app.dispatch("bili.broadcast.unknown", json!({}))
                .await
                .is_err()
        );
        add_credentials(&app);
        app.lock().unwrap().broadcast.busy = true;
        assert!(
            app.dispatch("bili.broadcast.start", json!({"confirmed":true}))
                .await
                .unwrap_err()
                .contains("正在处理请求")
        );
    }

    #[tokio::test]
    async fn logout_cancels_pending_management_and_discards_credentials() {
        let (_directory, app) = isolated(true);
        add_credentials(&app);
        let cancel = app.lock().unwrap().broadcast.cancel.clone();
        let old_epoch = app.lock().unwrap().broadcast.epoch;
        let guard = BroadcastGuard(app.clone(), old_epoch);
        app.dispatch("bili.logout", json!({"confirmed":true}))
            .await
            .unwrap();
        assert!(cancel.is_cancelled());
        assert!(app.lock().unwrap().broadcast.epoch != old_epoch);
        // A late old request must not release a newer request's busy flag.
        app.lock().unwrap().broadcast.busy = true;
        drop(guard);
        assert!(app.lock().unwrap().broadcast.busy);
        assert_eq!(
            app.snapshot().unwrap()["broadcast"]["has_stream_key"],
            false
        );
    }

    #[test]
    fn own_room_page_is_derived_from_management_state_without_secrets_or_watched_target() {
        let (_directory, app) = isolated(false);
        assert!(app.own_broadcast_page().is_err());
        add_credentials(&app);
        assert_eq!(
            app.own_broadcast_page().unwrap(),
            "https://live.bilibili.com/123"
        );
    }

    #[tokio::test]
    async fn obs_link_settings_and_password_stay_out_of_snapshots_exports_and_disk() {
        let (directory, app) = isolated(false);
        let snapshot = app.snapshot().unwrap();
        assert_eq!(snapshot["obs"]["settings"]["enabled"], false);
        assert_eq!(snapshot["obs"]["settings"]["port"], 4455);
        assert_eq!(snapshot["obs"]["has_password"], false);
        app.dispatch(
            "obs.save",
            json!({"settings":{"enabled":true,"host":" 127.0.0.1 ","port":4460}}),
        )
        .await
        .unwrap();
        let error = app
            .dispatch(
                "obs.save",
                json!({"settings":{"enabled":true,"host":"ws://127.0.0.1","port":4460}}),
            )
            .await
            .unwrap_err();
        assert!(error.contains("[DV-S38]"), "{error}");
        app.dispatch("obs.password", json!({"password":"fictional-obs-password"}))
            .await
            .unwrap();
        let snapshot = app.snapshot().unwrap();
        assert_eq!(snapshot["obs"]["settings"]["host"], "127.0.0.1");
        assert_eq!(snapshot["obs"]["settings"]["port"], 4460);
        assert_eq!(snapshot["obs"]["has_password"], true);
        assert!(!snapshot.to_string().contains("fictional-obs-password"));
        let exported =
            serde_json::to_string(&app.lock().unwrap().store.export_configuration().unwrap())
                .unwrap();
        assert!(!exported.contains("fictional-obs-password"));
        drop(app);
        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let bytes = std::fs::read(&path).unwrap();
                assert!(
                    !bytes
                        .windows(b"fictional-obs-password".len())
                        .any(|w| w == b"fictional-obs-password"),
                    "{}",
                    path.display()
                );
            }
        }
        let reopened = Application::new(directory.path().to_path_buf(), false).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(snapshot["obs"]["settings"]["enabled"], true);
        assert_eq!(snapshot["obs"]["has_password"], true);
        reopened
            .dispatch("obs.password", json!({"password":""}))
            .await
            .unwrap();
        assert_eq!(reopened.snapshot().unwrap()["obs"]["has_password"], false);
        reopened
            .dispatch("data.clear", json!({"confirmed":true}))
            .await
            .unwrap();
        assert_eq!(
            reopened.snapshot().unwrap()["obs"]["settings"]["enabled"],
            false
        );
    }

    #[tokio::test]
    async fn obs_test_reports_unreachable_obs_and_is_refused_offline() {
        let (_directory, offline) = isolated(true);
        let error = offline.dispatch("obs.test", json!({})).await.unwrap_err();
        assert!(error.contains("离线测试窗口"), "{error}");

        let (_directory, app) = isolated(false);
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        app.dispatch(
            "obs.save",
            json!({"settings":{"enabled":true,"host":"127.0.0.1","port":port}}),
        )
        .await
        .unwrap();
        let error = app.dispatch("obs.test", json!({})).await.unwrap_err();
        assert!(error.contains("[DV-OB01]"), "{error}");
        let status = &app.snapshot().unwrap()["obs"]["status"];
        assert_eq!(status["state"], "error");
        assert!(status["message"].as_str().unwrap().contains("[DV-OB01]"));
    }

    #[tokio::test]
    async fn obs_refresh_is_read_only_and_preserves_global_status_and_configuration() {
        let (_directory, app) = isolated(false);
        let fixture = obs_fixture(Some(("browser_source", OLD_OVERLAY_URL)), false).await;
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        install_test_overlay(&app).await;
        app.lock().unwrap().status = "unrelated operation result".into();
        let revision = app.snapshot().unwrap()["config_revision"].clone();
        let found = app.dispatch("obs.refresh", json!({})).await.unwrap();
        assert_eq!(found["obs"]["status"]["state"], "ok");
        assert_eq!(found["obs"]["status"]["obs_version"], "31.0.0");
        assert!(found["obs"]["status"].get("overlay_sync").is_none());
        assert_eq!(found["config_revision"], revision);
        assert_eq!(app.lock().unwrap().status, "unrelated operation result");
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .map(|(kind, _)| kind.as_str())
                .collect::<Vec<_>>(),
            ["GetVersion", "GetStreamStatus"]
        );
        let (_directory, offline) = isolated(true);
        for action in ["obs.refresh", "obs.overlay.sync"] {
            assert!(
                offline
                    .dispatch(action, json!({}))
                    .await
                    .unwrap_err()
                    .contains("离线测试窗口")
            );
        }
    }

    #[tokio::test]
    async fn safe_overlay_sync_repairs_only_owned_source_and_keeps_transport_separate() {
        for (source, expected) in [
            (Some(("browser_source", OLD_OVERLAY_URL)), "updated"),
            (None, "missing"),
            (
                Some(("browser_source", "https://example.org/unrelated-user-page")),
                "error",
            ),
            (Some(("image_source", OLD_OVERLAY_URL)), "error"),
        ] {
            let (_directory, app) = isolated(false);
            let fixture = obs_fixture(source, false).await;
            app.dispatch(
                "obs.save",
                json!({"settings":{"host":"127.0.0.1","port":fixture.port,"enabled":false}}),
            )
            .await
            .unwrap();
            install_test_overlay(&app).await;
            app.lock().unwrap().status = "other result".into();
            let result = app.dispatch("obs.overlay.sync", json!({})).await;
            let status = app.snapshot().unwrap()["obs"]["status"].clone();
            assert_eq!(
                status["state"], "ok",
                "source errors cannot imply a disconnected OBS"
            );
            assert_eq!(status["overlay_sync"]["state"], expected);
            assert_eq!(app.lock().unwrap().status, "other result");
            if expected == "error" {
                assert!(result.unwrap_err().contains("[DV-OB12]"));
            } else {
                result.unwrap();
            }
            {
                let requests = fixture.requests.lock().unwrap();
                let writes: Vec<_> = requests
                    .iter()
                    .filter(|(kind, _)| kind.starts_with("Set") || kind.starts_with("Create"))
                    .map(|(kind, _)| kind.as_str())
                    .collect();
                assert_eq!(
                    writes,
                    if expected == "updated" {
                        vec!["SetInputSettings"]
                    } else {
                        vec![]
                    }
                );
            }
            if expected == "updated" {
                let result = app.dispatch("obs.overlay.sync", json!({})).await.unwrap();
                assert_eq!(result["obs"]["status"]["overlay_sync"]["state"], "ready");
                assert_eq!(
                    fixture
                        .requests
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|(kind, _)| kind == "SetInputSettings")
                        .count(),
                    1
                );
            }
        }
    }

    #[tokio::test]
    async fn overlay_startup_port_fallback_and_token_reset_repair_current_endpoint() {
        let (_directory, app) = isolated(false);
        let fixture = obs_fixture(Some(("browser_source", OLD_OVERLAY_URL)), false).await;
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        {
            let mut state = app.lock().unwrap();
            state.overlay_settings.enabled = true;
            state.overlay_settings.port = preferred;
        }
        app.start_overlay(Arc::new(|_| None)).await;
        wait_for_overlay_sync(&app, "updated").await;
        let before = app.snapshot().unwrap()["overlay"].clone();
        assert_eq!(before["running"], true);
        assert_ne!(before["port"], preferred);
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .find(|(kind, _)| kind == "SetInputSettings")
                .unwrap()
                .1["inputSettings"]["url"],
            before["url"]
        );
        app.dispatch("overlay.token.reset", json!({}))
            .await
            .unwrap();
        // The UI may also ask for sync immediately. The shared gate must make
        // the automatic + explicit duplicate a no-op after the first update.
        app.dispatch("obs.overlay.sync", json!({})).await.unwrap();
        wait_for_overlay_sync(&app, "ready").await;
        let after = app.snapshot().unwrap()["overlay"].clone();
        assert_ne!(before["url"], after["url"]);
        let requests = fixture.requests.lock().unwrap();
        let updates: Vec<_> = requests
            .iter()
            .filter(|(kind, _)| kind == "SetInputSettings")
            .collect();
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[1].1["inputSettings"]["url"], after["url"]);
        assert!(!requests.iter().any(|(kind, _)| kind == "CreateInput"
            || kind == "StartStream"
            || kind == "SetStreamServiceSettings"));
    }

    #[tokio::test]
    async fn obs_started_later_recovers_after_read_only_probe_without_manual_add() {
        let (_directory, app) = isolated(false);
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":port}}),
        )
        .await
        .unwrap();
        {
            let mut state = app.lock().unwrap();
            state.overlay_settings.enabled = true;
            state.overlay_settings.port = 0;
        }
        app.start_overlay(Arc::new(|_| None)).await;
        wait_for_overlay_sync(&app, "error").await;
        let fixture = obs_fixture_at(port, Some(("browser_source", OLD_OVERLAY_URL)), false).await;
        app.dispatch("obs.refresh", json!({})).await.unwrap();
        assert!(
            !fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(kind, _)| kind.starts_with("Set") || kind.starts_with("Create"))
        );
        app.dispatch("obs.overlay.sync", json!({})).await.unwrap();
        assert_eq!(
            app.snapshot().unwrap()["obs"]["status"]["overlay_sync"]["state"],
            "updated"
        );
    }

    /// Reproduces the real report: address and canvas already match, but no
    /// browser event stream exists and the streamer never opens Settings.
    #[tokio::test]
    async fn obs_lifetime_recovers_identical_source_without_opening_settings() {
        let (_directory, app) = isolated(false);
        install_test_overlay(&app).await;
        let address = app.snapshot().unwrap()["overlay"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        let fixture =
            obs_fixture_rendered(0, Some(("browser_source", &address)), false, true, true).await;
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        let feed = tokio::spawn({
            let app = app.clone();
            async move { app.run_overlay_feed().await }
        });
        let recovered = tokio::time::timeout(std::time::Duration::from_secs(18), async {
            loop {
                if !fixture.browser_streams.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        feed.abort();
        assert!(
            recovered.is_ok(),
            "identical source must reconnect without Settings or manual Add"
        );
        assert!(
            app.lock().unwrap().overlay_hub.has_clients(),
            "refresh must establish a real overlay SSE stream"
        );
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(kind, _)| kind == "PressInputPropertiesButton")
                .count(),
            1
        );
        assert!(!requests.iter().any(|(kind, _)| {
            [
                "SetInputSettings",
                "CreateInput",
                "CreateSceneItem",
                "SetSceneItemEnabled",
                "StartStream",
                "StopStream",
            ]
            .contains(&kind.as_str())
        }));
    }

    #[test]
    fn recovery_is_single_flight_backs_off_and_reloads_once_per_missing_episode() {
        let start = tokio::time::Instant::now();
        let mut recovery = ObsRecovery::default();
        assert_eq!(recovery.begin(start, (0, 0), false), Some(false));
        assert_eq!(
            recovery.begin(start, (0, 0), true),
            None,
            "duplicate startup/UI work must stay single-flight"
        );
        recovery.finish(start + std::time::Duration::from_millis(20), true);
        assert_eq!(
            recovery.begin(start + OBS_RECOVERY_INTERVAL, (0, 0), false),
            Some(true)
        );
        recovery.reload_attempted = true;
        recovery.finish(
            start + OBS_RECOVERY_INTERVAL + std::time::Duration::from_millis(20),
            true,
        );
        assert_eq!(
            recovery.begin(start + OBS_RECOVERY_INTERVAL * 2, (0, 0), false),
            Some(false)
        );
        recovery.finish(start + OBS_RECOVERY_INTERVAL * 2, true);
        assert_eq!(
            recovery.begin(start + OBS_RECOVERY_INTERVAL * 3, (1, 1), false),
            None,
            "healthy OBS page must not be reset"
        );
        assert_eq!(
            recovery.begin(start + OBS_RECOVERY_INTERVAL * 4, (0, 1), false),
            Some(false)
        );
        recovery.finish(start + OBS_RECOVERY_INTERVAL * 4, true);
        assert_eq!(
            recovery.begin(start + OBS_RECOVERY_INTERVAL * 5, (0, 1), false),
            Some(true),
            "a new genuine connection starts a new missing episode"
        );

        let mut recovery = ObsRecovery::default();
        let mut attempt = start;
        for expected_seconds in [15, 30, 60, 120, 120] {
            assert!(recovery.begin(attempt, (0, 0), false).is_some());
            recovery.finish(attempt + std::time::Duration::from_millis(20), false);
            let next = attempt + std::time::Duration::from_secs(expected_seconds);
            assert_eq!(recovery.next_attempt, Some(next));
            assert_eq!(
                recovery.begin(next - std::time::Duration::from_millis(1), (0, 0), false),
                None
            );
            attempt = next;
        }
    }

    #[tokio::test]
    async fn lifetime_recovers_obs_started_later_with_no_visible_settings() {
        let (_directory, app) = isolated(false);
        install_test_overlay(&app).await;
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":port}}),
        )
        .await
        .unwrap();
        let feed = tokio::spawn({
            let app = app.clone();
            async move { app.run_overlay_feed().await }
        });
        wait_for_overlay_sync(&app, "error").await;
        let fixture = obs_fixture_rendered(
            port,
            Some(("browser_source", OLD_OVERLAY_URL)),
            false,
            true,
            true,
        )
        .await;
        let restored = tokio::time::timeout(std::time::Duration::from_secs(18), async {
            loop {
                if !fixture.browser_streams.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        feed.abort();
        assert!(
            restored.is_ok(),
            "late OBS must recover without any settings-page IPC"
        );
        assert_eq!(app.lock().unwrap().overlay_hub.obs_health().0, 1);
        assert!(
            !fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(kind, _)| kind.starts_with("Create") || kind == "SetSceneItemEnabled")
        );
    }

    #[tokio::test]
    async fn recovery_ignores_browser_preview_but_never_refreshes_a_healthy_obs_page() {
        let (_directory, app) = isolated(false);
        install_test_overlay(&app).await;
        let address = app.snapshot().unwrap()["overlay"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        let preview = connect_fixture_overlay(&address, false).await;
        assert_eq!(app.lock().unwrap().overlay_hub.obs_health().0, 0);
        let fixture =
            obs_fixture_rendered(0, Some(("browser_source", &address)), false, true, true).await;
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        // Observe the same real policy deadlines without waiting a whole
        // second 15s integration cycle (the preceding test exercises the loop).
        {
            let mut state = app.lock().unwrap();
            state.obs_activity.recovery.missing_since =
                Some(tokio::time::Instant::now() - OBS_RECOVERY_INTERVAL);
        }
        app.schedule_obs_overlay_recovery(false);
        wait_for_overlay_sync(&app, "ready").await;
        assert_eq!(app.lock().unwrap().overlay_hub.obs_health().0, 1);
        let count = fixture.requests.lock().unwrap().len();
        for _ in 0..3 {
            app.schedule_obs_overlay_recovery(false);
            tokio::task::yield_now().await;
        }
        assert_eq!(
            fixture.requests.lock().unwrap().len(),
            count,
            "healthy page must not reload or replay animations"
        );
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(kind, _)| kind == "PressInputPropertiesButton")
                .count(),
            1
        );
        drop(preview);
    }

    #[tokio::test]
    async fn automatic_overlay_recovery_does_not_fight_a_newer_app_instance() {
        let (directory, old) = isolated(false);
        install_test_overlay(&old).await;
        let old_address = old.snapshot().unwrap()["overlay"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        let fixture =
            obs_fixture_rendered(0, Some(("browser_source", &old_address)), false, true, true)
                .await;
        old.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        let new = Application::new(directory.path().to_path_buf(), false).unwrap();
        new.start_overlay(Arc::new(|_| None)).await;
        wait_for_overlay_sync(&new, "updated").await;
        let new_address = new.snapshot().unwrap()["overlay"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(old_address, new_address);
        assert!(new.lock().unwrap().owns_overlay_endpoint().unwrap());
        assert!(!old.lock().unwrap().owns_overlay_endpoint().unwrap());
        let count = fixture.requests.lock().unwrap().len();
        for _ in 0..3 {
            old.schedule_obs_overlay_recovery(false);
            tokio::task::yield_now().await;
        }
        assert_eq!(
            fixture.requests.lock().unwrap().len(),
            count,
            "an obsolete automatic worker must not retake the source"
        );
        let status = old.snapshot().unwrap()["obs"]["status"]["overlay_sync"].clone();
        assert_eq!(status["state"], "paused");
        assert_eq!(status["reason"], "another_instance");
        assert!(status["message"].as_str().unwrap().contains("[DV-OB15]"));
        let automatic = old
            .dispatch("obs.overlay.sync", json!({"automatic":true}))
            .await
            .unwrap_err();
        assert!(automatic.contains("[DV-OB15]"));
        assert_eq!(fixture.requests.lock().unwrap().len(), count);
        // An explicit action remains authorized by the user of that instance.
        old.dispatch("obs.overlay.sync", json!({})).await.unwrap();
        assert!(fixture.requests.lock().unwrap().len() > count);
        assert_eq!(
            fixture
                .requests
                .lock()
                .unwrap()
                .iter()
                .rfind(|(kind, _)| kind == "SetInputSettings")
                .unwrap()
                .1["inputSettings"]["url"],
            old_address
        );
    }

    #[tokio::test]
    async fn old_probe_cannot_overwrite_a_newer_explicit_result_or_new_settings() {
        let (_directory, app) = isolated(false);
        let fixture = obs_fixture(None, true).await;
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        let old_probe = tokio::spawn({
            let app = app.clone();
            async move { app.refresh_obs_status().await }
        });
        fixture.first_version.notified().await;
        // A later explicit connection test completed while the first probe
        // was pending. Its result (including separate source status) must win.
        app.test_obs().await.unwrap();
        // The immediately following explicit stream result supersedes the
        // delayed probe's false status without performing any stream operation.
        app.record_obs(Ok(true)).unwrap();
        app.lock().unwrap().obs_status["overlay_sync"] = json!({"state":"ready"});
        let newer = app.snapshot().unwrap()["obs"]["status"].clone();
        fixture.release_version.notify_one();
        old_probe.await.unwrap().unwrap();
        assert_eq!(app.snapshot().unwrap()["obs"]["status"], newer);

        let stale = app.begin_obs_probe().unwrap().0;
        app.save_obs(&json!({"settings":{"host":"127.0.0.1","port":fixture.port+1}}))
            .unwrap();
        assert!(stale.cancel.is_cancelled());
        app.record_probe_for(
            &stale,
            Ok(&obs::ObsProbe {
                obs_version: "stale".into(),
                websocket_version: "stale".into(),
                streaming: true,
            }),
        )
        .unwrap();
        assert_eq!(app.snapshot().unwrap()["obs"]["status"]["state"], "idle");
    }

    #[tokio::test]
    async fn settings_change_cancels_pending_network_probe_without_retry() {
        let (_directory, app) = isolated(false);
        let fixture = obs_fixture(None, true).await;
        app.dispatch(
            "obs.save",
            json!({"settings":{"host":"127.0.0.1","port":fixture.port}}),
        )
        .await
        .unwrap();
        let probe = tokio::spawn({
            let app = app.clone();
            async move { app.refresh_obs_status().await }
        });
        fixture.first_version.notified().await;
        app.save_obs_password(&json!({"password":""})).unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(1), probe)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("[DV-OB14]"));
        assert_eq!(app.snapshot().unwrap()["obs"]["status"]["state"], "idle");
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn obs_launch_and_overlay_source_refuse_what_they_cannot_do() {
        let (_directory, app) = isolated(false);
        let snapshot = app.snapshot().unwrap();
        assert_eq!(snapshot["obs"]["settings"]["auto_launch"], true);
        assert_eq!(snapshot["obs"]["local"], true);
        let error = app
            .dispatch(
                "obs.save",
                json!({"settings":{"enabled":true,"host":"127.0.0.1","port":4455,"auto_launch":true,"executable":"C:\\Windows\\System32\\cmd.exe"}}),
            )
            .await
            .unwrap_err();
        assert!(error.contains("[DV-S38]"), "{error}");
        app.dispatch(
            "obs.save",
            json!({"settings":{"enabled":true,"host":"obs-pc.lan","port":4455,"auto_launch":true,"executable":null}}),
        )
        .await
        .unwrap();
        assert_eq!(app.snapshot().unwrap()["obs"]["local"], false);
        let error = app.dispatch("obs.launch", json!({})).await.unwrap_err();
        assert!(error.contains("只能启动本机的 OBS"), "{error}");
        let error = app
            .dispatch("obs.overlay.add", json!({}))
            .await
            .unwrap_err();
        assert!(error.contains("请先启用 OBS 叠加层"), "{error}");
        let (_directory, offline) = isolated(true);
        for action in ["obs.launch", "obs.overlay.add"] {
            let error = offline.dispatch(action, json!({})).await.unwrap_err();
            assert!(error.contains("离线测试窗口"), "{error}");
        }
    }

    #[tokio::test]
    async fn obs_bitrate_commands_reject_offline_invalid_and_busy_requests() {
        let (_directory, offline) = isolated(true);
        for result in [
            offline.get_obs_bitrate().await,
            offline.set_obs_bitrate(&json!({"bitrate_kbps":6000})).await,
        ] {
            assert!(result.unwrap_err().contains("离线测试窗口"));
        }
        let (_directory, app) = isolated(false);
        for value in [
            Value::Null,
            json!("6000"),
            json!(6000.5),
            json!(-1),
            json!(99),
            json!(100_001),
            json!(u64::MAX),
        ] {
            let result = app.set_obs_bitrate(&json!({"bitrate_kbps":value})).await;
            assert!(result.unwrap_err().contains("[DV-OB11]"));
            assert!(!app.lock().unwrap().broadcast.busy);
        }
        app.lock().unwrap().broadcast.busy = true;
        assert!(
            app.set_obs_bitrate(&json!({"bitrate_kbps":6000}))
                .await
                .unwrap_err()
                .contains("[DV-B10]")
        );
        assert!(app.lock().unwrap().broadcast.busy);
    }

    #[tokio::test]
    async fn obs_bitrate_failure_releases_go_live_guard_without_saving_app_settings() {
        let (_directory, app) = isolated(false);
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        app.save_obs(&json!({"settings":{"port":port}})).unwrap();
        let before = app.lock().unwrap().store.load_obs_settings().unwrap();
        let error = app
            .set_obs_bitrate(&json!({"bitrate_kbps":6000}))
            .await
            .unwrap_err();
        assert!(error.contains("[DV-OB01]"), "{error}");
        let state = app.lock().unwrap();
        assert!(!state.broadcast.busy);
        assert_eq!(state.store.load_obs_settings().unwrap(), before);
    }

    #[tokio::test]
    async fn changed_saved_account_is_rejected_before_any_broadcast_side_effect() {
        let (_directory, app) = isolated(false);
        add_credentials(&app);
        app.lock().unwrap().bili_user_id = Some(99);
        for action in [
            "bili.broadcast.start",
            "bili.broadcast.stop",
            "bili.broadcast.update",
        ] {
            let result = app
                .broadcast_command(
                    action,
                    &json!({"confirmed":true,"area_id":2,"title":"test"}),
                )
                .await;
            assert!(result.unwrap_err().contains("账号已变更"));
            assert!(!app.lock().unwrap().broadcast.busy);
        }
    }

    #[tokio::test]
    async fn changing_obs_connection_cancels_paused_bitrate_before_writes() {
        for password in [false, true] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = Arc::new(tokio::sync::Notify::new());
            let server = tokio::spawn({
                let seen = seen.clone();
                async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    socket
                        .send(Message::text(
                            json!({"op":0,"d":{"rpcVersion":1}}).to_string(),
                        ))
                        .await
                        .unwrap();
                    socket.next().await.unwrap().unwrap();
                    socket
                        .send(Message::text(json!({"op":2,"d":{}}).to_string()))
                        .await
                        .unwrap();
                    let first = socket.next().await.unwrap().unwrap();
                    assert!(first.to_text().unwrap().contains("GetProfileList"));
                    seen.notify_one();
                    // No response: changing settings must drop the connection promptly.
                    let next = tokio::time::timeout(Duration::from_secs(2), socket.next())
                        .await
                        .unwrap();
                    assert!(
                        !matches!(next, Some(Ok(Message::Text(_)))),
                        "stale connection wrote another request"
                    );
                }
            });
            let (_directory, app) = isolated(false);
            app.save_obs(&json!({"settings":{"port":port}})).unwrap();
            let pending = tokio::spawn({
                let app = app.clone();
                async move { app.set_obs_bitrate(&json!({"bitrate_kbps":6000})).await }
            });
            tokio::time::timeout(Duration::from_secs(2), seen.notified())
                .await
                .unwrap();
            if password {
                app.save_obs_password(&json!({"password":"fixture-only"}))
                    .unwrap();
            } else {
                app.save_obs(&json!({"settings":{"enabled":true}})).unwrap();
            }
            assert!(
                tokio::time::timeout(Duration::from_secs(1), pending)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err()
                    .contains("设置已变更")
            );
            assert!(!app.lock().unwrap().broadcast.busy);
            server.await.unwrap();
        }
    }

    #[test]
    fn auto_launch_is_skipped_when_off_or_remote() {
        let off = ObsSettings {
            auto_launch: false,
            ..ObsSettings::default()
        };
        assert!(!launch_obs_if_needed(&off).unwrap());
        let remote = ObsSettings {
            host: "obs-pc.lan".into(),
            ..ObsSettings::default()
        };
        assert!(!launch_obs_if_needed(&remote).unwrap());
    }
}
