//! Versioned SQLite store in a caller-selected data directory.

use crate::audio::OutputSelection;
use crate::bilibili::BiliSession;
use crate::model::{LiveSettings, Provider, VoiceBinding, VoicePreset};
use crate::obs::ObsSettings;
use crate::rules::{RuleError, RulePreview, RuleSet};
use crate::secrets::{self, SecretBytes, SecretError};
use crate::tts::dobao::DoubaoDevice;
use crate::tts::fish::{self, FishPlaybackSettings};
use crate::voice_library::{ReferenceProfile, ReferenceRole};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

const CURRENT_SCHEMA: i64 = 6;
const MAX_ASSET_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DATABASE_BACKUPS: usize = 5;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("文件操作失败：{0} [DV-S01]")]
    Io(#[from] io::Error),
    #[error("数据库操作失败：{0} [DV-S02]")]
    Sql(#[from] rusqlite::Error),
    #[error("写入失败且回滚失败；原错误：{write}；回滚错误：{rollback} [DV-S47]")]
    WriteRollback {
        write: Box<StorageError>,
        rollback: rusqlite::Error,
    },
    #[error("配置格式错误：{0} [DV-S03]")]
    Json(#[from] serde_json::Error),
    #[error("不支持的数据库版本：{0} [DV-S04]")]
    UnsupportedSchema(i64),
    #[error("不支持的音频格式：{0} [DV-S05]")]
    UnsupportedAudio(String),
    #[error("音频素材超过 128 MiB 限制 [DV-S06]")]
    AssetTooLarge,
    #[error("素材仍被规则引用：{0} [DV-S07]")]
    AssetReferenced(String),
    #[error("素材不存在：{0} [DV-S08]")]
    AssetMissing(String),
    #[error("服务连接不存在：{0} [DV-S10]")]
    ConnectionMissing(String),
    #[error("声音预设不存在：{0} [DV-S11]")]
    PresetMissing(String),
    #[error("用户声音绑定不存在：{0} [DV-S12]")]
    BindingMissing(String),
    #[error("观众名称不能为空、超过 200 字，或包含前后空格与控制字符 [DV-S13]")]
    InvalidBindingName,
    #[error("此观众名称已有声音绑定，请编辑原有绑定 [DV-S14]")]
    DuplicateBindingName,
    #[error("此观众 UID 已有声音绑定，请编辑原有绑定 [DV-S15]")]
    DuplicateBindingUid,
    #[error("播报规则无效：{0}")]
    InvalidRules(#[from] RuleError),
    #[error("声音预设是当前默认声音，请先更换默认声音 [DV-S17]")]
    PresetIsDefault,
    #[error("声音预设仍被 {0} 条用户绑定引用 [DV-S18]")]
    PresetReferenced(i64),
    #[error("服务连接仍被 {0} 个声音预设引用 [DV-S19]")]
    ConnectionReferenced(i64),
    #[error("服务连接仍被声音预设引用，不能更换服务类型 [DV-S20]")]
    ConnectionProviderInUse,
    #[error("服务连接地址不能包含凭据、查询参数或片段 [DV-S21]")]
    CredentialsInUrl,
    #[error("服务连接地址无效 [DV-S22]")]
    InvalidEndpoint,
    #[error("服务连接超时无效：{0} [DV-S23]")]
    InvalidConnectionTimeout(&'static str),
    #[error("凭据保护失败：{0}")]
    Secret(#[from] SecretError),
    #[error("已保存的 B 站会话格式无效，请重新扫码 [DV-S25]")]
    InvalidBiliSession,
    #[error("直播设置无效 [DV-S26]")]
    InvalidLiveSettings,
    #[error("豆包设备标识无效，请检查本机数据目录 [DV-S27]")]
    InvalidDoubaoDevice,
    #[error("桌面偏好设置无效 [DV-S28]")]
    InvalidDesktopPreferences,
    #[error("参考音频路径无效、不可读或文件已删除 [DV-S29]")]
    ReferenceAudioUnavailable,
    #[error("参考配置无效或服务类型不匹配 [DV-S30]")]
    InvalidReferenceProfile,
    #[error("Fish Audio 参数无效或连接类型不匹配 [DV-S31]")]
    InvalidFishAudioSettings,
    #[error("dots.tts 参数无效或连接类型不匹配 [DV-S32]")]
    InvalidDotsSettings,
    #[error("Fish Audio 音色名称不能为空 [DV-S33]")]
    InvalidFishVoiceName,
    #[error("Fish Audio 音色 ID 或页面链接无效 [DV-S34]")]
    InvalidFishVoiceId,
    #[error("试听文本不能为空、不能超过 2000 字，且不能包含控制字符 [DV-S35]")]
    InvalidAuditionText,
    #[error("数据已重置，但数据库仍被其他实例占用；请关闭其他实例后重新清除 [DV-S36]")]
    DataResetBusy,
    #[error("OBS 叠加层设置无效 [DV-S37]")]
    InvalidOverlaySettings,
    #[error(
        "OBS 联动设置无效：地址只能是主机名或 IPv4，端口 1–65535，密码不超过 256 字且不含控制字符 [DV-S38]"
    )]
    InvalidObsSettings,
    #[error("备份版本或内容无效，请选择本应用导出的配置备份 [DV-S48]")]
    InvalidConfigurationBackup,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppearancePreference {
    Dark,
    Light,
    #[default]
    System,
}

/// Only observations made by this application, never Bilibili historical analytics.
/// An unfinished observation remains active across restarts; it is not a last session.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct BroadcastSessionRecord {
    pub active: Option<BroadcastSessionProgress>,
    pub last_session: Option<BroadcastSessionSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BroadcastSessionProgress {
    pub observation_run_id: String,
    pub started_at: Option<u64>,
    pub observed_started_at: u64,
    pub last_observed_at: u64,
    pub messages: u64,
    pub receiver: Option<BroadcastReceiverCursor>,
}

/// The receiver's cumulative count includes messages beyond the display buffer.
/// A run UUID and receiver epoch prevent reloads, reconnects and account switches
/// from adding an already-counted buffer again. This is not a credential.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BroadcastReceiverCursor {
    pub run_id: String,
    pub epoch: u64,
    pub received: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BroadcastSessionSummary {
    pub started_at: Option<u64>,
    pub observed_started_at: u64,
    pub ended_observed_at: u64,
    pub messages: u64,
    /// Exact distinct speakers for a fully observed runtime session. Older or
    /// interrupted sessions have no reconstructable identities, so remain unknown.
    #[serde(default)]
    pub unique_viewers: Option<u64>,
    /// Elapsed time to an observed ending. Unknown after an unobserved offline
    /// ending, or when Bilibili did not supply the current stream's start time.
    pub seconds: Option<u64>,
}

impl BroadcastSessionRecord {
    fn validate(&self) -> Result<(), StorageError> {
        if let Some(active) = &self.active
            && (active.observed_started_at == 0
                || Uuid::parse_str(&active.observation_run_id).is_err()
                || active.last_observed_at < active.observed_started_at
                || active
                    .started_at
                    .is_some_and(|start| start == 0 || start > active.last_observed_at)
                || active
                    .receiver
                    .as_ref()
                    .is_some_and(|cursor| Uuid::parse_str(&cursor.run_id).is_err()))
        {
            return Err(StorageError::InvalidLiveSettings);
        }
        if let Some(last) = &self.last_session
            && (last.observed_started_at == 0
                || last
                    .unique_viewers
                    .is_some_and(|count| count > last.messages)
                || last.ended_observed_at < last.observed_started_at
                || last
                    .started_at
                    .is_some_and(|start| start == 0 || start > last.ended_observed_at)
                || last.seconds.is_some_and(|seconds| {
                    last.started_at
                        .is_none_or(|start| seconds != last.ended_observed_at - start)
                }))
        {
            return Err(StorageError::InvalidLiveSettings);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum LanguagePreference {
    #[default]
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

/// Local UI choices. This deliberately excludes credentials and message history.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DesktopPreferences {
    pub appearance: AppearancePreference,
    pub language: LanguagePreference,
    pub scale: f32,
    pub output: OutputSelection,
    pub master_volume: f32,
    pub muted: bool,
    pub onboarding_done: bool,
    pub broadcaster_uid: Option<u64>,
    pub authenticated: bool,
    pub tts_enabled: bool,
    /// Experimental: show the broadcast console (open/close the own room) on the main screen.
    pub broadcast_console: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            appearance: AppearancePreference::System,
            language: LanguagePreference::Chinese,
            scale: 1.0,
            output: OutputSelection::Default,
            master_volume: 1.0,
            muted: false,
            onboarding_done: false,
            broadcaster_uid: None,
            authenticated: false,
            tts_enabled: true,
            broadcast_console: false,
        }
    }
}

impl DesktopPreferences {
    pub fn playback_volume(&self) -> f32 {
        if self.muted { 0.0 } else { self.master_volume }
    }

    /// Check an edited preference set before stopping playback or changing
    /// devices. Persistence uses the same validation again before writing.
    pub fn validate(&self) -> Result<(), StorageError> {
        if self.is_valid() {
            Ok(())
        } else {
            Err(StorageError::InvalidDesktopPreferences)
        }
    }

    fn is_valid(&self) -> bool {
        self.scale.is_finite()
            && self.broadcaster_uid != Some(0)
            && (0.8..=1.4).contains(&self.scale)
            && self.master_volume.is_finite()
            && (0.0..=2.0).contains(&self.master_volume)
            && match &self.output {
                OutputSelection::Default => true,
                OutputSelection::Named(name) => {
                    !name.trim().is_empty() && name.len() <= 512 && !name.contains('\0')
                }
            }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayStyle {
    /// A glass card wraps the masthead and the messages while anyone speaks.
    Card,
    /// The masthead and messages hang on one vertical line.
    #[default]
    Spine,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayCorner {
    #[default]
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayNames {
    /// Content only.
    None,
    /// Names only for gifts, Super Chat and guard purchases.
    #[default]
    Special,
    All,
}

pub const OVERLAY_DEFAULT_PORT: u16 = 47823;
pub const OVERLAY_DEFAULT_TITLE: &str = "今晚的弹幕";
pub const OVERLAY_TITLE_LIMIT: usize = 24;
pub const OVERLAY_DEFAULT_HISTORY_OPACITY: f32 = 0.72;
const OVERLAY_TAGLINE_LIMIT: usize = 64;

/// Experimental OBS browser-source overlay. The token only gates the local
/// loopback server; it is not an account credential and is not exported.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OverlaySettings {
    pub enabled: bool,
    pub style: OverlayStyle,
    pub corner: OverlayCorner,
    /// Browser-source pixels, positive toward the right and bottom. Kept
    /// independent of artwork scale and the selected corner.
    pub offset_x: i32,
    pub offset_y: i32,
    pub scale: f32,
    /// Darkness of the soft shade behind the corner, 0–1.
    pub vignette: f32,
    /// Opacity of the oldest line kept on the spine; the line between it and
    /// the newest sits proportionally closer to fully visible.
    pub history_opacity: f32,
    pub title: String,
    /// Shown while nobody is speaking. Empty means the built-in line.
    pub tagline: String,
    pub show_danmaku: bool,
    pub show_gift: bool,
    pub show_super_chat: bool,
    pub show_guard: bool,
    pub names: OverlayNames,
    pub merge_duplicates: bool,
    pub linger_seconds: u32,
    pub port: u16,
    pub token: String,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            style: OverlayStyle::Spine,
            corner: OverlayCorner::TopLeft,
            offset_x: 0,
            offset_y: 0,
            scale: 1.0,
            vignette: 0.6,
            history_opacity: OVERLAY_DEFAULT_HISTORY_OPACITY,
            title: OVERLAY_DEFAULT_TITLE.into(),
            tagline: String::new(),
            show_danmaku: true,
            show_gift: true,
            show_super_chat: true,
            show_guard: true,
            names: OverlayNames::Special,
            merge_duplicates: true,
            linger_seconds: 14,
            port: OVERLAY_DEFAULT_PORT,
            token: String::new(),
        }
    }
}

impl OverlaySettings {
    /// Preserve placement and content while retiring the older style controls.
    /// The legacy fields remain deserializable for existing local settings.
    /// The vignette is a control again (2026-10-18), so it is kept.
    pub fn with_lake_design(mut self) -> Self {
        self.style = OverlayStyle::Spine;
        self.linger_seconds = 14;
        self
    }

    pub fn validate(&self) -> Result<(), StorageError> {
        let text_ok = |text: &str, limit: usize| {
            text.chars().count() <= limit && !text.chars().any(char::is_control)
        };
        let valid = (-8192..=8192).contains(&self.offset_x)
            && (-8192..=8192).contains(&self.offset_y)
            && self.scale.is_finite()
            && (0.5..=2.0).contains(&self.scale)
            && self.vignette.is_finite()
            && (0.0..=1.0).contains(&self.vignette)
            && self.history_opacity.is_finite()
            && (0.3..=1.0).contains(&self.history_opacity)
            && !self.title.trim().is_empty()
            && text_ok(&self.title, OVERLAY_TITLE_LIMIT)
            && text_ok(&self.tagline, OVERLAY_TAGLINE_LIMIT)
            && (3..=120).contains(&self.linger_seconds)
            && self.port >= 1024
            && (self.token.is_empty()
                || (self.token.len() == 32
                    && self
                        .token
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))));
        if valid {
            Ok(())
        } else {
            Err(StorageError::InvalidOverlaySettings)
        }
    }

    /// Copy the user-editable fields and keep the server identity (port and
    /// token) owned by the application.
    pub fn with_edits_from(&self, edited: &OverlaySettings) -> OverlaySettings {
        OverlaySettings {
            title: edited.title.trim().to_owned(),
            tagline: edited.tagline.trim().to_owned(),
            port: self.port,
            token: self.token.clone(),
            ..edited.clone()
        }
        .with_lake_design()
    }
}

/// Only non-secret fields are serializable. API keys and Cookies are stored
/// separately as DPAPI blobs and never enter ordinary configuration export.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ConnectionSettings {
    Dots { endpoint: String, timeout_secs: u64 },
    GptSovits { endpoint: String, timeout_secs: u64 },
    FishAudio { timeout_secs: u64 },
    Doubao { timeout_secs: u64 },
}

impl ConnectionSettings {
    pub fn provider(&self) -> Provider {
        match self {
            Self::Dots { .. } => Provider::Dots,
            Self::GptSovits { .. } => Provider::GptSovits,
            Self::FishAudio { .. } => Provider::FishAudio,
            Self::Doubao { .. } => Provider::Doubao,
        }
    }

    fn validate(&self) -> Result<(), StorageError> {
        self.validate_export_safe()?;
        let (timeout, min, max, reason) = match self {
            Self::Dots { timeout_secs, .. }
            | Self::GptSovits { timeout_secs, .. }
            | Self::FishAudio { timeout_secs } => {
                (*timeout_secs, 5, 600, "此服务须在 5–600 秒之间")
            }
            Self::Doubao { timeout_secs } => (*timeout_secs, 1, 120, "豆包须在 1–120 秒之间"),
        };
        if !(min..=max).contains(&timeout) {
            return Err(StorageError::InvalidConnectionTimeout(reason));
        }
        Ok(())
    }

    fn validate_export_safe(&self) -> Result<(), StorageError> {
        let endpoint = match self {
            Self::Dots { endpoint, .. } | Self::GptSovits { endpoint, .. } => endpoint,
            _ => return Ok(()),
        };
        let url = reqwest::Url::parse(endpoint).map_err(|_| StorageError::InvalidEndpoint)?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(StorageError::InvalidEndpoint);
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(StorageError::CredentialsInUrl);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ServiceConnection {
    pub id: String,
    pub name: String,
    pub settings: ConnectionSettings,
    pub has_credential: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConfigurationExport {
    pub format_version: u32,
    pub rules: RuleSet,
    pub live_settings: LiveSettings,
    pub connections: Vec<ServiceConnection>,
    pub presets: Vec<VoicePreset>,
    pub bindings: Vec<VoiceBinding>,
    #[serde(default)]
    pub fish_audio_settings: BTreeMap<String, FishPlaybackSettings>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dots_settings: BTreeMap<String, DotsPlaybackSettings>,
}

/// Optional request parameters for one reviewed legacy dots.tts preset.
/// Empty text and zero steps retain the resident service's defaults.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DotsPlaybackSettings {
    pub prompt_text: String,
    pub language: String,
    pub num_steps: Option<u8>,
    pub normalize_text: bool,
}

impl Default for DotsPlaybackSettings {
    fn default() -> Self {
        Self {
            prompt_text: String::new(),
            language: String::new(),
            num_steps: None,
            normalize_text: true,
        }
    }
}

impl DotsPlaybackSettings {
    fn is_valid(&self) -> bool {
        self.num_steps.is_none_or(|steps| (1..=64).contains(&steps))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BindingRecord {
    pub id: String,
    pub binding: VoiceBinding,
}

pub struct DataStore {
    data_dir: PathBuf,
    conn: Connection,
    upgrade_backup: Option<PathBuf>,
}

impl DataStore {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self, StorageError> {
        let data_dir = data_dir.as_ref().to_path_buf();
        fs::create_dir_all(&data_dir)?;
        fs::create_dir_all(data_dir.join("assets"))?;
        fs::create_dir_all(data_dir.join("backups"))?;
        let db_path = data_dir.join("danmakuvoice.sqlite3");
        let mut conn = Connection::open(&db_path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;",
        )?;
        // Most opens (one per live event) only need this unlocked check.
        let upgrade_backup = if schema_version(&conn)? < CURRENT_SCHEMA {
            Self::upgrade(&mut conn, &data_dir, &db_path)?
        } else {
            None
        };
        let store = Self {
            data_dir,
            conn,
            upgrade_backup,
        };
        if store.upgrade_backup.is_some() {
            store.maintain_backups()?;
        }
        Ok(store)
    }

    /// Create or upgrade the schema under SQLite's write lock. Another
    /// instance may have finished either step after the unlocked version
    /// check, so the version is read again inside the transaction.
    fn upgrade(
        conn: &mut Connection,
        data_dir: &Path,
        db_path: &Path,
    ) -> Result<Option<PathBuf>, StorageError> {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version = schema_version(&tx)?;
        if version == CURRENT_SCHEMA {
            return Ok(None);
        }
        if version == 0 {
            let has_tables: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
                [], |row| row.get(0))?;
            if has_tables {
                return Err(StorageError::UnsupportedSchema(0));
            }
        }
        let upgrade_backup = if version > 0 {
            // The backup API cannot read through a connection that holds a
            // write transaction. The lock keeps the committed state fixed
            // while a second connection copies it.
            let source = Connection::open(db_path)?;
            source.busy_timeout(Duration::from_secs(5))?;
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let path = data_dir.join("backups").join(format!(
                "before-v{version}-to-v{CURRENT_SCHEMA}-{stamp}-{}.sqlite3",
                Uuid::new_v4()
            ));
            credential_free_backup(&source, &path)?;
            Some(path)
        } else {
            None
        };
        if version < 1 {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);\
                CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,\
                sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0));")?;
        }
        if version < 2 {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,\
                settings_json TEXT NOT NULL, protected_credential BLOB);\
                CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_id TEXT NOT NULL,\
                provider TEXT NOT NULL, settings_json TEXT NOT NULL,\
                FOREIGN KEY(connection_id) REFERENCES connections(id) ON DELETE RESTRICT);\
                CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, platform TEXT NOT NULL, user_id TEXT,\
                legacy_user_name TEXT, preset_id TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),\
                FOREIGN KEY(preset_id) REFERENCES presets(id) ON DELETE RESTRICT);")?;
        }
        if version < 3 {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS protected_secrets (key TEXT PRIMARY KEY, protected_value BLOB NOT NULL);")?;
        }
        if version < 4 {
            tx.execute_batch("CREATE TABLE IF NOT EXISTS reference_profiles (connection_id TEXT NOT NULL, role_key TEXT NOT NULL,
                provider TEXT NOT NULL, profile_json TEXT NOT NULL,
                PRIMARY KEY(connection_id, role_key),
                FOREIGN KEY(connection_id) REFERENCES connections(id) ON DELETE CASCADE);")?;
        } else if version == 4 {
            // A development-only v4 stored managed copies but not the
            // original path. Reuse an existing safe copy as a plain path;
            // missing/unsafe copies remain only in the pre-upgrade backup.
            // Never delete the old files during this migration.
            tx.execute_batch("ALTER TABLE reference_profiles RENAME TO reference_profiles_v4;
                CREATE TABLE reference_profiles (connection_id TEXT NOT NULL, role_key TEXT NOT NULL,
                provider TEXT NOT NULL, profile_json TEXT NOT NULL,
                PRIMARY KEY(connection_id, role_key),
                FOREIGN KEY(connection_id) REFERENCES connections(id) ON DELETE CASCADE);")?;
            let previous = {
                let mut statement = tx.prepare(
                    "SELECT connection_id,role_key,provider,profile_json FROM reference_profiles_v4",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (connection_id, role_key, provider, json) in previous {
                let mut profile: serde_json::Value = serde_json::from_str(&json)?;
                let fields = profile
                    .as_object_mut()
                    .ok_or(StorageError::InvalidReferenceProfile)?;
                let audio_id = fields
                    .remove("audio_id")
                    .and_then(|value| value.as_str().map(str::to_owned));
                let file_name: Option<String> = audio_id
                    .as_deref()
                    .map(|id| {
                        tx.query_row(
                            "SELECT file_name FROM reference_audio WHERE id=?1",
                            params![id],
                            |row| row.get(0),
                        )
                        .optional()
                    })
                    .transpose()?
                    .flatten();
                let Some(audio_path) = file_name
                    .as_deref()
                    .and_then(|name| existing_legacy_reference_path(data_dir, name))
                else {
                    continue;
                };
                fields.insert(
                    "audio_path".into(),
                    serde_json::Value::String(audio_path.to_string_lossy().into_owned()),
                );
                tx.execute(
                    "INSERT INTO reference_profiles(connection_id,role_key,provider,profile_json) VALUES(?1,?2,?3,?4)",
                    params![connection_id, role_key, provider, serde_json::to_string(&profile)?],
                )?;
            }
            tx.execute_batch("DROP TABLE reference_profiles_v4; DROP TABLE reference_audio;")?;
        }
        if version < 6 {
            // Older development databases may report an earlier version
            // while already carrying the column. Keep this upgrade
            // idempotent for those databases as well as released v5.
            let has_user_name: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM pragma_table_info('bindings') WHERE name='user_name' LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if has_user_name.is_none() {
                tx.execute_batch("ALTER TABLE bindings ADD COLUMN user_name TEXT;")?;
            }
            tx.execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS bindings_exact_name ON bindings(platform,user_name)
                 WHERE user_id IS NULL AND user_name IS NOT NULL;",
            )?;
        }
        tx.pragma_update(None, "user_version", CURRENT_SCHEMA)?;
        tx.commit()?;
        Ok(upgrade_backup)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
    pub fn upgrade_backup(&self) -> Option<&Path> {
        self.upgrade_backup.as_deref()
    }

    /// Caller must stop all live/playback work first. This commits the logical
    /// reset as one transaction and makes no backup. The application then
    /// removes its preflighted files and calls `purge_deleted_application_data`
    /// to erase deleted rows from the database file and WAL.
    pub fn clear_application_data(&mut self) -> Result<(), StorageError> {
        self.conn.execute_batch("PRAGMA secure_delete = ON;")?;
        let tx = self.conn.transaction()?;
        tx.execute_batch("DELETE FROM bindings; DELETE FROM presets; DELETE FROM reference_profiles; DELETE FROM connections; DELETE FROM assets; DELETE FROM settings; DELETE FROM protected_secrets;")?;
        tx.commit()?;
        self.upgrade_backup = None;
        Ok(())
    }

    /// Physical cleanup after a committed reset. A busy reader or an I/O
    /// failure may make this fail; the caller can retry without repeating the
    /// logical deletion or losing track of the files it already removed.
    pub fn purge_deleted_application_data(&mut self) -> Result<(), StorageError> {
        let busy: i64 = self
            .conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Err(StorageError::DataResetBusy);
        }
        self.conn.execute_batch("VACUUM;")?;
        let busy: i64 = self
            .conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Err(StorageError::DataResetBusy);
        }
        Ok(())
    }

    /// Keep all reads for one playback plan on the same SQLite WAL snapshot.
    /// The closure must only call read methods on this store. `BEGIN DEFERRED`
    /// pins the snapshot on its first query; a concurrent editor may commit,
    /// but later reads in this closure still see the earlier database version.
    pub fn with_read_snapshot<T, E>(&self, read: impl FnOnce(&Self) -> Result<T, E>) -> Result<T, E>
    where
        E: From<StorageError>,
    {
        let transaction = self
            .conn
            .unchecked_transaction()
            .map_err(StorageError::from)
            .map_err(E::from)?;
        let result = read(self);
        if result.is_ok() {
            transaction
                .commit()
                .map_err(StorageError::from)
                .map_err(E::from)?;
        }
        result
    }

    /// Group related database writes, including default-voice repair, into one
    /// commit. Nested store methods may open their own savepoints. The closure
    /// must not perform filesystem or network side effects.
    pub fn with_savepoint<T>(
        &mut self,
        write: impl FnOnce(&mut Self) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        self.in_savepoint("application_write", write)
    }

    /// The one savepoint helper for writes that call other store methods.
    /// A failure, including a failed RELEASE (the commit of an outermost
    /// savepoint), rolls the savepoint back. If an outermost savepoint still
    /// cannot be closed, the whole transaction is rolled back so the
    /// connection never stays inside an abandoned transaction.
    fn in_savepoint<T>(
        &mut self,
        name: &'static str,
        write: impl FnOnce(&mut Self) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let outermost = self.conn.is_autocommit();
        self.conn.execute_batch(&format!("SAVEPOINT {name}"))?;
        let write = match write(self).and_then(|value| {
            self.conn
                .execute_batch(&format!("RELEASE SAVEPOINT {name}"))?;
            Ok(value)
        }) {
            Ok(value) => return Ok(value),
            Err(write) => write,
        };
        match self.conn.execute_batch(&format!(
            "ROLLBACK TO SAVEPOINT {name}; RELEASE SAVEPOINT {name}"
        )) {
            Ok(()) => Err(write),
            Err(_)
                if outermost
                    && (self.conn.is_autocommit()
                        || self.conn.execute_batch("ROLLBACK").is_ok()) =>
            {
                Err(write)
            }
            Err(rollback) => Err(StorageError::WriteRollback {
                write: Box::new(write),
                rollback,
            }),
        }
    }

    /// Snapshot the current database before a user-confirmed legacy import.
    /// SQLite's backup API includes committed WAL content. Credentials are
    /// removed in memory before any snapshot is written to disk.
    pub fn backup_before_legacy_import(&self) -> Result<PathBuf, StorageError> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let path = self.data_dir.join("backups").join(format!(
            "before-legacy-import-{stamp}-{}.sqlite3",
            Uuid::new_v4()
        ));
        self.maintain_backups()?;
        credential_free_backup(&self.conn, &path)?;
        self.maintain_backups()?;
        Ok(path)
    }

    /// Preserve configuration recovery while revoking credentials from old
    /// snapshots. This runs at backup creation or explicit credential removal,
    /// never once per live event. Only our UUID-named snapshots are managed.
    fn maintain_backups(&self) -> Result<(), StorageError> {
        let directory = self.data_dir.join("backups");
        check_backup_entry(&directory, &self.data_dir.canonicalize()?)?;
        let root = directory.canonicalize()?;
        let mut snapshots = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name();
            if !name.to_str().is_some_and(is_database_backup) {
                continue;
            }
            let name = name
                .to_str()
                .ok_or_else(|| io::Error::other("备份名称无效"))?;
            let stem = name.trim_end_matches(".sqlite3");
            let stamp = stem
                .get(..stem.len() - 37)
                .and_then(|prefix| prefix.rsplit('-').next())
                .and_then(|stamp| stamp.parse::<u64>().ok())
                .ok_or_else(|| io::Error::other("备份时间无效"))?;
            let modified = entry.metadata()?.modified()?;
            let path = entry.path();
            check_backup_entry(&path, &root)?;
            let source =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            if backup_has_credentials(&source)? {
                let sanitized = root.join(format!(".sanitized-{}.tmp", Uuid::new_v4()));
                let result = credential_free_backup(&source, &sanitized);
                drop(source);
                if let Err(error) = result {
                    let _ = fs::remove_file(&sanitized);
                    return Err(error);
                }
                if let Err(error) = replace_backup(&sanitized, &path) {
                    let _ = fs::remove_file(&sanitized);
                    return Err(error.into());
                }
            }
            // Sanitizing an old file changes its mtime; retention follows the
            // original snapshot timestamp, not the order of cleanup writes.
            snapshots.push((stamp, modified, path));
        }
        snapshots.sort_by(|a, b| b.cmp(a));
        for (_, _, path) in snapshots.into_iter().skip(MAX_DATABASE_BACKUPS) {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    /// The importer uses a separate store connection so its immediate write
    /// lock can span every selected item while the original connection makes
    /// a consistent pre-import backup. Nested store operations use savepoints.
    pub(crate) fn begin_legacy_import_transaction(&mut self) -> Result<(), StorageError> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        Ok(())
    }

    pub(crate) fn finish_legacy_import_transaction(
        &mut self,
        commit: bool,
    ) -> Result<(), StorageError> {
        self.conn
            .execute_batch(if commit { "COMMIT" } else { "ROLLBACK" })?;
        Ok(())
    }

    pub fn save_rules(&mut self, rules: &RuleSet) -> Result<(), StorageError> {
        rules.validate()?;
        let json = serde_json::to_string(rules)?;
        let tx = self.conn.savepoint()?;
        for sound in &rules.sounds {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
                params![sound.asset_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::AssetMissing(sound.asset_id.clone()));
            }
        }
        tx.execute(
            "INSERT INTO settings(key,json) VALUES('rules',?1)\
            ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![json],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_rules(&self) -> Result<RuleSet, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM settings WHERE key='rules'", [], |row| {
                row.get(0)
            })
            .optional()?;
        match json {
            Some(value) => Ok(serde_json::from_str(&value)?),
            None => Ok(RuleSet::default()),
        }
    }

    pub fn save_live_settings(&mut self, settings: &LiveSettings) -> Result<(), StorageError> {
        if settings.room_id == Some(0) || !settings.gift_merge.is_valid() {
            return Err(StorageError::InvalidLiveSettings);
        }
        let json = serde_json::to_string(settings)?;
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES('live',?1)\
            ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![json],
        )?;
        Ok(())
    }

    pub fn load_live_settings(&self) -> Result<LiveSettings, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM settings WHERE key='live'", [], |row| {
                row.get(0)
            })
            .optional()?;
        let settings: LiveSettings = match json {
            Some(value) => serde_json::from_str(&value)?,
            None => LiveSettings::default(),
        };
        if settings.room_id == Some(0) || !settings.gift_merge.is_valid() {
            return Err(StorageError::InvalidLiveSettings);
        }
        Ok(settings)
    }

    pub fn save_overlay_settings(
        &mut self,
        settings: &OverlaySettings,
    ) -> Result<(), StorageError> {
        settings.validate()?;
        let json = serde_json::to_string(settings)?;
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES('overlay',?1)\
            ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![json],
        )?;
        Ok(())
    }

    pub fn load_overlay_settings(&self) -> Result<OverlaySettings, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM settings WHERE key='overlay'", [], |row| {
                row.get(0)
            })
            .optional()?;
        let settings = match json {
            Some(value) => serde_json::from_str(&value)?,
            None => OverlaySettings::default(),
        };
        settings.validate()?;
        Ok(settings)
    }

    /// OBS remote-control choices (experimental broadcast console). The
    /// WebSocket password lives separately in `protected_secrets`.
    pub fn save_obs_settings(&mut self, settings: &ObsSettings) -> Result<(), StorageError> {
        if !settings.is_valid() {
            return Err(StorageError::InvalidObsSettings);
        }
        let json = serde_json::to_string(settings)?;
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES('obs',?1)\
            ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![json],
        )?;
        Ok(())
    }

    pub fn load_obs_settings(&self) -> Result<ObsSettings, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM settings WHERE key='obs'", [], |row| {
                row.get(0)
            })
            .optional()?;
        let settings = match json {
            Some(value) => serde_json::from_str(&value)?,
            None => ObsSettings::default(),
        };
        if !settings.is_valid() {
            return Err(StorageError::InvalidObsSettings);
        }
        Ok(settings)
    }

    /// Replace (or with an empty value, remove) the OBS WebSocket password.
    /// It is DPAPI-protected like other credentials and never exported.
    pub fn save_obs_password(&mut self, password: &str) -> Result<(), StorageError> {
        if password.is_empty() {
            self.maintain_backups()?;
            self.conn.execute(
                "DELETE FROM protected_secrets WHERE key='obs_websocket'",
                [],
            )?;
            return Ok(());
        }
        if password.chars().count() > 256 || password.chars().any(char::is_control) {
            return Err(StorageError::InvalidObsSettings);
        }
        let protected = secrets::protect(password.as_bytes())?;
        self.conn.execute(
            "INSERT INTO protected_secrets(key,protected_value) VALUES('obs_websocket',?1)\
            ON CONFLICT(key) DO UPDATE SET protected_value=excluded.protected_value",
            params![protected],
        )?;
        Ok(())
    }

    pub fn has_obs_password(&self) -> Result<bool, StorageError> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM protected_secrets WHERE key='obs_websocket'",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn load_obs_password(&self) -> Result<Option<Zeroizing<String>>, StorageError> {
        let protected: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT protected_value FROM protected_secrets WHERE key='obs_websocket'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(protected) = protected else {
            return Ok(None);
        };
        let plaintext = secrets::unprotect(&protected)?;
        let text = plaintext.as_str().map_err(StorageError::from)?;
        Ok(Some(Zeroizing::new(text.to_owned())))
    }

    pub fn save_desktop_preferences(
        &mut self,
        preferences: &DesktopPreferences,
    ) -> Result<(), StorageError> {
        preferences.validate()?;
        let json = serde_json::to_string(preferences)?;
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES('desktop',?1)\
            ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![json],
        )?;
        Ok(())
    }

    pub fn load_desktop_preferences(&self) -> Result<DesktopPreferences, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM settings WHERE key='desktop'", [], |row| {
                row.get(0)
            })
            .optional()?;
        let preferences = match json {
            Some(value) => serde_json::from_str(&value)?,
            None => DesktopPreferences::default(),
        };
        preferences.validate()?;
        Ok(preferences)
    }

    /// Local stream observations are scoped to the authenticated owner and own
    /// room. Keep them outside shareable configuration exports and secret rows.
    pub fn load_broadcast_session(
        &self,
        account_uid: u64,
        room_id: u64,
    ) -> Result<Option<BroadcastSessionRecord>, StorageError> {
        if account_uid == 0 || room_id == 0 {
            return Err(StorageError::InvalidLiveSettings);
        }
        let key = format!("broadcast.session:{account_uid}:{room_id}");
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT json FROM settings WHERE key=?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        let record: Option<BroadcastSessionRecord> =
            json.map(|json| serde_json::from_str(&json)).transpose()?;
        if let Some(record) = &record {
            record.validate()?;
        }
        Ok(record)
    }

    /// One row atomically holds both the unfinished observation and last ending.
    pub fn save_broadcast_session(
        &mut self,
        account_uid: u64,
        room_id: u64,
        record: &BroadcastSessionRecord,
    ) -> Result<(), StorageError> {
        if account_uid == 0 || room_id == 0 {
            return Err(StorageError::InvalidLiveSettings);
        }
        record.validate()?;
        let key = format!("broadcast.session:{account_uid}:{room_id}");
        let json = serde_json::to_string(record)?;
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![key, json],
        )?;
        Ok(())
    }

    /// Store only a user-confirmed QR session. The serialized plaintext is
    /// zeroized after DPAPI protection and never enters configuration export.
    pub fn save_bili_session(&mut self, session: &BiliSession) -> Result<(), StorageError> {
        let payload = Zeroizing::new(
            session
                .secret_payload()
                .map_err(|_| StorageError::InvalidBiliSession)?,
        );
        let protected = secrets::protect(&payload)?;
        self.conn.execute(
            "INSERT INTO protected_secrets(key,protected_value) VALUES('bilibili',?1)\
            ON CONFLICT(key) DO UPDATE SET protected_value=excluded.protected_value",
            params![protected],
        )?;
        Ok(())
    }

    pub fn load_bili_session(&self) -> Result<Option<BiliSession>, StorageError> {
        let protected: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT protected_value FROM protected_secrets WHERE key='bilibili'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match protected {
            Some(value) => {
                let plaintext = secrets::unprotect(&value)?;
                BiliSession::from_secret_payload(plaintext.as_bytes())
                    .map(Some)
                    .map_err(|_| StorageError::InvalidBiliSession)
            }
            None => Ok(None),
        }
    }

    pub fn clear_bili_session(&mut self) -> Result<bool, StorageError> {
        self.maintain_backups()?;
        let changed = self
            .conn
            .execute("DELETE FROM protected_secrets WHERE key='bilibili'", [])?;
        Ok(changed > 0)
    }

    /// Generate the web identity only once per data directory. Its protected
    /// value is separate from credentials and excluded from normal export.
    pub fn load_or_create_dobao_device(&mut self) -> Result<DoubaoDevice, StorageError> {
        if let Some(device) = self.load_dobao_device()? {
            return Ok(device);
        }
        let generated = DoubaoDevice::generate();
        generated
            .validate()
            .map_err(|_| StorageError::InvalidDoubaoDevice)?;
        let plaintext = Zeroizing::new(serde_json::to_vec(&generated)?);
        let protected = secrets::protect(&plaintext)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO protected_secrets(key,protected_value) VALUES('dobao_device',?1)",
            params![protected],
        )?;
        self.load_dobao_device()?
            .ok_or(StorageError::InvalidDoubaoDevice)
    }

    fn load_dobao_device(&self) -> Result<Option<DoubaoDevice>, StorageError> {
        let protected: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT protected_value FROM protected_secrets WHERE key='dobao_device'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(protected) = protected else {
            return Ok(None);
        };
        let plaintext = secrets::unprotect(&protected)?;
        let device: DoubaoDevice = serde_json::from_slice(plaintext.as_bytes())
            .map_err(|_| StorageError::InvalidDoubaoDevice)?;
        device
            .validate()
            .map_err(|_| StorageError::InvalidDoubaoDevice)?;
        Ok(Some(device))
    }

    pub fn save_connection(&mut self, connection: &ServiceConnection) -> Result<(), StorageError> {
        self.save_connection_with_credential(connection, None)
    }

    /// Atomically save connection metadata and an explicitly supplied
    /// credential. Encryption finishes before any database mutation; a failed
    /// insert or credential update rolls back the entire savepoint.
    pub fn save_connection_with_credential(
        &mut self,
        connection: &ServiceConnection,
        credential: Option<&[u8]>,
    ) -> Result<(), StorageError> {
        connection.settings.validate()?;
        let protected = credential.map(secrets::protect).transpose()?;
        let provider = provider_name(connection.settings.provider());
        let json = serde_json::to_string(&connection.settings)?;
        let tx = self.conn.savepoint()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT provider FROM connections WHERE id=?1",
                params![connection.id],
                |row| row.get(0),
            )
            .optional()?;
        if existing
            .as_deref()
            .is_some_and(|previous| previous != provider)
        {
            let references: i64 = tx.query_row(
                "SELECT COUNT(*) FROM presets WHERE connection_id=?1",
                params![connection.id],
                |row| row.get(0),
            )?;
            if references > 0 {
                return Err(StorageError::ConnectionProviderInUse);
            }
        }
        tx.execute("INSERT INTO connections(id,name,provider,settings_json,protected_credential) VALUES(?1,?2,?3,?4,NULL)\
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,settings_json=excluded.settings_json,\
            protected_credential=CASE WHEN connections.provider=excluded.provider THEN connections.protected_credential ELSE NULL END",
            params![connection.id, connection.name, provider, json])?;
        if let Some(protected) = protected {
            tx.execute(
                "UPDATE connections SET protected_credential=?1 WHERE id=?2",
                params![protected, connection.id],
            )?;
        }
        if existing.as_deref() == Some("fish_audio") && provider != "fish_audio" {
            tx.execute(
                "DELETE FROM settings WHERE key=?1",
                params![fish_settings_key(&connection.id)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn connections(&self) -> Result<Vec<ServiceConnection>, StorageError> {
        let mut statement = self.conn.prepare("SELECT id,name,provider,settings_json,protected_credential IS NOT NULL FROM connections ORDER BY name,id")?;
        let rows = statement.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let provider: String = row.get(2)?;
            let json: String = row.get(3)?;
            let has_credential: bool = row.get(4)?;
            Ok((id, name, provider, json, has_credential))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (id, name, provider, json, has_credential) = row?;
            let settings: ConnectionSettings = serde_json::from_str(&json)?;
            if provider != provider_name(settings.provider()) {
                return Err(StorageError::InvalidEndpoint);
            }
            result.push(ServiceConnection {
                id,
                name,
                settings,
                has_credential,
            });
        }
        Ok(result)
    }

    pub fn delete_connection(&mut self, id: &str) -> Result<(), StorageError> {
        self.maintain_backups()?;
        let references: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM presets WHERE connection_id=?1",
            params![id],
            |row| row.get(0),
        )?;
        if references > 0 {
            return Err(StorageError::ConnectionReferenced(references));
        }
        let tx = self.conn.transaction()?;
        let changed = tx.execute("DELETE FROM connections WHERE id=?1", params![id])?;
        if changed == 0 {
            return Err(StorageError::ConnectionMissing(id.to_owned()));
        }
        tx.execute(
            "DELETE FROM settings WHERE key=?1",
            params![fish_settings_key(id)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Keep legacy dots.tts request options tied to its reviewed voice. A new
    /// voice on the same connection must not inherit the old reference text.
    pub fn dots_playback_settings(
        &self,
        preset_id: &str,
    ) -> Result<DotsPlaybackSettings, StorageError> {
        // Playback can prepare an ephemeral audition preset that has no saved
        // row. Such voices use service defaults rather than legacy options.
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT json FROM settings WHERE key=?1",
                params![dots_settings_key(preset_id)],
                |row| row.get(0),
            )
            .optional()?;
        let settings: DotsPlaybackSettings = json
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_default();
        if !settings.is_valid() {
            return Err(StorageError::InvalidDotsSettings);
        }
        Ok(settings)
    }

    pub fn save_dots_playback_settings(
        &mut self,
        preset_id: &str,
        settings: &DotsPlaybackSettings,
    ) -> Result<(), StorageError> {
        self.require_dots_preset(preset_id)?;
        if !settings.is_valid() {
            return Err(StorageError::InvalidDotsSettings);
        }
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![dots_settings_key(preset_id), serde_json::to_string(settings)?],
        )?;
        Ok(())
    }

    fn require_dots_preset(&self, preset_id: &str) -> Result<(), StorageError> {
        let provider: Option<String> = self
            .conn
            .query_row(
                "SELECT provider FROM presets WHERE id=?1",
                params![preset_id],
                |row| row.get(0),
            )
            .optional()?;
        match provider.as_deref() {
            Some("dots") => Ok(()),
            Some(_) => Err(StorageError::InvalidDotsSettings),
            None => Err(StorageError::PresetMissing(preset_id.to_owned())),
        }
    }

    /// Read the non-secret Fish generation options for one connection.
    /// Older stores receive the same defaults as the legacy application.
    pub fn fish_audio_settings(
        &self,
        connection_id: &str,
    ) -> Result<FishPlaybackSettings, StorageError> {
        self.require_fish_connection(connection_id)?;
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT json FROM settings WHERE key=?1",
                params![fish_settings_key(connection_id)],
                |row| row.get(0),
            )
            .optional()?;
        let settings: FishPlaybackSettings = json
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_default();
        if !settings.is_valid() {
            return Err(StorageError::InvalidFishAudioSettings);
        }
        Ok(settings)
    }

    pub fn save_fish_audio_settings(
        &mut self,
        connection_id: &str,
        settings: &FishPlaybackSettings,
    ) -> Result<(), StorageError> {
        self.require_fish_connection(connection_id)?;
        if !settings.is_valid() {
            return Err(StorageError::InvalidFishAudioSettings);
        }
        self.conn.execute(
            "INSERT INTO settings(key,json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
            params![fish_settings_key(connection_id), serde_json::to_string(settings)?],
        )?;
        Ok(())
    }

    fn require_fish_connection(&self, connection_id: &str) -> Result<(), StorageError> {
        let provider: Option<String> = self
            .conn
            .query_row(
                "SELECT provider FROM connections WHERE id=?1",
                params![connection_id],
                |row| row.get(0),
            )
            .optional()?;
        match provider.as_deref() {
            Some("fish_audio") => Ok(()),
            Some(_) => Err(StorageError::InvalidFishAudioSettings),
            None => Err(StorageError::ConnectionMissing(connection_id.to_owned())),
        }
    }

    /// Add or rename one Fish voice. Matching IDs retain their preset ID,
    /// speech settings, default selection and user bindings.
    pub fn save_fish_voice(
        &mut self,
        connection_id: &str,
        id_or_url: &str,
        name: &str,
    ) -> Result<VoicePreset, StorageError> {
        self.require_fish_connection(connection_id)?;
        let voice_id =
            fish::normalize_voice_id(id_or_url).map_err(|_| StorageError::InvalidFishVoiceId)?;
        let name = name.trim();
        if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return Err(StorageError::InvalidFishVoiceName);
        }
        let mut preset = self
            .presets()?
            .into_iter()
            .find(|preset| {
                preset.connection_id == connection_id
                    && preset.provider == Provider::FishAudio
                    && fish::normalize_voice_id(&preset.voice_id).ok().as_deref()
                        == Some(voice_id.as_str())
            })
            .unwrap_or_else(|| VoicePreset {
                id: Uuid::new_v4().to_string(),
                name: String::new(),
                connection_id: connection_id.to_owned(),
                provider: Provider::FishAudio,
                voice_id: voice_id.clone(),
                speed: 1.0,
                volume: 1.0,
                sovits: None,
            });
        preset.name = name.to_owned();
        preset.voice_id = voice_id;
        self.save_preset(&preset)?;
        Ok(preset)
    }

    /// Restore only absent shipped voices. User-renamed presets are preserved.
    pub fn restore_builtin_fish_voices(
        &mut self,
        connection_id: &str,
    ) -> Result<Vec<VoicePreset>, StorageError> {
        self.require_fish_connection(connection_id)?;
        let existing = self.presets()?;
        let mut created = Vec::new();
        for (voice_id, name) in fish::BUILTIN_VOICES {
            if existing.iter().any(|preset| {
                preset.connection_id == connection_id
                    && preset.provider == Provider::FishAudio
                    && fish::normalize_voice_id(&preset.voice_id).ok().as_deref() == Some(voice_id)
            }) {
                continue;
            }
            created.push(self.save_fish_voice(connection_id, voice_id, name)?);
        }
        Ok(created)
    }

    /// Called only after a user explicitly supplies or authorizes this
    /// credential. The secret is never interpolated into SQL or error text.
    pub fn set_connection_credential(
        &mut self,
        id: &str,
        secret: &[u8],
    ) -> Result<(), StorageError> {
        let protected = secrets::protect(secret)?;
        let changed = self.conn.execute(
            "UPDATE connections SET protected_credential=?1 WHERE id=?2",
            params![protected, id],
        )?;
        if changed == 0 {
            return Err(StorageError::ConnectionMissing(id.to_owned()));
        }
        Ok(())
    }

    pub fn connection_credential(&self, id: &str) -> Result<Option<SecretBytes>, StorageError> {
        let blob: Option<Option<Vec<u8>>> = self
            .conn
            .query_row(
                "SELECT protected_credential FROM connections WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        match blob {
            None => Err(StorageError::ConnectionMissing(id.to_owned())),
            Some(None) => Ok(None),
            Some(Some(value)) => Ok(Some(secrets::unprotect(&value)?)),
        }
    }

    pub fn clear_connection_credential(&mut self, id: &str) -> Result<bool, StorageError> {
        self.maintain_backups()?;
        let existing: Option<bool> = self
            .conn
            .query_row(
                "SELECT protected_credential IS NOT NULL FROM connections WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(had_credential) = existing else {
            return Err(StorageError::ConnectionMissing(id.to_owned()));
        };
        if had_credential {
            self.conn.execute(
                "UPDATE connections SET protected_credential=NULL WHERE id=?1",
                params![id],
            )?;
        }
        Ok(had_credential)
    }

    pub fn save_preset(&mut self, preset: &VoicePreset) -> Result<(), StorageError> {
        let connection_provider: Option<String> = self
            .conn
            .query_row(
                "SELECT provider FROM connections WHERE id=?1",
                params![preset.connection_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(connection_provider) = connection_provider else {
            return Err(StorageError::ConnectionMissing(
                preset.connection_id.clone(),
            ));
        };
        if connection_provider != provider_name(preset.provider) {
            return Err(StorageError::InvalidEndpoint);
        }
        let json = serde_json::to_string(preset)?;
        let tx = self.conn.savepoint()?;
        let prior_json: Option<String> = tx
            .query_row(
                "SELECT settings_json FROM presets WHERE id=?1",
                params![preset.id],
                |row| row.get(0),
            )
            .optional()?;
        let changed_voice = prior_json
            .map(|json| serde_json::from_str::<VoicePreset>(&json))
            .transpose()?
            .is_some_and(|prior| {
                prior.provider != preset.provider
                    || prior.connection_id != preset.connection_id
                    || prior.voice_id != preset.voice_id
            });
        tx.execute("INSERT INTO presets(id,name,connection_id,provider,settings_json) VALUES(?1,?2,?3,?4,?5)\
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,connection_id=excluded.connection_id,provider=excluded.provider,settings_json=excluded.settings_json",
            params![preset.id, preset.name, preset.connection_id, connection_provider, json])?;
        if changed_voice {
            tx.execute(
                "DELETE FROM settings WHERE key=?1",
                params![dots_settings_key(&preset.id)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn presets(&self) -> Result<Vec<VoicePreset>, StorageError> {
        let mut statement = self
            .conn
            .prepare("SELECT settings_json FROM presets ORDER BY name,id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    /// Build a direct audition from a persisted preset ID. The caller may
    /// prepare and enqueue it as JobOrigin::Audition; rules and bindings remain
    /// untouched, including the default preset.
    pub fn voice_audition_preview(
        &self,
        preset_id: &str,
        text: &str,
    ) -> Result<RulePreview, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT settings_json FROM presets WHERE id=?1",
                params![preset_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(json) = json else {
            return Err(StorageError::PresetMissing(preset_id.to_owned()));
        };
        let preset: VoicePreset = serde_json::from_str(&json)?;
        RulePreview::voice_audition(preset, text).map_err(|_| StorageError::InvalidAuditionText)
    }

    pub fn delete_preset(&mut self, id: &str) -> Result<(), StorageError> {
        // Check the default choice and bindings in the same transaction as
        // the delete, so another connection cannot add a reference between.
        self.in_savepoint("delete_preset", |store| {
            let mut rules = store.load_rules()?;
            if rules.default_preset_id.as_deref() == Some(id) {
                return Err(StorageError::PresetIsDefault);
            }
            let references: i64 = store.conn.query_row(
                "SELECT COUNT(*) FROM bindings WHERE preset_id=?1",
                params![id],
                |row| row.get(0),
            )?;
            if references > 0 {
                return Err(StorageError::PresetReferenced(references));
            }
            let changed = store
                .conn
                .execute("DELETE FROM presets WHERE id=?1", params![id])?;
            if changed == 0 {
                return Err(StorageError::PresetMissing(id.to_owned()));
            }
            store.conn.execute(
                "DELETE FROM settings WHERE key=?1",
                params![dots_settings_key(id)],
            )?;
            let remembered = rules.preferred_presets.len();
            rules
                .preferred_presets
                .retain(|_, preset_id| preset_id != id);
            if rules.preferred_presets.len() != remembered {
                store.save_rules(&rules)?;
            }
            Ok(())
        })
    }

    pub fn save_binding(&mut self, id: &str, binding: &VoiceBinding) -> Result<(), StorageError> {
        // Serialize the UID check and upsert across independent DataStore
        // connections. A UNIQUE index cannot be added while historical rows
        // with the same UID must remain available for correction.
        let tx = self.conn.savepoint()?;
        if let Some(user_id) = binding.user_id {
            // Older databases can already contain duplicate UIDs. Retain all
            // those rows and allow editing either existing row in place, so
            // the user can disable or correct them without an upgrade failure.
            let prior: Option<(String, Option<String>)> = tx
                .query_row(
                    "SELECT platform,user_id FROM bindings WHERE id=?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let unchanged_identity = prior.as_ref().is_some_and(|(platform, prior_id)| {
                platform == &binding.platform
                    && prior_id
                        .as_deref()
                        .and_then(|value| value.parse::<u64>().ok())
                        == Some(user_id)
            });
            if !unchanged_identity {
                let mut statement = tx.prepare(
                    "SELECT user_id FROM bindings WHERE platform=?1 AND id<>?2 AND user_id IS NOT NULL",
                )?;
                let duplicates = statement
                    .query_map(params![binding.platform, id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                if duplicates
                    .iter()
                    .any(|value| value.parse::<u64>().ok() == Some(user_id))
                {
                    return Err(StorageError::DuplicateBindingUid);
                }
            }
        }
        if let Some(name) = binding.user_name.as_deref() {
            if binding.platform != "bilibili"
                || binding.user_id.is_some()
                || name.is_empty()
                || name.trim() != name
                || name.chars().count() > 200
                || name.chars().any(char::is_control)
            {
                return Err(StorageError::InvalidBindingName);
            }
            let conflict: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM bindings WHERE platform=?1 AND user_id IS NULL AND user_name=?2 AND id<>?3)",
                params![binding.platform, name, id],
                |row| row.get(0),
            )?;
            if conflict {
                return Err(StorageError::DuplicateBindingName);
            }
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM presets WHERE id=?1)",
            params![binding.preset_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::PresetMissing(binding.preset_id.clone()));
        }
        tx.execute("INSERT INTO bindings(id,platform,user_id,legacy_user_name,preset_id,enabled,user_name) VALUES(?1,?2,?3,?4,?5,?6,?7)\
            ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,user_id=excluded.user_id,\
            legacy_user_name=excluded.legacy_user_name,preset_id=excluded.preset_id,enabled=excluded.enabled,user_name=excluded.user_name",
            params![id, binding.platform, binding.user_id.map(|id| id.to_string()), binding.legacy_user_name,
                binding.preset_id, binding.enabled, binding.user_name])?;
        tx.commit()?;
        Ok(())
    }

    pub fn bindings(&self) -> Result<Vec<VoiceBinding>, StorageError> {
        self.binding_records()
            .map(|records| records.into_iter().map(|record| record.binding).collect())
    }

    pub fn binding_records(&self) -> Result<Vec<BindingRecord>, StorageError> {
        let mut statement = self.conn.prepare("SELECT id,platform,user_id,legacy_user_name,preset_id,enabled,user_name FROM bindings ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            let user_id: Option<String> = row.get(2)?;
            let parsed = user_id.and_then(|value| value.parse().ok());
            Ok(BindingRecord {
                id: row.get(0)?,
                binding: VoiceBinding {
                    platform: row.get(1)?,
                    user_id: parsed,
                    user_name: row.get(6)?,
                    legacy_user_name: row.get(3)?,
                    preset_id: row.get(4)?,
                    enabled: row.get(5)?,
                },
            })
        })?;
        rows.map(|row| row.map_err(StorageError::from)).collect()
    }

    pub fn delete_binding(&mut self, id: &str) -> Result<(), StorageError> {
        let changed = self
            .conn
            .execute("DELETE FROM bindings WHERE id=?1", params![id])?;
        if changed == 0 {
            return Err(StorageError::BindingMissing(id.to_owned()));
        }
        Ok(())
    }

    pub fn export_configuration(&self) -> Result<ConfigurationExport, StorageError> {
        let connections = self.connections()?;
        // Older builds could persist a token inside a local service URL. Do
        // not copy such plaintext into an ordinary shareable export.
        for connection in &connections {
            connection.settings.validate_export_safe()?;
        }
        let fish_audio_settings = connections
            .iter()
            .filter(|connection| connection.settings.provider() == Provider::FishAudio)
            .map(|connection| {
                self.fish_audio_settings(&connection.id)
                    .map(|settings| (connection.id.clone(), settings))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let presets = self.presets()?;
        let dots_settings = presets
            .iter()
            .filter(|preset| preset.provider == Provider::Dots)
            .map(|preset| {
                self.dots_playback_settings(&preset.id)
                    .map(|settings| (preset.id.clone(), settings))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        Ok(ConfigurationExport {
            format_version: 4,
            rules: self.load_rules()?,
            live_settings: self.load_live_settings()?,
            connections,
            presets,
            bindings: self.bindings()?,
            fish_audio_settings,
            dots_settings,
        })
    }

    /// Restore the credential-free application export in one transaction.
    /// Existing unrelated voices remain available. Same-identity bindings are
    /// updated, rather than duplicated. Missing managed audio fails the whole
    /// restore, so a backup never silently loses its keyword sound rules.
    pub fn import_configuration(
        &mut self,
        export: &ConfigurationExport,
    ) -> Result<(), StorageError> {
        if !(1..=4).contains(&export.format_version)
            || export.connections.len() > 256
            || export.presets.len() > 4096
            || export.bindings.len() > 4096
        {
            return Err(StorageError::InvalidConfigurationBackup);
        }
        export.rules.validate()?;
        let mut connection_ids = std::collections::HashSet::new();
        for connection in &export.connections {
            connection.settings.validate_export_safe()?;
            if connection.id.is_empty() || !connection_ids.insert(&connection.id) {
                return Err(StorageError::InvalidConfigurationBackup);
            }
        }
        let mut preset_ids = std::collections::HashSet::new();
        for preset in &export.presets {
            if preset.id.is_empty()
                || !preset_ids.insert(&preset.id)
                || !connection_ids.contains(&preset.connection_id)
                || preset.voice_id.trim().is_empty()
                || !preset.speed.is_finite()
                || !(0.5..=2.0).contains(&preset.speed)
                || !preset.volume.is_finite()
                || !(0.0..=2.0).contains(&preset.volume)
            {
                return Err(StorageError::InvalidConfigurationBackup);
            }
        }
        if export
            .rules
            .default_preset_id
            .as_ref()
            .is_some_and(|id| !preset_ids.contains(id))
            || export
                .rules
                .preferred_presets
                .values()
                .any(|id| !preset_ids.contains(id))
            || export
                .bindings
                .iter()
                .any(|binding| !preset_ids.contains(&binding.preset_id))
        {
            return Err(StorageError::InvalidConfigurationBackup);
        }
        self.in_savepoint("restore_configuration", |store| {
            for connection in &export.connections {
                // has_credential is display metadata; no credential write is performed.
                store.save_connection(connection)?;
            }
            for preset in &export.presets { store.save_preset(preset)?; }
            for (id, settings) in &export.fish_audio_settings { store.save_fish_audio_settings(id, settings)?; }
            for (id, settings) in &export.dots_settings { store.save_dots_playback_settings(id, settings)?; }
            for binding in &export.bindings {
                let id: Option<String> = store.conn.query_row(
                    "SELECT id FROM bindings WHERE platform=?1 AND ((?2 IS NOT NULL AND user_id=?2) OR (?2 IS NULL AND ?3 IS NOT NULL AND user_id IS NULL AND user_name=?3) OR (?2 IS NULL AND ?3 IS NULL AND legacy_user_name IS ?4 AND preset_id=?5)) ORDER BY id LIMIT 1",
                    params![binding.platform, binding.user_id.map(|id| id.to_string()), binding.user_name, binding.legacy_user_name, binding.preset_id],
                    |row| row.get(0),
                ).optional()?;
                store.save_binding(&id.unwrap_or_else(|| Uuid::new_v4().to_string()), binding)?;
            }
            store.save_live_settings(&export.live_settings)?;
            let mut rules = export.rules.clone();
            rules.events.filter_bilibili_emoticons = true;
            store.save_rules(&rules)?;
            Ok(())
        })
    }

    /// Save a dots voice preset and its original-file reference together.
    /// Both rows roll back if either existing validation rejects the input.
    pub fn save_dots_voice(
        &mut self,
        preset: &VoicePreset,
        profile: &ReferenceProfile,
    ) -> Result<(), StorageError> {
        self.save_dots_voice_with_preference(preset, profile, false)
    }

    pub fn save_dots_voice_with_preference(
        &mut self,
        preset: &VoicePreset,
        profile: &ReferenceProfile,
        make_preferred: bool,
    ) -> Result<(), StorageError> {
        if preset.provider != Provider::Dots
            || preset.sovits.is_some()
            || profile.connection_id != preset.connection_id
            || !matches!(&profile.role, ReferenceRole::Dots { role } if role == &preset.voice_id)
        {
            return Err(StorageError::InvalidReferenceProfile);
        }
        self.in_savepoint("save_dots_voice", |store| {
            store.save_preset(preset)?;
            store.save_reference_profile(profile)?;
            if make_preferred {
                let mut rules = store.load_rules()?;
                rules.default_preset_id = Some(preset.id.clone());
                rules.default_preset_explicitly_cleared = false;
                rules
                    .preferred_presets
                    .insert(preset.provider, preset.id.clone());
                store.save_rules(&rules)?;
            }
            Ok(())
        })
    }

    /// Remember the user's original reference file path, text and languages
    /// for one dots role or exact GPT/SoVITS model pair. No audio is copied.
    pub fn save_reference_profile(
        &mut self,
        profile: &ReferenceProfile,
    ) -> Result<(), StorageError> {
        if !profile.is_valid() {
            return Err(StorageError::InvalidReferenceProfile);
        }
        let provider: Option<String> = self
            .conn
            .query_row(
                "SELECT provider FROM connections WHERE id=?1",
                params![profile.connection_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(provider) = provider else {
            return Err(StorageError::ConnectionMissing(
                profile.connection_id.clone(),
            ));
        };
        if provider != provider_name(profile.role.provider()) {
            return Err(StorageError::InvalidReferenceProfile);
        }
        Self::validate_reference_audio_path(Path::new(&profile.audio_path))?;
        let json = serde_json::to_string(profile)?;
        self.conn.execute(
            "INSERT INTO reference_profiles(connection_id,role_key,provider,profile_json)
             VALUES(?1,?2,?3,?4) ON CONFLICT(connection_id,role_key) DO UPDATE SET
             provider=excluded.provider,profile_json=excluded.profile_json",
            params![
                profile.connection_id,
                profile.role.storage_key(),
                provider,
                json
            ],
        )?;
        Ok(())
    }

    /// Check the exact source file immediately before preparing playback.
    /// A missing or unreadable file produces a user-facing error instead of
    /// silently choosing a different voice.
    pub fn validate_reference_audio_path(path: &Path) -> Result<(), StorageError> {
        if !path.is_absolute() || validated_reference_extension(path).is_err() {
            return Err(StorageError::ReferenceAudioUnavailable);
        }
        let metadata = path
            .metadata()
            .map_err(|_| StorageError::ReferenceAudioUnavailable)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ASSET_BYTES {
            return Err(StorageError::ReferenceAudioUnavailable);
        }
        let mut file = fs::File::open(path).map_err(|_| StorageError::ReferenceAudioUnavailable)?;
        let mut first = [0u8; 1];
        file.read_exact(&mut first)
            .map_err(|_| StorageError::ReferenceAudioUnavailable)?;
        Ok(())
    }

    pub fn reference_profile(
        &self,
        connection_id: &str,
        role: &ReferenceRole,
    ) -> Result<Option<ReferenceProfile>, StorageError> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT profile_json FROM reference_profiles WHERE connection_id=?1 AND role_key=?2",
                params![connection_id, role.storage_key()],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value).map_err(StorageError::from))
            .transpose()
    }

    pub fn reference_profiles(
        &self,
        connection_id: &str,
    ) -> Result<Vec<ReferenceProfile>, StorageError> {
        let mut statement = self.conn.prepare(
            "SELECT profile_json FROM reference_profiles WHERE connection_id=?1 ORDER BY role_key",
        )?;
        let rows = statement.query_map(params![connection_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn delete_reference_profile(
        &mut self,
        connection_id: &str,
        role: &ReferenceRole,
    ) -> Result<(), StorageError> {
        self.conn.execute(
            "DELETE FROM reference_profiles WHERE connection_id=?1 AND role_key=?2",
            params![connection_id, role.storage_key()],
        )?;
        Ok(())
    }

    pub fn import_asset(&mut self, source: &Path, name: &str) -> Result<Asset, StorageError> {
        let extension = validated_extension(source)?;
        let size = source.metadata()?.len();
        if size > MAX_ASSET_BYTES {
            return Err(StorageError::AssetTooLarge);
        }
        let id = Uuid::new_v4().to_string();
        let relative_path = format!("assets/{id}.{extension}");
        let dest = self.data_dir.join(&relative_path);
        if let Err(error) = fs::copy(source, &dest) {
            // A failed copy may already have created a partial managed file.
            let _ = fs::remove_file(&dest);
            return Err(error.into());
        }
        let result = (|| -> Result<Asset, StorageError> {
            let bytes = dest.metadata()?.len();
            if bytes > MAX_ASSET_BYTES {
                return Err(StorageError::AssetTooLarge);
            }
            let sha256 = file_sha256(&dest)?;
            let asset = Asset {
                id,
                name: name.to_owned(),
                relative_path,
                sha256,
                bytes,
            };
            let tx = self.conn.savepoint()?;
            tx.execute(
                "INSERT INTO assets(id,name,relative_path,sha256,bytes) VALUES(?1,?2,?3,?4,?5)",
                params![
                    asset.id,
                    asset.name,
                    asset.relative_path,
                    asset.sha256,
                    asset.bytes as i64
                ],
            )?;
            tx.commit()?;
            Ok(asset)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&dest);
        }
        result
    }

    /// Keep the stable asset ID and rule references while replacing its
    /// managed file. A failed copy or database update leaves the old file live.
    /// Retain the previous immutable file for already queued playback plans
    /// and SQLite backups that may still refer to it.
    pub fn replace_asset(&mut self, id: &str, source: &Path) -> Result<Asset, StorageError> {
        let old = self
            .asset(id)?
            .ok_or_else(|| StorageError::AssetMissing(id.to_owned()))?;
        let extension = validated_extension(source)?;
        if source.metadata()?.len() > MAX_ASSET_BYTES {
            return Err(StorageError::AssetTooLarge);
        }
        let relative_path = format!("assets/{}.{}", Uuid::new_v4(), extension);
        let dest = self.data_dir.join(&relative_path);
        if let Err(error) = fs::copy(source, &dest) {
            let _ = fs::remove_file(&dest);
            return Err(error.into());
        }
        let result = (|| -> Result<Asset, StorageError> {
            let bytes = dest.metadata()?.len();
            if bytes > MAX_ASSET_BYTES {
                return Err(StorageError::AssetTooLarge);
            }
            let asset = Asset {
                id: id.to_owned(),
                name: old.name.clone(),
                relative_path,
                sha256: file_sha256(&dest)?,
                bytes,
            };
            let tx = self.conn.transaction()?;
            tx.execute(
                "UPDATE assets SET relative_path=?1,sha256=?2,bytes=?3 WHERE id=?4",
                params![asset.relative_path, asset.sha256, asset.bytes as i64, id],
            )?;
            tx.commit()?;
            Ok(asset)
        })();
        match result {
            Ok(asset) => Ok(asset),
            Err(error) => {
                let _ = fs::remove_file(dest);
                Err(error)
            }
        }
    }

    pub fn asset(&self, id: &str) -> Result<Option<Asset>, StorageError> {
        self.conn
            .query_row(
                "SELECT id,name,relative_path,sha256,bytes FROM assets WHERE id=?1",
                params![id],
                |row| {
                    Ok(Asset {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        relative_path: row.get(2)?,
                        sha256: row.get(3)?,
                        bytes: row.get::<_, i64>(4)? as u64,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn assets(&self) -> Result<Vec<Asset>, StorageError> {
        let mut statement = self
            .conn
            .prepare("SELECT id,name,relative_path,sha256,bytes FROM assets ORDER BY name,id")?;
        let rows = statement.query_map([], |row| {
            Ok(Asset {
                id: row.get(0)?,
                name: row.get(1)?,
                relative_path: row.get(2)?,
                sha256: row.get(3)?,
                bytes: row.get::<_, i64>(4)? as u64,
            })
        })?;
        rows.map(|row| row.map_err(StorageError::from)).collect()
    }

    pub fn asset_path(&self, id: &str) -> Result<PathBuf, StorageError> {
        let asset = self
            .asset(id)?
            .ok_or_else(|| StorageError::AssetMissing(id.to_owned()))?;
        Ok(self.data_dir.join(asset.relative_path))
    }

    pub fn delete_asset(&mut self, id: &str) -> Result<(), StorageError> {
        let rules = self.load_rules()?;
        if let Some(rule) = rules.sounds.iter().find(|sound| sound.asset_id == id) {
            return Err(StorageError::AssetReferenced(rule.trigger.clone()));
        }
        let _path = self.asset_path(id)?;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM assets WHERE id=?1", params![id])?;
        tx.commit()?;
        // The managed file remains immutable for a plan already in the queue
        // and for retained SQLite backups. Reclaim it only with a separate
        // policy that accounts for both lifetimes.
        Ok(())
    }
}

fn backup_secret_tables(conn: &Connection) -> Result<(bool, bool), StorageError> {
    let secrets: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='protected_secrets')",
        [], |row| row.get(0))?;
    let credential: bool = conn
        .prepare("PRAGMA table_info(connections)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == "protected_credential");
    Ok((secrets, credential))
}

fn backup_has_credentials(conn: &Connection) -> Result<bool, StorageError> {
    let (secrets, credential) = backup_secret_tables(conn)?;
    Ok((secrets
        && conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM protected_secrets)",
            [],
            |row| row.get::<_, bool>(0),
        )?)
        || (credential
            && conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM connections WHERE protected_credential IS NOT NULL)",
                [],
                |row| row.get::<_, bool>(0),
            )?))
}

fn credential_free_backup(source: &Connection, path: &Path) -> Result<(), StorageError> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::other("备份目录不可用"))?;
    let data = directory
        .parent()
        .ok_or_else(|| io::Error::other("备份目录不可用"))?;
    check_backup_entry(directory, &data.canonicalize()?)?;
    let mut memory = Connection::open_in_memory()?;
    rusqlite::backup::Backup::new(source, &mut memory)?.run_to_completion(
        128,
        Duration::from_millis(1),
        None,
    )?;
    let (secrets, credential) = backup_secret_tables(&memory)?;
    memory.execute_batch("PRAGMA secure_delete = ON;")?;
    if secrets {
        memory.execute("DELETE FROM protected_secrets", [])?;
    }
    if credential {
        memory.execute("UPDATE connections SET protected_credential=NULL", [])?;
    }
    // Compact before persisting so deleted ciphertext does not survive in
    // free pages. The active database is never edited by this operation.
    memory.execute_batch("VACUUM")?;
    memory.backup(rusqlite::MAIN_DB, path, None)?;
    Ok(())
}

fn is_database_backup(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".sqlite3") else {
        return false;
    };
    if !stem.is_ascii() || stem.len() < 38 {
        return false;
    }
    let (prefix, uuid) = stem.split_at(stem.len() - 36);
    if Uuid::parse_str(uuid).is_err() {
        return false;
    }
    let Some(prefix) = prefix.strip_suffix('-') else {
        return false;
    };
    if let Some(stamp) = prefix.strip_prefix("before-legacy-import-") {
        return stamp.parse::<u64>().is_ok();
    }
    let Some(prefix) = prefix.strip_prefix("before-v") else {
        return false;
    };
    let Some((from, rest)) = prefix.split_once("-to-v") else {
        return false;
    };
    let Some((to, stamp)) = rest.split_once('-') else {
        return false;
    };
    from.parse::<u64>().is_ok() && to.parse::<u64>().is_ok() && stamp.parse::<u64>().is_ok()
}

fn check_backup_entry(path: &Path, parent: &Path) -> Result<(), StorageError> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let redirected = metadata.file_type().is_symlink();
    if redirected || path.canonicalize()?.parent() != Some(parent) {
        return Err(io::Error::other("备份路径被重定向，未操作该路径").into());
    }
    Ok(())
}

#[cfg(windows)]
fn replace_backup(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Both buffers are NUL terminated and live throughout the call.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_backup(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn schema_version(conn: &Connection) -> Result<i64, StorageError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if !(0..=CURRENT_SCHEMA).contains(&version) {
        return Err(StorageError::UnsupportedSchema(version));
    }
    Ok(version)
}

fn provider_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Dots => "dots",
        Provider::GptSovits => "gpt_sovits",
        Provider::FishAudio => "fish_audio",
        Provider::Doubao => "doubao",
    }
}

fn fish_settings_key(connection_id: &str) -> String {
    format!("fish_audio_settings:{connection_id}")
}

fn dots_settings_key(preset_id: &str) -> String {
    format!("dots_settings:{preset_id}")
}

fn validated_extension(source: &Path) -> Result<String, StorageError> {
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "wav" | "mp3" | "flac" | "ogg" | "aac" | "m4a"
    ) {
        Ok(extension)
    } else {
        Err(StorageError::UnsupportedAudio(extension))
    }
}

fn validated_reference_extension(source: &Path) -> Result<String, StorageError> {
    let extension = validated_extension(source)?;
    // Matches the local dots.tts service's supported reference audio suffixes.
    if matches!(extension.as_str(), "wav" | "mp3" | "flac" | "ogg" | "m4a") {
        Ok(extension)
    } else {
        Err(StorageError::UnsupportedAudio(extension))
    }
}

fn existing_legacy_reference_path(data_dir: &Path, file_name: &str) -> Option<PathBuf> {
    let name = Path::new(file_name);
    if name.file_name().and_then(|value| value.to_str()) != Some(file_name)
        || validated_reference_extension(name).is_err()
    {
        return None;
    }
    let data_root = data_dir.canonicalize().ok()?;
    let root = data_dir.join("references").canonicalize().ok()?;
    if root.parent() != Some(data_root.as_path()) {
        return None;
    }
    let path = root.join(name).canonicalize().ok()?;
    if path.parent() != Some(root.as_path())
        || DataStore::validate_reference_audio_path(&path).is_err()
    {
        return None;
    }
    Some(path)
}

fn file_sha256(path: &Path) -> Result<String, StorageError> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Provider;
    use crate::rules::{Replacement, SoundRule};
    use crate::voice_library::{ReferenceProfile, ReferenceRole};

    #[test]
    fn configuration_restore_is_atomic_and_does_not_import_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let connection = ServiceConnection {
            id: "backup-dots".into(),
            name: "Local".into(),
            settings: ConnectionSettings::Dots {
                endpoint: "http://127.0.0.1:9881".into(),
                timeout_secs: 30,
            },
            has_credential: true,
        };
        store.save_connection(&connection).unwrap();
        let preset = VoicePreset {
            id: "backup-voice".into(),
            name: "Original".into(),
            connection_id: connection.id.clone(),
            provider: Provider::Dots,
            voice_id: "role".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        store.save_preset(&preset).unwrap();
        let mut rules = RuleSet {
            default_preset_id: Some(preset.id.clone()),
            ..RuleSet::default()
        };
        rules.emote_words.push(Replacement {
            from: "[doge]".into(),
            to: "狗头".into(),
        });
        store.save_rules(&rules).unwrap();
        let binding = VoiceBinding {
            platform: "bilibili".into(),
            user_id: None,
            user_name: Some("Alice".into()),
            legacy_user_name: None,
            preset_id: preset.id.clone(),
            enabled: true,
        };
        store.save_binding("binding-original", &binding).unwrap();
        let backup = store.export_configuration().unwrap();
        let mut changed = preset.clone();
        changed.name = "Changed".into();
        store.save_preset(&changed).unwrap();
        store.import_configuration(&backup).unwrap();
        store.import_configuration(&backup).unwrap();
        assert_eq!(store.presets().unwrap()[0].name, "Original");
        assert_eq!(store.bindings().unwrap().len(), 1);
        assert_eq!(store.load_rules().unwrap(), rules);
        assert!(
            store
                .connection_credential(&connection.id)
                .unwrap()
                .is_none()
        );

        let mut broken = backup;
        broken.presets[0].name = "Must roll back".into();
        broken.rules.sounds.push(SoundRule {
            trigger: "晚安".into(),
            asset_id: "missing-audio".into(),
        });
        assert!(matches!(
            store.import_configuration(&broken),
            Err(StorageError::AssetMissing(_))
        ));
        assert_eq!(store.presets().unwrap()[0].name, "Original");
        assert_eq!(store.load_rules().unwrap(), rules);
        assert!(store.conn.is_autocommit());
    }

    fn broadcast_session_record() -> BroadcastSessionRecord {
        let run_id = Uuid::new_v4().to_string();
        BroadcastSessionRecord {
            active: Some(BroadcastSessionProgress {
                observation_run_id: run_id.clone(),
                started_at: Some(100),
                observed_started_at: 120,
                last_observed_at: 180,
                messages: 301,
                receiver: Some(BroadcastReceiverCursor {
                    run_id,
                    epoch: 2,
                    received: 301,
                }),
            }),
            last_session: Some(BroadcastSessionSummary {
                started_at: Some(10),
                observed_started_at: 12,
                ended_observed_at: 70,
                messages: 19,
                unique_viewers: Some(7),
                seconds: Some(60),
            }),
        }
    }

    #[test]
    fn broadcast_session_persistence_keeps_active_and_last_scoped_to_owner_room() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let first = broadcast_session_record();
        let mut other = first.clone();
        other.active.as_mut().unwrap().messages = 5;
        store.save_broadcast_session(123, 456, &first).unwrap();
        store.save_broadcast_session(789, 456, &other).unwrap();
        assert_eq!(store.load_broadcast_session(123, 789).unwrap(), None);
        drop(store);
        let reopened = DataStore::open(temp.path()).unwrap();
        assert_eq!(
            reopened.load_broadcast_session(123, 456).unwrap(),
            Some(first)
        );
        assert_eq!(
            reopened.load_broadcast_session(789, 456).unwrap(),
            Some(other)
        );
        assert_eq!(reopened.load_broadcast_session(456, 123).unwrap(), None);
    }

    #[test]
    fn broadcast_session_invalid_records_do_not_replace_saved_observations() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let saved = broadcast_session_record();
        store.save_broadcast_session(123, 456, &saved).unwrap();
        let mut invalid = saved.clone();
        invalid.last_session.as_mut().unwrap().seconds = Some(61);
        assert!(store.save_broadcast_session(123, 456, &invalid).is_err());
        invalid = saved.clone();
        invalid
            .active
            .as_mut()
            .unwrap()
            .receiver
            .as_mut()
            .unwrap()
            .run_id = "bad-run".into();
        assert!(store.save_broadcast_session(123, 456, &invalid).is_err());
        assert!(store.save_broadcast_session(0, 456, &saved).is_err());
        assert!(store.load_broadcast_session(123, 0).is_err());
        assert_eq!(store.load_broadcast_session(123, 456).unwrap(), Some(saved));
    }

    #[test]
    fn broadcast_session_history_is_not_exported_and_clear_data_removes_it() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_broadcast_session(123, 456, &broadcast_session_record())
            .unwrap();
        let exported = serde_json::to_value(store.export_configuration().unwrap()).unwrap();
        let exported = exported.to_string();
        assert!(!exported.contains("broadcast.session"));
        assert!(!exported.contains("last_session"));
        assert!(!exported.contains("observation_run_id"));
        store.clear_application_data().unwrap();
        assert_eq!(store.load_broadcast_session(123, 456).unwrap(), None);
    }

    #[test]
    fn broadcast_session_corruption_and_sql_write_failure_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let saved = broadcast_session_record();
        store.save_broadcast_session(123, 456, &saved).unwrap();
        store.conn.execute_batch(
            "CREATE TRIGGER reject_broadcast_session_write BEFORE UPDATE ON settings
             WHEN NEW.key LIKE 'broadcast.session:%' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;"
        ).unwrap();
        let mut next = saved.clone();
        next.active.as_mut().unwrap().messages += 1;
        assert!(matches!(
            store.save_broadcast_session(123, 456, &next),
            Err(StorageError::Sql(_))
        ));
        assert_eq!(store.load_broadcast_session(123, 456).unwrap(), Some(saved));
        store
            .conn
            .execute_batch("DROP TRIGGER reject_broadcast_session_write")
            .unwrap();
        store
            .conn
            .execute(
                "UPDATE settings SET json='not-json' WHERE key='broadcast.session:123:456'",
                [],
            )
            .unwrap();
        assert!(store.load_broadcast_session(123, 456).is_err());
    }

    #[test]
    fn invalid_rules_never_replace_the_saved_rules() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let mut saved = RuleSet::default();
        saved.templates.danmaku = "旧规则：{message}".into();
        store.save_rules(&saved).unwrap();

        for event in ["danmaku", "gift", "super_chat", "guard"] {
            let mut invalid = saved.clone();
            match event {
                "danmaku" => invalid.templates.danmaku = "{bad_field}".into(),
                "gift" => invalid.templates.gift = "礼物 }".into(),
                "super_chat" => invalid.templates.super_chat = "留言 {message".into(),
                _ => invalid.templates.guard = "舰长 {bad_field}".into(),
            }
            assert!(matches!(
                store.save_rules(&invalid),
                Err(StorageError::InvalidRules(
                    RuleError::InvalidTemplate { .. }
                ))
            ));
            assert_eq!(store.load_rules().unwrap(), saved, "{event}");
        }

        let mut invalid = saved.clone();
        invalid.events.gift_threshold_yuan = -1.0;
        assert!(matches!(
            store.save_rules(&invalid),
            Err(StorageError::InvalidRules(RuleError::InvalidThreshold))
        ));
        invalid = saved.clone();
        invalid.message_words.push(Replacement {
            from: String::new(),
            to: "replacement".into(),
        });
        assert!(matches!(
            store.save_rules(&invalid),
            Err(StorageError::InvalidRules(RuleError::EmptyKeyword))
        ));
        invalid = saved.clone();
        invalid.sounds.push(SoundRule {
            trigger: String::new(),
            asset_id: "sound-id".into(),
        });
        assert!(matches!(
            store.save_rules(&invalid),
            Err(StorageError::InvalidRules(RuleError::InvalidSoundRule))
        ));
        let mut unchanged_missing_references = saved.clone();
        unchanged_missing_references.default_preset_id = Some("missing-preset".into());
        unchanged_missing_references.sounds.push(SoundRule {
            trigger: "叮".into(),
            asset_id: "missing-asset".into(),
        });
        assert!(matches!(
            store.save_rules(&unchanged_missing_references),
            Err(StorageError::AssetMissing(_))
        ));
        assert_eq!(store.load_rules().unwrap(), saved);
        // An intentionally missing default voice is still repairable.
        unchanged_missing_references.sounds.clear();
        store.save_rules(&unchanged_missing_references).unwrap();
        assert_eq!(store.load_rules().unwrap(), unchanged_missing_references);
        store.save_rules(&saved).unwrap();
        assert_eq!(store.load_rules().unwrap(), saved);
    }

    #[test]
    fn duplicate_uid_is_rejected_but_historical_rows_remain_editable() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "本地声音".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        store
            .save_preset(&VoicePreset {
                id: "voice".into(),
                name: "声音".into(),
                connection_id: "dots".into(),
                provider: Provider::Dots,
                voice_id: "role".into(),
                speed: 1.0,
                volume: 1.0,
                sovits: None,
            })
            .unwrap();
        let mut binding = VoiceBinding {
            platform: "bilibili".into(),
            user_id: Some(42),
            user_name: None,
            legacy_user_name: None,
            preset_id: "voice".into(),
            enabled: true,
        };
        store.save_binding("first", &binding).unwrap();
        assert!(matches!(
            store.save_binding("new", &binding),
            Err(StorageError::DuplicateBindingUid)
        ));
        assert_eq!(store.binding_records().unwrap().len(), 1);
        let mut another_platform = binding.clone();
        another_platform.platform = "other-platform".into();
        store.save_binding("other", &another_platform).unwrap();

        // Simulate duplicate rows written by an older version; opening them
        // must not fail or force destructive cleanup before correction.
        store.conn.execute(
            "INSERT INTO bindings(id,platform,user_id,legacy_user_name,preset_id,enabled,user_name)
             VALUES('old-duplicate','bilibili','042',NULL,'voice',1,NULL)",
            [],
        ).unwrap();
        binding.enabled = false;
        store.save_binding("first", &binding).unwrap();
        store.save_binding("old-duplicate", &binding).unwrap();
        assert!(matches!(
            store.save_binding("new", &binding),
            Err(StorageError::DuplicateBindingUid)
        ));
        assert_eq!(store.binding_records().unwrap().len(), 3);

        binding.user_id = Some(100);
        store.save_binding("old-duplicate", &binding).unwrap();
        binding.user_id = Some(101);
        store.save_binding("first", &binding).unwrap();
        binding.user_id = Some(42);
        store.save_binding("new", &binding).unwrap();
        assert_eq!(store.binding_records().unwrap().len(), 4);
    }

    #[test]
    fn v5_legacy_name_binding_stays_pending_after_explicit_name_migration() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("danmakuvoice.sqlite3");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE bindings (id TEXT PRIMARY KEY, platform TEXT NOT NULL, user_id TEXT,
                legacy_user_name TEXT, preset_id TEXT NOT NULL, enabled INTEGER NOT NULL);
             INSERT INTO bindings VALUES ('legacy','bilibili',NULL,'同名观众','voice',1);
             PRAGMA user_version = 5;",
        )
        .unwrap();
        drop(conn);
        let store = DataStore::open(temp.path()).unwrap();
        assert!(store.upgrade_backup().is_some());
        let record = &store.binding_records().unwrap()[0].binding;
        assert_eq!(record.legacy_user_name.as_deref(), Some("同名观众"));
        assert_eq!(record.user_name, None);
        assert!(!record.matches_explicit_name("同名观众"));
    }

    #[test]
    fn direct_audition_selects_persisted_fish_voice_without_changing_live_default() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "fish".into(),
                name: "Fish Audio".into(),
                settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
                has_credential: false,
            })
            .unwrap();
        store
            .set_connection_credential("fish", b"sk-test-only-secret-key-12345678901234567890")
            .unwrap();
        let default = store
            .save_fish_voice("fish", fish::BUILTIN_VOICES[0].0, "默认音色")
            .unwrap();
        let selected = store
            .save_fish_voice("fish", fish::BUILTIN_VOICES[1].0, "试听音色")
            .unwrap();
        let mut rules = RuleSet {
            default_preset_id: Some(default.id.clone()),
            ..Default::default()
        };
        rules.events.danmaku_on = false;
        store.save_rules(&rules).unwrap();

        let preview = store
            .voice_audition_preview(&selected.id, "测试第二个音色")
            .unwrap();
        assert_eq!(preview.voice.as_ref().unwrap().id, selected.id);
        assert_eq!(preview.final_text, "测试第二个音色");
        assert_eq!(
            preview.parts,
            vec![crate::rules::PlanPart::Text("测试第二个音色".into())]
        );
        assert!(preview.filtered_reason.is_none());
        let prepared =
            crate::playback::PreparedPlayback::from_store(&store, &preview, None).unwrap();
        assert!(!format!("{prepared:?}").contains("sk-test-only-secret"));
        assert_eq!(store.load_rules().unwrap(), rules);
        assert!(matches!(
            store.voice_audition_preview("missing", "测试"),
            Err(StorageError::PresetMissing(_))
        ));
        assert!(matches!(
            store.voice_audition_preview(&selected.id, " \t"),
            Err(StorageError::InvalidAuditionText)
        ));
        assert!(matches!(
            store.voice_audition_preview(&selected.id, &"字".repeat(2001)),
            Err(StorageError::InvalidAuditionText)
        ));
    }

    #[test]
    fn fish_settings_and_named_voices_survive_restart_restore_without_overwriting_user_names() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "fish".into(),
                name: "Fish Audio".into(),
                settings: ConnectionSettings::FishAudio { timeout_secs: 180 },
                has_credential: false,
            })
            .unwrap();
        assert_eq!(
            store.fish_audio_settings("fish").unwrap(),
            FishPlaybackSettings::default()
        );
        let settings = FishPlaybackSettings {
            model: fish::FishModel::S2Pro,
            latency: fish::FishLatency::Balanced,
            volume_db: -3.0,
            temperature: 0.4,
            top_p: 0.6,
            streaming: false,
        };
        store.save_fish_audio_settings("fish", &settings).unwrap();
        let mut invalid = settings.clone();
        invalid.top_p = f32::NAN;
        assert!(matches!(
            store.save_fish_audio_settings("fish", &invalid),
            Err(StorageError::InvalidFishAudioSettings)
        ));

        let first = store
            .save_fish_voice(
                "fish",
                &format!("https://fish.audio/zh-CN/app/m/{}/", fish::DEFAULT_VOICE_ID),
                "用户命名",
            )
            .unwrap();
        assert_eq!(first.voice_id, fish::DEFAULT_VOICE_ID);
        let mut changed = first.clone();
        changed.speed = 1.3;
        store.save_preset(&changed).unwrap();
        let renamed = store
            .save_fish_voice("fish", fish::DEFAULT_VOICE_ID, "更新名称")
            .unwrap();
        assert_eq!(renamed.id, first.id);
        assert_eq!(renamed.speed, 1.3);
        assert_eq!(renamed.name, "更新名称");
        assert_eq!(store.restore_builtin_fish_voices("fish").unwrap().len(), 4);
        assert!(
            store
                .restore_builtin_fish_voices("fish")
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            store.save_fish_voice("fish", "https://evil.example/m/abc", "x"),
            Err(StorageError::InvalidFishVoiceId)
        ));
        let export = store.export_configuration().unwrap();
        assert_eq!(export.format_version, 4);
        assert_eq!(export.fish_audio_settings["fish"], settings);
        drop(store);

        let reopened = DataStore::open(temp.path()).unwrap();
        assert_eq!(reopened.fish_audio_settings("fish").unwrap(), settings);
        assert_eq!(
            reopened
                .presets()
                .unwrap()
                .iter()
                .filter(|preset| preset.provider == Provider::FishAudio)
                .count(),
            5
        );
        assert_eq!(
            reopened
                .presets()
                .unwrap()
                .into_iter()
                .find(|preset| preset.id == first.id)
                .unwrap()
                .name,
            "更新名称"
        );
    }

    #[test]
    fn dots_voice_and_reference_save_together_or_roll_back_together() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("reference.wav");
        fs::write(&original, b"RIFF reference recording WAVE").unwrap();
        let mut store = DataStore::open(temp.path().join("app")).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let mut preset = VoicePreset {
            id: "custom-role".into(),
            name: "自定义角色".into(),
            connection_id: "dots".into(),
            provider: Provider::Dots,
            voice_id: "角色 A".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        let mut profile = ReferenceProfile {
            connection_id: "dots".into(),
            role: ReferenceRole::Dots {
                role: "角色 A".into(),
            },
            audio_path: original.to_string_lossy().into_owned(),
            reference_text: String::new(),
            reference_language: String::new(),
            text_language: String::new(),
            text_free: false,
        };
        store.save_dots_voice(&preset, &profile).unwrap();
        assert_eq!(store.presets().unwrap(), vec![preset.clone()]);
        assert_eq!(
            store.reference_profile("dots", &profile.role).unwrap(),
            Some(profile.clone())
        );

        preset.name = "更新后".into();
        let mut rules = store.load_rules().unwrap();
        rules.default_preset_id = Some("previous-choice".into());
        store.save_rules(&rules).unwrap();
        profile.audio_path = temp
            .path()
            .join("missing.wav")
            .to_string_lossy()
            .into_owned();
        assert!(matches!(
            store.save_dots_voice_with_preference(&preset, &profile, true),
            Err(StorageError::ReferenceAudioUnavailable)
        ));
        assert_eq!(store.presets().unwrap()[0].name, "自定义角色");
        assert_eq!(
            store.load_rules().unwrap().default_preset_id,
            rules.default_preset_id
        );
        assert_eq!(
            store
                .reference_profile("dots", &profile.role)
                .unwrap()
                .unwrap()
                .audio_path,
            original.to_string_lossy()
        );

        profile.audio_path = original.to_string_lossy().into_owned();
        profile.reference_text = "可选参考文本".into();
        let mut cleared = store.load_rules().unwrap();
        cleared.default_preset_id = None;
        cleared.default_preset_explicitly_cleared = true;
        store.save_rules(&cleared).unwrap();
        store
            .save_dots_voice_with_preference(&preset, &profile, true)
            .unwrap();
        assert_eq!(store.presets().unwrap()[0].name, "更新后");
        assert_eq!(
            store.load_rules().unwrap().default_preset_id,
            Some(preset.id.clone())
        );
        assert!(
            !store
                .load_rules()
                .unwrap()
                .default_preset_explicitly_cleared
        );
        assert_eq!(
            store.reference_profile("dots", &profile.role).unwrap(),
            Some(profile)
        );
    }

    #[test]
    fn failed_savepoint_release_never_leaves_an_open_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("reference.wav");
        fs::write(&original, b"RIFF reference recording WAVE").unwrap();
        let mut store = DataStore::open(temp.path().join("app")).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let preset = VoicePreset {
            id: "voice".into(),
            name: "声音".into(),
            connection_id: "dots".into(),
            provider: Provider::Dots,
            voice_id: "角色 A".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        store.save_preset(&preset).unwrap();
        // A deferred foreign-key violation makes the outermost RELEASE
        // (the commit) fail while the savepoint is still open.
        store
            .conn
            .execute_batch(
                "CREATE TABLE release_probe (preset_id TEXT REFERENCES presets(id)
                     DEFERRABLE INITIALLY DEFERRED);
                 CREATE TRIGGER release_probe_delete AFTER DELETE ON presets BEGIN
                     INSERT INTO release_probe VALUES ('missing-preset'); END;
                 CREATE TRIGGER release_probe_update AFTER UPDATE ON presets BEGIN
                     INSERT INTO release_probe VALUES ('missing-preset'); END;",
            )
            .unwrap();
        let other = DataStore::open(temp.path().join("app")).unwrap();

        assert!(matches!(
            store.delete_preset("voice"),
            Err(StorageError::Sql(_))
        ));
        assert!(store.conn.is_autocommit());
        assert_eq!(other.presets().unwrap(), vec![preset.clone()]);

        let profile = ReferenceProfile {
            connection_id: "dots".into(),
            role: ReferenceRole::Dots {
                role: "角色 A".into(),
            },
            audio_path: original.to_string_lossy().into_owned(),
            reference_text: String::new(),
            reference_language: String::new(),
            text_language: String::new(),
            text_free: false,
        };
        let mut renamed = preset.clone();
        renamed.name = "改名".into();
        assert!(matches!(
            store.save_dots_voice_with_preference(&renamed, &profile, true),
            Err(StorageError::Sql(_))
        ));
        assert!(store.conn.is_autocommit());
        assert_eq!(other.presets().unwrap(), vec![preset.clone()]);
        assert!(other.reference_profiles("dots").unwrap().is_empty());

        assert!(
            store
                .with_savepoint(|store| store.save_preset(&renamed))
                .is_err()
        );
        assert!(store.conn.is_autocommit());
        assert_eq!(other.presets().unwrap(), vec![preset]);

        // Later writes commit normally and are visible to other connections.
        let mut rules = RuleSet::default();
        rules.templates.danmaku = "之后的写入".into();
        store.save_rules(&rules).unwrap();
        assert_eq!(other.load_rules().unwrap(), rules);
    }

    #[test]
    fn original_reference_path_is_remembered_and_missing_file_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("selected.wav");
        fs::write(&source, b"RIFF reference recording WAVE").unwrap();
        let mut store = DataStore::open(temp.path().join("app")).unwrap();
        for (id, settings) in [
            (
                "dots",
                ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 180,
                },
            ),
            (
                "gpt",
                ConnectionSettings::GptSovits {
                    endpoint: "http://127.0.0.1:9880".into(),
                    timeout_secs: 300,
                },
            ),
        ] {
            store
                .save_connection(&ServiceConnection {
                    id: id.into(),
                    name: id.into(),
                    settings,
                    has_credential: false,
                })
                .unwrap();
        }
        let audio_path = source.to_string_lossy().into_owned();
        let dots = ReferenceProfile {
            connection_id: "dots".into(),
            role: ReferenceRole::Dots {
                role: "角色 A".into(),
            },
            audio_path: audio_path.clone(),
            reference_text: "你好".into(),
            reference_language: String::new(),
            text_language: String::new(),
            text_free: false,
        };
        let gpt = ReferenceProfile {
            connection_id: "gpt".into(),
            role: ReferenceRole::GptSovits {
                gpt_weights_path: "C:/Models/A.ckpt".into(),
                sovits_weights_path: "C:/Models/A.pth".into(),
            },
            audio_path,
            reference_text: "参考原文".into(),
            reference_language: "all_zh".into(),
            text_language: "auto".into(),
            text_free: false,
        };
        store.save_reference_profile(&dots).unwrap();
        store.save_reference_profile(&gpt).unwrap();
        let wrong = ReferenceProfile {
            connection_id: "dots".into(),
            ..gpt.clone()
        };
        assert!(matches!(
            store.save_reference_profile(&wrong),
            Err(StorageError::InvalidReferenceProfile)
        ));
        drop(store);
        let mut reopened = DataStore::open(temp.path().join("app")).unwrap();
        assert_eq!(
            reopened.reference_profile("dots", &dots.role).unwrap(),
            Some(dots.clone())
        );
        assert_eq!(
            reopened.reference_profiles("gpt").unwrap(),
            vec![gpt.clone()]
        );
        fs::remove_file(&source).unwrap();
        assert!(matches!(
            reopened.save_reference_profile(&dots),
            Err(StorageError::ReferenceAudioUnavailable)
        ));
        assert_eq!(
            reopened.reference_profile("dots", &dots.role).unwrap(),
            Some(dots)
        );
        assert!(!reopened.data_dir().join("references").exists());
        reopened.clear_application_data().unwrap();
        assert!(reopened.reference_profiles("dots").unwrap().is_empty());
    }

    #[test]
    fn v4_reference_migration_keeps_existing_copy_without_creating_an_invalid_profile() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("app");
        let mut store = DataStore::open(&data_dir).unwrap();
        store
            .save_connection(&ServiceConnection {
                id: "dots".into(),
                name: "dots".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        drop(store);

        let references = data_dir.join("references");
        fs::create_dir_all(&references).unwrap();
        let existing = references.join("old.wav");
        fs::write(&existing, b"RIFF reference recording WAVE").unwrap();
        let conn = Connection::open(data_dir.join("danmakuvoice.sqlite3")).unwrap();
        conn.execute_batch(
            "DROP TABLE reference_profiles;
             CREATE TABLE reference_audio (id TEXT PRIMARY KEY, file_name TEXT NOT NULL);
             CREATE TABLE reference_profiles (connection_id TEXT NOT NULL, role_key TEXT NOT NULL,
                 provider TEXT NOT NULL, audio_id TEXT NOT NULL, profile_json TEXT NOT NULL,
                 PRIMARY KEY(connection_id,role_key));
             PRAGMA user_version = 4;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO reference_audio(id,file_name) VALUES('old','old.wav')",
            [],
        )
        .unwrap();
        for (role_name, audio_id) in [("works", "old"), ("missing", "gone")] {
            let role = ReferenceRole::Dots {
                role: role_name.into(),
            };
            let json = serde_json::json!({
                "connection_id": "dots", "role": role, "audio_id": audio_id,
                "reference_text": "保留原文", "reference_language": "",
                "text_language": "", "text_free": false,
            });
            conn.execute(
                "INSERT INTO reference_profiles(connection_id,role_key,provider,audio_id,profile_json)
                 VALUES(?1,?2,?3,?4,?5)",
                params!["dots", role.storage_key(), "dots", audio_id, json.to_string()],
            )
            .unwrap();
        }
        drop(conn);

        let migrated = DataStore::open(&data_dir).unwrap();
        assert!(migrated.upgrade_backup().is_some_and(Path::is_file));
        assert!(existing.is_file());
        let profiles = migrated.reference_profiles("dots").unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].reference_text, "保留原文");
        assert_eq!(
            profiles[0].audio_path,
            existing.canonicalize().unwrap().to_string_lossy()
        );
        assert!(profiles[0].is_valid());
        assert!(
            migrated
                .reference_profile(
                    "dots",
                    &ReferenceRole::Dots {
                        role: "missing".into()
                    }
                )
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn service_urls_with_query_or_fragment_cannot_enter_plaintext_storage() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        for endpoint in [
            "http://127.0.0.1:9881/tts?api_key=private-url-token",
            "http://127.0.0.1:9881/tts#private-url-token",
        ] {
            let connection = ServiceConnection {
                id: "dots".into(),
                name: "本地声音".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: endpoint.into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            };
            assert!(matches!(
                store.save_connection(&connection),
                Err(StorageError::CredentialsInUrl)
            ));
        }
        assert!(store.connections().unwrap().is_empty());
        let export = serde_json::to_string(&store.export_configuration().unwrap()).unwrap();
        assert!(!export.contains("private-url-token"));

        // A database written by an earlier build may already contain this
        // URL. Export must fail instead of publishing the embedded token.
        let old_settings = serde_json::to_string(&ConnectionSettings::Dots {
            endpoint: "http://127.0.0.1:9881/tts?api_key=private-url-token".into(),
            timeout_secs: 30,
        })
        .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO connections(id,name,provider,settings_json) VALUES('old','旧连接','dots',?1)",
                [old_settings],
            )
            .unwrap();
        assert!(matches!(
            store.export_configuration(),
            Err(StorageError::CredentialsInUrl)
        ));
    }

    #[test]
    fn connection_timeouts_match_each_provider_before_persistence() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let cases = [
            (
                ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 4,
                },
                false,
            ),
            (
                ConnectionSettings::GptSovits {
                    endpoint: "http://127.0.0.1:9880".into(),
                    timeout_secs: 4,
                },
                false,
            ),
            (ConnectionSettings::FishAudio { timeout_secs: 4 }, false),
            (ConnectionSettings::Doubao { timeout_secs: 120 }, true),
            (ConnectionSettings::Doubao { timeout_secs: 121 }, false),
        ];
        for (index, (settings, accepted)) in cases.into_iter().enumerate() {
            let connection = ServiceConnection {
                id: format!("connection-{index}"),
                name: format!("Connection {index}"),
                settings,
                has_credential: false,
            };
            let result = store.save_connection(&connection);
            assert_eq!(result.is_ok(), accepted, "case {index}: {result:?}");
        }
        assert_eq!(store.connections().unwrap().len(), 1);

        // Historical metadata with an unusable timeout remains exportable
        // for recovery; only a URL containing a possible secret blocks export.
        let old_settings =
            serde_json::to_string(&ConnectionSettings::Doubao { timeout_secs: 180 }).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO connections(id,name,provider,settings_json) VALUES('old','Old','doubao',?1)",
                [old_settings],
            )
            .unwrap();
        assert_eq!(store.export_configuration().unwrap().connections.len(), 2);
    }

    #[test]
    fn failed_credential_protection_cannot_partially_save_connection() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let mut connection = ServiceConnection {
            id: "atomic".into(),
            name: "Original".into(),
            settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
            has_credential: false,
        };
        assert!(
            store
                .save_connection_with_credential(&connection, Some(b""))
                .is_err()
        );
        assert!(store.connections().unwrap().is_empty());

        store.save_connection(&connection).unwrap();
        connection.name = "Changed".into();
        assert!(
            store
                .save_connection_with_credential(&connection, Some(b""))
                .is_err()
        );
        assert_eq!(store.connections().unwrap()[0].name, "Original");
    }

    #[cfg(windows)]
    #[test]
    fn connection_and_credential_commit_together_without_exporting_secret() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let connection = ServiceConnection {
            id: "atomic".into(),
            name: "Fish".into(),
            settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
            has_credential: false,
        };
        store
            .save_connection_with_credential(&connection, Some(b"test-only-secret"))
            .unwrap();
        assert_eq!(
            store
                .connection_credential("atomic")
                .unwrap()
                .unwrap()
                .as_bytes(),
            b"test-only-secret"
        );
        assert!(
            !serde_json::to_string(&store.export_configuration().unwrap())
                .unwrap()
                .contains("test-only-secret")
        );
    }

    #[test]
    fn legacy_import_lock_blocks_other_writers_and_rollback_removes_nested_writes() {
        let temp = tempfile::tempdir().unwrap();
        let mut importer = DataStore::open(temp.path()).unwrap();
        let mut other = DataStore::open(temp.path()).unwrap();
        other.conn.busy_timeout(Duration::from_millis(50)).unwrap();
        importer.begin_legacy_import_transaction().unwrap();
        importer
            .save_connection(&ServiceConnection {
                id: "imported".into(),
                name: "旧版服务".into(),
                settings: ConnectionSettings::Dots {
                    endpoint: "http://127.0.0.1:9881".into(),
                    timeout_secs: 30,
                },
                has_credential: false,
            })
            .unwrap();
        let mut rules = RuleSet::default();
        rules.templates.danmaku = "imported template".into();
        importer.save_rules(&rules).unwrap();

        let preferences = DesktopPreferences {
            onboarding_done: true,
            ..DesktopPreferences::default()
        };
        assert!(other.save_desktop_preferences(&preferences).is_err());
        importer.finish_legacy_import_transaction(false).unwrap();
        assert!(other.connections().unwrap().is_empty());
        assert_eq!(other.load_rules().unwrap(), RuleSet::default());
        other.save_desktop_preferences(&preferences).unwrap();
        assert_eq!(importer.load_desktop_preferences().unwrap(), preferences);
    }

    #[test]
    fn application_reset_removes_sensitive_rows_and_retains_schema_without_backup() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let marker = "reset-test-only-sensitive-record-unique";
        store
            .conn
            .execute(
                "INSERT INTO protected_secrets(key,protected_value) VALUES('fixture',?1)",
                [marker.as_bytes()],
            )
            .unwrap();
        let prefs = DesktopPreferences {
            onboarding_done: true,
            broadcaster_uid: Some(42),
            ..DesktopPreferences::default()
        };
        store.save_desktop_preferences(&prefs).unwrap();
        store.clear_application_data().unwrap();
        store.purge_deleted_application_data().unwrap();
        assert_eq!(
            store.load_desktop_preferences().unwrap(),
            DesktopPreferences::default()
        );
        let count: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM protected_secrets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        let schema: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(schema, CURRENT_SCHEMA);
        assert_eq!(
            fs::read_dir(temp.path().join("backups")).unwrap().count(),
            0
        );
        let bytes = fs::read(temp.path().join("danmakuvoice.sqlite3")).unwrap();
        assert!(
            !bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes())
        );
        let wal = fs::read(temp.path().join("danmakuvoice.sqlite3-wal")).unwrap_or_default();
        assert!(
            !wal.windows(marker.len())
                .any(|window| window == marker.as_bytes())
        );
    }

    #[test]
    fn committed_reset_can_retry_physical_purge_after_reader_exits() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let reader = DataStore::open(temp.path()).unwrap();
        reader.conn.execute_batch("BEGIN DEFERRED").unwrap();
        let _: i64 = reader
            .conn
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        store.conn.busy_timeout(Duration::from_millis(50)).unwrap();
        store
            .save_desktop_preferences(&DesktopPreferences {
                onboarding_done: true,
                ..DesktopPreferences::default()
            })
            .unwrap();
        store.clear_application_data().unwrap();
        assert_eq!(
            store.load_desktop_preferences().unwrap(),
            DesktopPreferences::default()
        );
        assert!(matches!(
            store.purge_deleted_application_data(),
            Err(StorageError::DataResetBusy)
        ));
        reader.conn.execute_batch("ROLLBACK").unwrap();
        store.purge_deleted_application_data().unwrap();
    }

    #[test]
    fn isolated_directory_asset_reference_and_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.wav");
        fs::write(&source, b"RIFFsample").unwrap();
        let raw_pcm = temp.path().join("clip.pcm");
        fs::write(&raw_pcm, [0u8; 64]).unwrap();
        let data_dir = temp.path().join("isolated");
        let mut store = DataStore::open(&data_dir).unwrap();
        assert!(matches!(
            store.import_asset(&raw_pcm, "无格式元数据的 PCM"),
            Err(StorageError::UnsupportedAudio(_))
        ));
        assert_eq!(store.load_rules().unwrap(), RuleSet::default());
        let asset = store.import_asset(&source, "测试音效").unwrap();
        assert_eq!(store.assets().unwrap(), vec![asset.clone()]);
        let original_managed_path = store.asset_path(&asset.id).unwrap();
        assert_ne!(original_managed_path, source);
        let mut rules = RuleSet::default();
        rules.sounds.push(SoundRule {
            trigger: "叮".into(),
            asset_id: asset.id.clone(),
        });
        store.save_rules(&rules).unwrap();
        assert_eq!(store.load_rules().unwrap(), rules);
        assert!(matches!(
            store.delete_asset(&asset.id),
            Err(StorageError::AssetReferenced(_))
        ));
        rules.sounds.clear();
        store.save_rules(&rules).unwrap();
        store.delete_asset(&asset.id).unwrap();
        assert!(store.assets().unwrap().is_empty());
        assert!(!store.asset_path(&asset.id).is_ok());
        assert!(original_managed_path.exists());
        assert!(source.exists());
    }

    #[test]
    fn replacing_asset_keeps_queued_file_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first.wav");
        let second = temp.path().join("second.wav");
        fs::write(&first, b"RIFF first").unwrap();
        fs::write(&second, b"RIFF second").unwrap();
        let mut store = DataStore::open(temp.path().join("data")).unwrap();
        let asset = store.import_asset(&first, "sound").unwrap();
        let queued_path = store.asset_path(&asset.id).unwrap();
        let replacement = store.replace_asset(&asset.id, &second).unwrap();
        assert_eq!(replacement.id, asset.id);
        assert_ne!(store.asset_path(&asset.id).unwrap(), queued_path);
        assert_eq!(fs::read(queued_path).unwrap(), b"RIFF first");
        assert_eq!(
            fs::read(store.asset_path(&asset.id).unwrap()).unwrap(),
            b"RIFF second"
        );
    }

    #[test]
    fn first_start_waits_for_another_instance_creating_the_schema() {
        let temp = tempfile::tempdir().unwrap();
        let template = DataStore::open(temp.path().join("template")).unwrap();
        let schema = template
            .conn
            .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        drop(template);
        let data_dir = temp.path().join("data");
        fs::create_dir_all(&data_dir).unwrap();
        // Another instance has switched the new file to WAL and is creating
        // the schema; its transaction is still open when this one starts.
        let other = Connection::open(data_dir.join("danmakuvoice.sqlite3")).unwrap();
        other
            .execute_batch(
                "PRAGMA journal_mode = WAL; CREATE TABLE warmup(x); DROP TABLE warmup;
                 BEGIN IMMEDIATE;",
            )
            .unwrap();
        for sql in &schema {
            other.execute_batch(sql).unwrap();
        }
        other
            .pragma_update(None, "user_version", CURRENT_SCHEMA)
            .unwrap();
        let opening = std::thread::spawn({
            let data_dir = data_dir.clone();
            move || DataStore::open(data_dir).map(|store| store.upgrade_backup().is_none())
        });
        std::thread::sleep(Duration::from_millis(300));
        other.execute_batch("COMMIT").unwrap();
        assert!(opening.join().unwrap().unwrap());
        let store = DataStore::open(&data_dir).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA);
        assert_eq!(store.load_rules().unwrap(), RuleSet::default());
    }

    #[test]
    fn upgrade_backup_keeps_the_previous_schema_for_manual_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        fs::create_dir_all(&data_dir).unwrap();
        let path = data_dir.join("danmakuvoice.sqlite3");
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);\
            CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,\
            sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0));\
            INSERT INTO settings(key,json) VALUES('marker','{}');\
            PRAGMA user_version = 1;").unwrap();
        drop(conn);
        let store = DataStore::open(&data_dir).unwrap();
        let snapshot = store.upgrade_backup().unwrap().to_path_buf();
        assert!(snapshot.exists());
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, CURRENT_SCHEMA);
        // The snapshot is only for manual recovery; nothing restores it.
        let backup =
            Connection::open_with_flags(&snapshot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let previous: i64 = backup
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(previous, 1);
        let marker: String = backup
            .query_row("SELECT json FROM settings WHERE key='marker'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(marker, "{}");
    }

    #[test]
    fn snapshots_preserve_configuration_but_never_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let store = DataStore::open(temp.path()).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO protected_secrets VALUES('bilibili', ?1)",
                params![b"test-encrypted-cookie-marker".as_slice()],
            )
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO connections VALUES('fish','Fish','fish_audio',?1,?2)",
                params![
                    r#"{"FishAudio":{"timeout_secs":30}}"#,
                    b"test-encrypted-api-key-marker".as_slice()
                ],
            )
            .unwrap();
        let backup = store.backup_before_legacy_import().unwrap();
        let snapshot = Connection::open(&backup).unwrap();
        assert!(!backup_has_credentials(&snapshot).unwrap());
        assert_eq!(
            snapshot
                .query_row("SELECT name FROM connections WHERE id='fish'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "Fish"
        );
        assert!(backup_has_credentials(&store.conn).unwrap());
        let bytes = fs::read(backup).unwrap();
        for marker in [
            b"test-encrypted-api-key-marker".as_slice(),
            b"test-encrypted-cookie-marker".as_slice(),
        ] {
            assert!(!bytes.windows(marker.len()).any(|part| part == marker));
        }
    }

    #[test]
    fn logout_scrubs_old_snapshots_and_retains_only_five_owned_backups() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO protected_secrets VALUES('bilibili', ?1)",
                params![b"test-encrypted-cookie-marker".as_slice()],
            )
            .unwrap();
        let directory = temp.path().join("backups");
        fs::write(directory.join("user.sqlite3"), b"keep user file").unwrap();
        for stamp in (94..=100).rev() {
            let path = directory.join(format!(
                "before-legacy-import-{stamp}-{}.sqlite3",
                Uuid::new_v4()
            ));
            store.conn.backup(rusqlite::MAIN_DB, &path, None).unwrap();
        }
        assert!(store.clear_bili_session().unwrap());
        let mut count = 0;
        for entry in fs::read_dir(&directory).unwrap() {
            let entry = entry.unwrap();
            if is_database_backup(entry.file_name().to_str().unwrap()) {
                count += 1;
                let backup = Connection::open(entry.path()).unwrap();
                assert!(!backup_has_credentials(&backup).unwrap());
                assert_eq!(schema_version(&backup).unwrap(), CURRENT_SCHEMA);
                let name = entry.file_name();
                let stamp = name
                    .to_str()
                    .unwrap()
                    .strip_prefix("before-legacy-import-")
                    .unwrap()
                    .split('-')
                    .next()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                assert!(stamp >= 96, "retained an older snapshot: {stamp}");
            }
        }
        assert_eq!(count, MAX_DATABASE_BACKUPS);
        assert_eq!(
            fs::read(directory.join("user.sqlite3")).unwrap(),
            b"keep user file"
        );
        assert!(!store.clear_bili_session().unwrap());
    }

    #[test]
    fn missing_sound_asset_cannot_replace_valid_rules() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let mut rules = RuleSet::default();
        rules.sounds.push(crate::rules::SoundRule {
            trigger: "叮".into(),
            asset_id: "missing".into(),
        });
        assert!(matches!(
            store.save_rules(&rules),
            Err(StorageError::AssetMissing(_))
        ));
        assert_eq!(store.load_rules().unwrap(), RuleSet::default());
        assert!(store.conn.is_autocommit());
    }

    #[cfg(windows)]
    #[test]
    fn credential_is_protected_and_excluded_from_export() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let connection = ServiceConnection {
            id: "fish".into(),
            name: "Fish".into(),
            settings: ConnectionSettings::FishAudio { timeout_secs: 30 },
            has_credential: false,
        };
        store.save_connection(&connection).unwrap();
        store
            .set_connection_credential("fish", b"local-test-key-example")
            .unwrap();
        assert_eq!(
            store
                .connection_credential("fish")
                .unwrap()
                .unwrap()
                .as_bytes(),
            b"local-test-key-example"
        );
        let preset = VoicePreset {
            id: "voice".into(),
            name: "测试声音".into(),
            connection_id: "fish".into(),
            provider: Provider::FishAudio,
            voice_id: "reference".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        };
        store.save_preset(&preset).unwrap();
        let binding = VoiceBinding {
            platform: "bilibili".into(),
            user_id: Some(42),
            user_name: None,
            legacy_user_name: None,
            preset_id: "voice".into(),
            enabled: true,
        };
        store.save_binding("binding", &binding).unwrap();
        assert_eq!(
            store.binding_records().unwrap(),
            vec![BindingRecord {
                id: "binding".into(),
                binding: binding.clone(),
            }]
        );
        let export = store.export_configuration().unwrap();
        assert_eq!(export.presets, vec![preset]);
        assert_eq!(export.bindings, vec![binding]);
        let text = serde_json::to_string(&export).unwrap();
        assert!(!text.contains("local-test-key-example"));
        let db = fs::read(temp.path().join("danmakuvoice.sqlite3")).unwrap();
        assert!(
            !db.windows(b"local-test-key-example".len())
                .any(|window| window == b"local-test-key-example")
        );
        let switched = ServiceConnection {
            id: "fish".into(),
            name: "改为本地服务".into(),
            settings: ConnectionSettings::Dots {
                endpoint: "http://127.0.0.1:9880".into(),
                timeout_secs: 30,
            },
            has_credential: false,
        };
        assert!(matches!(
            store.save_connection(&switched),
            Err(StorageError::ConnectionProviderInUse)
        ));
        assert!(store.clear_connection_credential("fish").unwrap());
        assert!(store.connection_credential("fish").unwrap().is_none());
        assert!(!store.clear_connection_credential("fish").unwrap());
        assert!(matches!(
            store.clear_connection_credential("missing"),
            Err(StorageError::ConnectionMissing(_))
        ));
        store.delete_binding("binding").unwrap();
        store.delete_preset("voice").unwrap();
        store.save_connection(&switched).unwrap();
        assert!(store.connection_credential("fish").unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn qr_session_uses_dpapi_and_logout_clears_it() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let session = BiliSession::from_secret_payload(
            br#"{"user_id":42,"sessdata":"session-secret","bili_jct":"csrf-secret","buvid3":null,"refresh_token":null}"#
        ).unwrap();
        store.save_bili_session(&session).unwrap();
        assert_eq!(store.load_bili_session().unwrap().unwrap().user_id(), 42);
        let export = serde_json::to_string(&store.export_configuration().unwrap()).unwrap();
        assert!(!export.contains("session-secret"));
        let db = fs::read(temp.path().join("danmakuvoice.sqlite3")).unwrap();
        assert!(
            !db.windows(b"session-secret".len())
                .any(|window| window == b"session-secret")
        );
        assert!(store.clear_bili_session().unwrap());
        assert!(store.load_bili_session().unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn dobao_device_identity_is_stable_protected_and_not_exported() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = DataStore::open(temp.path()).unwrap();
        let generated = first.load_or_create_dobao_device().unwrap();
        generated.validate().unwrap();
        let mut second = DataStore::open(temp.path()).unwrap();
        assert_eq!(second.load_or_create_dobao_device().unwrap(), generated);
        let export = serde_json::to_string(&second.export_configuration().unwrap()).unwrap();
        assert!(!export.contains(&generated.device_id));
        assert!(!export.contains(&generated.web_id));
        let db = fs::read(temp.path().join("danmakuvoice.sqlite3")).unwrap();
        assert!(
            !db.windows(generated.device_id.len())
                .any(|window| window == generated.device_id.as_bytes())
        );
    }

    #[test]
    fn live_settings_roundtrip_and_validation() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        assert_eq!(store.load_live_settings().unwrap(), LiveSettings::default());
        let settings = LiveSettings {
            room_id: Some(42),
            gift_merge: crate::model::GiftMergeSettings {
                enabled: true,
                initial_seconds: 1.5,
                increment_seconds: 0.5,
                maximum_seconds: 5.0,
            },
        };
        store.save_live_settings(&settings).unwrap();
        assert_eq!(store.load_live_settings().unwrap(), settings);
        let mut invalid = settings;
        invalid.gift_merge.maximum_seconds = 0.5;
        assert!(matches!(
            store.save_live_settings(&invalid),
            Err(StorageError::InvalidLiveSettings)
        ));
    }

    #[test]
    fn desktop_preferences_survive_restart_and_reject_invalid_audio_choices() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        assert_eq!(
            store.load_desktop_preferences().unwrap(),
            DesktopPreferences::default()
        );
        let preferences = DesktopPreferences {
            appearance: AppearancePreference::System,
            language: LanguagePreference::English,
            scale: 1.25,
            output: OutputSelection::Named("Speakers (USB DAC)".into()),
            master_volume: 0.65,
            muted: true,
            onboarding_done: true,
            broadcaster_uid: Some(42),
            authenticated: false,
            tts_enabled: false,
            broadcast_console: true,
        };
        store.save_desktop_preferences(&preferences).unwrap();
        drop(store);
        let mut reopened = DataStore::open(temp.path()).unwrap();
        assert_eq!(reopened.load_desktop_preferences().unwrap(), preferences);
        assert_eq!(preferences.playback_volume(), 0.0);
        let mut unmuted = preferences.clone();
        unmuted.muted = false;
        assert_eq!(unmuted.playback_volume(), 0.65);
        let exported = serde_json::to_string(&reopened.export_configuration().unwrap()).unwrap();
        assert!(!exported.contains("Speakers (USB DAC)"));
        let mut invalid = preferences;
        invalid.master_volume = f32::NAN;
        assert!(matches!(
            reopened.save_desktop_preferences(&invalid),
            Err(StorageError::InvalidDesktopPreferences)
        ));
        assert_eq!(
            reopened.load_desktop_preferences().unwrap().master_volume,
            0.65
        );
        invalid.master_volume = 1.0;
        invalid.broadcaster_uid = Some(0);
        assert!(matches!(
            reopened.save_desktop_preferences(&invalid),
            Err(StorageError::InvalidDesktopPreferences)
        ));
    }

    #[test]
    fn obs_settings_round_trip_validate_and_stay_out_of_exports() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        assert_eq!(store.load_obs_settings().unwrap(), ObsSettings::default());
        assert!(!store.has_obs_password().unwrap());
        let settings = ObsSettings {
            enabled: true,
            host: "obs-fictional-host.lan".into(),
            port: 4460,
            auto_launch: false,
            executable: Some(
                std::env::temp_dir()
                    .join("obs64.exe")
                    .to_string_lossy()
                    .into_owned(),
            ),
        };
        store.save_obs_settings(&settings).unwrap();
        for broken in [
            ObsSettings {
                host: "ws://127.0.0.1".into(),
                ..settings.clone()
            },
            ObsSettings {
                port: 0,
                ..settings.clone()
            },
            ObsSettings {
                executable: Some("C:\\Windows\\System32\\cmd.exe".into()),
                ..settings.clone()
            },
        ] {
            assert!(matches!(
                store.save_obs_settings(&broken),
                Err(StorageError::InvalidObsSettings)
            ));
        }
        assert!(matches!(
            store.save_obs_password("line\nbreak"),
            Err(StorageError::InvalidObsSettings)
        ));
        drop(store);
        let reopened = DataStore::open(temp.path()).unwrap();
        assert_eq!(reopened.load_obs_settings().unwrap(), settings);
        let exported = serde_json::to_string(&reopened.export_configuration().unwrap()).unwrap();
        assert!(!exported.contains("obs-fictional-host"));
    }

    #[cfg(windows)]
    #[test]
    fn obs_password_is_protected_cleared_and_never_exported() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        store.save_obs_password("fictional-obs-password").unwrap();
        assert!(store.has_obs_password().unwrap());
        assert_eq!(
            store.load_obs_password().unwrap().unwrap().as_str(),
            "fictional-obs-password"
        );
        let exported = serde_json::to_string(&store.export_configuration().unwrap()).unwrap();
        assert!(!exported.contains("fictional-obs-password"));
        store.save_obs_password("").unwrap();
        assert!(!store.has_obs_password().unwrap());
        assert!(store.load_obs_password().unwrap().is_none());
        drop(store);
        for entry in fs::read_dir(temp.path()).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let bytes = fs::read(&path).unwrap();
                assert!(
                    !bytes
                        .windows(b"fictional-obs-password".len())
                        .any(|w| w == b"fictional-obs-password"),
                    "{}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn overlay_settings_round_trip_validate_and_stay_out_of_exports() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        let defaults = store.load_overlay_settings().unwrap();
        assert_eq!(defaults, OverlaySettings::default());
        assert!(!defaults.enabled);
        assert_eq!(defaults.port, OVERLAY_DEFAULT_PORT);
        let settings = OverlaySettings {
            enabled: true,
            style: OverlayStyle::Card,
            corner: OverlayCorner::BottomRight,
            offset_x: -47,
            offset_y: 29,
            scale: 1.25,
            vignette: 0.8,
            history_opacity: 0.9,
            title: "上分夜".into(),
            tagline: "say a word — it'll be read aloud.".into(),
            names: OverlayNames::None,
            linger_seconds: 30,
            token: "0123456789abcdef0123456789abcdef".into(),
            ..OverlaySettings::default()
        };
        store.save_overlay_settings(&settings).unwrap();
        drop(store);
        let mut reopened = DataStore::open(temp.path()).unwrap();
        assert_eq!(reopened.load_overlay_settings().unwrap(), settings);
        let exported = serde_json::to_string(&reopened.export_configuration().unwrap()).unwrap();
        assert!(!exported.contains("0123456789abcdef"));
        for broken in [
            OverlaySettings {
                offset_x: -8193,
                ..settings.clone()
            },
            OverlaySettings {
                offset_y: 8193,
                ..settings.clone()
            },
            OverlaySettings {
                scale: f32::NAN,
                ..settings.clone()
            },
            OverlaySettings {
                scale: 3.0,
                ..settings.clone()
            },
            OverlaySettings {
                vignette: -0.1,
                ..settings.clone()
            },
            OverlaySettings {
                history_opacity: 0.2,
                ..settings.clone()
            },
            OverlaySettings {
                history_opacity: f32::NAN,
                ..settings.clone()
            },
            OverlaySettings {
                title: "  ".into(),
                ..settings.clone()
            },
            OverlaySettings {
                title: "长".repeat(25),
                ..settings.clone()
            },
            OverlaySettings {
                tagline: "line\nbreak".into(),
                ..settings.clone()
            },
            OverlaySettings {
                linger_seconds: 2,
                ..settings.clone()
            },
            OverlaySettings {
                port: 80,
                ..settings.clone()
            },
            OverlaySettings {
                token: "ABCDEF".into(),
                ..settings.clone()
            },
        ] {
            assert!(matches!(
                reopened.save_overlay_settings(&broken),
                Err(StorageError::InvalidOverlaySettings)
            ));
        }
        let edited = OverlaySettings {
            title: "  夜聊  ".into(),
            port: 2000,
            token: String::new(),
            ..settings.clone()
        };
        let merged = settings.with_edits_from(&edited);
        assert_eq!(merged.title, "夜聊");
        assert_eq!(merged.port, settings.port);
        assert_eq!(merged.token, settings.token);
        assert_eq!(merged.style, OverlayStyle::Spine);
        // The readability controls are the user's again.
        assert_eq!(merged.vignette, 0.8);
        assert_eq!(merged.history_opacity, 0.9);
        assert_eq!(merged.linger_seconds, 14);
        let migrated = settings.clone().with_lake_design();
        assert_eq!(migrated.corner, settings.corner);
        assert_eq!((migrated.offset_x, migrated.offset_y), (-47, 29));
        assert_eq!(migrated.scale, settings.scale);
        assert_eq!(migrated.token, settings.token);
        let old: OverlaySettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(old.style, OverlayStyle::Spine);
        assert_eq!(old.title, OVERLAY_DEFAULT_TITLE);
        assert_eq!((old.offset_x, old.offset_y), (0, 0));
        for offset in [-8192, 8192] {
            OverlaySettings {
                offset_x: offset,
                offset_y: offset,
                ..settings.clone()
            }
            .validate()
            .unwrap();
        }
    }

    #[test]
    fn old_desktop_preferences_keep_saved_theme_and_speech_behavior() {
        let old: DesktopPreferences = serde_json::from_str(
            r#"{"appearance":"dark","scale":1.0,"output":"default","master_volume":0.8,"onboarding_done":true}"#,
        )
        .unwrap();
        assert_eq!(old.appearance, AppearancePreference::Dark);
        assert_eq!(old.language, LanguagePreference::Chinese);
        assert!(old.onboarding_done);
        assert!(old.tts_enabled);
        assert!(!old.muted);
        assert!(!old.authenticated);
        assert!(!old.broadcast_console);
        assert_eq!(old.broadcaster_uid, None);
        let new: DesktopPreferences = serde_json::from_str("{}").unwrap();
        assert_eq!(new.appearance, AppearancePreference::System);
        assert_eq!(new.language, LanguagePreference::Chinese);
        assert!(serde_json::from_str::<DesktopPreferences>(r#"{"language":"fr"}"#).is_err());
        assert!(!new.onboarding_done);
    }

    #[test]
    fn read_snapshot_does_not_mix_concurrent_commits() {
        let temp = tempfile::tempdir().unwrap();
        let mut reader = DataStore::open(temp.path()).unwrap();
        let mut writer = DataStore::open(temp.path()).unwrap();
        let mut first = RuleSet::default();
        first.templates.danmaku = "before".into();
        reader.save_rules(&first).unwrap();
        let mut second = first.clone();
        second.templates.danmaku = "after".into();

        reader
            .with_read_snapshot::<_, StorageError>(|snapshot| {
                assert_eq!(snapshot.load_rules()?, first);
                writer.save_rules(&second)?;
                assert_eq!(snapshot.load_rules()?, first);
                Ok(())
            })
            .unwrap();
        assert_eq!(reader.load_rules().unwrap(), second);
    }
    #[test]
    fn standalone_emote_filter_persists_and_old_rules_default_on() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = DataStore::open(temp.path()).unwrap();
        assert!(store.load_rules().unwrap().events.filter_bilibili_emoticons);
        let mut rules = RuleSet::default();
        rules.templates.danmaku = "保留{message}".into();
        rules.events.gift_threshold_yuan = 8.0;
        let mut old = serde_json::to_value(&rules).unwrap();
        old["events"]
            .as_object_mut()
            .unwrap()
            .remove("filter_bilibili_emoticons");
        store
            .conn
            .execute(
                "INSERT INTO settings(key,json) VALUES('rules',?1)",
                params![old.to_string()],
            )
            .unwrap();
        assert_eq!(store.load_rules().unwrap(), rules);
        for enabled in [true, false] {
            rules.events.filter_bilibili_emoticons = enabled;
            store.save_rules(&rules).unwrap();
            drop(store);
            store = DataStore::open(temp.path()).unwrap();
            assert_eq!(store.load_rules().unwrap(), rules);
        }
    }
}
