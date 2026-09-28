//! Read-only preview of the Python application's `config.json`.
//!
//! This module never opens credential files or writes to the old installation.
//! Preview asset IDs and preset IDs are deliberately unusable until a confirmed
//! import copies assets into the managed directory and creates real presets.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::model::Provider;
use crate::rules::{Replacement, RuleSet, SoundRule, validate_template};

const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;
const MAX_RULES: usize = 1024;
const MAX_BINDINGS: usize = 4096;
const MAX_SOUND_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PREVIEW_HASH_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacyPreview {
    /// Rules for display and dry-run only. `sounds` contain preview-only IDs.
    pub rules: RuleSet,
    pub room_id: Option<u64>,
    pub gift_merge: LegacyGiftMerge,
    pub selected_provider: Option<Provider>,
    pub provider_settings: Vec<LegacyProviderSettings>,
    pub model_references: Vec<LegacyModelReference>,
    pub voice_bindings: Vec<LegacyVoiceBinding>,
    pub sounds: Vec<LegacySound>,
    pub warnings: Vec<LegacyWarning>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacyGiftMerge {
    pub enabled: bool,
    pub initial_seconds: f64,
    pub increment_seconds: f64,
    pub maximum_seconds: f64,
}

impl Default for LegacyGiftMerge {
    fn default() -> Self {
        Self {
            enabled: false,
            initial_seconds: 1.5,
            increment_seconds: 0.5,
            maximum_seconds: 5.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacyProviderSettings {
    pub provider: Provider,
    pub old_group: String,
    /// Only allow-listed, non-secret settings appear here.
    pub settings: Vec<LegacySetting>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacySetting {
    pub key: String,
    pub value: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyPathState {
    Empty,
    Relative,
    Missing,
    NotFile,
    Present,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LegacySound {
    pub trigger: String,
    pub source_path: String,
    pub path_state: LegacyPathState,
    /// A source-content check for the explicit review and later copy.
    pub source_sha256: Option<String>,
    pub source_bytes: Option<u64>,
    /// Must be replaced with a managed asset ID after explicit import.
    pub preview_asset_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LegacyModelReference {
    pub gpt_model: String,
    pub sovits_model: String,
    pub reference_audio: String,
    pub reference_text: String,
    pub reference_language: String,
    pub text_free: bool,
    pub gpt_path_state: LegacyPathState,
    pub sovits_path_state: LegacyPathState,
    pub audio_path_state: LegacyPathState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacyVoiceBinding {
    pub old_user_name: String,
    pub provider: Option<Provider>,
    pub enabled: bool,
    pub master_enabled: bool,
    /// This remains true even when a same-named viewer appears in a room.
    pub requires_uid_confirmation: bool,
    pub label: Option<String>,
    pub voice_id: Option<String>,
    pub gpt_model: Option<String>,
    pub sovits_model: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyWarningKind {
    UnknownField,
    InvalidValue,
    InvalidPath,
    UnsupportedService,
    CredentialOmitted,
    NeedsConfirmation,
    NotMigrated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LegacyWarning {
    pub kind: LegacyWarningKind,
    /// JSON key path, never the value of an unknown or secret field.
    pub path: String,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum LegacyError {
    #[error("无法读取所选旧配置文件：{0}")]
    Read(#[source] std::io::Error),
    #[error("旧配置文件超过 4 MiB 上限")]
    TooLarge,
    #[error("旧配置不是有效的 JSON：{0}")]
    Json(#[source] serde_json::Error),
    #[error("旧配置文件不是 UTF-8 文本")]
    Utf8,
    #[error("旧配置的顶层必须是对象")]
    NotObject,
    #[error("旧配置中的 {0} 超过数量上限")]
    TooMany(&'static str),
}

/// Read only a file chosen by the caller. No default path or credential path is searched.
pub fn preview_legacy_config_file(path: &Path) -> Result<LegacyPreview, LegacyError> {
    let file = fs::File::open(path).map_err(LegacyError::Read)?;
    let metadata = file.metadata().map_err(LegacyError::Read)?;
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(LegacyError::TooLarge);
    }
    // Bound the actual read as well: the selected file may grow after its
    // metadata is checked, or an unusual source may report a small length.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(LegacyError::Read)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(LegacyError::TooLarge);
    }
    let raw = std::str::from_utf8(&bytes).map_err(|_| LegacyError::Utf8)?;
    preview_legacy_config_json(raw)
}

/// Parse an in-memory copy of the old `config.json` without touching disk.
pub fn preview_legacy_config_json(raw: &str) -> Result<LegacyPreview, LegacyError> {
    if raw.len() > MAX_CONFIG_BYTES {
        return Err(LegacyError::TooLarge);
    }
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let value: Value = serde_json::from_str(raw).map_err(LegacyError::Json)?;
    let root = value.as_object().ok_or(LegacyError::NotObject)?;
    let mut preview = LegacyPreview {
        rules: legacy_rule_defaults(),
        room_id: None,
        gift_merge: LegacyGiftMerge::default(),
        selected_provider: None,
        provider_settings: Vec::new(),
        model_references: Vec::new(),
        voice_bindings: Vec::new(),
        sounds: Vec::new(),
        warnings: Vec::new(),
    };

    for name in root.keys() {
        if !KNOWN_GROUPS.contains(&name.as_str()) {
            warn(
                &mut preview,
                LegacyWarningKind::UnknownField,
                name,
                "未知配置分组，未导入",
            );
        }
    }
    for name in UNSUPPORTED_GROUPS {
        if root
            .get(*name)
            .is_some_and(|value| value.as_object().is_some_and(|map| !map.is_empty()))
        {
            warn(
                &mut preview,
                LegacyWarningKind::UnsupportedService,
                name,
                "旧服务不在本版四种服务中，设置未导入",
            );
        }
    }
    if let Some(bili) = object_group(root, "BiliService", &mut preview) {
        parse_bili(bili, &mut preview)?;
    }
    if let Some(tts) = object_group(root, "TTSService", &mut preview) {
        parse_active_tts(tts, &mut preview);
    }
    for (group, provider, safe) in PROVIDER_GROUPS {
        if let Some(settings) = object_group(root, group, &mut preview) {
            parse_provider(settings, group, *provider, safe, &mut preview)?;
        }
    }
    if let Some(player) = object_group(root, "Player", &mut preview) {
        for key in player.keys() {
            if key == "PlayerDevice" {
                warn(
                    &mut preview,
                    LegacyWarningKind::NotMigrated,
                    "Player.PlayerDevice",
                    "旧设备索引不稳定，请在新应用中重新选择输出设备",
                );
            } else {
                warn(
                    &mut preview,
                    LegacyWarningKind::UnknownField,
                    &format!("Player.{key}"),
                    "未知播放器设置，未导入",
                );
            }
        }
    }
    Ok(preview)
}

const KNOWN_GROUPS: &[&str] = &[
    "BiliService",
    "TTSService",
    "DotsTTSService",
    "GptSovitsService",
    "FishAudioService",
    "DoBaoTTSService",
    "Player",
    "MinimaxService",
    "FishSpeechService",
    "SeedTTSService",
    "PiperService",
    "EdgeService",
];
const UNSUPPORTED_GROUPS: &[&str] = &[
    "MinimaxService",
    "FishSpeechService",
    "SeedTTSService",
    "PiperService",
    "EdgeService",
];

#[derive(Clone, Copy)]
enum FieldType {
    String,
    Bool,
    Number,
    Object,
}

const DOTS_SETTINGS: &[(&str, FieldType)] = &[
    ("ApiUrl", FieldType::String),
    ("Voice", FieldType::String),
    ("PromptText", FieldType::String),
    ("Language", FieldType::String),
    ("NumSteps", FieldType::Number),
    ("NormalizeText", FieldType::Bool),
    ("Streaming", FieldType::Bool),
    ("Speed", FieldType::Number),
    ("Volume", FieldType::Number),
    ("Timeout", FieldType::Number),
];
const GPT_SETTINGS: &[(&str, FieldType)] = &[
    ("ApiUrl", FieldType::String),
    ("GptModel", FieldType::String),
    ("SovitsModel", FieldType::String),
    ("RefAudioPath", FieldType::String),
    ("RefText", FieldType::String),
    ("RefTextLang", FieldType::String),
    ("TextLang", FieldType::String),
    ("TopK", FieldType::Number),
    ("TopP", FieldType::Number),
    ("Temperature", FieldType::Number),
    ("TextSplitMethod", FieldType::String),
    ("SpeedFactor", FieldType::Number),
    ("RefTextFree", FieldType::Bool),
    ("SampleSteps", FieldType::Number),
    ("SuperSampling", FieldType::Bool),
    ("PauseSeconds", FieldType::Number),
    ("Streaming", FieldType::Bool),
];
const FISH_SETTINGS: &[(&str, FieldType)] = &[
    ("Model", FieldType::String),
    ("ReferenceId", FieldType::String),
    ("Voices", FieldType::Object),
    ("Streaming", FieldType::Bool),
    ("Speed", FieldType::Number),
    ("Volume", FieldType::Number),
    ("Temperature", FieldType::Number),
    ("TopP", FieldType::Number),
    ("Latency", FieldType::String),
    ("Timeout", FieldType::Number),
];
const DOBAO_SETTINGS: &[(&str, FieldType)] = &[
    ("Voice", FieldType::String),
    ("Speed", FieldType::Number),
    ("Timeout", FieldType::Number),
];
type ProviderGroup = (&'static str, Provider, &'static [(&'static str, FieldType)]);
const PROVIDER_GROUPS: &[ProviderGroup] = &[
    ("DotsTTSService", Provider::Dots, DOTS_SETTINGS),
    ("GptSovitsService", Provider::GptSovits, GPT_SETTINGS),
    ("FishAudioService", Provider::FishAudio, FISH_SETTINGS),
    ("DoBaoTTSService", Provider::Doubao, DOBAO_SETTINGS),
];

fn legacy_rule_defaults() -> RuleSet {
    let mut rules = RuleSet::default();
    rules.events.danmaku_on = false;
    rules.user_words.push(Replacement {
        from: "Merlin".into(),
        to: "么林".into(),
    });
    rules.templates.danmaku = "\"{user_name}\"说:\"{message}\"".into();
    rules.templates.gift = "\"{user_name}\" 赠送了{gift_num}个{gift_name}".into();
    rules.templates.super_chat = "\"{user_name}\" 发送了一条醒目留言,他说\"{message}\"".into();
    rules.templates.guard =
        "感谢 \"{user_name}\" 赠送的{guard_name},祝你熬夜不秃头,瞎吃不长胖!".into();
    rules
}

fn warn(preview: &mut LegacyPreview, kind: LegacyWarningKind, path: &str, message: &str) {
    preview.warnings.push(LegacyWarning {
        kind,
        path: path.into(),
        message: message.into(),
    });
}

fn object_group<'a>(
    root: &'a Map<String, Value>,
    name: &str,
    preview: &mut LegacyPreview,
) -> Option<&'a Map<String, Value>> {
    match root.get(name) {
        Some(Value::Object(map)) => Some(map),
        Some(_) => {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                name,
                "配置分组必须是对象，已跳过",
            );
            None
        }
        None => None,
    }
}

fn provider_name(value: &str) -> Option<Provider> {
    match value {
        "dots_tts" => Some(Provider::Dots),
        "gpt_sovits" => Some(Provider::GptSovits),
        "fish_audio" => Some(Provider::FishAudio),
        "dobao_tts" => Some(Provider::Doubao),
        _ => None,
    }
}

fn parse_active_tts(tts: &Map<String, Value>, preview: &mut LegacyPreview) {
    for (key, value) in tts {
        if key != "ActiveTTS" {
            warn(
                preview,
                LegacyWarningKind::UnknownField,
                &format!("TTSService.{key}"),
                "未知 TTS 设置，未导入",
            );
            continue;
        }
        match value.as_str().and_then(provider_name) {
            Some(provider) => preview.selected_provider = Some(provider),
            None => warn(
                preview,
                LegacyWarningKind::UnsupportedService,
                "TTSService.ActiveTTS",
                "旧默认服务不在本版四种服务中，请重新选择",
            ),
        }
    }
}

fn parse_bili(bili: &Map<String, Value>, preview: &mut LegacyPreview) -> Result<(), LegacyError> {
    const KEYS: &[&str] = &[
        "RoomId",
        "GiftThreshold",
        "FreeGiftOn",
        "NormalDanmakuOn",
        "GuardOn",
        "SuperChatOn",
        "SuperChatThreshold",
        "Debug",
        "WelcomeOn",
        "GiftOnText",
        "DanmakuOnText",
        "GuardOnText",
        "SuperChatOnText",
        "AliasDict",
        "MessageAliasDict",
        "AudioClipDict",
        "GiftMergeOn",
        "GiftMergeWindowInitial",
        "GiftMergeWindowIncrement",
        "GiftMergeWindow",
        "VoiceDict",
    ];
    for key in bili.keys() {
        if !KEYS.contains(&key.as_str()) {
            warn(
                preview,
                LegacyWarningKind::UnknownField,
                &format!("BiliService.{key}"),
                "未知 B 站设置，未导入",
            );
        }
    }
    if let Some(value) = bili.get("RoomId") {
        match value.as_u64().filter(|number| *number > 0) {
            Some(room) => preview.room_id = Some(room),
            None => warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "BiliService.RoomId",
                "房间号无效，请手动填写",
            ),
        }
    }
    assign_bool(
        bili,
        "FreeGiftOn",
        "BiliService",
        &mut preview.rules.events.free_gift_on,
        &mut preview.warnings,
    );
    assign_bool(
        bili,
        "NormalDanmakuOn",
        "BiliService",
        &mut preview.rules.events.danmaku_on,
        &mut preview.warnings,
    );
    assign_bool(
        bili,
        "GuardOn",
        "BiliService",
        &mut preview.rules.events.guard_on,
        &mut preview.warnings,
    );
    assign_bool(
        bili,
        "SuperChatOn",
        "BiliService",
        &mut preview.rules.events.super_chat_on,
        &mut preview.warnings,
    );
    assign_number(
        bili,
        "GiftThreshold",
        "BiliService",
        &mut preview.rules.events.gift_threshold_yuan,
        &mut preview.warnings,
    );
    assign_number(
        bili,
        "SuperChatThreshold",
        "BiliService",
        &mut preview.rules.events.super_chat_threshold_yuan,
        &mut preview.warnings,
    );
    assign_bool(
        bili,
        "GiftMergeOn",
        "BiliService",
        &mut preview.gift_merge.enabled,
        &mut preview.warnings,
    );
    assign_number(
        bili,
        "GiftMergeWindowInitial",
        "BiliService",
        &mut preview.gift_merge.initial_seconds,
        &mut preview.warnings,
    );
    assign_number(
        bili,
        "GiftMergeWindowIncrement",
        "BiliService",
        &mut preview.gift_merge.increment_seconds,
        &mut preview.warnings,
    );
    assign_number(
        bili,
        "GiftMergeWindow",
        "BiliService",
        &mut preview.gift_merge.maximum_seconds,
        &mut preview.warnings,
    );
    assign_string(
        bili,
        "DanmakuOnText",
        "BiliService",
        &mut preview.rules.templates.danmaku,
        &mut preview.warnings,
    );
    assign_string(
        bili,
        "GiftOnText",
        "BiliService",
        &mut preview.rules.templates.gift,
        &mut preview.warnings,
    );
    assign_string(
        bili,
        "GuardOnText",
        "BiliService",
        &mut preview.rules.templates.guard,
        &mut preview.warnings,
    );
    assign_string(
        bili,
        "SuperChatOnText",
        "BiliService",
        &mut preview.rules.templates.super_chat,
        &mut preview.warnings,
    );
    if bili.contains_key("AliasDict") {
        preview.rules.user_words = parse_replacements(
            bili.get("AliasDict"),
            "BiliService.AliasDict",
            &mut preview.warnings,
        )?;
    }
    if bili.contains_key("MessageAliasDict") {
        preview.rules.message_words = parse_replacements(
            bili.get("MessageAliasDict"),
            "BiliService.MessageAliasDict",
            &mut preview.warnings,
        )?;
    }
    parse_sounds(bili.get("AudioClipDict"), preview)?;
    for key in ["Debug", "WelcomeOn", "VoiceDict"] {
        if bili.contains_key(key) {
            warn(
                preview,
                LegacyWarningKind::NotMigrated,
                &format!("BiliService.{key}"),
                "此旧设置不适用于新版，未导入",
            );
        }
    }
    Ok(())
}

fn assign_bool(
    map: &Map<String, Value>,
    key: &str,
    group: &str,
    out: &mut bool,
    warnings: &mut Vec<LegacyWarning>,
) {
    if let Some(value) = map.get(key) {
        if let Some(parsed) = value.as_bool() {
            *out = parsed;
        } else {
            warnings.push(LegacyWarning {
                kind: LegacyWarningKind::InvalidValue,
                path: format!("{group}.{key}"),
                message: "预期布尔值，已保留旧版默认值".into(),
            });
        }
    }
}

fn assign_number(
    map: &Map<String, Value>,
    key: &str,
    group: &str,
    out: &mut f64,
    warnings: &mut Vec<LegacyWarning>,
) {
    if let Some(value) = map.get(key) {
        if let Some(parsed) = value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0)
        {
            *out = parsed;
        } else {
            warnings.push(LegacyWarning {
                kind: LegacyWarningKind::InvalidValue,
                path: format!("{group}.{key}"),
                message: "预期非负数，已保留旧版默认值".into(),
            });
        }
    }
}

fn assign_string(
    map: &Map<String, Value>,
    key: &str,
    group: &str,
    out: &mut String,
    warnings: &mut Vec<LegacyWarning>,
) {
    if let Some(value) = map.get(key) {
        if let Some(parsed) = value.as_str() {
            if validate_template(parsed).is_ok() {
                *out = parsed.into();
            } else {
                warnings.push(LegacyWarning {
                    kind: LegacyWarningKind::NotMigrated,
                    path: format!("{group}.{key}"),
                    message: "旧模板字段或格式与新版不兼容，已保留新版默认模板".into(),
                });
            }
        } else {
            warnings.push(LegacyWarning {
                kind: LegacyWarningKind::InvalidValue,
                path: format!("{group}.{key}"),
                message: "预期文本，已保留旧版默认值".into(),
            });
        }
    }
}

fn parse_replacements(
    value: Option<&Value>,
    path: &str,
    warnings: &mut Vec<LegacyWarning>,
) -> Result<Vec<Replacement>, LegacyError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(map) = value.as_object() else {
        warnings.push(LegacyWarning {
            kind: LegacyWarningKind::InvalidValue,
            path: path.into(),
            message: "词典必须是对象，已跳过".into(),
        });
        return Ok(Vec::new());
    };
    if map.len() > MAX_RULES {
        return Err(LegacyError::TooMany("词典"));
    }
    let mut replacements = Vec::new();
    for (from, to) in map {
        if from.is_empty() {
            warnings.push(LegacyWarning {
                kind: LegacyWarningKind::InvalidValue,
                path: path.into(),
                message: "空关键词不会匹配，已跳过".into(),
            });
        } else if let Some(to) = to.as_str() {
            replacements.push(Replacement {
                from: from.clone(),
                to: to.into(),
            });
        } else {
            warnings.push(LegacyWarning {
                kind: LegacyWarningKind::InvalidValue,
                path: format!("{path}.{from}"),
                message: "替换内容必须是文本，已跳过".into(),
            });
        }
    }
    Ok(replacements)
}

fn path_state(value: &str) -> LegacyPathState {
    if value.trim().is_empty() {
        return LegacyPathState::Empty;
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return LegacyPathState::Relative;
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => LegacyPathState::Present,
        Ok(_) => LegacyPathState::NotFile,
        Err(_) => LegacyPathState::Missing,
    }
}

fn parse_sounds(value: Option<&Value>, preview: &mut LegacyPreview) -> Result<(), LegacyError> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(map) = value.as_object() else {
        warn(
            preview,
            LegacyWarningKind::InvalidValue,
            "BiliService.AudioClipDict",
            "音效词典必须是对象，已跳过",
        );
        return Ok(());
    };
    if map.len() > MAX_RULES {
        return Err(LegacyError::TooMany("音效词典"));
    }
    let mut hashed_bytes = 0u64;
    for (trigger, value) in map {
        let Some(source_path) = value.as_str() else {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                &format!("BiliService.AudioClipDict.{trigger}"),
                "音效路径必须是文本，已跳过",
            );
            continue;
        };
        if trigger.is_empty() || source_path.is_empty() {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "BiliService.AudioClipDict",
                "空关键词或路径在旧版不会触发，已跳过",
            );
            continue;
        }
        let state = path_state(source_path);
        let mut source_sha256 = None;
        let mut source_bytes = None;
        if state != LegacyPathState::Present {
            warn(
                preview,
                LegacyWarningKind::InvalidPath,
                &format!("BiliService.AudioClipDict.{trigger}"),
                "音效文件不是可用的本机绝对文件，请在确认导入前修复",
            );
        } else {
            let size = fs::metadata(source_path).map_err(LegacyError::Read)?.len();
            if size > MAX_SOUND_BYTES || hashed_bytes.saturating_add(size) > MAX_PREVIEW_HASH_BYTES
            {
                warn(
                    preview,
                    LegacyWarningKind::InvalidPath,
                    &format!("BiliService.AudioClipDict.{trigger}"),
                    "音效超过预览校验预算，不能直接选择导入",
                );
            } else {
                source_sha256 = Some(sound_sha256(Path::new(source_path))?);
                source_bytes = Some(size);
                hashed_bytes += size;
            }
        }
        let preview_asset_id = format!("legacy-preview-only-sound-{}", preview.sounds.len());
        preview.rules.sounds.push(SoundRule {
            trigger: trigger.clone(),
            asset_id: preview_asset_id.clone(),
        });
        preview.sounds.push(LegacySound {
            trigger: trigger.clone(),
            source_path: source_path.into(),
            path_state: state,
            source_sha256,
            source_bytes,
            preview_asset_id,
        });
    }
    Ok(())
}

fn sound_sha256(path: &Path) -> Result<String, LegacyError> {
    let mut file = fs::File::open(path).map_err(LegacyError::Read)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(LegacyError::Read)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn valid_type(value: &Value, kind: FieldType) -> bool {
    match kind {
        FieldType::String => value.is_string(),
        FieldType::Bool => value.is_boolean(),
        FieldType::Number => value.as_f64().is_some_and(f64::is_finite),
        FieldType::Object => value.is_object(),
    }
}

fn parse_provider(
    settings: &Map<String, Value>,
    group: &str,
    provider: Provider,
    safe: &[(&str, FieldType)],
    preview: &mut LegacyPreview,
) -> Result<(), LegacyError> {
    let mut values = Vec::new();
    for (key, value) in settings {
        let path = format!("{group}.{key}");
        if key == "ApiKey" {
            warn(
                preview,
                LegacyWarningKind::CredentialOmitted,
                &path,
                "旧 API 密钥不会导入，请在新应用中单独授权",
            );
        } else if key == "FfmpegPath"
            || key == "InstallFolder"
            || (group == "DoBaoTTSService" && key == "ApiUrl")
        {
            warn(
                preview,
                LegacyWarningKind::NotMigrated,
                &path,
                "旧程序或服务路径不自动沿用，请重新配置",
            );
        } else if group == "GptSovitsService" && key == "ModelReferences" {
            parse_model_references(value, preview)?;
        } else if group == "GptSovitsService" && key == "UsernameModels" {
            parse_bindings(value, settings.get("UsernameModelsEnabled"), preview)?;
        } else if group == "GptSovitsService" && key == "UsernameModelsEnabled" {
            // Consumed with UsernameModels.
        } else if group == "GptSovitsService" && key == "RouteFromDots" {
            warn(
                preview,
                LegacyWarningKind::NotMigrated,
                &path,
                "旧路由开关已由独立用户绑定取代",
            );
        } else if let Some((_, kind)) = safe.iter().find(|(name, _)| *name == key.as_str()) {
            if valid_type(value, *kind) {
                if matches!(key.as_str(), "GptModel" | "SovitsModel" | "RefAudioPath")
                    && let Some(value) = value.as_str()
                {
                    let state = path_state(value);
                    if state != LegacyPathState::Present && state != LegacyPathState::Empty {
                        warn(
                            preview,
                            LegacyWarningKind::InvalidPath,
                            &path,
                            "本机未找到模型或参考文件；若为服务端路径，请在导入后确认",
                        );
                    }
                }
                if key == "ApiUrl"
                    && !value.as_str().is_some_and(|value| {
                        reqwest::Url::parse(value).is_ok_and(|url| {
                            matches!(url.scheme(), "http" | "https")
                                && url.host_str().is_some()
                                && url.username().is_empty()
                                && url.password().is_none()
                                && url.query().is_none()
                                && url.fragment().is_none()
                        })
                    })
                {
                    warn(
                        preview,
                        LegacyWarningKind::InvalidValue,
                        &path,
                        "服务地址无效或包含凭据、查询参数、片段，已跳过",
                    );
                } else {
                    values.push(LegacySetting {
                        key: key.clone(),
                        value: value.clone(),
                    });
                }
            } else {
                warn(
                    preview,
                    LegacyWarningKind::InvalidValue,
                    &path,
                    "旧设置类型无效，已跳过",
                );
            }
        } else {
            warn(
                preview,
                LegacyWarningKind::UnknownField,
                &path,
                "未知服务设置，未导入",
            );
        }
    }
    preview.provider_settings.push(LegacyProviderSettings {
        provider,
        old_group: group.into(),
        settings: values,
    });
    Ok(())
}

fn parse_model_references(value: &Value, preview: &mut LegacyPreview) -> Result<(), LegacyError> {
    let Some(map) = value.as_object() else {
        warn(
            preview,
            LegacyWarningKind::InvalidValue,
            "GptSovitsService.ModelReferences",
            "模型参考配置必须是对象，已跳过",
        );
        return Ok(());
    };
    if map.len() > MAX_BINDINGS {
        return Err(LegacyError::TooMany("模型参考配置"));
    }
    for (pair, value) in map {
        let Ok(paths) = serde_json::from_str::<Vec<String>>(pair) else {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "GptSovitsService.ModelReferences",
                "模型对键无法解析，已跳过",
            );
            continue;
        };
        if paths.len() != 2 {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "GptSovitsService.ModelReferences",
                "模型对需要 GPT 与 SoVITS 两条路径，已跳过",
            );
            continue;
        }
        let Some(entry) = value.as_object() else {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "GptSovitsService.ModelReferences",
                "参考配置必须是对象，已跳过",
            );
            continue;
        };
        for key in entry.keys() {
            if !["audio", "text", "language", "text_free"].contains(&key.as_str()) {
                warn(
                    preview,
                    LegacyWarningKind::UnknownField,
                    &format!("GptSovitsService.ModelReferences.{key}"),
                    "未知参考配置字段，未导入",
                );
            }
        }
        let audio = reference_text(entry, "audio", preview);
        let text = reference_text(entry, "text", preview);
        let language = reference_text(entry, "language", preview);
        let text_free = entry
            .get("text_free")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if entry
            .get("text_free")
            .is_some_and(|value| !value.is_boolean())
        {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "GptSovitsService.ModelReferences.text_free",
                "预期布尔值，已按 false 处理",
            );
        }
        let gpt_path_state = path_state(&paths[0]);
        let sovits_path_state = path_state(&paths[1]);
        let audio_path_state = path_state(&audio);
        if audio.is_empty() || (!text_free && text.is_empty()) {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "GptSovitsService.ModelReferences",
                "参考音频或必要的参考文本为空，使用此角色前需要补全",
            );
        }
        if [gpt_path_state, sovits_path_state, audio_path_state]
            .iter()
            .any(|state| !matches!(state, LegacyPathState::Present | LegacyPathState::Empty))
        {
            warn(
                preview,
                LegacyWarningKind::InvalidPath,
                "GptSovitsService.ModelReferences",
                "部分模型或参考文件在本机不可用；服务端路径需要人工核实",
            );
        }
        preview.model_references.push(LegacyModelReference {
            gpt_model: paths[0].clone(),
            sovits_model: paths[1].clone(),
            reference_audio: audio,
            reference_text: text,
            reference_language: language,
            text_free,
            gpt_path_state,
            sovits_path_state,
            audio_path_state,
        });
    }
    Ok(())
}

fn reference_text(entry: &Map<String, Value>, key: &str, preview: &mut LegacyPreview) -> String {
    match entry.get(key) {
        Some(Value::String(value)) => value.clone(),
        Some(_) => {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                &format!("GptSovitsService.ModelReferences.{key}"),
                "预期文本，已按空值处理",
            );
            String::new()
        }
        None if key == "language" => "auto".into(),
        None => String::new(),
    }
}

fn parse_bindings(
    value: &Value,
    master: Option<&Value>,
    preview: &mut LegacyPreview,
) -> Result<(), LegacyError> {
    let Some(map) = value.as_object() else {
        warn(
            preview,
            LegacyWarningKind::InvalidValue,
            "GptSovitsService.UsernameModels",
            "用户绑定必须是对象，已跳过",
        );
        return Ok(());
    };
    if map.len() > MAX_BINDINGS {
        return Err(LegacyError::TooMany("用户绑定"));
    }
    let master_enabled = master.and_then(Value::as_bool).unwrap_or(true);
    if master.is_some_and(|value| !value.is_boolean()) {
        warn(
            preview,
            LegacyWarningKind::InvalidValue,
            "GptSovitsService.UsernameModelsEnabled",
            "总开关类型无效，已按开启处理",
        );
    }
    for (name, value) in map {
        if name.trim().is_empty() {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                "GptSovitsService.UsernameModels",
                "空用户名无法绑定，已跳过",
            );
            continue;
        }
        let Some(record) = value.as_object() else {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                &format!("GptSovitsService.UsernameModels.{name}"),
                "绑定记录必须是对象，已跳过",
            );
            continue;
        };
        if record.is_empty() {
            continue;
        }
        for key in record.keys() {
            if ![
                "service",
                "enabled",
                "label",
                "reference_id",
                "voice",
                "speaker",
                "gpt",
                "sovits",
            ]
            .contains(&key.as_str())
            {
                warn(
                    preview,
                    LegacyWarningKind::UnknownField,
                    &format!("GptSovitsService.UsernameModels.{name}.{key}"),
                    "未知绑定字段，未导入",
                );
            }
        }
        let provider = match record.get("service") {
            Some(Value::String(value)) => provider_name(value),
            None => Some(Provider::GptSovits), // Old GPT records omitted service.
            _ => None,
        };
        if provider.is_none() {
            warn(
                preview,
                LegacyWarningKind::UnsupportedService,
                &format!("GptSovitsService.UsernameModels.{name}.service"),
                "绑定使用不支持的旧服务，保留预览但不能导入",
            );
        }
        let enabled = record
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if record
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
        {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                &format!("GptSovitsService.UsernameModels.{name}.enabled"),
                "独立开关类型无效，已按开启处理",
            );
        }
        let voice_id = match provider {
            Some(Provider::FishAudio) => optional_text(record, "reference_id", name, preview),
            Some(Provider::Doubao) => optional_text(record, "voice", name, preview),
            _ => None,
        };
        let gpt_model = if provider == Some(Provider::GptSovits) {
            optional_text(record, "gpt", name, preview)
        } else {
            None
        };
        let sovits_model = if provider == Some(Provider::GptSovits) {
            optional_text(record, "sovits", name, preview)
        } else {
            None
        };
        if provider == Some(Provider::GptSovits)
            && (gpt_model.as_deref().unwrap_or_default().is_empty()
                || sovits_model.as_deref().unwrap_or_default().is_empty())
        {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                &format!("GptSovitsService.UsernameModels.{name}"),
                "GPT-SoVITS 绑定缺少模型文件路径，需补全后才能使用",
            );
        }
        for (key, path) in [("gpt", &gpt_model), ("sovits", &sovits_model)] {
            if let Some(path) = path
                && !matches!(
                    path_state(path),
                    LegacyPathState::Present | LegacyPathState::Empty
                )
            {
                warn(
                    preview,
                    LegacyWarningKind::InvalidPath,
                    &format!("GptSovitsService.UsernameModels.{name}.{key}"),
                    "本机未找到模型文件；服务端路径需要人工核实",
                );
            }
        }
        let label = optional_text(record, "label", name, preview);
        preview.voice_bindings.push(LegacyVoiceBinding {
            old_user_name: name.clone(),
            provider,
            enabled,
            master_enabled,
            requires_uid_confirmation: true,
            label,
            voice_id,
            gpt_model,
            sovits_model,
        });
    }
    if !preview.voice_bindings.is_empty() {
        warn(
            preview,
            LegacyWarningKind::NeedsConfirmation,
            "GptSovitsService.UsernameModels",
            "旧绑定仅含用户名，必须确认平台 UID 后才能参与直播路由",
        );
    }
    Ok(())
}

