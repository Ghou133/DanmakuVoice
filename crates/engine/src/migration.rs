//! Explicit import of a reviewed legacy preview into the current data store.
//! Old credential files and unknown JSON values are never read by this path.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;
use uuid::Uuid;

use crate::legacy::{LegacyError, LegacyPathState, LegacyPreview, preview_legacy_config_file};
use crate::model::{
    GiftMergeSettings, LiveSettings, Provider, SovitsModelSelection, SovitsVoiceSettings,
    VoiceBinding, VoicePreset,
};
use crate::rules::{RuleSet, SoundRule};
use crate::storage::{
    ConnectionSettings, DataStore, DotsPlaybackSettings, ServiceConnection, StorageError,
};
use crate::tts::dobao::normalize_voice_id;
use crate::tts::fish::{self, FishLatency, FishModel, FishPlaybackSettings};

#[derive(Clone, Debug, Default)]
pub struct LegacyImportOptions {
    pub import_rules: bool,
    pub import_live_settings: bool,
    /// Explicitly selected IDs from `LegacyPreview::sounds`; the default is empty.
    pub selected_sound_ids: Vec<String>,
    pub import_connections: bool,
    pub import_pending_bindings: bool,
    /// Explicitly replace a nondefault rule set after the caller showed a diff.
    pub replace_existing_rules: bool,
    pub replace_existing_live_settings: bool,
}

#[derive(Clone, Debug)]
pub struct LegacyImportReport {
    pub backup_path: PathBuf,
    pub rules_imported: bool,
    pub live_settings_imported: bool,
    pub sounds_imported: usize,
    pub connections_created: usize,
    pub presets_created: usize,
    pub pending_bindings_created: usize,
    pub excluded: Vec<String>,
}

#[derive(Debug, Error)]
pub enum LegacyImportError {
    #[error("旧配置预览后已变化，请重新预览 [DV-M01]")]
    StalePreview,
    #[error("选择了预览中不存在或重复的音效 [DV-M02]")]
    InvalidSoundSelection,
    #[error("所选音效不是可用的本机绝对文件 [DV-M03]")]
    InvalidSoundPath,
    #[error("所选音效内容在预览后发生变化，请重新预览 [DV-M04]")]
    SoundChanged,
    #[error("必须同时选择导入规则才能导入音效 [DV-M05]")]
    SoundsNeedRules,
    #[error("当前规则已有修改，需明确选择覆盖规则 [DV-M06]")]
    RulesConflict,
    #[error("当前直播设置已有修改，需明确选择覆盖直播设置 [DV-M07]")]
    LiveSettingsConflict,
    #[error("无法读取旧配置：{0} [DV-M08]")]
    Legacy(#[from] LegacyError),
    #[error("无法导入旧配置：{0}")]
    Storage(#[from] StorageError),
    #[error("导入失败且数据库回滚失败；原错误：{apply}；回滚错误：{rollback} [DV-M10]")]
    Rollback {
        apply: Box<LegacyImportError>,
        rollback: StorageError,
    },
    #[error(
        "数据库已回滚，但新复制的音效文件清理失败；原错误：{apply}；清理错误：{cleanup} [DV-M11]"
    )]
    Cleanup {
        apply: Box<LegacyImportError>,
        cleanup: io::Error,
    },
}

/// Call only after a UI has displayed `expected` plus the exact selection and
/// received the user's confirmation. The old file is re-read to prevent a
/// changed config from being silently imported. A SQLite snapshot is kept for
/// manual recovery even after success. No existing credential is overwritten.
pub fn apply_confirmed_legacy_import(
    store: &mut DataStore,
    old_config_path: &Path,
    expected: &LegacyPreview,
    options: &LegacyImportOptions,
) -> Result<LegacyImportReport, LegacyImportError> {
    apply_confirmed_legacy_import_with_finalize(store, old_config_path, expected, options, |_| {
        Ok(())
    })
}

/// Run related database-only repairs before committing the reviewed import.
/// A repair failure rolls back the import and cleans its newly copied assets.
pub fn apply_confirmed_legacy_import_with_finalize(
    store: &mut DataStore,
    old_config_path: &Path,
    expected: &LegacyPreview,
    options: &LegacyImportOptions,
    finalize: impl FnOnce(&mut DataStore) -> Result<(), StorageError>,
) -> Result<LegacyImportReport, LegacyImportError> {
    let latest = preview_legacy_config_file(old_config_path)?;
    if &latest != expected {
        return Err(LegacyImportError::StalePreview);
    }
    if !options.import_rules && !options.selected_sound_ids.is_empty() {
        return Err(LegacyImportError::SoundsNeedRules);
    }
    let mut chosen = HashSet::new();
    for id in &options.selected_sound_ids {
        if !chosen.insert(id.as_str()) {
            return Err(LegacyImportError::InvalidSoundSelection);
        }
        let sound = expected
            .sounds
            .iter()
            .find(|sound| sound.preview_asset_id == *id)
            .ok_or(LegacyImportError::InvalidSoundSelection)?;
        if sound.path_state != LegacyPathState::Present
            || !Path::new(&sound.source_path).is_absolute()
            || !Path::new(&sound.source_path).is_file()
            || sound.source_sha256.is_none()
            || sound.source_bytes.is_none()
        {
            return Err(LegacyImportError::InvalidSoundPath);
        }
    }
    check_current_settings(store, options)?;
    // A separate connection holds SQLite's writer lock for the entire import.
    // It prevents another instance from committing between the backup and
    // import, and lets a failed import roll back only its own changes.
    let mut importer = DataStore::open(store.data_dir())?;
    importer.begin_legacy_import_transaction()?;
    check_current_settings(&importer, options)?;
    let backup_path = store.backup_before_legacy_import()?;
    let mut imported_paths = Vec::new();
    match apply_reviewed(
        &mut importer,
        expected,
        options,
        &chosen,
        backup_path.clone(),
        &mut imported_paths,
    )
    .and_then(|report| {
        finalize(&mut importer)?;
        Ok(report)
    }) {
        Ok(report) => match importer.finish_legacy_import_transaction(true) {
            Ok(()) => Ok(report),
            Err(error) => rollback_import(
                &mut importer,
                imported_paths,
                LegacyImportError::Storage(error),
            ),
        },
        Err(apply) => rollback_import(&mut importer, imported_paths, apply),
    }
}

