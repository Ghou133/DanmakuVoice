//! Bounded event de-duplication and gift grouping before rule evaluation.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::model::{EventKind, GiftMergeSettings, LiveEvent};

const MAX_RECENT_IDS: usize = 4096;
const RECENT_ID_LIFETIME: Duration = Duration::from_secs(120);
const MAX_GIFT_GROUPS: usize = 256;

struct PendingGift {
    event: LiveEvent,
    last_update: Instant,
    window: Duration,
}

/// One room/session owns this instance. `clear` discards outstanding groups on
/// stop; no pending gift can reappear after a later explicit restart.
pub struct EventPipeline {
    merge: GiftMergeSettings,
    seen_ids: HashSet<String>,
    recent_ids: VecDeque<(Instant, String)>,
    gifts: Vec<PendingGift>,
}

impl EventPipeline {
    pub fn new(merge: GiftMergeSettings) -> Result<Self, &'static str> {
        if !merge.is_valid() {
            return Err("礼物合并时间设置无效");
        }
        Ok(Self {
            merge,
            seen_ids: HashSet::new(),
            recent_ids: VecDeque::new(),
            gifts: Vec::new(),
        })
    }

    pub fn ingest(&mut self, event: LiveEvent, now: Instant) -> Vec<LiveEvent> {
        if self.remember_event_id(&event, now) {
            return Vec::new();
        }
        if event.kind != EventKind::Gift || !self.merge.enabled {
            return vec![event];
        }
        let mut ready = Vec::new();
        if let Some(group) = self
            .gifts
            .iter_mut()
            .find(|group| same_gift(&group.event, &event))
        {
            group.event.quantity = group.event.quantity.saturating_add(event.quantity);
            group.event.price_yuan = (group.event.price_yuan + event.price_yuan).min(1.0e12);
            group.event.observed_at_ms = event.observed_at_ms;
            group.event.platform_event_id = None;
            group.last_update = now;
            group.window = (group.window + Duration::from_secs_f64(self.merge.increment_seconds))
                .min(Duration::from_secs_f64(self.merge.maximum_seconds));
        } else {
            if self.gifts.len() >= MAX_GIFT_GROUPS {
                ready.push(self.gifts.remove(0).event);
            }
            self.gifts.push(PendingGift {
                event,
                last_update: now,
                window: Duration::from_secs_f64(self.merge.initial_seconds),
            });
        }
        ready
    }

    /// Flush only groups whose quiet window elapsed, preserving arrival order.
    pub fn drain_due(&mut self, now: Instant) -> Vec<LiveEvent> {
        let mut ready = Vec::new();
        let mut index = 0;
        while index < self.gifts.len() {
            let group = &self.gifts[index];
            if now.saturating_duration_since(group.last_update) >= group.window {
                ready.push(self.gifts.remove(index).event);
            } else {
                index += 1;
            }
        }
        ready
    }

    /// A settings change starts a new grouping epoch. Flush old groups so a
    /// live edit does not silently erase a gift already received.
    pub fn set_merge_settings(
        &mut self,
        merge: GiftMergeSettings,
    ) -> Result<Vec<LiveEvent>, &'static str> {
        if !merge.is_valid() {
            return Err("礼物合并时间设置无效");
        }
        if self.merge == merge {
            return Ok(Vec::new());
        }
        let ready = self.gifts.drain(..).map(|group| group.event).collect();
        self.merge = merge;
        Ok(ready)
    }

    pub fn clear(&mut self) {
        self.gifts.clear();
        self.seen_ids.clear();
        self.recent_ids.clear();
    }

    /// Forget partial gift groups when speech is disabled, while retaining
    /// bounded event IDs so a reconnect cannot speak an old event again when
    /// speech is re-enabled.
    pub fn discard_pending_gifts(&mut self) {
        self.gifts.clear();
    }

    /// Display-only events still count as seen for later speech. The caller
    /// may ignore the duplicate result because raw display can show repeats.
    pub fn remember_event_id(&mut self, event: &LiveEvent, now: Instant) -> bool {
        self.expire_ids(now);
        self.is_duplicate(event, now)
    }

    pub fn pending_gifts(&self) -> usize {
        self.gifts.len()
    }

    fn expire_ids(&mut self, now: Instant) {
        while self
            .recent_ids
            .front()
            .is_some_and(|(seen, _)| now.saturating_duration_since(*seen) >= RECENT_ID_LIFETIME)
        {
            if let Some((_, key)) = self.recent_ids.pop_front() {
                self.seen_ids.remove(&key);
            }
        }
    }

    fn is_duplicate(&mut self, event: &LiveEvent, now: Instant) -> bool {
        let Some(id) = event
            .platform_event_id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 128)
        else {
            return false;
        };
        let kind = match event.kind {
            EventKind::Danmaku => "danmaku",
            EventKind::Gift => "gift",
            EventKind::SuperChat => "sc",
            EventKind::Guard => "guard",
        };
        let key = format!("{}:{kind}:{id}", event.room_id);
        if !self.seen_ids.insert(key.clone()) {
            return true;
        }
        self.recent_ids.push_back((now, key));
        while self.recent_ids.len() > MAX_RECENT_IDS {
            if let Some((_, old)) = self.recent_ids.pop_front() {
                self.seen_ids.remove(&old);
            }
        }
        false
    }
}

