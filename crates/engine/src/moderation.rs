//! Bilibili live-room moderation. Room blacklisting belongs to the room's
//! anchor, independently of the logged-in account's following/blacklist.
//! Protocol source: Bilibili's live-room web client, build 2026-09-22,
//! `app.3b48f866e1563d25d39c.js` and `438.8fa97186cca171b1035d.js`;
//! no third-party client code is linked.
use reqwest::{
    Client, Url,
    header::{COOKIE, ORIGIN, REFERER},
};
use serde::{Serialize, Serializer};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::bilibili::{BiliError, BiliSession, http_client, read_json};

const LIVE_API: &str = "https://api.live.bilibili.com";
const ACCOUNT_API: &str = "https://api.bilibili.com";
const SILENT_ROOT: &str = "/xlive/web-ucenter/v1/banned/";
const BLACK_ROOT: &str = "/xlive/app-ucenter/v2/xbanned/banned/";
const MAX_LIST_PAGES: u64 = 100;
const BLACK_PAGE_SIZE: u64 = 10;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ModerationView {
    #[serde(serialize_with = "serialize_uid")]
    pub user_id: u64,
    pub room_id: u64,
    pub can_moderate: bool,
    pub can_blacklist: bool,
    pub can_manage_admins: bool,
    pub is_admin: Option<bool>,
    /// `None` is unknown or unavailable; it never means the user is unmuted.
    pub muted: Option<bool>,
    pub blacklisted: Option<bool>,
    pub message: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RoomPermission {
    room_id: u64,
    anchor_id: u64,
    can_moderate: bool,
    can_blacklist: bool,
}

pub struct ModerationClient {
    http: Client,
    live_base: Url,
    account_base: Url,
}

impl ModerationClient {
    pub fn new() -> Result<Self, BiliError> {
        Ok(Self {
            http: http_client()?,
            live_base: Url::parse(LIVE_API).expect("fixed API URL"),
            account_base: Url::parse(ACCOUNT_API).expect("fixed API URL"),
        })
    }

    fn request(
        &self,
        path: &str,
        session: &BiliSession,
        post: bool,
        account: bool,
        room: u64,
    ) -> reqwest::RequestBuilder {
        let base = if account {
            &self.account_base
        } else {
            &self.live_base
        };
        let url = base.join(path).expect("fixed relative API path");
        let request = if post {
            self.http.post(url)
        } else {
            self.http.get(url)
        };
        let cookie = Zeroizing::new(session.cookie_header());
        request
            .header(COOKIE, cookie.as_str())
            .header(ORIGIN, "https://live.bilibili.com")
            .header(REFERER, format!("https://live.bilibili.com/{room}"))
    }

    async fn get(
        &self,
        path: &str,
        session: &BiliSession,
        query: &[(&str, String)],
        account: bool,
        room: u64,
    ) -> Result<Value, BiliError> {
        let response = self
            .request(path, session, false, account, room)
            .query(query)
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        read_json(response).await
    }

    async fn post(
        &self,
        path: &str,
        session: &BiliSession,
        params: &[(String, String)],
        room: u64,
    ) -> Result<Value, BiliError> {
        let response = self
            .request(path, session, true, false, room)
            .form(params)
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        read_json(response).await
    }

    /// Revalidate the actual authenticated identity and canonical room for
    /// every operation, including writes; cached UI permissions are not trusted.
    async fn permission(
        &self,
        session: &BiliSession,
        display_room: u64,
    ) -> Result<RoomPermission, BiliError> {
        if display_room == 0 {
            return Err(BiliError::InvalidRoom);
        }
        let nav = self
            .get("/x/web-interface/nav", session, &[], true, display_room)
            .await?;
        parse_identity(&nav, session.user_id())?;
        let value = self
            .get(
                "/room/v1/Room/room_init",
                session,
                &[("id", display_room.to_string())],
                false,
                display_room,
            )
            .await?;
        let mut room = parse_room(&value)?;
        if room.anchor_id == session.user_id() {
            room.can_moderate = true;
            room.can_blacklist = true;
        } else {
            let value = self
                .get(
                    "/xlive/web-room/v1/index/getInfoByUser",
                    session,
                    &[("room_id", room.room_id.to_string())],
                    false,
                    room.room_id,
                )
                .await?;
            (room.can_moderate, room.can_blacklist) = parse_admin(&value, session.user_id())?;
        }
        Ok(room)
    }

    pub async fn inspect(
        &self,
        session: &BiliSession,
        display_room: u64,
        user_id: u64,
    ) -> Result<ModerationView, BiliError> {
        validate_target(user_id, session.user_id())?;
        let room = self.permission(session, display_room).await?;
        if user_id == room.anchor_id {
            return Err(BiliError::Protocol(
                "不能对这个直播间的主播执行用户管理操作",
            ));
        }
        if !room.can_moderate && !room.can_blacklist {
            return Ok(ModerationView {
                user_id,
                room_id: room.room_id,
                can_moderate: false,
                can_blacklist: false,
                can_manage_admins: false,
                is_admin: None,
                muted: None,
                blacklisted: None,
                message: Some("当前账号没有这个直播间的用户管理权限，或权限信息不可用"),
            });
        }
        let muted = if room.can_moderate {
            Some(self.silent_status(session, room.room_id, user_id).await?)
        } else {
            None
        };
        let blacklisted = if room.can_blacklist {
            Some(self.black_status(session, room, user_id).await?)
        } else {
            None
        };
        let can_manage_admins = room.anchor_id == session.user_id();
        let is_admin = if can_manage_admins {
            Some(self.admin_status(session, room.room_id, user_id).await?)
        } else {
            None
        };
        Ok(ModerationView {
            user_id,
            room_id: room.room_id,
            can_moderate: room.can_moderate,
            can_blacklist: room.can_blacklist,
            can_manage_admins,
            is_admin,
            muted,
            blacklisted,
            message: None,
        })
    }

    async fn silent_status(
        &self,
        session: &BiliSession,
        room: u64,
        user: u64,
    ) -> Result<bool, BiliError> {
        for page in 1..=MAX_LIST_PAGES {
            let mut params = csrf_params(session);
            params.extend([
                ("room_id".into(), room.to_string()),
                ("ps".into(), page.to_string()),
            ]);
            let value = self
                .post(
                    &format!("{SILENT_ROOT}GetSilentUserList"),
                    session,
                    &params,
                    room,
                )
                .await?;
            let parsed = parse_list(&value, user, "tuid", page, None)?;
            if parsed.found {
                return Ok(true);
            }
            if !parsed.more {
                return Ok(false);
            }
        }
        Err(BiliError::Protocol("禁言列表过大，无法确认用户状态"))
    }

    async fn black_status(
        &self,
        session: &BiliSession,
        room: RoomPermission,
        user: u64,
    ) -> Result<bool, BiliError> {
        for page in 1..=MAX_LIST_PAGES {
            let value = self
                .get(
                    &format!("{BLACK_ROOT}GetBlackList"),
                    session,
                    &[
                        ("anchor_id", room.anchor_id.to_string()),
                        ("pn", page.to_string()),
                        ("ps", BLACK_PAGE_SIZE.to_string()),
                    ],
                    false,
                    room.room_id,
                )
                .await?;
            let parsed = parse_list(&value, user, "uid", page, Some(BLACK_PAGE_SIZE))?;
            if parsed.found {
                return Ok(true);
            }
            if !parsed.more {
                return Ok(false);
            }
        }
        Err(BiliError::Protocol("直播间黑名单过大，无法确认用户状态"))
    }

    async fn admin_status(
        &self,
        session: &BiliSession,
        room: u64,
        user: u64,
    ) -> Result<bool, BiliError> {
        for page in 1..=MAX_LIST_PAGES {
            let value = self
                .get(
                    "/xlive/app-ucenter/v1/roomAdmin/get_by_anchor",
                    session,
                    &[("page", page.to_string())],
                    false,
                    room,
                )
                .await?;
            let parsed = parse_admin_list(&value, user, page)?;
            if parsed.found {
                return Ok(true);
            }
            if !parsed.more {
                return Ok(false);
            }
        }
        Err(BiliError::Protocol("房管列表过大，无法确认用户状态"))
    }

    async fn write_room(
        &self,
        session: &BiliSession,
        display_room: u64,
        expected_room: u64,
        user_id: u64,
    ) -> Result<RoomPermission, BiliError> {
        validate_target(user_id, session.user_id())?;
        let room = self.permission(session, display_room).await?;
        if room.room_id != expected_room {
            return Err(BiliError::Protocol("直播间已变更，请重新打开用户资料"));
        }
        if !room.can_moderate && !room.can_blacklist {
            return Err(BiliError::Protocol(
                "当前账号没有这个直播间的用户管理权限，或权限信息不可用",
            ));
        }
        if room.anchor_id == user_id {
            return Err(BiliError::Protocol("不能禁言或拉黑这个直播间的主播"));
        }
        Ok(room)
    }

    pub async fn mute(
        &self,
        session: &BiliSession,
        display_room: u64,
        expected_room: u64,
        user_id: u64,
        hours: i64,
    ) -> Result<(), BiliError> {
        validate_hours(hours)?;
        let room = self
            .write_room(session, display_room, expected_room, user_id)
            .await?;
        if !room.can_moderate {
            return Err(BiliError::Protocol("当前账号没有这个直播间的禁言权限"));
        }
        let mut params = csrf_params(session);
        params.extend([
            ("room_id".into(), room.room_id.to_string()),
            ("tuid".into(), user_id.to_string()),
            ("mobile_app".into(), "web".into()),
            ("type".into(), if hours == 0 { "2" } else { "1" }.into()),
            ("hour".into(), hours.to_string()),
        ]);
        api_ok(
            &self
                .post(
                    &format!("{SILENT_ROOT}AddSilentUser"),
                    session,
                    &params,
                    room.room_id,
                )
                .await?,
        )
    }

    pub async fn unmute(
        &self,
        session: &BiliSession,
        display_room: u64,
        expected_room: u64,
        user_id: u64,
    ) -> Result<(), BiliError> {
        let room = self
            .write_room(session, display_room, expected_room, user_id)
            .await?;
        if !room.can_moderate {
            return Err(BiliError::Protocol("当前账号没有这个直播间的禁言权限"));
        }
        let mut params = csrf_params(session);
        params.extend([
            ("room_id".into(), room.room_id.to_string()),
            ("tuid".into(), user_id.to_string()),
            ("mobi_app".into(), "web".into()),
        ]);
        api_ok(
            &self
                .post(
                    &format!("{SILENT_ROOT}DelSilentUser"),
                    session,
                    &params,
                    room.room_id,
                )
                .await?,
        )
    }

    /// Anchor room blacklist, not `/x/relation/modify` account blacklisting.
    pub async fn blacklist(
        &self,
        session: &BiliSession,
        display_room: u64,
        expected_room: u64,
        user_id: u64,
        blocked: bool,
    ) -> Result<(), BiliError> {
        let room = self
            .write_room(session, display_room, expected_room, user_id)
            .await?;
        if !room.can_blacklist {
            return Err(BiliError::Protocol("当前账号没有这个直播间的拉黑权限"));
        }
        let mut params = csrf_params(session);
        params.extend([
            ("anchor_id".into(), room.anchor_id.to_string()),
            ("tuid".into(), user_id.to_string()),
            ("spmid".into(), "444.8.0.0".into()),
        ]);
        let path = if blocked { "AddBlack" } else { "DelBlack" };
        api_ok(
            &self
                .post(
                    &format!("{BLACK_ROOT}{path}"),
                    session,
                    &params,
                    room.room_id,
                )
                .await?,
        )
    }

    /// Appointment/revocation is only available to the authenticated anchor.
    /// The UI never chooses or promotes a senior administrator role.
    pub async fn set_admin(
        &self,
        session: &BiliSession,
        display_room: u64,
        expected_room: u64,
        user_id: u64,
        appointed: bool,
    ) -> Result<(), BiliError> {
        let room = self
            .write_room(session, display_room, expected_room, user_id)
            .await?;
        if room.anchor_id != session.user_id() {
            return Err(BiliError::Protocol(
                "只有这个直播间的主播可以设置或撤销房管",
            ));
        }
        if appointed && self.admin_status(session, room.room_id, user_id).await? {
            return Err(BiliError::Protocol("这个用户已经是房管，请刷新资料"));
        }
        let mut params = csrf_params(session);
        let path = if appointed {
            params.extend([
                ("admin".into(), user_id.to_string()),
                ("admin_level".into(), "1".into()),
            ]);
            "/xlive/web-ucenter/v1/roomAdmin/appoint"
        } else {
            params.push(("uid".into(), user_id.to_string()));
            "/xlive/app-ucenter/v1/roomAdmin/dismiss"
        };
        api_ok(&self.post(path, session, &params, room.room_id).await?)
    }
}

pub fn validate_target(user: u64, account: u64) -> Result<(), BiliError> {
    if user == 0 {
        return Err(BiliError::InvalidUid);
    }
    if user == account {
        return Err(BiliError::Protocol("不能对当前登录账号执行用户管理操作"));
    }
    Ok(())
}

fn serialize_uid<S: Serializer>(uid: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&uid.to_string())
}

