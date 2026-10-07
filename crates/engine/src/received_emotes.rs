//! Resolve received text markers using verified, account-scoped platform metadata.
//! The platform may deliver personal comment emotes as dm_type=0 without images.
//! No arbitrary bracket text is classified, and no message body is rewritten.
use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::{
    chat_send::{ChatEmoticonPack, emoticon_image_url},
    model::{EventKind, LiveEmote, LiveEvent},
};

const MAX_CATALOG_ITEMS: usize = 20_000;
const MAX_MARKER_BYTES: usize = 512;
const MAX_EVENT_EMOTES: usize = 32;
const MAX_ADDED_BYTES: usize = 8 * 1024;

#[derive(Default)]
pub struct ReceivedEmoteCatalog {
    account_id: u64,
    room_id: u64,
    images: BTreeMap<String, String>,
}

impl ReceivedEmoteCatalog {
    pub fn from_packs(account_id: u64, room_id: u64, packs: &[ChatEmoticonPack]) -> Self {
        if account_id == 0 || room_id == 0 {
            return Self::default();
        }
        let mut images = BTreeMap::new();
        let mut ambiguous = BTreeSet::new();
        for item in packs
            .iter()
            .filter(|pack| matches!(pack.source, "account" | "live"))
            .flat_map(|pack| &pack.emoticons)
            .take(MAX_CATALOG_ITEMS)
        {
            if item.kind != "text" {
                continue;
            }
            let Some(text) = item.text.as_deref().filter(|text| {
                text.len() > 2
                    && text.len() <= MAX_MARKER_BYTES
                    && text.starts_with('[')
                    && text.ends_with(']')
                    && !text[1..text.len() - 1].contains(['[', ']'])
            }) else {
                continue;
            };
            let Some(url) = item
                .url
                .as_ref()
                .and_then(|url| emoticon_image_url(Some(&Value::String(url.clone()))))
            else {
                continue;
            };
            if ambiguous.contains(text) {
                continue;
            }
            if images.get(text).is_some_and(|previous| previous != &url) {
                images.remove(text);
                ambiguous.insert(text.to_owned());
            } else {
                images.insert(text.to_owned(), url);
            }
        }
        Self {
            account_id,
            room_id,
            images,
        }
    }

    pub fn matches_context(&self, account_id: u64, room_id: u64) -> bool {
        self.account_id == account_id && self.room_id == room_id
    }

    pub fn enrich(&self, event: &mut LiveEvent) {
        let allowed = self.room_id == event.room_id;
        self.enrich_with_catalog(event, allowed);
    }

    /// The connected room client supplies the canonical room ID, never the packet itself.
    pub(crate) fn enrich_in_connected_room(
        &self,
        event: &mut LiveEvent,
        requested: u64,
        canonical: u64,
    ) {
        let allowed =
            event.room_id == canonical && (self.room_id == requested || self.room_id == canonical);
        self.enrich_with_catalog(event, allowed);
    }

