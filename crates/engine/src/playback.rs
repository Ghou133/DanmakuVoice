//! Frozen playback plans and the real TTS → FFmpeg → CPAL job executor.

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{
    audio::AudioWriter,
    ffmpeg::{self, DecodeError},
    model::{Provider, SovitsModelSelection as PresetModelSelection, VoicePreset},
    rules::{PlanPart, RulePreview},
    scheduler::{JobExecutor, JobOutcome, SpeechJob},
    storage::{ConnectionSettings, DataStore, StorageError},
    tts::{
        AudioStream, TtsError,
        dobao::{DoubaoClient, DoubaoConfig, DoubaoDevice},
        dots::{DotsClient, DotsConfig},
        fish::{FishClient, FishConfig},
        sovits::{SovitsClient, SovitsConfig, SovitsLanguage, SovitsModelSelection, TextSplit},
    },
    voice_library::ReferenceRole,
};

#[derive(Debug, Error)]
pub enum PrepareError {
    #[error("这条消息已被过滤 [DV-P01]")]
    Filtered,
    #[error("未选择声音预设 [DV-P02]")]
    NoVoice,
    #[error("声音预设缺少音色或参考音频 ID [DV-P03]")]
    EmptyVoiceId,
    #[error("声音预设的语速须在 0.5 到 2.0 之间 [DV-P04]")]
    InvalidSpeed,
    #[error("声音预设的音量须在 0 到 2.0 之间 [DV-P05]")]
    InvalidVolume,
    #[error("声音预设对应的服务连接不存在 [DV-P06]")]
    MissingConnection,
    #[error("声音预设和服务连接的类型不一致 [DV-P07]")]
    ProviderMismatch,
    #[error("此服务连接缺少登录信息或 API Key [DV-P08]")]
    MissingCredential,
    #[error("豆包设备标识尚未初始化 [DV-P09]")]
    MissingDoubaoDevice,
    #[error("GPT-SoVITS 音色语言或分句方式无效 [DV-P10]")]
    InvalidSovitsSettings,
    #[error("音效素材文件不可用 [DV-P11]")]
    MissingSound,
    #[error("参考音频原文件已删除或不可读，请重新选择 [DV-P12]")]
    MissingReferenceAudio,
    #[error("找不到随应用提供的 ffmpeg.exe [DV-P13]")]
    MissingFfmpeg,
    #[error("读取播放配置失败：{0}")]
    Storage(#[from] StorageError),
    #[error("语音服务配置失败：{0}")]
    Tts(#[from] TtsError),
}

enum PreparedProvider {
    Dots(DotsClient),
    GptSovits(SovitsClient),
    FishAudio(FishClient),
    Doubao(DoubaoClient),
}

impl PreparedProvider {
    fn stream(&self, text: &str, cancel: &CancellationToken) -> Result<AudioStream, TtsError> {
        match self {
            Self::Dots(client) => client.stream(text, cancel),
            Self::GptSovits(client) => client.stream(text, cancel),
            Self::FishAudio(client) => client.stream(text, cancel),
            Self::Doubao(client) => client.stream(text, cancel),
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Dots(_) => "dots.tts",
            Self::GptSovits(_) => "GPT-SoVITS",
            Self::FishAudio(_) => "Fish Audio",
            Self::Doubao(_) => "豆包",
        }
    }

    async fn readiness(&self, cancel: &CancellationToken) -> Result<Readiness, String> {
        let check = async {
            match self {
                Self::Dots(client) => match client.readiness(cancel).await {
                    Ok(true) => Ok(Readiness::Ready),
                    Ok(false) => Ok(Readiness::Offline("模型尚未就绪")),
                    Err(error) => classify_readiness_error(error),
                },
                Self::GptSovits(client) => match client.readiness(cancel).await {
                    Ok(true) => Ok(Readiness::Ready),
                    Ok(false) => Ok(Readiness::Offline("无法连接服务")),
                    Err(error) => classify_readiness_error(error),
                },
                // No paid remote probe. A paused account is known unusable;
                // Fish and an unpaused Doubao client are tried directly.
                Self::Doubao(client) if client.pause_reason().is_some() => {
                    Ok(Readiness::Offline("豆包账号已暂停"))
                }
                Self::Doubao(_) | Self::FishAudio(_) => Ok(Readiness::Unknown),
            }
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("播放已取消".into()),
            result = tokio::time::timeout(Duration::from_secs(2), check) =>
                result.unwrap_or(Ok(Readiness::Unknown)),
        }
    }
}

enum Readiness {
    Ready,
    Offline(&'static str),
    Unknown,
}

enum FallbackCause {
    BeforeStart(&'static str),
    SynthesisBeforeAudio,
}

fn classify_readiness_error(error: TtsError) -> Result<Readiness, String> {
    match error {
        TtsError::Cancelled => Err("播放已取消".into()),
        TtsError::Network {
            reason: "无法连接服务",
            ..
        } => Ok(Readiness::Offline("无法连接服务")),
        _ => Ok(Readiness::Unknown),
    }
}

enum PreparedPart {
    Text(String),
    Sound(PathBuf),
    OutputTest,
}

/// A complete enqueue-time snapshot. It owns the service client (including
/// its credential), voice settings, text and immutable sound asset paths.
/// It has deliberately redacted `Debug` output because queue state is visible
/// to the UI and may be logged there.
pub struct PreparedPlayback {
    provider: Option<PreparedProvider>,
    parts: Vec<PreparedPart>,
    ffmpeg_speed: f32,
    voice_volume: f32,
    selected_from_binding: bool,
    selected_issue: Option<&'static str>,
    selected_name: Option<&'static str>,
    fallback: Option<Arc<PreparedPlayback>>,
    fallback_issue: Option<&'static str>,
}

impl fmt::Debug for PreparedPlayback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedPlayback")
            .field(
                "provider",
                &self
                    .provider
                    .as_ref()
                    .map_or("none", PreparedProvider::name),
            )
            .field(
                "fallback_provider",
                &self
                    .fallback
                    .as_ref()
                    .and_then(|plan| plan.provider.as_ref())
                    .map_or("none", PreparedProvider::name),
            )
            .field("parts", &self.parts.len())
            .field("credentials", &"[redacted]")
            .finish()
    }
}

impl PreparedPlayback {
    /// A local calibration tone, with no account, voice preset or network request.
    pub fn output_test() -> (RulePreview, Arc<Self>) {
        let preview = RulePreview {
            event: crate::model::LiveEvent::danmaku(0, None, "", "测试声音"),
            filtered_reason: None,
            final_text: "测试声音".into(),
            // Built-in sound identity is only used by this frozen plan, not storage.
            parts: vec![PlanPart::Sound {
                trigger: String::new(),
                asset_id: "builtin:output-test".into(),
            }],
            voice: None,
            default_voice: None,
            voice_from_binding: false,
            pending_legacy_binding: false,
        };
        let plan = Self {
            provider: None,
            parts: vec![PreparedPart::OutputTest],
            ffmpeg_speed: 1.0,
            voice_volume: 1.0,
            selected_from_binding: false,
            selected_issue: None,
            selected_name: None,
            fallback: None,
            fallback_issue: None,
        };
        (preview, Arc::new(plan))
    }

    async fn select_for_execution(
        &self,
        cancel: &CancellationToken,
    ) -> Result<(&PreparedPlayback, Option<String>), String> {
        if cancel.is_cancelled() {
            return Err("播放已取消".into());
        }
        let Some(target) = self.provider.as_ref() else {
            if let Some(issue) = self.selected_issue {
                return self
                    .choose_default(FallbackCause::BeforeStart(issue), cancel)
                    .await;
            }
            return Ok((self, None));
        };
        // Direct/default jobs never preflight or automatically change route.
        if !self.selected_from_binding {
            return Ok((self, None));
        }
        match target.readiness(cancel).await? {
            Readiness::Ready => Ok((self, None)),
            Readiness::Unknown => Ok((self, None)),
            Readiness::Offline(reason) => {
                self.choose_default(FallbackCause::BeforeStart(reason), cancel)
                    .await
            }
        }
    }

    async fn choose_default(
        &self,
        cause: FallbackCause,
        cancel: &CancellationToken,
    ) -> Result<(&PreparedPlayback, Option<String>), String> {
        if cancel.is_cancelled() {
            return Err("播放已取消".into());
        }
        let target = self.selected_name.unwrap_or("指定声音");
        let unavailable = self.fallback_issue.unwrap_or("未配置可用的主选声音");
        let fallback = self
            .fallback
            .as_deref()
            .ok_or_else(|| format!("指定的 {target} 不可用；{unavailable}，本条未发起主选合成"))?;
        let default = fallback.provider.as_ref().ok_or("主选声音缺少语音服务")?;
        match default.readiness(cancel).await? {
            Readiness::Offline(reason) => Err(format!(
                "指定的 {target} 不可用；主选 {} 也不可用（{reason}），本条未发起主选合成",
                default.name()
            )),
            Readiness::Ready | Readiness::Unknown => {
                let notice = match cause {
                    FallbackCause::BeforeStart(reason) => format!(
                        "指定的 {target} 不可用（{reason}），本条临时使用默认 {}",
                        default.name()
                    ),
                    FallbackCause::SynthesisBeforeAudio => format!(
                        "指定的 {target} 合成失败（尚未播放语音），本条临时使用默认 {}",
                        default.name()
                    ),
                };
                Ok((fallback, Some(notice)))
            }
        }
    }

    /// Read the selected connection and protected credential once. Sound asset
    /// IDs are resolved now, so later rule, connection or asset edits cannot
    /// redirect a queued job. `dobao_device` must be stable and persisted by
    /// the caller; no device ID is regenerated for each utterance.
    pub fn from_store(
        store: &DataStore,
        preview: &RulePreview,
        dobao_device: Option<&DoubaoDevice>,
    ) -> Result<Arc<Self>, PrepareError> {
        if preview.filtered_reason.is_some() {
            return Err(PrepareError::Filtered);
        }
        let (provider, ffmpeg_speed, voice_volume, selected_issue) = if preview.needs_tts() {
            let prepared = (|| -> Result<(PreparedProvider, f32, f32), PrepareError> {
                let preset = preview.voice.as_ref().ok_or(PrepareError::NoVoice)?;
                validate_preset(preset)?;
                let connection = store
                    .connections()?
                    .into_iter()
                    .find(|connection| connection.id == preset.connection_id)
                    .ok_or(PrepareError::MissingConnection)?;
                if connection.settings.provider() != preset.provider {
                    return Err(PrepareError::ProviderMismatch);
                }
                let (provider, ffmpeg_speed) = match connection.settings {
                    ConnectionSettings::Dots {
                        endpoint,
                        timeout_secs,
                    } => {
                        let reference = store.reference_profile(
                            &connection.id,
                            &ReferenceRole::Dots {
                                role: preset.voice_id.clone(),
                            },
                        )?;
                        let mut config = DotsConfig::new(endpoint);
                        let migrated = store.dots_playback_settings(&preset.id)?;
                        config.prompt_text = (!migrated.prompt_text.trim().is_empty())
                            .then_some(migrated.prompt_text);
                        config.language =
                            (!migrated.language.trim().is_empty()).then_some(migrated.language);
                        config.num_steps = migrated.num_steps;
                        config.normalize_text = migrated.normalize_text;
                        if let Some(profile) = reference {
                            DataStore::validate_reference_audio_path(Path::new(
                                &profile.audio_path,
                            ))
                            .map_err(|_| PrepareError::MissingReferenceAudio)?;
                            config.voice = Some(profile.audio_path);
                            // An omitted transcript lets dots.tts read a same-name
                            // sidecar .txt, or use its transcript-free mode.
                            config.prompt_text = (!profile.reference_text.trim().is_empty())
                                .then_some(profile.reference_text);
                        } else {
                            config.voice = Some(preset.voice_id.clone());
                        }
                        config.timeout_secs = timeout_secs.min(30);
                        (
                            PreparedProvider::Dots(DotsClient::new(config)?),
                            preset.speed,
                        )
                    }
                    ConnectionSettings::GptSovits {
                        endpoint,
                        timeout_secs,
                    } => {
                        let mut config = SovitsConfig::new(endpoint, preset.voice_id.clone());
                        // Older presets have only a reference path and use the
                        // server's resident model with transcript-free prompting.
                        config.reference_text_free = true;
                        if let Some(settings) = &preset.sovits {
                            config.model_selection = match settings.model_selection {
                                PresetModelSelection::GlobalResident => {
                                    SovitsModelSelection::GlobalResident
                                }
                                PresetModelSelection::PerRequestAtomic => {
                                    SovitsModelSelection::PerRequestAtomic
                                }
                            };
                            config.gpt_weights_path = settings.gpt_weights_path.clone();
                            config.sovits_weights_path = settings.sovits_weights_path.clone();
                            config.reference_text = settings.reference_text.clone();
                            config.reference_text_free = settings.reference_text_free;
                            config.reference_language =
                                SovitsLanguage::from_api_code(&settings.reference_language)
                                    .ok_or(PrepareError::InvalidSovitsSettings)?;
                            config.text_language =
                                SovitsLanguage::from_api_code(&settings.text_language)
                                    .ok_or(PrepareError::InvalidSovitsSettings)?;
                            config.split = TextSplit::from_api_code(&settings.split)
                                .ok_or(PrepareError::InvalidSovitsSettings)?;
                            config.top_k = settings.top_k;
                            config.top_p = settings.top_p;
                            config.temperature = settings.temperature;
                            config.sample_steps = settings.sample_steps;
                            config.super_sampling = settings.super_sampling;
                            config.fragment_interval_secs = settings.fragment_interval_secs;
                            if let (Some(gpt), Some(sovits)) = (
                                settings.gpt_weights_path.as_ref(),
                                settings.sovits_weights_path.as_ref(),
                            ) {
                                let role = ReferenceRole::GptSovits {
                                    gpt_weights_path: gpt.clone(),
                                    sovits_weights_path: sovits.clone(),
                                };
                                if let Some(profile) =
                                    store.reference_profile(&connection.id, &role)?
                                {
                                    DataStore::validate_reference_audio_path(Path::new(
                                        &profile.audio_path,
                                    ))
                                    .map_err(|_| PrepareError::MissingReferenceAudio)?;
                                    config.reference_audio_path = profile.audio_path;
                                    config.reference_text = profile.reference_text;
                                    config.reference_text_free = profile.text_free;
                                    config.reference_language =
                                        SovitsLanguage::from_api_code(&profile.reference_language)
                                            .ok_or(PrepareError::InvalidSovitsSettings)?;
                                    config.text_language =
                                        SovitsLanguage::from_api_code(&profile.text_language)
                                            .ok_or(PrepareError::InvalidSovitsSettings)?;
                                }
                            }
                        }
                        config.speed_factor = preset.speed;
                        config.timeout_secs = timeout_secs.min(30);
                        (PreparedProvider::GptSovits(SovitsClient::new(config)?), 1.0)
                    }
                    ConnectionSettings::FishAudio { timeout_secs } => {
                        let config =
                            fish_config_from_store(store, &connection.id, preset, timeout_secs)?;
                        (PreparedProvider::FishAudio(FishClient::new(config)?), 1.0)
                    }
                    ConnectionSettings::Doubao { timeout_secs } => {
                        let device = dobao_device.ok_or(PrepareError::MissingDoubaoDevice)?;
                        let secret = store
                            .connection_credential(&connection.id)?
                            .ok_or(PrepareError::MissingCredential)?;
                        let mut config = DoubaoConfig::new(
                            secret.as_str().map_err(StorageError::from)?,
                            device.clone(),
                        )?;
                        config.voice_id = preset.voice_id.clone();
                        config.speed = preset.speed;
                        config.timeout_secs = timeout_secs.min(30);
                        (PreparedProvider::Doubao(DoubaoClient::new(config)?), 1.0)
                    }
                };
                Ok((provider, ffmpeg_speed, preset.volume))
            })();
            match prepared {
                Ok((provider, speed, volume)) => (Some(provider), speed, volume, None),
                Err(error @ PrepareError::Storage(StorageError::Secret(_)))
                    if preview.voice_from_binding =>
                {
                    (None, 1.0, 1.0, Some(prepare_issue(&error)))
                }
                Err(PrepareError::Storage(error)) => return Err(PrepareError::Storage(error)),
                Err(error) if preview.voice_from_binding => {
                    (None, 1.0, 1.0, Some(prepare_issue(&error)))
                }
                Err(error) => return Err(error),
            }
        } else {
            (None, 1.0, 1.0, None)
        };
        let mut parts = Vec::with_capacity(preview.parts.len());
        for part in &preview.parts {
            match part {
                PlanPart::Text(text) => parts.push(PreparedPart::Text(text.clone())),
                PlanPart::Sound { asset_id, .. } => {
                    let path = store.asset_path(asset_id)?;
                    if !path.is_file() {
                        return Err(PrepareError::MissingSound);
                    }
                    parts.push(PreparedPart::Sound(path));
                }
            }
        }
        let (fallback, fallback_issue) = if preview.needs_tts() && preview.voice_from_binding {
            match (preview.voice.as_ref(), preview.default_voice.as_ref()) {
                (Some(selected), Some(default)) => {
                    if selected.id == default.id || same_synthesis(selected, default) {
                        (None, Some("默认声音与指定声音相同"))
                    } else {
                        let mut fallback_preview = preview.clone();
                        fallback_preview.voice = Some(default.clone());
                        fallback_preview.default_voice = None;
                        fallback_preview.voice_from_binding = false;
                        match Self::from_store(store, &fallback_preview, dobao_device) {
                            Ok(plan) => (Some(plan), None),
                            Err(_) => (None, Some("默认声音配置不可用")),
                        }
                    }
                }
                _ => (None, Some("未配置默认声音")),
            }
        } else {
            (None, None)
        };
        Ok(Arc::new(Self {
            provider,
            parts,
            ffmpeg_speed,
            voice_volume,
            selected_from_binding: preview.voice_from_binding,
            selected_issue,
            selected_name: preview
                .voice
                .as_ref()
                .map(|voice| provider_name(voice.provider)),
            fallback,
            fallback_issue,
        }))
    }
}

fn prepare_issue(error: &PrepareError) -> &'static str {
    match error {
        PrepareError::MissingConnection | PrepareError::ProviderMismatch => "指定服务连接不可用",
        PrepareError::MissingCredential => "指定服务缺少登录信息",
        PrepareError::Storage(StorageError::Secret(_)) => "指定服务登录信息不可用",
        PrepareError::MissingDoubaoDevice => "豆包设备信息不可用",
        PrepareError::MissingReferenceAudio => "指定参考音频不可用",
        _ => "指定声音配置不可用",
    }
}

fn same_synthesis(selected: &VoicePreset, default: &VoicePreset) -> bool {
    selected.provider == default.provider
        && selected.connection_id == default.connection_id
        && selected.voice_id == default.voice_id
        && selected.sovits == default.sovits
        && selected.speed == default.speed
}

fn provider_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Dots => "dots.tts",
        Provider::GptSovits => "GPT-SoVITS",
        Provider::FishAudio => "Fish Audio",
        Provider::Doubao => "豆包",
    }
}