pub fn validate_hours(hours: i64) -> Result<(), BiliError> {
    if (-1..=720).contains(&hours) {
        Ok(())
    } else {
        Err(BiliError::Protocol(
            "禁言时长须为本场、永久或 1 到 720 小时",
        ))
    }
}

pub(crate) fn csrf_params(session: &BiliSession) -> Zeroizing<Vec<(String, String)>> {
    Zeroizing::new(vec![
        ("csrf".into(), session.csrf().into()),
        ("csrf_token".into(), session.csrf().into()),
    ])
}

pub(crate) fn api_ok(value: &Value) -> Result<(), BiliError> {
    match value["code"].as_i64() {
        Some(0) => Ok(()),
        Some(-101) => Err(BiliError::SessionExpired),
        Some(code) => Err(BiliError::Api(code)),
        None => Err(BiliError::Protocol("缺少接口状态码")),
    }
}

fn id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| *n > 0)
}

pub(crate) fn parse_identity(value: &Value, expected: u64) -> Result<(), BiliError> {
    api_ok(value)?;
    if value["data"]["isLogin"].as_bool() != Some(true) {
        return Err(BiliError::SessionExpired);
    }
    if id(&value["data"]["mid"]) != Some(expected) {
        return Err(BiliError::Protocol("登录身份与当前账号不匹配，请重新扫码"));
    }
    Ok(())
}

