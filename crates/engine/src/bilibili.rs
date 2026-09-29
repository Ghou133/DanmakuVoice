//! Bilibili web live-room transport and explicit QR-login flow.
//!
//! The web protocol used here is distinct from Bilibili Open Live: the latter
//! requires a registered developer, AccessKey/Secret, an AppId and streamer
//! authorization, and its event permissions are separately approved. This
//! module does not claim to implement that official developer protocol.
//!
//! Web protocol references (unofficial, subject to change):
//! - https://github.com/pskdje/bilibili-API-collect/blob/main/docs/login/login_action/QR.md
//! - https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/info.md
//! - https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/danmaku.md
//! - https://github.com/melon-444/bilibili-API-collect-fork/blob/master/docs/live/message_stream.md
//! - https://github.com/pskdje/bilibili-API-collect/blob/main/docs/misc/sign/wbi.md
//! - https://github.com/streetartist/BiliKit/blob/main/Bilibili-Live-API-master/API.WebSocket.md
//! - https://github.com/public-clis/bilibili-cli/pull/27 (2026 crossDomain QR change)
//!
//! Official Open Live boundary: https://open-live.bilibili.com/document/849b924b-b421-8586-3e5e-765a72ec3840

use std::fmt;
use std::io::Read;
use std::time::{Duration, Instant};

use flate2::read::ZlibDecoder;
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{COOKIE, HeaderMap, LOCATION, REFERER, SET_COOKIE};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{Mutex, mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant as TokioInstant, MissedTickBehavior, interval_at, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{
    COOKIE as WS_COOKIE, HeaderValue as WsHeaderValue, ORIGIN, USER_AGENT,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::diagnostics::{self, DiagnosticCode};
use crate::model::{EventKind, LiveEmote, LiveEvent};

const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const QR_GENERATE_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const QR_TTL: Duration = Duration::from_secs(180);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const RECEIVE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_WIRE_BYTES: usize = 2 * 1024 * 1024;
const MAX_UNPACKED_BYTES: usize = 8 * 1024 * 1024;
const MAX_PACKETS: usize = 4096;
const MAX_IMAGE_URL_BYTES: usize = 1024;
const MAX_EMOTES_PER_EVENT: usize = 8;
const MAX_EMOTE_TEXT_BYTES: usize = 128;
const MAX_DANMAKU_EXTRA_BYTES: usize = 64 * 1024;

/// Error messages intentionally exclude URL query strings, ticket values,
/// Cookie headers, server response bodies and credentials.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum BiliError {
    #[error("直播间号必须大于零 [DV-B01]")]
    InvalidRoom,
    #[error("主播 UID 必须大于零 [DV-B02]")]
    InvalidUid,
    #[error("网络请求失败 [DV-B03]")]
    Network,
    #[error("B站接口返回错误码 {0} [DV-B04]")]
    Api(i64),
    #[error("B站返回了不支持或无效的数据：{0} [DV-B05]")]
    Protocol(&'static str),
    #[error("当前扫码流程已结束，请生成新的二维码 [DV-B06]")]
    QrFinished,
    #[error("直播连接任务已经运行 [DV-B07]")]
    AlreadyRunning,
    #[error("此账号没有可用的直播间 [DV-B08]")]
    NoOwnRoom,
    #[error("B站登录已失效，请重新扫码 [DV-B09]")]
    SessionExpired,
}

/// Sensitive web session returned by a confirmed QR login. Its Debug output
/// never displays credentials. The caller may pass `secret_payload` directly
/// to the engine's DPAPI helper; no plaintext file is written here.
#[derive(Clone, Deserialize)]
pub struct BiliSession {
    user_id: u64,
    sessdata: String,
    bili_jct: String,
    buvid3: Option<String>,
    refresh_token: Option<String>,
    #[serde(default)]
    profile: Option<BiliAccountProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct BiliAccountProfile {
    pub user_id: u64,
    pub name: String,
    pub avatar_url: Option<String>,
}

impl BiliAccountProfile {
    fn validated(mut self, user_id: u64) -> Result<Self, BiliError> {
        self.name = self.name.trim().to_owned();
        if self.user_id != user_id
            || user_id == 0
            || self.name.is_empty()
            || self.name.len() > 256
            || self.name.chars().any(char::is_control)
        {
            return Err(BiliError::Protocol("账号资料无效"));
        }
        self.avatar_url = self
            .avatar_url
            .and_then(|url| bili_image_url(Some(&Value::String(url))));
        Ok(self)
    }
}

impl fmt::Debug for BiliSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BiliSession")
            .field("user_id", &self.user_id)
            .field("credentials", &"[redacted]")
            .finish()
    }
}

impl Drop for BiliSession {
    fn drop(&mut self) {
        self.sessdata.zeroize();
        self.bili_jct.zeroize();
        if let Some(value) = &mut self.buvid3 {
            value.zeroize();
        }
        if let Some(value) = &mut self.refresh_token {
            value.zeroize();
        }
    }
}

#[derive(Serialize)]
struct SecretSession<'a> {
    user_id: u64,
    sessdata: &'a str,
    bili_jct: &'a str,
    buvid3: Option<&'a str>,
    refresh_token: Option<&'a str>,
    profile: Option<&'a BiliAccountProfile>,
}

impl BiliSession {
    pub fn user_id(&self) -> u64 {
        self.user_id
    }

    pub fn profile(&self) -> Option<&BiliAccountProfile> {
        self.profile.as_ref()
    }

    pub fn set_profile(&mut self, profile: BiliAccountProfile) -> Result<(), BiliError> {
        self.profile = Some(profile.validated(self.user_id)?);
        Ok(())
    }

    /// Returns plaintext bytes only in memory. Protect these with DPAPI before
    /// any persistence and zeroize the returned Vec after encryption.
    pub fn secret_payload(&self) -> Result<Vec<u8>, BiliError> {
        serde_json::to_vec(&SecretSession {
            user_id: self.user_id,
            sessdata: &self.sessdata,
            bili_jct: &self.bili_jct,
            buvid3: self.buvid3.as_deref(),
            refresh_token: self.refresh_token.as_deref(),
            profile: self.profile.as_ref(),
        })
        .map_err(|_| BiliError::Protocol("会话编码失败"))
    }

    /// Accepts only already-decrypted bytes from the application's protected
    /// secret store. It never reads legacy Cookie files.
    pub fn from_secret_payload(payload: &[u8]) -> Result<Self, BiliError> {
        let mut parsed: BiliSession =
            serde_json::from_slice(payload).map_err(|_| BiliError::Protocol("会话解码失败"))?;
        if parsed.user_id == 0
            || !valid_cookie_value(&parsed.sessdata)
            || !valid_cookie_value(&parsed.bili_jct)
            || parsed
                .buvid3
                .as_deref()
                .is_some_and(|v| !valid_cookie_value(v))
        {
            return Err(BiliError::Protocol("会话字段无效"));
        }
        parsed.profile = parsed
            .profile
            .take()
            .and_then(|profile| profile.validated(parsed.user_id).ok());
        Ok(parsed)
    }

    fn cookie_header(&self) -> String {
        let mut cookie = format!(
            "SESSDATA={}; bili_jct={}; DedeUserID={}",
            self.sessdata, self.bili_jct, self.user_id
        );
        if let Some(buvid3) = &self.buvid3 {
            cookie.push_str("; buvid3=");
            cookie.push_str(buvid3);
        }
        cookie
    }
}

pub struct QrChallenge {
    qr_url: String,
    key: String,
    created: Instant,
    phase: QrPhase,
}

impl fmt::Debug for QrChallenge {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QrChallenge")
            .field("qr_url", &"[redacted]")
            .field("key", &"[redacted]")
            .field("phase", &self.phase)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QrPhase {
    WaitingForScan,
    WaitingForConfirmation,
    Expired,
    Complete,
}

impl QrChallenge {
    /// QR content for display. It embeds an ephemeral login key; keep it out
    /// of logs and persistence.
    pub fn qr_url(&self) -> &str {
        &self.qr_url
    }

    pub fn phase(&self) -> QrPhase {
        self.phase
    }

    pub fn time_left(&self) -> Duration {
        QR_TTL.saturating_sub(self.created.elapsed())
    }
}

impl Drop for QrChallenge {
    fn drop(&mut self) {
        self.qr_url.zeroize();
        self.key.zeroize();
    }
}

pub enum QrPoll {
    WaitingForScan,
    WaitingForConfirmation,
    Expired,
    Complete(BiliSession),
}

impl fmt::Debug for QrPoll {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WaitingForScan => f.write_str("WaitingForScan"),
            Self::WaitingForConfirmation => f.write_str("WaitingForConfirmation"),
            Self::Expired => f.write_str("Expired"),
            Self::Complete(session) => f.debug_tuple("Complete").field(session).finish(),
        }
    }
}

pub struct QrLoginClient {
    http: Client,
}

impl QrLoginClient {
    pub fn new() -> Result<Self, BiliError> {
        Ok(Self {
            http: http_client()?,
        })
    }

    /// Fetch display identity once per login/start, never through UI polling.
    pub async fn account_profile(
        &self,
        session: &BiliSession,
    ) -> Result<BiliAccountProfile, BiliError> {
        let response = self
            .http
            .get("https://api.bilibili.com/x/web-interface/nav")
            .header(REFERER, "https://www.bilibili.com/")
            .header(COOKIE, session.cookie_header())
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        parse_account_profile(&read_json(response).await?, session.user_id())
    }

    /// Starts only when the UI explicitly requests QR login.
    pub async fn begin(&self) -> Result<QrChallenge, BiliError> {
        let response = self
            .http
            .get(QR_GENERATE_URL)
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        let value = read_json(response).await?;
        parse_qr_challenge(&value)
    }

