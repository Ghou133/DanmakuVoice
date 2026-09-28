//! Browser-free Doubao QR login. The caller explicitly starts and confirms one
//! session, then passes the Cookie to the application's protected secret store.

use std::{collections::BTreeMap, fmt, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use qrcode::{EcLevel, QrCode};
use reqwest::{
    Client, Url,
    header::{self, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde_json::Value;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use super::dobao::validate_cookie_header;
use super::{TtsError, read_limited};

const SERVICE: &str = "豆包扫码登录";
const ORIGIN: &str = "https://www.doubao.com";
const QR_TTL: Duration = Duration::from_secs(60);
const CONFIRMED_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_BODY: usize = 2 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

/// Display the PNG directly or draw the bool matrix as black modules, with a
/// quiet zone of at least two modules. The QR content is an opaque login token.
pub enum QrVisual {
    Png(Vec<u8>),
    Matrix { width: usize, modules: Vec<bool> },
}

impl Drop for QrVisual {
    fn drop(&mut self) {
        match self {
            Self::Png(bytes) => bytes.zeroize(),
            Self::Matrix { modules, .. } => modules.fill(false),
        }
    }
}

impl fmt::Debug for QrVisual {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("QrVisual([redacted])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QrStatus {
    Waiting,
    Scanned,
    Confirmed,
    Expired,
    Consumed,
}

/// An opaque QR attempt. `Debug` cannot reveal the QR or any credential.
pub struct QrSession {
    qr: QrVisual,
    token: Zeroizing<String>,
    fingerprint: Zeroizing<String>,
    csrf: Zeroizing<String>,
    jar: BTreeMap<String, Zeroizing<String>>,
    confirmed_cookie: Option<Zeroizing<String>>,
    expires_at: Instant,
    status: QrStatus,
}

impl fmt::Debug for QrSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QrSession")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl QrSession {
    pub fn qr_visual(&self) -> &QrVisual {
        &self.qr
    }
    pub fn status(&self) -> QrStatus {
        if Instant::now() >= self.expires_at && !matches!(self.status, QrStatus::Consumed) {
            QrStatus::Expired
        } else {
            self.status
        }
    }
    pub fn expires_in(&self) -> Duration {
        self.expires_at.saturating_duration_since(Instant::now())
    }

    /// Move a confirmed Cookie into the DPAPI-backed store. This method does
    /// not write a file or keep another copy of the credential.
    pub fn take_confirmed_cookie(&mut self) -> Result<Zeroizing<String>, TtsError> {
        if self.status() == QrStatus::Expired {
            self.expire();
        }
        if self.status() != QrStatus::Confirmed {
            return Err(configuration("请先扫码并在豆包应用中确认登录"));
        }
        let cookie = self
            .confirmed_cookie
            .take()
            .ok_or_else(|| protocol("缺少已确认的登录信息"))?;
        self.clear_visual();
        self.token.zeroize();
        self.fingerprint.zeroize();
        self.csrf.zeroize();
        self.jar.clear();
        self.status = QrStatus::Consumed;
        Ok(cookie)
    }

    fn expire(&mut self) {
        self.status = QrStatus::Expired;
        self.clear_visual();
        self.token.zeroize();
        self.fingerprint.zeroize();
        self.csrf.zeroize();
        self.jar.clear();
        self.confirmed_cookie = None;
    }

    fn clear_visual(&mut self) {
        self.qr = QrVisual::Matrix {
            width: 0,
            modules: Vec::new(),
        };
    }
}

pub struct DoubaoQrAuth {
    http: Client,
    origin: Url,
}

impl DoubaoQrAuth {
    pub fn new() -> Result<Self, TtsError> {
        Self::with_origin(Url::parse(ORIGIN).expect("fixed Doubao origin is valid"))
    }

    fn with_origin(origin: Url) -> Result<Self, TtsError> {
        if !matches!(origin.scheme(), "https" | "http") || origin.host_str().is_none() {
            return Err(configuration("登录服务地址无效"));
        }
        let http = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| configuration("无法创建 HTTPS 客户端"))?;
        Ok(Self { http, origin })
    }

    /// Start only in response to an explicit user action; this contacts the
    /// Doubao login endpoint and does not launch a browser or scan a QR code.
    pub async fn start_qr_login(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<QrSession, TtsError> {
        let mut session = QrSession {
            qr: QrVisual::Matrix {
                width: 0,
                modules: Vec::new(),
            },
            token: Zeroizing::new(String::new()),
            fingerprint: Zeroizing::new(fingerprint()),
            csrf: Zeroizing::new(Uuid::new_v4().simple().to_string()),
            jar: BTreeMap::new(),
            confirmed_cookie: None,
            expires_at: Instant::now(),
            status: QrStatus::Waiting,
        };
        let body = self
            .upstream(
                "/passport/web/get_qrcode/",
                &mut session,
                None,
                cancellation,
            )
            .await?;
        let data = body
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| protocol("没有返回有效的登录二维码"))?;
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty() && token.len() <= 8192)
            .ok_or_else(|| protocol("没有返回有效的登录二维码"))?;
        session.qr = qr_visual(data)?;
        session.token = Zeroizing::new(token.to_owned());
        session.expires_at = Instant::now() + QR_TTL;
        Ok(session)
    }

    pub async fn poll_qr_login(
        &self,
        session: &mut QrSession,
        cancellation: &CancellationToken,
    ) -> Result<QrStatus, TtsError> {
        if session.status() == QrStatus::Expired {
            session.expire();
            return Ok(QrStatus::Expired);
        }
        if matches!(session.status, QrStatus::Confirmed | QrStatus::Consumed) {
            return Ok(session.status);
        }
        let token = Zeroizing::new(session.token.to_string());
        let body = self
            .upstream(
                "/passport/web/check_qrconnect/",
                session,
                Some(&token),
                cancellation,
            )
            .await?;
        let data = body
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| protocol("二维码登录状态暂时不可用"))?;
        if data.get("status").and_then(Value::as_str) == Some("expired") {
            session.expire();
        } else if data.get("status").and_then(Value::as_str) == Some("confirmed")
            || data
                .get("redirect_url")
                .is_some_and(|value| value.as_str().is_some_and(|url| !url.is_empty()))
        {
            let cookie = cookie_header(&session.jar);
            session.confirmed_cookie = Some(
                validate_cookie_header(&cookie)
                    .map_err(|_| protocol("扫码已确认，但未返回完整登录信息"))?,
            );
            session.status = QrStatus::Confirmed;
            session.expires_at = Instant::now() + CONFIRMED_TTL;
        } else if data.get("status").and_then(Value::as_str) == Some("scanned") {
            session.status = QrStatus::Scanned;
        } else if body.get("error_code").is_some_and(nonzero_error)
            || data.get("error_code").is_some_and(nonzero_error)
        {
            return Err(protocol("二维码登录状态暂时不可用"));
        }
        Ok(session.status)
    }

    async fn upstream(
        &self,
        route: &str,
        session: &mut QrSession,
        token: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Value, TtsError> {
        let mut url = self
            .origin
            .join(route)
            .map_err(|_| configuration("登录服务地址无效"))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("next", ORIGIN)
                .append_pair("aid", "497858")
                .append_pair("account_sdk_source", "web")
                .append_pair("sdk_version", "2.2.11-doubao.0")
                .append_pair("verifyFp", &session.fingerprint)
                .append_pair("fp", &session.fingerprint);
            if let Some(token) = token {
                query.append_pair("token", token);
            }
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/json, text/javascript"),
        );
        headers.insert(
            header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("zh-CN,zh;q=0.9"),
        );
        headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("https://www.doubao.com/chat/?from_logout=1"),
        );
        headers.insert(
            "x-tt-passport-csrf-token",
            HeaderValue::from_str(&session.csrf).map_err(|_| configuration("登录会话无效"))?,
        );
        headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
        headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        if !session.jar.is_empty() {
            let cookie = cookie_header(&session.jar);
            headers.insert(
                header::COOKIE,
                HeaderValue::from_str(&cookie).map_err(|_| configuration("登录会话无效"))?,
            );
        }
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = self.http.get(url).headers(headers).send() => result,
        }
        .map_err(|_| TtsError::Network {
            service: SERVICE,
            stage: "",
            reason: "登录服务暂时无法连接",
        })?;
        match response.status().as_u16() {
            200 => {}
            403 => return Err(protocol("豆包暂未接受二维码登录")),
            429 => return Err(protocol("登录请求过于频繁")),
            _ => return Err(protocol("登录服务暂时不可用")),
        }
        merge_set_cookies(&mut session.jar, response.headers());
        let body = read_limited(response, cancellation, SERVICE, "读取登录响应", MAX_BODY).await?;
        let body: Value =
            serde_json::from_slice(&body).map_err(|_| protocol("登录响应格式无效"))?;
        if !body.is_object() {
            return Err(protocol("登录响应格式无效"));
        }
        Ok(body)
    }
}

