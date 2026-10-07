//! Transient moderation context: freeze the room and viewer at confirmation,
//! cancel on account changes, and never persist moderation credentials/state.
use super::{Application, Controller, confirmed, display};
use danmakuvoice_engine::{
    bilibili::{BiliError, BiliSession},
    moderation::{ModerationClient, ModerationView, validate_hours, validate_target},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct ModerationState {
    view: Option<ModerationView>,
    message: Option<String>,
    watched_room: Option<u64>,
    target_uid: Option<u64>,
    busy: bool,
    epoch: u64,
    cancel: CancellationToken,
}

impl ModerationState {
    pub(super) fn view(&self) -> Value {
        let mut view = self.view.as_ref().map_or_else(|| json!({
            "user_id":self.target_uid.map(|uid| uid.to_string()),
            "room_id":null,"can_moderate":false,"can_blacklist":false,"can_manage_admins":false,"is_admin":null,"muted":null,
            "blacklisted":null,"message":null,
        }), |view| json!(view));
        view["busy"] = json!(self.busy);
        if let Some(message) = &self.message {
            view["message"] = json!(message);
        }
        view
    }

    pub(super) fn invalidate(&mut self) {
        self.cancel.cancel();
        *self = Self {
            epoch: self.epoch.wrapping_add(1),
            ..Self::default()
        };
    }
}

struct ModerationGuard(Application, u64);

impl Drop for ModerationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock()
            && state.moderation.epoch == self.1
        {
            state.moderation.busy = false;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Refresh,
    Mute(i64),
    Unmute,
    Blacklist(bool),
    Admin(bool),
}

impl Action {
    fn parse(action: &str, payload: &Value) -> Result<Self, String> {
        let action = match action {
            "bili.moderation.refresh" => Self::Refresh,
            "bili.moderation.mute" => {
                let hours = payload["hours"].as_i64().ok_or("请选择禁言时长")?;
                validate_hours(hours).map_err(display)?;
                Self::Mute(hours)
            }
            "bili.moderation.unmute" => Self::Unmute,
            "bili.moderation.blacklist" => Self::Blacklist(true),
            "bili.moderation.unblacklist" => Self::Blacklist(false),
            "bili.moderation.appoint" => Self::Admin(true),
            "bili.moderation.dismiss" => Self::Admin(false),
            _ => return Err("不支持的直播间用户管理操作".into()),
        };
        if action != Self::Refresh {
            confirmed(payload)?;
        }
        Ok(action)
    }
}

struct Operation {
    session: BiliSession,
    watched_room: u64,
    expected_room: Option<u64>,
    target_uid: u64,
    epoch: u64,
    account_epoch: u64,
    cancel: CancellationToken,
}

impl Application {
    pub(super) async fn moderation_command(
        &self,
        action_name: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let epoch = {
            let state = self.lock()?;
            if !state.prefs.broadcast_console {
                return Err("请先启用实验性 OBS 开播台，再管理直播间用户".into());
            }
            state.moderation.epoch
        };
        let result = self.moderation_command_inner(action_name, payload).await;
        if action_name == "bili.moderation.refresh"
            && let Err(message) = &result
            && let Ok(target) = target_uid(payload)
            && let Ok(mut state) = self.lock()
            && !state.moderation.busy
            && state.moderation.epoch == epoch
        {
            if state.moderation.target_uid != Some(target) {
                state.moderation.view = None;
            }
            state.moderation.target_uid = Some(target);
            state.moderation.message = Some(message.clone());
        }
        result
    }

    async fn moderation_command_inner(
        &self,
        action_name: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let action = Action::parse(action_name, payload)?;
        let target_uid = target_uid(payload)?;
        self.require_network()?;
        let operation = {
            let mut state = self.lock()?;
            if !state.prefs.broadcast_console {
                return Err("请先启用实验性 OBS 开播台，再管理直播间用户".into());
            }
            if state.moderation.busy {
                return Err("直播间用户管理正在处理请求，请稍候".into());
            }
            let session = state
                .store
                .load_bili_session()
                .map_err(display)?
                .ok_or("请先扫码登录哔哩哔哩，再管理直播间用户")?;
            if state.bili_user_id != Some(session.user_id()) {
                return Err("登录身份与当前账号不匹配，请重新扫码".into());
            }
            validate_target(target_uid, session.user_id()).map_err(display)?;
            let watched_room = watched_room(&state)?;
            let expected_room = if action == Action::Refresh {
                None
            } else {
                let expected_room =
                    numeric_id(&payload["room_id"]).ok_or("直播间已变更，请重新打开用户资料")?;
                let view = state
                    .moderation
                    .view
                    .as_ref()
                    .filter(|view| {
                        view.user_id == target_uid
                            && view.room_id == expected_room
                            && state.moderation.watched_room == Some(watched_room)
                    })
                    .ok_or("用户或直播间已变更，请重新打开用户资料")?;
                if matches!(action, Action::Mute(_) | Action::Unmute) && !view.can_moderate {
                    return Err("当前登录账号不是这个直播间的主播或房管".into());
                }
                if matches!(action, Action::Blacklist(_)) && !view.can_blacklist {
                    return Err("当前账号没有这个直播间的拉黑权限".into());
                }
                if matches!(action, Action::Admin(_)) && !view.can_manage_admins {
                    return Err("只有这个直播间的主播可以设置或撤销房管".into());
                }
                Some(expected_room)
            };
            if action == Action::Refresh {
                state.moderation.view = None;
                state.moderation.target_uid = Some(target_uid);
                state.moderation.watched_room = Some(watched_room);
            }
            state.moderation.message = None;
            state.moderation.busy = true;
            Operation {
                session,
                watched_room,
                expected_room,
                target_uid,
                epoch: state.moderation.epoch,
                account_epoch: state.bili_profile_epoch,
                cancel: state.moderation.cancel.clone(),
            }
        };
        let _guard = ModerationGuard(self.clone(), operation.epoch);
        let result = tokio::select! {
            biased;
            _ = operation.cancel.cancelled() => return Err("账号或直播间已变更，用户管理请求已取消；请重新打开用户资料".into()),
            result = tokio::time::timeout(std::time::Duration::from_secs(30), perform(action, &operation)) =>
                result.unwrap_or(Err(BiliError::Protocol("直播间用户管理请求超时，请刷新资料核对操作结果"))),
        };
        self.complete_moderation(action, &operation, result)
    }

    fn complete_moderation(
        &self,
        action: Action,
        operation: &Operation,
        result: Result<Option<ModerationView>, BiliError>,
    ) -> Result<Value, String> {
        let mut state = self.lock()?;
        if state.moderation.epoch != operation.epoch
            || state.bili_profile_epoch != operation.account_epoch
            || state.bili_user_id != Some(operation.session.user_id())
            || watched_room(&state).ok() != Some(operation.watched_room)
            || !state.prefs.broadcast_console
        {
            return Err("账号或直播间已变更；请重新打开用户资料并核对操作结果".into());
        }
        match result {
            Err(error) => {
                let message = display(error);
                state.moderation.view = None;
                if error == BiliError::SessionExpired {
                    state.moderation.invalidate();
                }
                state.moderation.target_uid = Some(operation.target_uid);
                state.moderation.message = Some(message.clone());
                Err(message)
            }
            Ok(Some(view)) => {
                state.moderation.view = Some(view);
                state.moderation.busy = false;
                Ok(state.moderation.view())
            }
            Ok(None) => {
                let view = state
                    .moderation
                    .view
                    .as_mut()
                    .ok_or("用户管理信息已过期，请重新打开用户资料")?;
                // Only a successful platform response changes a known state.
                // Do not retry writes after an unrelated follow-up read fails.
                match action {
                    Action::Mute(_) => view.muted = Some(true),
                    Action::Unmute => view.muted = Some(false),
                    Action::Blacklist(blocked) => view.blacklisted = Some(blocked),
                    Action::Admin(appointed) => view.is_admin = Some(appointed),
                    Action::Refresh => return Err("用户管理响应无效".into()),
                }
                state.moderation.busy = false;
                Ok(state.moderation.view())
            }
        }
    }
}

fn watched_room(state: &Controller) -> Result<u64, String> {
    state
        .live
        .as_ref()
        .and_then(|live| live.snapshot().room_id)
        .or(state.store.load_live_settings().map_err(display)?.room_id)
        .filter(|room| *room > 0)
        .ok_or_else(|| "请先选择要管理的直播间".into())
}

fn numeric_id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| {
            let text = value.as_str()?;
            (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| text.parse().ok())
                .flatten()
        })
        .filter(|uid| *uid > 0)
}

