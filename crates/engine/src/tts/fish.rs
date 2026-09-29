//! Hosted Fish Audio TTS over the documented JSON `/v1/tts` endpoint.

use std::{fmt, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, Url, header::HeaderValue, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::{
    AudioEncoding, AudioStream, TtsError, network_error, network_error_at, read_limited,
    send_bytes, spawn_stream,
};

const SERVICE: &str = "Fish Audio";
const TTS_URL: &str = "https://api.fish.audio/v1/tts";
const CREDIT_URL: &str = "https://api.fish.audio/wallet/self/api-credit";
const SAMPLE_RATE: u32 = 44_100;
const MAX_BUFFERED_PCM_BYTES: usize = 64 * 1024 * 1024;

pub const API_KEYS_URL: &str = "https://fish.audio/zh-CN/app/api-keys/";
pub const DISCOVERY_URL: &str = "https://fish.audio/zh-CN/app/discovery/";
pub const BUILTIN_VOICES: [(&str, &str); 5] = [
    ("4ed45d53ee9245d9abf20db5221b19b2", "莫提斯"),
    ("b4f70fdef5f943c2bf43db00e80ad680", "高松灯（企鹅）"),
    ("4ca68a299cb24ae599dbb828dc31a73c", "井芹仁菜"),
    ("68a48589ed77491c9b442e956b6e346b", "安和昴"),
    ("561fcedfdf0e4e1399d1bc4930d50c0e", "赛马娘（曼波欧耶版）"),
];
pub const DEFAULT_VOICE_ID: &str = "561fcedfdf0e4e1399d1bc4930d50c0e";

/// Accept a 32-hex model ID or a Fish Audio model page, without fetching the
/// supplied URL. This is the same input shape as the legacy voice editor.
pub fn normalize_voice_id(input: &str) -> Result<String, TtsError> {
    let value = input.trim();
    if is_voice_id(value) {
        return Ok(value.to_ascii_lowercase());
    }
    let url = Url::parse(value)
        .map_err(|_| configuration("请输入 32 位音色 ID 或 Fish Audio 音色页面链接"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("fish.audio")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(configuration(
            "请输入 32 位音色 ID 或 Fish Audio 音色页面链接",
        ));
    }
    let mut segments: Vec<&str> = url
        .path_segments()
        .ok_or_else(|| configuration("请输入 32 位音色 ID 或 Fish Audio 音色页面链接"))?
        .collect();
    if segments.last() == Some(&"") {
        segments.pop();
    }
    let model_id = match segments.as_slice() {
        ["m", id] | ["app", "m", id] => Some(*id),
        [locale, "m", id] if valid_locale(locale) => Some(*id),
        [locale, "app", "m", id] if valid_locale(locale) => Some(*id),
        _ => None,
    };
    model_id
        .filter(|id| is_voice_id(id))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| configuration("请输入 32 位音色 ID 或 Fish Audio 音色页面链接"))
}

fn is_voice_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_locale(value: &str) -> bool {
    let (language, region) = value.split_once('-').unwrap_or((value, ""));
    (2..=3).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_alphabetic())
        && (region.is_empty()
            || ((2..=4).contains(&region.len())
                && region.bytes().all(|byte| byte.is_ascii_alphabetic())))
}

/// A clipboard hint only. Unknown key formats can still be entered and
/// verified through the read-only account endpoint.
pub fn looks_like_copied_key(input: &str) -> bool {
    let Some(suffix) = input.trim().strip_prefix("sk-") else {
        return false;
    };
    (40..=128).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FishModel {
    #[serde(rename = "s1")]
    S1,
    #[serde(rename = "s2-pro")]
    S2Pro,
    #[serde(rename = "s2.1-pro")]
    S21Pro,
    #[serde(rename = "s2.1-pro-free")]
    S21ProFree,
}

impl FishModel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::S1 => "s1",
            Self::S2Pro => "s2-pro",
            Self::S21Pro => "s2.1-pro",
            Self::S21ProFree => "s2.1-pro-free",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FishLatency {
    Normal,
    Balanced,
    Low,
}

/// Non-secret Fish settings remembered for one service connection. Voice IDs,
/// names, speed and playback gain remain in the ordinary voice presets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FishPlaybackSettings {
    pub model: FishModel,
    pub latency: FishLatency,
    pub volume_db: f32,
    pub temperature: f32,
    pub top_p: f32,
    pub streaming: bool,
}

