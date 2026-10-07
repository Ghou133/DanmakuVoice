//! Public Bilibili audience data. The contribution rank is a partial list,
//! and WATCHED_CHANGE is cumulative reach, never concurrent viewership.
use std::time::Duration;

use reqwest::{Client, header::REFERER};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::bilibili::{BiliError, bili_image_url, read_json, require_api_ok};

const PAGE_SIZE: usize = 50;
const MAX_USERS: usize = 1000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AudienceSnapshot {
    pub active: bool,
    /// Actual broadcast status from room_init, independent of socket reception.
    pub live_status: Option<u8>,
    pub loading: bool,
    pub error: Option<String>,
    pub rank_count: Option<u64>,
    pub rank_count_text: Option<String>,
    pub watched_count: Option<u64>,
    pub updated_at_ms: Option<u64>,
    pub users: Vec<AudienceUser>,
    pub page: usize,
    pub has_more: bool,
    pub limit_reached: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AudienceUser {
    pub user_id: Option<u64>,
    pub user_name: String,
    pub avatar_url: Option<String>,
    pub rank: Option<u64>,
    pub score: Option<String>,
    pub guard_level: Option<u64>,
    pub medal_name: Option<String>,
    pub medal_level: Option<u64>,
    pub mystery: bool,
}

impl AudienceSnapshot {
    fn apply_room_page(
        &mut self,
        page: usize,
        response: AudiencePage,
        now_ms: u64,
    ) -> Result<(), BiliError> {
        self.live_status = Some(response.live_status);
        if response.live_status != 1 {
            // A connected room is not necessarily broadcasting. Room status is
            // positive evidence for zero live viewers; no rank request is made.
            self.rank_count = Some(0);
            self.rank_count_text = Some("0".to_owned());
            self.users.clear();
            self.page = 1;
            self.has_more = false;
            self.limit_reached = false;
            self.updated_at_ms = Some(now_ms);
            self.error = None;
            return Ok(());
        }
        self.apply_page(
            page,
            &response.rank.ok_or(BiliError::Protocol("高能榜列表无效"))?,
            now_ms,
        )
    }

    pub(crate) fn apply_packet(&mut self, value: &Value) {
        if value.get("cmd").and_then(Value::as_str) == Some("WATCHED_CHANGE")
            && let Some(count) = value.pointer("/data/num").and_then(Value::as_u64)
        {
            self.watched_count = Some(count);
        }
    }

    fn apply_page(&mut self, page: usize, value: &Value, now_ms: u64) -> Result<(), BiliError> {
        require_api_ok(value)?;
        let count = value
            .pointer("/data/onlineNum")
            .and_then(Value::as_u64)
            .ok_or(BiliError::Protocol("缺少高能榜人数"))?;
        let items = value
            .pointer("/data/OnlineRankItem")
            .and_then(Value::as_array)
            .filter(|items| items.len() <= PAGE_SIZE)
            .ok_or(BiliError::Protocol("高能榜列表无效"))?;
        let users: Vec<_> = items.iter().filter_map(parse_user).collect();
        let text = value
            .pointer("/data/onlineNumText")
            .and_then(Value::as_str)
            .filter(|text| {
                !text.is_empty()
                    && text.len() <= 20
                    && text
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || byte == b'+')
            })
            .map(str::to_owned)
            .unwrap_or_else(|| count.to_string());
        // Validate the whole envelope before discarding a previous successful page.
        if page == 1 {
            self.users.clear();
        }
        for user in users {
            if user.user_id.is_none() || !self.users.iter().any(|old| old.user_id == user.user_id) {
                self.users.push(user);
            }
        }
        self.users.truncate(MAX_USERS);
        self.rank_count = Some(count);
        self.rank_count_text = Some(text);
        self.page = page;
        self.limit_reached = items.len() == PAGE_SIZE && page * PAGE_SIZE >= MAX_USERS;
        self.has_more = items.len() == PAGE_SIZE && !self.limit_reached;
        self.updated_at_ms = Some(now_ms);
        self.error = None;
        Ok(())
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| {
            !text.trim().is_empty() && text.len() <= 256 && !text.chars().any(char::is_control)
        })
        .map(str::to_owned)
}

fn positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|value| *value > 0)
}

