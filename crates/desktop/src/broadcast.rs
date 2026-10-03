//! Desktop broadcast state. Polling contains no RTMP credentials; only explicit
//! user reveal/copy commands return them. Nothing is written to the data store.
use super::{Application, confirmed, display, qr_url_png};
use danmakuvoice_engine::{
    bilibili::{BiliError, BiliSession},
    broadcast::{BroadcastClient, BroadcastRoom, LiveArea, PushCredentials, StartBroadcast},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Default)]
pub(super) struct BroadcastState {
    pub(super) room: Option<BroadcastRoom>,
    areas: Vec<LiveArea>,
    credentials: Option<PushCredentials>,
    face_image: Option<Zeroizing<String>>,
    busy: bool,
    epoch: u64,
    cancel: CancellationToken,
}

impl BroadcastState {
    pub(super) fn view(&self) -> Value {
        json!({"room":self.room, "areas":self.areas, "busy":self.busy,
            "has_stream_key":self.credentials.is_some(),
            "face_image":self.face_image.as_deref().map(|s| s.as_str())})
    }

    pub(super) fn invalidate(&mut self) {
        self.cancel.cancel();
        *self = Self {
            epoch: self.epoch.wrapping_add(1),
            ..Self::default()
        };
    }
}

struct BroadcastGuard(Application, u64);

impl Drop for BroadcastGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock()
            && state.broadcast.epoch == self.1
        {
            state.broadcast.busy = false;
        }
    }
}

enum Operation {
    Refreshed(BroadcastRoom, Vec<LiveArea>),
    Updated(BroadcastRoom),
    Started(BroadcastRoom, StartBroadcast),
    Stopped(BroadcastRoom),
}

impl Application {
    pub fn own_broadcast_page(&self) -> Result<String, String> {
        self.require_network()?;
        let state = self.lock()?;
        if state.bili_user_id.is_none() {
            return Err("请先扫码登录哔哩哔哩，再管理自己的直播间 [DV-B10]".into());
        }
        let room = state
            .broadcast
            .room
            .as_ref()
            .ok_or("请先加载自己的开播信息 [DV-B10]")?;
        Ok(format!("https://live.bilibili.com/{}", room.room_id))
    }