fn parse_room(value: &Value) -> Result<RoomPermission, BiliError> {
    api_ok(value)?;
    Ok(RoomPermission {
        room_id: id(&value["data"]["room_id"]).ok_or(BiliError::Protocol("直播间信息无效"))?,
        anchor_id: id(&value["data"]["uid"]).ok_or(BiliError::Protocol("直播间主播信息无效"))?,
        can_moderate: false,
        can_blacklist: false,
    })
}

fn parse_admin(value: &Value, account: u64) -> Result<(bool, bool), BiliError> {
    api_ok(value)?;
    if id(&value["data"]["info"]["uid"]) != Some(account) {
        return Err(BiliError::Protocol("房管身份与当前账号不匹配"));
    }
    let is_admin = match &value["data"]["badge"]["is_room_admin"] {
        Value::Bool(flag) => *flag,
        Value::Number(n) if n.as_u64().is_some_and(|n| n <= 1) => n.as_u64() == Some(1),
        _ => return Err(BiliError::Protocol("房管权限信息无效")),
    };
    // Current web permissions: MUTE = 1, BLOCK = 2. Membership/level alone
    // does not grant either permission. Missing or malformed permissions fail
    // closed, and the platform still enforces target privilege restrictions.
    let permissions = value["data"]["badge"]["permissions"]
        .as_array()
        .filter(|permissions| {
            permissions.len() <= 64
                && permissions
                    .iter()
                    .all(|permission| permission.as_u64().is_some())
        });
    let permits = |permission| {
        is_admin
            && permissions.is_some_and(|permissions| {
                permissions
                    .iter()
                    .any(|entry| entry.as_u64() == Some(permission))
            })
    };
    Ok((permits(1), permits(2)))
}

