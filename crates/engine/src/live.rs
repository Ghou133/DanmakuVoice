//! Explicit live-room session, with enqueue-time configuration snapshots.
//!
//! Constructing this controller performs no login, room connection, or TTS
//! request. `start` is the user action that begins receiving room events. It
//! shares the audio scheduler with audition: `stop` cancels only live jobs,
//! leaving audition jobs in the same FIFO.

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use thiserror::Error;
use tokio::{
    sync::{Mutex, mpsc, watch},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    bilibili::{BiliError, BiliRoomClient, BiliSession, RoomState},
    diagnostics::{self, DiagnosticCode},
    event_pipeline::EventPipeline,
    model::{EventKind, GiftMergeSettings, LiveEvent, Provider},
    playback::PreparedPlayback,
    received_emotes::ReceivedEmoteCatalog,
    rules::{RulePreview, RuleSet},
    scheduler::{JobOrigin, SchedulerHandle, SubmitError},
    storage::{DataStore, StorageError},
    tts::dobao::DoubaoDevice,
};

/// Backpressure reaches the room receiver when configuration or playback
/// cannot keep up. A disconnected receiver causes the room task to exit.
pub const LIVE_EVENT_CHANNEL_CAPACITY: usize = 128;
pub const LIVE_RECENT_EVENT_LIMIT: usize = 100;
pub(crate) const MAX_LIVE_EVENT_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveFailure {
    Storage,
    Rules,
    Prepare,
    QueueFull,
    QueueStopped,
    Worker,
}

impl From<StorageError> for LiveFailure {
    fn from(_: StorageError) -> Self {
        Self::Storage
    }
}

/// Counters belong to the current (or most recently stopped) session. Recent
/// message text is kept only in memory for the UI; events above 16 KiB are
/// rejected before retention. No credential, provider error, or path is kept.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveEventOutcome {
    DisplayOnly,
    Filtered,
    NoVoice,
    Enqueued { job_id: u64 },
    Failed(LiveFailure),
}

/// A de-duplicated or merged event after rule evaluation. It may represent
/// several source gifts; raw packets remain in `recent_events` separately.
#[derive(Clone, Debug, PartialEq)]
pub struct ProcessedLiveEvent {
    pub event: LiveEvent,
    pub outcome: LiveEventOutcome,
}

#[derive(Clone, PartialEq)]
pub struct LiveSnapshot {
    pub running: bool,
    pub room_id: Option<u64>,
    /// Canonical room returned by room_init; retained through reconnect/stop.
    pub resolved_room_id: Option<u64>,
    pub room_state: RoomState,
    pub received: u64,
    pub enqueued: u64,
    pub filtered: u64,
    pub no_voice: u64,
    pub errors: u64,
    pub emote_lookup_error: Option<String>,
    pub last_failure: Option<LiveFailure>,
    pub recent_events: Vec<LiveEvent>,
    pub recent_results: Vec<ProcessedLiveEvent>,
}

impl fmt::Debug for LiveSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LiveSnapshot")
            .field("running", &self.running)
            .field("room_id", &self.room_id)
            .field("room_state", &self.room_state)
            .field("received", &self.received)
            .field("enqueued", &self.enqueued)
            .field("filtered", &self.filtered)
            .field("no_voice", &self.no_voice)
            .field("errors", &self.errors)
            .field("last_failure", &self.last_failure)
            .field("recent_events", &self.recent_events.len())
            .field("recent_results", &self.recent_results.len())
            .finish()
    }
}

impl LiveSnapshot {
    pub fn canonical_room_id(&self) -> Option<u64> {
        self.resolved_room_id.or(match self.room_state {
            RoomState::Connected { room_id, .. } => Some(room_id),
            _ => self.room_id,
        })
    }
}

impl Default for LiveSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            room_id: None,
            resolved_room_id: None,
            room_state: RoomState::Stopped,
            received: 0,
            enqueued: 0,
            filtered: 0,
            no_voice: 0,
            errors: 0,
            last_failure: None,
            emote_lookup_error: None,
            recent_events: Vec::new(),
            recent_results: Vec::new(),
        }
    }
}

#[derive(Debug, Error)]
pub enum LiveError {
    #[error("直播会话已启动 [DV-V01]")]
    AlreadyRunning,
    #[error("直播间连接失败：{0} [DV-V02]")]
    Room(#[from] BiliError),
    #[error("播放调度器已关闭 [DV-V03]")]
    Scheduler,
    #[error("仅显示弹幕的会话没有播放组件，请启用语音后重新连接 [DV-V04]")]
    PlaybackUnavailable,
}

struct Running {
    cancel: CancellationToken,
    worker: JoinHandle<()>,
}

struct WorkerContext {
    scheduler: Option<SchedulerHandle>,
    tts_enabled: Arc<Mutex<bool>>,
    playback_changes: watch::Receiver<u64>,
    emote_catalog: watch::Receiver<Arc<ReceivedEmoteCatalog>>,
    data_dir: PathBuf,
    dobao_device: Option<DoubaoDevice>,
    updates: watch::Sender<LiveSnapshot>,
    cancel: CancellationToken,
    room_driven: bool,
}

/// A single-room controller. A supplied device stays fixed; otherwise a stored
/// Doubao identity is loaded lazily only for an event that needs it.
pub struct LiveController {
    room: BiliRoomClient,
    scheduler: Option<SchedulerHandle>,
    tts_enabled: Arc<Mutex<bool>>,
    playback_changes: watch::Sender<u64>,
    data_dir: PathBuf,
    dobao_device: Option<DoubaoDevice>,
    running: Mutex<Option<Running>>,
    updates: watch::Sender<LiveSnapshot>,
    emote_catalog: watch::Sender<Arc<ReceivedEmoteCatalog>>,
}

impl LiveController {
    pub fn new(
        data_dir: impl AsRef<Path>,
        scheduler: SchedulerHandle,
        dobao_device: Option<DoubaoDevice>,
    ) -> Result<Self, LiveError> {
        Self::with_playback(data_dir, Some(scheduler), dobao_device)
    }

    /// Receive and display events without constructing an audio device,
    /// decoder, speech provider or scheduler. Enabling speech requires a new
    /// controller built with `new` and a real playback scheduler.
    pub fn new_receive_only(data_dir: impl AsRef<Path>) -> Result<Self, LiveError> {
        Self::with_playback(data_dir, None, None)
    }

    fn with_playback(
        data_dir: impl AsRef<Path>,
        scheduler: Option<SchedulerHandle>,
        dobao_device: Option<DoubaoDevice>,
    ) -> Result<Self, LiveError> {
        let (updates, _) = watch::channel(LiveSnapshot::default());
        let (emote_catalog, _) = watch::channel(Arc::new(ReceivedEmoteCatalog::default()));
        let (playback_changes, _) = watch::channel(0);
        let tts_enabled = Arc::new(Mutex::new(scheduler.is_some()));
        Ok(Self {
            room: BiliRoomClient::new()?,
            scheduler,
            tts_enabled,
            playback_changes,
            data_dir: data_dir.as_ref().to_path_buf(),
            dobao_device,
            running: Mutex::new(None),
            updates,
            emote_catalog,
        })
    }

    pub fn subscribe(&self) -> watch::Receiver<LiveSnapshot> {
        self.updates.subscribe()
    }

    pub fn snapshot(&self) -> LiveSnapshot {
        self.updates.borrow().clone()
    }