impl Default for FishPlaybackSettings {
    fn default() -> Self {
        Self {
            model: FishModel::S21ProFree,
            latency: FishLatency::Normal,
            volume_db: 0.0,
            temperature: 0.7,
            top_p: 0.7,
            streaming: true,
        }
    }
}

impl FishPlaybackSettings {
    pub fn is_valid(&self) -> bool {
        self.volume_db.is_finite()
            && (-20.0..=20.0).contains(&self.volume_db)
            && [self.temperature, self.top_p]
                .into_iter()
                .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
    }
}

impl FishLatency {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Balanced => "balanced",
            Self::Low => "low",
        }
    }
}

#[derive(Clone)]
pub struct FishConfig {
    api_key: Zeroizing<String>,
    pub reference_id: String,
    pub model: FishModel,
    pub latency: FishLatency,
    pub speed: f32,
    /// Fish Audio prosody volume is in dB, unlike the application's main gain.
    pub volume_db: f32,
    pub temperature: f32,
    pub top_p: f32,
    pub normalize_text: bool,
    pub streaming: bool,
    pub timeout_secs: u64,
}

impl FishConfig {
    /// The key stays in memory and must be obtained from the application's
    /// protected credential store. It is never included in `Debug` output.
    pub fn new(api_key: impl Into<String>, reference_id: impl Into<String>) -> Self {
        let api_key = Zeroizing::new(api_key.into());
        Self {
            api_key: Zeroizing::new(api_key.trim().to_owned()),
            reference_id: reference_id.into(),
            model: FishModel::S21ProFree,
            latency: FishLatency::Normal,
            speed: 1.0,
            volume_db: 0.0,
            temperature: 0.7,
            top_p: 0.7,
            normalize_text: true,
            streaming: true,
            timeout_secs: 180,
        }
    }

    pub fn apply_playback_settings(&mut self, settings: &FishPlaybackSettings) {
        self.model = settings.model;
        self.latency = settings.latency;
        self.volume_db = settings.volume_db;
        self.temperature = settings.temperature;
        self.top_p = settings.top_p;
        self.streaming = settings.streaming;
    }
}

impl fmt::Debug for FishConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FishConfig")
            .field("api_key", &"[redacted]")
            .field("reference_id", &self.reference_id)
            .field("model", &self.model)
            .field("latency", &self.latency)
            .field("speed", &self.speed)
            .field("volume_db", &self.volume_db)
            .field("temperature", &self.temperature)
            .field("top_p", &self.top_p)
            .field("normalize_text", &self.normalize_text)
            .field("streaming", &self.streaming)
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

pub struct FishClient {
    config: FishConfig,
    endpoint: Url,
    http: Client,
}

impl FishClient {
    pub fn new(config: FishConfig) -> Result<Self, TtsError> {
        let endpoint = Url::parse(TTS_URL).expect("fixed Fish Audio URL is valid");
        Self::with_endpoint(config, endpoint)
    }

