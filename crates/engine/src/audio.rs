//! CPAL output. Its callback only dequeues ready samples and applies master gain.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_queue::ArrayQueue;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

// The output ring holds at most two seconds. If the callback cannot consume
// anything for this long, keeping FFmpeg and the TTS request alive would leave
// the current queue slot stuck indefinitely.
const OUTPUT_STALL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputSelection {
    Default,
    Named(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("没有可用的音频输出设备 [DV-A01]")]
    NoDevice,
    #[error("找不到音频输出设备：{0} [DV-A02]")]
    DeviceNotFound(String),
    #[error("同名音频设备不止一个：{0} [DV-A03]")]
    AmbiguousDevice(String),
    #[error("音频设备操作失败：{0} [DV-A04]")]
    Backend(#[from] cpal::Error),
    #[error("设备不支持的采样格式：{0:?} [DV-A05]")]
    UnsupportedSampleFormat(cpal::SampleFormat),
    #[error("播放已取消")]
    Cancelled,
    #[error("音频输出设备已断开 [DV-A07]")]
    Disconnected,
    #[error("输出设备连续 5 秒未消耗音频 [DV-A08]")]
    Stalled,
}

impl AudioError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoDevice => "DV-A01",
            Self::DeviceNotFound(_) => "DV-A02",
            Self::AmbiguousDevice(_) => "DV-A03",
            Self::Backend(_) => "DV-A04",
            Self::UnsupportedSampleFormat(_) => "DV-A05",
            Self::Cancelled => "DV-A06",
            Self::Disconnected => "DV-A07",
            Self::Stalled => "DV-A08",
        }
    }
}

#[derive(Clone, Copy)]
struct TaggedSample {
    job_id: u64,
    value: f32,
}

struct Shared {
    samples: ArrayQueue<TaggedSample>,
    active_job: AtomicU64,
    /// Last job that put PCM into the device queue. A failed synthesis may be
    /// rerouted only before this boundary; the callback may already have
    /// consumed any queued sample.
    queued_audio_job: AtomicU64,
    volume_bits: AtomicU32,
    disconnected: AtomicBool,
    underruns: AtomicU64,
}

