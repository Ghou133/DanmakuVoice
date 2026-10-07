//! Send to the authenticated broadcaster's own room. Protocol references are
//! Bilibili's current room-player.01626800.prod.min.js and the live-room
//! emoticon chunk 9649.1063b9e512e83582c1bc.js. Personal comment packages use
//! the official video.05af4e80b6081ba56c1b5b943d4c8e621df3f875.js panel mapping.
//! No unsigned retry/fallback.
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::{
    Client, Url,
    header::{CONTENT_TYPE, COOKIE, ORIGIN, REFERER},
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    bilibili::{BiliError, BiliSession, bili_image_url, http_client, nav_wbi_mixin, read_json},
    moderation::{api_ok, csrf_params, parse_identity},
};

const LIVE_API: &str = "https://api.live.bilibili.com";
const ACCOUNT_API: &str = "https://api.bilibili.com";
const DEFAULT_MESSAGE_LIMIT: usize = 20;
const MAX_PACKS: usize = 100;
const MAX_EMOTICONS: usize = 2000;
const MAX_ACCOUNT_PACKS: usize = 1000;
const MAX_ACCOUNT_EMOTICONS: usize = 20_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ChatEmoticon {
    pub emoticon_unique: String,
    pub emoji: String,
    pub url: Option<String>,
    pub allowed: bool,
    pub kind: &'static str,
    pub text: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ChatEmoticonPack {
    pub source: &'static str,
    pub name: String,
    pub pkg_type: Option<u64>,
    pub icon: Option<String>,
    pub emoticons: Vec<ChatEmoticon>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ChatSendView {
    pub room_id: u64,
    pub message_limit: usize,
    pub emoticons: Vec<ChatEmoticonPack>,
    pub warnings: Vec<String>,
    /// A partial live-only view must not suppress a personal metadata retry.
    pub account_error: Option<String>,
}

struct OwnRoom {
    room_id: u64,
    message_limit: usize,
    mixin: String,
}

pub struct ChatSendClient {
    http: Client,
    live_base: Url,
    account_base: Url,
}

impl ChatSendClient {
    pub fn new() -> Result<Self, BiliError> {
        Ok(Self {
            http: http_client()?,
            live_base: Url::parse(LIVE_API).expect("fixed API URL"),
            account_base: Url::parse(ACCOUNT_API).expect("fixed API URL"),
        })
    }

    fn request(
        &self,
        session: &BiliSession,
        path: &str,
        post: bool,
        account: bool,
        room: u64,
    ) -> reqwest::RequestBuilder {
        let url = (if account {
            &self.account_base
        } else {
            &self.live_base
        })
        .join(path)
        .expect("fixed relative API path");
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
        session: &BiliSession,
        path: &str,
        account: bool,
        room: u64,
        params: &[(&str, String)],
    ) -> Result<Value, BiliError> {
        let response = self
            .request(session, path, false, account, room)
            .query(params)
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        read_json(response).await
    }

    async fn own_room(&self, session: &BiliSession) -> Result<OwnRoom, BiliError> {
        let nav = self
            .get(session, "/x/web-interface/nav", true, 0, &[])
            .await?;
        parse_identity(&nav, session.user_id())?;
        // WBI discovery must succeed before there can be any POST.
        let mixin = nav_wbi_mixin(&nav, true)?;
        let value = self
            .get(
                session,
                "/room/v2/Room/room_id_by_uid",
                false,
                0,
                &[("uid", session.user_id().to_string())],
            )
            .await?;
        api_ok(&value)?;
        let room = id(&value["data"]["room_id"]).ok_or(BiliError::NoOwnRoom)?;
        let value = self
            .get(
                session,
                "/room/v1/Room/get_info",
                false,
                room,
                &[("id", room.to_string())],
            )
            .await?;
        api_ok(&value)?;
        if id(&value["data"]["room_id"]) != Some(room)
            || id(&value["data"]["uid"]) != Some(session.user_id())
        {
            return Err(BiliError::Protocol("直播间与当前登录账号不匹配"));
        }
        let value = self
            .get(
                session,
                "/xlive/web-room/v1/index/getInfoByUser",
                false,
                room,
                &[("room_id", room.to_string())],
            )
            .await?;
        api_ok(&value)?;
        if id(&value["data"]["info"]["uid"]) != Some(session.user_id()) {
            return Err(BiliError::Protocol("弹幕发送身份与当前账号不匹配"));
        }
        Ok(OwnRoom {
            room_id: room,
            message_limit: message_limit(&value)?,
            mixin,
        })
    }

    async fn emoticons_for(
        &self,
        session: &BiliSession,
        room: u64,
    ) -> Result<Vec<ChatEmoticonPack>, BiliError> {
        let value = self
            .get(
                session,
                "/xlive/web-ucenter/v2/emoticon/GetEmoticons",
                false,
                room,
                &[("platform", "pc".into()), ("room_id", room.to_string())],
            )
            .await?;
        parse_emoticons(&value)
    }

    pub async fn account_emoticons_for(
        &self,
        session: &BiliSession,
        room: u64,
    ) -> Result<Vec<ChatEmoticonPack>, BiliError> {
        // This is the authenticated personal collection, separate from the
        // live room's allowed standalone image-emoticon tokens. The official
        // web video client requests business=reply and reads packages/emote.
        let value = self
            .get(
                session,
                "/x/emote/user/panel/web",
                true,
                room,
                &[("business", "reply".into())],
            )
            .await?;
        parse_account_emoticons(&value)
    }

    pub async fn refresh(&self, session: &BiliSession) -> Result<ChatSendView, BiliError> {
        let room = self.own_room(session).await?;
        let account = self.account_emoticons_for(session, room.room_id).await;
        // Expired authentication invalidates the whole view; it must never be
        // hidden behind a partial-source warning or stale room permissions.
        if matches!(account, Err(BiliError::SessionExpired)) {
            return Err(BiliError::SessionExpired);
        }
        let live = self.emoticons_for(session, room.room_id).await;
        if matches!(live, Err(BiliError::SessionExpired)) {
            return Err(BiliError::SessionExpired);
        }
        let account_error = account.as_ref().err().map(ToString::to_string);
        let (emoticons, warnings) = merge_emoticon_sources(account, live)?;
        Ok(ChatSendView {
            room_id: room.room_id,
            message_limit: room.message_limit,
            emoticons,
            warnings,
            account_error,
        })
    }

    pub async fn send_text(&self, session: &BiliSession, message: &str) -> Result<u64, BiliError> {
        // Reject empty/control content before networking; the actual platform
        // limit is resolved before the write and counted like its JS client.
        validate_message(message, 1000)?;
        let room = self.own_room(session).await?;
        validate_message(message, room.message_limit)?;
        self.send(session, &room, message, false).await?;
        Ok(room.room_id)
    }

    pub async fn send_emoticon(
        &self,
        session: &BiliSession,
        token: &str,
    ) -> Result<u64, BiliError> {
        validate_token(token)?;
        let room = self.own_room(session).await?;
        // Re-fetch the exact current account collection or live permissions
        // for every send. The UI identity of a personal item is not a live
        // dm_type=1 token, and no caller-provided markup is trusted.
        let packs = if token.starts_with("account:") {
            self.account_emoticons_for(session, room.room_id).await?
        } else {
            self.emoticons_for(session, room.room_id).await?
        };
        let item = packs
            .iter()
            .flat_map(|pack| &pack.emoticons)
            .find(|item| item.emoticon_unique == token)
            .ok_or(BiliError::Protocol("这个表情当前不可用，请刷新表情列表"))?;
        if !item.allowed {
            return Err(BiliError::Protocol("当前账号没有使用这个表情的权限"));
        }
        match item.kind {
            "emoticon" => {
                self.send(session, &room, &item.emoticon_unique, true)
                    .await?;
            }
            "text" => {
                let message = item
                    .text
                    .as_deref()
                    .ok_or(BiliError::Protocol("这个表情当前不可用，请刷新表情列表"))?;
                validate_message(message, room.message_limit)?;
                // Send one standalone regular message using the official raw
                // text field. Never insert into a draft or invent an image
                // token from a comment package's numeric item ID.
                self.send(session, &room, message, false).await?;
            }
            _ => return Err(BiliError::Protocol("表情类型无效")),
        }
        Ok(room.room_id)
    }

    async fn send(
        &self,
        session: &BiliSession,
        room: &OwnRoom,
        message: &str,
        emoticon: bool,
    ) -> Result<(), BiliError> {
        let now = timestamp()?;
        let mut params = csrf_params(session);
        params.extend([
            ("msg".into(), message.into()),
            ("color".into(), "16777215".into()),
            ("fontsize".into(), "25".into()),
            ("mode".into(), "1".into()),
            ("rnd".into(), now.to_string()),
            ("roomid".into(), room.room_id.to_string()),
            ("data_extend".into(), json!({}).to_string()),
            ("bubble".into(), "0".into()),
        ]);
        if emoticon {
            params.push(("dm_type".into(), "1".into()));
        }
        let query = signed_send_query(now, &room.mixin);
        // Match the official player SDK's FormData request. Field names are
        // fixed here; UTF-8 content remains intact rather than WBI-filtered.
        let boundary = format!("danmakuvoice-{}", uuid::Uuid::new_v4().simple());
        let mut body = Zeroizing::new(String::new());
        for (name, value) in params.iter() {
            body.push_str(&format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            ));
        }
        body.push_str(&format!("--{boundary}--\r\n"));
        let response = self
            .request(session, "/msg/send", true, false, room.room_id)
            .query(&query)
            .header(
                CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(std::mem::take(&mut *body))
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        parse_send_result(&read_json(response).await?)
    }
}

fn parse_send_result(value: &Value) -> Result<(), BiliError> {
    api_ok(value)?;
    // The platform player checks code only. The primary authored
    // bili_danmu_disharmony script additionally detects top-level f/k as
    // system/anchor filtering. Never fabricate an optimistic local echo.
    match value.get("msg") {
        Some(Value::String(message)) if message == "f" => {
            return Err(BiliError::Protocol("弹幕被平台拦截，未确认发送成功"));
        }
        Some(Value::String(message)) if message == "k" => {
            return Err(BiliError::Protocol("弹幕被直播间屏蔽，未确认发送成功"));
        }
        None | Some(Value::Null) => {}
        Some(Value::String(message)) if message.is_empty() => {}
        _ => {
            return Err(BiliError::Protocol(
                "平台未确认弹幕发送成功，请核对接收记录",
            ));
        }
    }
    // Nonempty nested msg has no verified success meaning in the official
    // SDK, so keep the result explicitly uncertain without exposing it.
    match value.pointer("/data/msg") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(message)) if message.is_empty() => Ok(()),
        _ => Err(BiliError::Protocol(
            "平台未确认弹幕发送成功，请核对接收记录",
        )),
    }
}