    fn with_endpoint(mut config: FishConfig, endpoint: Url) -> Result<Self, TtsError> {
        validate_api_key(&config.api_key)?;
        config.reference_id = normalize_voice_id(&config.reference_id)?;
        if !config.speed.is_finite() || !(0.5..=2.0).contains(&config.speed) {
            return Err(configuration("语速须在 0.5 到 2.0 倍之间"));
        }
        if !config.volume_db.is_finite() || !(-20.0..=20.0).contains(&config.volume_db) {
            return Err(configuration("音量须在 -20 到 20 dB 之间"));
        }
        for value in [config.temperature, config.top_p] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(configuration("采样参数须在 0 到 1 之间"));
            }
        }
        if !(5..=600).contains(&config.timeout_secs) {
            return Err(configuration("超时须在 5 到 600 秒之间"));
        }
        let http = fish_http_builder()?
            // Never carry a bearer token to a redirect destination. TLS
            // certificate validation remains enabled for the official URL.
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|_| configuration("无法创建 HTTPS 客户端"))?;
        Ok(Self {
            config,
            endpoint,
            http,
        })
    }

    /// Explicit, read-only lookup through the official `GET /model/{id}` API.
    /// It does not synthesize audio or follow redirects with the API key.
    pub async fn voice_name(&self, cancellation: &CancellationToken) -> Result<String, TtsError> {
        let mut url = self.endpoint.clone();
        url.set_path("/model");
        url.path_segments_mut()
            .map_err(|_| configuration("音色查询地址无效"))?
            .push(&self.config.reference_id);
        let authorization = authorization_header(&self.config.api_key)?;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = self.http.get(url)
                .header(reqwest::header::AUTHORIZATION, authorization)
                .send() => result.map_err(|error| network_error_at(SERVICE, &error, "查询音色时"))?,
        };
        if !response.status().is_success() {
            return Err(http_error(response.status().as_u16()));
        }
        let bytes = read_limited(response, cancellation, SERVICE, "查询音色时", 256 * 1024).await?;
        let model: Value = serde_json::from_slice(&bytes).map_err(|_| TtsError::Protocol {
            service: SERVICE,
            reason: "音色信息不是预期的 JSON 格式",
        })?;
        model
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_owned)
            .ok_or(TtsError::Protocol {
                service: SERVICE,
                reason: "音色信息缺少名称，请手动填写",
            })
    }

    /// Start exactly one paid synthesis request. PCM chunks are produced as
    /// soon as complete 16-bit samples arrive; HTTP packet boundaries may
    /// split a sample. The request is not automatically retried.
    pub fn stream(&self, text: &str, parent: &CancellationToken) -> Result<AudioStream, TtsError> {
        if parent.is_cancelled() {
            return Err(TtsError::Cancelled);
        }
        if text.trim().is_empty() {
            return Err(configuration("朗读文本不能为空"));
        }
        let config = self.config.clone();
        let body = json!({
            "text": text,
            "reference_id": config.reference_id,
            "format": "pcm",
            "sample_rate": SAMPLE_RATE,
            "temperature": config.temperature,
            "top_p": config.top_p,
            "prosody": {
                "speed": config.speed,
                "volume": config.volume_db,
                "normalize_loudness": true,
            },
            "latency": config.latency.as_str(),
            "normalize": config.normalize_text,
        });
        let client = self.http.clone();
        let url = self.endpoint.clone();
        Ok(spawn_stream(
            AudioEncoding::PcmS16Le {
                sample_rate: SAMPLE_RATE,
                channels: 1,
            },
            parent,
            move |sender, cancellation| async move {
                let authorization = authorization_header(&config.api_key)?;
                let response = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(()),
                    result = client.post(url)
                        .header(reqwest::header::AUTHORIZATION, authorization)
                        .header("model", config.model.as_str())
                        .json(&body)
                        .send() => result.map_err(|error| network_error(SERVICE, &error, false))?,
                };
                if !response.status().is_success() {
                    return Err(http_error(response.status().as_u16()));
                }
                if !pcm_content_type(response.headers().get(reqwest::header::CONTENT_TYPE)) {
                    return Err(TtsError::InvalidAudio {
                        service: SERVICE,
                        reason: "响应不是 PCM 音频",
                    });
                }
                let mut packets = response.bytes_stream();
                let mut odd_byte = None;
                let mut received = false;
                let mut buffered = (!config.streaming).then(Vec::new);
                loop {
                    let packet = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => return Ok(()),
                        result = packets.next() => result,
                    };
                    let Some(packet) = packet else { break };
                    let packet =
                        packet.map_err(|error| network_error(SERVICE, &error, received))?;
                    let mut data = packet.as_ref();
                    if let Some(previous) = odd_byte.take() {
                        if let Some((&first, remainder)) = data.split_first() {
                            if let Some(buffer) = buffered.as_mut() {
                                if buffer.len() > MAX_BUFFERED_PCM_BYTES - 2 {
                                    return Err(TtsError::InvalidAudio {
                                        service: SERVICE,
                                        reason: "完整音频超过 64 MiB 限制",
                                    });
                                }
                                buffer.extend_from_slice(&[previous, first]);
                            } else if !send_bytes(&sender, &cancellation, &[previous, first]).await
                            {
                                return Ok(());
                            }
                            received = true;
                            data = remainder;
                        } else {
                            odd_byte = Some(previous);
                            continue;
                        }
                    }
                    let complete = data.len() & !1;
                    if complete > 0 {
                        if let Some(buffer) = buffered.as_mut() {
                            if complete > MAX_BUFFERED_PCM_BYTES.saturating_sub(buffer.len()) {
                                return Err(TtsError::InvalidAudio {
                                    service: SERVICE,
                                    reason: "完整音频超过 64 MiB 限制",
                                });
                            }
                            buffer.extend_from_slice(&data[..complete]);
                        } else if !send_bytes(&sender, &cancellation, &data[..complete]).await {
                            return Ok(());
                        }
                        received = true;
                    }
                    if complete < data.len() {
                        odd_byte = Some(data[complete]);
                    }
                }
                if odd_byte.is_some() {
                    return Err(TtsError::InvalidAudio {
                        service: SERVICE,
                        reason: "PCM 音频在样本中途结束",
                    });
                }
                if !received {
                    return Err(TtsError::InvalidAudio {
                        service: SERVICE,
                        reason: "服务未返回音频",
                    });
                }
                if let Some(buffer) = buffered
                    && !send_bytes(&sender, &cancellation, &buffer).await
                {
                    return Ok(());
                }
                Ok(())
            },
        ))
    }
}

