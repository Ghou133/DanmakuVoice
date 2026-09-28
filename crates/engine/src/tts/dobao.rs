//! Native Doubao WebSocket TTS. No external proxy or credential file is used.

use std::{
    fmt,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, mpsc},
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        self, Message,
        client::IntoClientRequest,
        http::{HeaderValue, header},
    },
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{AudioEncoding, AudioStream, TtsError, send_bytes, spawn_stream};

const SERVICE: &str = "豆包";
const WS_ENDPOINT: &str = "wss://ws-samantha.doubao.com/samantha/audio/tts";
const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(3200);
const IDLE_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

pub const DEFAULT_VOICE_ID: &str = "zh_female_wenroutaozi_uranus_bigtts";
pub const CLASSIC_VOICE_ID: &str = "zh_female_wenroutaozi_v2_mars_bigtts";

#[derive(Clone, Debug, Deserialize)]
pub struct DoubaoVoice {
    /// The stable voice ID sent as `speaker` in the WebSocket URL.
    #[serde(rename = "style_id")]
    pub id: String,
    pub name: String,
    /// Legacy numeric catalog ID, accepted when loading old voice selections.
    #[serde(rename = "id")]
    pub legacy_id: String,
}

#[derive(Deserialize)]
struct VoiceCatalog {
    voices: Vec<DoubaoVoice>,
}

/// Bundled, offline voice metadata from the earlier application (30 voices).
pub fn voice_catalog() -> &'static [DoubaoVoice] {
    static CATALOG: OnceLock<Vec<DoubaoVoice>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let catalog: VoiceCatalog = serde_json::from_str(include_str!("dobao_voices.json"))
            .expect("bundled Doubao voice catalog is valid");
        catalog.voices
    })
}

pub fn normalize_voice_id(value: &str) -> Result<String, TtsError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 200 || trimmed.chars().any(char::is_control)
    {
        return Err(configuration("请选择有效的豆包音色"));
    }
    match trimmed {
        "taozi" => return Ok(DEFAULT_VOICE_ID.to_owned()),
        "taozi-classic" => return Ok(CLASSIC_VOICE_ID.to_owned()),
        _ => {}
    }
    Ok(voice_catalog()
        .iter()
        .find(|voice| trimmed == voice.id || trimmed == voice.name || trimmed == voice.legacy_id)
        .map_or_else(|| trimmed.to_owned(), |voice| voice.id.clone()))
}

/// Stable web IDs should be persisted by the application, separate from secrets.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DoubaoDevice {
    pub device_id: String,
    pub web_id: String,
    pub web_tab_id: String,
}

impl DoubaoDevice {
    pub fn generate() -> Self {
        fn numeric_id() -> String {
            let uuid = Uuid::new_v4();
            let number =
                u64::from_le_bytes(uuid.as_bytes()[..8].try_into().expect("UUID is 16 bytes"));
            (number % 9_000_000_000_000_000_000 + 1_000_000_000_000_000_000).to_string()
        }
        Self {
            device_id: numeric_id(),
            web_id: numeric_id(),
            web_tab_id: Uuid::new_v4().to_string(),
        }
    }

    pub fn validate(&self) -> Result<(), TtsError> {
        if [&self.device_id, &self.web_id]
            .iter()
            .any(|id| id.len() != 19 || !id.bytes().all(|byte| byte.is_ascii_digit()))
            || Uuid::parse_str(&self.web_tab_id).is_err()
        {
            return Err(configuration("设备标识格式无效"));
        }
        Ok(())
    }
}

/// A validated Cookie header from the app's protected credential store.
pub fn validate_cookie_header(input: &str) -> Result<Zeroizing<String>, TtsError> {
    if input.len() > 32 * 1024 || input.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | 0)) {
        return Err(configuration("登录信息格式无效"));
    }
    let input = input.trim();
    let input = if input
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Cookie:"))
    {
        input[7..].trim()
    } else {
        input
    };
    let mut pairs = Vec::new();
    let mut has_session = false;
    for part in input
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| configuration("登录信息格式无效"))?;
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || value
                .bytes()
                .any(|byte| byte <= 32 || byte == 127 || byte == b';')
        {
            return Err(configuration("登录信息格式无效"));
        }
        if (key == "sessionid" || key == "sessionid_ss") && !value.is_empty() {
            has_session = true;
        }
        pairs.push(part);
    }
    if !has_session || pairs.is_empty() {
        return Err(configuration("请先完成豆包登录"));
    }
    Ok(Zeroizing::new(pairs.join("; ")))
}