pub fn validate_message(message: &str, limit: usize) -> Result<(), BiliError> {
    if message.trim().is_empty() {
        return Err(BiliError::Protocol("请输入要发送的弹幕"));
    }
    if message.chars().any(char::is_control) {
        return Err(BiliError::Protocol("弹幕不能包含换行或控制字符"));
    }
    if message.encode_utf16().count() > limit {
        return Err(BiliError::Protocol(
            "弹幕超过当前直播间允许的长度，请缩短后再发送",
        ));
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), BiliError> {
    if token.is_empty() || token.len() > 256 || token.chars().any(char::is_control) {
        Err(BiliError::Protocol("表情标识无效"))
    } else {
        Ok(())
    }
}

fn message_limit(value: &Value) -> Result<usize, BiliError> {
    match value.pointer("/data/property/danmu/length") {
        None | Some(Value::Null) => Ok(DEFAULT_MESSAGE_LIMIT),
        Some(value) => value
            .as_u64()
            .and_then(|length| usize::try_from(length).ok())
            .filter(|length| (1..=1000).contains(length))
            .ok_or(BiliError::Protocol("弹幕长度限制无效")),
    }
}

fn id(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|id| *id > 0)
}

fn text(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .filter(|text| text.len() <= limit && !text.chars().any(char::is_control))
        .map(str::to_owned)
}