/// Verify a supplied key with Fish Audio's read-only credit endpoint. This
/// never saves a key and never starts billable synthesis.
pub async fn verify_api_key(
    api_key: &str,
    cancellation: &CancellationToken,
) -> Result<(), TtsError> {
    let endpoint = Url::parse(CREDIT_URL).expect("fixed Fish Audio credit URL is valid");
    verify_api_key_at(api_key, cancellation, endpoint).await
}

async fn verify_api_key_at(
    api_key: &str,
    cancellation: &CancellationToken,
    endpoint: Url,
) -> Result<(), TtsError> {
    let api_key = api_key.trim();
    validate_api_key(api_key)?;
    let authorization = authorization_header(api_key)?;
    let client = fish_http_builder()?
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| configuration("无法创建 HTTPS 客户端"))?;
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
        result = client.get(endpoint)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .send() => result.map_err(|error| network_error_at(SERVICE, &error, "验证 API Key 时"))?,
    };
    if response.status().as_u16() != 200 {
        return Err(verification_http_error(response.status().as_u16()));
    }
    Ok(())
}

fn fish_http_builder() -> Result<reqwest::ClientBuilder, TtsError> {
    let builder = Client::builder();
    #[cfg(windows)]
    {
        // reqwest's system matcher accepts a shared server, but not the Windows
        // per-protocol form (http=host:port;https=host:port). Handle that form
        // explicitly while preserving environment overrides and bypass rules.
        let Ok(settings) = windows_registry::CURRENT_USER
            .open("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        else {
            return Ok(builder);
        };
        if settings.get_u32("ProxyEnable").unwrap_or(0) == 0 {
            return Ok(builder);
        }
        let server = settings.get_string("ProxyServer").unwrap_or_default();
        if !server.contains('=') {
            return Ok(builder);
        }
        let environment = |name: &str| {
            std::env::var(name)
                .ok()
                .or_else(|| std::env::var(name.to_ascii_lowercase()).ok())
                .filter(|s| !s.is_empty())
        };
        let bypass = environment("NO_PROXY").unwrap_or_else(|| {
            settings
                .get_string("ProxyOverride")
                .unwrap_or_default()
                .split(';')
                .map(|entry| {
                    let entry = entry.trim();
                    let parts: Vec<_> = entry.split('.').collect();
                    if let Some(star) = parts.iter().position(|part| *part == "*")
                        && (1..4).contains(&star)
                        && parts[star..].iter().all(|part| *part == "*")
                        && parts[..star].iter().all(|part| part.parse::<u8>().is_ok())
                    {
                        let mut octets = ["0"; 4];
                        octets[..star].copy_from_slice(&parts[..star]);
                        return format!("{}/{}", octets.join("."), star * 8);
                    }
                    entry.replace("*.", "")
                })
                .collect::<Vec<_>>()
                .join(",")
        });
        let mut builder = builder.no_proxy();
        for scheme in ["http", "https"] {
            let server = environment(&format!("{}_PROXY", scheme.to_ascii_uppercase()))
                .or_else(|| {
                    server.split(';').find_map(|entry| {
                        let (key, value) = entry.trim().split_once('=')?;
                        (key.trim().eq_ignore_ascii_case(scheme) && !value.trim().is_empty())
                            .then(|| value.trim().to_owned())
                    })
                })
                .or_else(|| environment("ALL_PROXY"));
            if let Some(server) = server {
                let proxy = if scheme == "https" {
                    reqwest::Proxy::https(server)
                } else {
                    reqwest::Proxy::http(server)
                }
                .map_err(|_| configuration("Windows 系统代理地址无效，请检查代理设置"))?;
                builder = builder.proxy(proxy.no_proxy(reqwest::NoProxy::from_string(&bypass)));
            }
        }
        Ok(builder)
    }
    #[cfg(not(windows))]
    Ok(builder)
}