fn nonzero_error(value: &Value) -> bool {
    value != 0 && value != "0" && !value.is_null()
}

fn cookie_header(jar: &BTreeMap<String, Zeroizing<String>>) -> Zeroizing<String> {
    let mut cookie = Zeroizing::new(String::new());
    for (key, value) in jar {
        if !cookie.is_empty() {
            cookie.push_str("; ");
        }
        cookie.push_str(key);
        cookie.push('=');
        cookie.push_str(value.as_str());
    }
    cookie
}

fn merge_set_cookies(jar: &mut BTreeMap<String, Zeroizing<String>>, headers: &HeaderMap) {
    for raw in headers.get_all(header::SET_COOKIE) {
        let Ok(raw) = raw.to_str() else { continue };
        let pair = raw.split(';').next().unwrap_or_default().trim();
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || value
                .bytes()
                .any(|byte| byte <= 32 || byte == 127 || byte == b';')
        {
            continue;
        }
        jar.insert(key.to_owned(), Zeroizing::new(value.to_owned()));
    }
}

fn qr_visual(data: &serde_json::Map<String, Value>) -> Result<QrVisual, TtsError> {
    if let Some(base64_png) = data.get("qrcode").and_then(Value::as_str)
        && base64_png.starts_with("iVBORw0KGgo")
    {
        let compact = Zeroizing::new(
            base64_png
                .chars()
                .filter(|char| !matches!(char, '\r' | '\n'))
                .collect::<String>(),
        );
        if compact.len() <= MAX_BODY
            && let Ok(png) = STANDARD.decode(&compact)
            && png.starts_with(b"\x89PNG\r\n\x1a\n")
            && png.len() <= MAX_BODY
            && png.len() >= 24
        {
            let width = u32::from_be_bytes(png[16..20].try_into().expect("checked PNG length"));
            let height = u32::from_be_bytes(png[20..24].try_into().expect("checked PNG length"));
            if (1..=1024).contains(&width) && (1..=1024).contains(&height) {
                return Ok(QrVisual::Png(png));
            }
        }
    }
    let url = data
        .get("qrcode_index_url")
        .or_else(|| data.get("scan_url"))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty() && url.len() <= 8192)
        .ok_or_else(|| protocol("没有返回有效的登录二维码"))?;
    let qr = QrCode::with_error_correction_level(url.as_bytes(), EcLevel::M)
        .map_err(|_| protocol("无法生成登录二维码"))?;
    let width = qr.width();
    let modules = qr
        .to_colors()
        .into_iter()
        .map(|color| color == qrcode::Color::Dark)
        .collect();
    Ok(QrVisual::Matrix { width, modules })
}