    /// Only verified current-account metadata may enter this in-memory catalog.
    /// Updating display metadata never requeues speech or changes old outcomes.
    pub fn set_received_emoticons(
        &self,
        account_id: u64,
        room_id: u64,
        packs: &[crate::chat_send::ChatEmoticonPack],
    ) {
        let catalog = Arc::new(ReceivedEmoteCatalog::from_packs(account_id, room_id, packs));
        self.emote_catalog.send_replace(catalog.clone());
        self.updates.send_modify(|state| {
            state.emote_lookup_error = None;
            for event in &mut state.recent_events {
                catalog.enrich(event);
            }
            for item in &mut state.recent_results {
                catalog.enrich(&mut item.event);
            }
        });
    }

    pub fn set_received_emoticon_error(&self, error: String) {
        self.updates
            .send_modify(|state| state.emote_lookup_error = Some(error.clone()));
    }

    pub fn audience_snapshot(&self) -> crate::audience::AudienceSnapshot {
        self.room.audience_snapshot()
    }

    pub async fn request_audience(&self, more: bool) -> Result<(), LiveError> {
        self.room.request_audience(more).await?;
        Ok(())
    }

    /// Serialize a short synchronous service-retirement check with live
    /// preparation and submission. The closure must not block or await.
    pub async fn with_speech_submissions_paused<F, R>(&self, check: F) -> R
    where
        F: FnOnce() -> R,
    {
        let _gate = self.tts_enabled.lock().await;
        check()
    }

    /// Stop live speech immediately while continuing to receive messages.
    /// The same gate protects submissions so a pending preparation cannot
    /// enqueue after this method acknowledges. Audition jobs are unaffected.
    pub async fn set_tts_enabled(&self, enabled: bool) -> Result<(), LiveError> {
        if enabled && self.scheduler.is_none() {
            return Err(LiveError::PlaybackUnavailable);
        }
        let mut gate = self.tts_enabled.lock().await;
        if *gate != enabled {
            *gate = enabled;
            self.playback_changes
                .send_modify(|generation| *generation = generation.wrapping_add(1));
        }
        if !enabled {
            stop_live_jobs(self.scheduler.as_ref()).await?;
        }
        Ok(())
    }

    /// The caller must explicitly start the shared scheduler before this call.
    /// A room connection cannot reopen a queue stopped by Stop All while its
    /// network start is still in flight. `None` uses only public room access
    /// and never initiates QR login.
    pub async fn start(&self, room_id: u64, session: Option<BiliSession>) -> Result<(), LiveError> {
        let mut running = self.running.lock().await;
        self.reap_finished(&mut running).await;
        if running.is_some() {
            return Err(LiveError::AlreadyRunning);
        }
        if room_id == 0 {
            return Err(BiliError::InvalidRoom.into());
        }

        if self
            .scheduler
            .as_ref()
            .is_some_and(|scheduler| !scheduler.state().borrow().accepting)
        {
            return Err(LiveError::Scheduler);
        }
        let mut lookup_error = None;
        if let Some(session) = session.as_ref() {
            if !self
                .emote_catalog
                .borrow()
                .matches_context(session.user_id(), room_id)
            {
                // Never retain another account's catalog when this read fails.
                self.emote_catalog
                    .send_replace(Arc::new(ReceivedEmoteCatalog::default()));
                let prior = self.emote_catalog.subscribe();
                let result = tokio::time::timeout(Duration::from_secs(5), async {
                    crate::chat_send::ChatSendClient::new()?
                        .account_emoticons_for(session, room_id)
                        .await
                })
                .await;
                // A newer UI metadata read can finish while this read waits.
                if !prior.has_changed().unwrap_or(true) {
                    match result {
                        Ok(Ok(packs)) => {
                            self.set_received_emoticons(session.user_id(), room_id, &packs)
                        }
                        Ok(Err(error)) => lookup_error = Some(error.to_string()),
                        Err(_) => {
                            lookup_error = Some("表情图片资料读取超时，请刷新表情列表".into())
                        }
                    }
                }
            }
        } else {
            self.emote_catalog
                .send_replace(Arc::new(ReceivedEmoteCatalog::default()));
        }
        let (events_tx, events_rx) = mpsc::channel(LIVE_EVENT_CHANNEL_CAPACITY);
        let slot = self.spawn_worker(room_id, events_rx, true);
        self.updates
            .send_modify(|state| state.emote_lookup_error = lookup_error);
        if let Err(error) = self.room.start(room_id, session, events_tx).await {
            slot.cancel.cancel();
            let _ = slot.worker.await;
            let _ = stop_live_jobs(self.scheduler.as_ref()).await;
            self.updates.send_replace(LiveSnapshot::default());
            diagnostics::record(DiagnosticCode::RoomFailed, None);
            return Err(error.into());
        }
        *running = Some(slot);
        Ok(())
    }

    /// Cancel intake and silence jobs before waiting for socket shutdown.
    /// Repeated stops are harmless.
    pub async fn stop(&self) -> Result<(), LiveError> {
        let mut running = self.running.lock().await;
        let Some(slot) = running.take() else {
            return Ok(());
        };
        slot.cancel.cancel();
        let scheduler_result = stop_live_jobs(self.scheduler.as_ref()).await;
        self.room.stop().await;
        let _ = slot.worker.await;
        self.updates.send_modify(|state| {
            state.running = false;
            state.room_state = RoomState::Stopped;
        });
        diagnostics::record(DiagnosticCode::RoomStopped, None);
        scheduler_result
    }

    fn spawn_worker(
        &self,
        room_id: u64,
        events: mpsc::Receiver<LiveEvent>,
        room_driven: bool,
    ) -> Running {
        self.updates.send_replace(LiveSnapshot {
            running: true,
            room_id: Some(room_id),
            room_state: RoomState::Connecting { room_id },
            ..LiveSnapshot::default()
        });
        let cancel = CancellationToken::new();
        let worker = tokio::spawn(run_events(
            events,
            self.room.subscribe_state(),
            WorkerContext {
                scheduler: self.scheduler.clone(),
                tts_enabled: self.tts_enabled.clone(),
                playback_changes: self.playback_changes.subscribe(),
                data_dir: self.data_dir.clone(),
                dobao_device: self.dobao_device.clone(),
                updates: self.updates.clone(),
                cancel: cancel.clone(),
                room_driven,
                emote_catalog: self.emote_catalog.subscribe(),
            },
        ));
        Running { cancel, worker }
    }

    async fn reap_finished(&self, running: &mut Option<Running>) {
        if running
            .as_ref()
            .is_some_and(|slot| slot.worker.is_finished())
        {
            let slot = running.take().expect("finished slot exists");
            let _ = slot.worker.await;
            let _ = stop_live_jobs(self.scheduler.as_ref()).await;
            self.room.stop().await;
        }
    }

    #[cfg(test)]
    async fn start_offline(&self, room_id: u64) -> Result<mpsc::Sender<LiveEvent>, LiveError> {
        let mut running = self.running.lock().await;
        self.reap_finished(&mut running).await;
        if running.is_some() {
            return Err(LiveError::AlreadyRunning);
        }
        if room_id == 0 {
            return Err(BiliError::InvalidRoom.into());
        }
        if self
            .scheduler
            .as_ref()
            .is_some_and(|scheduler| !scheduler.state().borrow().accepting)
        {
            return Err(LiveError::Scheduler);
        }
        let (sender, events) = mpsc::channel(LIVE_EVENT_CHANNEL_CAPACITY);
        *running = Some(self.spawn_worker(room_id, events, false));
        Ok(sender)
    }
}

impl Drop for LiveController {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running.try_lock()
            && let Some(slot) = running.take()
        {
            slot.cancel.cancel();
            slot.worker.abort();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let scheduler = self.scheduler.clone();
                runtime.spawn(async move {
                    let _ = stop_live_jobs(scheduler.as_ref()).await;
                });
            }
        }
    }
}

