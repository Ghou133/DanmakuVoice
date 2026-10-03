use serde::{Deserialize, Serialize};

/// The normalized event owned by the engine. UI code never parses platform packets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LiveEvent {
    pub room_id: u64,
    pub user_id: Option<u64>,
    pub user_name: String,
    /// CDN image from the event payload, if the platform supplied one.
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub kind: EventKind,
    /// Original message body, before any replacement.
    pub message: String,
    /// Text tokens and their CDN images for displaying rich danmaku.
    #[serde(default)]
    pub emotes: Vec<LiveEmote>,
    /// Bilibili DANMU_MSG has dm_type=1 (info[0][12]): a standalone emote.
    /// Missing or unknown types remain ordinary text, regardless of its contents.
    #[serde(default)]
    pub is_bilibili_emoticon: bool,
    pub gift_name: String,
    pub quantity: u32,
    /// Gift/SC price in yuan. Bilibili's gift packet uses thousandths of yuan.
    pub price_yuan: f64,
    /// `silver` identifies a free gift in legacy Bilibili packets.
    pub coin_type: Option<String>,
    pub guard_name: String,
    pub platform_event_id: Option<String>,
    pub observed_at_ms: u64,
}

impl LiveEvent {
    pub fn danmaku(room_id: u64, user_id: Option<u64>, user_name: &str, message: &str) -> Self {
        Self {
            room_id,
            user_id,
            user_name: user_name.into(),
            avatar_url: None,
            kind: EventKind::Danmaku,
            message: message.into(),
            emotes: Vec::new(),
            is_bilibili_emoticon: false,
            gift_name: String::new(),
            quantity: 0,
            price_yuan: 0.0,
            coin_type: None,
            guard_name: String::new(),
            platform_event_id: None,
            observed_at_ms: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LiveEmote {
    pub text: String,
    pub url: String,
    /// Bilibili's whole-message emoticon keeps its larger display size.
    #[serde(default)]
    pub large: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GiftMergeSettings {
    pub enabled: bool,
    pub initial_seconds: f64,
    pub increment_seconds: f64,
    pub maximum_seconds: f64,
}

impl Default for GiftMergeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            initial_seconds: 1.5,
            increment_seconds: 0.5,
            maximum_seconds: 5.0,
        }
    }
}

impl GiftMergeSettings {
    pub fn is_valid(&self) -> bool {
        self.initial_seconds.is_finite()
            && (0.1..=30.0).contains(&self.initial_seconds)
            && self.increment_seconds.is_finite()
            && (0.0..=30.0).contains(&self.increment_seconds)
            && self.maximum_seconds.is_finite()
            && (self.initial_seconds..=60.0).contains(&self.maximum_seconds)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LiveSettings {
    pub room_id: Option<u64>,
    pub gift_merge: GiftMergeSettings,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Danmaku,
    Gift,
    SuperChat,
    Guard,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Dots,
    GptSovits,
    FishAudio,
    Doubao,
}

/// A preset names a service connection; its values are copied into each plan.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoicePreset {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub provider: Provider,
    pub voice_id: String,
    pub speed: f32,
    pub volume: f32,
    /// Provider-specific request settings. Existing SQLite JSON defaults to
    /// the resident-model behavior when this field is absent.
    #[serde(default)]
    pub sovits: Option<SovitsVoiceSettings>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SovitsModelSelection {
    /// Use only the model already loaded by the user's GPT-SoVITS service.
    GlobalResident,
    /// Select a GPT/SoVITS pair atomically for this single request.
    PerRequestAtomic,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SovitsVoiceSettings {
    pub model_selection: SovitsModelSelection,
    pub gpt_weights_path: Option<String>,
    pub sovits_weights_path: Option<String>,
    pub reference_text: String,
    pub reference_text_free: bool,
    pub reference_language: String,
    pub text_language: String,
    pub split: String,
    pub top_k: u16,
    pub top_p: f32,
    pub temperature: f32,
    pub sample_steps: u16,
    pub super_sampling: bool,
    pub fragment_interval_secs: f32,
}

impl Default for SovitsVoiceSettings {
    fn default() -> Self {
        Self {
            model_selection: SovitsModelSelection::GlobalResident,
            gpt_weights_path: None,
            sovits_weights_path: None,
            reference_text: String::new(),
            reference_text_free: true,
            reference_language: "all_zh".into(),
            text_language: "all_zh".into(),
            split: "cut0".into(),
            top_k: 5,
            top_p: 1.0,
            temperature: 1.0,
            sample_steps: 8,
            super_sampling: false,
            fragment_interval_secs: 0.3,
        }
    }
}

/// Explicit name bindings match the displayed Bilibili username exactly.
/// Old imported names remain separate and never select a voice by themselves.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct VoiceBinding {
    pub platform: String,
    pub user_id: Option<u64>,
    #[serde(default)]
    pub user_name: Option<String>,
    pub legacy_user_name: Option<String>,
    pub preset_id: String,
    pub enabled: bool,
}

impl VoiceBinding {
    pub fn matches_confirmed_user(&self, user_id: Option<u64>) -> bool {
        self.enabled
            && self.platform == "bilibili"
            && self.user_id.is_some()
            && self.user_id == user_id
    }

    pub fn matches_explicit_name(&self, user_name: &str) -> bool {
        self.enabled
            && self.platform == "bilibili"
            && self.user_id.is_none()
            && self.user_name.as_deref() == Some(user_name)
    }
}