fn check_current_settings(
    store: &DataStore,
    options: &LegacyImportOptions,
) -> Result<(), LegacyImportError> {
    if options.import_rules
        && !options.replace_existing_rules
        && store.load_rules()? != RuleSet::default()
    {
        return Err(LegacyImportError::RulesConflict);
    }
    if options.import_live_settings
        && !options.replace_existing_live_settings
        && store.load_live_settings()? != LiveSettings::default()
    {
        return Err(LegacyImportError::LiveSettingsConflict);
    }
    Ok(())
}

fn rollback_import(
    importer: &mut DataStore,
    imported_paths: Vec<PathBuf>,
    apply: LegacyImportError,
) -> Result<LegacyImportReport, LegacyImportError> {
    if let Err(rollback) = importer.finish_legacy_import_transaction(false) {
        return Err(LegacyImportError::Rollback {
            apply: Box::new(apply),
            rollback,
        });
    }
    let mut cleanup_error = None;
    for path in imported_paths {
        if let Err(error) = fs::remove_file(path)
            && error.kind() != io::ErrorKind::NotFound
        {
            cleanup_error.get_or_insert(error);
        }
    }
    match cleanup_error {
        Some(cleanup) => Err(LegacyImportError::Cleanup {
            apply: Box::new(apply),
            cleanup,
        }),
        None => Err(apply),
    }
}