fn target_uid(payload: &Value) -> Result<u64, String> {
    numeric_id(&payload["user_id"])
        .ok_or_else(|| "这个用户没有可用的真实 UID，无法执行禁言或拉黑".into())
}

async fn perform(
    action: Action,
    operation: &Operation,
) -> Result<Option<ModerationView>, BiliError> {
    let client = ModerationClient::new()?;
    let session = &operation.session;
    let room = operation.watched_room;
    let target = operation.target_uid;
    if action == Action::Refresh {
        return client.inspect(session, room, target).await.map(Some);
    }
    let expected = operation.expected_room.ok_or(BiliError::InvalidRoom)?;
    match action {
        Action::Mute(hours) => client.mute(session, room, expected, target, hours).await?,
        Action::Unmute => client.unmute(session, room, expected, target).await?,
        Action::Blacklist(blocked) => {
            client
                .blacklist(session, room, expected, target, blocked)
                .await?
        }
        Action::Admin(appointed) => {
            client
                .set_admin(session, room, expected, target, appointed)
                .await?
        }
        Action::Refresh => unreachable!(),
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> BiliSession {
        BiliSession::from_secret_payload(
            br#"{"user_id":42,"sessdata":"fictional-session","bili_jct":"fictional-csrf"}"#,
        )
        .unwrap()
    }

    fn isolated(network_disabled: bool) -> (tempfile::TempDir, Application) {
        let directory = tempfile::tempdir().unwrap();
        let app = Application::new(directory.path().to_owned(), network_disabled).unwrap();
        (directory, app)
    }

    fn view() -> ModerationView {
        ModerationView {
            user_id: 77,
            room_id: 123,
            can_moderate: true,
            can_blacklist: true,
            can_manage_admins: true,
            is_admin: Some(false),
            muted: Some(false),
            blacklisted: Some(false),
            message: None,
        }
    }

    fn prepare(app: &Application) -> Operation {
        let mut state = app.lock().unwrap();
        state.prefs.broadcast_console = true;
        let session = session();
        state.store.save_bili_session(&session).unwrap();
        state.bili_user_id = Some(42);
        let mut settings = state.store.load_live_settings().unwrap();
        settings.room_id = Some(1);
        state.store.save_live_settings(&settings).unwrap();
        state.moderation.target_uid = Some(77);
        state.moderation.watched_room = Some(1);
        state.moderation.view = Some(view());
        Operation {
            session,
            watched_room: 1,
            expected_room: Some(123),
            target_uid: 77,
            epoch: state.moderation.epoch,
            account_epoch: state.bili_profile_epoch,
            cancel: state.moderation.cancel.clone(),
        }
    }

    #[test]
    fn moderation_payload_preserves_uid_and_requires_confirmation() {
        assert_eq!(
            target_uid(&json!({"user_id":"9007199254740993"})).unwrap(),
            9_007_199_254_740_993
        );
        for value in [
            json!("anonymous-77"),
            json!("77.0"),
            json!("-77"),
            json!(0),
            Value::Null,
        ] {
            assert!(target_uid(&json!({"user_id":value})).is_err());
        }
        for action in [
            "mute",
            "unmute",
            "blacklist",
            "unblacklist",
            "appoint",
            "dismiss",
        ] {
            assert!(
                Action::parse(&format!("bili.moderation.{action}"), &json!({"hours":24})).is_err()
            );
            assert!(
                Action::parse(
                    &format!("bili.moderation.{action}"),
                    &json!({"hours":24,"confirmed":true})
                )
                .is_ok()
            );
        }
        assert!(
            Action::parse(
                "bili.moderation.mute",
                &json!({"hours":721,"confirmed":true})
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn moderation_preflight_rejects_offline_missing_login_busy_and_stale_room() {
        let (_directory, offline) = isolated(true);
        offline.lock().unwrap().prefs.broadcast_console = true;
        let result = offline
            .moderation_command("bili.moderation.refresh", &json!({"user_id":"77"}))
            .await;
        assert!(result.unwrap_err().contains("离线"));
        assert!(
            offline.lock().unwrap().moderation.view()["message"]
                .as_str()
                .unwrap()
                .contains("离线")
        );
        let (_directory, app) = isolated(false);
        assert!(
            app.moderation_command("bili.moderation.refresh", &json!({"user_id":"77"}))
                .await
                .unwrap_err()
                .contains("OBS 开播台")
        );
        app.lock().unwrap().prefs.broadcast_console = true;
        assert!(
            app.moderation_command("bili.moderation.refresh", &json!({"user_id":"77"}))
                .await
                .unwrap_err()
                .contains("登录")
        );
        let operation = prepare(&app);
        app.lock().unwrap().moderation.busy = true;
        assert!(
            app.moderation_command("bili.moderation.refresh", &json!({"user_id":"88"}))
                .await
                .unwrap_err()
                .contains("稍候")
        );
        assert_eq!(app.lock().unwrap().moderation.target_uid, Some(77));
        app.lock().unwrap().moderation.busy = false;
        let mut settings = app.lock().unwrap().store.load_live_settings().unwrap();
        settings.room_id = Some(2);
        app.lock()
            .unwrap()
            .store
            .save_live_settings(&settings)
            .unwrap();
        assert!(
            app.moderation_command(
                "bili.moderation.mute",
                &json!({"user_id":"77","room_id":123,"hours":24,"confirmed":true})
            )
            .await
            .unwrap_err()
            .contains("变更")
        );
        assert!(
            app.complete_moderation(Action::Mute(24), &operation, Ok(None))
                .unwrap_err()
                .contains("变更")
        );
        assert_eq!(app.lock().unwrap().moderation.view()["muted"], false);
    }

    #[test]
    fn moderation_account_change_and_invalidation_never_commit_old_results() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        app.lock().unwrap().bili_profile_epoch += 1;
        assert!(
            app.complete_moderation(Action::Blacklist(true), &operation, Ok(None))
                .is_err()
        );
        let operation = prepare(&app);
        app.lock().unwrap().prefs.broadcast_console = false;
        assert!(
            app.complete_moderation(Action::Mute(24), &operation, Ok(None))
                .is_err()
        );
        assert_eq!(app.lock().unwrap().moderation.view()["muted"], false);
        assert_eq!(app.lock().unwrap().moderation.view()["blacklisted"], false);
        app.lock().unwrap().moderation.invalidate();
        assert!(operation.cancel.is_cancelled());
        let after = app.lock().unwrap().moderation.view();
        assert!(!after["can_moderate"].as_bool().unwrap());
        assert!(after["muted"].is_null());
        assert!(after["is_admin"].is_null());
        assert!(
            app.complete_moderation(Action::Refresh, &operation, Ok(Some(view())))
                .is_err()
        );
    }

    #[test]
    fn moderation_success_changes_only_platform_confirmed_field_and_error_hides_permissions() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        let muted = app
            .complete_moderation(Action::Mute(24), &operation, Ok(None))
            .unwrap();
        assert_eq!(muted["muted"], true);
        assert_eq!(muted["blacklisted"], false);
        assert_eq!(muted["is_admin"], false);
        let appointed = app
            .complete_moderation(Action::Admin(true), &operation, Ok(None))
            .unwrap();
        assert_eq!(appointed["is_admin"], true);
        assert!(
            app.complete_moderation(Action::Unmute, &operation, Err(BiliError::Api(403)))
                .is_err()
        );
        let after = app.lock().unwrap().moderation.view();
        assert!(!after["can_moderate"].as_bool().unwrap());
        assert!(after["muted"].is_null());
        assert!(after["message"].as_str().unwrap().contains("403"));
    }
}