fn fish_config_from_store(
    store: &DataStore,
    connection_id: &str,
    preset: &VoicePreset,
    timeout_secs: u64,
) -> Result<FishConfig, PrepareError> {
    let secret = store
        .connection_credential(connection_id)?
        .ok_or(PrepareError::MissingCredential)?;
    let mut config = FishConfig::new(
        secret.as_str().map_err(StorageError::from)?.to_owned(),
        preset.voice_id.clone(),
    );
    config.apply_playback_settings(&store.fish_audio_settings(connection_id)?);
    // Product playback is always incremental. Persisted legacy `false` is
    // ignored now that the user-facing mode switch has been removed.
    config.streaming = true;
    config.speed = preset.speed;
    config.timeout_secs = timeout_secs.min(30);
    Ok(config)
}

fn validate_preset(preset: &VoicePreset) -> Result<(), PrepareError> {
    if preset.voice_id.trim().is_empty() {
        return Err(PrepareError::EmptyVoiceId);
    }
    if !preset.speed.is_finite() || !(0.5..=2.0).contains(&preset.speed) {
        return Err(PrepareError::InvalidSpeed);
    }
    if !preset.volume.is_finite() || !(0.0..=2.0).contains(&preset.volume) {
        return Err(PrepareError::InvalidVolume);
    }
    Ok(())
}