async fn stop_live_jobs(scheduler: Option<&SchedulerHandle>) -> Result<(), LiveError> {
    if let Some(scheduler) = scheduler {
        scheduler
            .stop_origin(JobOrigin::Live)
            .await
            .map_err(|_| LiveError::Scheduler)?;
    }
    Ok(())
}

enum PreparedEvent {
    Filtered,
    NoVoice,
    Ready(Box<RulePreview>, Arc<PreparedPlayback>),
}

enum SnapshotPrepareError {
    Storage,
    Rules,
    Prepare,
    NeedsDoubaoDevice { fallback_only: bool },
}

impl From<StorageError> for SnapshotPrepareError {
    fn from(_: StorageError) -> Self {
        Self::Storage
    }
}

impl From<SnapshotPrepareError> for LiveFailure {
    fn from(value: SnapshotPrepareError) -> Self {
        match value {
            SnapshotPrepareError::Storage => Self::Storage,
            SnapshotPrepareError::Rules => Self::Rules,
            SnapshotPrepareError::Prepare | SnapshotPrepareError::NeedsDoubaoDevice { .. } => {
                Self::Prepare
            }
        }
    }
}

fn prepare_event(
    data_dir: &Path,
    event: LiveEvent,
    dobao_device: Option<&DoubaoDevice>,
) -> Result<PreparedEvent, LiveFailure> {
    let mut store = DataStore::open(data_dir)?;
    let mut generated_device = None;
    let mut optional_device_unavailable = false;
    loop {
        let device = dobao_device.or(generated_device.as_ref());
        let result = store.with_read_snapshot(|store| {
            let rules = store.load_rules()?;
            let presets = store.presets()?;
            let bindings = store.bindings()?;
            let preview = rules
                .preview(&event, &presets, &bindings)
                .map_err(|_| SnapshotPrepareError::Rules)?;
            if preview.filtered_reason.is_some() {
                return Ok(PreparedEvent::Filtered);
            }
            if !preview.has_playable_audio() || (preview.needs_tts() && preview.voice.is_none()) {
                return Ok(PreparedEvent::NoVoice);
            }
            if device.is_none() && preview.needs_tts() {
                if preview
                    .voice
                    .as_ref()
                    .is_some_and(|voice| voice.provider == Provider::Doubao)
                {
                    return Err(SnapshotPrepareError::NeedsDoubaoDevice {
                        fallback_only: false,
                    });
                }
                if !optional_device_unavailable
                    && preview.voice_from_binding
                    && preview
                        .default_voice
                        .as_ref()
                        .is_some_and(|voice| voice.provider == Provider::Doubao)
                {
                    return Err(SnapshotPrepareError::NeedsDoubaoDevice {
                        fallback_only: true,
                    });
                }
            }
            let prepared = PreparedPlayback::from_store(store, &preview, device)
                .map_err(|_| SnapshotPrepareError::Prepare)?;
            Ok(PreparedEvent::Ready(Box::new(preview), prepared))
        });
        match result {
            Ok(prepared) => return Ok(prepared),
            Err(SnapshotPrepareError::NeedsDoubaoDevice { fallback_only }) => {
                // The read transaction has rolled back. Persist the stable
                // identity only for an event whose selected voice or primary
                // fallback needs Doubao, then re-plan against a fresh snapshot.
                match store.load_or_create_dobao_device() {
                    Ok(device) => generated_device = Some(device),
                    Err(_) if fallback_only => optional_device_unavailable = true,
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
}

async fn run_events(
    mut events: mpsc::Receiver<LiveEvent>,
    mut room_state: watch::Receiver<RoomState>,
    context: WorkerContext,
) {
    let WorkerContext {
        scheduler,
        tts_enabled,
        mut playback_changes,
        emote_catalog,
        data_dir,
        dobao_device,
        updates,
        cancel,
        room_driven,
    } = context;
    let mut pipeline = EventPipeline::new(GiftMergeSettings::default())
        .expect("default gift merge settings are valid");
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0u8;
    let mut room_ended = false;
    let mut playback_generation = *playback_changes.borrow_and_update();
    'session: loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            changed = playback_changes.changed() => {
                if changed.is_err() { break; }
                reconcile_playback_generation(
                    &mut pipeline, &mut playback_changes, &mut playback_generation);
            },
            changed = room_state.changed() => {
                if changed.is_ok() {
                    let state = room_state.borrow_and_update().clone();
                    let code = match &state {
                        RoomState::Stopped => DiagnosticCode::RoomStopped,
                        RoomState::SessionExpired { .. } => DiagnosticCode::RoomFailed,
                        RoomState::Connecting { .. } => DiagnosticCode::RoomConnecting,
                        RoomState::Connected { .. } => DiagnosticCode::RoomConnected,
                        RoomState::Reconnecting { .. } => DiagnosticCode::RoomReconnecting,
                    };
                    let number = match &state {
                        RoomState::Reconnecting { attempt, .. } => Some(u64::from(*attempt)),
                        _ => None,
                    };
                    if matches!(&state, RoomState::Reconnecting { .. }) {
                        diagnostics::record(DiagnosticCode::RoomFailed, number);
                    }
                    diagnostics::record(code, number);
                    let terminal = matches!(
                        &state,
                        RoomState::Stopped | RoomState::SessionExpired { .. }
                    );
                    updates.send_modify(|snapshot| {
                        if let RoomState::Connected { room_id, .. } = &state { snapshot.resolved_room_id = Some(*room_id); }
                        snapshot.room_state = state;
                    });
                    if room_driven && terminal {
                        room_ended = true;
                        break 'session;
                    }
                } else {
                    room_ended = room_driven;
                    break 'session;
                }
            },
            _ = tick.tick(), if pipeline.pending_gifts() > 0 => {
                if reconcile_playback_generation(
                    &mut pipeline, &mut playback_changes, &mut playback_generation) {
                    continue;
                }
                // Every arriving event reads current ingress settings. With
                // no pending gifts, the timer has nothing to flush or re-plan;
                // avoid opening SQLite every second while the room is quiet.
                if pipeline.pending_gifts() == 0 {
                    continue;
                }
                let event_generation = playback_generation;
                if !*tts_enabled.lock().await {
                    continue;
                }
                ticks = (ticks + 1) % 4;
                if ticks == 1 {
                    let refresh = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break 'session,
                        result = load_merge_settings(&data_dir) => result,
                    };
                    if reconcile_playback_generation(
                        &mut pipeline, &mut playback_changes, &mut playback_generation) {
                        continue;
                    }
                    match refresh.and_then(|merge| pipeline.set_merge_settings(merge)
                        .map_err(|_| LiveFailure::Storage)) {
                        Ok(flushed) => {
                            for event in flushed {
                                if !dispatch_event(event, &data_dir, dobao_device.as_ref(),
                                    SpeechGate { scheduler: scheduler.as_ref(), enabled: &tts_enabled,
                                        generation: &playback_changes },
                                    event_generation, &updates, &cancel).await { break 'session; }
                            }
                        },
                        Err(failure) => record_failure(&updates, failure),
                    }
                }
                if reconcile_playback_generation(
                    &mut pipeline, &mut playback_changes, &mut playback_generation) {
                    continue;
                }
                for event in pipeline.drain_due(Instant::now()) {
                    if !dispatch_event(event, &data_dir, dobao_device.as_ref(),
                        SpeechGate { scheduler: scheduler.as_ref(), enabled: &tts_enabled,
                            generation: &playback_changes },
                        event_generation, &updates, &cancel).await { break 'session; }
                }
            },
            event = events.recv() => {
                let Some(mut event) = event else { break; };
                // A room task can end with packets still buffered in the
                // bounded channel. They must not turn into new paid jobs.
                if room_driven && events.is_closed() {
                    room_ended = true;
                    break 'session;
                }
                if event_payload_bytes(&event) > MAX_LIVE_EVENT_BYTES {
                    updates.send_modify(|snapshot| {
                        snapshot.received = snapshot.received.saturating_add(1);
                    });
                    record_failure(&updates, LiveFailure::Rules);
                    continue;
                }
                let requested = updates.borrow().room_id.unwrap_or_default();
                if let RoomState::Connected { room_id } = *room_state.borrow() {
                    emote_catalog.borrow().enrich_in_connected_room(&mut event, requested, room_id);
                } else {
                    emote_catalog.borrow().enrich(&mut event);
                }
                updates.send_modify(|snapshot| {
                    snapshot.received = snapshot.received.saturating_add(1);
                    push_bounded(&mut snapshot.recent_events, event.clone());
                });
                if reconcile_playback_generation(
                    &mut pipeline, &mut playback_changes, &mut playback_generation) {
                    pipeline.remember_event_id(&event, Instant::now());
                    record_processed(&updates, event, LiveEventOutcome::DisplayOnly);
                    continue;
                }
                let event_generation = playback_generation;
                if !*tts_enabled.lock().await {
                    pipeline.remember_event_id(&event, Instant::now());
                    record_processed(&updates, event, LiveEventOutcome::DisplayOnly);
                    continue;
                }
                let ingress = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break 'session,
                    result = load_ingress_configuration(&data_dir) => result,
                };
                if reconcile_playback_generation(
                    &mut pipeline, &mut playback_changes, &mut playback_generation) {
                    pipeline.remember_event_id(&event, Instant::now());
                    record_processed(&updates, event, LiveEventOutcome::DisplayOnly);
                    continue;
                }
                let (merge, rules) = match ingress {
                    Ok(config) => config,
                    Err(failure) => {
                        record_processed(&updates, event, LiveEventOutcome::Failed(failure));
                        continue;
                    }
                };
                let flushed = match pipeline.set_merge_settings(merge) {
                    Ok(flushed) => flushed,
                    Err(_) => {
                        record_processed(&updates, event,
                            LiveEventOutcome::Failed(LiveFailure::Storage));
                        continue;
                    }
                };
                for ready in flushed {
                    if !dispatch_event(ready, &data_dir, dobao_device.as_ref(),
                        SpeechGate { scheduler: scheduler.as_ref(), enabled: &tts_enabled,
                            generation: &playback_changes },
                        event_generation, &updates, &cancel).await { break 'session; }
                }
                if reconcile_playback_generation(
                    &mut pipeline, &mut playback_changes, &mut playback_generation) {
                    pipeline.remember_event_id(&event, Instant::now());
                    record_processed(&updates, event, LiveEventOutcome::DisplayOnly);
                    continue;
                }
                // Legacy behavior filters each raw gift before grouping. A
                // series of individually cheap gifts cannot cross the price
                // threshold merely because it was merged.
                if event.kind == EventKind::Gift && rules.filter_reason(&event).is_some() {
                    record_processed(&updates, event, LiveEventOutcome::Filtered);
                    continue;
                }
                for ready in pipeline.ingest(event, Instant::now()) {
                    if !dispatch_event(ready, &data_dir, dobao_device.as_ref(),
                        SpeechGate { scheduler: scheduler.as_ref(), enabled: &tts_enabled,
                            generation: &playback_changes },
                        event_generation, &updates, &cancel).await { break 'session; }
                }
            },
        }
    }
    pipeline.clear();
    if room_ended {
        let _ = stop_live_jobs(scheduler.as_ref()).await;
    }
    updates.send_modify(|state| {
        state.running = false;
        if !matches!(&state.room_state, RoomState::SessionExpired { .. }) {
            state.room_state = RoomState::Stopped;
        }
    });
}

fn reconcile_playback_generation(
    pipeline: &mut EventPipeline,
    playback_changes: &mut watch::Receiver<u64>,
    known_generation: &mut u64,
) -> bool {
    let current = *playback_changes.borrow_and_update();
    if current == *known_generation {
        return false;
    }
    // The watch channel coalesces a rapid off/on pair into one notification.
    // Clear gifts as soon as that new generation is observed, even if this
    // worker was already waiting for a settings read to finish.
    pipeline.discard_pending_gifts();
    *known_generation = current;
    true
}

async fn load_merge_settings(data_dir: &Path) -> Result<GiftMergeSettings, LiveFailure> {
    let path = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let store = DataStore::open(path).map_err(|_| LiveFailure::Storage)?;
        store
            .load_live_settings()
            .map(|settings| settings.gift_merge)
            .map_err(|_| LiveFailure::Storage)
    })
    .await
    .map_err(|_| LiveFailure::Worker)?
}

async fn load_ingress_configuration(
    data_dir: &Path,
) -> Result<(GiftMergeSettings, RuleSet), LiveFailure> {
    let path = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let store = DataStore::open(path)?;
        store.with_read_snapshot(|store| {
            let merge = store.load_live_settings()?.gift_merge;
            let rules = store.load_rules()?;
            Ok((merge, rules))
        })
    })
    .await
    .map_err(|_| LiveFailure::Worker)?
}