    /// Performs exactly one poll. The UI chooses the cadence and may stop by
    /// dropping the challenge. A successful key cannot be polled again.
    pub async fn poll(&self, challenge: &mut QrChallenge) -> Result<QrPoll, BiliError> {
        if matches!(challenge.phase, QrPhase::Complete | QrPhase::Expired) {
            return Err(BiliError::QrFinished);
        }
        if challenge.time_left().is_zero() {
            challenge.phase = QrPhase::Expired;
            return Ok(QrPoll::Expired);
        }
        let response = self
            .http
            .get(QR_POLL_URL)
            .query(&[("qrcode_key", challenge.key.as_str())])
            .send()
            .await
            .map_err(|_| BiliError::Network)?;
        let headers = response.headers().clone();
        let value = read_json(response).await?;
        let result = parse_qr_poll(&value, &headers)?;
        match result {
            ParsedQrPoll::WaitingForScan => {
                challenge.phase = QrPhase::WaitingForScan;
                Ok(QrPoll::WaitingForScan)
            }
            ParsedQrPoll::WaitingForConfirmation => {
                challenge.phase = QrPhase::WaitingForConfirmation;
                Ok(QrPoll::WaitingForConfirmation)
            }
            ParsedQrPoll::Expired => {
                challenge.phase = QrPhase::Expired;
                Ok(QrPoll::Expired)
            }
            ParsedQrPoll::Complete {
                url,
                refresh_token,
                mut cookies,
            } => {
                // Since August 2026 the success URL can contain a one-time
                // crossDomain ticket instead of Cookie query parameters.
                // The QR key is consumed at this point, including when the
                // ticket exchange fails and a fresh QR is needed.
                challenge.phase = QrPhase::Complete;
                if !cookies.complete() {
                    let ticket_url = url.ok_or(BiliError::Protocol("登录成功但缺少会话"))?;
                    self.exchange_ticket(&ticket_url, &mut cookies).await?;
                }
                let session = cookies.into_session(refresh_token)?;
                Ok(QrPoll::Complete(session))
            }
        }
    }

    async fn exchange_ticket(
        &self,
        raw_url: &str,
        cookies: &mut SessionCookies,
    ) -> Result<(), BiliError> {
        let mut url = checked_ticket_url(raw_url)?;
        for _ in 0..5 {
            let response = self
                .http
                .get(url.clone())
                .send()
                .await
                .map_err(|_| BiliError::Network)?;
            cookies.collect_headers(response.headers());
            if cookies.complete() {
                return Ok(());
            }
            if !response.status().is_redirection() {
                break;
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(BiliError::Protocol("跨域登录跳转无效"))?;
            url = checked_ticket_url(
                url.join(location)
                    .map_err(|_| BiliError::Protocol("跨域登录跳转无效"))?
                    .as_str(),
            )?;
            cookies.collect_query(&url);
        }
        if cookies.complete() {
            Ok(())
        } else {
            Err(BiliError::Protocol("扫码确认后未获得完整会话"))
        }
    }

    /// Finds the logged-in account's room through the documented UID-to-room
    /// web endpoint. The result still needs `room_init` normalization when a
    /// stream is started.
    pub async fn own_room_id(&self, session: &BiliSession) -> Result<u64, BiliError> {
        self.room_id_for_uid(session.user_id(), Some(session)).await
    }

    /// Resolve a broadcaster UID for either anonymous access or an explicit
    /// saved session. A UID is never interpreted as a room number.
    pub async fn room_id_for_uid(
        &self,
        uid: u64,
        session: Option<&BiliSession>,
    ) -> Result<u64, BiliError> {
        if uid == 0 {
            return Err(BiliError::InvalidUid);
        }
        let mut request = self
            .http
            .get("https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld")
            .query(&[("mid", uid)]);
        if let Some(session) = session {
            request = request.header(COOKIE, session.cookie_header());
        }
        let response = request.send().await.map_err(|_| BiliError::Network)?;
        let value = read_json(response).await?;
        parse_uid_room(&value)
    }
}

fn parse_uid_room(value: &Value) -> Result<u64, BiliError> {
    require_api_ok(value)?;
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or(BiliError::Protocol("缺少账号直播间数据"))?;
    match data.get("roomStatus").and_then(Value::as_i64) {
        Some(0) => return Err(BiliError::NoOwnRoom),
        Some(1) => {}
        _ => return Err(BiliError::Protocol("账号直播间状态无效")),
    }
    match data.get("roomid").and_then(Value::as_u64) {
        Some(0) => Err(BiliError::NoOwnRoom),
        Some(room_id) => Ok(room_id),
        None => Err(BiliError::Protocol("账号直播间号无效")),
    }
}

fn http_client() -> Result<Client, BiliError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT_VALUE)
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| BiliError::Network)
}

async fn read_json(response: reqwest::Response) -> Result<Value, BiliError> {
    if !response.status().is_success() {
        return Err(BiliError::Network);
    }
    let mut bytes = Vec::new();
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| BiliError::Network)?;
        if chunk.len() > MAX_WIRE_BYTES.saturating_sub(bytes.len()) {
            return Err(BiliError::Protocol("接口响应过大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| BiliError::Protocol("接口 JSON 无效"))
}

fn require_api_ok(value: &Value) -> Result<(), BiliError> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        Some(code) => Err(BiliError::Api(code)),
        None => Err(BiliError::Protocol("缺少接口状态码")),
    }
}

fn valid_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.bytes().any(|b| b <= 0x20 || b == b';' || b == 0x7f)
}

fn valid_qr_key(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn parse_qr_challenge(value: &Value) -> Result<QrChallenge, BiliError> {
    require_api_ok(value)?;
    let data = value
        .get("data")
        .ok_or(BiliError::Protocol("缺少二维码数据"))?;
    let qr_url = data
        .get("url")
        .and_then(Value::as_str)
        .ok_or(BiliError::Protocol("缺少二维码地址"))?;
    let key = data
        .get("qrcode_key")
        .and_then(Value::as_str)
        .ok_or(BiliError::Protocol("缺少二维码密钥"))?;
    // Current QR responses use account.bilibili.com; older responses used
    // passport.bilibili.com. Keep the host allowlist exact for both.
    if !valid_qr_key(key)
        || !allowed_url(qr_url, &["account.bilibili.com", "passport.bilibili.com"])
    {
        return Err(BiliError::Protocol("二维码地址或密钥无效"));
    }
    Ok(QrChallenge {
        qr_url: qr_url.to_owned(),
        key: key.to_owned(),
        created: Instant::now(),
        phase: QrPhase::WaitingForScan,
    })
}

fn allowed_url(raw: &str, hosts: &[&str]) -> bool {
    Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && url.host_str().is_some_and(|host| hosts.contains(&host))
    })
}

fn checked_ticket_url(raw: &str) -> Result<Url, BiliError> {
    let url = Url::parse(raw).map_err(|_| BiliError::Protocol("跨域登录地址无效"))?;
    if !allowed_url(
        raw,
        &[
            "passport.bilibili.com",
            "passport.biligame.com",
            "www.bilibili.com",
        ],
    ) {
        return Err(BiliError::Protocol("跨域登录地址不可信"));
    }
    Ok(url)
}

#[derive(Default)]
struct SessionCookies {
    sessdata: Option<String>,
    bili_jct: Option<String>,
    user_id: Option<u64>,
    buvid3: Option<String>,
}

impl SessionCookies {
    fn collect_headers(&mut self, headers: &HeaderMap) {
        for header in headers.get_all(SET_COOKIE) {
            if let Ok(text) = header.to_str()
                && let Some((name, value)) = text
                    .split(';')
                    .next()
                    .and_then(|part| part.trim().split_once('='))
            {
                self.collect_pair(name.trim(), value.trim());
            }
        }
    }

    fn collect_query(&mut self, url: &Url) {
        // Legacy success URLs already contain encoded Cookie values. Do not
        // percent-decode them before sending them back as Cookie headers.
        for part in url.query().unwrap_or_default().split('&') {
            if let Some((name, value)) = part.split_once('=') {
                self.collect_pair(name, value);
            }
        }
    }

    fn collect_pair(&mut self, name: &str, value: &str) {
        match name {
            "SESSDATA" if valid_cookie_value(value) => self.sessdata = Some(value.to_owned()),
            "bili_jct" if valid_cookie_value(value) => self.bili_jct = Some(value.to_owned()),
            "DedeUserID" => self.user_id = value.parse::<u64>().ok().filter(|id| *id > 0),
            "buvid3" if valid_cookie_value(value) => self.buvid3 = Some(value.to_owned()),
            _ => {}
        }
    }

    fn complete(&self) -> bool {
        self.sessdata.is_some() && self.bili_jct.is_some() && self.user_id.is_some()
    }

    fn into_session(mut self, refresh_token: Option<String>) -> Result<BiliSession, BiliError> {
        Ok(BiliSession {
            user_id: self.user_id.ok_or(BiliError::Protocol("缺少账号 UID"))?,
            sessdata: self
                .sessdata
                .take()
                .ok_or(BiliError::Protocol("缺少 SESSDATA"))?,
            bili_jct: self
                .bili_jct
                .take()
                .ok_or(BiliError::Protocol("缺少 bili_jct"))?,
            buvid3: self.buvid3.take(),
            refresh_token,
            profile: None,
        })
    }
}

impl Drop for SessionCookies {
    fn drop(&mut self) {
        if let Some(value) = &mut self.sessdata {
            value.zeroize();
        }
        if let Some(value) = &mut self.bili_jct {
            value.zeroize();
        }
        if let Some(value) = &mut self.buvid3 {
            value.zeroize();
        }
    }
}

enum ParsedQrPoll {
    WaitingForScan,
    WaitingForConfirmation,
    Expired,
    Complete {
        url: Option<String>,
        refresh_token: Option<String>,
        cookies: SessionCookies,
    },
}

