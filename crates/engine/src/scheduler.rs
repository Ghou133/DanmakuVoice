//! Single owner of preview/live playback jobs and their cancellation lifetime.

use crate::playback::PreparedPlayback;
use crate::rules::RulePreview;
use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MAX_PENDING: usize = 64;
const MAX_HISTORY: usize = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobOrigin {
    Live,
    Audition,
}

#[derive(Clone, Debug)]
pub struct SpeechJob {
    pub id: u64,
    pub generation: u64,
    pub origin: JobOrigin,
    /// An owned snapshot. Edits to rules/presets cannot change queued jobs.
    pub preview: RulePreview,
    /// Frozen service connection, credential and sound paths for real playback.
    pub prepared: Option<Arc<PreparedPlayback>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobState {
    Played,
    Failed,
    Skipped,
    Cleared,
    Stopped,
}

#[derive(Clone, Debug)]
pub struct JobRecord {
    pub id: u64,
    pub state: JobState,
    pub detail: String,
}

/// Safe user-visible completion text. The executor must never include a URL,
/// credential, source exception or response body here.
pub struct JobOutcome {
    pub detail: String,
}

impl Default for JobOutcome {
    fn default() -> Self {
        Self {
            detail: "播报完成".into(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct QueueSnapshot {
    pub accepting: bool,
    pub generation: u64,
    pub current: Option<SpeechJob>,
    pub pending: Vec<SpeechJob>,
    pub history: Vec<JobRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmitError {
    Stopped,
    Full,
    Filtered,
    NoVoice,
}

/// An executor streams a whole plan, including all text/sound parts, in one
/// slot. Dropping its future must cancel network requests and subprocesses.
#[async_trait]
pub trait JobExecutor: Send + Sync + 'static {
    async fn execute(
        &self,
        job: SpeechJob,
        cancel: CancellationToken,
    ) -> Result<JobOutcome, String>;

    /// Synchronously silence a cancelled job before the command acknowledges.
    /// An async task abort alone may not drop its guard before the next job.
    fn invalidate(&self, _job_id: u64) {}
}

enum Command {
    Start(oneshot::Sender<()>),
    Submit {
        preview: Box<RulePreview>,
        origin: JobOrigin,
        prepared: Option<Arc<PreparedPlayback>>,
        reply: oneshot::Sender<Result<u64, SubmitError>>,
    },
    SkipCurrent(oneshot::Sender<()>),
    ClearPending(oneshot::Sender<()>),
    StopOrigin(JobOrigin, oneshot::Sender<()>),
    StopAll(oneshot::Sender<()>),
}

#[derive(Clone)]
pub struct SchedulerHandle {
    tx: mpsc::Sender<Command>,
    state: watch::Receiver<QueueSnapshot>,
}

impl SchedulerHandle {
    pub fn state(&self) -> watch::Receiver<QueueSnapshot> {
        self.state.clone()
    }

    pub async fn start(&self) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Start(tx))
            .await
            .map_err(|_| "调度器已关闭")?;
        rx.await.map_err(|_| "调度器已关闭")
    }

    pub async fn submit(
        &self,
        preview: RulePreview,
        origin: JobOrigin,
    ) -> Result<u64, SubmitError> {
        self.submit_inner(preview, origin, None).await
    }

    pub async fn submit_prepared(
        &self,
        preview: RulePreview,
        origin: JobOrigin,
        prepared: Arc<PreparedPlayback>,
    ) -> Result<u64, SubmitError> {
        self.submit_inner(preview, origin, Some(prepared)).await
    }

    async fn submit_inner(
        &self,
        preview: RulePreview,
        origin: JobOrigin,
        prepared: Option<Arc<PreparedPlayback>>,
    ) -> Result<u64, SubmitError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Submit {
                preview: Box::new(preview),
                origin,
                prepared,
                reply: tx,
            })
            .await
            .map_err(|_| SubmitError::Stopped)?;
        rx.await.map_err(|_| SubmitError::Stopped)?
    }

