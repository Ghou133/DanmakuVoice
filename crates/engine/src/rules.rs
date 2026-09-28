//! Deterministic rule preview. This module never calls a TTS provider.

use crate::model::{EventKind, LiveEvent, VoiceBinding, VoicePreset};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

const MAX_TEMPLATE_BYTES: usize = 8 * 1024;
const MAX_KEYWORD_BYTES: usize = 512;
const MAX_REPLACEMENT_BYTES: usize = 2 * 1024;
const MAX_PLAN_BYTES: usize = 64 * 1024;
const MAX_PLAN_PARTS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Replacement {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SoundRule {
    pub trigger: String,
    /// Stable managed asset ID; resolution and validation happen before synthesis.
    pub asset_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventRules {
    pub danmaku_on: bool,
    pub gift_on: bool,
    pub free_gift_on: bool,
    pub super_chat_on: bool,
    pub guard_on: bool,
    pub gift_threshold_yuan: f64,
    pub super_chat_threshold_yuan: f64,
}

impl Default for EventRules {
    fn default() -> Self {
        Self {
            danmaku_on: true,
            gift_on: true,
            free_gift_on: false,
            super_chat_on: true,
            guard_on: true,
            gift_threshold_yuan: 5.0,
            super_chat_threshold_yuan: 30.0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EventTemplates {
    pub danmaku: String,
    pub gift: String,
    pub super_chat: String,
    pub guard: String,
}

impl Default for EventTemplates {
    fn default() -> Self {
        Self {
            danmaku: "\"{user_name}\"说:\"{message}\"".into(),
            gift: "\"{user_name}\"赠送了{gift_num}个{gift_name}".into(),
            super_chat: "\"{user_name}\"发送了一条醒目留言，他说\"{message}\"".into(),
            guard: "感谢\"{user_name}\"赠送的{guard_name}".into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RuleSet {
    pub events: EventRules,
    pub templates: EventTemplates,
    pub user_words: Vec<Replacement>,
    pub message_words: Vec<Replacement>,
    pub sounds: Vec<SoundRule>,
    pub default_preset_id: Option<String>,
    /// The most recently chosen voice for each TTS. Switching services can
    /// restore that voice without changing the single live primary rule.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub preferred_presets: BTreeMap<crate::model::Provider, String>,
    /// An explicit "no primary voice" choice must survive later service and
    /// preset additions. Older rule JSON defaults to automatic first choice.
    #[serde(default)]
    pub default_preset_explicitly_cleared: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum PlanPart {
    Text(String),
    Sound { trigger: String, asset_id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RulePreview {
    pub event: LiveEvent,
    pub filtered_reason: Option<String>,
    pub final_text: String,
    pub parts: Vec<PlanPart>,
    pub voice: Option<VoicePreset>,
    /// The default preset at preview time, frozen for a possible bound-voice
    /// fallback when this job reaches the playback queue.
    pub default_voice: Option<VoicePreset>,
    /// True only when a confirmed user binding selected `voice`.
    pub voice_from_binding: bool,
    /// A migrated name-only binding was found but deliberately not applied.
    pub pending_legacy_binding: bool,
}

impl RulePreview {
    /// Match the legacy rule that punctuation surrounding a sound trigger
    /// does not cause a separate TTS request.
    pub fn needs_tts(&self) -> bool {
        self.parts.iter().any(|part| match part {
            PlanPart::Text(text) => text.chars().any(char::is_alphanumeric),
            PlanPart::Sound { .. } => false,
        })
    }

    pub fn has_playable_audio(&self) -> bool {
        self.needs_tts()
            || self
                .parts
                .iter()
                .any(|part| matches!(part, PlanPart::Sound { .. }))
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum RuleError {
    #[error("模板缺少结束括号")]
    UnclosedField,
    #[error("模板中存在孤立的结束括号")]
    UnexpectedClose,
    #[error("不支持的模板字段：{0}")]
    UnknownField(String),
    #[error("配置过大：{0}")]
    TooLarge(&'static str),
    #[error("试听文本不能为空、不能超过 2000 字，且不能包含控制字符")]
    InvalidAuditionText,
    #[error("{event}模板无效：{reason}")]
    InvalidTemplate { event: &'static str, reason: String },
    #[error("礼物与醒目留言金额阈值必须是非负有限数")]
    InvalidThreshold,
    #[error("词典关键词不能为空")]
    EmptyKeyword,
    #[error("关键词音效需要非空关键词和素材")]
    InvalidSoundRule,
}

impl RulePreview {
    /// A direct voice audition uses exactly the chosen persisted preset and
    /// sample text. It does not apply live filters, bindings, templates or
    /// sound substitutions, and never changes the default voice rule.
    pub fn voice_audition(preset: VoicePreset, text: &str) -> Result<Self, RuleError> {
        if text.trim().is_empty()
            || text.chars().count() > 2000
            || text.chars().any(char::is_control)
        {
            return Err(RuleError::InvalidAuditionText);
        }
        Ok(Self {
            event: LiveEvent::danmaku(0, None, "试听", text),
            filtered_reason: None,
            final_text: text.to_owned(),
            parts: vec![PlanPart::Text(text.to_owned())],
            voice: Some(preset),
            default_voice: None,
            voice_from_binding: false,
            pending_legacy_binding: false,
        })
    }
}

/// Apply case-sensitive literal replacements once, using the earliest match and
/// longest key at the same position. Newly generated words are never rescanned.
pub fn replace_words(text: &str, rules: &[Replacement]) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    let keys = rules
        .iter()
        .map(|rule| rule.from.as_str())
        .collect::<Vec<_>>();
    while let Some((index, key_index)) = leftmost_longest(rest, &keys) {
        let rule = &rules[key_index];
        output.push_str(&rest[..index]);
        output.push_str(&rule.to);
        rest = &rest[index + rule.from.len()..];
    }
    output.push_str(rest);
    output
}

fn replace_words_bounded(
    text: &str,
    rules: &[Replacement],
    remaining_bytes: usize,
) -> Result<String, RuleError> {
    let mut output = String::with_capacity(text.len().min(remaining_bytes));
    let mut rest = text;
    let keys = rules
        .iter()
        .map(|rule| rule.from.as_str())
        .collect::<Vec<_>>();
    while let Some((index, key_index)) = leftmost_longest(rest, &keys) {
        let rule = &rules[key_index];
        append_bounded(&mut output, &rest[..index], remaining_bytes)?;
        append_bounded(&mut output, &rule.to, remaining_bytes)?;
        rest = &rest[index + rule.from.len()..];
    }
    append_bounded(&mut output, rest, remaining_bytes)?;
    Ok(output)
}

fn append_bounded(output: &mut String, text: &str, limit: usize) -> Result<(), RuleError> {
    if text.len() > limit.saturating_sub(output.len()) {
        return Err(RuleError::TooLarge("生成的播报文本"));
    }
    output.push_str(text);
    Ok(())
}

fn leftmost_longest(text: &str, keys: &[&str]) -> Option<(usize, usize)> {
    // Walk each input character at most once across successive replacements.
    // Repeated `find` from every rule at every match rescans the remaining
    // suffix, which becomes quadratic for dense 2,000-character messages.
    for (index, _) in text.char_indices() {
        let mut best: Option<(usize, usize)> = None;
        for (key_index, key) in keys.iter().enumerate() {
            if !key.is_empty() && text[index..].starts_with(key) {
                let chars = key.chars().count();
                if best.is_none_or(|(_, best_chars)| chars > best_chars) {
                    best = Some((key_index, chars));
                }
            }
        }
        if let Some((key_index, _)) = best {
            return Some((index, key_index));
        }
    }
    None
}

fn plan_bytes(parts: &[PlanPart]) -> usize {
    parts
        .iter()
        .map(|part| match part {
            PlanPart::Text(text) => text.len(),
            PlanPart::Sound { trigger, .. } => trigger.len(),
        })
        .sum()
}

fn append_text(parts: &mut Vec<PlanPart>, text: &str) -> Result<(), RuleError> {
    if text.is_empty() {
        return Ok(());
    }
    if text.len() > MAX_PLAN_BYTES.saturating_sub(plan_bytes(parts)) {
        return Err(RuleError::TooLarge("生成的播报文本"));
    }
    if let Some(PlanPart::Text(last)) = parts.last_mut() {
        last.push_str(text);
    } else {
        if parts.len() >= MAX_PLAN_PARTS {
            return Err(RuleError::TooLarge("播报片段"));
        }
        parts.push(PlanPart::Text(text.to_owned()));
    }
    Ok(())
}

fn append_sound(parts: &mut Vec<PlanPart>, rule: &SoundRule) -> Result<(), RuleError> {
    if parts.len() >= MAX_PLAN_PARTS {
        return Err(RuleError::TooLarge("播报片段"));
    }
    if rule.trigger.len() > MAX_PLAN_BYTES.saturating_sub(plan_bytes(parts)) {
        return Err(RuleError::TooLarge("生成的播报文本"));
    }
    parts.push(PlanPart::Sound {
        trigger: rule.trigger.clone(),
        asset_id: rule.asset_id.clone(),
    });
    Ok(())
}

fn append_message(
    parts: &mut Vec<PlanPart>,
    original: &str,
    words: &[Replacement],
    sounds: &[SoundRule],
) -> Result<(), RuleError> {
    let mut rest = original;
    let keys = sounds
        .iter()
        .map(|rule| {
            if rule.asset_id.is_empty() {
                ""
            } else {
                rule.trigger.as_str()
            }
        })
        .collect::<Vec<_>>();
    while let Some((index, sound_index)) = leftmost_longest(rest, &keys) {
        let rule = &sounds[sound_index];
        let remaining = MAX_PLAN_BYTES.saturating_sub(plan_bytes(parts));
        append_text(
            parts,
            &replace_words_bounded(&rest[..index], words, remaining)?,
        )?;
        append_sound(parts, rule)?;
        rest = &rest[index + rule.trigger.len()..];
    }
    let remaining = MAX_PLAN_BYTES.saturating_sub(plan_bytes(parts));
    append_text(parts, &replace_words_bounded(rest, words, remaining)?)?;
    Ok(())
}

fn field_text<'a>(
    field: &str,
    event: &'a LiveEvent,
    user_name: &'a str,
) -> Result<String, RuleError> {
    let value = match field {
        "user_name" => user_name.to_owned(),
        "message" => event.message.clone(),
        "gift_name" => event.gift_name.clone(),
        "gift_num" => event.quantity.to_string(),
        "guard_name" => event.guard_name.clone(),
        "price" => event.price_yuan.to_string(),
        _ => return Err(RuleError::UnknownField(field.to_owned())),
    };
    Ok(value)
}

fn render_template(
    template: &str,
    event: &LiveEvent,
    rules: &RuleSet,
) -> Result<Vec<PlanPart>, RuleError> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut chars = template.chars().peekable();
    let user_name = replace_words_bounded(&event.user_name, &rules.user_words, MAX_PLAN_BYTES)?;
    while let Some(ch) = chars.next() {
        match ch {
            '{' if chars.peek() == Some(&'{') => {
                chars.next();
                literal.push('{');
            }
            '}' if chars.peek() == Some(&'}') => {
                chars.next();
                literal.push('}');
            }
            '{' => {
                append_text(&mut parts, &literal)?;
                literal.clear();
                let mut field = String::new();
                loop {
                    match chars.next() {
                        Some('}') => break,
                        Some('{') | None => return Err(RuleError::UnclosedField),
                        Some(ch) => field.push(ch),
                    }
                }
                let text = field_text(&field, event, &user_name)?;
                if field == "message" {
                    append_message(
                        &mut parts,
                        &event.message,
                        &rules.message_words,
                        &rules.sounds,
                    )?;
                } else {
                    append_text(&mut parts, &text)?;
                }
            }
            '}' => return Err(RuleError::UnexpectedClose),
            _ => literal.push(ch),
        }
    }
    append_text(&mut parts, &literal)?;
    Ok(parts)
}

/// Check a legacy/user template before persisting it. A parser error at this
/// stage must not become a silent per-event failure during live playback.
pub(crate) fn validate_template(template: &str) -> Result<(), RuleError> {
    let sample = LiveEvent::danmaku(0, None, "用户", "消息");
    render_template(template, &sample, &RuleSet::default()).map(|_| ())
}

impl RuleSet {
    fn validate_lengths(&self) -> Result<(), RuleError> {
        if self.user_words.len() > 1024
            || self.message_words.len() > 1024
            || self.sounds.len() > 1024
        {
            return Err(RuleError::TooLarge("词典或音效规则"));
        }
        if [
            &self.templates.danmaku,
            &self.templates.gift,
            &self.templates.super_chat,
            &self.templates.guard,
        ]
        .iter()
        .any(|template| template.len() > MAX_TEMPLATE_BYTES)
        {
            return Err(RuleError::TooLarge("播报模板"));
        }
        if self
            .user_words
            .iter()
            .chain(&self.message_words)
            .any(|rule| {
                rule.from.len() > MAX_KEYWORD_BYTES || rule.to.len() > MAX_REPLACEMENT_BYTES
            })
        {
            return Err(RuleError::TooLarge("词典词条"));
        }
        if self.sounds.iter().any(|rule| {
            rule.trigger.len() > MAX_KEYWORD_BYTES || rule.asset_id.len() > MAX_KEYWORD_BYTES
        }) {
            return Err(RuleError::TooLarge("关键词音效"));
        }
        Ok(())
    }

    /// Reject a rule set that would make every event of a kind fail during
    /// live planning. The store invokes this before replacing saved rules.
    pub fn validate(&self) -> Result<(), RuleError> {
        self.validate_lengths()?;
        if !self.events.gift_threshold_yuan.is_finite()
            || self.events.gift_threshold_yuan < 0.0
            || !self.events.super_chat_threshold_yuan.is_finite()
            || self.events.super_chat_threshold_yuan < 0.0
        {
            return Err(RuleError::InvalidThreshold);
        }
        for (event, template) in [
            ("弹幕", &self.templates.danmaku),
            ("礼物", &self.templates.gift),
            ("醒目留言", &self.templates.super_chat),
            ("舰长", &self.templates.guard),
        ] {
            validate_template(template).map_err(|error| RuleError::InvalidTemplate {
                event,
                reason: error.to_string(),
            })?;
        }
        if self
            .user_words
            .iter()
            .chain(&self.message_words)
            .any(|rule| rule.from.is_empty())
        {
            return Err(RuleError::EmptyKeyword);
        }
        if self
            .sounds
            .iter()
            .any(|rule| rule.trigger.is_empty() || rule.asset_id.is_empty())
        {
            return Err(RuleError::InvalidSoundRule);
        }
        Ok(())
    }

    /// Event-level filter used both before gift grouping and when previewing
    /// the final plan. A gift below the threshold is not combined into a
    /// larger gift that would otherwise cross that threshold.
    pub fn filter_reason(&self, event: &LiveEvent) -> Option<&'static str> {
        match event.kind {
            EventKind::Danmaku if !self.events.danmaku_on => Some("弹幕播报已关闭"),
            EventKind::Gift if !self.events.gift_on => Some("礼物播报已关闭"),
            EventKind::Gift
                if event.coin_type.as_deref() == Some("silver") && !self.events.free_gift_on =>
            {
                Some("免费礼物已过滤")
            }
            EventKind::Gift if event.price_yuan < self.events.gift_threshold_yuan => {
                Some("礼物未达到金额阈值")
            }
            EventKind::SuperChat if !self.events.super_chat_on => Some("醒目留言播报已关闭"),
            EventKind::SuperChat if event.price_yuan < self.events.super_chat_threshold_yuan => {
                Some("醒目留言未达到金额阈值")
            }
            EventKind::Guard if !self.events.guard_on => Some("舰长播报已关闭"),
            _ => None,
        }
    }

    pub fn preview(
        &self,
        event: &LiveEvent,
        presets: &[VoicePreset],
        bindings: &[VoiceBinding],
    ) -> Result<RulePreview, RuleError> {
        if event.message.chars().take(2001).count() > 2000
            || event.user_name.chars().take(201).count() > 200
            || event.gift_name.chars().take(2001).count() > 2000
            || event.guard_name.chars().take(2001).count() > 2000
        {
            return Err(RuleError::TooLarge("消息或用户信息"));
        }
        self.validate_lengths()?;
        let reason = self.filter_reason(event);
        if let Some(reason) = reason {
            return Ok(RulePreview {
                event: event.clone(),
                filtered_reason: Some(reason.into()),
                final_text: String::new(),
                parts: Vec::new(),
                voice: None,
                default_voice: None,
                voice_from_binding: false,
                pending_legacy_binding: false,
            });
        }
        let template = match event.kind {
            EventKind::Danmaku => &self.templates.danmaku,
            EventKind::Gift => &self.templates.gift,
            EventKind::SuperChat => &self.templates.super_chat,
            EventKind::Guard => &self.templates.guard,
        };
        let parts = render_template(template, event, self)?;
        let final_text = parts
            .iter()
            .map(|part| match part {
                PlanPart::Text(text) => text.as_str(),
                PlanPart::Sound { trigger, .. } => trigger.as_str(),
            })
            .collect();
        let bound_id = bindings
            .iter()
            .find(|binding| binding.matches_confirmed_user(event.user_id))
            .or_else(|| {
                bindings
                    .iter()
                    .find(|binding| binding.matches_explicit_name(&event.user_name))
            })
            .map(|binding| &binding.preset_id);
        let selected_id = bound_id.or(self.default_preset_id.as_ref());
        let voice = selected_id
            .and_then(|id| presets.iter().find(|preset| &preset.id == id))
            .cloned();
        let default_voice = self
            .default_preset_id
            .as_ref()
            .and_then(|id| presets.iter().find(|preset| &preset.id == id))
            .cloned();
        let pending_legacy_binding = bindings.iter().any(|binding| {
            binding.enabled
                && binding.platform == "bilibili"
                && binding.user_id.is_none()
                && binding.legacy_user_name.as_deref() == Some(event.user_name.as_str())
        });
        Ok(RulePreview {
            event: event.clone(),
            filtered_reason: None,
            final_text,
            parts,
            voice,
            default_voice,
            voice_from_binding: bound_id.is_some(),
            pending_legacy_binding,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Provider;

    fn sample_voice(id: &str) -> VoicePreset {
        VoicePreset {
            id: id.into(),
            name: id.into(),
            connection_id: "local".into(),
            provider: Provider::Dots,
            voice_id: "ref.wav".into(),
            speed: 1.0,
            volume: 1.0,
            sovits: None,
        }
    }

    #[test]
    fn legacy_literal_longest_and_nonrecursive() {
        let rules = vec![
            Replacement {
                from: "ab".into(),
                to: "abcd".into(),
            },
            Replacement {
                from: "abcd".into(),
                to: "X".into(),
            },
            Replacement {
                from: "a.b".into(),
                to: "点".into(),
            },
            Replacement {
                from: "".into(),
                to: "bad".into(),
            },
        ];
        assert_eq!(replace_words("abcd ab a.b", &rules), "X abcd 点");
    }

    #[test]
    fn multibyte_replacements_keep_longest_literal_and_nonrecursive_meaning() {
        let rules = RuleSet {
            templates: EventTemplates {
                danmaku: "{message}".into(),
                ..Default::default()
            },
            message_words: vec![
                Replacement {
                    from: "猫".into(),
                    to: "猫猫".into(),
                },
                Replacement {
                    from: "猫猫".into(),
                    to: "双猫".into(),
                },
            ],
            ..Default::default()
        };
        let preview = rules
            .preview(&LiveEvent::danmaku(1, None, "观众", "猫猫 猫"), &[], &[])
            .unwrap();
        assert_eq!(preview.final_text, "双猫 猫猫");
        assert_eq!(preview.parts, vec![PlanPart::Text("双猫 猫猫".into())]);
    }

    #[test]
    fn oversized_rule_fields_are_rejected_before_saving() {
        let mut rules = RuleSet::default();
        rules.templates.danmaku = "字".repeat(MAX_TEMPLATE_BYTES / "字".len() + 1);
        assert_eq!(rules.validate(), Err(RuleError::TooLarge("播报模板")));

        rules.templates.danmaku = "{message}".into();
        rules.message_words.push(Replacement {
            from: "猫".into(),
            to: "字".repeat(MAX_REPLACEMENT_BYTES / "字".len() + 1),
        });
        assert_eq!(rules.validate(), Err(RuleError::TooLarge("词典词条")));
    }

    #[test]
    fn expanded_text_and_sound_parts_fail_instead_of_truncating() {
        let event = LiveEvent::danmaku(1, None, "观众", &"猫".repeat(2000));
        let rules = RuleSet {
            templates: EventTemplates {
                danmaku: "{message}".into(),
                ..Default::default()
            },
            message_words: vec![Replacement {
                from: "猫".into(),
                to: "字".repeat(MAX_REPLACEMENT_BYTES / "字".len()),
            }],
            ..Default::default()
        };
        rules.validate().unwrap();
        assert_eq!(
            rules.preview(&event, &[], &[]).unwrap_err(),
            RuleError::TooLarge("生成的播报文本")
        );

        let clips = RuleSet {
            templates: EventTemplates {
                danmaku: "{message}".into(),
                ..Default::default()
            },
            sounds: vec![SoundRule {
                trigger: "响".into(),
                asset_id: "clip".into(),
            }],
            ..Default::default()
        };
        clips.validate().unwrap();
        let event = LiveEvent::danmaku(1, None, "观众", &"响".repeat(MAX_PLAN_PARTS + 1));
        assert_eq!(
            clips.preview(&event, &[], &[]).unwrap_err(),
            RuleError::TooLarge("播报片段")
        );
    }

    #[test]
    fn repeated_template_fields_share_one_output_budget() {
        let rules = RuleSet {
            templates: EventTemplates {
                danmaku: "{message}".repeat(24),
                ..Default::default()
            },
            ..Default::default()
        };
        rules.validate().unwrap();
        let event = LiveEvent::danmaku(1, None, "观众", &"字".repeat(1000));
        assert_eq!(
            rules.preview(&event, &[], &[]).unwrap_err(),
            RuleError::TooLarge("生成的播报文本")
        );
    }

    #[test]
    fn dense_dictionary_with_repeated_multibyte_matches_stays_literal() {
        let mut rules = RuleSet {
            templates: EventTemplates {
                danmaku: "{message}".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        rules.message_words = (0..1023)
            .map(|index| Replacement {
                from: format!("不命中{index}"),
                to: "".into(),
            })
            .collect();
        rules.message_words.push(Replacement {
            from: "猫".into(),
            to: "雪".into(),
        });
        rules.validate().unwrap();
        let event = LiveEvent::danmaku(1, None, "观众", &"猫".repeat(2000));
        assert_eq!(
            rules.preview(&event, &[], &[]).unwrap().final_text,
            "雪".repeat(2000)
        );
    }

    #[test]
    fn incoming_gift_and_guard_fields_are_bounded_before_template_cloning() {
        let rules = RuleSet::default();
        let mut event = LiveEvent::danmaku(1, None, "观众", "");
        event.kind = EventKind::Gift;
        event.gift_name = "礼".repeat(2001);
        assert_eq!(
            rules.preview(&event, &[], &[]).unwrap_err(),
            RuleError::TooLarge("消息或用户信息")
        );
        event.kind = EventKind::Guard;
        event.gift_name.clear();
        event.guard_name = "舰".repeat(2001);
        assert_eq!(
            rules.preview(&event, &[], &[]).unwrap_err(),
            RuleError::TooLarge("消息或用户信息")
        );
    }

    #[test]
    fn scopes_and_original_clip_priority() {
        let rules = RuleSet {
            templates: EventTemplates {
                danmaku: "{user_name}说：{message}，固定Alice".into(),
                ..Default::default()
            },
            user_words: vec![Replacement {
                from: "Alice".into(),
                to: "小爱".into(),
            }],
            message_words: vec![
                Replacement {
                    from: "Alice".into(),
                    to: "艾丽丝".into(),
                },
                Replacement {
                    from: "咕咕嘎嘎".into(),
                    to: "不应覆盖音频".into(),
                },
            ],
            sounds: vec![
                SoundRule {
                    trigger: "咕咕".into(),
                    asset_id: "short".into(),
                },
                SoundRule {
                    trigger: "咕咕嘎嘎".into(),
                    asset_id: "long".into(),
                },
            ],
            ..Default::default()
        };
        let event = LiveEvent::danmaku(1, Some(2), "Alice", "Alice咕咕嘎嘎Alice");
        let preview = rules.preview(&event, &[], &[]).unwrap();
        assert_eq!(
            preview.parts,
            vec![
                PlanPart::Text("小爱说：艾丽丝".into()),
                PlanPart::Sound {
                    trigger: "咕咕嘎嘎".into(),
                    asset_id: "long".into()
                },
                PlanPart::Text("艾丽丝，固定Alice".into()),
            ]
        );
    }

    #[test]
    fn escaping_and_repeated_message_fields() {
        let rules = RuleSet {
            templates: EventTemplates {
                danmaku: "{{x}}{user_name}:{message}{message}".into(),
                ..Default::default()
            },
            sounds: vec![SoundRule {
                trigger: "音".into(),
                asset_id: "x".into(),
            }],
            ..Default::default()
        };
        let preview = rules
            .preview(&LiveEvent::danmaku(1, None, "{message}", "音"), &[], &[])
            .unwrap();
        assert_eq!(
            preview.parts,
            vec![
                PlanPart::Text("{x}{message}:".into()),
                PlanPart::Sound {
                    trigger: "音".into(),
                    asset_id: "x".into()
                },
                PlanPart::Sound {
                    trigger: "音".into(),
                    asset_id: "x".into()
                },
            ]
        );
    }

    #[test]
    fn filters_and_uid_binding() {
        let mut rules = RuleSet {
            default_preset_id: Some("default".into()),
            ..Default::default()
        };
        let presets = vec![sample_voice("default"), sample_voice("uid")];
        let bindings = vec![
            VoiceBinding {
                platform: "bilibili".into(),
                user_id: None,
                user_name: None,
                legacy_user_name: Some("A".into()),
                preset_id: "old".into(),
                enabled: true,
            },
            VoiceBinding {
                platform: "bilibili".into(),
                user_id: Some(7),
                user_name: None,
                legacy_user_name: None,
                preset_id: "uid".into(),
                enabled: true,
            },
        ];
        let event = LiveEvent::danmaku(1, Some(7), "A", "hello");
        let preview = rules.preview(&event, &presets, &bindings).unwrap();
        assert_eq!(preview.voice.as_ref().unwrap().id, "uid");
        assert_eq!(preview.default_voice.as_ref().unwrap().id, "default");
        assert!(preview.voice_from_binding);
        assert!(preview.pending_legacy_binding);
        rules.events.danmaku_on = false;
        assert_eq!(
            rules
                .preview(&event, &presets, &bindings)
                .unwrap()
                .filtered_reason
                .as_deref(),
            Some("弹幕播报已关闭")
        );
    }

    #[test]
    fn explicit_name_binding_matches_exactly_but_confirmed_uid_wins() {
        let rules = RuleSet {
            default_preset_id: Some("default".into()),
            ..Default::default()
        };
        let presets = vec![
            sample_voice("default"),
            sample_voice("name"),
            sample_voice("uid"),
            sample_voice("legacy"),
        ];
        let bindings = vec![
            VoiceBinding {
                platform: "bilibili".into(),
                user_id: None,
                user_name: None,
                legacy_user_name: Some("观众".into()),
                preset_id: "legacy".into(),
                enabled: true,
            },
            VoiceBinding {
                platform: "bilibili".into(),
                user_id: None,
                user_name: Some("观众".into()),
                legacy_user_name: None,
                preset_id: "name".into(),
                enabled: true,
            },
            VoiceBinding {
                platform: "bilibili".into(),
                user_id: Some(7),
                user_name: None,
                legacy_user_name: None,
                preset_id: "uid".into(),
                enabled: true,
            },
        ];
        let preview = |id, name: &str| {
            rules
                .preview(
                    &LiveEvent::danmaku(1, id, name, "你好"),
                    &presets,
                    &bindings,
                )
                .unwrap()
        };
        assert_eq!(preview(Some(7), "观众").voice.unwrap().id, "uid");
        assert_eq!(preview(Some(8), "观众").voice.unwrap().id, "name");
        assert_eq!(preview(None, "观众").voice.unwrap().id, "name");
        assert_eq!(preview(Some(8), "观众 ").voice.unwrap().id, "default");
        assert_eq!(preview(Some(8), "观眾").voice.unwrap().id, "default");
        let legacy_only = rules
            .preview(
                &LiveEvent::danmaku(1, Some(8), "观众", "你好"),
                &presets,
                &bindings[..1],
            )
            .unwrap();
        assert_eq!(legacy_only.voice.unwrap().id, "default");
        assert!(legacy_only.pending_legacy_binding);
    }
}