fn parse_user(value: &Value) -> Option<AudienceUser> {
    let mystery = value
        .get("is_mystery")
        .is_some_and(|flag| flag.as_bool() == Some(true) || flag.as_u64().is_some_and(|n| n > 0));
    let user_name = text(value.get("name")).or_else(|| text(value.pointer("/uinfo/base/name")))?;
    let score = text(value.get("score")).or_else(|| {
        value
            .get("score")
            .and_then(Value::as_u64)
            .map(|score| score.to_string())
    });
    Some(AudienceUser {
        user_id: if mystery {
            None
        } else {
            positive(value.get("uid")).or_else(|| positive(value.pointer("/uinfo/uid")))
        },
        user_name,
        avatar_url: bili_image_url(value.get("face"))
            .or_else(|| bili_image_url(value.pointer("/uinfo/base/face"))),
        rank: positive(value.get("userRank")),
        score,
        guard_level: positive(value.get("guard_level"))
            .or_else(|| positive(value.pointer("/uinfo/guard/level")))
            .filter(|level| *level <= 3),
        medal_name: text(value.pointer("/medalInfo/medal_name"))
            .or_else(|| text(value.pointer("/uinfo/medal/name"))),
        medal_level: positive(value.pointer("/medalInfo/level"))
            .or_else(|| positive(value.pointer("/uinfo/medal/level"))),
        mystery,
    })
}

struct AudiencePage {
    live_status: u8,
    rank: Option<Value>,
}

fn room_live_status(room: &Value) -> Result<u8, BiliError> {
    room.pointer("/data/live_status")
        .and_then(Value::as_u64)
        .filter(|status| *status <= 2)
        .map(|status| status as u8)
        .ok_or(BiliError::Protocol("缺少直播状态"))
}

async fn fetch_page(
    http: &Client,
    display_id: u64,
    page: usize,
) -> Result<AudiencePage, BiliError> {
    let room = read_json(
        http.get("https://api.live.bilibili.com/room/v1/Room/room_init")
            .query(&[("id", display_id)])
            .send()
            .await
            .map_err(|_| BiliError::Network)?,
    )
    .await?;
    require_api_ok(&room)?;
    let live_status = room_live_status(&room)?;
    if live_status != 1 {
        return Ok(AudiencePage {
            live_status,
            rank: None,
        });
    }
    let room_id =
        positive(room.pointer("/data/room_id")).ok_or(BiliError::Protocol("缺少直播间真实 ID"))?;
    let uid = positive(room.pointer("/data/uid")).ok_or(BiliError::Protocol("缺少主播 UID"))?;
    let rank = read_json(
        http.get("https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank")
            .header(REFERER, format!("https://live.bilibili.com/{room_id}"))
            .query(&[
                ("roomId", room_id),
                ("ruid", uid),
                ("page", page as u64),
                ("pageSize", PAGE_SIZE as u64),
            ])
            .send()
            .await
            .map_err(|_| BiliError::Network)?,
    )
    .await?;
    Ok(AudiencePage {
        live_status,
        rank: Some(rank),
    })
}

