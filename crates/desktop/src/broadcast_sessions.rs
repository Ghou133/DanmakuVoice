//! Durable observations of the owner's current and last completed broadcast.
//! No historical API, credentials, user names or message text enter this record.
use super::{Controller, display};
use danmakuvoice_engine::{
    broadcast::BroadcastRoom,
    live::LiveSnapshot,
    storage::{
        BroadcastReceiverCursor, BroadcastSessionProgress, BroadcastSessionRecord,
        BroadcastSessionSummary, DataStore,
    },
};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub(super) fn observed_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .max(1)
}

pub(super) struct BroadcastSessionTracker {
    run_id: String,
    observation_run_id: String,
    key: Option<(u64, u64)>,
    record: BroadcastSessionRecord,
    seen_live: bool,
}

/// Only successful room observations can establish an overlay stream boundary.
/// Receiver reconnects and the durable statistics observation UUID are separate.
#[derive(Clone, Copy)]
pub(super) struct OverlayBroadcastObservation {
    uid: u64,
    room_id: u64,
    live: bool,
    started_at: Option<u64>,
}

struct ReceiverObservation<'a> {
    live: &'a LiveSnapshot,
    epoch: u64,
    started_at: u64,
    now: u64,
}

impl Default for BroadcastSessionTracker {
    fn default() -> Self {
        Self {
            run_id: Uuid::new_v4().to_string(),
            observation_run_id: Uuid::new_v4().to_string(),
            key: None,
            record: BroadcastSessionRecord::default(),
            seen_live: false,
        }
    }
}

impl BroadcastSessionTracker {
    fn invalidate_observation(&mut self) {
        // Keep the receiver lifetime UUID: reauthentication in this same
        // process must not count an already-checkpointed last_live again.
        self.key = None;
        self.record = BroadcastSessionRecord::default();
        self.seen_live = false;
        self.observation_run_id = Uuid::new_v4().to_string();
    }

    fn select(&mut self, store: &DataStore, uid: u64, room_id: u64) -> Result<(), String> {
        if self.key != Some((uid, room_id)) {
            let record = store
                .load_broadcast_session(uid, room_id)
                .map_err(display)?
                .unwrap_or_default();
            self.key = Some((uid, room_id));
            self.record = record;
            self.seen_live = false;
            self.observation_run_id = Uuid::new_v4().to_string();
        }
        Ok(())
    }

    pub(super) fn summary(
        &self,
        uid: Option<u64>,
        room_id: Option<u64>,
    ) -> Option<&BroadcastSessionSummary> {
        if self.key == uid.zip(room_id) {
            self.record.last_session.as_ref()
        } else {
            None
        }
    }

    pub(super) fn active(&self, uid: Option<u64>, room_id: Option<u64>) -> bool {
        self.key == uid.zip(room_id) && self.record.active.is_some()
    }

    /// Every successful refresh, title update, start and stop uses this method.
    /// A changed live_since starts a new observation without pretending that we
    /// saw the previous stream finish while this application was absent.
    fn observe_room(
        &mut self,
        store: &mut DataStore,
        uid: u64,
        room: &BroadcastRoom,
        observation: ReceiverObservation<'_>,
    ) -> Result<(), String> {
        let now = observation.now;
        self.select(store, uid, room.room_id)?;
        let mut next = self.record.clone();
        if room.live_status == 1 {
            let start = room.live_since.filter(|start| *start > 0 && *start <= now);
            let replace =
                next.active
                    .as_ref()
                    .is_none_or(|active| match (active.started_at, start) {
                        (Some(previous), Some(current)) => previous != current,
                        (None, Some(current)) => current > active.observed_started_at,
                        (None, None) => active.observation_run_id != self.observation_run_id,
                        _ => false,
                    });
            if replace {
                next.active = Some(BroadcastSessionProgress {
                    observation_run_id: self.observation_run_id.clone(),
                    started_at: start,
                    observed_started_at: now,
                    last_observed_at: now,
                    messages: 0,
                    receiver: None,
                });
            }
            let active = next.active.as_mut().expect("live observation initialized");
            if active.started_at.is_none() {
                active.started_at = start;
            }
            active.last_observed_at = active.last_observed_at.max(now);
            self.count(active, room.room_id, &observation);
        } else if let Some(mut active) = next.active.take() {
            // Include packets received since the last UI poll before committing
            // the ending. Counter data is independent of the 100-message buffer.
            if self.seen_live {
                self.count(&mut active, room.room_id, &observation);
            }
            let end = now.max(active.last_observed_at);
            next.last_session = Some(BroadcastSessionSummary {
                started_at: active.started_at,
                observed_started_at: active.observed_started_at,
                ended_observed_at: end,
                messages: active.messages,
                seconds: self
                    .seen_live
                    .then_some(active.started_at)
                    .flatten()
                    .map(|start| end - start),
            });
        }
        if next != self.record {
            store
                .save_broadcast_session(uid, room.room_id, &next)
                .map_err(display)?;
            self.record = next;
        }
        self.seen_live = room.live_status == 1;
        Ok(())
    }