pub struct PlaybackExecutor {
    writer: AudioWriter,
    ffmpeg_path: PathBuf,
}

impl PlaybackExecutor {
    /// `AudioOutput` must remain alive while this executor uses its writer.
    /// Supply the app-bundled ffmpeg.exe, never an implicit executable search.
    pub fn new(writer: AudioWriter, ffmpeg_path: impl AsRef<Path>) -> Result<Self, PrepareError> {
        let ffmpeg_path = ffmpeg_path.as_ref();
        if !ffmpeg_path.is_file() {
            return Err(PrepareError::MissingFfmpeg);
        }
        Ok(Self {
            writer,
            ffmpeg_path: ffmpeg_path.to_path_buf(),
        })
    }

    pub fn writer(&self) -> &AudioWriter {
        &self.writer
    }
}

struct ActiveJobGuard {
    writer: AudioWriter,
    job_id: u64,
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        self.writer.deactivate_if(self.job_id);
    }
}

enum AttemptError {
    Cancelled,
    Synthesis(String),
    Playback(String),
}

struct PlanFailure {
    error: AttemptError,
    part_index: usize,
    speech_started: bool,
}

impl AttemptError {
    fn message(self) -> String {
        match self {
            Self::Cancelled => "播放已取消".into(),
            Self::Synthesis(message) | Self::Playback(message) => message,
        }
    }
}

impl PlaybackExecutor {
    async fn play_plan(
        &self,
        plan: &PreparedPlayback,
        job_id: u64,
        start_at: usize,
        cancel: &CancellationToken,
    ) -> Result<(), PlanFailure> {
        let mut speech_started = false;
        for (part_index, part) in plan.parts.iter().enumerate().skip(start_at) {
            if cancel.is_cancelled() {
                return Err(PlanFailure {
                    error: AttemptError::Cancelled,
                    part_index,
                    speech_started,
                });
            }
            let is_speech =
                matches!(part, PreparedPart::Text(text) if text.chars().any(char::is_alphanumeric));
            let speech_progress = AtomicBool::new(false);
            let result = self
                .play_part(plan, part, job_id, cancel, &speech_progress)
                .await;
            if is_speech && speech_progress.load(Ordering::Acquire) {
                speech_started = true;
            }
            if let Err(error) = result {
                return Err(PlanFailure {
                    error,
                    part_index,
                    speech_started,
                });
            }
        }
        Ok(())
    }