fn apply_reviewed(
    store: &mut DataStore,
    expected: &LegacyPreview,
    options: &LegacyImportOptions,
    chosen: &HashSet<&str>,
    backup_path: PathBuf,
    imported_paths: &mut Vec<PathBuf>,
) -> Result<LegacyImportReport, LegacyImportError> {
    let mut report = LegacyImportReport {
        backup_path,
        rules_imported: false,
        live_settings_imported: false,
        sounds_imported: 0,
        connections_created: 0,
        presets_created: 0,
        pending_bindings_created: 0,
        excluded: Vec::new(),
    };
    let mut sound_ids = HashMap::new();
    for sound in &expected.sounds {
        if chosen.contains(sound.preview_asset_id.as_str()) {
            let asset = store.import_asset(Path::new(&sound.source_path), &sound.trigger)?;
            imported_paths.push(store.data_dir().join(&asset.relative_path));
            if Some(asset.sha256.as_str()) != sound.source_sha256.as_deref()
                || Some(asset.bytes) != sound.source_bytes
            {
                return Err(LegacyImportError::SoundChanged);
            }
            sound_ids.insert(sound.preview_asset_id.as_str(), asset.id);
            report.sounds_imported += 1;
        } else {
            report
                .excluded
                .push(format!("音效规则“{}”：未选择音频文件", sound.trigger));
        }
    }

    let mut provider_presets: Vec<(Provider, String)> = Vec::new();
    let mut provider_connections: Vec<(Provider, String)> = Vec::new();
    if options.import_connections {
        for settings in &expected.provider_settings {
            let provider = settings.provider;
            let endpoint = setting_text(settings, "ApiUrl");
            let old_timeout = setting_seconds(settings, "Timeout", default_timeout(provider));
            let timeout = old_timeout.min(30);
            if old_timeout > timeout {
                report.excluded.push(format!(
                    "{} 旧超时 {old_timeout} 秒按新版上限调整为 30 秒",
                    provider_label(provider)
                ));
            }
            let connection_settings = match provider {
                Provider::Dots | Provider::GptSovits => {
                    let Some(url) = endpoint.filter(|url| valid_endpoint(url)) else {
                        report.excluded.push(format!(
                            "{} 连接：旧地址无效或为空",
                            provider_label(provider)
                        ));
                        continue;
                    };
                    if provider == Provider::Dots {
                        ConnectionSettings::Dots {
                            endpoint: url.to_owned(),
                            timeout_secs: timeout,
                        }
                    } else {
                        ConnectionSettings::GptSovits {
                            endpoint: url.to_owned(),
                            timeout_secs: timeout,
                        }
                    }
                }
                Provider::FishAudio => ConnectionSettings::FishAudio {
                    timeout_secs: timeout,
                },
                Provider::Doubao => ConnectionSettings::Doubao {
                    timeout_secs: timeout,
                },
            };
            let connection_id = Uuid::new_v4().to_string();
            store.save_connection(&ServiceConnection {
                id: connection_id.clone(),
                name: format!("旧版 {} 连接", provider_label(provider)),
                settings: connection_settings,
                has_credential: false,
            })?;
            report.connections_created += 1;
            provider_connections.push((provider, connection_id.clone()));
            if provider == Provider::FishAudio {
                let fish_settings = legacy_fish_settings(settings, &mut report.excluded);
                store.save_fish_audio_settings(&connection_id, &fish_settings)?;
                let speed = setting_float(settings, "Speed", 1.0, 0.5, 2.0);
                let mut imported = HashMap::new();
                let mut invalid_voices = 0;
                if let Some(voices) = setting_value(settings, "Voices").and_then(|v| v.as_object())
                {
                    // A saved empty map is deliberate: do not restore shipped voices.
                    for (id, value) in voices {
                        let Some(name) = value.as_str() else {
                            invalid_voices += 1;
                            continue;
                        };
                        if import_fish_voice(store, &connection_id, id, name, speed, &mut imported)?
                        {
                            report.presets_created += 1;
                        } else {
                            invalid_voices += 1;
                        }
                    }
                } else {
                    // Older configs without an explicit library used the built-in defaults.
                    for (id, name) in fish::BUILTIN_VOICES {
                        if import_fish_voice(store, &connection_id, id, name, speed, &mut imported)?
                        {
                            report.presets_created += 1;
                        }
                    }
                }
                if invalid_voices > 0 {
                    report.excluded.push(format!(
                        "Fish Audio 收藏：{invalid_voices} 条音色 ID 或名称无效，未导入"
                    ));
                }
                if let Some(selected) =
                    setting_text(settings, "ReferenceId").filter(|id| !id.trim().is_empty())
                {
                    match fish::normalize_voice_id(selected) {
                        Ok(selected_id) => {
                            if !imported.contains_key(&selected_id) {
                                let name = format!("音色 {}", &selected_id[..8]);
                                if import_fish_voice(
                                    store,
                                    &connection_id,
                                    &selected_id,
                                    &name,
                                    speed,
                                    &mut imported,
                                )? {
                                    report.presets_created += 1;
                                }
                            }
                            if let Some(preset_id) = imported.get(&selected_id) {
                                provider_presets.push((provider, preset_id.clone()));
                            }
                        }
                        Err(_) => report
                            .excluded
                            .push("Fish Audio 默认音色：ID 或页面链接无效，未设为默认".into()),
                    }
                }
                continue;
            }
            let (voice_id, sovits) = match provider {
                Provider::Dots => (setting_text(settings, "Voice").map(str::to_owned), None),
                Provider::FishAudio => unreachable!("Fish Audio handled above"),
                Provider::Doubao => (
                    setting_text(settings, "Voice")
                        .and_then(|voice| normalize_voice_id(voice).ok()),
                    None,
                ),
                Provider::GptSovits => match default_sovits(settings) {
                    Some((audio, voice)) => (Some(audio), Some(voice)),
                    None => (None, None),
                },
            };
            if let Some(voice_id) = voice_id.filter(|value| !value.trim().is_empty()) {
                let speed = setting_float(settings, speed_key(provider), 1.0, 0.5, 2.0);
                let volume = setting_float(settings, "Volume", 1.0, 0.0, 2.0);
                let preset_id = Uuid::new_v4().to_string();
                store.save_preset(&VoicePreset {
                    id: preset_id.clone(),
                    name: format!("旧版 {} 默认声音", provider_label(provider)),
                    connection_id,
                    provider,
                    voice_id,
                    speed,
                    volume,
                    sovits,
                })?;
                if provider == Provider::Dots {
                    let dots_settings = legacy_dots_settings(settings, &mut report.excluded);
                    store.save_dots_playback_settings(&preset_id, &dots_settings)?;
                }
                report.presets_created += 1;
                provider_presets.push((provider, preset_id));
            } else {
                report.excluded.push(format!(
                    "{} 默认声音：旧参考信息不完整或模型路径未成对",
                    provider_label(provider)
                ));
            }
        }
    } else if !expected.provider_settings.is_empty() {
        report
            .excluded
            .push("服务连接与声音预设：未选择导入".into());
    }

    if options.import_pending_bindings {
        for binding in &expected.voice_bindings {
            if !binding.requires_uid_confirmation {
                report.excluded.push(format!(
                    "{} 用户声音：旧记录不符合待确认条件",
                    binding.old_user_name
                ));
                continue;
            }
            let Some(provider) = binding.provider else {
                report.excluded.push(format!(
                    "{} 用户声音：旧服务不受支持",
                    binding.old_user_name
                ));
                continue;
            };
            let Some(connection_id) = provider_connections
                .iter()
                .find(|(kind, _)| *kind == provider)
                .map(|(_, id)| id)
            else {
                report.excluded.push(format!(
                    "{} 用户声音：未导入对应服务连接",
                    binding.old_user_name
                ));
                continue;
            };
            let (voice_id, sovits) = match provider {
                Provider::FishAudio => (
                    binding
                        .voice_id
                        .as_deref()
                        .and_then(|id| fish::normalize_voice_id(id).ok()),
                    None,
                ),
                Provider::Doubao => (
                    binding
                        .voice_id
                        .as_deref()
                        .and_then(|voice| normalize_voice_id(voice).ok()),
                    None,
                ),
                Provider::GptSovits => match bound_sovits(binding, expected) {
                    Some((audio, voice)) => (Some(audio), Some(voice)),
                    None => (None, None),
                },
                Provider::Dots => (None, None),
            };
            let Some(voice_id) = voice_id.filter(|value| !value.trim().is_empty()) else {
                report.excluded.push(format!(
                    "{} 用户声音：旧角色配置无法准确表达",
                    binding.old_user_name
                ));
                continue;
            };
            let preset_id = Uuid::new_v4().to_string();
            let speed = if provider == Provider::FishAudio {
                expected
                    .provider_settings
                    .iter()
                    .find(|settings| settings.provider == Provider::FishAudio)
                    .map_or(1.0, |settings| {
                        setting_float(settings, "Speed", 1.0, 0.5, 2.0)
                    })
            } else {
                1.0
            };
            store.save_preset(&VoicePreset {
                id: preset_id.clone(),
                name: binding
                    .label
                    .clone()
                    .unwrap_or_else(|| format!("旧版 {} 声音", binding.old_user_name)),
                connection_id: connection_id.clone(),
                provider,
                voice_id,
                speed,
                volume: 1.0,
                sovits,
            })?;
            report.presets_created += 1;
            store.save_binding(
                &Uuid::new_v4().to_string(),
                &VoiceBinding {
                    platform: "bilibili".into(),
                    user_id: None,
                    user_name: None,
                    legacy_user_name: Some(binding.old_user_name.clone()),
                    preset_id,
                    enabled: binding.enabled && binding.master_enabled,
                },
            )?;
            report.pending_bindings_created += 1;
        }
    } else if !expected.voice_bindings.is_empty() {
        report.excluded.push("旧用户名声音绑定：未选择导入".into());
    }

    if options.import_rules {
        let mut rules = expected.rules.clone();
        rules.sounds = rules
            .sounds
            .into_iter()
            .filter_map(|sound| {
                sound_ids
                    .get(sound.asset_id.as_str())
                    .map(|asset_id| SoundRule {
                        trigger: sound.trigger,
                        asset_id: asset_id.clone(),
                    })
            })
            .collect();
        rules.default_preset_id = expected.selected_provider.and_then(|selected| {
            provider_presets
                .iter()
                .find(|(provider, _)| *provider == selected)
                .map(|(_, id)| id.clone())
        });
        store.save_rules(&rules)?;
        report.rules_imported = true;
    } else {
        report.excluded.push("旧播报规则与词典：未选择导入".into());
    }
    if options.import_live_settings {
        let live = LiveSettings {
            room_id: expected.room_id,
            gift_merge: GiftMergeSettings {
                enabled: expected.gift_merge.enabled,
                initial_seconds: expected.gift_merge.initial_seconds,
                increment_seconds: expected.gift_merge.increment_seconds,
                maximum_seconds: expected.gift_merge.maximum_seconds,
            },
        };
        if live.gift_merge.is_valid() {
            store.save_live_settings(&live)?;
            report.live_settings_imported = true;
        } else {
            report
                .excluded
                .push("旧直播设置：礼物合并时间参数无效，未导入".into());
        }
    } else if expected.room_id.is_some() || expected.gift_merge.enabled {
        report
            .excluded
            .push("旧房间号与礼物合并设置：未选择导入".into());
    }
    let referenced = expected
        .voice_bindings
        .iter()
        .filter(|binding| {
            binding.provider == Some(Provider::GptSovits)
                && binding.gpt_model.is_some()
                && binding.sovits_model.is_some()
        })
        .count();
    if expected.model_references.len() > referenced {
        report
            .excluded
            .push("部分未绑定的 GPT-SoVITS 模型参考配置：仅保留在预览中".into());
    }
    Ok(report)
}