fn parse_qr_poll(value: &Value, headers: &HeaderMap) -> Result<ParsedQrPoll, BiliError> {
    require_api_ok(value)?;
    let data = value
        .get("data")
        .ok_or(BiliError::Protocol("缺少扫码状态"))?;
    match data.get("code").and_then(Value::as_i64) {
        Some(86101) => Ok(ParsedQrPoll::WaitingForScan),
        Some(86090) => Ok(ParsedQrPoll::WaitingForConfirmation),
        Some(86038) => Ok(ParsedQrPoll::Expired),
        Some(0) => {
            let mut cookies = SessionCookies::default();
            cookies.collect_headers(headers);
            let url = data
                .get("url")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if let Some(url) = url {
                let checked = checked_ticket_url(url)?;
                cookies.collect_query(&checked);
            }
            let refresh_token = data
                .get("refresh_token")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            Ok(ParsedQrPoll::Complete {
                url: url.map(str::to_owned),
                refresh_token,
                cookies,
            })
        }
        Some(code) => Err(BiliError::Api(code)),
        None => Err(BiliError::Protocol("缺少扫码状态码")),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomState {
    Stopped,
    SessionExpired {
        room_id: u64,
    },
    Connecting {
        room_id: u64,
    },
    Connected {
        room_id: u64,
    },
    Reconnecting {
        room_id: u64,
        attempt: u32,
        delay: Duration,
    },
}

struct RunningRoom {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

/// Owns at most one room task. The caller supplies a bounded channel; when
/// its receiver closes, the task exits rather than reconnecting forever.
pub struct BiliRoomClient {
    http: Client,
    running: Mutex<Option<RunningRoom>>,
    state_tx: watch::Sender<RoomState>,
}

impl BiliRoomClient {
    pub fn new() -> Result<Self, BiliError> {
        let (state_tx, _) = watch::channel(RoomState::Stopped);
        Ok(Self {
            http: http_client()?,
            running: Mutex::new(None),
            state_tx,
        })
    }

    pub fn subscribe_state(&self) -> watch::Receiver<RoomState> {
        self.state_tx.subscribe()
    }

    /// One call starts one long-running room connection. Duplicate starts
    /// fail, including during discovery and reconnect backoff.
    pub async fn start(
        &self,
        room_id: u64,
        session: Option<BiliSession>,
        events: mpsc::Sender<LiveEvent>,
    ) -> Result<(), BiliError> {
        let http = self.http.clone();
        self.start_task(room_id, move |task_cancel, state| {
            tokio::spawn(async move {
                let final_state =
                    run_room(http, room_id, session, &events, task_cancel, state.clone()).await;
                state.send_replace(final_state);
            })
        })
        .await
    }

    async fn start_task<F>(&self, room_id: u64, make_task: F) -> Result<(), BiliError>
    where
        F: FnOnce(CancellationToken, watch::Sender<RoomState>) -> JoinHandle<()>,
    {
        if room_id == 0 {
            return Err(BiliError::InvalidRoom);
        }
        let mut running = self.running.lock().await;
        if running
            .as_ref()
            .is_some_and(|slot| !slot.task.is_finished())
        {
            return Err(BiliError::AlreadyRunning);
        }
        running.take();
        let cancel = CancellationToken::new();
        let task = make_task(cancel.clone(), self.state_tx.clone());
        *running = Some(RunningRoom { cancel, task });
        Ok(())
    }

    /// Cancels discovery, WebSocket work, heartbeat, and reconnect sleep.
    /// Waits for the task so a new `start` cannot overlap the old connection.
    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        if let Some(mut slot) = running.take() {
            slot.cancel.cancel();
            if timeout(Duration::from_secs(5), &mut slot.task)
                .await
                .is_err()
            {
                slot.task.abort();
                let _ = slot.task.await;
            }
        }
        self.state_tx.send_replace(RoomState::Stopped);
    }
}

impl Drop for BiliRoomClient {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running.try_lock()
            && let Some(slot) = running.take()
        {
            slot.cancel.cancel();
            slot.task.abort();
        }
    }
}

async fn run_room(
    http: Client,
    display_room_id: u64,
    session: Option<BiliSession>,
    events: &mpsc::Sender<LiveEvent>,
    cancel: CancellationToken,
    state: watch::Sender<RoomState>,
) -> RoomState {
    let mut failures = 0u32;
    loop {
        if cancel.is_cancelled() || events.is_closed() {
            return RoomState::Stopped;
        }
        state.send_replace(RoomState::Connecting {
            room_id: display_room_id,
        });
        let started = Instant::now();
        let result = tokio::select! {
            _ = cancel.cancelled() => return RoomState::Stopped,
            result = connect_once(&http, display_room_id, session.as_ref(), events, &cancel, &state) => result,
        };
        if result == ConnectionEnd::SessionExpired {
            return RoomState::SessionExpired {
                room_id: display_room_id,
            };
        }
        if matches!(
            result,
            ConnectionEnd::Cancelled | ConnectionEnd::ReceiverClosed
        ) || cancel.is_cancelled()
            || events.is_closed()
        {
            return RoomState::Stopped;
        }
        if let ConnectionEnd::Failed(stage) = result {
            diagnostics::record(DiagnosticCode::RoomFailed, Some(stage.diagnostic_number()));
        }
        failures = if started.elapsed() >= Duration::from_secs(60) {
            1
        } else {
            failures.saturating_add(1)
        };
        let delay = reconnect_delay(failures);
        state.send_replace(RoomState::Reconnecting {
            room_id: display_room_id,
            attempt: failures,
            delay,
        });
        tokio::select! {
            _ = cancel.cancelled() => return RoomState::Stopped,
            _ = events.closed() => return RoomState::Stopped,
            _ = tokio::time::sleep(delay) => {},
        }
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(
        1u64.checked_shl(attempt.saturating_sub(1).min(5))
            .unwrap_or(32)
            .min(30),
    )
}

// `live.rs` records RoomFailed with a u32 reconnect attempt. Reserve the next
// numeric range for a transport stage; no URL, token, packet, or server body is
// ever passed to the diagnostic log. Low bits: 1 resolve_room, 2 discover_danmu,
// 3 WSS connect, 4 auth send, 5 auth reply, 6 established stream. The code
// identifies the last transport step only; it does not infer a server cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
enum ConnectionFailureStage {
    ResolveRoom = 1,
    DiscoverDanmu = 2,
    WebSocketConnect = 3,
    AuthSend = 4,
    AuthReply = 5,
    Stream = 6,
}

impl ConnectionFailureStage {
    fn diagnostic_number(self) -> u64 {
        (1u64 << 32) | u64::from(self as u8)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionEnd {
    Failed(ConnectionFailureStage),
    SessionExpired,
    Cancelled,
    ReceiverClosed,
}

async fn connect_once(
    http: &Client,
    display_room_id: u64,
    session: Option<&BiliSession>,
    events: &mpsc::Sender<LiveEvent>,
    cancel: &CancellationToken,
    state: &watch::Sender<RoomState>,
) -> ConnectionEnd {
    let Ok(room_id) = resolve_room(http, display_room_id).await else {
        return ConnectionEnd::Failed(ConnectionFailureStage::ResolveRoom);
    };
    let info = match discover_danmu(http, room_id, session).await {
        Ok(info) => info,
        Err(BiliError::SessionExpired) => return ConnectionEnd::SessionExpired,
        Err(_) => return ConnectionEnd::Failed(ConnectionFailureStage::DiscoverDanmu),
    };
    let mut host_failure = ConnectionFailureStage::WebSocketConnect;
    for host in info.hosts {
        if cancel.is_cancelled() {
            return ConnectionEnd::Cancelled;
        }
        let url = format!("wss://{}:{}/sub", host.host, host.port);
        let Ok(mut request) = url.as_str().into_client_request() else {
            continue;
        };
        request
            .headers_mut()
            .insert(USER_AGENT, WsHeaderValue::from_static(USER_AGENT_VALUE));
        request.headers_mut().insert(
            ORIGIN,
            WsHeaderValue::from_static("https://live.bilibili.com"),
        );
        if let Some(session) = session {
            let Ok(value) = WsHeaderValue::from_str(&session.cookie_header()) else {
                continue;
            };
            request.headers_mut().insert(WS_COOKIE, value);
        }
        let connection = tokio::select! {
            _ = cancel.cancelled() => return ConnectionEnd::Cancelled,
            result = timeout(Duration::from_secs(12), tokio_tungstenite::connect_async(request)) => result,
        };
        let Ok(Ok((mut socket, _))) = connection else {
            continue;
        };
        let random_client_id = Uuid::new_v4().simple().to_string();
        let queue_id = Uuid::new_v4().simple().to_string();
        let auth = json!({
            "uid": session.map_or(0, BiliSession::user_id),
            "roomid": room_id,
            "protover": 3,
            "buvid": session.and_then(|s| s.buvid3.as_deref()).unwrap_or(&random_client_id),
            // op 24's payload schema is not verified; do not advertise ack
            // support until it can be implemented from evidence.
            "support_ack": false,
            "queue_uuid": &queue_id[..8],
            "scene": "",
            "platform": "web",
            "type": 2,
            "key": info.token,
        });
        let Ok(body) = serde_json::to_vec(&auth) else {
            return ConnectionEnd::Failed(ConnectionFailureStage::AuthSend);
        };
        let auth_packet = encode_packet(7, 1, &body);
        if socket
            .send(Message::Binary(auth_packet.into()))
            .await
            .is_err()
        {
            host_failure = host_failure.max(ConnectionFailureStage::AuthSend);
            continue;
        }
        let authenticated = tokio::select! {
            _ = cancel.cancelled() => return ConnectionEnd::Cancelled,
            result = timeout(Duration::from_secs(10), wait_for_auth(&mut socket)) => result,
        };
        let initial_packets = match authenticated {
            Ok(Ok(packets)) => packets,
            _ => {
                host_failure = host_failure.max(ConnectionFailureStage::AuthReply);
                continue;
            }
        };
        state.send_replace(RoomState::Connected { room_id });
        return stream_room(socket, room_id, events, cancel, initial_packets).await;
    }
    ConnectionEnd::Failed(host_failure)
}

async fn resolve_room(http: &Client, display_id: u64) -> Result<u64, BiliError> {
    let url = format!("https://api.live.bilibili.com/room/v1/Room/room_init?id={display_id}");
    let value = read_json(http.get(url).send().await.map_err(|_| BiliError::Network)?).await?;
    require_api_ok(&value)?;
    value
        .pointer("/data/room_id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or(BiliError::Protocol("缺少直播间真实 ID"))
}

struct DanmuHost {
    host: String,
    port: u16,
}
struct DanmuInfo {
    token: String,
    hosts: Vec<DanmuHost>,
}

async fn discover_danmu(
    http: &Client,
    room_id: u64,
    session: Option<&BiliSession>,
) -> Result<DanmuInfo, BiliError> {
    let mixin_key = fetch_wbi_mixin(http, session).await?;
    let query = signed_danmu_query(room_id, now_ms() / 1000, &mixin_key);
    let url = format!("https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?{query}");
    let mut request = http
        .get(url)
        .header(REFERER, format!("https://live.bilibili.com/{room_id}"));
    if let Some(session) = session {
        request = request.header(COOKIE, session.cookie_header());
    }
    let value = read_json(request.send().await.map_err(|_| BiliError::Network)?).await?;
    require_api_ok(&value)?;
    parse_danmu_info(&value)
}

/// WBI keys come from `/x/web-interface/nav` even when its outer code is
/// -101 for an anonymous viewer. The image URLs are key containers, not
/// resources to download.
async fn fetch_wbi_mixin(
    http: &Client,
    session: Option<&BiliSession>,
) -> Result<String, BiliError> {
    let mut request = http
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header(REFERER, "https://www.bilibili.com/");
    if let Some(session) = session {
        request = request.header(COOKIE, session.cookie_header());
    }
    let value = read_json(request.send().await.map_err(|_| BiliError::Network)?).await?;
    nav_wbi_mixin(&value, session.is_some())
}

fn parse_account_profile(value: &Value, user_id: u64) -> Result<BiliAccountProfile, BiliError> {
    if value.get("code").and_then(Value::as_i64) == Some(-101)
        || value.pointer("/data/isLogin").and_then(Value::as_bool) == Some(false)
    {
        return Err(BiliError::SessionExpired);
    }
    require_api_ok(value)?;
    if value.pointer("/data/isLogin").and_then(Value::as_bool) != Some(true) {
        return Err(BiliError::Protocol("登录资料缺少状态"));
    }
    BiliAccountProfile {
        user_id: value
            .pointer("/data/mid")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        name: value
            .pointer("/data/uname")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        avatar_url: bili_image_url(value.pointer("/data/face")),
    }
    .validated(user_id)
}

fn nav_wbi_mixin(value: &Value, authenticated: bool) -> Result<String, BiliError> {
    // Bilibili's nav endpoint returns code -101 and isLogin=false for an
    // unauthenticated viewer. This is expected for anonymous reception, but
    // the same explicit reply means a supplied saved session no longer logs
    // the user in. Other API/network failures remain reconnectable.
    if authenticated
        && value.get("code").and_then(Value::as_i64) == Some(-101)
        && value.pointer("/data/isLogin").and_then(Value::as_bool) == Some(false)
    {
        return Err(BiliError::SessionExpired);
    }
    let img = value
        .pointer("/data/wbi_img/img_url")
        .and_then(Value::as_str)
        .and_then(wbi_image_key)
        .ok_or(BiliError::Protocol("WBI 图像密钥缺失"))?;
    let sub = value
        .pointer("/data/wbi_img/sub_url")
        .and_then(Value::as_str)
        .and_then(wbi_image_key)
        .ok_or(BiliError::Protocol("WBI 子密钥缺失"))?;
    mixin_key(&img, &sub)
}

fn wbi_image_key(raw_url: &str) -> Option<String> {
    let url = Url::parse(raw_url).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let file = url.path_segments()?.next_back()?;
    let key = file.split('.').next()?;
    if key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(key.to_owned())
    } else {
        None
    }
}

fn mixin_key(img: &str, sub: &str) -> Result<String, BiliError> {
    const TAB: [usize; 64] = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
        29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
        22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ];
    let raw = format!("{img}{sub}");
    if raw.len() != 64 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(BiliError::Protocol("WBI 密钥无效"));
    }
    Ok(TAB[..32]
        .iter()
        .map(|&index| raw.as_bytes()[index] as char)
        .collect())
}

fn signed_danmu_query(room_id: u64, wts: u64, mixin_key: &str) -> String {
    // Keys are sorted by name per the WBI protocol. All values here are ASCII
    // numbers or punctuation and need no percent encoding.
    let query = format!("id={room_id}&type=0&web_location=444.8&wts={wts}");
    format!(
        "{query}&w_rid={:x}",
        md5::compute(format!("{query}{mixin_key}"))
    )
}

fn parse_danmu_info(value: &Value) -> Result<DanmuInfo, BiliError> {
    let token = value
        .pointer("/data/token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty() && token.len() <= 8192)
        .ok_or(BiliError::Protocol("弹幕鉴权令牌缺失"))?;
    let host_list = value
        .pointer("/data/host_list")
        .and_then(Value::as_array)
        .ok_or(BiliError::Protocol("弹幕主机列表缺失"))?;
    let hosts: Vec<_> = host_list
        .iter()
        .filter_map(|entry| {
            let host = entry.get("host")?.as_str()?;
            let port = u16::try_from(entry.get("wss_port")?.as_u64()?).ok()?;
            if !valid_chat_host(host) || port == 0 {
                return None;
            }
            Some(DanmuHost {
                host: host.to_owned(),
                port,
            })
        })
        .take(10)
        .collect();
    if hosts.is_empty() {
        return Err(BiliError::Protocol("没有可信的弹幕主机"));
    }
    Ok(DanmuInfo {
        token: token.to_owned(),
        hosts,
    })
}

fn valid_chat_host(host: &str) -> bool {
    host.len() <= 253
        && host.ends_with(".chat.bilibili.com")
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !host.starts_with('.')
        && !host.contains("..")
}

async fn wait_for_auth<S>(socket: &mut S) -> Result<Vec<Packet>, BiliError>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut pending = Vec::new();
    let mut pending_bytes = 0usize;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|_| BiliError::Network)?;
        if let Message::Binary(bytes) = message {
            let packets = decode_packets(&bytes)?;
            let authenticated = if let Some(reply) = packets.iter().find(|packet| packet.op == 8) {
                let value: Value = serde_json::from_slice(&reply.body)
                    .map_err(|_| BiliError::Protocol("弹幕鉴权响应无效"))?;
                if value.get("code").and_then(Value::as_i64) != Some(0) {
                    return Err(BiliError::Protocol("弹幕鉴权失败"));
                }
                true
            } else {
                false
            };
            // The server may send events before the auth reply, either in the
            // same frame or in earlier frames. Keep them until authentication
            // succeeds, with a bound across all pre-auth frames.
            for packet in packets.into_iter().filter(|packet| packet.op == 5) {
                pending_bytes = pending_bytes.saturating_add(packet.body.len());
                if pending.len() >= MAX_PACKETS || pending_bytes > MAX_UNPACKED_BYTES {
                    return Err(BiliError::Protocol("鉴权前弹幕积压超限"));
                }
                pending.push(packet);
            }
            if authenticated {
                return Ok(pending);
            }
        }
    }
    Err(BiliError::Network)
}