    pub async fn skip_current(&self) -> Result<(), &'static str> {
        self.send_unit(Command::SkipCurrent).await
    }

    pub async fn clear_pending(&self) -> Result<(), &'static str> {
        self.send_unit(Command::ClearPending).await
    }

    pub async fn stop_all(&self) -> Result<(), &'static str> {
        self.send_unit(Command::StopAll).await
    }

    /// Cancel one producer's current and queued jobs without disturbing jobs
    /// from other producers or changing the scheduler's accepting state.
    pub async fn stop_origin(&self, origin: JobOrigin) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::StopOrigin(origin, tx))
            .await
            .map_err(|_| "调度器已关闭")?;
        rx.await.map_err(|_| "调度器已关闭")
    }

    async fn send_unit(
        &self,
        make: fn(oneshot::Sender<()>) -> Command,
    ) -> Result<(), &'static str> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(make(tx)).await.map_err(|_| "调度器已关闭")?;
        rx.await.map_err(|_| "调度器已关闭")
    }
}

struct Current {
    job: SpeechJob,
    cancel: CancellationToken,
    task: JoinHandle<Result<JobOutcome, String>>,
}

struct Scheduler {
    executor: Arc<dyn JobExecutor>,
    state: QueueSnapshot,
    next_id: u64,
    pending: VecDeque<SpeechJob>,
    current: Option<Current>,
    updates: watch::Sender<QueueSnapshot>,
}

pub fn spawn(executor: Arc<dyn JobExecutor>) -> SchedulerHandle {
    let (tx, rx) = mpsc::channel(80);
    let (updates, state) = watch::channel(QueueSnapshot::default());
    let scheduler = Scheduler {
        executor,
        state: QueueSnapshot::default(),
        next_id: 1,
        pending: VecDeque::new(),
        current: None,
        updates,
    };
    tokio::spawn(scheduler.run(rx));
    SchedulerHandle { tx, state }
}

impl Scheduler {
    fn publish(&mut self) {
        self.state.current = self.current.as_ref().map(|item| item.job.clone());
        self.state.pending = self.pending.iter().cloned().collect();
        self.updates.send_replace(self.state.clone());
    }

    fn record(&mut self, id: u64, state: JobState, detail: impl Into<String>) {
        self.state.history.push(JobRecord {
            id,
            state,
            detail: detail.into(),
        });
        if self.state.history.len() > MAX_HISTORY {
            self.state.history.remove(0);
        }
    }

    fn cancel_current(&mut self, state: JobState, detail: &'static str) {
        if let Some(current) = self.current.take() {
            self.executor.invalidate(current.job.id);
            current.cancel.cancel();
            current.task.abort();
            self.record(current.job.id, state, detail);
            // Invalidate any late PCM from this job even if a callback already has it.
            self.state.generation = self.state.generation.wrapping_add(1);
        }
    }

    fn clear_pending_as(&mut self, state: JobState, detail: &'static str) {
        while let Some(job) = self.pending.pop_front() {
            self.record(job.id, state, detail);
        }
    }