    pub(super) async fn broadcast_command(
        &self,
        action: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        if !matches!(
            action,
            "bili.broadcast.refresh"
                | "bili.broadcast.update"
                | "bili.broadcast.start"
                | "bili.broadcast.stop"
                | "bili.broadcast.credentials"
                | "bili.broadcast.forget"
        ) {
            return Err("不支持的开播管理操作 [DV-B10]".into());
        }
        if action == "bili.broadcast.forget" {
            let mut state = self.lock()?;
            let room = state.broadcast.room.take();
            let areas = std::mem::take(&mut state.broadcast.areas);
            state.broadcast.invalidate();
            state.broadcast.room = room;
            state.broadcast.areas = areas;
            return Ok(Value::Null);
        }
        if matches!(
            action,
            "bili.broadcast.start"
                | "bili.broadcast.stop"
                | "bili.broadcast.update"
                | "bili.broadcast.credentials"
        ) {
            confirmed(payload)?;
        }
        if action == "bili.broadcast.credentials" {
            let state = self.lock()?;
            if state.broadcast.busy {
                return Err("开播管理正在处理请求，请稍候 [DV-B10]".into());
            }
            return state
                .broadcast
                .credentials
                .as_ref()
                .map(|credentials| json!(credentials))
                .ok_or_else(|| "当前没有推流信息，请点击开播获取 [DV-B10]".into());
        }
        self.require_network()?;
        let (session, epoch, cancel) = {
            let mut state = self.lock()?;
            if state.broadcast.busy {
                return Err("开播管理正在处理请求，请稍候 [DV-B10]".into());
            }
            let session = state
                .store
                .load_bili_session()
                .map_err(display)?
                .ok_or("请先扫码登录哔哩哔哩，再管理自己的直播间 [DV-B10]")?;
            if action == "bili.broadcast.start" {
                state.broadcast.credentials = None;
                state.broadcast.face_image = None;
            }
            state.broadcast.busy = true;
            (
                session,
                state.broadcast.epoch,
                state.broadcast.cancel.clone(),
            )
        };
        let _guard = BroadcastGuard(self.clone(), epoch);
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("账号已变更，开播管理请求已取消；请刷新房间状态 [DV-B10]".into()),
            result = perform(action, payload, &session) => result,
        };
        let mut state = self.lock()?;
        if state.broadcast.epoch != epoch || state.bili_user_id != Some(session.user_id()) {
            return Err("账号已变更，请重新加载自己的直播间 [DV-B10]".into());
        }
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if matches!(error, BiliError::SessionExpired) {
                    state.broadcast.invalidate();
                }
                return Err(display(error));
            }
        };
        match result {
            Operation::Refreshed(room, areas) => {
                if room.live_status != 1 {
                    state.broadcast.credentials = None;
                }
                state.broadcast.room = Some(room);
                state.broadcast.areas = areas;
            }
            Operation::Updated(mut room) => {
                if let Some(parent) = state
                    .broadcast
                    .areas
                    .iter()
                    .find(|p| p.children.iter().any(|c| c.id == room.area_id))
                {
                    room.parent_area_id = parent.id;
                }
                state.broadcast.room = Some(room);
            }
            Operation::Started(room, result) => {
                state.broadcast.room = Some(room);
                match result {
                    StartBroadcast::Started(credentials) => {
                        state.broadcast.credentials = Some(credentials);
                        state.broadcast.face_image = None;
                    }
                    StartBroadcast::FaceVerification(url) => {
                        state.broadcast.face_image = Some(Zeroizing::new(qr_url_png(&url)?));
                    }
                }
            }
            Operation::Stopped(room) => {
                state.broadcast.room = Some(room);
                state.broadcast.credentials = None;
                state.broadcast.face_image = None;
            }
        }
        Ok(Value::Null)
    }
}