fn same_gift(left: &LiveEvent, right: &LiveEvent) -> bool {
    left.room_id == right.room_id
        && left.kind == EventKind::Gift
        && right.kind == EventKind::Gift
        && left.user_id == right.user_id
        && (left.user_id.is_some() || left.user_name == right.user_name)
        && left.gift_name == right.gift_name
        && left.coin_type == right.coin_type
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gift(uid: u64, name: &str, quantity: u32, price: f64, id: &str) -> LiveEvent {
        let mut event = LiveEvent::danmaku(42, Some(uid), name, "");
        event.kind = EventKind::Gift;
        event.gift_name = "小心心".into();
        event.quantity = quantity;
        event.price_yuan = price;
        event.platform_event_id = Some(id.into());
        event
    }

    #[test]
    fn id_dedupe_is_scoped_bounded_and_expires() {
        let now = Instant::now();
        let mut pipeline = EventPipeline::new(GiftMergeSettings::default()).unwrap();
        let event = gift(7, "A", 1, 1.0, "same");
        assert_eq!(pipeline.ingest(event.clone(), now).len(), 1);
        assert!(pipeline.ingest(event.clone(), now).is_empty());
        let mut other_room = event.clone();
        other_room.room_id = 43;
        assert_eq!(pipeline.ingest(other_room, now).len(), 1);
        assert_eq!(
            pipeline.ingest(event, now + Duration::from_secs(121)).len(),
            1
        );
        assert!(pipeline.recent_ids.len() <= MAX_RECENT_IDS);
    }

    #[test]
    fn gifts_group_by_uid_type_and_quiet_window() {
        let now = Instant::now();
        let mut pipeline = EventPipeline::new(GiftMergeSettings {
            enabled: true,
            initial_seconds: 1.5,
            increment_seconds: 0.5,
            maximum_seconds: 2.0,
        })
        .unwrap();
        assert!(pipeline.ingest(gift(7, "A", 1, 1.0, "one"), now).is_empty());
        assert!(
            pipeline
                .ingest(
                    gift(7, "A-renamed", 2, 2.0, "two"),
                    now + Duration::from_secs(1)
                )
                .is_empty()
        );
        assert!(
            pipeline
                .ingest(gift(8, "B", 1, 1.0, "three"), now + Duration::from_secs(1))
                .is_empty()
        );
        let ready = pipeline.drain_due(now + Duration::from_millis(2500));
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].user_id, Some(8));
        let ready = pipeline.drain_due(now + Duration::from_secs(3));
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].quantity, 3);
        assert_eq!(ready[0].price_yuan, 3.0);
    }

    #[test]
    fn stop_discards_and_setting_change_flushes() {
        let now = Instant::now();
        let mut pipeline = EventPipeline::new(GiftMergeSettings {
            enabled: true,
            ..GiftMergeSettings::default()
        })
        .unwrap();
        pipeline.ingest(gift(1, "A", 1, 1.0, "one"), now);
        assert_eq!(
            pipeline
                .set_merge_settings(GiftMergeSettings::default())
                .unwrap()
                .len(),
            1
        );
        pipeline.ingest(gift(1, "A", 1, 1.0, "two"), now);
        pipeline
            .set_merge_settings(GiftMergeSettings {
                enabled: true,
                ..GiftMergeSettings::default()
            })
            .unwrap();
        pipeline.ingest(gift(1, "A", 1, 1.0, "three"), now);
        pipeline.clear();
        assert!(pipeline.drain_due(now + Duration::from_secs(10)).is_empty());
    }

    #[test]
    fn speech_toggle_discards_gifts_but_remembers_live_and_display_only_ids() {
        let now = Instant::now();
        let mut pipeline = EventPipeline::new(GiftMergeSettings {
            enabled: true,
            ..GiftMergeSettings::default()
        })
        .unwrap();
        let spoken = gift(1, "A", 1, 1.0, "spoken");
        let displayed = gift(1, "A", 1, 1.0, "displayed");
        assert!(pipeline.ingest(spoken.clone(), now).is_empty());
        pipeline.discard_pending_gifts();
        assert_eq!(pipeline.pending_gifts(), 0);
        assert!(!pipeline.remember_event_id(&displayed, now));
        assert!(pipeline.ingest(spoken, now).is_empty());
        assert!(pipeline.ingest(displayed, now).is_empty());
        assert_eq!(pipeline.pending_gifts(), 0);
        assert_eq!(pipeline.recent_ids.len(), 2);
    }
}
