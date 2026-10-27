//! Native Bilibili broadcast management, independent of OBS and live-chat reception.
//! Protocol reference: Zarosmm/obs-bilibili-stream at
//! 051cf769d63a9b7111382f3f6cf7baaed0257b05.
//! This is an independent implementation of the HTTP protocol, not linked plugin code.
use std::{
    fmt,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::{
    Client, Url,
    header::{COOKIE, HeaderName, ORIGIN, REFERER, USER_AGENT},
};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::bilibili::{BiliError, BiliSession, http_client, read_json};

// Public protocol application identity used by the referenced desktop live client.
// These are not user credentials. There is no access-token import or provider fallback.
const APP_KEY: &str = "aae92bc66f3edfab";
const APP_SECRET: &str = "af125a0d5279fd576c1b4418a3e8276d";
const API: &str = "https://api.live.bilibili.com";
/// The desktop client identifies itself to the app-blink API with this exact
/// shape (`LiveHime/{version} os/Windows pc_app/livehime build/{build}
/// osVer/{os}_{arch}`, from `bililive_secret.dll`). Browser-style requests to
/// the same endpoints are what the web page sends, and they take a different
/// risk path when a broadcast is opened.
const LIVEHIME_OS_VERSION: &str = "10.0_x86_64";

fn livehime_user_agent(version: &str, build: u64) -> String {
    format!(
        "LiveHime/{version} os/Windows pc_app/livehime build/{build} osVer/{LIVEHIME_OS_VERSION}"
    )
}

/// The desktop client sends its device identity in this header on every
/// app-blink request, in addition to the `buvid3` cookie.
const BUVID: HeaderName = HeaderName::from_static("buvid");

/// Last version/build this process learned from the app-blink API. Each command
/// builds its own client, and the face-status poll must speak with the same
/// identity as the startLive call that created its challenge, so the pair is
/// remembered across clients. Only the desktop client identity reads it.
static ANNOUNCED_VERSION: Mutex<Option<(u64, String)>> = Mutex::new(None);

/// The device identity the desktop client presents as `buvid`. It belongs to
/// one installation (data directory), not to the logged-in account, so logout,
/// session expiry and re-login keep presenting the same device. Generated
/// locally once: no registration request is made for it.
#[derive(Clone, PartialEq, Eq)]
pub struct LivehimeDevice(String);

impl LivehimeDevice {
    /// The desktop client's own shape (`%s%duser` in `bililive_secret.dll`,
    /// the same as StartLive's `gen_buvid`): an upper-case hyphenated UUID,
    /// the process id, then `user`.
    pub fn generate() -> Self {
        Self(format!(
            "{}{}user",
            Uuid::new_v4().hyphenated().to_string().to_uppercase(),
            std::process::id()
        ))
    }

    /// Accept only the generated shape; the value goes verbatim into a header
    /// and a cookie.
    pub fn parse(value: &str) -> Result<Self, BiliError> {
        let valid = value.is_ascii()
            && value
                .strip_suffix("user")
                .filter(|rest| (37..=46).contains(&rest.len()))
                .is_some_and(|rest| {
                    let (uuid, pid) = rest.split_at(36);
                    Uuid::parse_str(uuid).is_ok()
                        && uuid.bytes().filter(|b| *b == b'-').count() == 4
                        && !uuid.bytes().any(|b| b.is_ascii_lowercase())
                        && pid.bytes().all(|b| b.is_ascii_digit())
                });
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(BiliError::Protocol("直播姬设备标识无效"))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LivehimeDevice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LivehimeDevice([redacted])")
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LiveArea {
    pub id: u64,
    pub name: String,
    pub children: Vec<LiveSubArea>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct LiveSubArea {
    pub id: u64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BroadcastRoom {
    pub room_id: u64,
    pub title: String,
    pub parent_area_id: u64,
    pub area_id: u64,
    pub live_status: u64,
    /// When the current broadcast began, in Unix seconds, while the room is live.
    pub live_since: Option<u64>,
}

/// Only returned to an explicit reveal/copy command; never part of polling or exports.
#[derive(Serialize)]
pub struct PushCredentials {
    pub address: String,
    pub stream_key: String,
}

impl fmt::Debug for PushCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PushCredentials([redacted])")
    }
}

impl Drop for PushCredentials {
    fn drop(&mut self) {
        self.address.zeroize();
        self.stream_key.zeroize();
    }
}

pub enum StartBroadcast {
    Started(PushCredentials),
    FaceVerification { url: Zeroizing<String>, code: u64 },
}

impl fmt::Debug for StartBroadcast {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Started(_) => f.write_str("Started([redacted])"),
            Self::FaceVerification { code, .. } => f
                .debug_struct("FaceVerification")
                .field("code", code)
                .field("url", &"[redacted]")
                .finish(),
        }
    }
}

/// Who the request pretends to be. `room/v1` endpoints serve both the web
/// page under `link.bilibili.com` and the desktop client; the client identity
/// decides which headers accompany the call. Opening a broadcast and its face
/// check are performed as the desktop client, always with a known version so
/// no request mixes a browser User-Agent with desktop headers.
#[derive(Clone, Copy)]
enum ClientIdentity<'a> {
    Web,
    Desktop { build: u64, version: &'a str },
}

pub struct BroadcastClient {
    http: Client,
    base: Url,
    device: LivehimeDevice,
    /// Version and build announced by the app-blink API. The desktop client
    /// signs with the same pair and repeats it in its User-Agent. Production
    /// shares `ANNOUNCED_VERSION`; tests get their own slot.
    versions: &'static Mutex<Option<(u64, String)>>,
}

impl BroadcastClient {
    pub fn new(device: LivehimeDevice) -> Result<Self, BiliError> {
        Ok(Self {
            http: http_client()?,
            base: Url::parse(API).expect("fixed API URL"),
            device,
            versions: &ANNOUNCED_VERSION,
        })
    }

    /// Ask the app-blink API for the current desktop version and remember it.
    async fn fetch_version(&self, session: &BiliSession) -> Result<(u64, String), BiliError> {
        let query = signed_params(vec![
            ("system_version".into(), "2".into()),
            ("ts".into(), timestamp()?.to_string()),
        ]);
        let response = self
            .request(
                "/xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion",
                Some(session),
                false,
                // Public metadata endpoint also used by the web page; the
                // desktop User-Agent needs the version this call returns.
                ClientIdentity::Web,
            )
            .query(&*query)
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        let announced = parse_version(&read_json(response).await?)?;
        if let Ok(mut slot) = self.versions.lock() {
            *slot = Some(announced.clone());
        }
        Ok(announced)
    }

    /// The remembered version, fetched first when this process has none yet
    /// (for example a face check after the app restarted).
    async fn desktop_version(&self, session: &BiliSession) -> Result<(u64, String), BiliError> {
        match self.versions.lock().ok().and_then(|slot| slot.clone()) {
            Some(announced) => Ok(announced),
            None => self.fetch_version(session).await,
        }
    }

    fn request(
        &self,
        path: &str,
        session: Option<&BiliSession>,
        post: bool,
        identity: ClientIdentity<'_>,
    ) -> reqwest::RequestBuilder {
        let url = self.base.join(path).expect("fixed relative API path");
        let mut request = if post {
            self.http.post(url)
        } else {
            self.http.get(url)
        };
        let cookie = match identity {
            // The desktop client sends no browser Origin/Referer to its API;
            // it names its device in a `buvid` header and the `buvid3` cookie.
            ClientIdentity::Desktop { build, version } => {
                request = request
                    .header(USER_AGENT, livehime_user_agent(version, build))
                    .header(BUVID, self.device.as_str());
                session.map(|s| s.desktop_cookie_header(self.device.as_str()))
            }
            ClientIdentity::Web => {
                request = request
                    .header(ORIGIN, "https://link.bilibili.com")
                    .header(REFERER, "https://link.bilibili.com/p/center/index");
                session.map(BiliSession::cookie_header)
            }
        };
        if let Some(cookie) = cookie.map(Zeroizing::new) {
            request = request.header(COOKIE, cookie.as_str());
        }
        request
    }

    async fn get(
        &self,
        path: &str,
        session: Option<&BiliSession>,
        query: &[(&str, String)],
    ) -> Result<Value, BiliError> {
        let response = self
            .request(path, session, false, ClientIdentity::Web)
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
        identity: ClientIdentity<'_>,
    ) -> Result<Value, BiliError> {
        let response = self
            .request(path, Some(session), true, identity)
            .form(params)
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        read_json(response).await
    }

    /// Resolve from the authenticated UID, never from the watched-room setting.
    pub async fn own_room(&self, session: &BiliSession) -> Result<BroadcastRoom, BiliError> {
        let value = self
            .get(
                "/room/v2/Room/room_id_by_uid",
                Some(session),
                &[("uid", session.user_id().to_string())],
            )
            .await?;
        api_ok(&value)?;
        let room_id = id(&value["data"]["room_id"])
            .filter(|id| *id > 0)
            .ok_or(BiliError::NoOwnRoom)?;
        let value = self
            .get(
                "/room/v1/Room/get_info",
                Some(session),
                &[("id", room_id.to_string())],
            )
            .await?;
        parse_room(&value, session.user_id(), room_id)
    }

    pub async fn areas(&self) -> Result<Vec<LiveArea>, BiliError> {
        parse_areas(&self.get("/room/v1/Area/getList", None, &[]).await?)
    }

    /// Resolve ownership and validate against the current server list before every write.
    pub async fn update(
        &self,
        session: &BiliSession,
        title: &str,
        area_id: u64,
    ) -> Result<BroadcastRoom, BiliError> {
        validate_title(title)?;
        validate_area(&self.areas().await?, area_id)?;
        let mut room = self.own_room(session).await?;
        let mut params = csrf_params(session, room.room_id);
        params.push(("title".into(), title.trim().into()));
        params.push(("area_id".into(), area_id.to_string()));
        api_ok(
            &self
                .post(
                    "/room/v1/Room/update",
                    session,
                    &params,
                    ClientIdentity::Web,
                )
                .await?,
        )?;
        room.title = title.trim().into();
        room.area_id = area_id;
        Ok(room)
    }

    pub async fn start(
        &self,
        session: &BiliSession,
        area_id: u64,
    ) -> Result<(BroadcastRoom, StartBroadcast), BiliError> {
        validate_area(&self.areas().await?, area_id)?;
        let mut room = self.own_room(session).await?;
        let now = timestamp()?;
        // Always the current version when opening a room; the face check
        // that may follow reuses it.
        let (build, version) = self.fetch_version(session).await?;
        let mut params = csrf_params(session, room.room_id);
        params.extend([
            ("area_v2".into(), area_id.to_string()),
            ("backup_stream".into(), "0".into()),
            ("build".into(), build.to_string()),
            ("version".into(), version.clone()),
            ("ts".into(), timestamp()?.to_string()),
            // Sent by StartLive with the same signed parameter set.
            ("type".into(), "2".into()),
        ]);
        let params = signed_params(params);
        let result = parse_start(
            &self
                .post(
                    "/room/v1/Room/startLive",
                    session,
                    &params,
                    ClientIdentity::Desktop {
                        build,
                        version: &version,
                    },
                )
                .await?,
            session.user_id(),
        )?;
        room.area_id = area_id;
        if matches!(result, StartBroadcast::Started(_)) {
            room.live_status = 1;
            room.live_since = room.live_since.or(Some(now));
        }
        Ok((room, result))
    }

    /// Check the server-side result of an existing 60024 challenge. This does
    /// not open the room, create a new challenge, or establish a reusable grant.
    pub async fn face_verification_status(
        &self,
        session: &BiliSession,
        room_id: u64,
    ) -> Result<bool, BiliError> {
        if room_id == 0 {
            return Err(BiliError::Protocol("直播间无效"));
        }
        let params = Zeroizing::new(vec![
            ("room_id".into(), room_id.to_string()),
            ("face_auth_code".into(), "60024".into()),
            ("csrf_token".into(), session.csrf().into()),
            ("csrf".into(), session.csrf().into()),
            ("visit_id".into(), String::new()),
        ]);
        let (build, version) = self.desktop_version(session).await?;
        let value = self
            .post(
                "/xlive/app-blink/v1/preLive/IsUserIdentifiedByFaceAuth",
                session,
                &params,
                ClientIdentity::Desktop {
                    build,
                    version: &version,
                },
            )
            .await?;
        api_ok(&value)?;
        match &value["data"]["is_identified"] {
            Value::Bool(identified) => Ok(*identified),
            Value::Number(n) if n.as_u64() == Some(0) => Ok(false),
            Value::Number(n) if n.as_u64() == Some(1) => Ok(true),
            _ => Err(BiliError::Protocol("人脸验证状态无效")),
        }
    }

    pub async fn stop(&self, session: &BiliSession) -> Result<BroadcastRoom, BiliError> {
        let mut room = self.own_room(session).await?;
        let params = Zeroizing::new(csrf_params(session, room.room_id));
        api_ok(
            &self
                .post(
                    "/room/v1/Room/stopLive",
                    session,
                    &params,
                    ClientIdentity::Web,
                )
                .await?,
        )?;
        room.live_status = 0;
        room.live_since = None;
        Ok(room)
    }
}

fn api_ok(value: &Value) -> Result<(), BiliError> {
    match value.get("code").and_then(Value::as_i64) {
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
        .filter(|id| *id <= u32::MAX as u64)
}

fn text(value: &Value, limit: usize) -> Result<String, BiliError> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= limit && !v.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or(BiliError::Protocol("直播管理字段无效"))
}

fn parse_room(value: &Value, owner: u64, expected_room: u64) -> Result<BroadcastRoom, BiliError> {
    api_ok(value)?;
    let data = &value["data"];
    if data["uid"]
        .as_u64()
        .or_else(|| data["uid"].as_str()?.parse().ok())
        != Some(owner)
        || id(&data["room_id"]) != Some(expected_room)
    {
        return Err(BiliError::Protocol("直播间与当前登录账号不匹配"));
    }
    let live_status = id(&data["live_status"])
        .filter(|v| *v <= 2)
        .ok_or(BiliError::Protocol("开播状态无效"))?;
    Ok(BroadcastRoom {
        room_id: expected_room,
        title: text(&data["title"], 1024)?,
        parent_area_id: id(&data["parent_area_id"]).ok_or(BiliError::Protocol("直播分区无效"))?,
        area_id: id(&data["area_id"]).ok_or(BiliError::Protocol("直播分区无效"))?,
        live_status,
        // Only a live room has a start time; an unreadable one just hides the timer.
        live_since: (live_status == 1)
            .then(|| data["live_time"].as_str().and_then(beijing_unix_seconds))
            .flatten(),
    })
}

/// Bilibili reports `live_time` as `YYYY-MM-DD HH:MM:SS` in China Standard Time (UTC+8);
/// a room that is not live reports `0000-00-00 00:00:00`.
fn beijing_unix_seconds(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() != 19
        || [4, 7].iter().any(|&i| bytes[i] != b'-')
        || bytes[10] != b' '
        || [13, 16].iter().any(|&i| bytes[i] != b':')
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = value.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(2000..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Days from the civil date (proleptic Gregorian), Howard Hinnant's algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - 8 * 3_600;
    u64::try_from(seconds).ok()
}

fn parse_areas(value: &Value) -> Result<Vec<LiveArea>, BiliError> {
    api_ok(value)?;
    let rows = value["data"]
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 100)
        .ok_or(BiliError::Protocol("直播分区列表无效"))?;
    let mut seen = std::collections::HashSet::new();
    let mut parents = std::collections::HashSet::new();
    rows.iter()
        .map(|row| {
            let parent = id(&row["id"])
                .filter(|id| *id > 0 && parents.insert(*id))
                .ok_or(BiliError::Protocol("直播分区无效"))?;
            let children = row["list"]
                .as_array()
                .filter(|v| v.len() <= 1000)
                .ok_or(BiliError::Protocol("直播子分区无效"))?;
            let children = children
                .iter()
                .filter(|row| id(&row["lock_status"]).unwrap_or(0) == 0)
                .map(|row| {
                    let child = id(&row["id"])
                        .filter(|id| *id > 0 && seen.insert(*id))
                        .ok_or(BiliError::Protocol("直播子分区无效"))?;
                    Ok(LiveSubArea {
                        id: child,
                        name: text(&row["name"], 256)?,
                    })
                })
                .collect::<Result<Vec<_>, BiliError>>()?;
            Ok(LiveArea {
                id: parent,
                name: text(&row["name"], 256)?,
                children,
            })
        })
        .collect()
}

fn validate_area(areas: &[LiveArea], area: u64) -> Result<(), BiliError> {
    if areas
        .iter()
        .any(|p| p.children.iter().any(|c| c.id == area))
    {
        Ok(())
    } else {
        Err(BiliError::Protocol("请选择当前可用的直播子分区"))
    }
}

pub fn validate_title(title: &str) -> Result<(), BiliError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 40 || title.chars().any(char::is_control) {
        Err(BiliError::Protocol(
            "直播标题须为 1 到 40 个字符，且不能包含换行",
        ))
    } else {
        Ok(())
    }
}