fn fingerprint() -> String {
    let hex = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    format!(
        "verify_{}_{}_{}_{}_{}_{}",
        &hex[0..8],
        &hex[8..16],
        &hex[16..20],
        &hex[20..24],
        &hex[24..28],
        &hex[28..40]
    )
}

fn configuration(reason: &'static str) -> TtsError {
    TtsError::Configuration {
        service: SERVICE,
        reason,
    }
}
fn protocol(reason: &'static str) -> TtsError {
    TtsError::Protocol {
        service: SERVICE,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncWriteExt, net::TcpListener};

    #[tokio::test]
    async fn qr_login_waits_for_confirmation_then_releases_one_cookie() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            for index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = super::super::test_http::read_request(&mut socket).await;
                let request = String::from_utf8(request).unwrap();
                assert!(request.contains("aid=497858"));
                assert!(request.contains("verifyFp=verify_"));
                assert!(request.contains("fp=verify_"));
                let (json, cookies) = match index {
                    0 => {
                        assert!(request.starts_with("GET /passport/web/get_qrcode/?"));
                        (
                            r#"{"data":{"token":"secret-qr-token","qrcode_index_url":"https://www.doubao.com/qr/secret-qr-token"}}"#,
                            "Set-Cookie: csrf=abc; Path=/\r\n",
                        )
                    }
                    1 => {
                        assert!(request.starts_with("GET /passport/web/check_qrconnect/?"));
                        assert!(request.contains("token=secret-qr-token"));
                        assert!(request.contains("csrf=abc"));
                        (r#"{"data":{"status":"scanned"}}"#, "")
                    }
                    _ => (
                        r#"{"data":{"status":"confirmed"}}"#,
                        "Set-Cookie: sessionid=confirmed-secret; Path=/\r\n",
                    ),
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{cookies}Content-Length: {}\r\nConnection: close\r\n\r\n{json}", json.len()).as_bytes()).await.unwrap();
            }
        });
        let auth = DoubaoQrAuth::with_origin(origin).unwrap();
        let cancellation = CancellationToken::new();
        let mut session = auth.start_qr_login(&cancellation).await.unwrap();
        match session.qr_visual() {
            QrVisual::Matrix { width, modules } => assert_eq!(width * width, modules.len()),
            QrVisual::Png(_) => panic!("URL response should generate a matrix"),
        }
        assert_eq!(session.status(), QrStatus::Waiting);
        assert_eq!(
            auth.poll_qr_login(&mut session, &cancellation)
                .await
                .unwrap(),
            QrStatus::Scanned
        );
        assert!(session.take_confirmed_cookie().is_err());
        assert_eq!(
            auth.poll_qr_login(&mut session, &cancellation)
                .await
                .unwrap(),
            QrStatus::Confirmed
        );
        assert!(!format!("{session:?}").contains("confirmed-secret"));
        let cookie = session.take_confirmed_cookie().unwrap();
        assert!(cookie.contains("sessionid=confirmed-secret"));
        assert_eq!(session.status(), QrStatus::Consumed);
        assert!(session.take_confirmed_cookie().is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_qr_start_does_not_send_request() {
        let auth = DoubaoQrAuth::with_origin(Url::parse("http://127.0.0.1:1").unwrap()).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            auth.start_qr_login(&cancellation).await.unwrap_err(),
            TtsError::Cancelled
        );
    }
}