    fn start_next(&mut self) {
        if !self.state.accepting || self.current.is_some() {
            return;
        }
        if let Some(mut job) = self.pending.pop_front() {
            job.generation = self.state.generation;
            let cancel = CancellationToken::new();
            let executor = self.executor.clone();
            let task_job = job.clone();
            let task_cancel = cancel.clone();
            let task = tokio::spawn(async move { executor.execute(task_job, task_cancel).await });
            self.current = Some(Current { job, cancel, task });
        }
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Command>) {
        loop {
            tokio::select! {
                // A continuous stream of Submit commands must not starve the
                // completed current job. Tokio's default selection is fair.
                command = rx.recv() => {
                    let Some(command) = command else { break; };
                    match command {
                        Command::Start(reply) => {
                            self.state.accepting = true;
                            self.start_next();
                            self.publish();
                            let _ = reply.send(());
                        }
                        Command::Submit { preview, origin, prepared, reply } => {
                            let result = if !self.state.accepting { Err(SubmitError::Stopped) }
                                else if preview.filtered_reason.is_some() { Err(SubmitError::Filtered) }
                                else if !preview.has_playable_audio()
                                    || (preview.needs_tts() && preview.voice.is_none()) {
                                    Err(SubmitError::NoVoice)
                                }
                                else if self.pending.len() >= MAX_PENDING { Err(SubmitError::Full) }
                                else {
                                    let id = self.next_id;
                                    self.next_id = self.next_id.wrapping_add(1);
                                    self.pending.push_back(SpeechJob { id, generation: self.state.generation,
                                        origin, preview: *preview, prepared });
                                    self.start_next();
                                    self.publish();
                                    Ok(id)
                                };
                            let _ = reply.send(result);
                        }
                        Command::SkipCurrent(reply) => {
                            self.cancel_current(JobState::Skipped, "已跳过当前整条播报");
                            self.start_next();
                            self.publish();
                            let _ = reply.send(());
                        }
                        Command::ClearPending(reply) => {
                            self.clear_pending_as(JobState::Cleared, "已清空待播");
                            self.publish();
                            let _ = reply.send(());
                        }
                        Command::StopOrigin(origin, reply) => {
                            if self.current.as_ref().is_some_and(|current| current.job.origin == origin) {
                                self.cancel_current(JobState::Stopped, "来源已停止");
                            }
                            let mut retained = VecDeque::with_capacity(self.pending.len());
                            while let Some(job) = self.pending.pop_front() {
                                if job.origin == origin {
                                    self.record(job.id, JobState::Stopped, "来源已停止");
                                } else {
                                    retained.push_back(job);
                                }
                            }
                            self.pending = retained;
                            self.start_next();
                            self.publish();
                            let _ = reply.send(());
                        }
                        Command::StopAll(reply) => {
                            self.state.accepting = false;
                            self.cancel_current(JobState::Stopped, "全部停止");
                            self.clear_pending_as(JobState::Stopped, "全部停止");
                            self.state.generation = self.state.generation.wrapping_add(1);
                            self.publish();
                            let _ = reply.send(());
                        }
                    }
                }
                result = async { (&mut self.current.as_mut().unwrap().task).await }, if self.current.is_some() => {
                    let id = self.current.take().unwrap().job.id;
                    match result {
                        Ok(Ok(outcome)) => self.record(id, JobState::Played, outcome.detail),
                        Ok(Err(detail)) => self.record(id, JobState::Failed, detail),
                        Err(join_error) => self.record(id, JobState::Failed, format!("播报任务异常：{join_error}")),
                    }
                    self.start_next();
                    self.publish();
                }
            }
        }
        self.cancel_current(JobState::Stopped, "调度器关闭");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LiveEvent, Provider, VoicePreset};
    use crate::rules::RuleSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;
    use tokio::time::{Duration, sleep, timeout};

    struct WaitingExecutor {
        started: mpsc::Sender<u64>,
    }

    #[async_trait]
    impl JobExecutor for WaitingExecutor {
        async fn execute(
            &self,
            job: SpeechJob,
            cancel: CancellationToken,
        ) -> Result<JobOutcome, String> {
            self.started
                .send(job.id)
                .await
                .map_err(|error| error.to_string())?;
            cancel.cancelled().await;
            Ok(JobOutcome::default())
        }
    }