fn csrf_params(session: &BiliSession, room: u64) -> Vec<(String, String)> {
    vec![
        ("room_id".into(), room.to_string()),
        ("platform".into(), "pc_link".into()),
        ("csrf".into(), session.csrf().into()),
        ("csrf_token".into(), session.csrf().into()),
    ]
}

fn timestamp() -> Result<u64, BiliError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| BiliError::Protocol("系统时间无效"))
}

fn signed_params(mut params: Vec<(String, String)>) -> Zeroizing<Vec<(String, String)>> {
    params.push(("appkey".into(), APP_KEY.into()));
    // The desktop client's signer always includes an `access_key` field, empty
    // for a cookie-authenticated session. Sending the same parameter set keeps
    // the request shaped like the client it claims to be.
    params.push(("access_key".into(), String::new()));
    params.sort();
    let mut serializer = reqwest::Url::parse("https://example.invalid").expect("fixed URL");
    serializer.query_pairs_mut().extend_pairs(&params);
    let digest = {
        let raw = Zeroizing::new(format!(
            "{}{APP_SECRET}",
            serializer.query().unwrap_or_default()
        ));
        format!("{:x}", md5::compute(raw.as_bytes()))
    };
    params.push(("sign".into(), digest));
    Zeroizing::new(params)
}