struct ParsedList {
    found: bool,
    more: bool,
}

fn parse_admin_list(value: &Value, target: u64, page: u64) -> Result<ParsedList, BiliError> {
    api_ok(value)?;
    let data = &value["data"];
    let rows = data["data"]
        .as_array()
        .filter(|rows| rows.len() <= 1000)
        .ok_or(BiliError::Protocol("房管列表无效"))?;
    let pages = match data.pointer("/page/total_page") {
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or(BiliError::Protocol("房管列表分页信息无效"))?,
        // The platform omits pagination for a single-page list.
        None | Some(Value::Null) if page == 1 => 1,
        _ => return Err(BiliError::Protocol("房管列表分页信息无效")),
    };
    let mut found = false;
    for row in rows {
        let uid = id(&row["uid"]).ok_or(BiliError::Protocol("房管列表 UID 无效"))?;
        found |= uid == target;
    }
    let more = page < pages;
    if more && rows.is_empty() {
        return Err(BiliError::Protocol("房管列表分页不完整"));
    }
    Ok(ParsedList { found, more })
}

fn parse_list(
    value: &Value,
    target: u64,
    uid_key: &str,
    page: u64,
    page_size: Option<u64>,
) -> Result<ParsedList, BiliError> {
    api_ok(value)?;
    let data = &value["data"];
    let total = data["total"]
        .as_u64()
        .ok_or(BiliError::Protocol("用户管理列表数量无效"))?;
    let empty = Vec::new();
    let rows = match &data["data"] {
        Value::Null if total == 0 => &empty,
        Value::Array(rows) if rows.len() <= 1000 => rows,
        _ => return Err(BiliError::Protocol("用户管理列表无效")),
    };
    let mut found = false;
    for row in rows {
        let uid = id(&row[uid_key]).ok_or(BiliError::Protocol("用户管理列表 UID 无效"))?;
        found |= uid == target;
    }
    let page_size = match (page_size, data.get("ps")) {
        (Some(_), Some(value)) => Some(
            value
                .as_u64()
                .filter(|size| (1..=1000).contains(size))
                .ok_or(BiliError::Protocol("用户管理列表分页大小无效"))?,
        ),
        (size, _) => size,
    };
    let explicit_pages = data["total_page"].as_u64().filter(|n| *n > 0);
    let pages = data["total_page"]
        .as_u64()
        .filter(|n| *n > 0)
        .or_else(|| page_size.map(|size| total.div_ceil(size)));
    let more = match pages {
        Some(pages) => page < pages,
        None if page == 1 && rows.len() as u64 == total => false,
        _ => return Err(BiliError::Protocol("用户管理列表分页信息无效")),
    };
    if more && rows.is_empty() {
        return Err(BiliError::Protocol("用户管理列表分页不完整"));
    }
    if !found
        && explicit_pages.is_none()
        && let Some(size) = page_size
    {
        let expected = total
            .saturating_sub(page.saturating_sub(1).saturating_mul(size))
            .min(size);
        if rows.len() as u64 != expected {
            return Err(BiliError::Protocol("用户管理列表分页不完整"));
        }
    }
    Ok(ParsedList { found, more })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn session() -> BiliSession {
        BiliSession::from_secret_payload(
            br#"{"user_id":42,"sessdata":"fictional-session","bili_jct":"fictional-csrf"}"#,
        )
        .unwrap()
    }
    fn nav() -> Value {
        json!({"code":0,"data":{"isLogin":true,"mid":42}})
    }
    fn room(owner: u64) -> Value {
        json!({"code":0,"data":{"uid":owner,"room_id":123}})
    }
    fn admin(flag: bool) -> Value {
        json!({"code":0,"data":{"info":{"uid":42},"badge":{"is_room_admin":flag,"admin_level":1,"permissions":[1]}}})
    }
    fn senior() -> Value {
        json!({"code":0,"data":{"info":{"uid":42},"badge":{"is_room_admin":true,"admin_level":2,"permissions":[1,2]}}})
    }
    fn list(rows: Value, total: u64, pages: u64) -> Value {
        json!({"code":0,"data":{"data":rows,"total":total,"total_page":pages}})
    }

    async fn fixture(
        replies: Vec<Value>,
    ) -> (ModerationClient, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for reply in replies {
                let (mut socket, _) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let size = socket.read(&mut chunk).await.unwrap();
                    assert!(size > 0, "request must be complete");
                    bytes.extend_from_slice(&chunk[..size]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")?
                                    .parse::<usize>()
                                    .ok()
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                    assert!(bytes.len() < 64 * 1024);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = reply.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (
            ModerationClient {
                http: http_client().unwrap(),
                live_base: base.clone(),
                account_base: base,
            },
            task,
        )
    }

    #[test]
    fn moderation_target_and_duration_are_explicit_and_lossless() {
        assert_eq!(validate_target(0, 42), Err(BiliError::InvalidUid));
        assert!(validate_target(42, 42).is_err());
        assert!(validate_target(u64::MAX, 42).is_ok());
        for hours in [-1, 0, 1, 24, 720] {
            assert!(validate_hours(hours).is_ok());
        }
        for hours in [-2, 721, i64::MAX] {
            assert!(validate_hours(hours).is_err());
        }
        let view = ModerationView {
            user_id: 9_007_199_254_740_993,
            room_id: 123,
            can_moderate: false,
            can_blacklist: false,
            can_manage_admins: false,
            is_admin: None,
            muted: None,
            blacklisted: None,
            message: None,
        };
        assert_eq!(json!(view)["user_id"], "9007199254740993");
        assert!(json!(view)["muted"].is_null());
    }

    #[test]
    fn response_errors_do_not_expose_platform_messages() {
        assert_eq!(
            api_ok(&json!({"code":-101,"message":"sensitive"})),
            Err(BiliError::SessionExpired)
        );
        let error = api_ok(&json!({"code":403,"message":"sensitive"})).unwrap_err();
        assert_eq!(error, BiliError::Api(403));
        assert!(!error.to_string().contains("sensitive"));
        assert!(api_ok(&json!({"code":"0"})).is_err());
        assert!(parse_identity(&json!({"code":0,"data":{"isLogin":false,"mid":42}}), 42).is_err());
        assert!(parse_identity(&nav(), 43).is_err());
        assert!(parse_admin(&admin(true), 43).is_err());
        assert!(
            parse_admin(
                &json!({"code":0,"data":{"info":{"uid":42},"badge":{"is_room_admin":"true"}}}),
                42
            )
            .is_err()
        );
    }

    #[test]
    fn list_unknown_or_incomplete_pages_never_mean_false() {
        assert!(parse_list(&list(json!([]), 1, 2), 77, "tuid", 1, None).is_err());
        assert!(
            parse_list(
                &json!({"code":0,"data":{"data":[{"tuid":0}],"total":1}}),
                77,
                "tuid",
                1,
                None
            )
            .is_err()
        );
        assert!(
            parse_list(
                &json!({"code":0,"data":{"data":[],"total":10}}),
                77,
                "tuid",
                1,
                None
            )
            .is_err()
        );
        let parsed = parse_list(&list(json!([{"tuid":"77"}]), 1, 1), 77, "tuid", 1, None).unwrap();
        assert!(parsed.found);
        assert!(!parsed.more);
        assert!(
            !parse_list(&list(Value::Null, 0, 0), 77, "tuid", 1, None)
                .unwrap()
                .found
        );
    }

    #[tokio::test]
    async fn inspect_paginates_and_uses_anchor_blacklist() {
        let (client, task) = fixture(vec![
            nav(),
            room(42),
            list(json!([{"tuid":55}]), 2, 2),
            list(json!([{"tuid":77}]), 2, 2),
            list(json!([{"uid":77}]), 1, 0),
            json!({"code":0,"data":{"data":[{"uid":77}],"page":{"total_page":1}}}),
        ])
        .await;
        let view = client.inspect(&session(), 1, 77).await.unwrap();
        assert_eq!(
            (view.room_id, view.muted, view.blacklisted),
            (123, Some(true), Some(true))
        );
        let requests = task.await.unwrap();
        assert!(requests[0].starts_with("GET /x/web-interface/nav "));
        assert!(requests[1].starts_with("GET /room/v1/Room/room_init?id=1 "));
        assert!(requests[2].contains("room_id=123&ps=1"));
        assert!(requests[3].contains("room_id=123&ps=2"));
        assert!(requests[4].contains("GetBlackList?anchor_id=42&pn=1&ps=10"));
        assert!(
            !requests
                .iter()
                .any(|request| request.contains("/x/relation"))
        );
    }

    #[tokio::test]
    async fn ordinary_viewer_cannot_write_and_does_not_read_private_lists() {
        let (client, task) = fixture(vec![nav(), room(7), admin(false)]).await;
        let view = client.inspect(&session(), 1, 77).await.unwrap();
        assert!(!view.can_moderate);
        assert_eq!((view.muted, view.blacklisted), (None, None));
        assert_eq!(task.await.unwrap().len(), 3);
        let (client, task) = fixture(vec![nav(), room(7), admin(false)]).await;
        assert!(client.mute(&session(), 1, 123, 77, 24).await.is_err());
        assert_eq!(task.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn owner_and_admin_revalidate_identity_role_and_csrf_before_mute() {
        for (owner, replies) in [
            (42, vec![nav(), room(42), json!({"code":0})]),
            (7, vec![nav(), room(7), admin(true), json!({"code":0})]),
        ] {
            let (client, task) = fixture(replies).await;
            client.mute(&session(), 1, 123, 77, 24).await.unwrap();
            let requests = task.await.unwrap();
            let write = requests.last().unwrap();
            assert!(write.starts_with("POST /xlive/web-ucenter/v1/banned/AddSilentUser "));
            assert!(write.contains("csrf=fictional-csrf&csrf_token=fictional-csrf"));
            assert!(write.contains("room_id=123&tuid=77&mobile_app=web&type=1&hour=24"));
            assert!(
                write
                    .to_ascii_lowercase()
                    .contains("cookie: sessdata=fictional-session")
            );
            assert_eq!(requests.len(), if owner == 42 { 3 } else { 4 });
        }
    }

    #[tokio::test]
    async fn current_live_mute_and_unmute_use_current_web_api_fields() {
        let (client, task) = fixture(vec![nav(), room(42), json!({"code":0})]).await;
        client.mute(&session(), 1, 123, 77, 0).await.unwrap();
        assert!(task.await.unwrap()[2].contains("mobile_app=web&type=2&hour=0"));
        let (client, task) = fixture(vec![nav(), room(42), json!({"code":0})]).await;
        client.unmute(&session(), 1, 123, 77).await.unwrap();
        let requests = task.await.unwrap();
        assert!(requests[2].starts_with("POST /xlive/web-ucenter/v1/banned/DelSilentUser "));
        assert!(requests[2].contains("room_id=123&tuid=77&mobi_app=web"));
    }

    #[tokio::test]
    async fn room_blacklist_never_changes_logged_in_account_relations() {
        for blocked in [true, false] {
            let (client, task) = fixture(vec![nav(), room(7), senior(), json!({"code":0})]).await;
            client
                .blacklist(&session(), 1, 123, 77, blocked)
                .await
                .unwrap();
            let requests = task.await.unwrap();
            let endpoint = if blocked { "AddBlack" } else { "DelBlack" };
            assert!(requests[3].starts_with(&format!(
                "POST /xlive/app-ucenter/v2/xbanned/banned/{endpoint} "
            )));
            assert!(requests[3].contains("anchor_id=7&tuid=77&spmid=444.8.0.0"));
            assert!(!requests[3].contains("act="));
        }
    }

    #[tokio::test]
    async fn changed_room_expired_session_and_anchor_target_never_send_write() {
        let (client, task) = fixture(vec![nav(), room(42)]).await;
        assert!(client.mute(&session(), 1, 456, 77, 24).await.is_err());
        assert_eq!(task.await.unwrap().len(), 2);
        let (client, task) = fixture(vec![json!({"code":-101})]).await;
        assert_eq!(
            client.blacklist(&session(), 1, 123, 77, true).await,
            Err(BiliError::SessionExpired)
        );
        assert_eq!(task.await.unwrap().len(), 1);
        let (client, task) = fixture(vec![nav(), room(7), admin(true)]).await;
        assert!(client.blacklist(&session(), 1, 123, 7, true).await.is_err());
        assert_eq!(task.await.unwrap().len(), 3);
        let (client, task) = fixture(vec![nav(), room(7), admin(true)]).await;
        assert!(client.inspect(&session(), 1, 7).await.is_err());
        assert_eq!(task.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn platform_permission_denial_is_preserved_without_success() {
        let (client, task) = fixture(vec![
            nav(),
            room(7),
            admin(true),
            json!({"code":403,"message":"credential-like-secret"}),
        ])
        .await;
        let error = client.mute(&session(), 1, 123, 77, 24).await.unwrap_err();
        assert_eq!(error, BiliError::Api(403));
        assert!(!error.to_string().contains("credential-like-secret"));
        assert_eq!(task.await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn only_authenticated_owner_can_appoint_or_dismiss_ordinary_admin() {
        for appointed in [true, false] {
            let mut replies = vec![nav(), room(42)];
            if appointed {
                replies.push(json!({"code":0,"data":{"data":[]}}));
            }
            replies.push(json!({"code":0}));
            let (client, task) = fixture(replies).await;
            client
                .set_admin(&session(), 1, 123, 77, appointed)
                .await
                .unwrap();
            let requests = task.await.unwrap();
            if appointed {
                assert!(requests[3].starts_with("POST /xlive/web-ucenter/v1/roomAdmin/appoint "));
                assert!(requests[3].contains("admin=77&admin_level=1"));
                assert!(!requests[3].contains("admin_level=2"));
            } else {
                assert!(requests[2].starts_with("POST /xlive/app-ucenter/v1/roomAdmin/dismiss "));
                assert!(requests[2].contains("uid=77"));
            }
            assert!(
                requests
                    .last()
                    .unwrap()
                    .contains("csrf=fictional-csrf&csrf_token=fictional-csrf")
            );
        }
        let (client, task) = fixture(vec![nav(), room(7), admin(true)]).await;
        assert!(
            client
                .set_admin(&session(), 1, 123, 77, true)
                .await
                .is_err()
        );
        assert_eq!(task.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn appointment_never_downgrades_existing_senior_admin() {
        let (client, task) = fixture(vec![
            nav(),
            room(42),
            json!({"code":0,"data":{"data":[{"uid":77,"admin_level":2}]}}),
        ])
        .await;
        assert!(
            client
                .set_admin(&session(), 1, 123, 77, true)
                .await
                .is_err()
        );
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|request| request.starts_with("GET ")));
    }

    #[tokio::test]
    async fn ordinary_room_admin_can_mute_without_private_blacklist_or_admin_list() {
        let (client, task) =
            fixture(vec![nav(), room(7), admin(true), list(json!([]), 0, 0)]).await;
        let view = client.inspect(&session(), 1, 77).await.unwrap();
        assert!(view.can_moderate);
        assert!(!view.can_blacklist);
        assert!(!view.can_manage_admins);
        assert_eq!(
            (view.muted, view.blacklisted, view.is_admin),
            (Some(false), None, None)
        );
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 4);
        assert!(
            !requests.iter().any(
                |request| request.contains("GetBlackList") || request.contains("get_by_anchor")
            )
        );
        let (client, task) = fixture(vec![nav(), room(7), admin(true)]).await;
        assert!(
            client
                .blacklist(&session(), 1, 123, 77, true)
                .await
                .is_err()
        );
        assert_eq!(task.await.unwrap().len(), 3);
        let mut unknown = admin(true);
        unknown["data"]["badge"]
            .as_object_mut()
            .unwrap()
            .remove("permissions");
        assert_eq!(parse_admin(&unknown, 42).unwrap(), (false, false));
        assert_eq!(parse_admin(&senior(), 42).unwrap(), (true, true));
    }

    #[test]
    fn admin_list_requires_real_uids_and_complete_pages() {
        assert!(
            parse_admin_list(
                &json!({"code":0,"data":{"data":[{"uid":"77"}],"page":{"total_page":2}}}),
                77,
                1
            )
            .unwrap()
            .found
        );
        assert!(
            parse_admin_list(
                &json!({"code":0,"data":{"data":[],"page":{"total_page":2}}}),
                77,
                1
            )
            .is_err()
        );
        assert!(parse_admin_list(&json!({"code":0,"data":{"data":[{"uid":0}]}}), 77, 1).is_err());
        assert!(
            !parse_admin_list(&json!({"code":0,"data":{"data":[]}}), 77, 1)
                .unwrap()
                .more
        );
    }
}