    async fn play_part(
        &self,
        plan: &PreparedPlayback,
        part: &PreparedPart,
        job_id: u64,
        cancel: &CancellationToken,
        speech_progress: &AtomicBool,
    ) -> Result<(), AttemptError> {
        match part {
            PreparedPart::OutputTest => {
                ffmpeg::play_tts(
                    &self.ffmpeg_path,
                    output_test_stream(cancel),
                    &self.writer,
                    job_id,
                    ffmpeg::TtsPlayback {
                        speed: 1.0,
                        voice_volume: 1.0,
                        speech_progress,
                    },
                    cancel,
                )
                .await
                .map_err(|error| match error {
                    DecodeError::Cancelled => AttemptError::Cancelled,
                    other => AttemptError::Playback(safe_decode_error(other)),
                })?;
            }
            PreparedPart::Text(text) if !text.chars().any(char::is_alphanumeric) => {}
            PreparedPart::Text(text) => {
                let stream = plan
                    .provider
                    .as_ref()
                    .ok_or_else(|| AttemptError::Playback("播报计划缺少语音服务".into()))?
                    .stream(text, cancel)
                    .map_err(|error| match error {
                        TtsError::Cancelled => AttemptError::Cancelled,
                        other => AttemptError::Synthesis(other.to_string()),
                    })?;
                ffmpeg::play_tts(
                    &self.ffmpeg_path,
                    stream,
                    &self.writer,
                    job_id,
                    ffmpeg::TtsPlayback {
                        speed: plan.ffmpeg_speed,
                        voice_volume: plan.voice_volume,
                        speech_progress,
                    },
                    cancel,
                )
                .await
                .map_err(|error| match error {
                    DecodeError::Cancelled => AttemptError::Cancelled,
                    DecodeError::Tts(message) => AttemptError::Synthesis(message),
                    DecodeError::InvalidAudio(_)
                    | DecodeError::Misaligned
                    | DecodeError::Wav(_) => AttemptError::Synthesis(safe_decode_error(error)),
                    other => AttemptError::Playback(safe_decode_error(other)),
                })?;
            }
            PreparedPart::Sound(path) => {
                ffmpeg::play_sound(&self.ffmpeg_path, path, &self.writer, job_id, cancel)
                    .await
                    .map_err(|error| match error {
                        DecodeError::Cancelled => AttemptError::Cancelled,
                        other => AttemptError::Playback(safe_decode_error(other)),
                    })?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl JobExecutor for PlaybackExecutor {
    fn invalidate(&self, job_id: u64) {
        self.writer.deactivate_if(job_id);
    }

    async fn execute(
        &self,
        job: SpeechJob,
        cancel: CancellationToken,
    ) -> Result<JobOutcome, String> {
        let plan = job
            .prepared
            .as_ref()
            .ok_or("播放任务未准备服务连接和音效素材")?;
        if cancel.is_cancelled() {
            return Err("播放已取消".into());
        }
        let (selected, fallback_notice) = plan.select_for_execution(&cancel).await?;
        self.writer
            .activate_for(job.id, &cancel)
            .map_err(|_| "播放已取消".to_owned())?;
        let _guard = ActiveJobGuard {
            writer: self.writer.clone(),
            job_id: job.id,
        };
        match self.play_plan(selected, job.id, 0, &cancel).await {
            Ok(()) => {}
            Err(PlanFailure {
                error: AttemptError::Synthesis(error),
                part_index,
                speech_started: false,
            }) if plan.selected_from_binding
                && std::ptr::eq(selected, plan.as_ref())
                && !cancel.is_cancelled() =>
            {
                let (default, notice) = plan
                    .choose_default(FallbackCause::SynthesisBeforeAudio, &cancel)
                    .await
                    .map_err(|reason| {
                        if cancel.is_cancelled() {
                            "播放已取消".into()
                        } else {
                            format!("指定声音合成失败：{error}；{reason}")
                        }
                    })?;
                // Sound parts before the failed text have already drained;
                // do not replay them. No speech PCM from the first route
                // reached the output queue.
                self.writer
                    .activate_for(job.id, &cancel)
                    .map_err(|_| "播放已取消".to_owned())?;
                self.play_plan(default, job.id, part_index, &cancel)
                    .await
                    .map_err(|failure| with_route_notice(&notice, failure.error.message()))?;
                return Ok(JobOutcome {
                    detail: format!("{}；播报完成", notice.expect("fallback has notice")),
                });
            }
            Err(failure) => {
                let error = failure.error.message();
                if cancel.is_cancelled() {
                    return Err("播放已取消".into());
                }
                if plan.selected_from_binding
                    && std::ptr::eq(selected, plan.as_ref())
                    && failure.speech_started
                {
                    return Err(format!("{error}；已有语音进入输出队列，本条不重复播报"));
                }
                return Err(with_route_notice(&fallback_notice, error));
            }
        }
        Ok(JobOutcome {
            detail: fallback_notice
                .map(|notice| format!("{notice}；播报完成"))
                .unwrap_or_else(|| "播报完成".into()),
        })
    }
}

fn with_route_notice(notice: &Option<String>, error: String) -> String {
    if error == "播放已取消" {
        return error;
    }
    if let Some(notice) = notice {
        format!("{notice}；默认服务播放失败：{error}")
    } else {
        error
    }
}

fn output_test_stream(cancel: &CancellationToken) -> AudioStream {
    crate::tts::spawn_stream(
        crate::tts::AudioEncoding::PcmS16Le {
            sample_rate: 24_000,
            channels: 1,
        },
        cancel,
        |sender, cancel| async move {
            // 600 ms at 440 Hz, with 20 ms ramps to avoid clicks.
            let mut pcm = Vec::with_capacity(14_400 * 2);
            for i in 0..14_400 {
                let gain = (i.min(14_399 - i) as f32 / 480.0).min(1.0);
                let sample = ((i as f32 * 440.0 * std::f32::consts::TAU / 24_000.0).sin()
                    * 4000.0
                    * gain) as i16;
                pcm.extend_from_slice(&sample.to_le_bytes());
            }
            crate::tts::send_bytes(&sender, &cancel, &pcm).await;
            Ok(())
        },
    )
}

fn safe_io_error(stage: &str, error: std::io::Error) -> String {
    let reason = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "访问被拒绝，请检查文件权限或安全软件拦截记录",
        std::io::ErrorKind::NotFound => "文件或所需组件不存在",
        std::io::ErrorKind::BrokenPipe => "音频组件提前关闭了管道",
        std::io::ErrorKind::TimedOut => "操作超时",
        _ => "系统操作失败",
    };
    match error.raw_os_error() {
        Some(code) => format!("{stage}：{reason}（系统错误 {code}）"),
        None => format!("{stage}：{reason}"),
    }
}

fn safe_decode_error(error: DecodeError) -> String {
    let code = match &error {
        DecodeError::Cancelled | DecodeError::Output(crate::audio::AudioError::Cancelled) => {
            return "播放已取消".into();
        }
        DecodeError::MissingFfmpeg => "DV-C01",
        DecodeError::Start(_) => "DV-C02",
        DecodeError::Pipe(_) => "DV-C03",
        DecodeError::ProcessExit(_) | DecodeError::InvalidAudio(Some(_)) => "DV-C04",
        DecodeError::InvalidAudio(None) | DecodeError::Misaligned | DecodeError::Wav(_) => "DV-C05",
        DecodeError::MissingSound => "DV-C06",
        DecodeError::InvalidSpeed | DecodeError::InvalidVolume => "DV-C07",
        DecodeError::Output(error) => error.code(),
        DecodeError::Tts(_) => "DV-T000",
    };
    let message: String = match error {
        DecodeError::Cancelled => "播放已取消".into(),
        DecodeError::MissingFfmpeg => "找不到音频组件 ffmpeg.exe".into(),
        DecodeError::MissingSound => "音效素材文件不可用".into(),
        DecodeError::Tts(message) => message,
        DecodeError::InvalidAudio(Some(code)) | DecodeError::ProcessExit(Some(code)) => format!(
            "音频组件 FFmpeg 异常退出（退出码 {code} / 0x{:08X}）",
            code as u32
        ),
        DecodeError::ProcessExit(None) => "音频组件 FFmpeg 异常终止，无法取得退出码".into(),
        DecodeError::InvalidAudio(None) | DecodeError::Misaligned | DecodeError::Wav(_) => {
            "音频解码失败或文件不完整".into()
        }
        DecodeError::Start(error) => safe_io_error("音频组件 FFmpeg 无法启动", error),
        DecodeError::Pipe(error) => safe_io_error("音频组件管道中断", error),
        DecodeError::Output(crate::audio::AudioError::Disconnected) => {
            "输出设备已断开或驱动报告错误，请重新连接设备".into()
        }
        DecodeError::Output(crate::audio::AudioError::Stalled) => {
            "输出设备连续 5 秒未消耗音频，请重新连接或选择其他设备".into()
        }
        DecodeError::Output(crate::audio::AudioError::Cancelled) => "播放已取消".into(),
        DecodeError::Output(_) => "音频输出设备操作失败，请重新连接或选择其他设备".into(),
        DecodeError::InvalidSpeed | DecodeError::InvalidVolume => "语速或音量配置无效".into(),
    };
    crate::error_codes::tag(message, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playback_diagnostics_separate_device_decoder_and_pipe_without_raw_messages() {
        let start = safe_decode_error(DecodeError::Start(std::io::Error::from_raw_os_error(5)));
        assert!(start.contains("FFmpeg 无法启动") && start.contains("系统错误 5"));
        let pipe = safe_decode_error(DecodeError::Pipe(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "private-path-or-token",
        )));
        assert!(pipe.contains("管道中断"));
        assert!(!pipe.contains("private-path-or-token"));
        let exit = safe_decode_error(DecodeError::InvalidAudio(Some(0xC000001Du32 as i32)));
        assert!(exit.contains("0xC000001D"));
        assert!(
            safe_decode_error(DecodeError::Output(crate::audio::AudioError::Stalled))
                .contains("5 秒未消耗")
        );
        assert!(
            safe_decode_error(DecodeError::Output(crate::audio::AudioError::Disconnected))
                .contains("驱动报告错误")
        );
    }

    #[tokio::test]
    async fn output_test_uses_real_ffmpeg_without_voice_account_or_network() {
        let Some(path) = std::env::var_os("DANMAKUVOICE_TEST_FFMPEG") else {
            return;
        };
        let (preview, prepared) = PreparedPlayback::output_test();
        assert!(preview.voice.is_none());
        assert!(!preview.needs_tts());
        assert!(preview.has_playable_audio());
        let writer = crate::audio::test_writer(48_000, 2, 100_000);
        let executor = PlaybackExecutor::new(writer.clone(), path).unwrap();
        let job = SpeechJob {
            id: 1,
            generation: 0,
            origin: crate::scheduler::JobOrigin::Audition,
            preview,
            prepared: Some(prepared),
        };
        let mut task =
            tokio::spawn(async move { executor.execute(job, CancellationToken::new()).await });
        let mut samples = Vec::new();
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                tokio::select! {
                    result = &mut task => break result.unwrap().unwrap(),
                    _ = tokio::time::sleep(Duration::from_millis(5)) => samples.extend(writer.take_test_samples()),
                }
            }
        }).await.unwrap();
        assert!(outcome.detail.contains("播报完成"));
        assert!(samples.len() >= 50_000);
        assert!(samples.iter().any(|value| value.abs() > 0.05));
        assert!(
            samples
                .iter()
                .all(|value| value.is_finite() && value.abs() < 0.2)
        );
    }

    use crate::{
        audio::test_writer,
        model::{LiveEvent, Provider, SovitsVoiceSettings, VoiceBinding},
        rules::{RuleSet, SoundRule},
        scheduler::{self, JobOrigin, JobState, SchedulerHandle},
        storage::{DotsPlaybackSettings, ServiceConnection},
        tts::test_http,
        voice_library::{ReferenceProfile, ReferenceRole},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::AsyncWriteExt,
        net::TcpListener,
        sync::oneshot,
        time::{Duration, sleep, timeout},
    };

    fn ffmpeg_for_test() -> Option<PathBuf> {
        std::env::var_os("DANMAKUVOICE_TEST_FFMPEG")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    }