/// Cloneable writer used by the async decode task; capacity is fixed at open.
#[derive(Clone)]
pub struct AudioWriter {
    shared: Arc<Shared>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioWriter {
    pub fn activate(&self, job_id: u64) {
        self.shared.active_job.store(0, Ordering::Release);
        while self.shared.samples.pop().is_some() {}
        self.shared.queued_audio_job.store(0, Ordering::Release);
        self.shared.active_job.store(job_id, Ordering::Release);
    }

    pub fn has_queued_audio(&self, job_id: u64) -> bool {
        self.shared.queued_audio_job.load(Ordering::Acquire) == job_id
    }

    pub fn cancel_active(&self) {
        self.shared.active_job.store(0, Ordering::Release);
        while self.shared.samples.pop().is_some() {}
    }

    /// Invalidate only this job. Its late samples are discarded by the CPAL
    /// callback, while a newer job can safely keep playing after an old
    /// task's cancellation guard drops.
    pub fn deactivate_if(&self, job_id: u64) {
        let _ =
            self.shared
                .active_job
                .compare_exchange(job_id, 0, Ordering::AcqRel, Ordering::Acquire);
    }

    pub fn set_master_volume(&self, value: f32) {
        self.shared
            .volume_bits
            .store(value.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }

    pub fn disconnected(&self) -> bool {
        self.shared.disconnected.load(Ordering::Acquire)
    }
    pub fn underruns(&self) -> u64 {
        self.shared.underruns.load(Ordering::Relaxed)
    }
    pub fn queued_samples(&self) -> usize {
        self.shared.samples.len()
    }

    /// Backpressure is on the producer, never the CPAL callback. The caller
    /// must supply samples already converted to this device's rate/channels.
    pub async fn push_interleaved(
        &self,
        job_id: u64,
        samples: &[f32],
        cancel: &CancellationToken,
    ) -> Result<(), AudioError> {
        self.push_interleaved_inner(job_id, samples, cancel, OUTPUT_STALL_TIMEOUT, None)
            .await
    }

    /// Record whether this specific speech fragment reached the ring. The
    /// marker belongs to its FFmpeg task, so a late chunk from a cancelled
    /// prior job cannot alter the next job's fallback decision.
    pub(crate) async fn push_interleaved_marked(
        &self,
        job_id: u64,
        samples: &[f32],
        cancel: &CancellationToken,
        progress: &AtomicBool,
    ) -> Result<(), AudioError> {
        self.push_interleaved_inner(
            job_id,
            samples,
            cancel,
            OUTPUT_STALL_TIMEOUT,
            Some(progress),
        )
        .await
    }

    #[cfg(test)]
    async fn push_interleaved_with_stall_timeout(
        &self,
        job_id: u64,
        samples: &[f32],
        cancel: &CancellationToken,
        stall_timeout: Duration,
    ) -> Result<(), AudioError> {
        self.push_interleaved_inner(job_id, samples, cancel, stall_timeout, None)
            .await
    }

    async fn push_interleaved_inner(
        &self,
        job_id: u64,
        samples: &[f32],
        cancel: &CancellationToken,
        stall_timeout: Duration,
        progress: Option<&AtomicBool>,
    ) -> Result<(), AudioError> {
        let mut marked_progress = false;
        for value in samples {
            let sample = TaggedSample {
                job_id,
                value: if value.is_finite() {
                    value.clamp(-1.0, 1.0)
                } else {
                    0.0
                },
            };
            let stalled_since = Instant::now();
            loop {
                if cancel.is_cancelled() || self.shared.active_job.load(Ordering::Acquire) != job_id
                {
                    return Err(AudioError::Cancelled);
                }
                if self.disconnected() {
                    return Err(AudioError::Disconnected);
                }
                if self.shared.samples.push(sample).is_ok() {
                    self.shared
                        .queued_audio_job
                        .store(job_id, Ordering::Release);
                    if !marked_progress {
                        if let Some(progress) = progress {
                            progress.store(true, Ordering::Release);
                        }
                        marked_progress = true;
                    }
                    break;
                }
                if stalled_since.elapsed() >= stall_timeout {
                    self.shared.disconnected.store(true, Ordering::Release);
                    return Err(AudioError::Stalled);
                }
                tokio::select! {
                    _ = cancel.cancelled() => return Err(AudioError::Cancelled),
                    _ = tokio::time::sleep(Duration::from_millis(3)) => {},
                }
            }
        }
        Ok(())
    }

    pub async fn wait_until_drained(
        &self,
        job_id: u64,
        cancel: &CancellationToken,
    ) -> Result<(), AudioError> {
        self.wait_until_drained_with_stall_timeout(job_id, cancel, OUTPUT_STALL_TIMEOUT)
            .await
    }

    async fn wait_until_drained_with_stall_timeout(
        &self,
        job_id: u64,
        cancel: &CancellationToken,
        stall_timeout: Duration,
    ) -> Result<(), AudioError> {
        let mut previous_len = self.shared.samples.len();
        let mut last_progress = Instant::now();
        loop {
            if cancel.is_cancelled() || self.shared.active_job.load(Ordering::Acquire) != job_id {
                return Err(AudioError::Cancelled);
            }
            if self.disconnected() {
                return Err(AudioError::Disconnected);
            }
            let remaining = self.shared.samples.len();
            if remaining == 0 {
                return Ok(());
            }
            if remaining < previous_len {
                last_progress = Instant::now();
            } else if last_progress.elapsed() >= stall_timeout {
                self.shared.disconnected.store(true, Ordering::Release);
                return Err(AudioError::Stalled);
            }
            previous_len = remaining;
            tokio::select! {
                _ = cancel.cancelled() => return Err(AudioError::Cancelled),
                _ = tokio::time::sleep(Duration::from_millis(5)) => {},
            }
        }
    }
}

pub struct AudioOutput {
    _stream: cpal::Stream,
    pub writer: AudioWriter,
    pub device_name: String,
    device_id: Option<cpal::DeviceId>,
    follows_default: bool,
}

pub fn enumerate_devices() -> Result<Vec<DeviceInfo>, AudioError> {
    let host = cpal::default_host();
    let default_id = current_default_id();
    let mut result = Vec::new();
    for device in host.output_devices()? {
        let name = device
            .description()
            .map(|description| description.name().to_owned())
            .unwrap_or_else(|_| "未知设备".into());
        result.push(DeviceInfo {
            is_default: default_id
                .as_ref()
                .is_some_and(|id| device.id().ok().as_ref() == Some(id)),
            name,
        });
    }
    Ok(result)
}

/// Cheap read-only probe for a configured default output route. Requiring a
/// DeviceId here would reject drivers that can open a stream but cannot report
/// an identity.
pub fn default_output_available() -> bool {
    cpal::default_host()
        .default_output_device()
        .is_some_and(|device| device.default_output_config().is_ok())
}

fn current_default_id() -> Option<cpal::DeviceId> {
    cpal::default_host().default_output_device()?.id().ok()
}

impl AudioOutput {
    /// A default output selection follows Windows' current default device.
    /// Prefer device identities; use the display name only when the driver
    /// cannot report an ID. A missing default needs a reopen, while failed
    /// metadata reads alone must not cause a repeated reconnect loop.
    pub fn default_device_changed(&self) -> bool {
        if !self.follows_default {
            return false;
        }
        let Some(current) = cpal::default_host().default_output_device() else {
            return true;
        };
        let current_id = current.id().ok();
        let current_name = current.description().ok();
        default_route_changed(
            self.device_id.as_ref(),
            &self.device_name,
            current_id.as_ref(),
            current_name.as_ref().map(|description| description.name()),
        )
    }

    pub fn open(selection: &OutputSelection, master_volume: f32) -> Result<Self, AudioError> {
        let host = cpal::default_host();
        let device = match selection {
            OutputSelection::Default => host.default_output_device().ok_or(AudioError::NoDevice)?,
            OutputSelection::Named(name) => {
                let mut matches = host.output_devices()?.filter(|device| {
                    device
                        .description()
                        .ok()
                        .as_ref()
                        .map(|description| description.name())
                        == Some(name.as_str())
                });
                let first = matches
                    .next()
                    .ok_or_else(|| AudioError::DeviceNotFound(name.clone()))?;
                if matches.next().is_some() {
                    return Err(AudioError::AmbiguousDevice(name.clone()));
                }
                first
            }
        };
        let device_id = device.id().ok();
        let device_name = device
            .description()
            .map(|description| description.name().to_owned())
            .unwrap_or_else(|_| "未知设备".into());
        let supported = device.default_output_config()?;
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let capacity = (sample_rate as usize * channels as usize * 2).clamp(4096, 768_000);
        let shared = Arc::new(Shared {
            samples: ArrayQueue::new(capacity),
            active_job: AtomicU64::new(0),
            queued_audio_job: AtomicU64::new(0),
            volume_bits: AtomicU32::new(master_volume.clamp(0.0, 2.0).to_bits()),
            disconnected: AtomicBool::new(false),
            underruns: AtomicU64::new(0),
        });
        let writer = AudioWriter {
            shared: shared.clone(),
            sample_rate,
            channels,
        };
        let config: cpal::StreamConfig = supported.into();
        let error_shared = shared.clone();
        let error = move |_error: cpal::Error| {
            // A CPAL stream callback reports a broken output path. Some
            // backends use BackendSpecific instead of DeviceNotAvailable, so
            // every stream error must release a backpressured producer.
            error_shared.disconnected.store(true, Ordering::Release);
        };
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => {
                let callback_shared = shared.clone();
                device.build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        fill(data, &callback_shared, |sample| sample);
                    },
                    error,
                    None,
                )?
            }
            cpal::SampleFormat::I16 => {
                let callback_shared = shared.clone();
                device.build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        fill(data, &callback_shared, |sample| {
                            (sample * 32767.0).round() as i16
                        });
                    },
                    error,
                    None,
                )?
            }
            cpal::SampleFormat::U16 => {
                let callback_shared = shared.clone();
                device.build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        fill(data, &callback_shared, |sample| {
                            ((sample + 1.0) * 32767.5).round() as u16
                        });
                    },
                    error,
                    None,
                )?
            }
            format => return Err(AudioError::UnsupportedSampleFormat(format)),
        };
        stream.play()?;
        Ok(Self {
            _stream: stream,
            writer,
            device_name,
            device_id,
            follows_default: matches!(selection, OutputSelection::Default),
        })
    }
}