fn provider_label(provider: Provider) -> &'static str {
    match provider {
        Provider::Dots => "dots.tts",
        Provider::GptSovits => "GPT-SoVITS",
        Provider::FishAudio => "Fish Audio",
        Provider::Doubao => "豆包",
    }
}

fn default_timeout(provider: Provider) -> u64 {
    match provider {
        Provider::GptSovits => 300,
        Provider::Doubao => 120,
        _ => 180,
    }
}

fn import_fish_voice(
    store: &mut DataStore,
    connection_id: &str,
    id: &str,
    name: &str,
    speed: f32,
    imported: &mut HashMap<String, String>,
) -> Result<bool, StorageError> {
    let Ok(id) = fish::normalize_voice_id(id) else {
        return Ok(false);
    };
    if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Ok(false);
    }
    if imported.contains_key(&id) {
        return Ok(false);
    }
    let mut preset = store.save_fish_voice(connection_id, &id, name)?;
    preset.speed = speed;
    store.save_preset(&preset)?;
    imported.insert(id, preset.id);
    Ok(true)
}

fn legacy_dots_settings(
    settings: &crate::legacy::LegacyProviderSettings,
    excluded: &mut Vec<String>,
) -> DotsPlaybackSettings {
    let mut result = DotsPlaybackSettings {
        prompt_text: setting_text(settings, "PromptText")
            .unwrap_or_default()
            .to_owned(),
        language: setting_text(settings, "Language")
            .unwrap_or_default()
            .to_owned(),
        normalize_text: setting_bool(settings, "NormalizeText", true),
        ..Default::default()
    };
    if let Some(value) = setting_value(settings, "NumSteps") {
        result.num_steps = match value.as_u64() {
            Some(0) => None,
            Some(steps @ 1..=64) => Some(steps as u8),
            _ => {
                excluded.push("dots.tts 推理步数无效，沿用服务设置".into());
                None
            }
        };
    }
    if !setting_bool(settings, "Streaming", true) {
        excluded.push("dots.tts 旧流式开关已停用；新版始终使用流式播放".into());
    }
    result
}

fn legacy_fish_settings(
    settings: &crate::legacy::LegacyProviderSettings,
    excluded: &mut Vec<String>,
) -> FishPlaybackSettings {
    let mut result = FishPlaybackSettings::default();
    if let Some(model) = setting_text(settings, "Model") {
        result.model = match model {
            "s1" => FishModel::S1,
            "s2-pro" => FishModel::S2Pro,
            "s2.1-pro" => FishModel::S21Pro,
            "s2.1-pro-free" => FishModel::S21ProFree,
            _ => {
                excluded.push("Fish Audio 模型值无效，使用免费默认模型".into());
                result.model
            }
        };
    }
    if let Some(latency) = setting_text(settings, "Latency") {
        result.latency = match latency {
            "normal" => FishLatency::Normal,
            "balanced" => FishLatency::Balanced,
            "low" => FishLatency::Low,
            _ => {
                excluded.push("Fish Audio 延迟模式无效，使用默认模式".into());
                result.latency
            }
        };
    }
    result.streaming = setting_bool(settings, "Streaming", result.streaming);
    for (key, target, minimum, maximum) in [
        ("Volume", &mut result.volume_db, -20.0, 20.0),
        ("Temperature", &mut result.temperature, 0.0, 1.0),
        ("TopP", &mut result.top_p, 0.0, 1.0),
    ] {
        if let Some(value) = setting_value(settings, key) {
            match value.as_f64() {
                Some(value) if value.is_finite() && value >= minimum && value <= maximum => {
                    *target = value as f32;
                }
                _ => excluded.push(format!("Fish Audio {key} 无效，使用默认值")),
            }
        }
    }
    result
}