struct SpeechGate<'a> {
    scheduler: Option<&'a SchedulerHandle>,
    enabled: &'a Mutex<bool>,
    generation: &'a watch::Receiver<u64>,
}

async fn dispatch_event(
    event: LiveEvent,
    data_dir: &Path,
    dobao_device: Option<&DoubaoDevice>,
    speech: SpeechGate<'_>,
    expected_generation: u64,
    updates: &watch::Sender<LiveSnapshot>,
    cancel: &CancellationToken,
) -> bool {
    // Keep preparation and submission in one gate. A UI disable waits for an
    // in-flight submission, cancels it, then acknowledges with no live jobs.
    let gate = speech.enabled.lock().await;
    if !*gate || speech.scheduler.is_none() || *speech.generation.borrow() != expected_generation {
        record_processed(updates, event, LiveEventOutcome::DisplayOnly);
        return true;
    }
    let scheduler = speech.scheduler.expect("enabled playback has a scheduler");
    let path = data_dir.to_path_buf();
    let preparation_event = event.clone();
    let device = dobao_device.cloned();
    let preparation = tokio::task::spawn_blocking(move || {
        prepare_event(&path, preparation_event, device.as_ref())
    });
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => return false,
        result = preparation => result,
    };
    if cancel.is_cancelled() {
        return false;
    }
    let result = match outcome {
        Ok(Ok(PreparedEvent::Filtered)) => LiveEventOutcome::Filtered,
        Ok(Ok(PreparedEvent::NoVoice)) => LiveEventOutcome::NoVoice,
        Ok(Ok(PreparedEvent::Ready(preview, prepared))) => {
            let submission = tokio::select! {
                biased;
                _ = cancel.cancelled() => return false,
                result = scheduler.submit_prepared(*preview, JobOrigin::Live, prepared) => result,
            };
            match submission {
                Ok(job_id) => LiveEventOutcome::Enqueued { job_id },
                Err(SubmitError::Full) => LiveEventOutcome::Failed(LiveFailure::QueueFull),
                Err(SubmitError::Stopped) => LiveEventOutcome::Failed(LiveFailure::QueueStopped),
                Err(SubmitError::Filtered) => LiveEventOutcome::Filtered,
                Err(SubmitError::NoVoice) => LiveEventOutcome::NoVoice,
            }
        }
        Ok(Err(failure)) => LiveEventOutcome::Failed(failure),
        Err(_) => LiveEventOutcome::Failed(LiveFailure::Worker),
    };
    record_processed(updates, event, result);
    true
}