pub struct DoubaoConfig {
    cookie: Zeroizing<String>,
    pub device: DoubaoDevice,
    pub voice_id: String,
    pub speed: f32,
    pub timeout_secs: u64,
}

impl DoubaoConfig {
    pub fn new(cookie: &str, device: DoubaoDevice) -> Result<Self, TtsError> {
        Ok(Self {
            cookie: validate_cookie_header(cookie)?,
            device,
            voice_id: DEFAULT_VOICE_ID.to_owned(),
            speed: 1.0,
            timeout_secs: 120,
        })
    }
}

impl fmt::Debug for DoubaoConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DoubaoConfig")
            .field("cookie", &"[redacted]")
            .field("device", &self.device)
            .field("voice_id", &self.voice_id)
            .field("speed", &self.speed)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DoubaoPauseReason {
    Authentication,
    AccountBlocked,
    RateLimited,
}

impl DoubaoPauseReason {
    fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Authentication),
            2 => Some(Self::AccountBlocked),
            3 => Some(Self::RateLimited),
            _ => None,
        }
    }
    fn as_byte(self) -> u8 {
        match self {
            Self::Authentication => 1,
            Self::AccountBlocked => 2,
            Self::RateLimited => 3,
        }
    }
}

#[derive(Default)]
struct GateState {
    next_start: Option<Instant>,
}
type SharedGate = Arc<Mutex<GateState>>;

fn process_gate() -> SharedGate {
    static GATE: OnceLock<SharedGate> = OnceLock::new();
    Arc::clone(GATE.get_or_init(|| Arc::new(Mutex::new(GateState::default()))))
}

fn process_pause() -> Arc<AtomicU8> {
    static PAUSE: OnceLock<Arc<AtomicU8>> = OnceLock::new();
    Arc::clone(PAUSE.get_or_init(|| Arc::new(AtomicU8::new(0))))
}

struct Inner {
    config: DoubaoConfig,
    endpoint: Url,
    gate: SharedGate,
    interval: Duration,
    pause: Arc<AtomicU8>,
}

#[derive(Clone)]
pub struct DoubaoClient {
    inner: Arc<Inner>,
}

impl DoubaoClient {
    pub fn new(config: DoubaoConfig) -> Result<Self, TtsError> {
        let endpoint = Url::parse(WS_ENDPOINT).expect("fixed Doubao URL is valid");
        Self::with_endpoint(
            config,
            endpoint,
            process_gate(),
            process_pause(),
            MIN_REQUEST_INTERVAL,
        )
    }