    fn count(
        &self,
        active: &mut BroadcastSessionProgress,
        room_id: u64,
        observation: &ReceiverObservation<'_>,
    ) {
        let ReceiverObservation {
            live,
            epoch,
            started_at: receiver_started_at,
            now,
        } = *observation;
        if live.canonical_room_id() != Some(room_id) {
            return;
        }
        let previous = active.receiver.as_ref();
        let same_receiver =
            previous.is_some_and(|cursor| cursor.run_id == self.run_id && cursor.epoch == epoch);
        let boundary = active.started_at.unwrap_or(active.observed_started_at);
        let added = if same_receiver {
            live.received
                .saturating_sub(previous.expect("same receiver").received)
        } else if receiver_started_at >= boundary {
            live.received
        } else {
            // The receiver predates this stream. Its cumulative count also
            // contains an older stream, so only attributable retained events
            // are admitted at this boundary; later increments remain complete.
            live.recent_events
                .iter()
                .filter(|event| event.room_id == room_id && event.observed_at_ms / 1000 >= boundary)
                .count() as u64
        };
        active.messages = active.messages.saturating_add(added);
        if added > 0 {
            active.last_observed_at = active.last_observed_at.max(now);
        }
        let received = if same_receiver {
            live.received.max(previous.expect("same receiver").received)
        } else {
            live.received
        };
        active.receiver = Some(BroadcastReceiverCursor {
            run_id: self.run_id.clone(),
            epoch,
            received,
        });
    }

    fn observe_received(
        &mut self,
        store: &mut DataStore,
        uid: u64,
        room_id: u64,
        observation: ReceiverObservation<'_>,
    ) -> Result<(), String> {
        self.select(store, uid, room_id)?;
        if !self.seen_live {
            return Ok(());
        }
        let mut next = self.record.clone();
        if let Some(active) = &mut next.active {
            self.count(active, room_id, &observation);
        }
        if next != self.record {
            store
                .save_broadcast_session(uid, room_id, &next)
                .map_err(display)?;
            self.record = next;
        }
        Ok(())
    }
}

impl Controller {
    pub(super) fn suspend_broadcast_observation(&mut self, now: u64) -> Result<(), String> {
        let live = self
            .live
            .as_ref()
            .map(|live| live.snapshot())
            .unwrap_or_else(|| self.last_live.clone());
        self.observe_broadcast_received(&live, now)?;
        self.broadcast_session.invalidate_observation();
        Ok(())
    }

    pub(super) fn observe_broadcast_room(&mut self, now: u64) -> Result<(), String> {
        self.observe_broadcast_room_with_start_authority(now, true)
    }