fn record_processed(
    updates: &watch::Sender<LiveSnapshot>,
    event: LiveEvent,
    outcome: LiveEventOutcome,
) {
    let failure = match outcome {
        LiveEventOutcome::Failed(failure) => Some(failure),
        _ => None,
    };
    updates.send_modify(|state| {
        match outcome {
            LiveEventOutcome::DisplayOnly => {}
            LiveEventOutcome::Filtered => state.filtered = state.filtered.saturating_add(1),
            LiveEventOutcome::NoVoice => state.no_voice = state.no_voice.saturating_add(1),
            LiveEventOutcome::Enqueued { .. } => state.enqueued = state.enqueued.saturating_add(1),
            LiveEventOutcome::Failed(failure) => {
                state.errors = state.errors.saturating_add(1);
                state.last_failure = Some(failure);
            }
        }
        push_bounded(
            &mut state.recent_results,
            ProcessedLiveEvent { event, outcome },
        )
    });
    if let Some(failure) = failure {
        log_failure(failure, updates.borrow().errors);
    }
}

fn push_bounded<T>(items: &mut Vec<T>, item: T) {
    if items.len() == LIVE_RECENT_EVENT_LIMIT {
        items.remove(0);
    }
    items.push(item);
}

pub(crate) fn event_payload_bytes(event: &LiveEvent) -> usize {
    event
        .user_name
        .len()
        .saturating_add(event.avatar_url.as_ref().map_or(0, String::len))
        .saturating_add(event.message.len())
        .saturating_add(
            event
                .emotes
                .iter()
                .map(|emote| emote.text.len().saturating_add(emote.url.len()))
                .sum::<usize>(),
        )
        .saturating_add(event.gift_name.len())
        .saturating_add(event.guard_name.len())
        .saturating_add(event.coin_type.as_ref().map_or(0, String::len))
        .saturating_add(event.platform_event_id.as_ref().map_or(0, String::len))
}

fn record_failure(updates: &watch::Sender<LiveSnapshot>, failure: LiveFailure) {
    updates.send_modify(|state| {
        state.errors = state.errors.saturating_add(1);
        state.last_failure = Some(failure);
    });
    log_failure(failure, updates.borrow().errors);
}