fn speed_key(provider: Provider) -> &'static str {
    if provider == Provider::GptSovits {
        "SpeedFactor"
    } else {
        "Speed"
    }
}

fn default_sovits(
    settings: &crate::legacy::LegacyProviderSettings,
) -> Option<(String, SovitsVoiceSettings)> {
    let audio = setting_text(settings, "RefAudioPath")?.trim();
    if audio.is_empty() {
        return None;
    }
    let mut voice = base_sovits(settings)?;
    let gpt = setting_text(settings, "GptModel").filter(|value| !value.trim().is_empty());
    let sovits = setting_text(settings, "SovitsModel").filter(|value| !value.trim().is_empty());
    match (gpt, sovits) {
        (None, None) => {}
        (Some(gpt), Some(sovits)) => {
            voice.model_selection = SovitsModelSelection::PerRequestAtomic;
            voice.gpt_weights_path = Some(gpt.to_owned());
            voice.sovits_weights_path = Some(sovits.to_owned());
        }
        _ => return None,
    }
    if !voice.reference_text_free && voice.reference_text.trim().is_empty() {
        return None;
    }
    Some((audio.to_owned(), voice))
}

fn bound_sovits(
    binding: &crate::legacy::LegacyVoiceBinding,
    preview: &LegacyPreview,
) -> Option<(String, SovitsVoiceSettings)> {
    let settings = preview
        .provider_settings
        .iter()
        .find(|settings| settings.provider == Provider::GptSovits)?;
    let gpt = binding.gpt_model.as_deref()?.trim();
    let sovits = binding.sovits_model.as_deref()?.trim();
    if gpt.is_empty() || sovits.is_empty() {
        return None;
    }
    let reference = preview
        .model_references
        .iter()
        .find(|reference| reference.gpt_model == gpt && reference.sovits_model == sovits)?;
    if reference.reference_audio.trim().is_empty()
        || (!reference.text_free && reference.reference_text.trim().is_empty())
    {
        return None;
    }
    let mut voice = base_sovits(settings)?;
    voice.model_selection = SovitsModelSelection::PerRequestAtomic;
    voice.gpt_weights_path = Some(gpt.to_owned());
    voice.sovits_weights_path = Some(sovits.to_owned());
    voice.reference_text = reference.reference_text.clone();
    voice.reference_text_free = reference.text_free;
    voice.reference_language = normalize_language(&reference.reference_language)?.into();
    Some((reference.reference_audio.clone(), voice))
}

fn base_sovits(settings: &crate::legacy::LegacyProviderSettings) -> Option<SovitsVoiceSettings> {
    let mut voice = SovitsVoiceSettings::default();
    // These are the old qconfig defaults, not the new app's defaults.
    voice.reference_text_free = false;
    voice.reference_language = "auto".into();
    voice.text_language = "auto".into();
    // The old streaming branch maps the UI's “不切” choice to cut5.
    voice.split = "cut5".into();
    voice.reference_text = setting_text(settings, "RefText")
        .unwrap_or_default()
        .to_owned();
    voice.reference_text_free = setting_bool(settings, "RefTextFree", voice.reference_text_free);
    if let Some(language) = setting_text(settings, "RefTextLang") {
        voice.reference_language = normalize_language(language)?.into();
    }
    if let Some(language) = setting_text(settings, "TextLang") {
        voice.text_language = normalize_language(language)?.into();
    }
    if let Some(split) = setting_text(settings, "TextSplitMethod") {
        voice.split = normalize_legacy_split(split)?.into();
    }
    voice.top_k = setting_u16(settings, "TopK", voice.top_k, 1, 1000);
    voice.top_p = setting_float(settings, "TopP", voice.top_p, 0.0, 1.0);
    voice.temperature = setting_float(settings, "Temperature", voice.temperature, 0.0, 2.0);
    voice.sample_steps = setting_u16(settings, "SampleSteps", voice.sample_steps, 1, 64);
    voice.super_sampling = setting_bool(settings, "SuperSampling", voice.super_sampling);
    voice.fragment_interval_secs = setting_float(
        settings,
        "PauseSeconds",
        voice.fragment_interval_secs,
        0.0,
        5.0,
    );
    Some(voice)
}

fn normalize_language(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" | "multilingual mixed" => Some("auto"),
        "zh" | "all_zh" | "中文" | "chinese" => Some("all_zh"),
        "en" | "english" | "英文" => Some("en"),
        "ja" | "jp" | "all_ja" | "日文" | "japanese" => Some("all_ja"),
        "ko" | "all_ko" | "韩文" | "korean" => Some("all_ko"),
        "yue" | "all_yue" | "粤语" | "cantonese" => Some("all_yue"),
        _ => None,
    }
}

fn normalize_legacy_split(value: &str) -> Option<&'static str> {
    match value {
        "不切" | "按标点符号切" | "cut5" => Some("cut5"),
        "凑四句一切" | "cut1" => Some("cut1"),
        "凑50字一切" | "cut2" => Some("cut2"),
        "按中文句号。切" | "cut3" => Some("cut3"),
        "按英文句号.切" | "cut4" => Some("cut4"),
        "cut0" => Some("cut0"),
        _ => None,
    }
}

