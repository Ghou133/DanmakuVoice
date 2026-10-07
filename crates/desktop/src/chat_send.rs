//! Transient authenticated chat sending to the current account's own room.
//! Accepted sends are shown only by the actual receive feed, never inserted here.
use super::{Application, confirmed, display};
use danmakuvoice_engine::{
    bilibili::{BiliError, BiliSession},
    chat_send::{ChatSendClient, ChatSendView, validate_message},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct ChatSendState {
    view: Option<ChatSendView>,
    account_id: Option<u64>,
    error: Option<String>,
    busy: bool,
    epoch: u64,
    cancel: CancellationToken,
}

impl ChatSendState {
    pub(super) fn received_emoticons(
        &self,
        account_id: u64,
        room_id: u64,
    ) -> Option<&ChatSendView> {
        self.view.as_ref().filter(|view| {
            self.account_id == Some(account_id)
                && view.room_id == room_id
                && view.account_error.is_none()
        })
    }

    pub(super) fn view(&self) -> Value {
        let mut view = self.view.as_ref().map_or_else(
            || {
                json!({
                    "room_id":null,"message_limit":20,"emoticons":[],"warnings":[],
                })
            },
            |view| json!(view),
        );
        view["busy"] = json!(self.busy);
        view["error"] = json!(self.error);
        view["account_id"] = json!(self.account_id);
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

struct ChatSendGuard(Application, u64);
impl Drop for ChatSendGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock()
            && state.chat_send.epoch == self.1
        {
            state.chat_send.busy = false;
        }
    }
}

enum Action<'a> {
    Refresh,
    Text(&'a str),
    Emoticon(&'a str),
}
impl<'a> Action<'a> {
    fn parse(action: &str, payload: &'a Value) -> Result<Self, String> {
        match action {
            "bili.chat.emoticons.refresh" => Ok(Self::Refresh),
            "bili.chat.send" => {
                confirmed(payload)?;
                let message = payload["message"].as_str().ok_or("请输入要发送的弹幕")?;
                validate_message(message, 1000).map_err(display)?;
                Ok(Self::Text(message))
            }
            "bili.chat.emoticon.send" => {
                confirmed(payload)?;
                let token = payload["emoticon_unique"]
                    .as_str()
                    .filter(|token| !token.is_empty())
                    .ok_or("请选择要发送的表情")?;
                Ok(Self::Emoticon(token))
            }
            _ => Err("不支持的弹幕发送操作".into()),
        }
    }
}

struct Operation {
    session: BiliSession,
    epoch: u64,
    account_epoch: u64,
    cancel: CancellationToken,
}
enum Outcome {
    Refreshed(ChatSendView),
    Sent(u64),
}

fn cached_emoticon_allowed(view: Option<&ChatSendView>, identity: &str) -> bool {
    view.is_some_and(|view| {
        view.emoticons
            .iter()
            .flat_map(|pack| &pack.emoticons)
            .any(|item| {
                item.emoticon_unique == identity
                    && item.allowed
                    && (item.kind == "emoticon"
                        || (item.kind == "text"
                            && item.text.as_ref().is_some_and(|text| !text.is_empty())))
            })
    })
}

impl Application {
    pub(super) async fn chat_send_command(
        &self,
        action_name: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let epoch = {
            let state = self.lock()?;
            state.chat_send.epoch
        };
        let result = self.chat_send_command_inner(action_name, payload).await;
        if let Err(message) = &result
            && let Ok(mut state) = self.lock()
            && state.chat_send.epoch == epoch
            && !state.chat_send.busy
        {
            state.chat_send.error = Some(message.clone());
        }
        result
    }

    async fn chat_send_command_inner(
        &self,
        action_name: &str,
        payload: &Value,
    ) -> Result<Value, String> {
        let action = Action::parse(action_name, payload)?;
        self.require_network()?;
        let operation = {
            let mut state = self.lock()?;
            if state.chat_send.busy {
                return Err("弹幕发送正在处理请求，请稍候".into());
            }
            let session = state
                .store
                .load_bili_session()
                .map_err(display)?
                .ok_or("请先扫码登录哔哩哔哩，再发送弹幕")?;
            if state.bili_user_id != Some(session.user_id()) {
                return Err("登录身份与当前账号不匹配，请重新扫码".into());
            }
            if state.chat_send.account_id != Some(session.user_id()) {
                state.chat_send.view = None;
            }
            state.chat_send.account_id = Some(session.user_id());
            if let Action::Emoticon(token) = &action
                && !cached_emoticon_allowed(state.chat_send.view.as_ref(), token)
            {
                return Err("这个表情当前不可用，请刷新表情列表".into());
            }
            state.chat_send.error = None;
            state.chat_send.busy = true;
            Operation {
                session,
                epoch: state.chat_send.epoch,
                account_epoch: state.bili_profile_epoch,
                cancel: state.chat_send.cancel.clone(),
            }
        };
        let _guard = ChatSendGuard(self.clone(), operation.epoch);
        let result = tokio::select! {
            biased;
            _ = operation.cancel.cancelled() => return Err("账号或网络设置已变更，弹幕请求已取消；请核对发送结果".into()),
            result = tokio::time::timeout(std::time::Duration::from_secs(30),perform(&action,&operation.session)) =>
                result.unwrap_or(Err(BiliError::Protocol("弹幕请求超时，请核对发送结果"))),
        };
        self.complete_chat_send(&operation, result)
    }

    fn complete_chat_send(
        &self,
        operation: &Operation,
        result: Result<Outcome, BiliError>,
    ) -> Result<Value, String> {
        let mut state = self.lock()?;
        if state.chat_send.epoch != operation.epoch
            || state.bili_profile_epoch != operation.account_epoch
            || state.bili_user_id != Some(operation.session.user_id())
        {
            return Err("账号或网络设置已变更；请核对发送结果".into());
        }
        match result {
            Err(error) => {
                let message = display(error);
                if error == BiliError::SessionExpired {
                    state.chat_send.invalidate();
                }
                state.chat_send.error = Some(message.clone());
                Err(message)
            }
            Ok(Outcome::Refreshed(view)) => {
                let account_id = operation.session.user_id();
                if let Some(live) = &state.live
                    && live.snapshot().canonical_room_id() == Some(view.room_id)
                {
                    if let Some(error) = &view.account_error {
                        live.set_received_emoticon_error(error.clone());
                    } else {
                        live.set_received_emoticons(account_id, view.room_id, &view.emoticons);
                    }
                }
                let catalog =
                    danmakuvoice_engine::received_emotes::ReceivedEmoteCatalog::from_packs(
                        account_id,
                        view.room_id,
                        &view.emoticons,
                    );
                for event in &mut state.carried_events {
                    catalog.enrich(event);
                }
                for event in &mut state.last_live.recent_events {
                    catalog.enrich(event);
                }
                state.chat_send.view = Some(view);
                state.chat_send.account_id = Some(operation.session.user_id());
                state.chat_send.busy = false;
                Ok(state.chat_send.view())
            }
            Ok(Outcome::Sent(room_id)) => {
                if let Some(view) = state.chat_send.view.as_mut() {
                    view.room_id = room_id;
                }
                state.chat_send.busy = false;
                Ok(json!({"room_id":room_id}))
            }
        }
    }
}

async fn perform(action: &Action<'_>, session: &BiliSession) -> Result<Outcome, BiliError> {
    let client = ChatSendClient::new()?;
    match action {
        Action::Refresh => client.refresh(session).await.map(Outcome::Refreshed),
        Action::Text(message) => client.send_text(session, message).await.map(Outcome::Sent),
        Action::Emoticon(token) => client
            .send_emoticon(session, token)
            .await
            .map(Outcome::Sent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmakuvoice_engine::chat_send::{ChatEmoticon, ChatEmoticonPack};

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

    fn view() -> ChatSendView {
        ChatSendView {
            room_id: 123,
            message_limit: 20,
            warnings: vec![],
            account_error: None,
            emoticons: vec![ChatEmoticonPack {
                source: "live",
                name: "平台表情".into(),
                pkg_type: Some(1),
                icon: Some("https://i0.hdslb.com/bfs/emote/official-cover.png".into()),
                emoticons: vec![ChatEmoticon {
                    emoticon_unique: "official_token".into(),
                    emoji: "测试".into(),
                    url: None,
                    allowed: true,
                    kind: "emoticon",
                    text: None,
                    description: None,
                }],
            }],
        }
    }

    fn prepare(app: &Application) -> Operation {
        let mut state = app.lock().unwrap();
        let session = session();
        state.store.save_bili_session(&session).unwrap();
        state.bili_user_id = Some(42);
        state.chat_send.view = Some(view());
        state.chat_send.account_id = Some(session.user_id());
        Operation {
            session,
            epoch: state.chat_send.epoch,
            account_epoch: state.bili_profile_epoch,
            cancel: state.chat_send.cancel.clone(),
        }
    }

    #[test]
    fn send_payloads_require_confirmation_and_explicit_content() {
        assert!(Action::parse("bili.chat.send", &json!({"message":"你好"})).is_err());
        assert!(
            Action::parse(
                "bili.chat.send",
                &json!({"message":"你好","confirmed":true})
            )
            .is_ok()
        );
        assert!(
            Action::parse("bili.chat.send", &json!({"message":"\n","confirmed":true})).is_err()
        );
        assert!(
            Action::parse(
                "bili.chat.emoticon.send",
                &json!({"emoticon_unique":"official_token"})
            )
            .is_err()
        );
        assert!(
            Action::parse(
                "bili.chat.emoticon.send",
                &json!({"emoticon_unique":"official_token","confirmed":true})
            )
            .is_ok()
        );
        assert!(Action::parse("bili.chat.emoticons.refresh", &json!({})).is_ok());
    }

    #[tokio::test]
    async fn console_flag_is_not_required_but_login_and_network_still_are() {
        let (_directory, app) = isolated(false);
        assert!(!app.lock().unwrap().prefs.broadcast_console);
        for (action, payload) in [
            ("bili.chat.emoticons.refresh", json!({})),
            ("bili.chat.send", json!({"message":"你好","confirmed":true})),
            (
                "bili.chat.emoticon.send",
                json!({"emoticon_unique":"account:77:88","confirmed":true}),
            ),
        ] {
            assert!(
                app.chat_send_command(action, &payload)
                    .await
                    .unwrap_err()
                    .contains("登录")
            );
        }
        assert!(
            app.lock().unwrap().chat_send.view()["error"]
                .as_str()
                .unwrap()
                .contains("登录")
        );
        let (_directory, offline) = isolated(true);
        prepare(&offline);
        assert!(!offline.lock().unwrap().prefs.broadcast_console);
        assert!(
            offline
                .chat_send_command("bili.chat.emoticons.refresh", &json!({}))
                .await
                .unwrap_err()
                .contains("离线")
        );
    }

    #[tokio::test]
    async fn busy_identity_mismatch_and_unavailable_emoticons_reject_preflight() {
        let (_directory, app) = isolated(false);
        prepare(&app);
        app.lock().unwrap().chat_send.busy = true;
        assert!(
            app.chat_send_command(
                "bili.chat.send",
                &json!({"message":"你好","confirmed":true})
            )
            .await
            .unwrap_err()
            .contains("稍候")
        );
        {
            let mut state = app.lock().unwrap();
            state.chat_send.busy = false;
            state.bili_user_id = Some(7);
        }
        assert!(
            app.chat_send_command(
                "bili.chat.send",
                &json!({"message":"你好","confirmed":true})
            )
            .await
            .unwrap_err()
            .contains("不匹配")
        );
        app.lock().unwrap().bili_user_id = Some(42);
        for token in ["missing", "official_token"] {
            if token == "official_token" {
                app.lock()
                    .unwrap()
                    .chat_send
                    .view
                    .as_mut()
                    .unwrap()
                    .emoticons[0]
                    .emoticons[0]
                    .allowed = false;
            }
            assert!(
                app.chat_send_command(
                    "bili.chat.emoticon.send",
                    &json!({"emoticon_unique":token,"confirmed":true})
                )
                .await
                .unwrap_err()
                .contains("刷新")
            );
        }
        {
            let mut state = app.lock().unwrap();
            let item = &mut state.chat_send.view.as_mut().unwrap().emoticons[0].emoticons[0];
            item.allowed = true;
            item.kind = "text";
        }
        assert!(
            app.chat_send_command(
                "bili.chat.emoticon.send",
                &json!({"emoticon_unique":"official_token","confirmed":true})
            )
            .await
            .is_err()
        );
        assert!(!app.lock().unwrap().chat_send.busy);
    }

    #[test]
    fn account_changes_discard_async_results_and_invalidate() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        app.lock().unwrap().bili_profile_epoch += 1;
        assert!(
            app.complete_chat_send(
                &operation,
                Ok(Outcome::Refreshed(ChatSendView {
                    room_id: 456,
                    ..view()
                }))
            )
            .is_err()
        );
        assert_eq!(app.lock().unwrap().chat_send.view()["room_id"], 123);
        let operation = prepare(&app);
        app.lock().unwrap().chat_send.invalidate();
        assert!(operation.cancel.is_cancelled());
        assert!(
            app.complete_chat_send(&operation, Ok(Outcome::Sent(456)))
                .is_err()
        );
        let after = app.lock().unwrap().chat_send.view();
        assert!(after["room_id"].is_null());
        assert!(after["account_id"].is_null());
        assert_eq!(after["emoticons"], json!([]));
    }

    #[test]
    fn console_mode_does_not_reject_a_current_accounts_result() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        assert!(!app.lock().unwrap().prefs.broadcast_console);
        assert!(
            app.complete_chat_send(&operation, Ok(Outcome::Refreshed(view())))
                .is_ok()
        );
        app.lock().unwrap().prefs.broadcast_console = true;
        app.lock().unwrap().prefs.broadcast_console = false;
        assert_eq!(
            app.complete_chat_send(&operation, Ok(Outcome::Sent(123)))
                .unwrap(),
            json!({"room_id":123})
        );
        assert!(!operation.cancel.is_cancelled());
    }

    #[test]
    fn cached_preflight_accepts_valid_personal_and_live_text_item_ids() {
        let mut metadata = view();
        metadata.emoticons[0].source = "account";
        let item = &mut metadata.emoticons[0].emoticons[0];
        item.emoticon_unique = "account:77:88".into();
        item.kind = "text";
        item.text = Some("[个人收藏_花花]".into());
        assert!(cached_emoticon_allowed(Some(&metadata), "account:77:88"));
        assert!(!cached_emoticon_allowed(Some(&metadata), "account:77:89"));
        assert!(!cached_emoticon_allowed(None, "account:77:88"));
        metadata.emoticons[0].emoticons[0].allowed = false;
        assert!(!cached_emoticon_allowed(Some(&metadata), "account:77:88"));
        metadata.emoticons[0].emoticons[0].allowed = true;
        metadata.emoticons[0].emoticons[0].text = None;
        assert!(!cached_emoticon_allowed(Some(&metadata), "account:77:88"));
        metadata.emoticons[0].source = "live";
        metadata.emoticons[0].emoticons[0].emoticon_unique = "text:1:0".into();
        metadata.emoticons[0].emoticons[0].text = Some("[笑]".into());
        assert!(cached_emoticon_allowed(Some(&metadata), "text:1:0"));
    }

    #[test]
    fn success_does_not_fabricate_feed_and_failures_remain_visible() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        let before = app.lock().unwrap().carried_events.len();
        assert_eq!(
            app.complete_chat_send(&operation, Ok(Outcome::Sent(123)))
                .unwrap(),
            json!({"room_id":123})
        );
        assert_eq!(app.lock().unwrap().carried_events.len(), before);
        assert!(
            app.complete_chat_send(&operation, Err(BiliError::Api(403)))
                .is_err()
        );
        assert!(
            app.lock().unwrap().chat_send.view()["error"]
                .as_str()
                .unwrap()
                .contains("403")
        );
        assert!(
            app.complete_chat_send(&operation, Err(BiliError::SessionExpired))
                .is_err()
        );
        assert!(operation.cancel.is_cancelled());
        let after = app.lock().unwrap().chat_send.view();
        assert!(after["room_id"].is_null());
        assert_eq!(after["emoticons"], json!([]));
        assert!(after["error"].as_str().is_some());
    }

    #[test]
    fn refreshed_packages_expose_the_authenticated_owner_and_actual_own_room() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        let reply = app
            .complete_chat_send(
                &operation,
                Ok(Outcome::Refreshed(ChatSendView {
                    room_id: 456,
                    ..view()
                })),
            )
            .unwrap();
        assert_eq!(reply["account_id"], 42);
        assert_eq!(reply["room_id"], 456);
        assert_eq!(reply["emoticons"][0]["name"], "平台表情");
        assert_eq!(reply["emoticons"][0]["source"], "live");
        assert_eq!(reply["warnings"], json!([]));
        assert_eq!(reply["emoticons"][0]["pkg_type"], 1);
        assert_eq!(
            reply["emoticons"][0]["icon"],
            "https://i0.hdslb.com/bfs/emote/official-cover.png"
        );
        assert_eq!(app.lock().unwrap().chat_send.view()["account_id"], 42);
        app.lock().unwrap().chat_send.invalidate();
        let after = app.lock().unwrap().chat_send.view();
        assert!(after["account_id"].is_null());
        assert!(after["room_id"].is_null());
        assert_eq!(after["emoticons"], json!([]));
    }

    #[test]
    fn package_source_warnings_are_visible_only_for_the_current_account() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        let mut metadata = view();
        metadata.emoticons[0].source = "account";
        metadata.emoticons[0].emoticons[0].kind = "text";
        metadata.emoticons[0].emoticons[0].text = Some("[个人收藏_花花]".into());
        metadata.warnings = vec!["直播房间表情读取失败 [DV-B04]".into()];
        let reply = app
            .complete_chat_send(&operation, Ok(Outcome::Refreshed(metadata)))
            .unwrap();
        assert_eq!(reply["account_id"], 42);
        assert_eq!(reply["emoticons"][0]["source"], "account");
        assert_eq!(
            reply["emoticons"][0]["emoticons"][0]["text"],
            "[个人收藏_花花]"
        );
        assert_eq!(reply["warnings"][0], "直播房间表情读取失败 [DV-B04]");
        app.lock().unwrap().chat_send.invalidate();
        let after = app.lock().unwrap().chat_send.view();
        assert!(after["account_id"].is_null());
        assert_eq!(after["emoticons"], json!([]));
        assert_eq!(after["warnings"], json!([]));
    }

    #[test]
    fn refreshed_personal_metadata_backfills_same_room_chat_and_stale_account_cannot_change_it() {
        use danmakuvoice_engine::model::LiveEvent;
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        let marker = "[个人收藏_花花]";
        let image = "https://i0.hdslb.com/bfs/emote/flower.png";
        let mut metadata = view();
        metadata.emoticons[0].source = "account";
        let emote = &mut metadata.emoticons[0].emoticons[0];
        emote.kind = "text";
        emote.text = Some(marker.into());
        emote.url = Some(image.into());
        {
            let mut state = app.lock().unwrap();
            state.carried_events = vec![
                LiveEvent::danmaku(123, Some(7), "虚构观众", marker),
                LiveEvent::danmaku(999, Some(7), "虚构观众", marker),
            ];
            state.last_live.recent_events = vec![state.carried_events[0].clone()];
        }
        app.complete_chat_send(&operation, Ok(Outcome::Refreshed(metadata.clone())))
            .unwrap();
        {
            let state = app.lock().unwrap();
            assert_eq!(state.carried_events[0].emotes[0].url, image);
            assert!(state.carried_events[1].emotes.is_empty());
            assert_eq!(state.last_live.recent_events[0].emotes[0].url, image);
            assert_eq!(state.last_live.enqueued, 0);
        }
        app.lock().unwrap().chat_send.invalidate();
        metadata.emoticons[0].emoticons[0].url =
            Some("https://i0.hdslb.com/bfs/emote/stale.png".into());
        assert!(
            app.complete_chat_send(&operation, Ok(Outcome::Refreshed(metadata)))
                .is_err()
        );
        assert_eq!(app.lock().unwrap().carried_events[0].emotes[0].url, image);
    }

    #[test]
    fn partial_personal_read_failure_does_not_suppress_receive_session_retry() {
        let (_directory, app) = isolated(false);
        let operation = prepare(&app);
        let mut partial = view();
        partial.account_error = Some("个人表情接口读取超时".into());
        partial.warnings = vec!["个人表情读取失败：个人表情接口读取超时".into()];
        let reply = app
            .complete_chat_send(&operation, Ok(Outcome::Refreshed(partial)))
            .unwrap();
        assert_eq!(reply["account_error"], "个人表情接口读取超时");
        assert!(
            app.lock()
                .unwrap()
                .chat_send
                .received_emoticons(42, 123)
                .is_none()
        );
        app.complete_chat_send(&operation, Ok(Outcome::Refreshed(view())))
            .unwrap();
        let state = app.lock().unwrap();
        assert!(state.chat_send.received_emoticons(42, 123).is_some());
        assert!(state.chat_send.received_emoticons(43, 123).is_none());
        assert!(state.chat_send.received_emoticons(42, 999).is_none());
    }
}