async fn perform(
    action: &str,
    payload: &Value,
    session: &BiliSession,
) -> Result<Operation, BiliError> {
    let client = BroadcastClient::new()?;
    match action {
        "bili.broadcast.refresh" => {
            let room = client.own_room(session).await?;
            Ok(Operation::Refreshed(room, client.areas().await?))
        }
        "bili.broadcast.update" => {
            let title = payload["title"]
                .as_str()
                .ok_or(BiliError::Protocol("请填写直播标题"))?;
            let area = payload["area_id"]
                .as_u64()
                .ok_or(BiliError::Protocol("请选择直播子分区"))?;
            Ok(Operation::Updated(
                client.update(session, title, area).await?,
            ))
        }
        "bili.broadcast.start" => {
            let area = payload["area_id"]
                .as_u64()
                .ok_or(BiliError::Protocol("请选择直播子分区"))?;
            let (room, result) = client.start(session, area).await?;
            Ok(Operation::Started(room, result))
        }
        "bili.broadcast.stop" => Ok(Operation::Stopped(client.stop(session).await?)),
        _ => unreachable!("validated action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(network_disabled: bool) -> (tempfile::TempDir, Application) {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_path_buf(), network_disabled).unwrap();
        (directory, app)
    }

    fn add_credentials(app: &Application) {
        let session = BiliSession::from_secret_payload(
            br#"{"user_id":42,"sessdata":"fictional-session","bili_jct":"fictional-csrf"}"#,
        )
        .unwrap();
        let mut state = app.lock().unwrap();
        state.store.save_bili_session(&session).unwrap();
        state.bili_user_id = Some(42);
        state.broadcast.room = Some(BroadcastRoom {
            room_id: 123,
            title: "fictional room".into(),
            parent_area_id: 2,
            area_id: 86,
            live_status: 1,
            live_since: Some(1_791_028_805),
        });
        state.broadcast.credentials = Some(PushCredentials {
            address: "rtmp://live-push.bilivideo.com/live/".into(),
            stream_key: "fictional-private-stream-key".into(),
        });
    }

    #[tokio::test]
    async fn snapshots_exports_and_disk_exclude_stream_credentials() {
        let (directory, app) = isolated(true);
        add_credentials(&app);
        let snapshot = app.snapshot().unwrap();
        assert!(snapshot["broadcast"]["has_stream_key"].as_bool().unwrap());
        assert!(
            !snapshot
                .to_string()
                .contains("fictional-private-stream-key")
        );
        let revealed = app
            .dispatch("bili.broadcast.credentials", json!({"confirmed":true}))
            .await
            .unwrap();
        assert_eq!(
            revealed["result"]["stream_key"],
            "fictional-private-stream-key"
        );
        assert!(
            !app.snapshot()
                .unwrap()
                .to_string()
                .contains("fictional-private-stream-key")
        );
        assert!(
            app.dispatch("bili.broadcast.credentials", json!({}))
                .await
                .is_err()
        );
        let exported =
            serde_json::to_string(&app.lock().unwrap().store.export_configuration().unwrap())
                .unwrap();
        assert!(!exported.contains("fictional-private-stream-key"));
        app.dispatch("bili.broadcast.forget", json!({}))
            .await
            .unwrap();
        assert!(
            app.dispatch("bili.broadcast.credentials", json!({"confirmed":true}))
                .await
                .is_err()
        );
        drop(app);
        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_file() {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert!(
                    !bytes
                        .windows(b"fictional-private-stream-key".len())
                        .any(|w| w == b"fictional-private-stream-key")
                );
            }
        }
        let reopened = Application::new(directory.path().to_path_buf(), true).unwrap();
        assert_eq!(
            reopened.snapshot().unwrap()["broadcast"]["has_stream_key"],
            false
        );
    }

    #[tokio::test]
    async fn offline_missing_login_confirmation_and_busy_block_requests() {
        let (_directory, offline) = isolated(true);
        for action in ["refresh", "update", "start", "stop"] {
            let error = offline
                .dispatch(
                    &format!("bili.broadcast.{action}"),
                    json!({"confirmed":true}),
                )
                .await
                .unwrap_err();
            assert!(error.contains("离线测试窗口"), "{error}");
        }
        let (_directory, app) = isolated(false);
        assert!(
            app.dispatch("bili.broadcast.refresh", json!({}))
                .await
                .unwrap_err()
                .contains("请先扫码登录")
        );
        assert!(
            app.dispatch("bili.broadcast.start", json!({}))
                .await
                .is_err()
        );
        assert!(
            app.dispatch("bili.broadcast.unknown", json!({}))
                .await
                .is_err()
        );
        add_credentials(&app);
        app.lock().unwrap().broadcast.busy = true;
        assert!(
            app.dispatch("bili.broadcast.start", json!({"confirmed":true}))
                .await
                .unwrap_err()
                .contains("正在处理请求")
        );
    }

    #[tokio::test]
    async fn logout_cancels_pending_management_and_discards_credentials() {
        let (_directory, app) = isolated(true);
        add_credentials(&app);
        let cancel = app.lock().unwrap().broadcast.cancel.clone();
        let old_epoch = app.lock().unwrap().broadcast.epoch;
        let guard = BroadcastGuard(app.clone(), old_epoch);
        app.dispatch("bili.logout", json!({"confirmed":true}))
            .await
            .unwrap();
        assert!(cancel.is_cancelled());
        assert!(app.lock().unwrap().broadcast.epoch != old_epoch);
        // A late old request must not release a newer request's busy flag.
        app.lock().unwrap().broadcast.busy = true;
        drop(guard);
        assert!(app.lock().unwrap().broadcast.busy);
        assert_eq!(
            app.snapshot().unwrap()["broadcast"]["has_stream_key"],
            false
        );
    }

    #[test]
    fn own_room_page_is_derived_from_management_state_without_secrets_or_watched_target() {
        let (_directory, app) = isolated(false);
        assert!(app.own_broadcast_page().is_err());
        add_credentials(&app);
        assert_eq!(
            app.own_broadcast_page().unwrap(),
            "https://live.bilibili.com/123"
        );
    }
}