    fn with_endpoint(
        config: DoubaoConfig,
        endpoint: Url,
        gate: SharedGate,
        pause: Arc<AtomicU8>,
        interval: Duration,
    ) -> Result<Self, TtsError> {
        config.device.validate()?;
        normalize_voice_id(&config.voice_id)?;
        if !config.speed.is_finite() || !(0.5..=2.0).contains(&config.speed) {
            return Err(configuration("语速须在 0.5 到 2.0 倍之间"));
        }
        if !(1..=120).contains(&config.timeout_secs) {
            return Err(configuration("总超时须在 1 到 120 秒之间"));
        }
        if !matches!(endpoint.scheme(), "ws" | "wss") {
            return Err(configuration("WebSocket 地址无效"));
        }
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                endpoint,
                gate,
                interval,
                pause,
            }),
        })
    }

    pub fn pause_reason(&self) -> Option<DoubaoPauseReason> {
        DoubaoPauseReason::from_byte(self.inner.pause.load(Ordering::Acquire))
    }

    /// Called only after the user resolves login or a service rate limit.
    pub fn resume_after_user_action(&self) {
        self.inner.pause.store(0, Ordering::Release);
    }

    /// A confirmed QR login replaces the credential used by all new clients.
    /// Clear their shared pause only after the new credential is persisted.
    pub fn resume_after_confirmed_login() {
        process_pause().store(0, Ordering::Release);
    }

    pub fn stream(&self, text: &str, parent: &CancellationToken) -> Result<AudioStream, TtsError> {
        if text.trim().is_empty() || text.chars().count() > 10_000 {
            return Err(configuration("朗读文本须为 1 到 10000 个字符"));
        }
        if self.pause_reason().is_some() {
            return Err(configuration("豆包请求已暂停，请检查登录或稍后手动恢复"));
        }
        let inner = Arc::clone(&self.inner);
        let text = text.trim().to_owned();
        Ok(spawn_stream(
            AudioEncoding::AacAdts,
            parent,
            move |sender, cancellation| async move {
                let mut gate = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(()),
                    guard = inner.gate.lock() => guard,
                };
                if inner.pause.load(Ordering::Acquire) != 0 {
                    return Err(configuration("豆包请求已暂停，请检查登录或稍后手动恢复"));
                }
                if let Some(instant) = gate.next_start {
                    tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => return Ok(()),
                        _ = tokio::time::sleep_until(instant) => {},
                    }
                }
                gate.next_start = Some(Instant::now() + inner.interval);
                // The guard covers the entire synthesis, not just connection setup.
                let result = timeout(
                    Duration::from_secs(inner.config.timeout_secs),
                    run_request(&inner, &text, &sender, &cancellation),
                )
                .await;
                drop(gate);
                match result {
                    Ok(value) => value,
                    Err(_) => Err(TtsError::Network {
                        service: SERVICE,
                        stage: "",
                        reason: "合成总时间超过上限",
                    }),
                }
            },
        ))
    }
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
fn invalid_audio(reason: &'static str) -> TtsError {
    TtsError::InvalidAudio {
        service: SERVICE,
        reason,
    }
}

fn websocket_url(inner: &Inner) -> Url {
    let mut url = inner.endpoint.clone();
    let speech_rate = ((inner.config.speed as f64 - 1.0) * 100.0 + 0.5).floor() as i32;
    let voice_id = normalize_voice_id(&inner.config.voice_id).expect("config validated");
    url.query_pairs_mut()
        .append_pair("speaker", &voice_id)
        .append_pair("format", "aac")
        .append_pair("speech_rate", &speech_rate.to_string())
        .append_pair("pitch", "0")
        .append_pair("version_code", "20800")
        .append_pair("language", "zh")
        .append_pair("device_platform", "web")
        .append_pair("aid", "497858")
        .append_pair("real_aid", "497858")
        .append_pair("pkg_type", "release_version")
        .append_pair("device_id", &inner.config.device.device_id)
        .append_pair("pc_version", "3.11.1")
        .append_pair("web_id", &inner.config.device.web_id)
        .append_pair("tea_uuid", &inner.config.device.web_id)
        .append_pair("region", "CN")
        .append_pair("sys_region", "CN")
        .append_pair("samantha_web", "1")
        .append_pair("use-olympus-account", "1")
        .append_pair("web_tab_id", &inner.config.device.web_tab_id);
    url
}