fn text_item_identity(package_name: &str, message: &str) -> String {
    // Names and markers cannot contain control characters, so the separator
    // is unambiguous. Unlike array indices, this identity survives reordered
    // packages/items and cannot resolve to a different original marker.
    let digest = Sha256::digest(format!("{package_name}\0{message}"));
    format!("text:{digest:x}")
}

fn parse_emoticons(value: &Value) -> Result<Vec<ChatEmoticonPack>, BiliError> {
    api_ok(value)?;
    let rows = value
        .pointer("/data/data")
        .and_then(Value::as_array)
        .filter(|rows| rows.len() <= MAX_PACKS)
        .ok_or(BiliError::Protocol("表情包列表无效"))?;
    let mut count = 0;
    let mut tokens = std::collections::HashSet::new();
    rows.iter()
        .enumerate()
        .map(|(pack_index, row)| {
            let name = text(&row["pkg_name"], 256)
                .filter(|name| !name.is_empty())
                .ok_or(BiliError::Protocol("表情包名称无效"))?;
            let pkg_type = row["pkg_type"].as_u64();
            let text_pack = pkg_type == Some(3);
            // The current official emoticon component's tabsImages getter
            // reads current_cover directly; pkg_icon is not its API field.
            let icon = emoticon_image_url(row.get("current_cover"));
            let items = row["emoticons"]
                .as_array()
                .ok_or(BiliError::Protocol("表情列表无效"))?;
            count += items.len();
            if count > MAX_EMOTICONS {
                return Err(BiliError::Protocol("表情列表过大"));
            }
            let emoticons = items
                .iter()
                .enumerate()
                .map(|(item_index, item)| {
                    let inserted = if text_pack {
                        text(&item["descript"], 256).filter(|text| !text.is_empty())
                    } else {
                        None
                    };
                    // The official text-emoji pack uses descript, not a send
                    // token. Its identity resolves the original text field.
                    let token = if text_pack {
                        inserted.as_deref().map_or_else(
                            || format!("text:{pack_index}:{item_index}"),
                            |message| text_item_identity(&name, message),
                        )
                    } else {
                        text(&item["emoticon_unique"], 256)
                            .ok_or(BiliError::Protocol("表情标识无效"))?
                    };
                    validate_token(&token)?;
                    if !tokens.insert(token.clone()) {
                        return Err(BiliError::Protocol("表情标识重复"));
                    }
                    let emoji = text(&item["emoji"], 256)
                        .filter(|emoji| !emoji.is_empty())
                        .or_else(|| inserted.clone())
                        .unwrap_or_else(|| token.clone());
                    let allowed = if text_pack {
                        inserted.is_some()
                    } else {
                        item["perm"].as_u64() == Some(1)
                    };
                    Ok(ChatEmoticon {
                        emoticon_unique: token,
                        emoji,
                        url: emoticon_image_url(item.get("url")),
                        allowed,
                        kind: if text_pack { "text" } else { "emoticon" },
                        text: inserted,
                        description: text(&item["unlock_show_text"], 512)
                            .filter(|description| !description.is_empty()),
                    })
                })
                .collect::<Result<_, BiliError>>()?;
            Ok(ChatEmoticonPack {
                source: "live",
                name,
                pkg_type,
                icon,
                emoticons,
            })
        })
        .collect()
}

fn merge_emoticon_sources(
    account: Result<Vec<ChatEmoticonPack>, BiliError>,
    live: Result<Vec<ChatEmoticonPack>, BiliError>,
) -> Result<(Vec<ChatEmoticonPack>, Vec<String>), BiliError> {
    if matches!(account, Err(BiliError::SessionExpired))
        || matches!(live, Err(BiliError::SessionExpired))
    {
        return Err(BiliError::SessionExpired);
    }
    if account.is_err() && live.is_err() {
        return Err(BiliError::Protocol(
            "个人表情和直播表情都读取失败，请刷新重试",
        ));
    }
    let mut packs = Vec::new();
    let mut warnings = Vec::new();
    match account {
        Ok(account) => packs.extend(account),
        Err(error) => warnings.push(format!("个人表情读取失败：{error}")),
    }
    match live {
        Ok(live) => packs.extend(live),
        Err(error) => warnings.push(format!("直播表情读取失败：{error}")),
    }
    Ok((packs, warnings))
}