fn setting_bool(
    settings: &crate::legacy::LegacyProviderSettings,
    key: &str,
    default: bool,
) -> bool {
    settings
        .settings
        .iter()
        .find(|setting| setting.key == key)
        .and_then(|setting| setting.value.as_bool())
        .unwrap_or(default)
}

fn setting_u16(
    settings: &crate::legacy::LegacyProviderSettings,
    key: &str,
    default: u16,
    minimum: u16,
    maximum: u16,
) -> u16 {
    settings
        .settings
        .iter()
        .find(|setting| setting.key == key)
        .and_then(|setting| setting.value.as_u64())
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| (minimum..=maximum).contains(value))
        .unwrap_or(default)
}

fn setting_text<'a>(
    settings: &'a crate::legacy::LegacyProviderSettings,
    key: &str,
) -> Option<&'a str> {
    settings
        .settings
        .iter()
        .find(|setting| setting.key == key)
        .and_then(|setting| setting.value.as_str())
}

fn setting_value<'a>(
    settings: &'a crate::legacy::LegacyProviderSettings,
    key: &str,
) -> Option<&'a serde_json::Value> {
    settings
        .settings
        .iter()
        .find(|setting| setting.key == key)
        .map(|setting| &setting.value)
}

fn setting_seconds(
    settings: &crate::legacy::LegacyProviderSettings,
    key: &str,
    default: u64,
) -> u64 {
    settings
        .settings
        .iter()
        .find(|setting| setting.key == key)
        .and_then(|setting| setting.value.as_u64())
        .filter(|value| (5..=600).contains(value))
        .unwrap_or(default)
}

fn setting_float(
    settings: &crate::legacy::LegacyProviderSettings,
    key: &str,
    default: f32,
    minimum: f32,
    maximum: f32,
) -> f32 {
    settings
        .settings
        .iter()
        .find(|setting| setting.key == key)
        .and_then(|setting| setting.value.as_f64())
        .filter(|value| {
            value.is_finite() && (*value as f32) >= minimum && (*value as f32) <= maximum
        })
        .map_or(default, |value| value as f32)
}