fn validate_api_key(key: &str) -> Result<(), TtsError> {
    if !(20..=256).contains(&key.len()) || key.bytes().any(|byte| !(33..=126).contains(&byte)) {
        return Err(configuration("请填写有效的 API Key"));
    }
    Ok(())
}

fn verification_http_error(status: u16) -> TtsError {
    let reason = match status {
        401 => "API Key 无效或已过期",
        403 => "当前账号无权访问 API",
        429 => "请求过于频繁",
        503 => "服务暂时不可用",
        300..=399 => "服务返回重定向，已拒绝转发 API Key",
        _ => "无法验证 API Key",
    };
    TtsError::HttpStatus {
        service: SERVICE,
        status,
        reason,
    }
}

fn authorization_header(key: &str) -> Result<HeaderValue, TtsError> {
    let mut value = Zeroizing::new(String::with_capacity(7 + key.len()));
    value.push_str("Bearer ");
    value.push_str(key);
    HeaderValue::from_str(&value).map_err(|_| configuration("API Key 格式无效"))
}

fn configuration(reason: &'static str) -> TtsError {
    TtsError::Configuration {
        service: SERVICE,
        reason,
    }
}

fn pcm_content_type(value: Option<&reqwest::header::HeaderValue>) -> bool {
    value.is_none_or(|value| {
        value.to_str().is_ok_and(|text| {
            matches!(
                text.split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "audio/pcm" | "audio/x-pcm" | "application/pcm" | "application/octet-stream"
            )
        })
    })
}