fn parse_account_emoticons(value: &Value) -> Result<Vec<ChatEmoticonPack>, BiliError> {
    api_ok(value)?;
    let rows = match value.pointer("/data/packages") {
        // The official client explicitly uses packages || [] for an empty
        // account collection, and the API also returns null for no packages.
        Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(rows)) if rows.len() <= MAX_ACCOUNT_PACKS => rows,
        _ => return Err(BiliError::Protocol("个人表情包列表无效")),
    };
    let mut count = 0;
    let mut identities = std::collections::HashSet::new();
    rows.iter()
        .map(|row| {
            let package_id = id(&row["id"]).ok_or(BiliError::Protocol("个人表情包标识无效"))?;
            let name = text(&row["text"], 256)
                .filter(|name| !name.is_empty())
                .ok_or(BiliError::Protocol("个人表情包名称无效"))?;
            let items = row["emote"]
                .as_array()
                .ok_or(BiliError::Protocol("个人表情列表无效"))?;
            count += items.len();
            if count > MAX_ACCOUNT_EMOTICONS {
                return Err(BiliError::Protocol("个人表情列表过大"));
            }
            let emoticons = items
                .iter()
                .map(|item| {
                    let emote_id =
                        id(&item["id"]).ok_or(BiliError::Protocol("个人表情标识无效"))?;
                    if let Some(owner) = item.get("package_id")
                        && id(owner) != Some(package_id)
                    {
                        return Err(BiliError::Protocol("个人表情与表情包不匹配"));
                    }
                    let inserted = text(&item["text"], 256)
                        .filter(|text| !text.is_empty())
                        .ok_or(BiliError::Protocol("个人表情文字无效"))?;
                    // An item lookup identity only: never send this as a live
                    // emoticon_unique or dm_type=1. A click resolves the fresh
                    // original item.text and sends it as a regular message.
                    let token = format!("account:{package_id}:{emote_id}");
                    if !identities.insert(token.clone()) {
                        return Err(BiliError::Protocol("个人表情标识重复"));
                    }
                    Ok(ChatEmoticon {
                        emoticon_unique: token,
                        emoji: inserted.clone(),
                        url: emoticon_image_url(item.get("url")),
                        // The official web panel maps every returned item.
                        // flags.unlocked is false even for owned packages, so
                        // it is not interpreted as live send permission here.
                        allowed: true,
                        kind: "text",
                        text: Some(inserted),
                        description: None,
                    })
                })
                .collect::<Result<_, BiliError>>()?;
            Ok(ChatEmoticonPack {
                source: "account",
                name,
                pkg_type: row["type"].as_u64(),
                icon: emoticon_image_url(row.get("url")),
                emoticons,
            })
        })
        .collect()
}

pub(crate) fn emoticon_image_url(value: Option<&Value>) -> Option<String> {
    let candidate = bili_image_url(value)?;
    let url = Url::parse(&candidate).ok()?;
    // Platform static raster images only; no custom external URLs or SVG.
    let path = url.path().to_ascii_lowercase();
    if path.contains(".svg") {
        return None;
    }
    if [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]
        .iter()
        .any(|extension| path.ends_with(extension) || path.contains(&format!("{extension}@")))
    {
        Some(candidate)
    } else {
        None
    }
}

fn timestamp() -> Result<u64, BiliError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| BiliError::Protocol("系统时间无效"))
}