/// The task is owned by the room session. Requests stay in memory; failures
/// neither reconnect the danmaku socket nor affect the speech scheduler.
pub(crate) async fn run_audience(
    http: Client,
    room_id: u64,
    updates: watch::Sender<AudienceSnapshot>,
    mut requests: mpsc::Receiver<bool>,
    cancel: CancellationToken,
) {
    let mut page = 1;
    loop {
        if cancel.is_cancelled() {
            break;
        }
        updates.send_modify(|state| state.loading = true);
        let result = tokio::select! {
            _ = cancel.cancelled() => break,
            result = fetch_page(&http, room_id, page) => result,
        };
        updates.send_modify(|state| {
            let result = result.and_then(|response| {
                state.apply_room_page(page, response, crate::bilibili::now_ms())
            });
            if let Err(error) = result {
                state.error = Some(error.to_string());
            }
            state.loading = false;
        });
        // Manual refreshes are coalesced while fetching. Rate-limit repeated
        // clicks as well as automatic polling, and cancel even during cooldown.
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
        }
        page = tokio::select! {
            _ = cancel.cancelled() => break,
            request = requests.recv() => {
                let Some(mut more) = request else { break; };
                while let Ok(next) = requests.try_recv() { more &= next; }
                let state = updates.borrow();
                if more && state.has_more { state.page + 1 } else { 1 }
            },
            _ = tokio::time::sleep(Duration::from_secs(28)) => 1,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_keep_caps_and_watched_is_separate_from_popularity() {
        let mut state = AudienceSnapshot::default();
        state.apply_page(1, &json!({"code":0,"data":{"onlineNum":9999,"onlineNumText":"9999+","OnlineRankItem":[]}}), 5).unwrap();
        state.apply_packet(&json!({"cmd":"WATCHED_CHANGE","data":{"num":12500}}));
        state.apply_packet(&json!({"cmd":"ONLINE_RANK_COUNT","data":{"count":42}}));
        state.apply_packet(&json!({"cmd":"WATCHED_CHANGE","data":{"num":-1}}));
        assert_eq!(state.rank_count_text.as_deref(), Some("9999+"));
        assert_eq!(state.rank_count, Some(9999));
        assert_eq!(state.watched_count, Some(12500));
    }

    #[test]
    fn unbroadcast_rooms_clear_rank_data_while_socket_session_can_remain_active() {
        let mut state = AudienceSnapshot {
            active: true,
            ..AudienceSnapshot::default()
        };
        state.apply_room_page(1, AudiencePage { live_status: 1, rank: Some(json!({"code":0,"data":{"onlineNum":1,"OnlineRankItem":[{"uid":42,"name":"Viewer"}]}})) }, 1).unwrap();
        assert_eq!(state.users.len(), 1);
        state.has_more = true;
        for status in [0, 2] {
            state
                .apply_room_page(
                    2,
                    AudiencePage {
                        live_status: status,
                        rank: None,
                    },
                    2,
                )
                .unwrap();
            assert!(state.active);
            assert_eq!(state.live_status, Some(status));
            assert_eq!(state.rank_count_text.as_deref(), Some("0"));
            assert!(state.users.is_empty());
            assert!(!state.has_more);
        }
        assert!(room_live_status(&json!({"data":{}})).is_err());
        assert!(room_live_status(&json!({"data":{"live_status":99}})).is_err());
        assert_eq!(room_live_status(&json!({"data":{"live_status":1}})), Ok(1));
    }

    #[test]
    fn pages_deduplicate_and_failures_preserve_previous_data() {
        let mut state = AudienceSnapshot::default();
        let user = json!({"uid":42,"name":"Viewer","userRank":1,"score":50,"face":"https://evil.example/bfs/a.png","uinfo":{"medal":{"name":"粉丝牌","level":9},"guard":{"level":3}}});
        let page = json!({"code":0,"data":{"onlineNum":90,"OnlineRankItem":vec![user.clone();50]}});
        state.apply_page(1, &page, 5).unwrap();
        state.apply_page(2, &page, 6).unwrap();
        assert_eq!(state.users.len(), 1);
        assert!(state.has_more);
        assert_eq!(state.users[0].medal_name.as_deref(), Some("粉丝牌"));
        assert_eq!(state.users[0].guard_level, Some(3));
        assert_eq!(state.users[0].avatar_url, None);
        let prior = state.clone();
        assert!(state.apply_page(1, &json!({"code":-352}), 7).is_err());
        assert_eq!(state, prior);
        assert!(
            state
                .apply_page(1, &json!({"code":0,"data":{"onlineNum":1}}), 7)
                .is_err()
        );
        assert_eq!(state, prior);
        state.apply_page(20, &page, 8).unwrap();
        assert!(state.limit_reached);
        assert!(!state.has_more);
    }

    #[test]
    fn mystery_id_is_never_exposed_and_invalid_names_are_skipped() {
        let user = parse_user(&json!({"uid":42,"name":"神秘人","is_mystery":1})).unwrap();
        assert_eq!(user.user_id, None);
        assert!(user.mystery);
        assert!(parse_user(&json!({"uid":42,"name":"bad\nname"})).is_none());
    }

    #[tokio::test]
    async fn cancellation_stops_pending_fetch_without_contacting_a_room() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (updates, _) = watch::channel(AudienceSnapshot::default());
        let (_requests, receiver) = mpsc::channel(1);
        tokio::time::timeout(
            Duration::from_secs(1),
            run_audience(
                crate::bilibili::http_client().unwrap(),
                0,
                updates,
                receiver,
                cancel,
            ),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    #[ignore = "Requires Bilibili public network and DANMAKUVOICE_TEST_AUDIENCE_ROOM"]
    async fn public_audience_endpoint_acceptance() {
        let room = std::env::var("DANMAKUVOICE_TEST_AUDIENCE_ROOM")
            .unwrap()
            .parse()
            .unwrap();
        let value = fetch_page(&crate::bilibili::http_client().unwrap(), room, 1)
            .await
            .unwrap();
        let mut state = AudienceSnapshot::default();
        state.apply_room_page(1, value, 1).unwrap();
        assert!(
            !state.users.is_empty(),
            "Choose a public room with rank participants"
        );
        assert!(state.rank_count.is_some());
        // Only aggregate evidence is printed, never viewer names or UIDs.
        println!(
            "public audience request: count={}, parsed_users={}, has_more={}",
            state.rank_count_text.unwrap(),
            state.users.len(),
            state.has_more
        );
    }
}