    pub(super) fn observe_broadcast_room_with_start_authority(
        &mut self,
        now: u64,
        authoritative_start: bool,
    ) -> Result<(), String> {
        let Some((uid, room)) = self
            .bili_user_id
            .filter(|uid| *uid > 0)
            .zip(self.broadcast.room.clone())
        else {
            return Ok(());
        };
        let live = self
            .live
            .as_ref()
            .map(|live| live.snapshot())
            .unwrap_or_else(|| self.last_live.clone());
        self.broadcast_session.observe_room(
            &mut self.store,
            uid,
            &room,
            ReceiverObservation {
                live: &live,
                epoch: self.broadcast_receiver_epoch,
                started_at: self.broadcast_receiver_started_at,
                now,
            },
        )?;
        let target = live.canonical_room_id();
        // Do not clear a different watched room, or infer an ending from a
        // missing account, cached snapshot or connection/recovery status.
        if target != Some(room.room_id) || room.live_status > 2 {
            return Ok(());
        }
        let live = room.live_status == 1;
        let previous = self
            .overlay_broadcast_observation
            .filter(|previous| previous.uid == uid && previous.room_id == room.room_id);
        let actual_start = authoritative_start
            .then_some(room.live_since)
            .flatten()
            .filter(|start| *start > 0 && *start <= now);
        let changed = previous.is_some_and(|previous| {
            previous.live != live
                || (live
                    && previous.live
                    && previous
                        .started_at
                        .zip(actual_start)
                        .is_some_and(|(before, after)| before != after))
        });
        let started_at = if live {
            actual_start.or_else(|| {
                previous
                    .filter(|previous| previous.live)
                    .and_then(|previous| previous.started_at)
            })
        } else {
            None
        };
        self.overlay_broadcast_observation = Some(OverlayBroadcastObservation {
            uid,
            room_id: room.room_id,
            live,
            started_at,
        });
        if changed {
            self.overlay_hub.clear_items();
        }
        Ok(())
    }