fn http_error(status: u16) -> TtsError {
    let reason = match status {
        401 => "API Key 无效或已过期",
        402 => "余额不足或所选模型不可用",
        403 => "当前账号无权使用此音色或模型",
        404 => "音色或接口不存在",
        422 => "音色或合成参数无效",
        429 => "请求过于频繁",
        503 => "服务暂时不可用",
        300..=399 => "服务返回重定向，已拒绝转发 API Key",
        _ => "服务未完成合成",
    };
    TtsError::HttpStatus {
        service: SERVICE,
        status,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use tokio::{io::AsyncWriteExt, net::TcpListener, sync::oneshot, time::timeout};

    use super::*;
    use crate::tts::test_http::{chunk, chunked_end, chunked_start, json_response, read_request};

    /// Explicit opt-in live check using an already protected local account.
    /// The selected free model makes one short synthesis request; it never
    /// prints or exports the API key and it does not access the audio device.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires an explicitly configured local Fish Audio account"]
    async fn live_free_model_short_synthesis() {
        use crate::{model::Provider, storage::DataStore};
        let directory = std::env::var_os("DANMAKUVOICE_FISH_TEST_DATA_DIR")
            .expect("set DANMAKUVOICE_FISH_TEST_DATA_DIR explicitly");
        let store = DataStore::open(directory).unwrap();
        let connection = store
            .connections()
            .unwrap()
            .into_iter()
            .find(|connection| connection.settings.provider() == Provider::FishAudio)
            .expect("Fish Audio is not configured");
        let credential = store
            .connection_credential(&connection.id)
            .unwrap()
            .expect("Fish Audio credential is missing");
        let mut config = FishConfig::new(credential.as_str().unwrap(), DEFAULT_VOICE_ID);
        config.model = FishModel::S21ProFree;
        config.timeout_secs = 30;
        let client = FishClient::new(config).unwrap();
        let cancellation = CancellationToken::new();
        let mut stream = client.stream("你好。", &cancellation).unwrap();
        let mut bytes = 0usize;
        while let Some(chunk) = stream.recv().await {
            bytes += chunk.unwrap().len();
        }
        assert!(bytes > 0);
        println!("fish-free-live: received {bytes} PCM bytes");
    }

    #[test]
    fn voice_links_and_clipboard_hints_match_legacy_input_rules() {
        let uppercase = DEFAULT_VOICE_ID.to_ascii_uppercase();
        assert_eq!(normalize_voice_id(&uppercase).unwrap(), DEFAULT_VOICE_ID);
        for page in [
            format!("https://fish.audio/m/{DEFAULT_VOICE_ID}"),
            format!("https://fish.audio/app/m/{DEFAULT_VOICE_ID}/"),
            format!("https://fish.audio/zh-CN/app/m/{DEFAULT_VOICE_ID}/?share=1#preview"),
        ] {
            assert_eq!(normalize_voice_id(&page).unwrap(), DEFAULT_VOICE_ID);
        }
        for invalid in [
            format!("http://fish.audio/m/{DEFAULT_VOICE_ID}"),
            format!("https://fish.audio.evil.example/m/{DEFAULT_VOICE_ID}"),
            format!("https://fish.audio@evil.example/m/{DEFAULT_VOICE_ID}"),
            format!("https://fish.audio/m/{DEFAULT_VOICE_ID}/extra"),
            format!("https://fish.audio:9880/m/{DEFAULT_VOICE_ID}"),
            "not-a-voice-id".to_owned(),
        ] {
            assert!(normalize_voice_id(&invalid).is_err(), "{invalid}");
        }
        assert!(looks_like_copied_key(&format!("sk-{}", "a".repeat(40))));
        assert!(!looks_like_copied_key("sk-short"));
        assert!(!looks_like_copied_key(&format!("sk-{}!", "a".repeat(40))));
    }

    #[tokio::test]
    async fn account_validation_uses_read_only_credit_get_and_never_exposes_key() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            json_response(&mut socket, "200 OK", r#"{"credit":"1.00"}"#).await;
            request
        });
        let key = "sk-test-only-secret-key-12345678901234567890";
        let endpoint = Url::parse(&format!("http://{address}/wallet/self/api-credit")).unwrap();
        verify_api_key_at(key, &CancellationToken::new(), endpoint)
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(request.starts_with(b"GET /wallet/self/api-credit HTTP/1.1"));
        assert!(String::from_utf8_lossy(&request).contains(key));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            request
        });
        let endpoint = Url::parse(&format!("http://{address}/wallet/self/api-credit")).unwrap();
        let error = verify_api_key_at(key, &CancellationToken::new(), endpoint)
            .await
            .unwrap_err();
        assert!(matches!(error, TtsError::HttpStatus { status: 302, .. }));
        assert!(!error.to_string().contains(key));
        assert!(
            server
                .await
                .unwrap()
                .starts_with(b"GET /wallet/self/api-credit")
        );
    }

    #[tokio::test]
    async fn whole_response_mode_waits_for_completion_before_emitting_pcm() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (first_sender, first_receiver) = oneshot::channel();
        let (finish_sender, finish_receiver) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            chunked_start(&mut socket, "audio/pcm").await;
            chunk(&mut socket, &[1, 0]).await;
            first_sender.send(()).unwrap();
            finish_receiver.await.unwrap();
            chunk(&mut socket, &[2, 0]).await;
            chunked_end(&mut socket).await;
            request
        });
        let mut config = FishConfig::new(
            "sk-test-only-secret-key-12345678901234567890",
            DEFAULT_VOICE_ID,
        );
        config.streaming = false;
        config.model = FishModel::S2Pro;
        config.latency = FishLatency::Balanced;
        config.volume_db = -2.0;
        config.temperature = 0.3;
        config.top_p = 0.6;
        let endpoint = Url::parse(&format!("http://{address}/v1/tts")).unwrap();
        let client = FishClient::with_endpoint(config, endpoint).unwrap();
        let mut audio = client.stream("测试", &CancellationToken::new()).unwrap();
        first_receiver.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), audio.recv())
                .await
                .is_err()
        );
        finish_sender.send(()).unwrap();
        assert_eq!(audio.recv().await.unwrap().unwrap(), [1, 0, 2, 0]);
        assert!(audio.recv().await.is_none());
        let request = server.await.unwrap();
        let headers_end = request
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        let headers = String::from_utf8_lossy(&request[..headers_end]).to_ascii_lowercase();
        assert!(headers.contains("model: s2-pro"));
        let body: serde_json::Value = serde_json::from_slice(&request[headers_end..]).unwrap();
        assert_eq!(body["latency"], "balanced");
        assert_eq!(body["prosody"]["volume"], -2.0);
        assert!((body["temperature"].as_f64().unwrap() - 0.3).abs() < 0.0001);
        assert!((body["top_p"].as_f64().unwrap() - 0.6).abs() < 0.0001);
    }

    #[tokio::test]
    async fn pcm_stream_aligns_samples_and_starts_before_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (finish_sender, finish_receiver) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            chunked_start(&mut socket, "audio/pcm").await;
            chunk(&mut socket, &[1]).await;
            chunk(&mut socket, &[0, 2, 0, 3]).await;
            finish_receiver.await.unwrap();
            chunk(&mut socket, &[0]).await;
            chunked_end(&mut socket).await;
            request
        });
        let config = FishConfig::new(
            "sk-test-only-secret-key-12345678901234567890",
            DEFAULT_VOICE_ID,
        );
        let endpoint = Url::parse(&format!("http://{address}/v1/tts")).unwrap();
        let client = FishClient::with_endpoint(config.clone(), endpoint).unwrap();
        assert!(!format!("{config:?}").contains("sk-test-only-secret"));
        let parent = CancellationToken::new();
        let mut audio = client.stream("测试", &parent).unwrap();
        assert_eq!(
            audio.encoding(),
            AudioEncoding::PcmS16Le {
                sample_rate: 44_100,
                channels: 1
            }
        );
        let first = timeout(Duration::from_secs(3), audio.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first, [1, 0]);
        assert!(!server.is_finished());
        finish_sender.send(()).unwrap();
        let mut output = first;
        while let Some(next) = audio.recv().await {
            output.extend_from_slice(&next.unwrap());
        }
        assert_eq!(output, [1, 0, 2, 0, 3, 0]);
        let request = server.await.unwrap();
        let headers_end = request
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        let headers = String::from_utf8_lossy(&request[..headers_end]).to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/tts http/1.1"));
        assert!(
            headers.contains("authorization: bearer sk-test-only-secret-key-12345678901234567890")
        );
        assert!(headers.contains("model: s2.1-pro-free"));
        let body: serde_json::Value = serde_json::from_slice(&request[headers_end..]).unwrap();
        assert_eq!(body["text"], "测试");
        assert_eq!(body["reference_id"], DEFAULT_VOICE_ID);
        assert_eq!(body["format"], "pcm");
        assert_eq!(body["sample_rate"], 44_100);
        assert_eq!(body["prosody"]["speed"], 1.0);
    }

    #[tokio::test]
    async fn redirect_is_rejected_without_exposing_key() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/steal\r\nContent-Length: 30\r\nConnection: close\r\n\r\nBearer sk-test-only-secret-key")
                .await
                .unwrap();
            request
        });
        let key = "sk-test-only-secret-key-12345678901234567890";
        let config = FishConfig::new(key, DEFAULT_VOICE_ID);
        let endpoint = Url::parse(&format!("http://{address}/v1/tts")).unwrap();
        let client = FishClient::with_endpoint(config, endpoint).unwrap();
        let parent = CancellationToken::new();
        let mut audio = client.stream("测试", &parent).unwrap();
        let error = timeout(Duration::from_secs(3), audio.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, TtsError::HttpStatus { status: 302, .. }));
        assert!(!format!("{error:?}").contains(key));
        assert!(!error.to_string().contains(key));
        assert!(server.await.unwrap().starts_with(b"POST /v1/tts"));
    }

    #[tokio::test]
    async fn cancelling_parent_discards_already_buffered_audio() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut socket).await;
            chunked_start(&mut socket, "audio/pcm").await;
            chunk(&mut socket, &[1, 0, 2, 0]).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let config = FishConfig::new(
            "sk-test-only-secret-key-12345678901234567890",
            DEFAULT_VOICE_ID,
        );
        let endpoint = Url::parse(&format!("http://{address}/v1/tts")).unwrap();
        let client = FishClient::with_endpoint(config, endpoint).unwrap();
        let parent = CancellationToken::new();
        let mut audio = client.stream("测试", &parent).unwrap();
        assert!(audio.recv().await.unwrap().is_ok());
        parent.cancel();
        assert!(audio.recv().await.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn voice_lookup_uses_official_model_route_without_synthesis() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            json_response(&mut socket, "200 OK", r#"{"title":"  测试音色  "}"#).await;
            request
        });
        let key = "sk-test-only-secret-key-12345678901234567890";
        let config = FishConfig::new(key, DEFAULT_VOICE_ID);
        let endpoint = Url::parse(&format!("http://{address}/v1/tts")).unwrap();
        let client = FishClient::with_endpoint(config, endpoint).unwrap();
        let name = client.voice_name(&CancellationToken::new()).await.unwrap();
        assert_eq!(name, "测试音色");
        let request = server.await.unwrap();
        assert!(request.starts_with(format!("GET /model/{DEFAULT_VOICE_ID} HTTP/1.1").as_bytes()));
        assert!(String::from_utf8_lossy(&request).contains(key));
    }

    #[tokio::test]
    async fn voice_lookup_missing_title_allows_manual_name_without_reflecting_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            json_response(
                &mut socket,
                "200 OK",
                r#"{"title":123,"reflected":"sk-test-only-secret-key-12345678901234567890"}"#,
            )
            .await;
            request
        });
        let key = "sk-test-only-secret-key-12345678901234567890";
        let config = FishConfig::new(key, DEFAULT_VOICE_ID);
        let endpoint = Url::parse(&format!("http://{address}/v1/tts")).unwrap();
        let client = FishClient::with_endpoint(config, endpoint).unwrap();
        let error = client
            .voice_name(&CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("请手动填写"));
        assert!(!error.to_string().contains(key));
        assert!(server.await.unwrap().starts_with(b"GET /model/"));
    }
}