    fn local_dots_plan(
        store: &mut DataStore,
        endpoint: String,
    ) -> (RulePreview, Arc<PreparedPlayback>) {
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "本地 dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint,
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let preset = VoicePreset {
            id: "voice".into(),
            name: "本地测试".into(),
            connection_id: "dots".into(),
            provider: Provider::Dots,
            voice_id: "ref.wav".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        store.save_preset(&preset).unwrap();
        let mut rules = RuleSet {
            default_preset_id: Some("voice".into()),
            ..Default::default()
        };
        rules.templates.danmaku = "{message}".into();
        let preview = rules
            .preview(
                &LiveEvent::danmaku(1, Some(1), "用户", "本地测试语音"),
                &[preset],
                &[],
            )
            .unwrap();
        let plan = PreparedPlayback::from_store(store, &preview, None).unwrap();
        (preview, plan)
    }

    fn bound_dots_plan(
        store: &mut DataStore,
        target_endpoint: String,
        default_endpoint: String,
    ) -> (RulePreview, Arc<PreparedPlayback>) {
        for (id, endpoint) in [("bound", target_endpoint), ("default", default_endpoint)] {
            store
                .save_connection(&ServiceConnection {
                    id: id.into(),
                    name: id.into(),
                    settings: ConnectionSettings::Dots {
                        endpoint,
                        timeout_secs: 30,
                    },
                    has_credential: false,
                })
                .unwrap();
            store
                .save_preset(&VoicePreset {
                    id: id.into(),
                    name: id.into(),
                    connection_id: id.into(),
                    provider: Provider::Dots,
                    voice_id: format!("{id}-ref.wav"),
                    speed: 1.0,
                    volume: 1.0,
                    sovits: None,
                })
                .unwrap();
        }
        let mut rules = RuleSet {
            default_preset_id: Some("default".into()),
            ..Default::default()
        };
        rules.templates.danmaku = "{message}".into();
        store.save_rules(&rules).unwrap();
        let binding = VoiceBinding {
            platform: "bilibili".into(),
            user_id: Some(5),
            user_name: None,
            legacy_user_name: None,
            preset_id: "bound".into(),
            enabled: true,
        };
        store.save_binding("binding", &binding).unwrap();
        let preview = rules
            .preview(
                &LiveEvent::danmaku(1, Some(5), "观众", "离线回退测试"),
                &store.presets().unwrap(),
                &[binding],
            )
            .unwrap();
        assert!(preview.voice_from_binding);
        let plan = PreparedPlayback::from_store(store, &preview, None).unwrap();
        (preview, plan)
    }

    #[tokio::test]
    async fn gpt_bound_voice_and_direct_voice_send_identical_requests_without_fallback() {
        for atomic in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let mut bodies = Vec::new();
                while bodies.len() < 2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request = test_http::read_request(&mut socket).await;
                    if request.starts_with(b"GET /kinoko/status ") {
                        test_http::json_response(&mut socket, if atomic { "200 OK" } else { "404 Not Found" },
                            if atomic { r#"{"protocol":1,"atomic_model_selection":true,"resident_model_reuse":true}"# } else { "{}" }).await;
                    } else if request.starts_with(b"GET /openapi.json ") {
                        test_http::json_response(&mut socket, "200 OK",
                            r#"{"paths":{"/tts":{"post":{}},"/set_gpt_weights":{"get":{}},"/set_sovits_weights":{"get":{}}}}"#).await;
                    } else {
                        assert!(request.starts_with(if atomic {
                            b"POST /kinoko/tts "
                        } else {
                            b"POST /tts "
                        }));
                        let separator = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .unwrap();
                        bodies.push(
                            serde_json::from_slice::<serde_json::Value>(&request[separator + 4..])
                                .unwrap(),
                        );
                        // A valid WAV fixture, consumed in memory without audio output.
                        let wav = one_second_wav();
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",
                            wav.len()
                        );
                        socket.write_all(header.as_bytes()).await.unwrap();
                        socket.write_all(&wav).await.unwrap();
                    }
                }
                bodies
            });
            let default_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let temp = tempfile::tempdir().unwrap();
            let mut store = DataStore::open(temp.path()).unwrap();
            let (mut preview, _) = bound_dots_plan(
                &mut store,
                endpoint.clone(),
                format!("http://{}", default_listener.local_addr().unwrap()),
            );
            // Rebuild from the persisted GPT voice, exactly as the GUI audition
            // and live binding do. Both retain the same reference and model pair.
            // Changing provider of a referenced connection is forbidden; use
            // a separate GPT connection and update the existing voice instead.
            store
                .save_connection(&ServiceConnection {
                    id: "gpt".into(),
                    name: "GPT".into(),
                    settings: ConnectionSettings::GptSovits {
                        endpoint,
                        timeout_secs: 30,
                    },
                    has_credential: false,
                })
                .unwrap();
            let voice = preview.voice.as_mut().unwrap();
            voice.provider = Provider::GptSovits;
            voice.connection_id = "gpt".into();
            voice.sovits = Some(crate::model::SovitsVoiceSettings {
                model_selection: if atomic {
                    PresetModelSelection::PerRequestAtomic
                } else {
                    PresetModelSelection::GlobalResident
                },
                gpt_weights_path: Some("model.ckpt".into()),
                sovits_weights_path: Some("model.pth".into()),
                reference_text_free: true,
                ..Default::default()
            });
            store.save_preset(voice).unwrap();
            let direct = RulePreview::voice_audition(voice.clone(), &preview.final_text).unwrap();
            let cancel = CancellationToken::new();
            for preview in [&direct, &preview] {
                let plan = PreparedPlayback::from_store(&store, preview, None).unwrap();
                let (selected, notice) = plan.select_for_execution(&cancel).await.unwrap();
                assert!(std::ptr::eq(selected, plan.as_ref()));
                assert!(notice.is_none());
                let mut stream = selected
                    .provider
                    .as_ref()
                    .unwrap()
                    .stream(&preview.final_text, &cancel)
                    .unwrap();
                let mut bytes = 0;
                while let Some(chunk) = stream.recv().await {
                    bytes += chunk.unwrap().len();
                }
                assert!(bytes > 44);
            }
            let bodies = server.await.unwrap();
            assert_eq!(bodies[0], bodies[1]);
            assert!(
                timeout(Duration::from_millis(50), default_listener.accept())
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn offline_bound_gpt_voice_uses_ready_gpt_default_with_visible_notice() {
        let offline = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", offline.local_addr().unwrap());
        drop(offline);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for expected in ["GET /kinoko/status ", "GET /openapi.json ", "POST /tts "] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                assert!(request.starts_with(expected.as_bytes()));
                if expected.contains("kinoko/status") {
                    test_http::json_response(&mut socket, "404 Not Found", "{}").await;
                } else if expected.contains("openapi") {
                    test_http::json_response(&mut socket, "200 OK", r#"{"paths":{"/tts":{"post":{}},"/set_gpt_weights":{"get":{}},"/set_sovits_weights":{"get":{}}}}"#).await;
                } else {
                    let wav = one_second_wav();
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",
                        wav.len()
                    );
                    socket.write_all(header.as_bytes()).await.unwrap();
                    socket.write_all(&wav).await.unwrap();
                }
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (mut preview, _) =
            bound_dots_plan(&mut store, target_endpoint.clone(), endpoint.clone());
        for (id, endpoint, voice) in [
            (
                "gpt-target",
                target_endpoint,
                preview.voice.as_mut().unwrap(),
            ),
            (
                "gpt-default",
                endpoint,
                preview.default_voice.as_mut().unwrap(),
            ),
        ] {
            store
                .save_connection(&ServiceConnection {
                    id: id.into(),
                    name: id.into(),
                    has_credential: false,
                    settings: ConnectionSettings::GptSovits {
                        endpoint,
                        timeout_secs: 30,
                    },
                })
                .unwrap();
            voice.connection_id = id.into();
            voice.provider = Provider::GptSovits;
            store.save_preset(voice).unwrap();
        }
        let plan = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        let cancel = CancellationToken::new();
        let (selected, notice) = plan.select_for_execution(&cancel).await.unwrap();
        assert!(std::ptr::eq(selected, plan.fallback.as_deref().unwrap()));
        assert!(notice.unwrap().contains("本条临时使用默认 GPT-SoVITS"));
        let mut stream = selected
            .provider
            .as_ref()
            .unwrap()
            .stream(&preview.final_text, &cancel)
            .unwrap();
        let mut bytes = 0;
        while let Some(chunk) = stream.recv().await {
            bytes += chunk.unwrap().len();
        }
        assert!(bytes > 44);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn imported_dots_options_reach_the_queued_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, _) = local_dots_plan(&mut store, endpoint);
        store
            .save_dots_playback_settings(
                "voice",
                &DotsPlaybackSettings {
                    prompt_text: "准确的参考文本".into(),
                    language: "zh".into(),
                    num_steps: Some(32),
                    normalize_text: false,
                },
            )
            .unwrap();
        let plan = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        let Some(PreparedProvider::Dots(client)) = plan.provider.as_ref() else {
            panic!("expected dots.tts client");
        };
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = test_http::read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
            request
        });
        assert!(
            client
                .synthesize_wav("测试", &CancellationToken::new())
                .await
                .is_err()
        );
        let request = server.await.unwrap();
        let body_start = request
            .windows(4)
            .position(|chunk| chunk == b"\r\n\r\n")
            .unwrap()
            + 4;
        let body: serde_json::Value = serde_json::from_slice(&request[body_start..]).unwrap();
        assert_eq!(body["voice"], "ref.wav");
        assert_eq!(body["prompt_text"], "准确的参考文本");
        assert_eq!(body["language"], "zh");
        assert_eq!(body["num_steps"], 32);
        assert_eq!(body["normalize_text"], false);
    }

    fn one_second_wav() -> Vec<u8> {
        let frames = 24_000u32;
        let mut wav = Vec::with_capacity(44 + frames as usize * 2);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + frames * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(frames * 2).to_le_bytes());
        for index in 0..frames {
            let sample = if (index / 120) % 2 == 0 {
                1200i16
            } else {
                -1200i16
            };
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }

    fn preview_for(preset: &VoicePreset) -> RulePreview {
        let mut rules = RuleSet {
            default_preset_id: Some(preset.id.clone()),
            ..Default::default()
        };
        rules.templates.danmaku = "{message}".into();
        rules
            .preview(
                &LiveEvent::danmaku(1, Some(1), "用户", "测试参考音频"),
                std::slice::from_ref(preset),
                &[],
            )
            .unwrap()
    }

    #[tokio::test]
    async fn dots_reference_uses_original_path_and_rejects_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("original.wav");
        std::fs::write(&source, one_second_wav()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let mut store = DataStore::open(temp.path().join("app")).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint,
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let audio_path = source.to_string_lossy().into_owned();
        let preset = VoicePreset {
            id: "role-a".into(),
            name: "角色 A".into(),
            connection_id: "dots".into(),
            provider: Provider::Dots,
            voice_id: "角色 A".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        store
            .save_reference_profile(&ReferenceProfile {
                connection_id: "dots".into(),
                role: ReferenceRole::Dots {
                    role: preset.voice_id.clone(),
                },
                audio_path: audio_path.clone(),
                reference_text: "这段声音的原文".into(),
                reference_language: String::new(),
                text_language: String::new(),
                text_free: false,
            })
            .unwrap();
        let preview = preview_for(&preset);
        let plan = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        let expected_path = audio_path;
        let server = tokio::spawn(async move {
            let (mut capability_socket, _) = listener.accept().await.unwrap();
            let capability = test_http::read_request(&mut capability_socket).await;
            assert!(capability.starts_with(b"GET /danmakuvoice/capabilities HTTP/1.1"));
            test_http::json_response(
                &mut capability_socket,
                "200 OK",
                r#"{"protocol":"danmakuvoice-dots-paths-v1","arbitrary_voice_paths":true,"reference_text_explicit":true}"#,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let raw = test_http::read_request(&mut socket).await;
            assert!(raw.starts_with(b"POST /tts/stream HTTP/1.1"));
            let body_start = raw
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4;
            let body: serde_json::Value = serde_json::from_slice(&raw[body_start..]).unwrap();
            assert_eq!(body["voice"], expected_path);
            assert_eq!(body["prompt_text"], "这段声音的原文");
            test_http::chunked_start(&mut socket, "audio/wav").await;
            test_http::chunk(&mut socket, &one_second_wav()).await;
            test_http::chunked_end(&mut socket).await;
        });
        let cancellation = CancellationToken::new();
        let mut stream = plan
            .provider
            .as_ref()
            .unwrap()
            .stream("测试", &cancellation)
            .unwrap();
        while let Some(packet) = stream.recv().await {
            packet.unwrap();
        }
        server.await.unwrap();
        std::fs::remove_file(source).unwrap();
        assert!(matches!(
            PreparedPlayback::from_store(&store, &preview, None),
            Err(PrepareError::MissingReferenceAudio)
        ));
    }

    #[tokio::test]
    async fn gpt_pair_restores_original_path_and_rejects_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("original.wav");
        std::fs::write(&source, one_second_wav()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let mut store = DataStore::open(temp.path().join("app")).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "gpt".into(),
                name: "GPT".into(),
                settings: ConnectionSettings::GptSovits {
                    endpoint,
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let audio_path = source.to_string_lossy().into_owned();
        let role = ReferenceRole::GptSovits {
            gpt_weights_path: "C:/Models/A.ckpt".into(),
            sovits_weights_path: "C:/Models/A.pth".into(),
        };
        store
            .save_reference_profile(&ReferenceProfile {
                connection_id: "gpt".into(),
                role: role.clone(),
                audio_path: audio_path.clone(),
                reference_text: "English reference".into(),
                reference_language: "en".into(),
                text_language: "auto".into(),
                text_free: false,
            })
            .unwrap();
        let settings = SovitsVoiceSettings {
            gpt_weights_path: Some("C:/Models/A.ckpt".into()),
            sovits_weights_path: Some("C:/Models/A.pth".into()),
            ..Default::default()
        };
        let preset = VoicePreset {
            id: "role-a".into(),
            name: "角色 A".into(),
            connection_id: "gpt".into(),
            provider: Provider::GptSovits,
            voice_id: "old/original.wav".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: Some(settings),
        };
        let preview = preview_for(&preset);
        let plan = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        let expected_path = audio_path;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let raw = test_http::read_request(&mut socket).await;
            assert!(raw.starts_with(b"POST /tts HTTP/1.1"));
            let body_start = raw
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4;
            let body: serde_json::Value = serde_json::from_slice(&raw[body_start..]).unwrap();
            assert_eq!(body["ref_audio_path"], expected_path);
            assert_eq!(body["prompt_text"], "English reference");
            assert_eq!(body["prompt_lang"], "en");
            assert_eq!(body["text_lang"], "auto");
            test_http::chunked_start(&mut socket, "audio/wav").await;
            test_http::chunk(&mut socket, &one_second_wav()).await;
            test_http::chunked_end(&mut socket).await;
        });
        let cancellation = CancellationToken::new();
        let mut stream = plan
            .provider
            .as_ref()
            .unwrap()
            .stream("测试", &cancellation)
            .unwrap();
        while let Some(packet) = stream.recv().await {
            packet.unwrap();
        }
        server.await.unwrap();
        std::fs::remove_file(source).unwrap();
        assert!(matches!(
            PreparedPlayback::from_store(&store, &preview, None),
            Err(PrepareError::MissingReferenceAudio)
        ));
    }

    async fn wait_for_record(handle: &SchedulerHandle, job_id: u64, expected: JobState) {
        timeout(Duration::from_secs(10), async {
            loop {
                let state = handle.state().borrow().clone();
                if let Some(record) = state.history.iter().find(|record| record.id == job_id) {
                    assert_eq!(record.state, expected, "{}", record.detail);
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn offline_dots_job_streams_through_ffmpeg_and_completes() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = test_http::read_request(&mut socket).await;
            assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
            let body = String::from_utf8(request).unwrap();
            assert!(body.contains("ref.wav"));
            test_http::chunked_start(&mut socket, "audio/wav").await;
            test_http::chunk(&mut socket, &one_second_wav()).await;
            test_http::chunked_end(&mut socket).await;
        });
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = local_dots_plan(&mut store, endpoint);
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let consumer_stop = CancellationToken::new();
        let consumer_token = consumer_stop.clone();
        let consumer_writer = writer.clone();
        let nonzero = Arc::new(AtomicUsize::new(0));
        let counter = nonzero.clone();
        let consumer = tokio::spawn(async move {
            while !consumer_token.is_cancelled() {
                let output = consumer_writer.render_test_frames(480);
                counter.fetch_add(
                    output.iter().filter(|sample| sample.abs() > 0.001).count(),
                    Ordering::Relaxed,
                );
                sleep(Duration::from_millis(10)).await;
            }
        });
        let id = handle
            .submit_prepared(preview, JobOrigin::Audition, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Played).await;
        consumer_stop.cancel();
        consumer.await.unwrap();
        assert!(
            nonzero.load(Ordering::Relaxed) > 20_000,
            "no decoded PCM reached AudioWriter"
        );
        assert!(
            writer
                .render_test_frames(480)
                .iter()
                .all(|sample| *sample == 0.0)
        );
        server.await.unwrap();
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn clip_only_message_plays_without_a_tts_connection() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.wav");
        std::fs::write(&source, one_second_wav()).unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let asset = store.import_asset(&source, "提示音").unwrap();
        let rules = RuleSet {
            templates: crate::rules::EventTemplates {
                danmaku: "\"{message}\"".into(),
                ..Default::default()
            },
            sounds: vec![SoundRule {
                trigger: "咕".into(),
                asset_id: asset.id,
            }],
            ..Default::default()
        };
        let preview = rules
            .preview(&LiveEvent::danmaku(1, None, "用户", "咕"), &[], &[])
            .unwrap();
        assert!(preview.voice.is_none());
        assert!(!preview.needs_tts());
        assert!(preview.has_playable_audio());
        let plan = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        assert!(plan.provider.is_none());

        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let stop = CancellationToken::new();
        let consumer_stop = stop.clone();
        let consumer_writer = writer.clone();
        let nonzero = Arc::new(AtomicUsize::new(0));
        let count = nonzero.clone();
        let consumer = tokio::spawn(async move {
            while !consumer_stop.is_cancelled() {
                let samples = consumer_writer.render_test_frames(480);
                count.fetch_add(
                    samples.iter().filter(|sample| sample.abs() > 0.001).count(),
                    Ordering::Relaxed,
                );
                sleep(Duration::from_millis(10)).await;
            }
        });
        let id = handle
            .submit_prepared(preview, JobOrigin::Audition, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Played).await;
        stop.cancel();
        consumer.await.unwrap();
        assert!(nonzero.load(Ordering::Relaxed) > 20_000);
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn skip_immediately_mutes_a_live_ffmpeg_stream() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            test_http::read_request(&mut socket).await;
            test_http::chunked_start(&mut socket, "audio/wav").await;
            let wav = one_second_wav();
            test_http::chunk(&mut socket, &wav[..44 + 24_000]).await;
            let _ = release_rx.await;
            drop(socket);
        });
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = local_dots_plan(&mut store, endpoint);
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let id = handle
            .submit_prepared(preview, JobOrigin::Audition, plan)
            .await
            .unwrap();
        timeout(Duration::from_secs(5), async {
            loop {
                let rendered = writer.render_test_frames(480);
                if rendered.iter().any(|sample| sample.abs() > 0.001) {
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("no partial PCM before source completed");
        handle.skip_current().await.unwrap();
        wait_for_record(&handle, id, JobState::Skipped).await;
        for _ in 0..3 {
            assert!(
                writer
                    .render_test_frames(480)
                    .iter()
                    .all(|sample| *sample == 0.0),
                "skipped audio leaked into output"
            );
        }
        let _ = release_tx.send(());
        server.await.unwrap();
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn offline_bound_service_uses_frozen_default_once_and_records_route() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let offline = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", offline.local_addr().unwrap());
        drop(offline);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for request_index in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if request_index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    assert!(String::from_utf8_lossy(&request).contains("default-ref.wav"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    test_http::chunk(&mut socket, &one_second_wav()).await;
                    test_http::chunked_end(&mut socket).await;
                }
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        // The queued plan must keep the original default even after an edit.
        store
            .save_connection(&ServiceConnection {
                id: "default".into(),
                name: "changed after enqueue".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9".into(),
                    timeout_secs: 5,
                },
                has_credential: false,
            })
            .unwrap();
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let stop = CancellationToken::new();
        let consumer_stop = stop.clone();
        let consumer_writer = writer.clone();
        let consumer = tokio::spawn(async move {
            while !consumer_stop.is_cancelled() {
                consumer_writer.render_test_frames(480);
                sleep(Duration::from_millis(10)).await;
            }
        });
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Played).await;
        stop.cancel();
        consumer.await.unwrap();
        timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        let record = handle
            .state()
            .borrow()
            .history
            .iter()
            .find(|record| record.id == id)
            .unwrap()
            .detail
            .clone();
        assert!(record.contains("指定的 dots.tts 不可用"));
        assert!(record.contains("临时使用默认 dots.tts"));
        assert!(record.contains("播报完成"));
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn bound_and_default_offline_fail_before_synthesis() {
        let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}", first.local_addr().unwrap());
        drop(first);
        let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default = format!("http://{}", second.local_addr().unwrap());
        drop(second);
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (_, plan) = bound_dots_plan(&mut store, target, default);
        let error = plan
            .select_for_execution(&CancellationToken::new())
            .await
            .err()
            .unwrap();
        assert!(error.contains("主选 dots.tts 也不可用"));
        assert!(error.contains("未发起主选合成"));
    }

    #[tokio::test]
    async fn offline_local_binding_selects_prepared_fish_or_doubao_default() {
        for cloud_provider in [Provider::FishAudio, Provider::Doubao] {
            let offline = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let target = format!("http://{}", offline.local_addr().unwrap());
            drop(offline);
            let temp = tempfile::tempdir().unwrap();
            let mut store = DataStore::open(temp.path()).unwrap();
            let (mut preview, _) = bound_dots_plan(&mut store, target, "http://127.0.0.1:9".into());
            store
                .save_connection(&ServiceConnection {
                    id: "cloud".into(),
                    name: "cloud".into(),
                    settings: match cloud_provider {
                        Provider::FishAudio => ConnectionSettings::FishAudio { timeout_secs: 5 },
                        Provider::Doubao => ConnectionSettings::Doubao { timeout_secs: 5 },
                        _ => unreachable!(),
                    },
                    has_credential: false,
                })
                .unwrap();
            let credential: &[u8] = match cloud_provider {
                Provider::FishAudio => b"sk-offline-fixture-key-1234567890",
                Provider::Doubao => b"sessionid=offline-fixture",
                _ => unreachable!(),
            };
            store
                .set_connection_credential("cloud", credential)
                .unwrap();
            let default = preview.default_voice.as_mut().unwrap();
            default.provider = cloud_provider;
            default.connection_id = "cloud".into();
            default.voice_id = match cloud_provider {
                Provider::FishAudio => crate::tts::fish::DEFAULT_VOICE_ID.into(),
                Provider::Doubao => crate::tts::dobao::DEFAULT_VOICE_ID.into(),
                _ => unreachable!(),
            };
            let device = DoubaoDevice::generate();
            let plan = PreparedPlayback::from_store(&store, &preview, Some(&device)).unwrap();
            let (selected, notice) = plan
                .select_for_execution(&CancellationToken::new())
                .await
                .unwrap();
            assert!(matches!(
                selected.provider.as_ref().unwrap(),
                PreparedProvider::FishAudio(_) | PreparedProvider::Doubao(_)
            ));
            assert!(notice.unwrap().contains("临时使用默认"));
        }
    }

    #[tokio::test]
    async fn unconfigured_fish_or_doubao_binding_uses_ready_local_default() {
        for cloud_provider in [Provider::FishAudio, Provider::Doubao] {
            let default = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let default_endpoint = format!("http://{}", default.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = default.accept().await.unwrap();
                assert!(
                    test_http::read_request(&mut socket)
                        .await
                        .starts_with(b"GET /health HTTP/1.1")
                );
                test_http::json_response(
                &mut socket,
                "200 OK",
                r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
            )
            .await;
            });
            let temp = tempfile::tempdir().unwrap();
            let mut store = DataStore::open(temp.path()).unwrap();
            let (mut preview, _) =
                bound_dots_plan(&mut store, "http://127.0.0.1:9".into(), default_endpoint);
            store
                .save_connection(&ServiceConnection {
                    id: "cloud-target".into(),
                    name: "cloud-target".into(),
                    settings: match cloud_provider {
                        Provider::FishAudio => ConnectionSettings::FishAudio { timeout_secs: 5 },
                        Provider::Doubao => ConnectionSettings::Doubao { timeout_secs: 5 },
                        _ => unreachable!(),
                    },
                    has_credential: false,
                })
                .unwrap();
            let target = preview.voice.as_mut().unwrap();
            target.provider = cloud_provider;
            target.connection_id = "cloud-target".into();
            target.voice_id = match cloud_provider {
                Provider::FishAudio => crate::tts::fish::DEFAULT_VOICE_ID.into(),
                Provider::Doubao => crate::tts::dobao::DEFAULT_VOICE_ID.into(),
                _ => unreachable!(),
            };
            let device = DoubaoDevice::generate();
            let plan = PreparedPlayback::from_store(&store, &preview, Some(&device)).unwrap();
            assert!(plan.provider.is_none());
            assert_eq!(plan.selected_issue, Some("指定服务缺少登录信息"));
            let (selected, notice) = plan
                .select_for_execution(&CancellationToken::new())
                .await
                .unwrap();
            assert!(matches!(
                selected.provider.as_ref(),
                Some(PreparedProvider::Dots(_))
            ));
            assert!(notice.unwrap().contains("不可用"));
            server.await.unwrap();
        }
    }

    #[test]
    fn cancellation_does_not_gain_fallback_notice() {
        assert_eq!(
            with_route_notice(&Some("临时使用默认".into()), "播放已取消".into()),
            "播放已取消"
        );
    }

    #[tokio::test]
    async fn uncertain_bound_status_keeps_target_before_synthesis() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = target.accept().await.unwrap();
            assert!(
                test_http::read_request(&mut socket)
                    .await
                    .starts_with(b"GET /health HTTP/1.1")
            );
            test_http::json_response(&mut socket, "500 Internal Server Error", "{}").await;
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (_, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let (selected, notice) = plan
            .select_for_execution(&CancellationToken::new())
            .await
            .unwrap();
        assert!(std::ptr::eq(selected, plan.as_ref()));
        assert!(notice.is_none());
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), fallback.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancelling_bound_preflight_never_contacts_default() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let (seen_tx, seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut socket, _) = target.accept().await.unwrap();
            assert!(
                test_http::read_request(&mut socket)
                    .await
                    .starts_with(b"GET /health HTTP/1.1")
            );
            let _ = seen_tx.send(());
            let _ = release_rx.await;
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (_, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task =
            tokio::spawn(async move { plan.select_for_execution(&task_cancel).await.map(|_| ()) });
        timeout(Duration::from_secs(2), seen_rx)
            .await
            .unwrap()
            .unwrap();
        cancel.cancel();
        let error = timeout(Duration::from_millis(300), task)
            .await
            .expect("preflight ignored cancellation")
            .unwrap()
            .unwrap_err();
        assert!(error.contains("取消"));
        let _ = release_tx.send(());
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), fallback.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancelling_started_synthesis_never_contacts_default() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let (seen_tx, seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut seen_tx = Some(seen_tx);
            let mut release_rx = Some(release_rx);
            for index in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    let _ = seen_tx.take().unwrap().send(());
                    let _ = release_rx.take().unwrap().await;
                }
            }
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let executor = PlaybackExecutor::new(test_writer(48_000, 1, 96_000), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        timeout(Duration::from_secs(2), seen_rx)
            .await
            .unwrap()
            .unwrap();
        handle.skip_current().await.unwrap();
        wait_for_record(&handle, id, JobState::Skipped).await;
        let _ = release_tx.send(());
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), fallback.accept())
                .await
                .is_err()
        );
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn failed_target_synthesis_before_pcm_uses_default_once() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::json_response(&mut socket, "503 Service Unavailable", "{}").await;
                }
            }
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let default_server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = fallback.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    test_http::chunk(&mut socket, &one_second_wav()).await;
                    test_http::chunked_end(&mut socket).await;
                }
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let stop = CancellationToken::new();
        let consumer_stop = stop.clone();
        let consumer = tokio::spawn(async move {
            while !consumer_stop.is_cancelled() {
                writer.render_test_frames(480);
                sleep(Duration::from_millis(10)).await;
            }
        });
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Played).await;
        stop.cancel();
        consumer.await.unwrap();
        server.await.unwrap();
        default_server.await.unwrap();
        let detail = handle
            .state()
            .borrow()
            .history
            .iter()
            .find(|record| record.id == id)
            .unwrap()
            .detail
            .clone();
        assert!(detail.contains("合成失败（尚未播放语音）"));
        assert!(detail.contains("临时使用默认 dots.tts"));
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn sound_before_failed_bound_voice_uses_default_without_replaying_sound() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let target_server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::json_response(&mut socket, "503 Service Unavailable", "{}").await;
                }
            }
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let default_server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = fallback.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    test_http::chunk(&mut socket, &one_second_wav()).await;
                    test_http::chunked_end(&mut socket).await;
                }
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sound.wav");
        std::fs::write(&source, one_second_wav()).unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let (mut preview, _) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let asset = store.import_asset(&source, "关键词音效").unwrap();
        preview.parts.insert(
            0,
            PlanPart::Sound {
                trigger: "叮".into(),
                asset_id: asset.id,
            },
        );
        let plan = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let stop = CancellationToken::new();
        let consumer_stop = stop.clone();
        let played_frames = Arc::new(AtomicUsize::new(0));
        let counter = played_frames.clone();
        let consumer = tokio::spawn(async move {
            while !consumer_stop.is_cancelled() {
                let samples = writer.render_test_frames(480);
                counter.fetch_add(
                    samples.iter().filter(|sample| **sample != 0.0).count(),
                    Ordering::Relaxed,
                );
                sleep(Duration::from_millis(5)).await;
            }
        });
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Played).await;
        stop.cancel();
        consumer.await.unwrap();
        target_server.await.unwrap();
        default_server.await.unwrap();
        let frames = played_frames.load(Ordering::Relaxed);
        assert!(
            (80_000..120_000).contains(&frames),
            "played {frames} frames"
        );
        let detail = handle
            .state()
            .borrow()
            .history
            .iter()
            .find(|record| record.id == id)
            .unwrap()
            .detail
            .clone();
        assert!(detail.contains("临时使用默认 dots.tts"));
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn empty_source_audio_before_pcm_uses_default() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    test_http::chunk(&mut socket, &one_second_wav()[..44]).await;
                    test_http::chunked_end(&mut socket).await;
                }
            }
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let default_server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = fallback.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    test_http::chunk(&mut socket, &one_second_wav()).await;
                    test_http::chunked_end(&mut socket).await;
                }
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let stop = CancellationToken::new();
        let consumer_stop = stop.clone();
        let consumer = tokio::spawn(async move {
            while !consumer_stop.is_cancelled() {
                writer.render_test_frames(480);
                sleep(Duration::from_millis(10)).await;
            }
        });
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Played).await;
        stop.cancel();
        consumer.await.unwrap();
        server.await.unwrap();
        default_server.await.unwrap();
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn partial_pcm_from_bound_service_is_never_replayed_at_default() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut release_rx = Some(release_rx);
            for index in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    let wav = one_second_wav();
                    test_http::chunk(&mut socket, &wav[..44 + 24_000]).await;
                    let _ = release_rx.take().unwrap().await;
                    // No terminating chunk: the source fails after PCM entered
                    // the output queue, even if the callback has drained it.
                }
            }
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let writer = test_writer(48_000, 1, 96_000);
        let executor = PlaybackExecutor::new(writer.clone(), ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        timeout(Duration::from_secs(5), async {
            while !writer.has_queued_audio(id) {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("source did not enqueue partial PCM");
        let _ = release_tx.send(());
        wait_for_record(&handle, id, JobState::Failed).await;
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), fallback.accept())
                .await
                .is_err()
        );
        let detail = handle
            .state()
            .borrow()
            .history
            .iter()
            .find(|record| record.id == id)
            .unwrap()
            .detail
            .clone();
        assert!(detail.contains("已有语音进入输出队列"));
        handle.stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn output_device_failure_does_not_retry_at_default() {
        let Some(ffmpeg_path) = ffmpeg_for_test() else {
            return;
        };
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_endpoint = format!("http://{}", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                let request = test_http::read_request(&mut socket).await;
                if index == 0 {
                    assert!(request.starts_with(b"GET /health HTTP/1.1"));
                    test_http::json_response(
                        &mut socket,
                        "200 OK",
                        r#"{"status":"ok","ready":true,"needs_restart":false,"model_loaded":true,"stream_requests":0}"#,
                    )
                    .await;
                } else {
                    assert!(request.starts_with(b"POST /tts/stream HTTP/1.1"));
                    test_http::chunked_start(&mut socket, "audio/wav").await;
                    test_http::chunk(&mut socket, &one_second_wav()).await;
                    test_http::chunked_end(&mut socket).await;
                }
            }
        });
        let fallback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let default_endpoint = format!("http://{}", fallback.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let (preview, plan) = bound_dots_plan(&mut store, target_endpoint, default_endpoint);
        let writer = test_writer(48_000, 1, 96_000);
        writer.disconnect_test_device();
        let executor = PlaybackExecutor::new(writer, ffmpeg_path).unwrap();
        let handle = scheduler::spawn(Arc::new(executor));
        handle.start().await.unwrap();
        let id = handle
            .submit_prepared(preview, JobOrigin::Live, plan)
            .await
            .unwrap();
        wait_for_record(&handle, id, JobState::Failed).await;
        server.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), fallback.accept())
                .await
                .is_err()
        );
        handle.stop_all().await.unwrap();
    }

    #[test]
    fn preparation_freezes_managed_sound_path_and_text() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "本地 dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9880".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let preset = VoicePreset {
            id: "voice".into(),
            name: "测试".into(),
            connection_id: "dots".into(),
            provider: Provider::Dots,
            voice_id: "ref.wav".into(),
            speed: 1.25,
            volume: 0.8,
            sovits: None,
        };
        store.save_preset(&preset).unwrap();
        let first_source = temp.path().join("first.wav");
        std::fs::write(&first_source, b"first managed sound").unwrap();
        let asset = store.import_asset(&first_source, "提示").unwrap();
        let rules = RuleSet {
            default_preset_id: Some("voice".into()),
            sounds: vec![SoundRule {
                trigger: "叮".into(),
                asset_id: asset.id.clone(),
            }],
            ..Default::default()
        };
        let mut preview = rules
            .preview(
                &LiveEvent::danmaku(1, Some(1), "用户", "前叮后"),
                &[preset],
                &[],
            )
            .unwrap();
        let prepared = PreparedPlayback::from_store(&store, &preview, None).unwrap();
        let original_path = prepared
            .parts
            .iter()
            .find_map(|part| match part {
                PreparedPart::Sound(path) => Some(path.clone()),
                PreparedPart::Text(_) | PreparedPart::OutputTest => None,
            })
            .expect("expected sound part");
        let second_source = temp.path().join("second.wav");
        std::fs::write(&second_source, b"replacement sound").unwrap();
        store.replace_asset(&asset.id, &second_source).unwrap();
        preview.parts.clear();
        assert_eq!(
            std::fs::read(&original_path).unwrap(),
            b"first managed sound"
        );
        assert_ne!(store.asset_path(&asset.id).unwrap(), original_path);
        assert!(!prepared.parts.is_empty());
        assert_eq!(prepared.ffmpeg_speed, 1.25);
        assert_eq!(prepared.voice_volume, 0.8);
        assert!(!format!("{prepared:?}").contains(original_path.to_string_lossy().as_ref()));
    }

    #[test]
    fn fish_without_credential_is_rejected_before_network_use() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "fish".into(),
                name: "Fish".into(),
                settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
                has_credential: false,
            })
            .unwrap();
        let preset = VoicePreset {
            id: "voice".into(),
            name: "测试".into(),
            connection_id: "fish".into(),
            provider: Provider::FishAudio,
            voice_id: "voice-id".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        let preview = RulePreview {
            event: LiveEvent::danmaku(1, None, "用户", "测试"),
            filtered_reason: None,
            final_text: "测试".into(),
            parts: vec![PlanPart::Text("测试".into())],
            voice: Some(preset),
            default_voice: None,
            voice_from_binding: false,
            pending_legacy_binding: false,
        };
        assert!(matches!(
            PreparedPlayback::from_store(&store, &preview, None),
            Err(PrepareError::MissingCredential)
        ));
    }

    #[test]
    fn fish_preset_restores_all_legacy_generation_options_without_synthesis() {
        use crate::tts::fish::{DEFAULT_VOICE_ID, FishLatency, FishModel, FishPlaybackSettings};

        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "fish".into(),
                name: "Fish".into(),
                settings: ConnectionSettings::FishAudio { timeout_secs: 75 },
                has_credential: false,
            })
            .unwrap();
        store
            .set_connection_credential("fish", b"sk-test-only-secret-key-12345678901234567890")
            .unwrap();
        store
            .save_fish_audio_settings(
                "fish",
                &FishPlaybackSettings {
                    model: FishModel::S2Pro,
                    latency: FishLatency::Low,
                    volume_db: -4.0,
                    temperature: 0.3,
                    top_p: 0.6,
                    streaming: false,
                },
            )
            .unwrap();
        let preset = VoicePreset {
            id: "voice".into(),
            name: "测试".into(),
            connection_id: "fish".into(),
            provider: Provider::FishAudio,
            voice_id: DEFAULT_VOICE_ID.into(),
            speed: 1.4,
            volume: 0.8,
            sovits: None,
        };
        let config = fish_config_from_store(&store, "fish", &preset, 75).unwrap();
        assert_eq!(config.reference_id, DEFAULT_VOICE_ID);
        assert_eq!(config.model, FishModel::S2Pro);
        assert_eq!(config.latency, FishLatency::Low);
        assert_eq!(config.speed, 1.4);
        assert_eq!(config.volume_db, -4.0);
        assert_eq!(config.temperature, 0.3);
        assert_eq!(config.top_p, 0.6);
        assert!(config.streaming);
        assert_eq!(config.timeout_secs, 30);
        assert!(!format!("{config:?}").contains("sk-test-only-secret"));
    }

    #[test]
    fn atomic_sovits_preset_requires_a_complete_weight_pair() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "sovits".into(),
                name: "本地 GPT-SoVITS".into(),
                settings: ConnectionSettings::GptSovits {
                    endpoint: "http://127.0.0.1:9880".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let settings = crate::model::SovitsVoiceSettings {
            model_selection: PresetModelSelection::PerRequestAtomic,
            gpt_weights_path: Some("model.ckpt".into()),
            ..Default::default()
        };
        let mut preview = RulePreview {
            event: LiveEvent::danmaku(1, None, "用户", "测试"),
            filtered_reason: None,
            final_text: "测试".into(),
            parts: vec![PlanPart::Text("测试".into())],
            voice: Some(VoicePreset {
                id: "voice".into(),
                name: "测试".into(),
                connection_id: "sovits".into(),
                provider: Provider::GptSovits,
                voice_id: "server/ref.wav".into(),
                speed: 1.0,
                volume: 1.0,
                sovits: Some(settings),
            }),
            default_voice: None,
            voice_from_binding: false,
            pending_legacy_binding: false,
        };
        assert!(matches!(
            PreparedPlayback::from_store(&store, &preview, None),
            Err(PrepareError::Tts(TtsError::Configuration { .. }))
        ));
        preview
            .voice
            .as_mut()
            .unwrap()
            .sovits
            .as_mut()
            .unwrap()
            .sovits_weights_path = Some("model.pth".into());
        assert!(PreparedPlayback::from_store(&store, &preview, None).is_ok());
    }
}