    pub(super) fn observe_broadcast_received(
        &mut self,
        live: &LiveSnapshot,
        now: u64,
    ) -> Result<(), String> {
        let Some((uid, room)) = self
            .bili_user_id
            .filter(|uid| *uid > 0)
            .zip(self.broadcast.room.as_ref())
        else {
            return Ok(());
        };
        if self.prefs.broadcast_console && room.live_status == 1 {
            self.broadcast_session.observe_received(
                &mut self.store,
                uid,
                room.room_id,
                ReceiverObservation {
                    live,
                    epoch: self.broadcast_receiver_epoch,
                    started_at: self.broadcast_receiver_started_at,
                    now,
                },
            )?;
        } else {
            // Loading an existing last summary is safe; cached room data must
            // never finalize an active stream or invent a new live transition.
            self.broadcast_session
                .select(&self.store, uid, room.room_id)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::Application;
    use super::*;
    use danmakuvoice_engine::model::LiveEvent;

    fn room(room_id: u64, live: bool, started_at: Option<u64>) -> BroadcastRoom {
        BroadcastRoom {
            room_id,
            title: "observed room".into(),
            parent_area_id: 1,
            area_id: 2,
            live_status: u64::from(live),
            live_since: started_at,
        }
    }

    fn live(room_id: u64, received: u64) -> LiveSnapshot {
        LiveSnapshot {
            room_id: Some(room_id),
            received,
            running: true,
            ..Default::default()
        }
    }

    fn observation(
        live: &LiveSnapshot,
        epoch: u64,
        started_at: u64,
        now: u64,
    ) -> ReceiverObservation<'_> {
        ReceiverObservation {
            live,
            epoch,
            started_at,
            now,
        }
    }

    fn isolated() -> (tempfile::TempDir, DataStore, BroadcastSessionTracker) {
        let directory = tempfile::tempdir().unwrap();
        let store = DataStore::open(directory.path()).unwrap();
        (directory, store, BroadcastSessionTracker::default())
    }

    #[test]
    fn short_room_number_counts_canonical_room_and_preserves_final_count() {
        let (_directory, mut store, mut tracker) = isolated();
        let mut receiver = live(2, 3);
        receiver.resolved_room_id = Some(800);
        tracker
            .observe_room(
                &mut store,
                11,
                &room(800, true, Some(100)),
                observation(&receiver, 1, 110, 120),
            )
            .unwrap();
        receiver.running = false;
        receiver.room_state = danmakuvoice_engine::bilibili::RoomState::Stopped;
        receiver.received = 5;
        tracker
            .observe_room(
                &mut store,
                11,
                &room(800, false, None),
                observation(&receiver, 1, 110, 130),
            )
            .unwrap();
        assert_eq!(tracker.summary(Some(11), Some(800)).unwrap().messages, 5);
    }

    #[test]
    fn broadcast_session_counts_beyond_buffer_idempotently_and_commits_final_packets() {
        let (directory, mut store, mut tracker) = isolated();
        let own_room = room(8, true, Some(100));
        // The display buffer is empty, but the real receiver counter is complete.
        tracker
            .observe_room(
                &mut store,
                11,
                &own_room,
                observation(&live(8, 340), 1, 110, 120),
            )
            .unwrap();
        for received in [480, 480, 475, 485] {
            tracker
                .observe_received(
                    &mut store,
                    11,
                    8,
                    observation(&live(8, received), 1, 110, 130),
                )
                .unwrap();
        }
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&live(8, 490), 1, 110, 150),
            )
            .unwrap();
        let last = tracker.summary(Some(11), Some(8)).unwrap().clone();
        assert_eq!(last.messages, 490);
        assert_eq!(last.seconds, Some(50));
        assert!(!tracker.active(Some(11), Some(8)));
        drop(store);
        let reopened = DataStore::open(directory.path()).unwrap();
        assert_eq!(
            reopened
                .load_broadcast_session(11, 8)
                .unwrap()
                .unwrap()
                .last_session,
            Some(last)
        );
    }

    #[test]
    fn broadcast_session_restart_and_new_receiver_add_own_counters_without_subtraction() {
        let (directory, mut store, mut tracker) = isolated();
        let own_room = room(8, true, Some(100));
        tracker
            .observe_room(
                &mut store,
                11,
                &own_room,
                observation(&live(8, 330), 1, 110, 200),
            )
            .unwrap();
        drop(store);
        let mut store = DataStore::open(directory.path()).unwrap();
        let mut restarted = BroadcastSessionTracker::default();
        // Same backend lifetime epoch number, different run UUID. Even when
        // this counter exceeds the old counter, all new packets are added.
        restarted
            .observe_room(
                &mut store,
                11,
                &own_room,
                observation(&live(8, 500), 1, 210, 250),
            )
            .unwrap();
        assert!(restarted.summary(Some(11), Some(8)).is_none());
        assert_eq!(restarted.record.active.as_ref().unwrap().messages, 830);
        let mut new_receiver = live(8, 40);
        new_receiver.recent_events = vec![LiveEvent::danmaku(
            8,
            None,
            "carried user",
            "carried old event",
        )];
        // Carried display events never add a second copy of previous packets.
        restarted
            .observe_received(&mut store, 11, 8, observation(&new_receiver, 2, 260, 270))
            .unwrap();
        restarted
            .observe_received(&mut store, 11, 8, observation(&new_receiver, 2, 260, 270))
            .unwrap();
        assert_eq!(restarted.record.active.as_ref().unwrap().messages, 870);
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&new_receiver, 2, 260, 320),
            )
            .unwrap();
        assert_eq!(restarted.summary(Some(11), Some(8)).unwrap().messages, 870);
    }

    #[test]
    fn broadcast_session_new_stream_after_absence_does_not_invent_last_session() {
        let (_directory, mut store, mut tracker) = isolated();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(100)),
                observation(&live(8, 12), 1, 110, 120),
            )
            .unwrap();
        let mut restarted = BroadcastSessionTracker::default();
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(300)),
                observation(&live(8, 5), 1, 310, 320),
            )
            .unwrap();
        assert!(restarted.summary(Some(11), Some(8)).is_none());
        let active = restarted.record.active.as_ref().unwrap();
        assert_eq!(active.started_at, Some(300));
        assert_eq!(active.messages, 5);
    }

    #[test]
    fn broadcast_session_offline_after_restart_preserves_count_with_unknown_duration() {
        let (_directory, mut store, mut tracker) = isolated();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(100)),
                observation(&live(8, 123), 1, 110, 120),
            )
            .unwrap();
        let mut restarted = BroadcastSessionTracker::default();
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&live(8, 900), 1, 410, 500),
            )
            .unwrap();
        let last = restarted.summary(Some(11), Some(8)).unwrap();
        assert_eq!(last.messages, 123);
        assert_eq!(last.ended_observed_at, 500);
        assert_eq!(last.seconds, None);
        assert_eq!(
            store
                .load_broadcast_session(11, 8)
                .unwrap()
                .unwrap()
                .last_session
                .as_ref(),
            Some(last)
        );
    }

    #[test]
    fn broadcast_session_unknown_start_does_not_merge_unproven_stream_identity() {
        let (_directory, mut store, mut tracker) = isolated();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, None),
                observation(&live(8, 12), 1, 110, 110),
            )
            .unwrap();
        let mut restarted = BroadcastSessionTracker::default();
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, true, None),
                observation(&live(8, 7), 1, 210, 210),
            )
            .unwrap();
        assert_eq!(restarted.record.active.as_ref().unwrap().messages, 7);
        assert!(restarted.summary(Some(11), Some(8)).is_none());
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&live(8, 7), 1, 210, 230),
            )
            .unwrap();
        assert_eq!(restarted.summary(Some(11), Some(8)).unwrap().seconds, None);
    }

    #[test]
    fn broadcast_session_account_room_and_watched_foreign_room_are_isolated() {
        let (_directory, mut store, mut tracker) = isolated();
        for (uid, own, received) in [(11, 8, 80), (22, 8, 20), (11, 9, 7)] {
            tracker
                .observe_room(
                    &mut store,
                    uid,
                    &room(own, true, Some(100)),
                    observation(&live(own, received), 1, 110, 120),
                )
                .unwrap();
            tracker
                .observe_room(
                    &mut store,
                    uid,
                    &room(own, false, None),
                    observation(&live(own, received), 1, 110, 150),
                )
                .unwrap();
            assert_eq!(
                tracker.summary(Some(uid), Some(own)).unwrap().messages,
                received
            );
        }
        assert!(tracker.summary(Some(11), Some(8)).is_none());
        for (uid, own, received) in [(11, 8, 80), (22, 8, 20), (11, 9, 7)] {
            assert_eq!(
                store
                    .load_broadcast_session(uid, own)
                    .unwrap()
                    .unwrap()
                    .last_session
                    .unwrap()
                    .messages,
                received
            );
        }
        tracker
            .observe_room(
                &mut store,
                33,
                &room(10, true, Some(100)),
                observation(&live(8, 900), 1, 110, 120),
            )
            .unwrap();
        tracker
            .observe_room(
                &mut store,
                33,
                &room(10, false, None),
                observation(&live(8, 920), 1, 110, 150),
            )
            .unwrap();
        assert_eq!(tracker.summary(Some(33), Some(10)).unwrap().messages, 0);
    }

    #[test]
    fn broadcast_session_receiver_before_stream_uses_timestamp_boundary_then_all_new_packets() {
        let (_directory, mut store, mut tracker) = isolated();
        let mut received = live(8, 280);
        received.recent_events = [99, 101, 102]
            .into_iter()
            .map(|time| {
                let mut event = LiveEvent::danmaku(8, None, "user", "message");
                event.observed_at_ms = time * 1000;
                event
            })
            .collect();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(100)),
                observation(&received, 1, 90, 120),
            )
            .unwrap();
        assert_eq!(tracker.record.active.as_ref().unwrap().messages, 2);
        received.received = 430;
        tracker
            .observe_received(&mut store, 11, 8, observation(&received, 1, 90, 130))
            .unwrap();
        assert_eq!(tracker.record.active.as_ref().unwrap().messages, 152);
    }

    #[test]
    fn broadcast_session_failed_commit_leaves_progress_retryable() {
        let (_directory, mut store, mut tracker) = isolated();
        let own_room = room(8, true, Some(100));
        assert!(
            tracker
                .observe_room(
                    &mut store,
                    11,
                    &own_room,
                    observation(&live(8, 3), 1, 100, 0)
                )
                .is_err()
        );
        assert!(tracker.record.active.is_none());
        assert!(!tracker.seen_live);
        assert!(store.load_broadcast_session(11, 8).unwrap().is_none());
        tracker
            .observe_room(
                &mut store,
                11,
                &own_room,
                observation(&live(8, 3), 1, 100, 120),
            )
            .unwrap();
        assert_eq!(tracker.record.active.as_ref().unwrap().messages, 3);
    }

    #[test]
    fn broadcast_session_application_ending_snapshot_has_latest_persisted_summary() {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), true).unwrap();
        assert!(app.snapshot().unwrap()["broadcast"]["last_session"].is_null());
        {
            let mut state = app.lock().unwrap();
            state.bili_user_id = Some(11);
            state.prefs.broadcast_console = true;
            state.broadcast.room = Some(room(8, true, Some(100)));
            state.broadcast_receiver_epoch = 1;
            state.broadcast_receiver_started_at = 110;
            state.last_live = live(8, 301);
            state.observe_broadcast_room(120).unwrap();
            state.broadcast.room = Some(room(8, false, None));
            state.last_live.received = 312;
            state.observe_broadcast_room(150).unwrap();
        }
        let snapshot = app.snapshot().unwrap();
        assert_eq!(snapshot["broadcast"]["last_session"]["messages"], 312);
        assert_eq!(snapshot["broadcast"]["last_session"]["seconds"], 50);
        assert_eq!(snapshot["broadcast"]["session_active"], false);
        drop(app);
        let restarted = Application::new(directory.path().to_path_buf(), true).unwrap();
        {
            let mut state = restarted.lock().unwrap();
            state.bili_user_id = Some(11);
            state.broadcast.room = Some(room(8, false, None));
        }
        assert_eq!(
            restarted.snapshot().unwrap()["broadcast"]["last_session"],
            snapshot["broadcast"]["last_session"]
        );
        restarted.lock().unwrap().bili_user_id = Some(22);
        assert!(restarted.snapshot().unwrap()["broadcast"]["last_session"].is_null());
    }

    #[test]
    fn broadcast_session_cached_or_disabled_snapshot_does_not_finalize_current_stream() {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), true).unwrap();
        {
            let mut state = app.lock().unwrap();
            state.bili_user_id = Some(11);
            state.prefs.broadcast_console = true;
            state.broadcast.room = Some(room(8, true, Some(100)));
            state.broadcast_receiver_started_at = 110;
            state.last_live = live(8, 123);
            state.observe_broadcast_room(120).unwrap();
        }
        drop(app);
        let restarted = Application::new(directory.path().to_path_buf(), true).unwrap();
        {
            let mut state = restarted.lock().unwrap();
            state.bili_user_id = Some(11);
            state.prefs.broadcast_console = false;
            state.broadcast.room = Some(room(8, false, None));
            state.last_live = live(8, 999);
        }
        let snapshot = restarted.snapshot().unwrap();
        assert!(snapshot["broadcast"]["last_session"].is_null());
        assert_eq!(snapshot["broadcast"]["session_active"], true);
        assert_eq!(
            restarted
                .lock()
                .unwrap()
                .store
                .load_broadcast_session(11, 8)
                .unwrap()
                .unwrap()
                .active
                .unwrap()
                .messages,
            123
        );
    }

    #[test]
    fn broadcast_session_existing_last_survives_current_session_until_actual_ending() {
        let (_directory, mut store, mut tracker) = isolated();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(100)),
                observation(&live(8, 120), 1, 110, 120),
            )
            .unwrap();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&live(8, 130), 1, 110, 150),
            )
            .unwrap();
        let first = tracker.summary(Some(11), Some(8)).unwrap().clone();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(200)),
                observation(&live(8, 20), 2, 210, 220),
            )
            .unwrap();
        let mut restarted = BroadcastSessionTracker::default();
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(200)),
                observation(&live(8, 40), 1, 230, 240),
            )
            .unwrap();
        assert_eq!(restarted.summary(Some(11), Some(8)), Some(&first));
        assert_eq!(restarted.record.active.as_ref().unwrap().messages, 60);
        restarted
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&live(8, 45), 1, 230, 250),
            )
            .unwrap();
        let last = restarted.summary(Some(11), Some(8)).unwrap();
        assert_eq!(last.started_at, Some(200));
        assert_eq!(last.messages, 65);
        assert_eq!(last.seconds, Some(50));
    }

    #[tokio::test]
    async fn broadcast_session_receive_stop_checkpoints_remaining_packets_without_ending_stream() {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), true).unwrap();
        {
            let mut state = app.lock().unwrap();
            state.bili_user_id = Some(11);
            state.prefs.broadcast_console = true;
            state.broadcast.room = Some(room(8, true, Some(100)));
            state.broadcast_receiver_started_at = 110;
            state.last_live = live(8, 120);
            state.observe_broadcast_room(120).unwrap();
            state.last_live.received = 180;
        }
        app.stop(false).await.unwrap();
        let snapshot = app.snapshot().unwrap();
        assert!(snapshot["broadcast"]["last_session"].is_null());
        assert_eq!(snapshot["broadcast"]["session_active"], true);
        let state = app.lock().unwrap();
        assert!(!state.stopping);
        assert_eq!(
            state
                .store
                .load_broadcast_session(11, 8)
                .unwrap()
                .unwrap()
                .active
                .unwrap()
                .messages,
            180
        );
    }

    #[test]
    fn broadcast_session_new_known_start_after_unknown_observation_is_not_merged() {
        let (_directory, mut store, mut tracker) = isolated();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, None),
                observation(&live(8, 10), 1, 100, 100),
            )
            .unwrap();
        // Receiving continued while no new authoritative room snapshot arrived.
        tracker
            .observe_received(&mut store, 11, 8, observation(&live(8, 30), 1, 100, 200))
            .unwrap();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, Some(150)),
                observation(&live(8, 5), 2, 200, 210),
            )
            .unwrap();
        assert_eq!(
            tracker.record.active.as_ref().unwrap().started_at,
            Some(150)
        );
        assert_eq!(tracker.record.active.as_ref().unwrap().messages, 5);
        assert!(tracker.summary(Some(11), Some(8)).is_none());
    }

    #[test]
    fn broadcast_session_same_owner_after_auth_gap_uses_unknown_end_without_double_counting() {
        let (_directory, mut store, mut tracker) = isolated();
        let own_room = room(8, true, Some(100));
        tracker
            .observe_room(
                &mut store,
                11,
                &own_room,
                observation(&live(8, 170), 1, 110, 120),
            )
            .unwrap();
        let run_id = tracker.run_id.clone();
        tracker.invalidate_observation();
        assert_eq!(tracker.run_id, run_id);
        tracker
            .observe_room(
                &mut store,
                11,
                &own_room,
                observation(&live(8, 170), 1, 110, 150),
            )
            .unwrap();
        assert_eq!(tracker.record.active.as_ref().unwrap().messages, 170);
        tracker.invalidate_observation();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, false, None),
                observation(&live(8, 170), 1, 110, 200),
            )
            .unwrap();
        let last = tracker.summary(Some(11), Some(8)).unwrap();
        assert_eq!(last.messages, 170);
        assert_eq!(last.seconds, None);
    }

    #[tokio::test]
    async fn broadcast_session_console_disable_checkpoints_then_breaks_observation_continuity() {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), true).unwrap();
        {
            let mut state = app.lock().unwrap();
            state.bili_user_id = Some(11);
            state.prefs.broadcast_console = true;
            state.broadcast.room = Some(room(8, true, Some(100)));
            state.broadcast_receiver_started_at = 110;
            state.last_live = live(8, 120);
            state.observe_broadcast_room(120).unwrap();
            state.last_live.received = 160;
        }
        app.preferences(&serde_json::json!({"preferences":{"broadcast_console":false}}))
            .await
            .unwrap();
        {
            let mut state = app.lock().unwrap();
            assert!(!state.broadcast_session.seen_live);
            assert_eq!(
                state
                    .store
                    .load_broadcast_session(11, 8)
                    .unwrap()
                    .unwrap()
                    .active
                    .unwrap()
                    .messages,
                160
            );
            state.broadcast.room = Some(room(8, false, None));
            state.observe_broadcast_room(200).unwrap();
        }
        let snapshot = app.snapshot().unwrap();
        assert_eq!(snapshot["broadcast"]["last_session"]["messages"], 160);
        assert!(snapshot["broadcast"]["last_session"]["seconds"].is_null());
    }

    #[test]
    fn broadcast_session_unknown_start_after_observation_gap_is_not_merged() {
        let (_directory, mut store, mut tracker) = isolated();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, None),
                observation(&live(8, 10), 1, 100, 100),
            )
            .unwrap();
        tracker.invalidate_observation();
        tracker
            .observe_room(
                &mut store,
                11,
                &room(8, true, None),
                observation(&live(8, 7), 2, 200, 200),
            )
            .unwrap();
        assert_eq!(tracker.record.active.as_ref().unwrap().messages, 7);
        assert!(tracker.summary(Some(11), Some(8)).is_none());
    }

    #[test]
    fn overlay_broadcast_boundaries_follow_successful_matching_room_observations() {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), true).unwrap();
        let mut state = app.lock().unwrap();
        state.bili_user_id = Some(11);
        state.prefs.broadcast_console = true;
        state.last_live = live(8, 1);
        state.broadcast.room = Some(room(8, true, Some(100)));
        state.observe_broadcast_room(120).unwrap();
        let hub = state.overlay_hub.clone();
        hub.publish_item(serde_json::json!({"kind":"danmaku","message":"同场内容"}));
        hub.set_reading(serde_json::json!({"job_id":7}));
        let before = hub.replay_snapshot();
        state.observe_broadcast_room(130).unwrap();
        assert_eq!(hub.replay_snapshot(), before);
        // Cached room data and ordinary UI polling cannot infer an ending.
        state.broadcast.room = Some(room(8, false, None));
        let last_live = state.last_live.clone();
        state.observe_broadcast_received(&last_live, 140).unwrap();
        assert_eq!(hub.replay_snapshot(), before);
        state.observe_broadcast_room(150).unwrap();
        assert_eq!(hub.replay_boundary().0, 1);
        assert_eq!(hub.replay_snapshot()["items"], serde_json::json!([]));
        assert!(hub.replay_snapshot()["reading"].is_null());
        state.observe_broadcast_room(160).unwrap();
        assert_eq!(hub.replay_boundary().0, 1);
        // Non-live -> live is a new stream; a changed real start detects a
        // missed ending without any new polling mechanism.
        state.broadcast.room = Some(room(8, true, Some(170)));
        state.observe_broadcast_room(180).unwrap();
        assert_eq!(hub.replay_boundary().0, 2);
        state.broadcast.room = Some(room(8, true, Some(190)));
        state.observe_broadcast_room(200).unwrap();
        assert_eq!(hub.replay_boundary().0, 3);
        state.last_live = live(9, 1);
        state.broadcast.room = Some(room(8, false, None));
        state.observe_broadcast_room(210).unwrap();
        assert_eq!(hub.replay_boundary().0, 3);
    }

    #[test]
    fn overlay_broadcast_unknown_or_synthetic_start_does_not_clear_the_same_stream() {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), true).unwrap();
        let mut state = app.lock().unwrap();
        state.bili_user_id = Some(11);
        state.last_live = live(8, 1);
        state.broadcast.room = Some(room(8, false, None));
        state.observe_broadcast_room(100).unwrap();
        state.broadcast.room = Some(room(8, true, Some(120)));
        state
            .observe_broadcast_room_with_start_authority(130, false)
            .unwrap();
        let hub = state.overlay_hub.clone();
        assert_eq!(hub.replay_boundary().0, 1);
        hub.publish_item(serde_json::json!({"kind":"danmaku","message":"保留"}));
        let before = hub.replay_snapshot();
        // get_info corrects the locally synthesized start by a few seconds.
        state.broadcast.room = Some(room(8, true, Some(118)));
        state.observe_broadcast_room(140).unwrap();
        assert_eq!(hub.replay_snapshot(), before);
        state.broadcast.room = Some(room(8, true, None));
        state.observe_broadcast_room(150).unwrap();
        state.broadcast.room = Some(room(8, true, Some(0)));
        state.observe_broadcast_room(160).unwrap();
        state.broadcast.room = Some(room(8, true, Some(999)));
        state.observe_broadcast_room(170).unwrap();
        assert_eq!(hub.replay_snapshot(), before);
        let mut unknown = room(8, false, None);
        unknown.live_status = 7;
        state.broadcast.room = Some(unknown);
        state.observe_broadcast_room(180).unwrap();
        assert_eq!(hub.replay_snapshot(), before);
        state.broadcast.room = Some(room(8, true, Some(190)));
        state.observe_broadcast_room(200).unwrap();
        assert_eq!(hub.replay_boundary().0, 2);
    }
}