fn parse_version(value: &Value) -> Result<(u64, String), BiliError> {
    api_ok(value)?;
    let build = id(&value["data"]["build"])
        .filter(|v| *v > 0)
        .ok_or(BiliError::Protocol("直播客户端版本无效"))?;
    let version = text(&value["data"]["curr_version"], 64)?;
    Ok((build, version))
}

fn parse_start(value: &Value, uid: u64) -> Result<StartBroadcast, BiliError> {
    match value["code"].as_i64() {
        Some(60024 | 60043) => {
            if value["code"] == 60043
                && value["data"]["risk_extra"]["v_voucher"]
                    .as_str()
                    .is_some_and(|voucher| !voucher.trim().is_empty())
            {
                return Err(BiliError::Protocol(
                    "B站新版人脸验证暂不支持，请使用官方直播姬开播",
                ));
            }
            let url = if value["code"] == 60043 {
                format!(
                    "https://www.bilibili.com/blackboard/live/face-auth-middle.html?source_event=400&mid={uid}"
                )
            } else {
                text(&value["data"]["qr"], 4096)?
            };
            let parsed = Url::parse(&url).map_err(|_| BiliError::Protocol("人脸验证地址无效"))?;
            if parsed.scheme() != "https"
                || parsed.port().is_some()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || !matches!(
                    parsed.host_str(),
                    Some("www.bilibili.com" | "live.bilibili.com" | "link.bilibili.com")
                )
            {
                return Err(BiliError::Protocol("人脸验证地址无效"));
            }
            return Ok(StartBroadcast::FaceVerification {
                url: Zeroizing::new(url),
                code: value["code"].as_u64().expect("matched positive code"),
            });
        }
        _ => api_ok(value)?,
    }
    let address = text(&value["data"]["rtmp"]["addr"], 4096)?;
    let stream_key = text(&value["data"]["rtmp"]["code"], 8192)?;
    let parsed = Url::parse(&address).map_err(|_| BiliError::Protocol("推流地址无效"))?;
    let host = parsed.host_str().unwrap_or_default();
    if !matches!(parsed.scheme(), "rtmp" | "rtmps")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !(host.ends_with(".bilivideo.com") || host.ends_with(".bilibili.com"))
    {
        return Err(BiliError::Protocol("推流地址无效"));
    }
    Ok(StartBroadcast::Started(PushCredentials {
        address,
        stream_key,
    }))
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
    fn areas() -> Value {
        json!({"code":0,"data":[{"id": "2", "name":"网游", "list":[
            {"id":"86","name":"英雄联盟","lock_status":"0"},
            {"id":"87","name":"锁定分区","lock_status":"1"}]}]})
    }
    fn room() -> Value {
        json!({"code":0,"data":{"uid":42,"room_id":123,"title":"中文直播", "parent_area_id":2,"area_id":86,"live_status":0}})
    }

    async fn fixture(
        replies: Vec<Value>,
    ) -> (BroadcastClient, tokio::task::JoinHandle<Vec<String>>) {
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
                    let mut buf = [0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0 && bytes.len() < 64 * 1024);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|v| {
                                v.strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = reply.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            requests
        });
        let http = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        (
            BroadcastClient {
                http,
                base,
                device: LivehimeDevice::parse(DEVICE).unwrap(),
                // Each fixture starts like a fresh process.
                versions: Box::leak(Box::new(Mutex::new(None))),
            },
            task,
        )
    }

    const DEVICE: &str = "0C1D2E3F-4A5B-4C6D-8E9F-A0B1C2D3E4F512345user";
    fn version() -> Value {
        json!({"code":0,"data":{"build":9999,"curr_version":"9.9.9"}})
    }

    fn form(request: &str) -> std::collections::BTreeMap<String, String> {
        Url::parse(&format!(
            "https://example.invalid/?{}",
            request.split("\r\n\r\n").nth(1).unwrap()
        ))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
    }

    #[tokio::test]
    async fn face_status_uses_existing_room_and_never_starts_or_creates_a_challenge() {
        let (client, task) = fixture(vec![
            // A process that has not opened a room yet learns the version once.
            version(),
            json!({"code":0,"data":{"is_identified":false}}),
            json!({"code":0,"data":{"is_identified":true}}),
            json!({"code":0,"data":{"is_identified":2}}),
            json!({"code":-101}),
        ])
        .await;
        assert!(
            !client
                .face_verification_status(&session(), 123)
                .await
                .unwrap()
        );
        assert!(
            client
                .face_verification_status(&session(), 123)
                .await
                .unwrap()
        );
        assert!(
            client
                .face_verification_status(&session(), 123)
                .await
                .is_err()
        );
        assert!(
            client
                .face_verification_status(&session(), 123)
                .await
                .is_err()
        );
        let mut requests = task.await.unwrap();
        let version = requests.remove(0);
        assert!(
            version.starts_with("GET /xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion?")
        );
        assert_eq!(requests.len(), 4);
        for request in requests {
            assert!(
                request.starts_with("POST /xlive/app-blink/v1/preLive/IsUserIdentifiedByFaceAuth ")
            );
            // Never a browser User-Agent on a desktop-identity request.
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("user-agent: livehime/9.9.9 ")
            );
            let params = form(&request);
            assert_eq!(params["room_id"], "123");
            assert_eq!(params["face_auth_code"], "60024");
            assert_eq!(params["csrf"], "fictional-csrf");
            assert_eq!(params["csrf_token"], "fictional-csrf");
            assert_eq!(params["visit_id"], "");
            assert!(request.contains("cookie: SESSDATA=fictional-session"));
            assert!(!request.contains("startLive"));
        }
    }

    #[tokio::test]
    async fn update_uses_authenticated_owner_csrf_and_encoded_unicode() {
        let (client, task) = fixture(vec![
            areas(),
            json!({"code":0,"data":{"room_id":123}}),
            room(),
            json!({"code":0}),
        ])
        .await;
        let updated = client
            .update(&session(), "中文 & 标题=测试", 86)
            .await
            .unwrap();
        assert_eq!(updated.room_id, 123);
        assert_eq!(updated.title, "中文 & 标题=测试");
        let requests = task.await.unwrap();
        assert!(requests[1].starts_with("GET /room/v2/Room/room_id_by_uid?uid=42 "));
        assert!(requests[3].starts_with("POST /room/v1/Room/update "));
        let params = form(&requests[3]);
        assert_eq!(params["title"], "中文 & 标题=测试");
        assert_eq!(params["csrf"], "fictional-csrf");
        assert_eq!(params["csrf_token"], "fictional-csrf");
        assert_eq!(params["room_id"], "123");
        assert_eq!(params["area_id"], "86");
        assert!(requests[3].contains("cookie: SESSDATA=fictional-session"));
    }

    #[tokio::test]
    async fn signed_start_fetches_current_version_and_returns_redacted_secrets() {
        let (client, task) = fixture(vec![areas(), json!({"code":0,"data":{"room_id":123}}), room(),
            version(),
            json!({"code":0,"data":{"rtmp":{"addr":"rtmp://live-push.bilivideo.com/live-bvc/","code":"?streamname=fictional-secret&key=value"}}})]).await;
        let (room, result) = client.start(&session(), 86).await.unwrap();
        assert_eq!(room.live_status, 1);
        assert!(room.live_since.is_some());
        let StartBroadcast::Started(credentials) = result else {
            panic!("expected credentials")
        };
        assert!(credentials.stream_key.contains("fictional-secret"));
        assert!(!format!("{credentials:?}").contains("fictional-secret"));
        let requests = task.await.unwrap();
        assert!(requests[3].contains("getHomePageLiveVersion?access_key=&appkey="));
        let mut params = form(&requests[4]);
        let signature = params.remove("sign").unwrap();
        let mut url = Url::parse("https://example.invalid").unwrap();
        url.query_pairs_mut().extend_pairs(&params);
        assert_eq!(
            signature,
            format!(
                "{:x}",
                md5::compute(format!("{}{APP_SECRET}", url.query().unwrap()))
            )
        );
        assert_eq!(params["build"], "9999");
        assert_eq!(params["version"], "9.9.9");
        assert_eq!(params["area_v2"], "86");
        // The desktop signer always carries an (empty) access_key field.
        assert_eq!(params["access_key"], "");
        assert_eq!(params["type"], "2");
        assert_eq!(params["platform"], "pc_link");
    }

    #[tokio::test]
    async fn desktop_identity_reaches_the_face_check_with_the_announced_version_and_device() {
        let (client, task) = fixture(vec![
            areas(),
            json!({"code":0,"data":{"room_id":123}}),
            room(),
            version(),
            json!({"code":60024,"data":{"qr":"https://live.bilibili.com/face?token=fictional"}}),
            json!({"code":0,"data":{"is_identified":true}}),
        ])
        .await;
        // The QR login's browser buvid3 must not leak into desktop requests.
        let session = BiliSession::from_secret_payload(
            br#"{"user_id":42,"sessdata":"fictional-session","bili_jct":"fictional-csrf","buvid3":"WEB-BROWSER-BUVID"}"#,
        )
        .unwrap();
        let (_, started) = client.start(&session, 86).await.unwrap();
        assert!(matches!(
            started,
            StartBroadcast::FaceVerification { code: 60024, .. }
        ));
        // Reuses the version startLive announced instead of fetching again.
        assert!(
            client
                .face_verification_status(&session, 123)
                .await
                .unwrap()
        );
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 6);
        let identity =
            "user-agent: livehime/9.9.9 os/windows pc_app/livehime build/9999 osver/10.0_x86_64";
        for request in [&requests[4], &requests[5]] {
            assert!(
                request.contains(&format!("buvid: {DEVICE}\r\n")),
                "{request}"
            );
            assert!(request.contains(&format!(
                "cookie: SESSDATA=fictional-session; bili_jct=fictional-csrf; DedeUserID=42; buvid3={DEVICE}\r\n"
            )));
            let lower = request.to_ascii_lowercase();
            assert!(lower.starts_with("post "));
            assert!(lower.contains(identity), "{lower}");
            assert!(!lower.contains("origin:"));
            assert!(!lower.contains("referer:"));
            assert!(!request.contains("WEB-BROWSER-BUVID"));
        }
        // Web-identity requests keep the browser session and carry no device header.
        for request in &requests[..4] {
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("origin: https://link.bilibili.com"));
            assert!(!lower.contains("user-agent: livehime/"));
            assert!(!lower.contains("\r\nbuvid:"));
            assert!(!request.contains(DEVICE));
        }
        assert!(requests[3].contains("buvid3=WEB-BROWSER-BUVID"));
    }

    #[test]
    fn device_identity_is_the_desktop_clients_generated_shape() {
        let generated = LivehimeDevice::generate();
        let value = generated.as_str();
        assert!(value.ends_with("user"));
        assert_eq!(&value[..36], value[..36].to_ascii_uppercase());
        assert!(Uuid::parse_str(&value[..36]).is_ok());
        assert!(
            value[36..value.len() - 4]
                .bytes()
                .all(|b| b.is_ascii_digit())
        );
        assert_eq!(LivehimeDevice::parse(value).unwrap(), generated);
        assert_ne!(LivehimeDevice::generate(), generated);
        assert!(!format!("{generated:?}").contains(&value[..8]));
        for invalid in [
            "",
            "user",
            "0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f512345user",
            "0C1D2E3F4A5B4C6D8E9FA0B1C2D3E4F5123456789user",
            "0C1D2E3F-4A5B-4C6D-8E9F-A0B1C2D3E4F5user",
            "0C1D2E3F-4A5B-4C6D-8E9F-A0B1C2D3E4F512345678901user",
            "0C1D2E3F-4A5B-4C6D-8E9F-A0B1C2D3E4F51234;user",
            "0C1D2E3F-4A5B-4C6D-8E9F-A0B1C2D3E4F512345USER",
            "0C1D2E3F-4A5B-4C6D-8E9F-A0B1C2D3E4F5１２user",
        ] {
            assert!(LivehimeDevice::parse(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            livehime_user_agent("1.2.3.4242", 4242),
            "LiveHime/1.2.3.4242 os/Windows pc_app/livehime build/4242 osVer/10.0_x86_64"
        );
    }

    #[tokio::test]
    async fn stop_checks_owner_and_sends_csrf_without_starting_chat_or_media() {
        let (client, task) = fixture(vec![
            json!({"code":0,"data":{"room_id":123}}),
            room(),
            json!({"code":0}),
        ])
        .await;
        let stopped = client.stop(&session()).await.unwrap();
        assert_eq!((stopped.live_status, stopped.live_since), (0, None));
        let requests = task.await.unwrap();
        assert!(requests[2].starts_with("POST /room/v1/Room/stopLive "));
        assert_eq!(form(&requests[2])["room_id"], "123");
        assert_eq!(form(&requests[2])["csrf"], "fictional-csrf");
    }

    #[tokio::test]
    async fn invalid_area_and_wrong_owner_never_reach_a_mutation() {
        let (client, task) = fixture(vec![areas()]).await;
        assert!(client.start(&session(), 87).await.is_err());
        assert_eq!(task.await.unwrap().len(), 1);
        let mut wrong_room = room();
        wrong_room["data"]["uid"] = json!(999);
        let (client, task) =
            fixture(vec![json!({"code":0,"data":{"room_id":123}}), wrong_room]).await;
        assert!(client.stop(&session()).await.is_err());
        assert_eq!(task.await.unwrap().len(), 2);
    }

    #[test]
    fn live_room_reports_its_start_time_in_china_standard_time() {
        let mut live = room();
        live["data"]["live_status"] = json!(1);
        live["data"]["live_time"] = json!("2026-10-03 20:00:05");
        let parsed = parse_room(&live, 42, 123).unwrap();
        // 2026-10-03 12:00:05 UTC.
        assert_eq!(parsed.live_since, Some(1_791_028_805));
        for value in [
            json!("0000-00-00 00:00:00"),
            json!("2026-13-03 20:00:05"),
            json!("2026-10-03T20:00:05"),
            json!("２０２６-10-03 20:00:05"),
            json!(1_791_028_805),
        ] {
            live["data"]["live_time"] = value;
            assert_eq!(parse_room(&live, 42, 123).unwrap().live_since, None);
        }
        // An offline room never shows a running timer, whatever the server sends.
        let mut offline = room();
        offline["data"]["live_time"] = json!("2026-10-03 20:00:05");
        assert_eq!(parse_room(&offline, 42, 123).unwrap().live_since, None);
        assert_eq!(
            beijing_unix_seconds("2000-03-01 08:00:00"),
            Some(951_868_800)
        );
    }

    #[test]
    fn face_verification_is_allowlisted_and_never_claims_started() {
        let result = parse_start(
            &json!({"code":60024,"data":{"qr":"https://live.bilibili.com/face?token=fictional"}}),
            42,
        )
        .unwrap();
        assert!(matches!(
            result,
            StartBroadcast::FaceVerification { code: 60024, .. }
        ));
        assert!(!format!("{result:?}").contains("fictional"));
        let error = parse_start(
            &json!({"code":60043,"data":{"risk_extra":{"v_voucher":"fictional-private-voucher"}}}),
            42,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("新版人脸验证暂不支持"));
        assert!(error.contains("官方直播姬"));
        assert!(!error.contains("fictional-private-voucher"));
        let StartBroadcast::FaceVerification { url, code: 60043 } =
            parse_start(&json!({"code":60043}), 42).unwrap()
        else {
            panic!()
        };
        assert!(url.ends_with("mid=42"));
        for url in [
            "https://www.bilibili.com.evil.example/qr",
            "http://live.bilibili.com/qr",
            "https://live.bilibili.com:444/qr",
            "https://user@live.bilibili.com/qr",
        ] {
            assert!(parse_start(&json!({"code":60024,"data":{"qr":url}}), 42).is_err());
        }
    }

    #[test]
    fn strict_errors_titles_versions_and_stream_addresses() {
        assert_eq!(
            api_ok(&json!({"code":-101,"message":"fictional-secret"})),
            Err(BiliError::SessionExpired)
        );
        assert!(
            !api_ok(&json!({"code":-400,"message":"fictional-secret"}))
                .unwrap_err()
                .to_string()
                .contains("fictional-secret")
        );
        for title in ["".to_owned(), "字".repeat(41), "标题\n内容".to_owned()] {
            assert!(validate_title(&title).is_err());
        }
        assert!(validate_title(&"字".repeat(40)).is_ok());
        assert!(parse_version(&json!({"code":0,"data":{"build":0,"curr_version":"x"}})).is_err());
        assert!(parse_start(&json!({"code":0}), 42).is_err());
        for address in [
            "https://live-push.bilivideo.com/live/",
            "rtmp://bilivideo.com.evil.example/live/",
        ] {
            assert!(
                parse_start(
                    &json!({"code":0,"data":{"rtmp":{"addr":address,"code":"fictional"}}}),
                    42
                )
                .is_err()
            );
        }
        let parsed = parse_areas(&areas()).unwrap();
        assert_eq!(parsed[0].children.len(), 1);
        assert!(parse_areas(&json!({"code":0,"data":[]})).is_err());
    }

    #[tokio::test]
    #[ignore = "explicit read-only online probe of public areas and signed desktop-version endpoint; no account or broadcast mutation"]
    async fn public_broadcast_metadata_online_probe() {
        let client = BroadcastClient::new(LivehimeDevice::generate()).unwrap();
        let areas = client.areas().await.unwrap();
        assert!(!areas.is_empty());
        let query = signed_params(vec![
            ("system_version".into(), "2".into()),
            ("ts".into(), timestamp().unwrap().to_string()),
        ]);
        let response = client
            .request(
                "/xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion",
                None,
                false,
                ClientIdentity::Web,
            )
            .query(&*query)
            .send()
            .await
            .unwrap();
        let (build, version) = parse_version(&read_json(response).await.unwrap()).unwrap();
        println!(
            "Public broadcast metadata: {} parent areas; desktop build {build}, version {version}; no login or room mutation.",
            areas.len()
        );
    }
}