async fn stream_room<S>(
    mut socket: S,
    room_id: u64,
    events: &mpsc::Sender<LiveEvent>,
    cancel: &CancellationToken,
    initial_packets: Vec<Packet>,
) -> ConnectionEnd
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    if let Err(end) = send_event_packets(initial_packets, room_id, events, cancel).await {
        return end;
    }
    let mut heartbeat = interval_at(TokioInstant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_received = Instant::now();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = timeout(Duration::from_secs(1), socket.close()).await;
                return ConnectionEnd::Cancelled;
            }
            _ = events.closed() => return ConnectionEnd::ReceiverClosed,
            _ = heartbeat.tick() => {
                if last_received.elapsed() >= RECEIVE_TIMEOUT { return ConnectionEnd::Failed(ConnectionFailureStage::Stream); }
                if socket.send(Message::Binary(encode_packet(2, 1, b"[object Object]").into())).await.is_err() {
                    return ConnectionEnd::Failed(ConnectionFailureStage::Stream);
                }
            }
            message = socket.next() => {
                let Some(Ok(message)) = message else { return ConnectionEnd::Failed(ConnectionFailureStage::Stream); };
                last_received = Instant::now();
                match message {
                    Message::Binary(bytes) => {
                        let Ok(packets) = decode_packets(&bytes) else { return ConnectionEnd::Failed(ConnectionFailureStage::Stream); };
                        if let Err(end) = send_event_packets(packets, room_id, events, cancel).await {
                            return end;
                        }
                    }
                    Message::Ping(payload) => {
                        if socket.send(Message::Pong(payload)).await.is_err() { return ConnectionEnd::Failed(ConnectionFailureStage::Stream); }
                    }
                    Message::Close(_) => return ConnectionEnd::Failed(ConnectionFailureStage::Stream),
                    _ => {}
                }
            }
        }
    }
}