async fn run_request(
    inner: &Inner,
    text: &str,
    sender: &mpsc::Sender<Result<Vec<u8>, TtsError>>,
    cancellation: &CancellationToken,
) -> Result<(), TtsError> {
    let url = websocket_url(inner);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| configuration("WebSocket 地址无效"))?;
    let headers = request.headers_mut();
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("https://www.doubao.com"),
    );
    headers.insert(
        header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("zh,zh-CN;q=0.9"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&inner.config.cookie)
            .map_err(|_| configuration("登录信息格式无效"))?,
    );
    let mut ws_config = tungstenite::protocol::WebSocketConfig::default();
    ws_config.max_message_size = Some(MAX_AUDIO_BYTES);
    ws_config.max_frame_size = Some(MAX_AUDIO_BYTES);
    let connected = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Ok(()),
        result = timeout(CONNECT_TIMEOUT, connect_async_with_config(request, Some(ws_config), false)) => result,
    };
    let (mut socket, _) = match connected {
        Err(_) => {
            return Err(TtsError::Network {
                service: SERVICE,
                stage: "连接",
                reason: "连接超时",
            });
        }
        Ok(Err(error)) => return Err(ws_error(inner, error, "连接")),
        Ok(Ok(pair)) => pair,
    };
    for event in [
        json!({"event":"text","text":text}),
        json!({"event":"finish"}),
    ] {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = socket.send(Message::Text(event.to_string().into())) => {
                result.map_err(|error| ws_error(inner, error, "发送"))?;
            },
        }
    }
    let mut adts = AdtsDecoder::default();
    loop {
        let message = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = timeout(IDLE_TIMEOUT, socket.next()) => result,
        };
        let message = match message {
            Err(_) => {
                return Err(TtsError::Network {
                    service: SERVICE,
                    stage: "接收",
                    reason: "服务响应超时",
                });
            }
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(error))) => return Err(ws_error(inner, error, "接收")),
            Ok(None) => return Err(protocol("连接在完成事件之前关闭")),
        };
        match message {
            Message::Text(text) => {
                let event: Value =
                    serde_json::from_str(text.as_str()).map_err(|_| protocol("无法识别的事件"))?;
                if process_event(inner, &event, &adts)? {
                    return Ok(());
                }
            }
            Message::Binary(bytes) => {
                let data = bytes.as_ref();
                if data
                    .iter()
                    .take(64)
                    .find(|byte| !byte.is_ascii_whitespace())
                    .is_some_and(|byte| *byte == b'{' || *byte == b'[')
                    && let Ok(event) = serde_json::from_slice::<Value>(data)
                {
                    if process_event(inner, &event, &adts)? {
                        return Ok(());
                    }
                    continue;
                }
                adts.push(data, sender, cancellation).await?;
            }
            Message::Close(_) => return Err(protocol("连接在完成事件之前关闭")),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

fn process_event(inner: &Inner, event: &Value, adts: &AdtsDecoder) -> Result<bool, TtsError> {
    let event = event.as_object().ok_or_else(|| protocol("事件格式无效"))?;
    let code = [
        event.get("code"),
        event.get("error").and_then(|error| error.get("code")),
        event.get("status_code"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| match value {
        Value::String(code) if code != "0" => Some(code.clone()),
        Value::Number(code) if code.to_string() != "0" => Some(code.to_string()),
        _ => None,
    });
    if code.is_some()
        || event
            .get("error")
            .is_some_and(|value| !value.is_null() && value != false)
        || event.get("event").and_then(Value::as_str) == Some("error")
    {
        let reason = match code.as_deref() {
            Some("710012001") => Some(DoubaoPauseReason::Authentication),
            Some("710022002") => Some(DoubaoPauseReason::AccountBlocked),
            Some("671000003") => Some(DoubaoPauseReason::RateLimited),
            _ => None,
        };
        if let Some(reason) = reason {
            inner.pause.store(reason.as_byte(), Ordering::Release);
        }
        return Err(match reason {
            Some(DoubaoPauseReason::Authentication) => {
                protocol("登录状态无效，请重新登录（710012001）")
            }
            Some(DoubaoPauseReason::AccountBlocked) => {
                protocol("账号或设备语音请求受限（710022002）")
            }
            Some(DoubaoPauseReason::RateLimited) => protocol("请求频率过高（671000003）"),
            None => protocol("服务拒绝了语音合成请求"),
        });
    }
    if event.get("event").and_then(Value::as_str) == Some("finish") {
        if !adts.has_audio || !adts.pending.is_empty() {
            return Err(invalid_audio("AAC 音频为空或帧不完整"));
        }
        return Ok(true);
    }
    Ok(false)
}

fn ws_error(inner: &Inner, error: tungstenite::Error, stage: &'static str) -> TtsError {
    if let tungstenite::Error::Http(response) = &error {
        let status = response.status().as_u16();
        let reason = match status {
            401 => {
                inner.pause.store(
                    DoubaoPauseReason::Authentication.as_byte(),
                    Ordering::Release,
                );
                "登录状态无效，请重新登录"
            }
            403 => {
                inner.pause.store(
                    DoubaoPauseReason::AccountBlocked.as_byte(),
                    Ordering::Release,
                );
                "账号或设备语音请求受限"
            }
            429 => {
                inner
                    .pause
                    .store(DoubaoPauseReason::RateLimited.as_byte(), Ordering::Release);
                "请求频率过高"
            }
            300..=399 => "连接被重定向",
            _ => "服务未接受连接",
        };
        return TtsError::HttpStatus {
            service: SERVICE,
            status,
            reason,
        };
    }
    TtsError::Network {
        service: SERVICE,
        stage,
        reason: "WebSocket 传输失败",
    }
}

#[derive(Default)]
struct AdtsDecoder {
    pending: Vec<u8>,
    total_bytes: usize,
    has_audio: bool,
}

impl AdtsDecoder {
    async fn push(
        &mut self,
        data: &[u8],
        sender: &mpsc::Sender<Result<Vec<u8>, TtsError>>,
        cancellation: &CancellationToken,
    ) -> Result<(), TtsError> {
        self.total_bytes = self
            .total_bytes
            .checked_add(data.len())
            .ok_or_else(|| invalid_audio("AAC 音频超过上限"))?;
        if self.total_bytes > MAX_AUDIO_BYTES {
            return Err(invalid_audio("AAC 音频超过 16 MiB 上限"));
        }
        self.pending.extend_from_slice(data);
        let mut cursor = 0;
        while self.pending.len() - cursor >= 7 {
            let frame = &self.pending[cursor..];
            if frame[0] != 0xff || frame[1] & 0xf6 != 0xf0 {
                return Err(invalid_audio("AAC ADTS 帧头无效"));
            }
            let frequency = (frame[2] >> 2) & 0x0f;
            let header_len = if frame[1] & 1 != 0 { 7 } else { 9 };
            let frame_len = ((frame[3] as usize & 3) << 11)
                | ((frame[4] as usize) << 3)
                | ((frame[5] as usize) >> 5);
            if frequency >= 13 || frame_len <= header_len {
                return Err(invalid_audio("AAC ADTS 帧长度无效"));
            }
            if frame.len() < frame_len {
                break;
            }
            if !send_bytes(sender, cancellation, &frame[..frame_len]).await {
                return Ok(());
            }
            self.has_audio = true;
            cursor += frame_len;
        }
        self.pending.drain(..cursor);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    const FRAME: [u8; 11] = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, 1, 2, 3, 4];

    fn config() -> DoubaoConfig {
        DoubaoConfig::new(
            "sessionid=test-secret; csrf_token=test",
            DoubaoDevice {
                device_id: "1000000000000000000".to_owned(),
                web_id: "2000000000000000000".to_owned(),
                web_tab_id: Uuid::new_v4().to_string(),
            },
        )
        .unwrap()
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // tungstenite's handshake callback fixes this result type.
    async fn native_stream_sends_old_contract_and_validates_split_adts() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "ws://{}/samantha/audio/tts",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(socket, |request: &Request, response: Response| {
                let url = Url::parse(&format!("http://localhost{}", request.uri())).unwrap();
                let query: std::collections::HashMap<_, _> =
                    url.query_pairs().into_owned().collect();
                assert_eq!(
                    query.get("speaker").map(String::as_str),
                    Some(DEFAULT_VOICE_ID)
                );
                assert_eq!(query.get("format").map(String::as_str), Some("aac"));
                assert_eq!(query.get("speech_rate").map(String::as_str), Some("0"));
                assert_eq!(
                    query.get("device_id").map(String::as_str),
                    Some("1000000000000000000")
                );
                assert_eq!(
                    request.headers()[header::COOKIE],
                    "sessionid=test-secret; csrf_token=test"
                );
                assert_eq!(request.headers()[header::ORIGIN], ORIGIN_FOR_TEST);
                Ok(response)
            })
            .await
            .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().to_text().unwrap(),
                r#"{"event":"text","text":"你好"}"#
            );
            assert_eq!(
                socket.next().await.unwrap().unwrap().to_text().unwrap(),
                r#"{"event":"finish"}"#
            );
            socket
                .send(Message::Binary(FRAME[..3].to_vec().into()))
                .await
                .unwrap();
            socket
                .send(Message::Binary(FRAME[3..].to_vec().into()))
                .await
                .unwrap();
            socket
                .send(Message::Text(r#"{"event":"finish"}"#.into()))
                .await
                .unwrap();
        });
        let client = DoubaoClient::with_endpoint(
            config(),
            endpoint,
            Arc::new(Mutex::new(GateState::default())),
            Arc::new(AtomicU8::new(0)),
            Duration::ZERO,
        )
        .unwrap();
        let parent = CancellationToken::new();
        let mut stream = client.stream("你好", &parent).unwrap();
        assert_eq!(stream.encoding(), AudioEncoding::AacAdts);
        assert_eq!(stream.recv().await.unwrap().unwrap(), FRAME);
        assert!(stream.recv().await.is_none());
        server.await.unwrap();
    }

    const ORIGIN_FOR_TEST: &str = "https://www.doubao.com";

    #[tokio::test]
    async fn upstream_rate_limit_pauses_without_retry_and_redacts_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "ws://{}/samantha/audio/tts",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            for _ in 0..2 {
                socket.next().await.unwrap().unwrap();
            }
            socket
                .send(Message::Text(
                    r#"{"event":"error","code":671000003,"message":"secret-Cookie-value"}"#.into(),
                ))
                .await
                .unwrap();
        });
        let client = DoubaoClient::with_endpoint(
            config(),
            endpoint,
            Arc::new(Mutex::new(GateState::default())),
            Arc::new(AtomicU8::new(0)),
            Duration::ZERO,
        )
        .unwrap();
        let parent = CancellationToken::new();
        let mut stream = client.stream("test", &parent).unwrap();
        let error = stream.recv().await.unwrap().unwrap_err();
        assert!(error.to_string().contains("671000003"));
        assert!(!error.to_string().contains("secret-Cookie-value"));
        assert_eq!(client.pause_reason(), Some(DoubaoPauseReason::RateLimited));
        assert!(client.stream("again", &parent).is_err());
        client.resume_after_user_action();
        assert_eq!(client.pause_reason(), None);
        server.await.unwrap();
    }

    #[test]
    fn confirmed_login_resumes_new_clients_sharing_process_pause() {
        let pause = process_pause();
        pause.store(
            DoubaoPauseReason::Authentication.as_byte(),
            Ordering::Release,
        );
        let client = DoubaoClient::new(config()).unwrap();
        assert_eq!(
            client.pause_reason(),
            Some(DoubaoPauseReason::Authentication)
        );
        DoubaoClient::resume_after_confirmed_login();
        assert_eq!(client.pause_reason(), None);
    }

    #[tokio::test]
    async fn incomplete_adts_is_rejected_at_finish() {
        let mut decoder = AdtsDecoder::default();
        let (sender, _receiver) = mpsc::channel(8);
        decoder
            .push(&FRAME[..8], &sender, &CancellationToken::new())
            .await
            .unwrap();
        let inner = DoubaoClient::with_endpoint(
            config(),
            Url::parse(WS_ENDPOINT).unwrap(),
            Arc::new(Mutex::new(GateState::default())),
            Arc::new(AtomicU8::new(0)),
            Duration::ZERO,
        )
        .unwrap();
        let error = process_event(&inner.inner, &json!({"event":"finish"}), &decoder).unwrap_err();
        assert!(matches!(error, TtsError::InvalidAudio { .. }));
    }

    #[tokio::test]
    async fn concurrent_streams_hold_one_gate_until_finish() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Url::parse(&format!(
            "ws://{}/samantha/audio/tts",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = tokio::spawn(async move {
            let (first, _) = listener.accept().await.unwrap();
            let mut first = tokio_tungstenite::accept_async(first).await.unwrap();
            for _ in 0..2 {
                first.next().await.unwrap().unwrap();
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
            first
                .send(Message::Binary(FRAME.to_vec().into()))
                .await
                .unwrap();
            first
                .send(Message::Text(r#"{"event":"finish"}"#.into()))
                .await
                .unwrap();
            let (second, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut second = tokio_tungstenite::accept_async(second).await.unwrap();
            for _ in 0..2 {
                second.next().await.unwrap().unwrap();
            }
            second
                .send(Message::Binary(FRAME.to_vec().into()))
                .await
                .unwrap();
            second
                .send(Message::Text(r#"{"event":"finish"}"#.into()))
                .await
                .unwrap();
        });
        let client = DoubaoClient::with_endpoint(
            config(),
            endpoint,
            Arc::new(Mutex::new(GateState::default())),
            Arc::new(AtomicU8::new(0)),
            Duration::from_millis(10),
        )
        .unwrap();
        let parent = CancellationToken::new();
        let mut first = client.stream("first", &parent).unwrap();
        let mut second = client.stream("second", &parent).unwrap();
        assert_eq!(first.recv().await.unwrap().unwrap(), FRAME);
        assert_eq!(second.recv().await.unwrap().unwrap(), FRAME);
        assert!(first.recv().await.is_none());
        assert!(second.recv().await.is_none());
        server.await.unwrap();
    }
}
