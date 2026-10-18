//! Complete, runtime-only received history, separate from the compact UI snapshot.
//! A desktop reception session shares this archive across audio-mode restarts.
//! Text never enters configuration exports or the durable broadcast summary.
use crate::{
    model::{EventKind, LiveEvent},
    received_emotes::ReceivedEmoteCatalog,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct LiveHistory(Arc<Mutex<History>>);

struct History {
    session_id: String,
    room_id: Option<u64>,
    started_at_ms: u64,
    events: Vec<LiveEvent>,
    speakers: HashSet<String>,
    viewer_messages: HashMap<String, u64>,
    emote_catalog: Option<Arc<ReceivedEmoteCatalog>>,
    canonical_room_id: Option<u64>,
    metadata_revision: u64,
}

impl Default for History {
    fn default() -> Self {
        Self {
            session_id: Uuid::new_v4().to_string(),
            room_id: None,
            started_at_ms: 0,
            events: Vec::new(),
            speakers: HashSet::new(),
            viewer_messages: HashMap::new(),
            emote_catalog: None,
            canonical_room_id: None,
            metadata_revision: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct HistoryStats {
    pub session_id: String,
    pub room_id: Option<u64>,
    pub started_at_ms: u64,
    pub messages: u64,
    pub unique_viewers: u64,
    pub metadata_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HistoryItem {
    pub sequence: u64,
    pub event: LiveEvent,
}

#[derive(Clone, Debug, Serialize)]
pub struct HistoryPage {
    #[serde(flatten)]
    pub stats: HistoryStats,
    pub items: Vec<HistoryItem>,
    pub before: Option<u64>,
    pub has_more: bool,
    pub viewer_messages: Option<u64>,
}

fn viewer_key(event: &LiveEvent) -> Option<String> {
    if let Some(uid) = event.user_id.filter(|uid| *uid > 0) {
        Some(format!("uid:{uid}"))
    } else {
        let name = event.user_name.trim();
        (!name.is_empty()).then(|| format!("name:{name}"))
    }
}

impl History {
    fn stats(&self) -> HistoryStats {
        HistoryStats {
            session_id: self.session_id.clone(),
            room_id: self.room_id,
            started_at_ms: self.started_at_ms,
            messages: self.events.len() as u64,
            unique_viewers: self.speakers.len() as u64,
            metadata_revision: self.metadata_revision,
        }
    }
}

impl LiveHistory {
    pub fn begin_room(&self, room_id: u64) {
        let mut history = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if history.room_id != Some(room_id) {
            *history = History {
                room_id: Some(room_id),
                started_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                ..History::default()
            };
        }
    }

    /// Rotate on an observed new broadcast while retaining any packets already
    /// received after its real start. Audio reconnects do not call this method.
    pub fn begin_broadcast(&self, since_ms: u64) {
        let mut history = self.0.lock().unwrap_or_else(|error| error.into_inner());
        history.session_id = Uuid::new_v4().to_string();
        history.started_at_ms = history.started_at_ms.max(since_ms);
        history
            .events
            .retain(|event| event.observed_at_ms >= since_ms);
        history.speakers = history
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::Danmaku | EventKind::SuperChat))
            .filter_map(viewer_key)
            .collect();
        history.viewer_messages = history
            .events
            .iter()
            .filter(|event| matches!(event.kind, EventKind::Danmaku | EventKind::SuperChat))
            .filter_map(viewer_key)
            .fold(HashMap::new(), |mut counts, key| {
                *counts.entry(key).or_default() += 1;
                counts
            });
    }

    pub(crate) fn set_emote_catalog(
        &self,
        catalog: Arc<ReceivedEmoteCatalog>,
        canonical_room_id: Option<u64>,
    ) {
        let mut history = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if history.emote_catalog.as_deref() != Some(catalog.as_ref())
            || history.canonical_room_id != canonical_room_id
        {
            history.emote_catalog = Some(catalog);
            history.canonical_room_id = canonical_room_id;
            history.metadata_revision = history.metadata_revision.wrapping_add(1);
        }
    }

    pub(crate) fn push(&self, event: LiveEvent) {
        let mut history = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if matches!(event.kind, EventKind::Danmaku | EventKind::SuperChat)
            && let Some(key) = viewer_key(&event)
        {
            history.speakers.insert(key.clone());
            *history.viewer_messages.entry(key).or_default() += 1;
        }
        history.events.push(event);
    }

    pub fn stats(&self) -> HistoryStats {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .stats()
    }

    pub fn unique_viewers_since(&self, since_ms: u64) -> u64 {
        let history = self.0.lock().unwrap_or_else(|error| error.into_inner());
        history
            .events
            .iter()
            .filter(|event| {
                event.observed_at_ms >= since_ms
                    && matches!(event.kind, EventKind::Danmaku | EventKind::SuperChat)
            })
            .filter_map(viewer_key)
            .collect::<HashSet<_>>()
            .len() as u64
    }

    /// Stable sequence cursors are unaffected by messages arriving at the top.
    /// A stale session is rejected instead of returning another room's history.
    pub fn page(
        &self,
        session_id: &str,
        before: Option<u64>,
        limit: usize,
        viewer: Option<&str>,
    ) -> Result<HistoryPage, &'static str> {
        let history = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if session_id != history.session_id {
            return Err("直播间历史已切换，请重新打开水下历史");
        }
        let end = before
            .and_then(|value| usize::try_from(value.saturating_sub(1)).ok())
            .unwrap_or(history.events.len())
            .min(history.events.len());
        let limit = limit.clamp(1, 100);
        let mut items = Vec::with_capacity(limit);
        let mut has_more = false;
        for index in (0..end).rev() {
            let event = &history.events[index];
            if viewer.is_some_and(|viewer| {
                !matches!(event.kind, EventKind::Danmaku | EventKind::SuperChat)
                    || viewer_key(event).as_deref() != Some(viewer)
            }) {
                continue;
            }
            if items.len() == limit {
                has_more = true;
                break;
            }
            let mut event = event.clone();
            if let Some(catalog) = &history.emote_catalog {
                if let Some(canonical) = history.canonical_room_id {
                    catalog.enrich_in_connected_room(
                        &mut event,
                        history.room_id.unwrap_or(canonical),
                        canonical,
                    );
                } else {
                    catalog.enrich(&mut event);
                }
            }
            items.push(HistoryItem {
                sequence: index as u64 + 1,
                event,
            });
        }
        Ok(HistoryPage {
            stats: history.stats(),
            before: items.last().map(|item| item.sequence),
            items,
            has_more,
            viewer_messages: viewer
                .map(|key| history.viewer_messages.get(key).copied().unwrap_or(0)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(index: u64) -> LiveEvent {
        let mut event = LiveEvent::danmaku(
            7,
            Some(index % 17 + 1),
            &format!("viewer-{}", index % 17),
            &format!("message {index}"),
        );
        event.platform_event_id = Some(format!("event-{index}"));
        event.observed_at_ms = index;
        event
    }

    #[test]
    fn archive_pages_every_event_past_snapshot_limit_without_duplicates_or_gaps() {
        let history = LiveHistory::default();
        history.begin_room(7);
        for index in 0..405 {
            history.push(event(index));
        }
        let stats = history.stats();
        assert_eq!(stats.messages, 405);
        assert_eq!(stats.unique_viewers, 17);
        let first = history.page(&stats.session_id, None, 100, None).unwrap();
        assert_eq!(first.items[0].sequence, 405);
        history.push(event(405));
        let mut cursor = first.before;
        let mut sequences: Vec<u64> = first.items.iter().map(|item| item.sequence).collect();
        while let Some(before) = cursor {
            let page = history
                .page(&stats.session_id, Some(before), 100, None)
                .unwrap();
            sequences.extend(page.items.iter().map(|item| item.sequence));
            cursor = page.has_more.then_some(page.before).flatten();
        }
        assert_eq!(sequences, (1..=405).rev().collect::<Vec<_>>());
        let viewer = history
            .page(&stats.session_id, None, 3, Some("uid:1"))
            .unwrap();
        assert_eq!(viewer.items.len(), 3);
        assert_eq!(viewer.viewer_messages, Some(24));
    }

    #[test]
    fn audio_restarts_share_history_but_room_changes_reject_old_cursors() {
        let history = LiveHistory::default();
        history.begin_room(7);
        history.push(event(1));
        let original = history.stats();
        let restarted = history.clone();
        restarted.begin_room(7);
        restarted.push(event(2));
        assert_eq!(restarted.stats().messages, 2);
        assert_eq!(restarted.stats().session_id, original.session_id);
        restarted.begin_broadcast(2);
        assert_eq!(history.stats().messages, 1);
        assert_eq!(history.stats().unique_viewers, 1);
        assert_eq!(history.unique_viewers_since(3), 0);
        assert!(history.page(&original.session_id, None, 100, None).is_err());
        restarted.begin_room(8);
        assert_eq!(history.stats().messages, 0);
        assert!(history.page(&original.session_id, None, 100, None).is_err());
    }
}