    fn preview() -> RulePreview {
        let preset = VoicePreset {
            id: "voice".into(),
            name: "声音".into(),
            connection_id: "local".into(),
            provider: Provider::Dots,
            voice_id: "ref.wav".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        let rules = RuleSet {
            default_preset_id: Some("voice".into()),
            ..Default::default()
        };
        rules
            .preview(
                &LiveEvent::danmaku(1, Some(1), "用户", "正文"),
                &[preset],
                &[],
            )
            .unwrap()
    }

    #[tokio::test]
    async fn skip_clear_stop_and_explicit_restart() {
        let (started_tx, mut started_rx) = mpsc::channel(8);
        let handle = spawn(Arc::new(WaitingExecutor {
            started: started_tx,
        }));
        assert_eq!(
            handle.submit(preview(), JobOrigin::Live).await,
            Err(SubmitError::Stopped)
        );
        handle.start().await.unwrap();
        let first = handle.submit(preview(), JobOrigin::Live).await.unwrap();
        assert_eq!(started_rx.recv().await, Some(first));
        let second = handle.submit(preview(), JobOrigin::Audition).await.unwrap();
        let third = handle.submit(preview(), JobOrigin::Live).await.unwrap();
        handle.clear_pending().await.unwrap();
        assert_eq!(handle.state.borrow().current.as_ref().unwrap().id, first);
        assert_eq!(handle.state.borrow().pending.len(), 0);
        assert!(
            handle
                .state
                .borrow()
                .history
                .iter()
                .any(|entry| entry.id == second && entry.state == JobState::Cleared)
        );
        assert!(
            handle
                .state
                .borrow()
                .history
                .iter()
                .any(|entry| entry.id == third && entry.state == JobState::Cleared)
        );
        let next = handle.submit(preview(), JobOrigin::Live).await.unwrap();
        handle.skip_current().await.unwrap();
        assert_eq!(started_rx.recv().await, Some(next));
        assert!(
            handle
                .state
                .borrow()
                .history
                .iter()
                .any(|entry| entry.id == first && entry.state == JobState::Skipped)
        );
        handle.stop_all().await.unwrap();
        assert!(!handle.state.borrow().accepting);
        assert_eq!(
            handle.submit(preview(), JobOrigin::Live).await,
            Err(SubmitError::Stopped)
        );
        handle.start().await.unwrap();
        let resumed = handle.submit(preview(), JobOrigin::Live).await.unwrap();
        assert_eq!(started_rx.recv().await, Some(resumed));
    }

    #[tokio::test]
    async fn stopping_live_preserves_the_shared_audition_queue() {
        let (started_tx, mut started_rx) = mpsc::channel(8);
        let handle = spawn(Arc::new(WaitingExecutor {
            started: started_tx,
        }));
        handle.start().await.unwrap();
        let live_current = handle.submit(preview(), JobOrigin::Live).await.unwrap();
        assert_eq!(started_rx.recv().await, Some(live_current));
        let live_pending = handle.submit(preview(), JobOrigin::Live).await.unwrap();
        let audition = handle.submit(preview(), JobOrigin::Audition).await.unwrap();
        handle.stop_origin(JobOrigin::Live).await.unwrap();
        assert_eq!(started_rx.recv().await, Some(audition));
        let state = handle.state().borrow().clone();
        assert!(state.accepting);
        assert_eq!(state.current.as_ref().map(|job| job.id), Some(audition));
        assert!(state.pending.is_empty());
        assert!(
            state
                .history
                .iter()
                .any(|entry| entry.id == live_current && entry.state == JobState::Stopped)
        );
        assert!(
            state
                .history
                .iter()
                .any(|entry| entry.id == live_pending && entry.state == JobState::Stopped)
        );
        handle.stop_all().await.unwrap();
    }

    struct ActiveGuard(Arc<AtomicUsize>);

    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }

    struct StressExecutor {
        started: mpsc::Sender<u64>,
        active: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl JobExecutor for StressExecutor {
        async fn execute(
            &self,
            job: SpeechJob,
            cancel: CancellationToken,
        ) -> Result<JobOutcome, String> {
            self.active.fetch_add(1, Ordering::AcqRel);
            let _guard = ActiveGuard(self.active.clone());
            self.started.send(job.id).await.map_err(|e| e.to_string())?;
            cancel.cancelled().await;
            Ok(JobOutcome::default())
        }
    }