fn valid_endpoint(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::preview_legacy_config_file;
    use std::fs;

    #[test]
    fn dots_import_keeps_request_options_after_restart_and_export() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        fs::write(
            &source,
            r#"{"TTSService":{"ActiveTTS":"dots_tts"},"DotsTTSService":{"ApiUrl":"http://127.0.0.1:9881","Voice":"ref.wav","PromptText":"准确的参考文本","Language":"zh","NumSteps":32,"NormalizeText":false,"Streaming":false}}"#,
        )
        .unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        let data_dir = temp.path().join("data");
        let mut store = DataStore::open(&data_dir).unwrap();
        let report = apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_connections: true,
                import_rules: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((report.connections_created, report.presets_created), (1, 1));
        assert!(
            report
                .excluded
                .iter()
                .any(|line| line.contains("旧流式开关"))
        );
        let preset_id = store.presets().unwrap().pop().unwrap().id;
        let expected = DotsPlaybackSettings {
            prompt_text: "准确的参考文本".into(),
            language: "zh".into(),
            num_steps: Some(32),
            normalize_text: false,
        };
        assert_eq!(store.dots_playback_settings(&preset_id).unwrap(), expected);
        assert_eq!(
            store.export_configuration().unwrap().dots_settings[&preset_id],
            expected
        );
        drop(store);
        let mut reopened = DataStore::open(&data_dir).unwrap();
        assert_eq!(
            reopened.dots_playback_settings(&preset_id).unwrap(),
            expected
        );
        let mut another = reopened.presets().unwrap().pop().unwrap();
        another.id = "new-voice".into();
        another.voice_id = "another.wav".into();
        reopened.save_preset(&another).unwrap();
        assert_eq!(
            reopened.dots_playback_settings(&another.id).unwrap(),
            DotsPlaybackSettings::default(),
            "a new voice must not inherit the migrated prompt text"
        );
        let mut original = reopened
            .presets()
            .unwrap()
            .into_iter()
            .find(|preset| preset.id == preset_id)
            .unwrap();
        original.voice_id = "replacement.wav".into();
        reopened.save_preset(&original).unwrap();
        assert_eq!(
            reopened.dots_playback_settings(&preset_id).unwrap(),
            DotsPlaybackSettings::default(),
            "changing the imported voice must clear its old reference text"
        );
    }

    #[test]
    fn fish_import_preserves_library_settings_and_db_volume_without_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        let selected = fish::BUILTIN_VOICES[0].0;
        let other = fish::BUILTIN_VOICES[1].0;
        let old = serde_json::json!({
            "TTSService": {"ActiveTTS": "fish_audio"},
            "FishAudioService": {
                "ApiKey": "never-import-this-private-key",
                "Model": "s2-pro", "ReferenceId": format!("https://fish.audio/m/{selected}"),
                "Voices": { (selected): "自定义名称", (other): "保留的收藏", "bad-id": "跳过" },
                "Streaming": false, "Speed": 1.5, "Volume": 0.0,
                "Temperature": 0.3, "TopP": 0.4, "Latency": "low", "Timeout": 180
            }
        });
        fs::write(&source, old.to_string()).unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains("never-import-this")
        );
        let mut store = DataStore::open(temp.path().join("new-data")).unwrap();
        let report = apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_rules: true,
                import_connections: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(report.connections_created, 1);
        assert_eq!(report.presets_created, 2);
        assert!(report.excluded.iter().any(|item| item.contains("1 条音色")));
        let connection = store.connections().unwrap().pop().unwrap();
        assert!(matches!(
            connection.settings,
            ConnectionSettings::FishAudio { timeout_secs: 30 }
        ));
        assert!(
            report
                .excluded
                .iter()
                .any(|item| item.contains("旧超时 180 秒"))
        );
        assert!(!connection.has_credential);
        assert!(
            store
                .connection_credential(&connection.id)
                .unwrap()
                .is_none()
        );
        let settings = store.fish_audio_settings(&connection.id).unwrap();
        assert_eq!(settings.model, FishModel::S2Pro);
        assert_eq!(settings.latency, FishLatency::Low);
        assert_eq!(settings.volume_db, 0.0);
        assert!(!settings.streaming);
        assert!((settings.temperature - 0.3).abs() < 0.001);
        assert!((settings.top_p - 0.4).abs() < 0.001);
        let presets = store.presets().unwrap();
        assert_eq!(presets.len(), 2);
        let selected_preset = presets
            .iter()
            .find(|voice| voice.voice_id == selected)
            .unwrap();
        assert_eq!(selected_preset.name, "自定义名称");
        assert_eq!(selected_preset.speed, 1.5);
        assert_eq!(selected_preset.volume, 1.0, "0 dB must not mute playback");
        assert_eq!(
            store.load_rules().unwrap().default_preset_id.as_deref(),
            Some(selected_preset.id.as_str())
        );
    }

    #[test]
    fn fish_saved_empty_library_is_not_reseeded_during_import() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        fs::write(
            &source,
            r#"{"FishAudioService":{"Voices":{},"ReferenceId":""}}"#,
        )
        .unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        let mut store = DataStore::open(temp.path().join("new-data")).unwrap();
        let report = apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_connections: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(report.connections_created, 1);
        assert_eq!(report.presets_created, 0);
        assert!(store.presets().unwrap().is_empty());
    }

    #[test]
    fn incompatible_old_template_is_reported_and_cannot_break_live_rule_after_import() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        fs::write(
            &source,
            r#"{"BiliService":{"DanmakuOnText":"{user_name!r}说{message}","GiftOnText":"{user_name}送了{gift_num}个{gift_name}"}}"#,
        )
        .unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        assert_eq!(
            preview.rules.templates.danmaku,
            RuleSet::default().templates.danmaku
        );
        assert_eq!(
            preview.rules.templates.gift,
            "{user_name}送了{gift_num}个{gift_name}"
        );
        assert!(preview.warnings.iter().any(|warning| {
            warning.path == "BiliService.DanmakuOnText" && warning.message.contains("不兼容")
        }));
        let mut store = DataStore::open(temp.path().join("new-data")).unwrap();
        apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_rules: true,
                ..Default::default()
            },
        )
        .unwrap();
        let rules = store.load_rules().unwrap();
        let event = crate::model::LiveEvent::danmaku(42, Some(7), "甲", "你好");
        assert!(rules.preview(&event, &[], &[]).is_ok());
    }

    #[test]
    fn reviewed_selection_preserves_source_order_and_does_not_touch_old_files() {
        let temp = tempfile::tempdir().unwrap();
        let z_sound = temp.path().join("z.wav");
        let a_sound = temp.path().join("a.wav");
        fs::write(&z_sound, b"RIFF Z").unwrap();
        fs::write(&a_sound, b"RIFF A").unwrap();
        let source = temp.path().join("config.json");
        let old = serde_json::json!({
            "BiliService": { "RoomId": 42, "NormalDanmakuOn": true,
                "AudioClipDict": {"z": z_sound, "a": a_sound}},
            "TTSService": {"ActiveTTS": "dots_tts"},
            "DotsTTSService": {"ApiUrl": "http://127.0.0.1:9881", "Voice": "ref.wav"}
        });
        fs::write(&source, old.to_string()).unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        assert_eq!(
            preview
                .sounds
                .iter()
                .map(|sound| sound.trigger.as_str())
                .collect::<Vec<_>>(),
            vec!["z", "a"]
        );
        let selected = preview.sounds[0].preview_asset_id.clone();
        let mut store = DataStore::open(temp.path().join("new-data")).unwrap();
        let report = apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_rules: true,
                selected_sound_ids: vec![selected],
                import_connections: true,
                import_live_settings: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(report.backup_path.exists());
        assert_eq!(
            (
                report.sounds_imported,
                report.connections_created,
                report.presets_created
            ),
            (1, 1, 1)
        );
        let rules = store.load_rules().unwrap();
        assert_eq!(rules.sounds.len(), 1);
        assert_eq!(rules.sounds[0].trigger, "z");
        assert!(
            store
                .asset_path(&rules.sounds[0].asset_id)
                .unwrap()
                .is_file()
        );
        assert!(rules.default_preset_id.is_some());
        assert!(report.live_settings_imported);
        assert_eq!(store.load_live_settings().unwrap().room_id, Some(42));
        assert_eq!(fs::read(z_sound).unwrap(), b"RIFF Z");
        assert_eq!(fs::read(a_sound).unwrap(), b"RIFF A");
        assert!(!report.excluded.iter().any(|entry| entry.contains("房间号")));
    }

    #[test]
    fn changed_preview_and_rules_conflict_refuse_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        fs::write(&source, r#"{"BiliService":{"NormalDanmakuOn":true}}"#).unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        fs::write(&source, r#"{"BiliService":{"NormalDanmakuOn":false}}"#).unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let selected = LegacyImportOptions {
            import_rules: true,
            ..Default::default()
        };
        assert!(matches!(
            apply_confirmed_legacy_import(&mut store, &source, &preview, &selected),
            Err(LegacyImportError::StalePreview)
        ));
        assert_eq!(store.load_rules().unwrap(), RuleSet::default());
        let latest = preview_legacy_config_file(&source).unwrap();
        let mut changed = RuleSet::default();
        changed.templates.danmaku = "custom".into();
        store.save_rules(&changed).unwrap();
        assert!(matches!(
            apply_confirmed_legacy_import(&mut store, &source, &latest, &selected),
            Err(LegacyImportError::RulesConflict)
        ));
        assert_eq!(store.load_rules().unwrap(), changed);
    }

    #[test]
    fn legacy_url_with_query_secret_is_excluded_from_import() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        fs::write(
            &source,
            r#"{"DotsTTSService":{"ApiUrl":"http://127.0.0.1:9881/tts?token=private-url-token","Voice":"ref.wav"}}"#,
        )
        .unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let report = apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_connections: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(report.connections_created, 0);
        assert!(store.connections().unwrap().is_empty());
        assert!(
            !serde_json::to_string(&store.export_configuration().unwrap())
                .unwrap()
                .contains("private-url-token")
        );
    }

    #[test]
    fn changed_sound_bytes_refuse_before_import() {
        let temp = tempfile::tempdir().unwrap();
        let sound = temp.path().join("clip.wav");
        fs::write(&sound, b"RIFF original").unwrap();
        let source = temp.path().join("old.json");
        fs::write(
            &source,
            serde_json::json!({
                "BiliService":{"AudioClipDict":{"ding":sound}}
            })
            .to_string(),
        )
        .unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        assert!(preview.sounds[0].source_sha256.is_some());
        fs::write(&sound, b"RIFF changed!").unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let options = LegacyImportOptions {
            import_rules: true,
            selected_sound_ids: vec![preview.sounds[0].preview_asset_id.clone()],
            ..Default::default()
        };
        assert!(matches!(
            apply_confirmed_legacy_import(&mut store, &source, &preview, &options),
            Err(LegacyImportError::StalePreview)
        ));
        assert_eq!(store.load_rules().unwrap(), RuleSet::default());
    }

    #[test]
    fn apply_failure_restores_database_and_never_reads_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let good = temp.path().join("good.wav");
        let unsupported = temp.path().join("bad.txt");
        fs::write(&good, b"RIFF good").unwrap();
        fs::write(&unsupported, b"not audio").unwrap();
        let source = temp.path().join("old.json");
        let old = serde_json::json!({
            "BiliService": {"AudioClipDict": {"first": good, "second": unsupported}},
            "FishAudioService": {"ApiKey": "must-never-import", "ReferenceId": "ref"}
        });
        fs::write(&source, old.to_string()).unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let options = LegacyImportOptions {
            import_rules: true,
            selected_sound_ids: preview
                .sounds
                .iter()
                .map(|sound| sound.preview_asset_id.clone())
                .collect(),
            import_connections: true,
            ..Default::default()
        };
        assert!(matches!(
            apply_confirmed_legacy_import(&mut store, &source, &preview, &options),
            Err(LegacyImportError::Storage(StorageError::UnsupportedAudio(
                _
            )))
        ));
        assert_eq!(store.load_rules().unwrap(), RuleSet::default());
        assert!(store.connections().unwrap().is_empty());
        assert_eq!(
            fs::read_dir(store.data_dir().join("assets"))
                .unwrap()
                .count(),
            0,
            "failed import must not retain a copied private sound"
        );
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains("must-never-import")
        );
        assert!(source.exists());
    }

    #[test]
    fn gpt_model_pair_and_name_binding_remain_explicit_and_pending() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old.json");
        let old = r#"{
          "TTSService":{"ActiveTTS":"gpt_sovits"},
          "GptSovitsService":{
            "ApiUrl":"http://127.0.0.1:9880",
            "RefAudioPath":"C:/server/ref.wav", "RefText":"参考文本",
            "RefTextLang":"Chinese", "TextLang":"Multilingual Mixed",
            "TextSplitMethod":"不切", "RefTextFree":false,
            "GptModel":"C:/server/a.ckpt", "SovitsModel":"C:/server/b.pth",
            "ModelReferences":{"[\"C:/server/a.ckpt\",\"C:/server/b.pth\"]":
              {"audio":"C:/server/ref.wav","text":"参考文本","language":"Chinese","text_free":false}},
            "UsernameModelsEnabled":true,
            "UsernameModels":{"Alice":{"gpt":"C:/server/a.ckpt","sovits":"C:/server/b.pth"}}
          }
        }"#;
        fs::write(&source, old).unwrap();
        let preview = preview_legacy_config_file(&source).unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let report = apply_confirmed_legacy_import(
            &mut store,
            &source,
            &preview,
            &LegacyImportOptions {
                import_rules: true,
                import_connections: true,
                import_pending_bindings: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(report.presets_created, 2);
        assert_eq!(report.pending_bindings_created, 1);
        let default_id = store.load_rules().unwrap().default_preset_id.unwrap();
        let default = store
            .presets()
            .unwrap()
            .into_iter()
            .find(|preset| preset.id == default_id)
            .unwrap();
        let voice = default.sovits.unwrap();
        assert_eq!(
            voice.model_selection,
            SovitsModelSelection::PerRequestAtomic
        );
        assert_eq!(voice.reference_language, "all_zh");
        assert_eq!(voice.text_language, "auto");
        assert_eq!(voice.split, "cut5");
        let binding = store.bindings().unwrap().pop().unwrap();
        assert_eq!(binding.legacy_user_name.as_deref(), Some("Alice"));
        assert_eq!(binding.user_name, None);
        assert_eq!(binding.user_id, None);
        assert!(!binding.matches_confirmed_user(None));
        assert!(!binding.matches_explicit_name("Alice"));
    }
}