fn default_route_changed(
    opened_id: Option<&cpal::DeviceId>,
    opened_name: &str,
    current_id: Option<&cpal::DeviceId>,
    current_name: Option<&str>,
) -> bool {
    match (opened_id, current_id) {
        (Some(opened), Some(current)) => opened != current,
        _ => current_name.is_some_and(|name| name != opened_name),
    }
}

fn fill<T: Copy>(data: &mut [T], shared: &Shared, convert: impl Fn(f32) -> T) {
    let volume = f32::from_bits(shared.volume_bits.load(Ordering::Relaxed));
    let mut empty = false;
    for out in data {
        let value = loop {
            match shared.samples.pop() {
                Some(tagged) if tagged.job_id == shared.active_job.load(Ordering::Acquire) => {
                    break tagged.value;
                }
                Some(_) => continue,
                None => {
                    empty = true;
                    break 0.0;
                }
            }
        };
        *out = convert((value * volume).clamp(-1.0, 1.0));
    }
    if empty {
        shared.underruns.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
pub(crate) fn test_writer(sample_rate: u32, channels: u16, capacity: usize) -> AudioWriter {
    AudioWriter {
        shared: Arc::new(Shared {
            samples: ArrayQueue::new(capacity),
            active_job: AtomicU64::new(0),
            queued_audio_job: AtomicU64::new(0),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            disconnected: AtomicBool::new(false),
            underruns: AtomicU64::new(0),
        }),
        sample_rate,
        channels,
    }
}

#[cfg(test)]
impl AudioWriter {
    pub(crate) fn disconnect_test_device(&self) {
        self.shared.disconnected.store(true, Ordering::Release);
    }

    pub(crate) fn take_test_samples(&self) -> Vec<f32> {
        let mut result = Vec::new();
        while let Some(sample) = self.shared.samples.pop() {
            result.push(sample.value);
        }
        result
    }

    pub(crate) fn render_test_frames(&self, samples: usize) -> Vec<f32> {
        let mut output = vec![0.0; samples];
        fill(&mut output, &self.shared, |sample| sample);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_device_change_prefers_identity_and_degrades_to_name() {
        let host = cpal::default_host().id();
        let opened = cpal::DeviceId::new(host, "first-output");
        let same = cpal::DeviceId::new(host, "first-output");
        let other = cpal::DeviceId::new(host, "second-output");
        assert!(!default_route_changed(
            Some(&opened),
            "Same name",
            Some(&same),
            Some("Same name")
        ));
        assert!(default_route_changed(
            Some(&opened),
            "Same name",
            Some(&other),
            Some("Same name")
        ));
        assert!(!default_route_changed(None, "Output", None, Some("Output")));
        assert!(default_route_changed(None, "Output", None, Some("Another")));
        assert!(!default_route_changed(None, "Output", None, None));
    }

    #[tokio::test]
    async fn fixed_buffer_cancellation_and_volume() {
        let shared = Arc::new(Shared {
            samples: ArrayQueue::new(2),
            active_job: AtomicU64::new(0),
            queued_audio_job: AtomicU64::new(0),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            disconnected: AtomicBool::new(false),
            underruns: AtomicU64::new(0),
        });
        let writer = AudioWriter {
            shared,
            sample_rate: 48_000,
            channels: 1,
        };
        writer.activate(7);
        assert!(!writer.has_queued_audio(7));
        writer.set_master_volume(0.5);
        let token = CancellationToken::new();
        writer
            .push_interleaved(7, &[0.8, -0.8], &token)
            .await
            .unwrap();
        assert!(writer.has_queued_audio(7));
        let mut output = [0f32; 2];
        fill(&mut output, &writer.shared, |sample| sample);
        assert_eq!(output, [0.4, -0.4]);
        writer.cancel_active();
        assert!(matches!(
            writer.push_interleaved(7, &[1.0], &token).await,
            Err(AudioError::Cancelled)
        ));
        writer.activate(8);
        assert!(!writer.has_queued_audio(8));
        writer.push_interleaved(8, &[0.25], &token).await.unwrap();
        writer.deactivate_if(7);
        assert_eq!(writer.shared.active_job.load(Ordering::Acquire), 8);
        let mut next = [0f32; 1];
        fill(&mut next, &writer.shared, |sample| sample);
        assert_eq!(next, [0.125]);
    }

    #[tokio::test]
    async fn empty_queue_still_reports_cancel_or_disconnected_device() {
        let writer = test_writer(48_000, 2, 8);
        writer.activate(42);
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(
            writer.wait_until_drained(42, &cancelled).await,
            Err(AudioError::Cancelled)
        ));

        let active = CancellationToken::new();
        writer.shared.disconnected.store(true, Ordering::Release);
        assert!(matches!(
            writer.wait_until_drained(42, &active).await,
            Err(AudioError::Disconnected)
        ));

        writer.shared.disconnected.store(false, Ordering::Release);
        writer.deactivate_if(42);
        assert!(matches!(
            writer.wait_until_drained(42, &active).await,
            Err(AudioError::Cancelled)
        ));
    }

    #[tokio::test]
    async fn stopped_callback_releases_backpressured_producer() {
        let writer = test_writer(48_000, 1, 2);
        writer.activate(91);
        let cancel = CancellationToken::new();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            writer.push_interleaved_with_stall_timeout(
                91,
                &[0.25, 0.5, 0.75],
                &cancel,
                Duration::from_millis(30),
            ),
        )
        .await
        .expect("stalled writer did not finish");
        assert!(matches!(result, Err(AudioError::Stalled)));
        assert!(writer.disconnected());
    }

    #[tokio::test]
    async fn stopped_callback_releases_drain_waiter() {
        let writer = test_writer(48_000, 1, 2);
        writer.activate(92);
        let cancel = CancellationToken::new();
        writer.push_interleaved(92, &[0.25], &cancel).await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            writer.wait_until_drained_with_stall_timeout(92, &cancel, Duration::from_millis(30)),
        )
        .await
        .expect("stalled drain did not finish");
        assert!(matches!(result, Err(AudioError::Stalled)));
        assert!(writer.disconnected());
    }
}