    #[tokio::test]
    async fn bounded_backlog_survives_repeated_skip_stop_and_restart() {
        let (started_tx, mut started_rx) = mpsc::channel(128);
        let active = Arc::new(AtomicUsize::new(0));
        let handle = spawn(Arc::new(StressExecutor {
            started: started_tx,
            active: active.clone(),
        }));
        for _ in 0..3 {
            handle.start().await.unwrap();
            let first = handle.submit(preview(), JobOrigin::Live).await.unwrap();
            assert_eq!(started_rx.recv().await, Some(first));
            for _ in 0..64 {
                handle.submit(preview(), JobOrigin::Live).await.unwrap();
            }
            assert_eq!(
                handle.submit(preview(), JobOrigin::Live).await,
                Err(SubmitError::Full)
            );
            assert_eq!(handle.state.borrow().pending.len(), 64);
            for _ in 0..16 {
                handle.skip_current().await.unwrap();
                timeout(Duration::from_secs(2), started_rx.recv())
                    .await
                    .expect("next job did not start")
                    .expect("executor stopped unexpectedly");
            }
            handle.stop_all().await.unwrap();
            timeout(Duration::from_secs(2), async {
                while active.load(Ordering::Acquire) != 0 {
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("stopped jobs kept executing");
            let snapshot = handle.state.borrow().clone();
            assert!(!snapshot.accepting);
            assert!(snapshot.current.is_none() && snapshot.pending.is_empty());
        }
    }

    struct CompletingExecutor {
        started: mpsc::UnboundedSender<u64>,
        active: Arc<AtomicUsize>,
        peak_active: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl JobExecutor for CompletingExecutor {
        async fn execute(
            &self,
            job: SpeechJob,
            _cancel: CancellationToken,
        ) -> Result<JobOutcome, String> {
            let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.peak_active.fetch_max(active, Ordering::AcqRel);
            let _guard = ActiveGuard(self.active.clone());
            self.started
                .send(job.id)
                .map_err(|error| error.to_string())?;
            tokio::task::yield_now().await;
            Ok(JobOutcome::default())
        }
    }

    #[tokio::test]
    async fn thousands_of_completed_jobs_keep_fifo_and_bounded_state() {
        const BATCHES: usize = 128;
        const BATCH_SIZE: usize = 32;
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let active = Arc::new(AtomicUsize::new(0));
        let peak_active = Arc::new(AtomicUsize::new(0));
        let handle = spawn(Arc::new(CompletingExecutor {
            started: started_tx,
            active: active.clone(),
            peak_active: peak_active.clone(),
        }));
        handle.start().await.unwrap();
        let mut ids = Vec::with_capacity(BATCHES * BATCH_SIZE);
        let mut state = handle.state();

        for _ in 0..BATCHES {
            for _ in 0..BATCH_SIZE {
                ids.push(handle.submit(preview(), JobOrigin::Live).await.unwrap());
            }
            let last = *ids.last().unwrap();
            timeout(Duration::from_secs(5), async {
                loop {
                    let snapshot = state.borrow_and_update().clone();
                    assert!(snapshot.pending.len() <= MAX_PENDING);
                    assert!(snapshot.history.len() <= MAX_HISTORY);
                    if snapshot.current.is_none()
                        && snapshot.pending.is_empty()
                        && snapshot.history.last().is_some_and(|record| {
                            record.id == last && record.state == JobState::Played
                        })
                    {
                        break;
                    }
                    state.changed().await.unwrap();
                }
            })
            .await
            .expect("completed jobs left the FIFO stuck");
        }

        let executed: Vec<_> = (0..ids.len())
            .map(|_| started_rx.try_recv().expect("job was not executed"))
            .collect();
        assert_eq!(executed, ids);
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert_eq!(peak_active.load(Ordering::Acquire), 1);
        let snapshot = handle.state.borrow().clone();
        assert_eq!(snapshot.history.len(), MAX_HISTORY);
        assert!(snapshot.current.is_none() && snapshot.pending.is_empty());
        handle.stop_all().await.unwrap();
    }
}