fn log_failure(failure: LiveFailure, error_count: u64) {
    let code = match failure {
        LiveFailure::QueueFull | LiveFailure::QueueStopped => DiagnosticCode::EventDropped,
        LiveFailure::Storage | LiveFailure::Rules | LiveFailure::Prepare | LiveFailure::Worker => {
            DiagnosticCode::PlanFailed
        }
    };
    diagnostics::record(code, Some(error_count));
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use async_trait::async_trait;
    use tokio::{sync::mpsc, time::timeout};
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::{
        model::{GiftMergeSettings, LiveSettings, Provider, VoiceBinding, VoicePreset},
        rules::{EventTemplates, RuleSet},
        scheduler::{self, JobExecutor, JobOutcome, SpeechJob},
        storage::{ConnectionSettings, ServiceConnection},
    };

    struct CaptureExecutor {
        jobs: mpsc::Sender<SpeechJob>,
        wait_for_cancel: bool,
    }

    #[async_trait]
    impl JobExecutor for CaptureExecutor {
        async fn execute(
            &self,
            job: SpeechJob,
            cancel: CancellationToken,
        ) -> Result<JobOutcome, String> {
            self.jobs
                .send(job)
                .await
                .map_err(|_| "test receiver closed".to_owned())?;
            if self.wait_for_cancel {
                cancel.cancelled().await;
            }
            Ok(JobOutcome::default())
        }
    }

    fn configure_store(path: &Path) -> DataStore {
        let mut store = DataStore::open(path).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "local".into(),
                name: "local dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9".into(),
                    timeout_secs: 5,
                },
                has_credential: false,
            })
            .unwrap();
        for id in ["default", "bound"] {
            store
                .save_preset(&VoicePreset {
                    id: id.into(),
                    name: id.into(),
                    connection_id: "local".into(),
                    provider: Provider::Dots,
                    voice_id: format!("{id}.wav"),
                    speed: 1.0,
                    volume: 1.0,
                    sovits: None,
                })
                .unwrap();
        }
        let rules = RuleSet {
            default_preset_id: Some("default".into()),
            templates: EventTemplates {
                danmaku: "old:{message}".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        store.save_rules(&rules).unwrap();
        store
            .save_binding(
                "uid-7",
                &VoiceBinding {
                    platform: "bilibili".into(),
                    user_id: Some(7),
                    user_name: None,
                    legacy_user_name: None,
                    preset_id: "bound".into(),
                    enabled: true,
                },
            )
            .unwrap();
        store
    }

    #[test]
    fn unrelated_live_voice_ignores_unreadable_dobao_identity() {
        let temp = tempfile::tempdir().unwrap();
        drop(configure_store(temp.path()));
        let db = rusqlite::Connection::open(temp.path().join("danmakuvoice.sqlite3")).unwrap();
        db.execute(
            "INSERT INTO protected_secrets(key,protected_value) VALUES('dobao_device',?1)",
            rusqlite::params![vec![1_u8, 2, 3]],
        )
        .unwrap();
        drop(db);

        let event = LiveEvent::danmaku(42, Some(7), "Alice", "hello");
        assert!(matches!(
            prepare_event(temp.path(), event, None).unwrap(),
            PreparedEvent::Ready(..)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn dobao_identity_is_created_only_when_live_plan_selects_dobao() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "doubao".into(),
                name: "Doubao".into(),
                settings: ConnectionSettings::Doubao { timeout_secs: 30 },
                has_credential: false,
            })
            .unwrap();
        store
            .set_connection_credential("doubao", b"sessionid=test-secret; csrf_token=test")
            .unwrap();
        store
            .save_preset(&VoicePreset {
                id: "doubao-default".into(),
                name: "Doubao".into(),
                connection_id: "doubao".into(),
                provider: Provider::Doubao,
                voice_id: "voice".into(),
                speed: 1.0,
                volume: 1.0,
                sovits: None,
            })
            .unwrap();
        let rules = RuleSet {
            default_preset_id: Some("doubao-default".into()),
            ..RuleSet::default()
        };
        store.save_rules(&rules).unwrap();
        drop(store);

        let event = LiveEvent::danmaku(42, Some(7), "Alice", "hello");
        assert!(matches!(
            prepare_event(temp.path(), event, None).unwrap(),
            PreparedEvent::Ready(..)
        ));
        let mut reopened = DataStore::open(temp.path()).unwrap();
        let first = reopened.load_or_create_dobao_device().unwrap();
        assert_eq!(reopened.load_or_create_dobao_device().unwrap(), first);
    }

    async fn wait_for_enqueued(controller: &LiveController, count: u64) {
        let mut status = controller.subscribe();
        timeout(Duration::from_secs(3), async {
            loop {
                if status.borrow().enqueued >= count {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    fn gift(id: &str, price_yuan: f64) -> LiveEvent {
        let mut event = LiveEvent::danmaku(42, Some(7), "Alice", "");
        event.kind = EventKind::Gift;
        event.gift_name = "rose".into();
        event.quantity = 1;
        event.price_yuan = price_yuan;
        event.platform_event_id = Some(id.into());
        event
    }

    async fn wait_for_processed(controller: &LiveController, count: usize) {
        let mut status = controller.subscribe();
        timeout(Duration::from_secs(3), async {
            loop {
                if status.borrow().recent_results.len() >= count {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn idle_speech_session_does_not_initialize_or_poll_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("uninitialized");
        let (jobs_tx, _jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(&data_dir, scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        assert!(!data_dir.exists(), "idle timer accessed configuration");
        events
            .send(LiveEvent::danmaku(42, None, "user", "first message"))
            .await
            .unwrap();
        wait_for_processed(&controller, 1).await;
        assert!(data_dir.join("danmakuvoice.sqlite3").is_file());
        assert_eq!(controller.snapshot().errors, 0);
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn pending_gift_observes_merge_setting_change_without_another_event() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = configure_store(dir.path());
        let mut settings = LiveSettings {
            room_id: Some(42),
            gift_merge: GiftMergeSettings {
                enabled: true,
                initial_seconds: 5.0,
                increment_seconds: 0.0,
                maximum_seconds: 5.0,
            },
        };
        store.save_live_settings(&settings).unwrap();
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        events.send(gift("pending-gift", 6.0)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(controller.snapshot().received, 1);
        assert_eq!(controller.snapshot().enqueued, 0);
        settings.gift_merge.enabled = false;
        store.save_live_settings(&settings).unwrap();
        let job = timeout(Duration::from_secs(2), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            job.preview.event.platform_event_id.as_deref(),
            Some("pending-gift")
        );
        assert_eq!(job.preview.event.quantity, 1);
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn receive_only_keeps_real_event_payloads_without_audio_or_voice_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("uninitialized");
        let controller = LiveController::new_receive_only(&data_dir).unwrap();
        assert!(matches!(
            controller.set_tts_enabled(true).await,
            Err(LiveError::PlaybackUnavailable)
        ));
        let events = controller.start_offline(42).await.unwrap();
        let danmaku = LiveEvent::danmaku(42, Some(7), "Alice", "display this");
        let present = gift("display-gift", 1.0);
        events.send(danmaku.clone()).await.unwrap();
        events.send(present.clone()).await.unwrap();
        wait_for_processed(&controller, 2).await;
        let state = controller.snapshot();
        assert_eq!(state.recent_events, vec![danmaku, present]);
        assert!(
            state
                .recent_results
                .iter()
                .all(|event| event.outcome == LiveEventOutcome::DisplayOnly)
        );
        assert_eq!((state.enqueued, state.errors, state.no_voice), (0, 0, 0));
        assert!(
            !data_dir.exists(),
            "receive-only must not initialize speech configuration"
        );
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn repeated_receive_only_sessions_bound_history_and_close_old_producers() {
        const SESSIONS: u64 = 16;
        const EVENTS_PER_SESSION: u64 = 256;
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("uninitialized");
        let controller = LiveController::new_receive_only(&data_dir).unwrap();

        for cycle in 0..SESSIONS {
            let room_id = 42 + cycle;
            let events = controller.start_offline(room_id).await.unwrap();
            for index in 0..EVENTS_PER_SESSION {
                events
                    .send(LiveEvent::danmaku(
                        room_id,
                        Some(7),
                        "Alice",
                        &format!("{cycle}:{index}"),
                    ))
                    .await
                    .unwrap();
            }
            let mut status = controller.subscribe();
            timeout(Duration::from_secs(5), async {
                loop {
                    if status.borrow().received == EVENTS_PER_SESSION {
                        break;
                    }
                    status.changed().await.unwrap();
                }
            })
            .await
            .expect("bounded room receiver stopped making progress");

            let snapshot = controller.snapshot();
            assert_eq!(snapshot.room_id, Some(room_id));
            assert_eq!(snapshot.recent_events.len(), LIVE_RECENT_EVENT_LIMIT);
            assert_eq!(snapshot.recent_results.len(), LIVE_RECENT_EVENT_LIMIT);
            assert_eq!(
                snapshot.recent_events.last().unwrap().message,
                format!("{cycle}:255")
            );
            assert!(
                snapshot
                    .recent_results
                    .iter()
                    .all(|result| result.outcome == LiveEventOutcome::DisplayOnly)
            );
            controller.stop().await.unwrap();
            assert!(controller.running.lock().await.is_none());
            assert!(
                events
                    .send(LiveEvent::danmaku(room_id, Some(7), "Alice", "late"))
                    .await
                    .is_err(),
                "old room producer remained connected after stop"
            );
        }
        assert!(!data_dir.exists());
    }

    #[tokio::test]
    async fn disabling_speech_cancels_live_jobs_and_continues_display_without_replaying_messages() {
        let dir = tempfile::tempdir().unwrap();
        let _store = configure_store(dir.path());
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: true,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler.clone(), None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "speaking"))
            .await
            .unwrap();
        timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        wait_for_enqueued(&controller, 1).await;
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "pending"))
            .await
            .unwrap();
        wait_for_enqueued(&controller, 2).await;
        controller.set_tts_enabled(false).await.unwrap();
        let queue = scheduler.state().borrow().clone();
        assert!(queue.current.is_none());
        assert!(queue.pending.is_empty());
        assert!(queue.accepting);
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "silent"))
            .await
            .unwrap();
        events.send(gift("silent-gift", 1.0)).await.unwrap();
        wait_for_processed(&controller, 4).await;
        assert_eq!(
            controller.snapshot().recent_results[2].outcome,
            LiveEventOutcome::DisplayOnly
        );
        assert_eq!(
            controller.snapshot().recent_results[3].outcome,
            LiveEventOutcome::DisplayOnly
        );
        controller.set_tts_enabled(true).await.unwrap();
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "next"))
            .await
            .unwrap();
        let next = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.preview.final_text, "old:next");
        wait_for_enqueued(&controller, 3).await;
        assert_eq!(controller.snapshot().errors, 0);
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn speech_toggle_keeps_event_id_memory_for_reconnect_replays() {
        let dir = tempfile::tempdir().unwrap();
        let _store = configure_store(dir.path());
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();

        let mut spoken = LiveEvent::danmaku(42, Some(7), "Alice", "spoken");
        spoken.platform_event_id = Some("spoken-id".into());
        events.send(spoken.clone()).await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(3), jobs_rx.recv())
                .await
                .unwrap()
                .unwrap()
                .preview
                .event
                .message,
            "spoken"
        );
        wait_for_enqueued(&controller, 1).await;

        controller.set_tts_enabled(false).await.unwrap();
        let mut silent = LiveEvent::danmaku(42, Some(7), "Alice", "silent");
        silent.platform_event_id = Some("silent-id".into());
        events.send(silent.clone()).await.unwrap();
        wait_for_processed(&controller, 2).await;
        controller.set_tts_enabled(true).await.unwrap();
        events.send(spoken).await.unwrap();
        events.send(silent).await.unwrap();
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "new"))
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(3), jobs_rx.recv())
                .await
                .unwrap()
                .unwrap()
                .preview
                .event
                .message,
            "new"
        );
        wait_for_enqueued(&controller, 2).await;
        assert_eq!(controller.snapshot().received, 5);
        assert!(jobs_rx.try_recv().is_err());
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn rapid_off_on_discards_pending_gifts_and_rejects_stale_submission() {
        let mut pipeline = EventPipeline::new(GiftMergeSettings {
            enabled: true,
            ..GiftMergeSettings::default()
        })
        .unwrap();
        assert!(
            pipeline
                .ingest(gift("old-gift", 1.0), Instant::now())
                .is_empty()
        );
        assert_eq!(pipeline.pending_gifts(), 1);
        let (changes, mut observed_changes) = watch::channel(0u64);
        let mut known_generation = *observed_changes.borrow_and_update();
        changes.send_modify(|value| *value += 1); // off
        changes.send_modify(|value| *value += 1); // on before the worker polls
        assert!(reconcile_playback_generation(
            &mut pipeline,
            &mut observed_changes,
            &mut known_generation,
        ));
        assert_eq!(known_generation, 2);
        assert_eq!(pipeline.pending_gifts(), 0);

        let (jobs_tx, mut jobs_rx) = mpsc::channel(1);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let (updates, _) = watch::channel(LiveSnapshot::default());
        let enabled = Mutex::new(true);
        assert!(
            dispatch_event(
                LiveEvent::danmaku(42, Some(7), "Alice", "before-toggle"),
                Path::new("unused-for-stale-generation"),
                None,
                SpeechGate {
                    scheduler: Some(&scheduler),
                    enabled: &enabled,
                    generation: &observed_changes,
                },
                0,
                &updates,
                &CancellationToken::new(),
            )
            .await
        );
        assert!(jobs_rx.try_recv().is_err());
        assert_eq!(
            updates.borrow().recent_results[0].outcome,
            LiveEventOutcome::DisplayOnly
        );
    }

    #[tokio::test]
    async fn room_start_cannot_reopen_a_stopped_scheduler() {
        let dir = tempfile::tempdir().unwrap();
        let (jobs_tx, _jobs_rx) = mpsc::channel(1);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        let controller = LiveController::new(dir.path(), scheduler.clone(), None).unwrap();
        assert!(matches!(
            controller.start_offline(42).await,
            Err(LiveError::Scheduler)
        ));
        scheduler.start().await.unwrap();
        let events = controller.start_offline(42).await.unwrap();
        controller.stop().await.unwrap();
        drop(events);
        scheduler.stop_all().await.unwrap();
        assert!(matches!(
            controller.start_offline(42).await,
            Err(LiveError::Scheduler)
        ));
    }

    #[tokio::test]
    async fn offline_events_use_current_rules_bindings_and_enqueue_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = configure_store(dir.path());
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();

        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "one"))
            .await
            .unwrap();
        let first = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap_or_else(|_| panic!("no first job: {:?}", controller.snapshot()))
            .unwrap();
        assert_eq!(first.preview.final_text, "old:one");
        assert_eq!(first.preview.voice.as_ref().unwrap().id, "bound");
        assert!(first.prepared.is_some());
        wait_for_enqueued(&controller, 1).await;

        let mut rules = store.load_rules().unwrap();
        rules.templates.danmaku = "new:{message}".into();
        store
            .save_preset(&VoicePreset {
                id: "next-primary".into(),
                name: "next-primary".into(),
                connection_id: "local".into(),
                provider: Provider::Dots,
                voice_id: "next-primary.wav".into(),
                speed: 1.0,
                volume: 1.0,
                sovits: None,
            })
            .unwrap();
        rules.default_preset_id = Some("next-primary".into());
        store.save_rules(&rules).unwrap();
        store
            .save_binding(
                "uid-7",
                &VoiceBinding {
                    platform: "bilibili".into(),
                    user_id: Some(7),
                    user_name: None,
                    legacy_user_name: None,
                    preset_id: "bound".into(),
                    enabled: false,
                },
            )
            .unwrap();
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "two"))
            .await
            .unwrap();
        let second = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(second.preview.final_text, "new:two");
        assert_eq!(second.preview.voice.as_ref().unwrap().id, "next-primary");
        assert_eq!(first.preview.final_text, "old:one");
        assert_eq!(first.preview.voice.as_ref().unwrap().id, "bound");
        wait_for_enqueued(&controller, 2).await;
        assert_eq!(controller.snapshot().received, 2);
        assert_eq!(controller.snapshot().errors, 0);

        events
            .send(LiveEvent::danmaku(
                42,
                Some(7),
                "Alice",
                &"x".repeat(17_000),
            ))
            .await
            .unwrap();
        let mut status = controller.subscribe();
        timeout(Duration::from_secs(3), async {
            loop {
                if status.borrow().errors == 1 {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(controller.snapshot().recent_events.len(), 2);
        assert_eq!(controller.snapshot().enqueued, 2);
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn stopping_offline_session_closes_events_and_clears_active_job() {
        let dir = tempfile::tempdir().unwrap();
        let _store = configure_store(dir.path());
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: true,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler.clone(), None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "one"))
            .await
            .unwrap();
        let job = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap_or_else(|_| panic!("no job: {:?}", controller.snapshot()))
            .unwrap();
        assert_eq!(job.origin, JobOrigin::Live);
        for index in 0..12 {
            events
                .send(LiveEvent::danmaku(
                    42,
                    Some(7),
                    "Alice",
                    &format!("queued-{index}"),
                ))
                .await
                .unwrap();
        }
        controller.stop().await.unwrap();

        assert!(!controller.snapshot().running);
        assert_eq!(controller.snapshot().room_state, RoomState::Stopped);
        assert!(
            events
                .send(LiveEvent::danmaku(42, Some(7), "Alice", "late"))
                .await
                .is_err()
        );
        let queue = scheduler.state().borrow().clone();
        assert!(queue.accepting, "试听仍共用可用的调度器");
        assert!(queue.current.is_none());
        assert!(queue.pending.is_empty());
        assert!(
            timeout(Duration::from_millis(100), jobs_rx.recv())
                .await
                .is_err()
        );
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn closed_room_source_discards_buffered_late_events() {
        let dir = tempfile::tempdir().unwrap();
        let _store = configure_store(dir.path());
        let (jobs_tx, mut jobs_rx) = mpsc::channel(2);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        let controller = LiveController::new(dir.path(), scheduler.clone(), None).unwrap();
        scheduler.start().await.unwrap();

        let (sender, receiver) = mpsc::channel(2);
        sender
            .try_send(LiveEvent::danmaku(42, Some(7), "Alice", "late"))
            .unwrap();
        drop(sender);
        *controller.running.lock().await = Some(controller.spawn_worker(42, receiver, true));

        let mut status = controller.subscribe();
        timeout(Duration::from_secs(3), async {
            loop {
                if !status.borrow().running {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(controller.snapshot().received, 0);
        assert!(jobs_rx.try_recv().is_err());
        assert!(
            scheduler.state().borrow().accepting,
            "房间结束不应停止试听调度器"
        );
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn saved_session_expiry_ends_room_and_remains_visible_in_snapshot() {
        let (events_tx, events_rx) = mpsc::channel(1);
        let (room_tx, room_rx) = watch::channel(RoomState::Connecting { room_id: 42 });
        let (updates, snapshot) = watch::channel(LiveSnapshot {
            running: true,
            room_id: Some(42),
            room_state: RoomState::Connecting { room_id: 42 },
            ..LiveSnapshot::default()
        });
        let (_playback_tx, playback_rx) = watch::channel(0u64);
        let worker = tokio::spawn(run_events(
            events_rx,
            room_rx,
            WorkerContext {
                scheduler: None,
                tts_enabled: Arc::new(Mutex::new(false)),
                playback_changes: playback_rx,
                emote_catalog: watch::channel(Arc::new(ReceivedEmoteCatalog::default())).1,
                data_dir: PathBuf::from("unused-receive-only"),
                dobao_device: None,
                updates,
                cancel: CancellationToken::new(),
                room_driven: true,
            },
        ));
        room_tx.send_replace(RoomState::SessionExpired { room_id: 42 });
        timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(!snapshot.borrow().running);
        assert_eq!(
            snapshot.borrow().room_state,
            RoomState::SessionExpired { room_id: 42 }
        );
        drop(events_tx);
    }

    #[tokio::test]
    async fn gifts_are_filtered_before_merge_and_qualifying_gifts_enqueue_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = configure_store(dir.path());
        let mut rules = store.load_rules().unwrap();
        rules.events.gift_threshold_yuan = 5.0;
        rules.templates.gift = "{gift_num}".into();
        store.save_rules(&rules).unwrap();
        store
            .save_live_settings(&LiveSettings {
                room_id: Some(42),
                gift_merge: GiftMergeSettings {
                    enabled: true,
                    initial_seconds: 0.1,
                    increment_seconds: 0.0,
                    maximum_seconds: 0.1,
                },
            })
            .unwrap();

        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        events.send(gift("cheap-1", 3.0)).await.unwrap();
        events.send(gift("cheap-2", 3.0)).await.unwrap();

        let mut status = controller.subscribe();
        timeout(Duration::from_secs(3), async {
            loop {
                if status.borrow().filtered >= 2 {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(controller.snapshot().enqueued, 0);
        assert!(jobs_rx.try_recv().is_err());

        events.send(gift("paid-1", 6.0)).await.unwrap();
        events.send(gift("paid-2", 6.0)).await.unwrap();
        let job = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.preview.event.quantity, 2);
        assert_eq!(job.preview.event.price_yuan, 12.0);
        assert_eq!(job.preview.final_text, "2");
        wait_for_enqueued(&controller, 1).await;
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert_eq!(controller.snapshot().enqueued, 1);
        assert!(jobs_rx.try_recv().is_err());
        let snapshot = controller.snapshot();
        assert_eq!(snapshot.recent_events.len(), 4);
        assert_eq!(snapshot.recent_results.len(), 3);
        assert!(matches!(
            snapshot.recent_results[0].outcome,
            LiveEventOutcome::Filtered
        ));
        assert!(matches!(
            snapshot.recent_results[1].outcome,
            LiveEventOutcome::Filtered
        ));
        assert!(matches!(
            snapshot.recent_results[2].outcome,
            LiveEventOutcome::Enqueued { .. }
        ));
        controller.stop().await.unwrap();
    }
    #[tokio::test]
    async fn standalone_emote_filter_keeps_chat_and_applies_changes_without_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = configure_store(dir.path());
        let mut rules = store.load_rules().unwrap();
        rules.events.filter_bilibili_emoticons = true;
        store.save_rules(&rules).unwrap();
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        let mut metadata = vec![serde_json::Value::Null; 13];
        metadata[12] = serde_json::json!(1);
        let emote = crate::bilibili::parse_live_event(
            42,
            1,
            &serde_json::json!({"cmd":"DANMU_MSG","info":[metadata,"[表情]",[7,"Alice"]]}),
        )
        .unwrap();
        events.send(emote.clone()).await.unwrap();
        wait_for_processed(&controller, 1).await;
        let state = controller.snapshot();
        assert_eq!(state.filtered, 1);
        assert_eq!(state.recent_events, vec![emote.clone()]);
        assert_eq!(state.recent_results[0].outcome, LiveEventOutcome::Filtered);
        assert_eq!(state.enqueued, 0);
        assert!(jobs_rx.try_recv().is_err());
        events
            .send(LiveEvent::danmaku(42, Some(7), "Alice", "你好😀[表情]"))
            .await
            .unwrap();
        let job = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.preview.event.message, "你好😀[表情]");
        wait_for_processed(&controller, 2).await;
        rules.events.filter_bilibili_emoticons = false;
        store.save_rules(&rules).unwrap();
        events.send(emote.clone()).await.unwrap();
        let job = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.preview.event, emote);
        wait_for_processed(&controller, 3).await;
        rules.events.filter_bilibili_emoticons = true;
        store.save_rules(&rules).unwrap();
        events.send(emote).await.unwrap();
        wait_for_processed(&controller, 4).await;
        assert_eq!(controller.snapshot().filtered, 2);
        assert_eq!(controller.snapshot().enqueued, 2);
        assert_eq!(controller.snapshot().recent_events.len(), 4);
        assert!(controller.snapshot().running);
        assert!(jobs_rx.try_recv().is_err());
        controller.stop().await.unwrap();
    }

    #[tokio::test]
    async fn personal_marker_catalog_enriches_before_live_filter_and_metadata_refresh_never_requeues()
     {
        use crate::chat_send::{ChatEmoticon, ChatEmoticonPack};
        const MARKER: &str = "[费可装扮表情包_爱你]";
        const IMAGE: &str =
            "https://i0.hdslb.com/bfs/garb/699dc00ce1374521842dc1bf13d5946fc5d5607e.png";
        let dir = tempfile::tempdir().unwrap();
        let mut store = configure_store(dir.path());
        let mut rules = store.load_rules().unwrap();
        rules.events.filter_bilibili_emoticons = true;
        store.save_rules(&rules).unwrap();
        let (jobs_tx, mut jobs_rx) = mpsc::channel(4);
        let scheduler = scheduler::spawn(Arc::new(CaptureExecutor {
            jobs: jobs_tx,
            wait_for_cancel: false,
        }));
        scheduler.start().await.unwrap();
        let controller = LiveController::new(dir.path(), scheduler, None).unwrap();
        let events = controller.start_offline(42).await.unwrap();
        let packs = vec![ChatEmoticonPack {
            source: "account",
            name: "费可装扮表情包".into(),
            pkg_type: Some(3),
            icon: None,
            emoticons: vec![ChatEmoticon {
                emoticon_unique: "account:3735:52234".into(),
                emoji: MARKER.into(),
                url: Some(IMAGE.into()),
                allowed: true,
                kind: "text",
                text: Some(MARKER.into()),
                description: None,
            }],
        }];
        // Reproduce the real packet: plain comment marker, dm_type=0, no URL.
        let raw = |text: &str, sequence: u64| {
            crate::bilibili::parse_live_event(42, sequence, &serde_json::json!({"cmd":"DANMU_MSG","info":[[0,1,25,16777215,0,0,0,0,0,0,0,0,0],text,[7,"虚构观众"]]})).unwrap()
        };
        // Older messages acquire only display metadata, never a new job.
        events.send(raw(MARKER, 1)).await.unwrap();
        let _ = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        wait_for_processed(&controller, 1).await;
        let before = controller.snapshot();
        assert!(before.recent_events[0].emotes.is_empty());
        controller.set_received_emoticons(42, 42, &packs);
        let after = controller.snapshot();
        assert_eq!(
            (after.received, after.enqueued, after.filtered),
            (before.received, before.enqueued, before.filtered)
        );
        assert_eq!(
            after.recent_results[0].outcome,
            before.recent_results[0].outcome
        );
        assert_eq!(after.recent_events[0].emotes[0].url, IMAGE);
        assert_eq!(after.recent_results[0].event.emotes[0].url, IMAGE);
        assert!(jobs_rx.try_recv().is_err());

        events.send(raw(MARKER, 2)).await.unwrap();
        wait_for_processed(&controller, 2).await;
        assert_eq!(controller.snapshot().filtered, 1);
        assert_eq!(
            controller.snapshot().recent_results[1].outcome,
            LiveEventOutcome::Filtered
        );
        assert!(controller.snapshot().recent_events[1].emotes[0].large);
        assert!(jobs_rx.try_recv().is_err());

        let mixed = format!("你好{MARKER}");
        events.send(raw(&mixed, 3)).await.unwrap();
        let job = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.preview.event.message, mixed);
        assert_eq!(job.preview.event.emotes[0].url, IMAGE);
        assert!(!job.preview.event.is_bilibili_emoticon);
        wait_for_processed(&controller, 3).await;

        rules.events.filter_bilibili_emoticons = false;
        store.save_rules(&rules).unwrap();
        events.send(raw(MARKER, 4)).await.unwrap();
        let job = timeout(Duration::from_secs(3), jobs_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(job.preview.event.is_bilibili_emoticon);
        assert_eq!(job.preview.event.emotes[0].url, IMAGE);
        wait_for_processed(&controller, 4).await;
        assert_eq!(
            (
                controller.snapshot().enqueued,
                controller.snapshot().filtered
            ),
            (3, 1)
        );
        assert!(controller.snapshot().running);
        controller.stop().await.unwrap();
    }
}