async fn send_event_packets(
    packets: Vec<Packet>,
    room_id: u64,
    events: &mpsc::Sender<LiveEvent>,
    cancel: &CancellationToken,
) -> Result<(), ConnectionEnd> {
    for packet in packets {
        if packet.op != 5 {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&packet.body) else {
            continue;
        };
        if let Some(event) = parse_live_event(room_id, now_ms(), &value) {
            let sent = tokio::select! {
                _ = cancel.cancelled() => return Err(ConnectionEnd::Cancelled),
                result = events.send(event) => result,
            };
            if sent.is_err() {
                return Err(ConnectionEnd::ReceiverClosed);
            }
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[derive(Debug)]
struct Packet {
    op: u32,
    body: Vec<u8>,
}

fn encode_packet(op: u32, version: u16, body: &[u8]) -> Vec<u8> {
    let total = 16 + body.len();
    let mut bytes = Vec::with_capacity(total);
    bytes.extend_from_slice(&(total as u32).to_be_bytes());
    bytes.extend_from_slice(&16u16.to_be_bytes());
    bytes.extend_from_slice(&version.to_be_bytes());
    bytes.extend_from_slice(&op.to_be_bytes());
    bytes.extend_from_slice(&1u32.to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}

fn decode_packets(raw: &[u8]) -> Result<Vec<Packet>, BiliError> {
    if raw.len() > MAX_WIRE_BYTES {
        return Err(BiliError::Protocol("弹幕帧过大"));
    }
    let mut packets = Vec::new();
    // Each compressed sibling previously had its own 8 MiB limit. A single
    // wire frame could contain many small compressed siblings and retain far
    // more packet bodies than that limit. Share one expansion budget across
    // the entire frame, including nested compressed packets.
    let mut remaining_unpacked = MAX_UNPACKED_BYTES - raw.len();
    unpack_packets(raw, 0, &mut packets, &mut remaining_unpacked)?;
    Ok(packets)
}

fn unpack_packets(
    raw: &[u8],
    depth: u8,
    packets: &mut Vec<Packet>,
    remaining_unpacked: &mut usize,
) -> Result<(), BiliError> {
    if depth > 3 || raw.len() > MAX_UNPACKED_BYTES {
        return Err(BiliError::Protocol("弹幕压缩层数或大小超限"));
    }
    let mut offset = 0;
    while offset < raw.len() {
        if raw.len() - offset < 16 {
            return Err(BiliError::Protocol("弹幕包头不完整"));
        }
        let total = u32::from_be_bytes(raw[offset..offset + 4].try_into().unwrap()) as usize;
        let header = u16::from_be_bytes(raw[offset + 4..offset + 6].try_into().unwrap()) as usize;
        let version = u16::from_be_bytes(raw[offset + 6..offset + 8].try_into().unwrap());
        let op = u32::from_be_bytes(raw[offset + 8..offset + 12].try_into().unwrap());
        if header < 16 || total < header || total > raw.len() - offset || total > MAX_UNPACKED_BYTES
        {
            return Err(BiliError::Protocol("弹幕包长度无效"));
        }
        let body = &raw[offset + header..offset + total];
        match version {
            0 | 1 => {
                if packets.len() >= MAX_PACKETS {
                    return Err(BiliError::Protocol("弹幕包数量超限"));
                }
                packets.push(Packet {
                    op,
                    body: body.to_vec(),
                });
            }
            2 | 3 if op == 5 => {
                let mut expanded = Vec::new();
                let reader: Box<dyn Read> = if version == 2 {
                    Box::new(ZlibDecoder::new(body))
                } else {
                    Box::new(brotli::Decompressor::new(body, 4096))
                };
                reader
                    .take((*remaining_unpacked as u64) + 1)
                    .read_to_end(&mut expanded)
                    .map_err(|_| BiliError::Protocol("弹幕解压失败"))?;
                if expanded.len() > *remaining_unpacked {
                    return Err(BiliError::Protocol("弹幕解压后累计大小超限"));
                }
                *remaining_unpacked -= expanded.len();
                unpack_packets(&expanded, depth + 1, packets, remaining_unpacked)?;
            }
            _ => return Err(BiliError::Protocol("弹幕协议版本不支持")),
        }
        offset += total;
    }
    Ok(())
}

/// Decodes one raw WebSocket binary frame for offline fixtures or adapters.
/// Non-event operations (auth and heartbeat replies) produce no LiveEvent.
pub fn decode_live_events(
    room_id: u64,
    observed_at_ms: u64,
    frame: &[u8],
) -> Result<Vec<LiveEvent>, BiliError> {
    let mut events = Vec::new();
    for packet in decode_packets(frame)? {
        if packet.op != 5 {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&packet.body)
            && let Some(event) = parse_live_event(room_id, observed_at_ms, &value)
        {
            events.push(event);
        }
    }
    Ok(events)
}

/// Maps raw `DANMU_MSG`, `SEND_GIFT`, `SUPER_CHAT_MESSAGE` and `GUARD_BUY`
/// payloads. Unknown commands are deliberately ignored.
pub fn parse_live_event(room_id: u64, observed_at_ms: u64, value: &Value) -> Option<LiveEvent> {
    let cmd = value.get("cmd")?.as_str()?.split(':').next()?;
    let data = value.get("data");
    let mut event = match cmd {
        "DANMU_MSG" => {
            let info = value.get("info")?.as_array()?;
            let message = info.get(1)?.as_str()?;
            let user = info.get(2)?.as_array()?;
            let mut event = LiveEvent::danmaku(
                room_id,
                user.first().and_then(Value::as_u64),
                user.get(1)?.as_str()?,
                message,
            );
            let metadata = info.first().and_then(Value::as_array).map(Vec::as_slice);
            let mode_info = metadata.and_then(|meta| meta.get(15));
            let extra = danmaku_extra(mode_info);
            event.avatar_url =
                bili_image_url(mode_info.and_then(|mode| mode.pointer("/user/base/face")));
            // Current web packets carry a per-message ID in the nested extra
            // JSON. The pipeline uses it to discard a replay after reconnect,
            // while distinct messages with identical text remain separate.
            event.platform_event_id = extra.as_ref().and_then(danmaku_id);
            event.emotes = danmaku_emotes(message, metadata, extra.as_ref());
            event
        }
        "SEND_GIFT" => {
            let data = data?;
            let quantity = data
                .get("num")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)?;
            let milli_yuan = data
                .get("price")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0)?;
            LiveEvent {
                room_id,
                user_id: data.get("uid").and_then(Value::as_u64),
                user_name: data.get("uname")?.as_str()?.to_owned(),
                avatar_url: bili_image_url(data.get("face")),
                kind: EventKind::Gift,
                message: String::new(),
                emotes: Vec::new(),
                gift_name: data.get("giftName")?.as_str()?.to_owned(),
                quantity,
                price_yuan: milli_yuan / 1000.0 * f64::from(quantity),
                coin_type: data
                    .get("coin_type")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                guard_name: String::new(),
                platform_event_id: json_id(data.get("tid")),
                observed_at_ms,
            }
        }
        "SUPER_CHAT_MESSAGE" => {
            let data = data?;
            let price = data
                .get("price")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0)?;
            LiveEvent {
                room_id,
                user_id: data.get("uid").and_then(Value::as_u64),
                user_name: data
                    .pointer("/user_info/uname")
                    .or_else(|| data.get("uname"))?
                    .as_str()?
                    .to_owned(),
                avatar_url: bili_image_url(data.pointer("/user_info/face")),
                kind: EventKind::SuperChat,
                message: data.get("message")?.as_str()?.to_owned(),
                emotes: Vec::new(),
                gift_name: String::new(),
                quantity: 0,
                price_yuan: price,
                coin_type: None,
                guard_name: String::new(),
                platform_event_id: json_id(data.get("id")),
                observed_at_ms,
            }
        }
        "GUARD_BUY" => {
            let data = data?;
            let level = data.get("guard_level").and_then(Value::as_u64)?;
            let guard_name = match level {
                1 => "总督",
                2 => "提督",
                3 => "舰长",
                _ => return None,
            };
            LiveEvent {
                room_id,
                user_id: data.get("uid").and_then(Value::as_u64),
                user_name: data
                    .get("username")
                    .or_else(|| data.get("uname"))?
                    .as_str()?
                    .to_owned(),
                avatar_url: bili_image_url(data.get("face")),
                kind: EventKind::Guard,
                message: String::new(),
                emotes: Vec::new(),
                gift_name: String::new(),
                quantity: data
                    .get("num")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .unwrap_or(1),
                price_yuan: 0.0,
                coin_type: None,
                guard_name: guard_name.to_owned(),
                platform_event_id: json_id(data.get("id")),
                observed_at_ms,
            }
        }
        _ => return None,
    };
    event.observed_at_ms = observed_at_ms;
    Some(event)
}

/// Image references come only from Bilibili's own CDN. This also keeps a
/// malformed packet from becoming an arbitrary WebView image request.
fn bili_image_url(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    if raw.is_empty() || raw.len() > MAX_IMAGE_URL_BYTES {
        return None;
    }
    let candidate = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.to_owned()
    };
    let mut url = Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/bfs/")
    {
        return None;
    }
    let host = url.host_str()?.as_bytes();
    if host.len() != 12
        || host[0] != b'i'
        || !host[1].is_ascii_digit()
        || &host[2..] != b".hdslb.com"
    {
        return None;
    }
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn danmaku_extra(mode_info: Option<&Value>) -> Option<Value> {
    mode_info
        .and_then(|mode| mode.get("extra"))
        .and_then(Value::as_str)
        .filter(|raw| raw.len() <= MAX_DANMAKU_EXTRA_BYTES)
        .and_then(|raw| serde_json::from_str(raw).ok())
}

fn danmaku_id(extra: &Value) -> Option<String> {
    extra
        .get("id_str")
        .and_then(Value::as_str)
        .filter(|id| {
            (8..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .map(str::to_owned)
}

fn danmaku_emotes(
    message: &str,
    metadata: Option<&[Value]>,
    extra: Option<&Value>,
) -> Vec<LiveEmote> {
    let Some(metadata) = metadata else {
        return Vec::new();
    };
    let mut emotes = Vec::new();
    let mode_info = metadata.get(15);

    // Room-specific emoticons are represented by the entire danmaku text.
    let whole_image = bili_image_url(metadata.get(13).and_then(|value| value.get("url")))
        .or_else(|| bili_image_url(mode_info.and_then(|mode| mode.pointer("/emoticon/url"))));
    if let Some(url) = whole_image
        && !message.is_empty()
        && message.len() <= MAX_EMOTE_TEXT_BYTES
    {
        emotes.push(LiveEmote {
            text: message.to_owned(),
            url,
            large: true,
        });
    }

    // Current web packets put regular inline emotes into a JSON string in
    // mode_info.extra. Some variants expose emots directly on mode_info.
    let inline = extra
        .and_then(|value| value.get("emots"))
        .and_then(Value::as_object)
        .or_else(|| {
            mode_info
                .and_then(|mode| mode.get("emots"))
                .and_then(Value::as_object)
        });
    if let Some(inline) = inline {
        for (text, value) in inline {
            if emotes.len() == MAX_EMOTES_PER_EVENT {
                break;
            }
            if text.is_empty() || text.len() > MAX_EMOTE_TEXT_BYTES || !message.contains(text) {
                continue;
            }
            let Some(url) = bili_image_url(value.get("url")) else {
                continue;
            };
            if !emotes.iter().any(|emote| emote.text == *text) {
                emotes.push(LiveEmote {
                    text: text.to_owned(),
                    url,
                    large: false,
                });
            }
        }
    }
    emotes
}

fn json_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_pipeline::EventPipeline;
    use crate::model::GiftMergeSettings;
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use futures_util::stream;
    use reqwest::header::HeaderValue;
    use std::io::Write;

    #[test]
    fn connection_failure_stages_are_distinct_numeric_diagnostics() {
        let cases = [
            (ConnectionFailureStage::ResolveRoom, 0x1_0000_0001),
            (ConnectionFailureStage::DiscoverDanmu, 0x1_0000_0002),
            (ConnectionFailureStage::WebSocketConnect, 0x1_0000_0003),
            (ConnectionFailureStage::AuthSend, 0x1_0000_0004),
            (ConnectionFailureStage::AuthReply, 0x1_0000_0005),
            (ConnectionFailureStage::Stream, 0x1_0000_0006),
        ];
        let temp = tempfile::tempdir().unwrap();
        let mut log = crate::diagnostics::DiagnosticLog::open(temp.path()).unwrap();
        for (stage, expected) in cases {
            assert_eq!(stage.diagnostic_number(), expected);
            assert!(expected > u64::from(u32::MAX));
            log.record(DiagnosticCode::RoomFailed, Some(stage.diagnostic_number()))
                .unwrap();
        }
        drop(log);
        let jsonl = std::fs::read_to_string(temp.path().join("logs/current.jsonl")).unwrap();
        let records = jsonl
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), cases.len());
        for (record, (_, expected)) in records.iter().zip(cases) {
            assert_eq!(record["code"], "room_failed");
            assert_eq!(record["number"], expected);
            assert_eq!(record.as_object().unwrap().len(), 3);
        }
    }

    #[test]
    fn later_websocket_failures_do_not_hide_a_reached_auth_reply() {
        let mut last = ConnectionFailureStage::WebSocketConnect;
        last = last.max(ConnectionFailureStage::AuthReply);
        last = last.max(ConnectionFailureStage::WebSocketConnect);
        assert_eq!(last, ConnectionFailureStage::AuthReply);
    }

    #[tokio::test]
    async fn auth_reply_parsing_accepts_only_success_code() {
        let good = Message::Binary(encode_packet(8, 1, br#"{"code":0}"#).into());
        let mut replies = stream::iter([Ok::<_, tokio_tungstenite::tungstenite::Error>(good)]);
        assert!(wait_for_auth(&mut replies).await.unwrap().is_empty());

        let denied = Message::Binary(encode_packet(8, 1, br#"{"code":7}"#).into());
        let mut replies = stream::iter([Ok::<_, tokio_tungstenite::tungstenite::Error>(denied)]);
        assert!(matches!(
            wait_for_auth(&mut replies).await,
            Err(BiliError::Protocol("弹幕鉴权失败"))
        ));

        let malformed = Message::Binary(encode_packet(8, 1, b"not json").into());
        let mut replies = stream::iter([Ok::<_, tokio_tungstenite::tungstenite::Error>(malformed)]);
        assert!(matches!(
            wait_for_auth(&mut replies).await,
            Err(BiliError::Protocol("弹幕鉴权响应无效"))
        ));
    }

    #[tokio::test]
    async fn auth_frame_preserves_events_before_and_after_reply_including_compressed_packets() {
        let event = |text: &str| {
            encode_packet(
                5,
                1,
                &serde_json::to_vec(&json!({"cmd":"DANMU_MSG","info":[[],text,[7,"Alice"]]}))
                    .unwrap(),
            )
        };
        let mut compressed = ZlibEncoder::new(Vec::new(), Compression::default());
        compressed.write_all(&event("nested")).unwrap();
        let frame = [
            event("before"),
            encode_packet(8, 1, br#"{"code":0}"#),
            encode_packet(5, 2, &compressed.finish().unwrap()),
            event("after"),
        ]
        .concat();
        let mut replies = stream::iter([Ok::<_, tokio_tungstenite::tungstenite::Error>(
            Message::Binary(frame.into()),
        )]);
        let pending = wait_for_auth(&mut replies).await.unwrap();
        let (events_tx, mut events_rx) = mpsc::channel(3);
        let (transport, _peer) = tokio::io::duplex(1024);
        let socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
            transport,
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await;
        let cancel = CancellationToken::new();
        let stream_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            stream_room(socket, 42, &events_tx, &stream_cancel, pending).await
        });
        assert_eq!(events_rx.recv().await.unwrap().message, "before");
        assert_eq!(events_rx.recv().await.unwrap().message, "nested");
        assert_eq!(events_rx.recv().await.unwrap().message, "after");
        assert!(events_rx.try_recv().is_err());
        cancel.cancel();
        assert_eq!(
            timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap(),
            ConnectionEnd::Cancelled
        );
    }

    #[tokio::test]
    async fn auth_reply_preserves_events_from_earlier_websocket_frames() {
        let event = |text: &str| {
            encode_packet(
                5,
                1,
                &serde_json::to_vec(&json!({"cmd":"DANMU_MSG","info":[[],text,[7,"Alice"]]}))
                    .unwrap(),
            )
        };
        let frames = vec![
            Ok::<_, tokio_tungstenite::tungstenite::Error>(Message::Binary(
                event("earlier").into(),
            )),
            Ok(Message::Binary(
                [event("before-reply"), encode_packet(8, 1, br#"{"code":0}"#)]
                    .concat()
                    .into(),
            )),
        ];
        let pending = wait_for_auth(&mut stream::iter(frames)).await.unwrap();
        let messages = pending
            .iter()
            .filter_map(|packet| serde_json::from_slice::<Value>(&packet.body).ok())
            .filter_map(|value| parse_live_event(42, 1, &value))
            .map(|event| event.message)
            .collect::<Vec<_>>();
        assert_eq!(messages, ["earlier", "before-reply"]);
    }

    #[tokio::test]
    async fn auth_pending_events_are_bounded_across_websocket_frames() {
        let event = encode_packet(5, 1, b"{}");
        let frames = vec![
            Ok::<_, tokio_tungstenite::tungstenite::Error>(Message::Binary(
                event.repeat(MAX_PACKETS).into(),
            )),
            Ok(Message::Binary(
                [event, encode_packet(8, 1, br#"{"code":0}"#)]
                    .concat()
                    .into(),
            )),
        ];
        assert!(matches!(
            wait_for_auth(&mut stream::iter(frames)).await,
            Err(BiliError::Protocol("鉴权前弹幕积压超限"))
        ));
    }

    #[tokio::test]
    async fn denied_auth_frame_never_releases_adjacent_events() {
        let event = encode_packet(
            5,
            1,
            &serde_json::to_vec(&json!({"cmd":"DANMU_MSG","info":[[],"private",[7,"Alice"]]}))
                .unwrap(),
        );
        let frame = [event.clone(), encode_packet(8, 1, br#"{"code":7}"#), event].concat();
        let mut replies = stream::iter([Ok::<_, tokio_tungstenite::tungstenite::Error>(
            Message::Binary(frame.into()),
        )]);
        assert!(matches!(
            wait_for_auth(&mut replies).await,
            Err(BiliError::Protocol("弹幕鉴权失败"))
        ));
    }

    #[test]
    fn account_identity_requires_matching_login_and_safe_avatar() {
        let mut value = json!({"code":0,"data":{"isLogin":true,"mid":42,"uname":"桃子","face":"http://i0.hdslb.com/bfs/face/member.jpg"}});
        let profile = parse_account_profile(&value, 42).unwrap();
        assert_eq!(profile.name, "桃子");
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("https://i0.hdslb.com/bfs/face/member.jpg")
        );
        assert!(parse_account_profile(&value, 43).is_err());
        value["data"]["face"] = json!("https://untrusted.example/avatar.png");
        assert!(
            parse_account_profile(&value, 42)
                .unwrap()
                .avatar_url
                .is_none()
        );
        value["data"]["isLogin"] = json!(false);
        assert_eq!(
            parse_account_profile(&value, 42),
            Err(BiliError::SessionExpired)
        );
    }

    #[test]
    fn old_sessions_load_without_identity_and_profile_round_trips_without_debug_leaks() {
        let old = br#"{"user_id":42,"sessdata":"fixture-secret","bili_jct":"csrf"}"#;
        let mut session = BiliSession::from_secret_payload(old).unwrap();
        assert!(session.profile().is_none());
        let profile = BiliAccountProfile {
            user_id: 42,
            name: "桃子".into(),
            avatar_url: None,
        };
        session.set_profile(profile.clone()).unwrap();
        let mut bytes = session.secret_payload().unwrap();
        let restored = BiliSession::from_secret_payload(&bytes).unwrap();
        assert_eq!(restored.profile(), Some(&profile));
        assert!(!format!("{restored:?}").contains("桃子"));
        let mut wrong = profile;
        wrong.user_id = 43;
        assert!(session.set_profile(wrong).is_err());
        bytes.zeroize();
    }

    #[tokio::test]
    async fn zero_broadcaster_uid_is_rejected_before_any_request() {
        let client = QrLoginClient::new().unwrap();
        assert_eq!(
            client.room_id_for_uid(0, None).await,
            Err(BiliError::InvalidUid)
        );
    }

    #[test]
    fn uid_room_lookup_distinguishes_missing_room_from_bad_api_data() {
        assert_eq!(
            parse_uid_room(&json!({"code":0,"data":{"roomStatus":1,"roomid":314159}})),
            Ok(314159)
        );
        for data in [json!({"roomStatus":0}), json!({"roomStatus":1,"roomid":0})] {
            assert_eq!(
                parse_uid_room(&json!({"code":0,"data":data})),
                Err(BiliError::NoOwnRoom)
            );
        }
        assert_eq!(
            parse_uid_room(&json!({"code":-400,"message":"private server detail"})),
            Err(BiliError::Api(-400))
        );
        for invalid in [
            json!({}),
            json!({"code":0}),
            json!({"code":0,"data":null}),
            json!({"code":0,"data":{"roomStatus":"1","roomid":42}}),
            json!({"code":0,"data":{"roomStatus":1}}),
            json!({"code":0,"data":{"roomStatus":1,"roomid":"42"}}),
            json!({"code":0,"data":{"roomStatus":1,"roomid":-1}}),
        ] {
            assert!(matches!(
                parse_uid_room(&invalid),
                Err(BiliError::Protocol(_))
            ));
        }
    }

    #[test]
    fn qr_generate_accepts_exact_current_and_legacy_bilibili_hosts() {
        const KEY: &str = "0123456789abcdef0123456789abcdef";
        for host in ["account.bilibili.com", "passport.bilibili.com"] {
            let value = json!({
                "code": 0,
                "data": {
                    "url": format!("https://{host}/h5-app/passport/login/scan?navhide=1&qrcode_key=synthetic"),
                    "qrcode_key": KEY,
                }
            });
            let challenge = parse_qr_challenge(&value).unwrap();
            assert_eq!(challenge.phase(), QrPhase::WaitingForScan);
            assert!(challenge.time_left() > Duration::ZERO);
        }

        for url in [
            "https://account.bilibili.com.evil.example/scan",
            "https://account.bilibili.com:444/scan",
            "http://account.bilibili.com/scan",
            "https://account.bilibili.com@evil.example/scan",
        ] {
            let value = json!({"code":0,"data":{"url":url,"qrcode_key":KEY}});
            assert!(matches!(
                parse_qr_challenge(&value),
                Err(BiliError::Protocol("二维码地址或密钥无效"))
            ));
        }
        let bad_key = json!({"code":0,"data":{"url":"https://account.bilibili.com/scan","qrcode_key":"short"}});
        assert!(matches!(
            parse_qr_challenge(&bad_key),
            Err(BiliError::Protocol("二维码地址或密钥无效"))
        ));
    }

    #[test]
    fn qr_state_and_cookie_shapes_are_offline() {
        let headers = HeaderMap::new();
        let pending = json!({"code":0,"data":{"code":86101}});
        assert!(matches!(
            parse_qr_poll(&pending, &headers).unwrap(),
            ParsedQrPoll::WaitingForScan
        ));
        let scanned = json!({"code":0,"data":{"code":86090}});
        assert!(matches!(
            parse_qr_poll(&scanned, &headers).unwrap(),
            ParsedQrPoll::WaitingForConfirmation
        ));
        let expired = json!({"code":0,"data":{"code":86038}});
        assert!(matches!(
            parse_qr_poll(&expired, &headers).unwrap(),
            ParsedQrPoll::Expired
        ));

        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("SESSDATA=abc%2Cdef; HttpOnly; Secure"),
        );
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("bili_jct=csrf123; Secure"),
        );
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("DedeUserID=42; Secure"),
        );
        let done = json!({"code":0,"data":{"code":0,"url":"https://passport.biligame.com/crossDomain?ticket=one-time", "refresh_token":"rt"}});
        let ParsedQrPoll::Complete {
            cookies,
            refresh_token,
            ..
        } = parse_qr_poll(&done, &headers).unwrap()
        else {
            panic!("expected completion")
        };
        let session = cookies.into_session(refresh_token).unwrap();
        assert_eq!(session.user_id(), 42);
        assert_eq!(
            format!("{session:?}"),
            "BiliSession { user_id: 42, credentials: \"[redacted]\" }"
        );
        assert!(!format!("{session:?}").contains("abc"));

        let legacy = json!({"code":0,"data":{"code":0,"url":"https://passport.biligame.com/crossDomain?DedeUserID=43&SESSDATA=sess%2Cpart&bili_jct=csrf"}});
        let ParsedQrPoll::Complete { cookies, .. } =
            parse_qr_poll(&legacy, &HeaderMap::new()).unwrap()
        else {
            panic!("expected legacy completion")
        };
        let legacy_session = cookies.into_session(None).unwrap();
        assert_eq!(legacy_session.user_id(), 43);
        assert!(
            legacy_session
                .cookie_header()
                .contains("SESSDATA=sess%2Cpart")
        );
        let untrusted = json!({"code":0,"data":{"code":0,"url":"https://evil.example/crossDomain?SESSDATA=secret"}});
        assert!(matches!(
            parse_qr_poll(&untrusted, &HeaderMap::new()),
            Err(BiliError::Protocol(_))
        ));
    }

    #[test]
    fn four_event_types_and_nested_packets() {
        let samples = [
            json!({"cmd":"DANMU_MSG:4:0:2:2:2:0","info":[[],"你好",[12,"甲"]]}),
            json!({"cmd":"SEND_GIFT","data":{"uid":13,"uname":"乙","giftName":"辣条","num":2,"price":1500,"coin_type":"gold","tid":"t1"}}),
            json!({"cmd":"SUPER_CHAT_MESSAGE","data":{"uid":14,"user_info":{"uname":"丙"},"message":"醒目","price":30,"id":99}}),
            json!({"cmd":"GUARD_BUY","data":{"uid":15,"username":"丁","guard_level":3,"num":1}}),
        ];
        let inner: Vec<u8> = samples
            .iter()
            .flat_map(|sample| encode_packet(5, 1, &serde_json::to_vec(sample).unwrap()))
            .collect();
        let direct = decode_live_events(99, 1234, &inner).unwrap();
        assert_eq!(direct.len(), 4);
        assert_eq!(direct[0].kind, EventKind::Danmaku);
        assert_eq!(direct[0].message, "你好");
        assert_eq!(direct[1].price_yuan, 3.0);
        assert_eq!(direct[1].platform_event_id.as_deref(), Some("t1"));
        assert_eq!(direct[2].price_yuan, 30.0);
        assert_eq!(direct[2].platform_event_id.as_deref(), Some("99"));
        assert_eq!(direct[3].guard_name, "舰长");
        assert!(
            direct
                .iter()
                .all(|event| event.room_id == 99 && event.observed_at_ms == 1234)
        );

        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
        zlib.write_all(&inner).unwrap();
        let zlib_frame = encode_packet(5, 2, &zlib.finish().unwrap());
        assert_eq!(decode_live_events(99, 1234, &zlib_frame).unwrap(), direct);

        let mut brotli = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut brotli, 4096, 5, 22);
            writer.write_all(&inner).unwrap();
        }
        let brotli_frame = encode_packet(5, 3, &brotli);
        assert_eq!(decode_live_events(99, 1234, &brotli_frame).unwrap(), direct);
    }

    #[test]
    fn danmaku_avatar_and_inline_emotes_reach_serialized_event() {
        let mut metadata = vec![Value::Null; 16];
        metadata[15] = json!({
            "user": {"base": {"face": "http://i2.hdslb.com/bfs/face/member.jpg"}},
            "extra": json!({"emots": {
                "[dog]": {"url": "https://i1.hdslb.com/bfs/emote/dog.png"},
                "[absent]": {"url": "https://i1.hdslb.com/bfs/emote/absent.png"}
            }, "id_str": "364b06e3c561af3d5921f1253d66c1d575"}).to_string()
        });
        let raw = json!({
            "cmd": "DANMU_MSG:4:0:2:2:2:0",
            "info": [metadata, "你好[dog][dog]", [12, "甲"]]
        });
        let event = parse_live_event(99, 1234, &raw).unwrap();
        assert_eq!(
            event.avatar_url.as_deref(),
            Some("https://i2.hdslb.com/bfs/face/member.jpg")
        );
        assert_eq!(
            event.emotes,
            vec![LiveEmote {
                text: "[dog]".into(),
                url: "https://i1.hdslb.com/bfs/emote/dog.png".into(),
                large: false,
            }]
        );
        let serialized = serde_json::to_value(&event).unwrap();
        assert_eq!(
            serialized["avatar_url"],
            "https://i2.hdslb.com/bfs/face/member.jpg"
        );
        assert_eq!(serialized["emotes"][0]["text"], "[dog]");
        assert_eq!(serialized["emotes"][0]["large"], false);
        assert_eq!(
            event.platform_event_id.as_deref(),
            Some("364b06e3c561af3d5921f1253d66c1d575")
        );

        let mut former_event = serialized.clone();
        former_event["emotes"][0]
            .as_object_mut()
            .unwrap()
            .remove("large");
        let former_event: LiveEvent = serde_json::from_value(former_event).unwrap();
        assert!(!former_event.emotes[0].large);

        let mut old_event = serialized;
        old_event.as_object_mut().unwrap().remove("avatar_url");
        old_event.as_object_mut().unwrap().remove("emotes");
        let restored: LiveEvent = serde_json::from_value(old_event).unwrap();
        assert!(restored.avatar_url.is_none());
        assert!(restored.emotes.is_empty());
    }

    #[test]
    fn danmaku_replay_is_bounded_without_suppressing_a_repeated_message() {
        fn danmaku(id: Option<&str>) -> LiveEvent {
            let mut metadata = vec![Value::Null; 16];
            if let Some(id) = id {
                metadata[15] = json!({"extra": json!({"id_str": id}).to_string()});
            }
            parse_live_event(
                99,
                1234,
                &json!({"cmd":"DANMU_MSG","info":[metadata,"再来一次",[12,"甲"]]}),
            )
            .unwrap()
        }

        let first = danmaku(Some("364b06e3c561af3d5921f1253d66c1d575"));
        let repeated = danmaku(Some("364b06e3c561af3d5921f1253d66c1d576"));
        let no_id = danmaku(None);
        assert_ne!(first.platform_event_id, repeated.platform_event_id);
        assert!(no_id.platform_event_id.is_none());

        let start = Instant::now();
        let mut pipeline = EventPipeline::new(GiftMergeSettings::default()).unwrap();
        assert_eq!(pipeline.ingest(first.clone(), start).len(), 1);
        assert!(
            pipeline
                .ingest(first.clone(), start + Duration::from_secs(1))
                .is_empty()
        );
        assert_eq!(
            pipeline
                .ingest(repeated, start + Duration::from_secs(1))
                .len(),
            1,
            "the same user may legitimately send the same text twice"
        );
        assert_eq!(
            pipeline.ingest(no_id, start + Duration::from_secs(1)).len(),
            1,
            "an event without a reliable ID is not guessed from text or time"
        );
        assert_eq!(
            pipeline
                .ingest(first, start + Duration::from_secs(121))
                .len(),
            1,
            "replay suppression is bounded to the live session window"
        );
    }

    #[test]
    fn whole_message_emote_and_other_event_avatars_are_mapped() {
        let mut metadata = vec![Value::Null; 16];
        metadata[13] = json!({"url": "//i0.hdslb.com/bfs/live/room.gif"});
        let danmaku = parse_live_event(
            1,
            2,
            &json!({"cmd":"DANMU_MSG","info":[metadata,"[房间表情]",[7,"甲"]]}),
        )
        .unwrap();
        assert_eq!(
            danmaku.emotes,
            vec![LiveEmote {
                text: "[房间表情]".into(),
                url: "https://i0.hdslb.com/bfs/live/room.gif".into(),
                large: true,
            }]
        );
        let gift = parse_live_event(
            1,
            2,
            &json!({"cmd":"SEND_GIFT","data":{"uid":8,"uname":"乙","face":"https://i0.hdslb.com/bfs/face/gift.jpg","giftName":"辣条","num":1,"price":1000}}),
        )
        .unwrap();
        assert_eq!(
            gift.avatar_url.as_deref(),
            Some("https://i0.hdslb.com/bfs/face/gift.jpg")
        );
        let super_chat = parse_live_event(
            1,
            2,
            &json!({"cmd":"SUPER_CHAT_MESSAGE","data":{"uid":9,"user_info":{"uname":"丙","face":"https://i1.hdslb.com/bfs/face/sc.jpg"},"message":"醒目","price":30}}),
        )
        .unwrap();
        assert_eq!(
            super_chat.avatar_url.as_deref(),
            Some("https://i1.hdslb.com/bfs/face/sc.jpg")
        );
    }

    #[test]
    fn untrusted_or_malformed_image_metadata_is_ignored() {
        for raw in [
            "https://i0.hdslb.com.evil.example/bfs/face/x.jpg",
            "https://i0.hdslb.com@evil.example/bfs/face/x.jpg",
            "https://i0.hdslb.com:444/bfs/face/x.jpg",
            "javascript:alert(1)",
            "data:image/svg+xml,evil",
            "https://i0.hdslb.com/elsewhere/x.jpg",
        ] {
            assert_eq!(bili_image_url(Some(&json!(raw))), None);
        }
        let mut metadata = vec![Value::Null; 16];
        metadata[13] = json!({"url":"https://evil.example/bfs/live/room.gif"});
        metadata[15] = json!({
            "user":{"base":{"face":"https://evil.example/bfs/face/attack.jpg"}},
            "extra":"{malformed"
        });
        let event = parse_live_event(
            1,
            2,
            &json!({"cmd":"DANMU_MSG","info":[metadata,"hello",[7,"甲"]]}),
        )
        .unwrap();
        assert!(event.avatar_url.is_none());
        assert!(event.emotes.is_empty());
    }

    #[test]
    fn malformed_frames_hosts_and_backoff_are_bounded() {
        assert!(decode_live_events(1, 0, &[0, 1, 2]).is_err());
        let mut packet = encode_packet(5, 1, b"{}");
        packet[0..4].copy_from_slice(&999u32.to_be_bytes());
        assert!(decode_live_events(1, 0, &packet).is_err());
        assert!(!valid_chat_host("evil.chat.bilibili.com.attacker.example"));
        assert!(valid_chat_host("broadcastlv.chat.bilibili.com"));
        assert_eq!(reconnect_delay(1), Duration::from_secs(1));
        assert_eq!(reconnect_delay(2), Duration::from_secs(2));
        assert_eq!(reconnect_delay(99), Duration::from_secs(30));
        let heartbeat = encode_packet(2, 1, b"[object Object]");
        assert_eq!(u32::from_be_bytes(heartbeat[8..12].try_into().unwrap()), 2);
        assert_eq!(&heartbeat[16..], b"[object Object]");
        let info = json!({"data":{"token":"x","host_list":[{"host":"evil.test","wss_port":443},{"host":"broadcastlv.chat.bilibili.com","wss_port":443}]}});
        assert_eq!(parse_danmu_info(&info).unwrap().hosts.len(), 1);
    }

    #[test]
    fn compressed_siblings_share_one_unpacked_byte_budget() {
        let inner = encode_packet(5, 1, &vec![b'X'; 3 * 1024 * 1024]);
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&inner).unwrap();
        let compressed = encode_packet(5, 2, &encoder.finish().unwrap());
        assert_eq!(decode_packets(&compressed).unwrap().len(), 1);

        let siblings = [compressed.as_slice(); 3].concat();
        assert!(matches!(
            decode_packets(&siblings),
            Err(BiliError::Protocol("弹幕解压后累计大小超限"))
        ));
    }

    #[test]
    fn wbi_signing_uses_live_nav_keys_and_sorted_query() {
        let img =
            wbi_image_key("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png")
                .unwrap();
        let sub =
            wbi_image_key("https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png")
                .unwrap();
        let mixin = mixin_key(&img, &sub).unwrap();
        assert_eq!(mixin, "ea1db124af3c7062474693fa704f4ff8");
        assert_eq!(
            signed_danmu_query(545068, 1702204169, &mixin),
            "id=545068&type=0&web_location=444.8&wts=1702204169&w_rid=a2ac37a437757a8ae6fbab3db3aa7b99"
        );
        assert!(wbi_image_key("https://evil.test/x/short.png").is_none());
    }

    #[test]
    fn nav_distinguishes_anonymous_wbi_from_expired_saved_session() {
        let nav = json!({
            "code": -101,
            "data": {
                "isLogin": false,
                "wbi_img": {
                    "img_url": "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
                    "sub_url": "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"
                }
            }
        });
        assert_eq!(
            nav_wbi_mixin(&nav, false).unwrap(),
            "ea1db124af3c7062474693fa704f4ff8"
        );
        assert_eq!(
            nav_wbi_mixin(&nav, true).unwrap_err(),
            BiliError::SessionExpired
        );
        let transient = json!({"code": -412, "data": {"isLogin": false}});
        assert!(!matches!(
            nav_wbi_mixin(&transient, true),
            Err(BiliError::SessionExpired)
        ));
    }

    #[test]
    fn session_payload_is_explicit_and_debug_is_redacted() {
        let session = BiliSession {
            user_id: 123,
            sessdata: "secret".into(),
            bili_jct: "csrf".into(),
            buvid3: None,
            refresh_token: None,
            profile: None,
        };
        let mut payload = session.secret_payload().unwrap();
        let restored = BiliSession::from_secret_payload(&payload).unwrap();
        assert_eq!(restored.user_id(), 123);
        assert!(!format!("{restored:?}").contains("secret"));
        payload.zeroize();
    }

    #[tokio::test]
    async fn expired_qr_and_room_task_guard_need_no_network() {
        let client = QrLoginClient::new().unwrap();
        let mut challenge = QrChallenge {
            qr_url: "https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=sample"
                .into(),
            key: "0123456789abcdef0123456789abcdef".into(),
            created: Instant::now() - QR_TTL,
            phase: QrPhase::WaitingForScan,
        };
        assert!(matches!(
            client.poll(&mut challenge).await.unwrap(),
            QrPoll::Expired
        ));
        assert_eq!(challenge.phase(), QrPhase::Expired);
        assert!(matches!(
            client.poll(&mut challenge).await,
            Err(BiliError::QrFinished)
        ));

        let room = BiliRoomClient::new().unwrap();
        room.start_task(1, |cancel, _| {
            tokio::spawn(async move { cancel.cancelled().await })
        })
        .await
        .unwrap();
        assert!(matches!(
            room.start_task(1, |_, _| unreachable!()).await,
            Err(BiliError::AlreadyRunning)
        ));
        room.stop().await;
        assert_eq!(*room.subscribe_state().borrow(), RoomState::Stopped);
        room.start_task(1, |cancel, _| {
            tokio::spawn(async move { cancel.cancelled().await })
        })
        .await
        .unwrap();
        room.stop().await;
    }
}