    fn enrich_with_catalog(&self, event: &mut LiveEvent, allowed: bool) {
        if event.kind != EventKind::Danmaku {
            return;
        }
        // Packet metadata is authoritative; cache images only fill missing tokens.
        let native: BTreeMap<_, _> = event
            .emotes
            .iter()
            .filter_map(|emote| {
                emoticon_image_url(Some(&Value::String(emote.url.clone())))
                    .map(|_| (emote.text.as_str(), emote.url.as_str()))
            })
            .collect();
        let catalog = allowed.then_some(&self.images);
        let mut rest = event.message.as_str();
        let mut tokens = Vec::new();
        let mut other_text = false;
        while !rest.is_empty() {
            if rest.starts_with('[')
                && let Some(end) = rest.find(']')
            {
                let marker = &rest[..=end];
                let url = native.get(marker).copied().or_else(|| {
                    catalog
                        .and_then(|images| images.get(marker))
                        .map(String::as_str)
                });
                if let Some(url) = url {
                    tokens.push((marker.to_owned(), url.to_owned()));
                    rest = &rest[end + 1..];
                    continue;
                }
            }
            let character = rest.chars().next().expect("nonempty remainder");
            other_text |= !character.is_whitespace();
            rest = &rest[character.len_utf8()..];
        }
        let standalone = !other_text && !tokens.is_empty();
        let large = standalone && tokens.len() == 1;
        let budget = crate::live::MAX_LIVE_EVENT_BYTES
            .saturating_sub(crate::live::event_payload_bytes(event))
            .min(MAX_ADDED_BYTES);
        let mut added_bytes = 0;
        for (text, url) in tokens {
            if event.emotes.iter().any(|emote| emote.text == text) {
                continue;
            }
            if event.emotes.len() >= MAX_EVENT_EMOTES
                || added_bytes + text.len() + url.len() > budget
            {
                break;
            }
            added_bytes += text.len() + url.len();
            event.emotes.push(LiveEmote { text, url, large });
        }
        event.is_bilibili_emoticon |= standalone;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{chat_send::ChatEmoticon, rules::RuleSet};
    const MARKER: &str = "[费可装扮表情包_爱你]";
    const IMAGE: &str =
        "https://i0.hdslb.com/bfs/garb/699dc00ce1374521842dc1bf13d5946fc5d5607e.png";
    fn pack(text: &str, url: &str) -> ChatEmoticonPack {
        ChatEmoticonPack {
            source: "account",
            name: "样本表情包".into(),
            pkg_type: Some(3),
            icon: None,
            emoticons: vec![ChatEmoticon {
                emoticon_unique: "account:3735:52234".into(),
                emoji: text.into(),
                url: Some(url.into()),
                allowed: true,
                kind: "text",
                text: Some(text.into()),
                description: None,
            }],
        }
    }
    fn raw(message: &str) -> LiveEvent {
        crate::bilibili::parse_live_event(999, 1, &serde_json::json!({"cmd":"DANMU_MSG", "info":[[0,1,25,16777215,0,0,0,0,0,0,0,0,0],message,[7,"虚构观众"]]})).unwrap()
    }
    #[test]
    fn actual_personal_marker_packet_reaches_image_and_standalone_filter() {
        let mut event = raw(MARKER);
        assert!(event.emotes.is_empty());
        assert!(!event.is_bilibili_emoticon);
        ReceivedEmoteCatalog::from_packs(42, 999, &[pack(MARKER, IMAGE)]).enrich(&mut event);
        assert_eq!(event.message, MARKER);
        assert_eq!(
            event.emotes,
            vec![LiveEmote {
                text: MARKER.into(),
                url: IMAGE.into(),
                large: true
            }]
        );
        assert_eq!(
            RuleSet::default().filter_reason(&event),
            Some("B站官方表情已过滤")
        );
        let mut rules = RuleSet::default();
        rules.events.filter_bilibili_emoticons = false;
        assert_eq!(rules.filter_reason(&event), None);
    }
    #[test]
    fn mixed_text_and_unknown_brackets_remain_ordinary_speech() {
        let catalog = ReceivedEmoteCatalog::from_packs(42, 999, &[pack(MARKER, IMAGE)]);
        for text in [
            format!("你好{MARKER}"),
            "[普通文字]".into(),
            format!("{MARKER}[未知]"),
            "😀".into(),
        ] {
            let mut event = raw(&text);
            catalog.enrich(&mut event);
            assert!(!event.is_bilibili_emoticon);
            assert_eq!(RuleSet::default().filter_reason(&event), None);
            assert_eq!(event.message, text);
        }
        let mut event = raw(&format!("  {MARKER} {MARKER}  "));
        catalog.enrich(&mut event);
        assert!(event.is_bilibili_emoticon);
        assert_eq!(event.emotes.len(), 1);
        assert!(!event.emotes[0].large);
    }
    #[test]
    fn native_image_wins_and_other_room_or_account_catalog_cannot_leak() {
        let catalog = ReceivedEmoteCatalog::from_packs(42, 999, &[pack(MARKER, IMAGE)]);
        assert!(catalog.matches_context(42, 999));
        assert!(!catalog.matches_context(43, 999));
        let mut wrong = raw(MARKER);
        wrong.room_id = 1000;
        catalog.enrich(&mut wrong);
        assert!(wrong.emotes.is_empty());
        assert!(!wrong.is_bilibili_emoticon);
        let mut native = raw(MARKER);
        native.emotes.push(LiveEmote {
            text: MARKER.into(),
            url: "https://i0.hdslb.com/bfs/emote/native.png".into(),
            large: false,
        });
        catalog.enrich(&mut native);
        assert_eq!(native.emotes.len(), 1);
        assert!(native.emotes[0].url.ends_with("native.png"));
        assert!(!native.emotes[0].large);
        assert!(native.is_bilibili_emoticon);
    }
    #[test]
    fn unsafe_missing_ambiguous_and_nonmarker_images_never_classify_text() {
        for packs in [
            vec![pack(MARKER, "https://example.com/a.png")],
            vec![pack(MARKER, "https://i0.hdslb.com/bfs/emote/a.svg")],
            vec![
                pack(MARKER, IMAGE),
                pack(MARKER, "https://i0.hdslb.com/bfs/emote/other.png"),
            ],
            vec![pack("你好", IMAGE)],
        ] {
            let mut event = raw(MARKER);
            ReceivedEmoteCatalog::from_packs(42, 999, &packs).enrich(&mut event);
            assert!(event.emotes.is_empty());
            assert!(!event.is_bilibili_emoticon);
        }
    }

    #[test]
    fn short_room_alias_uses_only_the_canonical_connection_context() {
        let catalog = ReceivedEmoteCatalog::from_packs(42, 123, &[pack(MARKER, IMAGE)]);
        let mut event = raw(MARKER);
        catalog.enrich(&mut event);
        assert!(event.emotes.is_empty());
        catalog.enrich_in_connected_room(&mut event, 123, 999);
        assert_eq!(event.emotes[0].url, IMAGE);
        for (requested, canonical) in [(124, 999), (123, 1000)] {
            let mut other = raw(MARKER);
            catalog.enrich_in_connected_room(&mut other, requested, canonical);
            assert!(other.emotes.is_empty());
            assert!(!other.is_bilibili_emoticon);
        }
    }

    #[test]
    fn image_enrichment_preserves_the_live_payload_bound_and_ignores_empty_markers() {
        let catalog =
            ReceivedEmoteCatalog::from_packs(42, 999, &[pack(MARKER, IMAGE), pack("[]", IMAGE)]);
        let mut empty = raw("[]");
        catalog.enrich(&mut empty);
        assert!(empty.emotes.is_empty());
        assert!(!empty.is_bilibili_emoticon);
        let mut event = raw(MARKER);
        let available =
            crate::live::MAX_LIVE_EVENT_BYTES - crate::live::event_payload_bytes(&event);
        event.user_name.push_str(&"x".repeat(available));
        catalog.enrich(&mut event);
        assert!(event.is_bilibili_emoticon);
        assert!(event.emotes.is_empty());
        assert_eq!(
            crate::live::event_payload_bytes(&event),
            crate::live::MAX_LIVE_EVENT_BYTES
        );
    }
}