fn optional_text(
    record: &Map<String, Value>,
    key: &str,
    name: &str,
    preview: &mut LegacyPreview,
) -> Option<String> {
    match record.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => {
            warn(
                preview,
                LegacyWarningKind::InvalidValue,
                &format!("GptSovitsService.UsernameModels.{name}.{key}"),
                "预期文本，已跳过",
            );
            None
        }
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LiveEvent;
    use crate::rules::PlanPart;

    #[test]
    fn previews_rules_with_old_scope_and_sound_order() {
        let input = r#"{
          "BiliService": {
            "RoomId": 42, "NormalDanmakuOn": true,
            "AliasDict": {"Alice":"小爱"},
            "MessageAliasDict": {"Alice":"艾丽丝","咕咕嘎嘎":"不应覆盖音频"},
            "AudioClipDict": {"咕咕":"C:/missing-short.wav","咕咕嘎嘎":"C:/missing-long.wav"},
            "DanmakuOnText": "{user_name}说：{message}，固定Alice",
            "GiftThreshold": 12, "GiftMergeOn": true
          }
        }"#;
        let preview = preview_legacy_config_json(input).unwrap();
        assert_eq!(preview.room_id, Some(42));
        assert_eq!(preview.rules.events.gift_threshold_yuan, 12.0);
        assert!(preview.gift_merge.enabled);
        let event = LiveEvent::danmaku(42, Some(7), "Alice", "Alice咕咕嘎嘎Alice");
        let result = preview.rules.preview(&event, &[], &[]).unwrap();
        assert_eq!(
            result.parts,
            vec![
                PlanPart::Text("小爱说：艾丽丝".into()),
                PlanPart::Sound {
                    trigger: "咕咕嘎嘎".into(),
                    asset_id: "legacy-preview-only-sound-1".into()
                },
                PlanPart::Text("艾丽丝，固定Alice".into()),
            ]
        );
        assert_eq!(preview.sounds.len(), 2);
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.kind == LegacyWarningKind::InvalidPath)
        );
    }

    #[test]
    fn omits_secrets_and_marks_name_bindings_pending() {
        let input = r#"{
          "TTSService": {"ActiveTTS":"fish_audio"},
          "FishAudioService": {"ApiKey":"private-fish-key","Model":"s2.1-pro-free","ReferenceId":"abc"},
          "DoBaoTTSService": {"InstallFolder":"C:/private","ApiUrl":"http://127.0.0.1:9882","Voice":"taozi"},
          "GptSovitsService": {"UsernameModelsEnabled":false,"UsernameModels":{
            "Alice":{"gpt":"C:/a.ckpt","sovits":"C:/a.pth"},
            "Bob":{"service":"seed_tts","speaker":"secret"}
          }}
        }"#;
        let preview = preview_legacy_config_json(input).unwrap();
        let encoded = serde_json::to_string(&preview).unwrap();
        assert!(!encoded.contains("private-fish-key"));
        assert!(!encoded.contains("C:/private"));
        assert!(!encoded.contains("secret"));
        assert_eq!(preview.selected_provider, Some(Provider::FishAudio));
        assert_eq!(preview.voice_bindings.len(), 2);
        assert_eq!(
            preview.voice_bindings[0].provider,
            Some(Provider::GptSovits)
        );
        assert!(preview.voice_bindings[0].requires_uid_confirmation);
        assert!(!preview.voice_bindings[0].master_enabled);
        assert_eq!(preview.voice_bindings[1].provider, None);
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.kind == LegacyWarningKind::CredentialOmitted)
        );
    }

    #[test]
    fn preview_omits_secrets_embedded_in_service_urls() {
        let preview = preview_legacy_config_json(
            r#"{"DotsTTSService":{"ApiUrl":"http://user:password@localhost:9881/tts?token=private-url-token#private-fragment","Voice":"ref.wav"}}"#,
        )
        .unwrap();
        let encoded = serde_json::to_string(&preview).unwrap();
        for secret in ["password", "private-url-token", "private-fragment"] {
            assert!(!encoded.contains(secret));
        }
        assert!(
            preview.provider_settings[0]
                .settings
                .iter()
                .all(|setting| setting.key != "ApiUrl")
        );
        assert!(preview.warnings.iter().any(|warning| {
            warning.path == "DotsTTSService.ApiUrl"
                && warning.kind == LegacyWarningKind::InvalidValue
        }));
    }

    #[test]
    fn reports_unknown_invalid_and_rejects_oversize() {
        let preview = preview_legacy_config_json(
            r#"{
          "BiliService":{"NormalDanmakuOn":"yes","Surprise":1,"AliasDict":{"ok":1}},
          "UnknownGroup":{"ApiKey":"hidden"},
          "TTSService":{"ActiveTTS":"edge"}
        }"#,
        )
        .unwrap();
        assert!(!preview.rules.events.danmaku_on);
        assert!(preview.rules.user_words.is_empty());
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.kind == LegacyWarningKind::UnknownField)
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.kind == LegacyWarningKind::InvalidValue)
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.kind == LegacyWarningKind::UnsupportedService)
        );
        assert!(!serde_json::to_string(&preview).unwrap().contains("hidden"));
        assert!(matches!(
            preview_legacy_config_json(&" ".repeat(MAX_CONFIG_BYTES + 1)),
            Err(LegacyError::TooLarge)
        ));
    }
}