fn signed_send_query(now: u64, mixin: &str) -> Vec<(&'static str, String)> {
    let query = format!("web_location=444.8&wts={now}");
    let digest = format!("{:x}", md5::compute(format!("{query}{mixin}")));
    vec![
        ("web_location", "444.8".into()),
        ("wts", now.to_string()),
        ("w_rid", digest),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
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
        json!({"code":0,"data":{"isLogin":true,"mid":42,"wbi_img":{
            "img_url":"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            "sub_url":"https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
        }}})
    }

    fn own_room(limit: usize) -> Vec<Value> {
        vec![
            nav(),
            json!({"code":0,"data":{"room_id":123}}),
            json!({"code":0,"data":{"room_id":123,"uid":42,"live_status":0}}),
            json!({"code":0,"data":{"info":{"uid":42},"property":{"danmu":{"length":limit}}}}),
        ]
    }

    fn packs(perm: Value) -> Value {
        json!({"code":0,"data":{"data":[
            {"pkg_name":"平台表情","pkg_type":1,"pkg_perm":2,"emoticons":[
                {"emoticon_unique":"official_token!&中文","emoji":"测试","url":"//i0.hdslb.com/bfs/emote/image.png","perm":perm,"unlock_show_text":"权限提示"}
            ]},
            {"pkg_name":"文本表情","pkg_type":3,"emoticons":[
                {"descript":"[笑]","url":"https://i1.hdslb.com/bfs/emote/smile.png","perm":0}
            ]}
        ]}})
    }

    fn account_packs() -> Value {
        json!({"code":0,"data":{"packages":[{
            "id":77,"text":"个人收藏包","type":3,
            "url":"//i0.hdslb.com/bfs/emote/personal-cover.png",
            "flags":{"added":true},"meta":{"size":2},
            "emote":[{
                "id":88,"package_id":77,"type":3,"text":"[个人收藏包_花花]",
                "url":"https://i1.hdslb.com/bfs/emote/personal.png",
                "flags":{"unlocked":false},"meta":{"alias":"花花","size":2}
            }]
        }],"setting":{}}})
    }

    #[test]
    fn personal_packages_use_exact_account_fields_and_keep_original_markup() {
        let packs = parse_account_emoticons(&account_packs()).unwrap();
        assert_eq!(packs.len(), 1);
        let pack = &packs[0];
        assert_eq!(pack.source, "account");
        assert_eq!(pack.name, "个人收藏包");
        assert_eq!(pack.pkg_type, Some(3));
        assert_eq!(
            pack.icon.as_deref(),
            Some("https://i0.hdslb.com/bfs/emote/personal-cover.png")
        );
        let item = &pack.emoticons[0];
        assert_eq!(item.emoticon_unique, "account:77:88");
        assert_eq!(item.emoji, "[个人收藏包_花花]");
        assert_eq!(item.text.as_deref(), Some("[个人收藏包_花花]"));
        assert_eq!(item.kind, "text");
        assert!(
            item.allowed,
            "owned-panel flags.unlocked=false is not a live permission"
        );
        assert_eq!(
            item.url.as_deref(),
            Some("https://i1.hdslb.com/bfs/emote/personal.png")
        );
    }

    #[test]
    fn personal_package_and_emote_counts_and_order_are_preserved() {
        for count in [0, 1, 15, 101] {
            let rows: Vec<Value> = (0..count)
                .map(|pack| {
                    let package_id = pack + 1;
                    let items: Vec<Value> = (0..(15 + pack % 11))
                        .map(|item| {
                            json!({
                                "id":item+1,"package_id":package_id,
                                "text":format!("[原始第{pack}包_第{item}项]")
                            })
                        })
                        .collect();
                    json!({"id":package_id,"text":format!("第{pack}包"),"type":3,"emote":items})
                })
                .collect();
            let parsed =
                parse_account_emoticons(&json!({"code":0,"data":{"packages":rows}})).unwrap();
            assert_eq!(parsed.len(), count);
            for (pack, value) in parsed.iter().enumerate() {
                assert_eq!(value.name, format!("第{pack}包"));
                assert_eq!(value.emoticons.len(), 15 + pack % 11);
                for (item, value) in value.emoticons.iter().enumerate() {
                    assert_eq!(value.text, Some(format!("[原始第{pack}包_第{item}项]")));
                    assert_eq!(value.kind, "text");
                }
            }
        }
        assert!(
            parse_account_emoticons(&json!({"code":0,"data":{"packages":null}}))
                .unwrap()
                .is_empty()
        );
        assert!(parse_account_emoticons(&json!({"code":0,"data":{}})).is_err());
    }

    #[test]
    fn malformed_personal_identity_markup_and_images_are_rejected_or_filtered() {
        for (field, value) in [
            ("id", json!(0)),
            ("text", json!("")),
            ("text", json!("invalid\nmarkup")),
            ("package_id", json!(42)),
        ] {
            let mut invalid = account_packs();
            invalid["data"]["packages"][0]["emote"][0][field] = value;
            assert!(parse_account_emoticons(&invalid).is_err(), "{field}");
        }
        let mut duplicate = account_packs();
        let item = duplicate["data"]["packages"][0]["emote"][0].clone();
        duplicate["data"]["packages"][0]["emote"]
            .as_array_mut()
            .unwrap()
            .push(item);
        assert!(parse_account_emoticons(&duplicate).is_err());
        let mut unsafe_urls = account_packs();
        unsafe_urls["data"]["packages"][0]["url"] = json!("https://evil.example/cover.png");
        unsafe_urls["data"]["packages"][0]["emote"][0]["url"] = json!("javascript:attack()");
        let parsed = parse_account_emoticons(&unsafe_urls).unwrap();
        assert!(parsed[0].icon.is_none());
        assert!(parsed[0].emoticons[0].url.is_none());
        assert_eq!(
            parsed[0].emoticons[0].text.as_deref(),
            Some("[个人收藏包_花花]")
        );
    }

    #[test]
    fn platform_package_counts_and_item_order_are_not_fixed_or_truncated() {
        for count in [0, 1, 2, 5] {
            let rows: Vec<Value> = (0..count)
                .map(|pack| {
                    let items: Vec<Value> = (0..73)
                        .map(|item| json!({
                            "emoticon_unique": format!("pack{pack}:item{item}"),
                            "emoji": format!("原始第{item}项"),
                            "perm": if item % 3 == 0 { 0 } else { 1 }
                        }))
                        .collect();
                    json!({"pkg_name":format!("返回顺序{}", count-pack),"pkg_type":1,"emoticons":items})
                })
                .collect();
            let result = parse_emoticons(&json!({"code":0,"data":{"data":rows}})).unwrap();
            assert_eq!(result.len(), count);
            for (pack, value) in result.iter().enumerate() {
                assert_eq!(value.name, format!("返回顺序{}", count - pack));
                assert_eq!(value.emoticons.len(), 73);
                for (item, value) in value.emoticons.iter().enumerate() {
                    assert_eq!(value.emoticon_unique, format!("pack{pack}:item{item}"));
                    assert_eq!(value.allowed, item % 3 != 0);
                }
            }
        }
    }

    #[test]
    fn package_names_types_and_covers_use_the_official_component_fields() {
        let input = json!({"code":0,"data":{"data":[
            {"pkg_name":"原始名称 <花花>","pkg_type":1,"current_cover":"//i0.hdslb.com/bfs/emote/cover.png","pkg_icon":"https://evil.example/wrong.png","emoticons":[]},
            {"pkg_name":"文本包","pkg_type":3,"current_cover":"https://i1.hdslb.com/bfs/emote/cover.webp@64w.webp","emoticons":[]},
            {"pkg_name":"只有名称","pkg_icon":"https://i0.hdslb.com/bfs/emote/not-the-field.png","emoticons":[]}
        ]}});
        let result = parse_emoticons(&input).unwrap();
        assert_eq!(result[0].name, "原始名称 <花花>");
        assert_eq!(result[0].pkg_type, Some(1));
        assert_eq!(
            result[0].icon.as_deref(),
            Some("https://i0.hdslb.com/bfs/emote/cover.png")
        );
        assert_eq!(result[1].pkg_type, Some(3));
        assert_eq!(
            result[1].icon.as_deref(),
            Some("https://i1.hdslb.com/bfs/emote/cover.webp@64w.webp")
        );
        assert!(result[2].pkg_type.is_none());
        assert!(
            result[2].icon.is_none(),
            "an unverified field is not used as a cover fallback"
        );
        for name in [
            Value::Null,
            json!(""),
            json!("line\nfeed"),
            json!("a".repeat(257)),
        ] {
            let mut invalid = input.clone();
            invalid["data"]["data"][0]["pkg_name"] = name;
            assert!(parse_emoticons(&invalid).is_err());
        }
    }

    #[test]
    fn package_cover_filters_preserve_the_named_package_without_a_fake_icon() {
        for cover in [
            Value::Null,
            json!(""),
            json!("javascript:attack()"),
            json!("data:image/png;base64,abc"),
            json!("https://evil.example/emote.png"),
            json!("https://i0.hdslb.com.evil.example/emote.png"),
            json!("https://user@i0.hdslb.com/bfs/emote/test.png"),
            json!("https://i0.hdslb.com:444/bfs/emote/test.png"),
            json!("https://i0.hdslb.com/bfs/emote/test.svg"),
            json!("https://i0.hdslb.com/bfs/emote/test.svg@png"),
            json!("https://i0.hdslb.com/bfs/emote/no-extension"),
            json!("https://i0.hdslb.com/elsewhere/test.png"),
        ] {
            let input = json!({"code":0,"data":{"data":[{"pkg_name":"平台仍然可选的包","pkg_type":1,"current_cover":cover,"emoticons":[]}]}});
            let result = parse_emoticons(&input).unwrap();
            assert_eq!(result.len(), 1);
            assert_eq!(result[0].name, "平台仍然可选的包");
            assert!(result[0].icon.is_none(), "{cover}");
        }
    }

    async fn fixture(
        replies: Vec<Value>,
    ) -> (ChatSendClient, tokio::task::JoinHandle<Vec<String>>) {
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
                    assert!(size > 0);
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
            ChatSendClient {
                http: http_client().unwrap(),
                live_base: base.clone(),
                account_base: base,
            },
            task,
        )
    }

    fn form(request: &str) -> HashMap<String, String> {
        let (headers, body) = request.split_once("\r\n\r\n").unwrap();
        let boundary = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-type: multipart/form-data; boundary="))
            .unwrap();
        body.split(&format!("--{boundary}"))
            .filter_map(|part| {
                let part = part.strip_prefix("\r\n")?;
                let (header, value) = part.split_once("\r\n\r\n")?;
                let name = header
                    .strip_prefix("Content-Disposition: form-data; name=\"")?
                    .strip_suffix('"')?;
                Some((name.to_owned(), value.strip_suffix("\r\n")?.to_owned()))
            })
            .collect()
    }

    #[test]
    fn messages_use_platform_utf16_count_and_keep_content() {
        assert!(validate_message("🙂", 1).is_err());
        assert!(validate_message("🙂", 2).is_ok());
        assert!(validate_message(" 中文!&= ", 8).is_ok());
        for message in ["", "  ", "\n", "a\nb", "\u{0}", "\t"] {
            assert!(validate_message(message, 1000).is_err());
        }
        assert_eq!(message_limit(&json!({"data":{}})).unwrap(), 20);
        for length in [json!(0), json!(1001), json!("20"), json!(true)] {
            assert!(
                message_limit(&json!({"data":{"property":{"danmu":{"length":length}}}})).is_err()
            );
        }
    }

    #[test]
    fn emoticon_permissions_text_protocol_and_image_sources_are_explicit() {
        let packs = parse_emoticons(&packs(json!(1))).unwrap();
        assert!(packs[0].emoticons[0].allowed);
        assert_eq!(packs[0].emoticons[0].kind, "emoticon");
        assert_eq!(
            packs[0].emoticons[0].url.as_deref(),
            Some("https://i0.hdslb.com/bfs/emote/image.png")
        );
        assert_eq!(packs[1].emoticons[0].text.as_deref(), Some("[笑]"));
        assert_eq!(packs[1].emoticons[0].kind, "text");
        assert_eq!(
            packs[1].emoticons[0].emoticon_unique,
            text_item_identity("文本表情", "[笑]")
        );
        assert!(packs[1].emoticons[0].allowed);
        for perm in [json!(0), json!(2), json!(true), json!("1"), Value::Null] {
            assert!(!parse_emoticons(&self::packs(perm)).unwrap()[0].emoticons[0].allowed);
        }
        for url in [
            "https://evil.example/emote.png",
            "data:image/png;base64,abc",
            "https://i0.hdslb.com/bfs/emote/test.svg",
            "https://i0.hdslb.com/bfs/emote/image.svg@png",
            "https://user@i0.hdslb.com/bfs/emote/test.png",
            "https://i0.hdslb.com:444/bfs/emote/test.png",
        ] {
            assert!(emoticon_image_url(Some(&json!(url))).is_none(), "{url}");
        }
    }

    #[tokio::test]
    async fn plain_send_signs_only_query_preserves_form_and_uses_own_offline_room() {
        let mut replies = own_room(20);
        replies.push(json!({"code":0,"data":{"msg":""}}));
        let (client, task) = fixture(replies).await;
        let message = " 中文!&=🙂 ";
        assert_eq!(client.send_text(&session(), message).await.unwrap(), 123);
        let requests = task.await.unwrap();
        assert!(requests[1].starts_with("GET /room/v2/Room/room_id_by_uid?uid=42 "));
        assert!(requests[2].starts_with("GET /room/v1/Room/get_info?id=123 "));
        assert!(requests[3].starts_with("GET /xlive/web-room/v1/index/getInfoByUser?room_id=123 "));
        let write = &requests[4];
        let path = write
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let url = Url::parse(&format!("http://fixture{path}")).unwrap();
        let query = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert_eq!(query.len(), 3);
        let now = query["wts"].parse().unwrap();
        let mixin = nav_wbi_mixin(&nav(), true).unwrap();
        assert_eq!(query["w_rid"], signed_send_query(now, &mixin)[2].1);
        assert_eq!(query["web_location"], "444.8");
        let fields = form(write);
        assert_eq!(fields["msg"], message);
        assert_eq!(fields["roomid"], "123");
        assert_eq!(fields["mode"], "1");
        assert_eq!(fields["color"], "16777215");
        assert_eq!(fields["fontsize"], "25");
        assert_eq!(fields["rnd"], query["wts"]);
        assert_eq!(fields["data_extend"], "{}");
        assert_eq!(fields["csrf"], "fictional-csrf");
        assert_eq!(fields["csrf_token"], "fictional-csrf");
        assert!(!fields.contains_key("dm_type"));
    }

    #[tokio::test]
    async fn refresh_exposes_current_room_limit_and_platform_packs() {
        let mut replies = own_room(30);
        replies.push(account_packs());
        replies.push(packs(json!(1)));
        let (client, task) = fixture(replies).await;
        let view = client.refresh(&session()).await.unwrap();
        assert_eq!(view.room_id, 123);
        assert_eq!(view.message_limit, 30);
        assert_eq!(view.emoticons.len(), 3);
        assert_eq!(view.emoticons[0].source, "account");
        assert_eq!(view.emoticons[1].source, "live");
        assert_eq!(view.emoticons[0].emoticons[0].kind, "text");
        assert!(view.warnings.is_empty());
        let requests = task.await.unwrap();
        assert!(requests[4].starts_with("GET /x/emote/user/panel/web?business=reply "));
        assert!(requests[4].contains("cookie: SESSDATA=fictional-session"));
        assert!(requests[5].contains("GetEmoticons?platform=pc&room_id=123"));
        assert!(requests.iter().all(|request| request.starts_with("GET ")));
    }

    #[tokio::test]
    async fn partial_personal_or_live_source_failure_is_visible_without_silent_fallback() {
        for (account, live, expected_source, warning) in [
            (
                json!({"code":-400}),
                packs(json!(1)),
                "live",
                "个人表情读取失败",
            ),
            (
                account_packs(),
                json!({"code":-500}),
                "account",
                "直播表情读取失败",
            ),
        ] {
            let mut replies = own_room(30);
            replies.extend([account, live]);
            let (client, task) = fixture(replies).await;
            let view = client.refresh(&session()).await.unwrap();
            assert!(
                view.emoticons
                    .iter()
                    .all(|pack| pack.source == expected_source)
            );
            assert_eq!(view.warnings.len(), 1);
            assert!(view.warnings[0].starts_with(warning));
            assert_eq!(task.await.unwrap().len(), 6);
        }
        let mut replies = own_room(30);
        replies.extend([json!({"code":-400}), json!({"code":-500})]);
        let (client, task) = fixture(replies).await;
        assert!(client.refresh(&session()).await.is_err());
        assert_eq!(task.await.unwrap().len(), 6);
    }

    #[tokio::test]
    async fn expired_personal_or_live_source_invalidates_the_entire_refresh() {
        let mut replies = own_room(30);
        replies.push(json!({"code":-101,"message":"fictional-secret-response"}));
        let (client, task) = fixture(replies).await;
        assert_eq!(
            client.refresh(&session()).await.unwrap_err(),
            BiliError::SessionExpired
        );
        assert_eq!(
            task.await.unwrap().len(),
            5,
            "no live-source request after an expired account reply"
        );
        let mut replies = own_room(30);
        replies.extend([account_packs(), json!({"code":-101})]);
        let (client, task) = fixture(replies).await;
        assert_eq!(
            client.refresh(&session()).await.unwrap_err(),
            BiliError::SessionExpired
        );
        assert_eq!(task.await.unwrap().len(), 6);
    }

    #[tokio::test]
    async fn emote_send_refreshes_permission_and_posts_exact_platform_token() {
        let mut replies = own_room(20);
        replies.extend([packs(json!(1)), json!({"code":0})]);
        let (client, task) = fixture(replies).await;
        let token = "official_token!&中文";
        assert_eq!(client.send_emoticon(&session(), token).await.unwrap(), 123);
        let requests = task.await.unwrap();
        let fields = form(&requests[5]);
        assert_eq!(fields["msg"], token);
        assert_eq!(fields["dm_type"], "1");
        assert_eq!(fields["roomid"], "123");
    }

    #[tokio::test]
    async fn locked_or_missing_live_items_never_send_a_write() {
        for (perm, token) in [(json!(0), "official_token!&中文"), (json!(1), "missing")] {
            let mut replies = own_room(20);
            replies.push(packs(perm));
            let (client, task) = fixture(replies).await;
            assert!(client.send_emoticon(&session(), token).await.is_err());
            assert_eq!(task.await.unwrap().len(), 5);
        }
    }

    #[tokio::test]
    async fn personal_item_send_rechecks_actual_id_and_sends_original_markup_once() {
        let mut replies = own_room(20);
        replies.extend([account_packs(), json!({"code":0})]);
        let (client, task) = fixture(replies).await;
        assert_eq!(
            client
                .send_emoticon(&session(), "account:77:88")
                .await
                .unwrap(),
            123
        );
        let requests = task.await.unwrap();
        assert!(requests[4].starts_with("GET /x/emote/user/panel/web?business=reply "));
        assert!(requests[5].starts_with("POST /msg/send?"));
        let fields = form(&requests[5]);
        assert_eq!(fields["msg"], "[个人收藏包_花花]");
        assert_eq!(fields["roomid"], "123");
        assert!(!fields.contains_key("dm_type"));
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
        assert!(
            requests
                .iter()
                .all(|request| !request.contains("GetEmoticons"))
        );
    }

    #[tokio::test]
    async fn live_text_item_click_sends_original_text_as_a_separate_regular_message() {
        let mut replies = own_room(20);
        replies.extend([packs(json!(1)), json!({"code":0})]);
        let (client, task) = fixture(replies).await;
        assert_eq!(
            client
                .send_emoticon(&session(), &text_item_identity("文本表情", "[笑]"))
                .await
                .unwrap(),
            123
        );
        let requests = task.await.unwrap();
        assert!(requests[4].contains("GetEmoticons?platform=pc&room_id=123"));
        let fields = form(&requests[5]);
        assert_eq!(fields["msg"], "[笑]");
        assert!(!fields.contains_key("dm_type"));
    }

    #[tokio::test]
    async fn live_text_item_identity_survives_fresh_package_and_item_reordering() {
        let mut initial = packs(json!(1));
        initial["data"]["data"][1]["emoticons"]
            .as_array_mut()
            .unwrap()
            .push(json!({"descript":"[花]","perm":0}));
        let initial = parse_emoticons(&initial).unwrap();
        let selected = &initial[1].emoticons[0].emoticon_unique;
        let mut fresh = packs(json!(1));
        fresh["data"]["data"][1]["emoticons"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({"descript":"[花]","perm":0}));
        fresh["data"]["data"].as_array_mut().unwrap().reverse();
        let mut replies = own_room(20);
        replies.extend([fresh, json!({"code":0})]);
        let (client, task) = fixture(replies).await;
        assert_eq!(
            client.send_emoticon(&session(), selected).await.unwrap(),
            123
        );
        let requests = task.await.unwrap();
        assert_eq!(form(&requests[5])["msg"], "[笑]");
    }

    #[tokio::test]
    async fn missing_removed_expired_or_too_long_personal_items_never_write_or_fallback() {
        for (panel, token, limit, expected_error) in [
            (account_packs(), "account:77:89", 20, None),
            (
                json!({"code":0,"data":{"packages":[]}}),
                "account:77:88",
                20,
                None,
            ),
            (
                json!({"code":-101}),
                "account:77:88",
                20,
                Some(BiliError::SessionExpired),
            ),
            (
                json!({"code":-400}),
                "account:77:88",
                20,
                Some(BiliError::Api(-400)),
            ),
            (account_packs(), "account:77:88", 3, None),
        ] {
            let mut replies = own_room(limit);
            replies.push(panel);
            let (client, task) = fixture(replies).await;
            let error = client.send_emoticon(&session(), token).await.unwrap_err();
            if let Some(expected) = expected_error {
                assert_eq!(error, expected);
            }
            let requests = task.await.unwrap();
            assert_eq!(requests.len(), 5);
            assert!(requests.iter().all(|request| request.starts_with("GET ")));
            assert!(
                requests
                    .iter()
                    .all(|request| !request.contains("GetEmoticons"))
            );
        }
    }

    #[tokio::test]
    async fn personal_send_failure_does_not_retry_or_switch_to_an_image_token() {
        let mut replies = own_room(20);
        replies.extend([account_packs(), json!({"code":403})]);
        let (client, task) = fixture(replies).await;
        assert_eq!(
            client
                .send_emoticon(&session(), "account:77:88")
                .await
                .unwrap_err(),
            BiliError::Api(403)
        );
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 6);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
        assert!(!form(&requests[5]).contains_key("dm_type"));
    }

    #[tokio::test]
    async fn fresh_length_limit_prevents_send_without_truncating() {
        let (client, task) = fixture(own_room(3)).await;
        assert!(client.send_text(&session(), "🙂🙂").await.is_err());
        assert_eq!(task.await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn identity_expiration_and_wbi_failure_never_send_or_fallback() {
        for reply in [
            json!({"code":-101,"message":"fictional-private-response"}),
            json!({"code":0,"data":{"isLogin":true,"mid":7}}),
            json!({"code":0,"data":{"isLogin":true,"mid":42}}),
        ] {
            let (client, task) = fixture(vec![reply]).await;
            let error = client.send_text(&session(), "你好").await.unwrap_err();
            assert!(!error.to_string().contains("fictional-private-response"));
            assert_eq!(task.await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn room_owner_and_current_account_are_reverified_before_write() {
        let mut replies = own_room(20);
        replies[2]["data"]["uid"] = json!(7);
        replies.truncate(3);
        let (client, task) = fixture(replies).await;
        assert!(client.send_text(&session(), "你好").await.is_err());
        assert_eq!(task.await.unwrap().len(), 3);
        let mut replies = own_room(20);
        replies[3]["data"]["info"]["uid"] = json!(7);
        let (client, task) = fixture(replies).await;
        assert!(client.send_text(&session(), "你好").await.is_err());
        assert_eq!(task.await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn platform_send_failure_is_not_success_and_message_is_redacted() {
        let mut replies = own_room(20);
        replies.push(json!({"code":403,"message":"fictional-private-response"}));
        let (client, task) = fixture(replies).await;
        let error = client.send_text(&session(), "你好").await.unwrap_err();
        assert_eq!(error, BiliError::Api(403));
        assert!(!error.to_string().contains("fictional-private-response"));
        assert_eq!(task.await.unwrap().len(), 5);
    }

    #[test]
    fn code_zero_filtering_and_uncertain_messages_never_report_success() {
        assert!(
            parse_send_result(&json!({"code":0,"msg":"f"}))
                .unwrap_err()
                .to_string()
                .contains("平台拦截")
        );
        assert!(
            parse_send_result(&json!({"code":0,"msg":"k"}))
                .unwrap_err()
                .to_string()
                .contains("直播间屏蔽")
        );
        for value in [
            json!({"code":0,"msg":"fictional-private-response"}),
            json!({"code":0,"data":{"msg":"fictional-private-response"}}),
            json!({"code":0,"msg":true}),
        ] {
            let error = parse_send_result(&value).unwrap_err();
            assert!(!error.to_string().contains("fictional-private-response"));
        }
        assert!(parse_send_result(&json!({"code":0,"msg":"","data":{"msg":""}})).is_ok());
    }
}
