//! GPT-SoVITS `api_v2.py` REST client with optional atomic Kinoko extension.
//!
//! Standard `/tts` synthesis never changes the server's globally loaded
//! weights. The two `/set_*_weights` calls are available only through the
//! explicitly named method intended for a confirmed GUI operation.

use std::time::Duration;

use reqwest::{Client, Response, Url, redirect::Policy};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    AudioEncoding, AudioStream, TtsError, confirmed_loopback_offline, forward_wav_response,
    network_error, network_error_at, read_limited, spawn_stream,
};

const SERVICE: &str = "GPT-SoVITS";
const MAX_WAV_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SovitsMode {
    Standard,
    AtomicExtension,
}

/// How a synthesis request selects its model. Standard api_v2.py reads the
/// server's currently loaded global weights; it must never change them as a
/// side effect of one utterance.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SovitsModelSelection {
    GlobalResident,
    PerRequestAtomic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SovitsLanguage {
    Auto,
    Chinese,
    English,
    Japanese,
    Korean,
    Cantonese,
}

impl SovitsLanguage {
    pub fn from_api_code(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "all_zh" => Some(Self::Chinese),
            "en" => Some(Self::English),
            "all_ja" => Some(Self::Japanese),
            "all_ko" => Some(Self::Korean),
            "all_yue" => Some(Self::Cantonese),
            _ => None,
        }
    }

    pub const fn as_api_code(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Chinese => "all_zh",
            Self::English => "en",
            Self::Japanese => "all_ja",
            Self::Korean => "all_ko",
            Self::Cantonese => "all_yue",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextSplit {
    None,
    FourSentences,
    FiftyCharacters,
    ChinesePeriod,
    EnglishPeriod,
    Punctuation,
}

impl TextSplit {
    pub fn from_api_code(value: &str) -> Option<Self> {
        match value {
            "cut0" => Some(Self::None),
            "cut1" => Some(Self::FourSentences),
            "cut2" => Some(Self::FiftyCharacters),
            "cut3" => Some(Self::ChinesePeriod),
            "cut4" => Some(Self::EnglishPeriod),
            "cut5" => Some(Self::Punctuation),
            _ => None,
        }
    }

    pub const fn as_api_code(self) -> &'static str {
        match self {
            Self::None => "cut0",
            Self::FourSentences => "cut1",
            Self::FiftyCharacters => "cut2",
            Self::ChinesePeriod => "cut3",
            Self::EnglishPeriod => "cut4",
            Self::Punctuation => "cut5",
        }
    }
}

#[derive(Clone, Debug)]
pub struct SovitsConfig {
    /// Service root or `/tts` URL. The reference audio path below is resolved
    /// by this server; a desktop-only local path is not uploaded automatically.
    pub endpoint: String,
    pub reference_audio_path: String,
    pub reference_text: String,
    pub reference_text_free: bool,
    pub text_language: SovitsLanguage,
    pub reference_language: SovitsLanguage,
    pub split: TextSplit,
    pub top_k: u16,
    pub top_p: f32,
    pub temperature: f32,
    pub speed_factor: f32,
    pub sample_steps: u16,
    pub super_sampling: bool,
    pub fragment_interval_secs: f32,
    pub model_selection: SovitsModelSelection,
    /// Sent only to the verified `/kinoko/tts` atomic extension. Standard
    /// synthesis does not switch weights using these values.
    pub gpt_weights_path: Option<String>,
    pub sovits_weights_path: Option<String>,
    pub timeout_secs: u64,
}

impl SovitsConfig {
    pub fn new(endpoint: impl Into<String>, reference_audio_path: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            reference_audio_path: reference_audio_path.into(),
            reference_text: String::new(),
            reference_text_free: false,
            text_language: SovitsLanguage::Chinese,
            reference_language: SovitsLanguage::Chinese,
            split: TextSplit::None,
            top_k: 5,
            top_p: 1.0,
            temperature: 1.0,
            speed_factor: 1.0,
            sample_steps: 8,
            super_sampling: false,
            fragment_interval_secs: 0.3,
            model_selection: SovitsModelSelection::GlobalResident,
            gpt_weights_path: None,
            sovits_weights_path: None,
            timeout_secs: 300,
        }
    }
}

pub struct SovitsClient {
    config: SovitsConfig,
    base: Url,
    http: Client,
}

impl SovitsClient {
    pub fn new(config: SovitsConfig) -> Result<Self, TtsError> {
        validate_config(&config)?;
        let base = normalize_base(&config.endpoint)?;
        let http = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|_| configuration("无法创建 HTTP 客户端"))?;
        Ok(Self { config, base, http })
    }

    /// Fresh capability negotiation. A 404 or 405 means standard `api_v2.py`.
    /// Any other status error is surfaced without silently changing weights.
    pub async fn mode(&self, cancellation: &CancellationToken) -> Result<SovitsMode, TtsError> {
        negotiate(&self.http, &self.base, cancellation).await
    }

    /// Read-only queue preflight. The standard API must identify itself via
    /// its OpenAPI routes; a generic 404 at /kinoko/status is insufficient.
    pub async fn readiness(&self, cancellation: &CancellationToken) -> Result<bool, TtsError> {
        match tokio::time::timeout(
            Duration::from_millis(1_500),
            self.readiness_inner(cancellation),
        )
        .await
        {
            Ok(Ok(())) => Ok(true),
            Ok(Err(TtsError::Cancelled)) => Err(TtsError::Cancelled),
            Ok(Err(error)) => {
                if matches!(error, TtsError::Network { .. })
                    && confirmed_loopback_offline(&self.base, cancellation).await?
                {
                    Ok(false)
                } else {
                    Err(error)
                }
            }
            Err(_) => {
                if confirmed_loopback_offline(&self.base, cancellation).await? {
                    Ok(false)
                } else {
                    Err(TtsError::Network {
                        service: SERVICE,
                        stage: "检查服务时",
                        reason: "连接或接收超时",
                    })
                }
            }
        }
    }

    async fn readiness_inner(&self, cancellation: &CancellationToken) -> Result<(), TtsError> {
        let mode = self.mode(cancellation).await?;
        if self.config.model_selection == SovitsModelSelection::PerRequestAtomic
            && mode != SovitsMode::AtomicExtension
        {
            return Err(configuration("服务未提供原子模型选择接口"));
        }
        if mode == SovitsMode::AtomicExtension {
            return Ok(());
        }
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = self.http.get(route(&self.base, "openapi.json")).send() =>
                result.map_err(|error| network_error_at(SERVICE, &error, "检查服务时"))?,
        };
        if !response.status().is_success() {
            return Err(http_error(response.status().as_u16()));
        }
        let body = read_limited(response, cancellation, SERVICE, "检查服务时", 128 * 1024).await?;
        let schema: Value = serde_json::from_slice(&body).map_err(|_| TtsError::Protocol {
            service: SERVICE,
            reason: "服务接口信息不是有效 JSON",
        })?;
        let paths = schema.get("paths").and_then(Value::as_object);
        let expected = [
            ("/tts", "post"),
            ("/set_gpt_weights", "get"),
            ("/set_sovits_weights", "get"),
        ];
        if paths.is_none_or(|paths| {
            expected.iter().any(|(path, method)| {
                paths
                    .get(*path)
                    .and_then(Value::as_object)
                    .is_none_or(|methods| !methods.contains_key(*method))
            })
        }) {
            return Err(TtsError::Protocol {
                service: SERVICE,
                reason: "该地址不是兼容的 GPT-SoVITS 服务",
            });
        }
        Ok(())
    }

    pub fn stream(&self, text: &str, parent: &CancellationToken) -> Result<AudioStream, TtsError> {
        if parent.is_cancelled() {
            return Err(TtsError::Cancelled);
        }
        let request = request_body(&self.config, text, true)?;
        let config = self.config.clone();
        let client = self.http.clone();
        let base = self.base.clone();
        Ok(spawn_stream(
            AudioEncoding::Wav,
            parent,
            move |sender, cancellation| async move {
                let response = send_tts(&client, &base, &config, request, &cancellation).await?;
                forward_wav_response(response, &sender, &cancellation, SERVICE).await
            },
        ))
    }

    pub async fn synthesize_wav(
        &self,
        text: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, TtsError> {
        if cancellation.is_cancelled() {
            return Err(TtsError::Cancelled);
        }
        let request = request_body(&self.config, text, false)?;
        let response =
            send_tts(&self.http, &self.base, &self.config, request, cancellation).await?;
        let audio =
            read_limited(response, cancellation, SERVICE, "接收音频时", MAX_WAV_BYTES).await?;
        if audio.len() < 44 || &audio[..4] != b"RIFF" || &audio[8..12] != b"WAVE" {
            return Err(TtsError::InvalidAudio {
                service: SERVICE,
                reason: "响应不是完整的 WAV 音频",
            });
        }
        Ok(audio)
    }

    /// Only call after the user confirms a server-wide weight change. The
    /// standard `api_v2.py` setters are not atomic: if the second call fails,
    /// the SoVITS weight may already have changed.
    pub async fn switch_global_weights_explicit(
        &self,
        gpt_weights_path: &str,
        sovits_weights_path: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), TtsError> {
        if gpt_weights_path.trim().is_empty() || sovits_weights_path.trim().is_empty() {
            return Err(configuration("请先选择成对的 GPT 与 SoVITS 权重"));
        }
        let first = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = self.http.get(route(&self.base, "set_sovits_weights"))
                .query(&[("weights_path", sovits_weights_path)])
                .send() => result.map_err(|error| network_error_at(SERVICE, &error, "切换 SoVITS 权重时"))?,
        };
        if !first.status().is_success() {
            return Err(TtsError::HttpStatus {
                service: SERVICE,
                status: first.status().as_u16(),
                reason: "切换 SoVITS 权重失败，GPT 权重尚未切换",
            });
        }
        let second = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(partial_switch_error()),
            result = self.http.get(route(&self.base, "set_gpt_weights"))
                .query(&[("weights_path", gpt_weights_path)])
                .send() => result.map_err(|_| partial_switch_error())?,
        };
        if !second.status().is_success() {
            return Err(partial_switch_error());
        }
        Ok(())
    }
}

async fn negotiate(
    client: &Client,
    base: &Url,
    cancellation: &CancellationToken,
) -> Result<SovitsMode, TtsError> {
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
        result = client.get(route(base, "kinoko/status")).send() =>
            result.map_err(|error| network_error_at(SERVICE, &error, "查询服务能力时"))?,
    };
    match response.status().as_u16() {
        404 | 405 => return Ok(SovitsMode::Standard),
        200 => {}
        status => return Err(http_error(status)),
    }
    let body = read_limited(response, cancellation, SERVICE, "查询服务能力时", 16 * 1024).await?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| TtsError::Protocol {
        service: SERVICE,
        reason: "能力信息不是有效 JSON",
    })?;
    if value.get("protocol").and_then(Value::as_u64) == Some(1)
        && value.get("atomic_model_selection").and_then(Value::as_bool) == Some(true)
        && value.get("resident_model_reuse").and_then(Value::as_bool) == Some(true)
    {
        Ok(SovitsMode::AtomicExtension)
    } else {
        Ok(SovitsMode::Standard)
    }
}

async fn send_tts(
    client: &Client,
    base: &Url,
    config: &SovitsConfig,
    tts: Value,
    cancellation: &CancellationToken,
) -> Result<Response, TtsError> {
    let (endpoint, body) = match config.model_selection {
        SovitsModelSelection::GlobalResident => (route(base, "tts"), tts),
        SovitsModelSelection::PerRequestAtomic => {
            if negotiate(client, base, cancellation).await? != SovitsMode::AtomicExtension {
                return Err(configuration("服务未提供原子模型选择接口"));
            }
            let gpt = config
                .gpt_weights_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| configuration("原子服务需要 GPT 权重路径"))?;
            let sovits = config
                .sovits_weights_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| configuration("原子服务需要 SoVITS 权重路径"))?;
            (
                route(base, "kinoko/tts"),
                json!({
                    "gpt_weights_path": gpt,
                    "sovits_weights_path": sovits,
                    "tts": tts,
                }),
            )
        }
    };
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
        result = client.post(endpoint).json(&body).send() =>
            result.map_err(|error| network_error(SERVICE, &error, false))?,
    };
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    Ok(response)
}

fn request_body(config: &SovitsConfig, text: &str, streaming: bool) -> Result<Value, TtsError> {
    if text.trim().is_empty() {
        return Err(configuration("朗读文本不能为空"));
    }
    Ok(json!({
        "text": text,
        "text_lang": config.text_language.as_api_code(),
        "ref_audio_path": config.reference_audio_path,
        "prompt_text": if config.reference_text_free { "" } else { &config.reference_text },
        "prompt_lang": config.reference_language.as_api_code(),
        "top_k": config.top_k,
        "top_p": config.top_p,
        "temperature": config.temperature,
        "text_split_method": config.split.as_api_code(),
        "speed_factor": config.speed_factor,
        "sample_steps": config.sample_steps,
        "super_sampling": config.super_sampling,
        "fragment_interval": config.fragment_interval_secs,
        "media_type": "wav",
        "streaming_mode": streaming,
        "batch_size": 1,
        "split_bucket": false,
    }))
}

fn validate_config(config: &SovitsConfig) -> Result<(), TtsError> {
    if config.reference_audio_path.trim().is_empty() {
        return Err(configuration("请指定服务端可访问的参考音频路径"));
    }
    if config.top_k == 0 || config.top_k > 1000 {
        return Err(configuration("Top K 须在 1 到 1000 之间"));
    }
    if !config.top_p.is_finite() || !(0.0..=1.0).contains(&config.top_p) {
        return Err(configuration("Top P 须在 0 到 1 之间"));
    }
    if !config.temperature.is_finite() || !(0.0..=2.0).contains(&config.temperature) {
        return Err(configuration("温度须在 0 到 2 之间"));
    }
    if !config.speed_factor.is_finite() || !(0.5..=2.0).contains(&config.speed_factor) {
        return Err(configuration("语速须在 0.5 到 2.0 倍之间"));
    }
    if config.sample_steps == 0 || config.sample_steps > 64 {
        return Err(configuration("采样步数须在 1 到 64 之间"));
    }
    if !config.fragment_interval_secs.is_finite()
        || !(0.0..=5.0).contains(&config.fragment_interval_secs)
    {
        return Err(configuration("片段间隔须在 0 到 5 秒之间"));
    }
    if !(5..=600).contains(&config.timeout_secs) {
        return Err(configuration("超时须在 5 到 600 秒之间"));
    }
    if config.model_selection == SovitsModelSelection::PerRequestAtomic
        && (config
            .gpt_weights_path
            .as_deref()
            .is_none_or(|path| path.trim().is_empty())
            || config
                .sovits_weights_path
                .as_deref()
                .is_none_or(|path| path.trim().is_empty()))
    {
        return Err(configuration(
            "原子模型选择需要成对的 GPT 与 SoVITS 权重路径",
        ));
    }
    Ok(())
}

fn normalize_base(value: &str) -> Result<Url, TtsError> {
    let mut url = Url::parse(value.trim()).map_err(|_| configuration("API 地址不是有效 URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(configuration("API 地址须为无凭据、查询参数的 HTTP(S) 地址"));
    }
    let path = url.path().trim_end_matches('/');
    let path = path
        .strip_suffix("/kinoko/tts")
        .or_else(|| path.strip_suffix("/tts"))
        .unwrap_or(path);
    let base_path = if path.is_empty() { "/" } else { path }.to_string();
    url.set_path(&base_path);
    Ok(url)
}

fn route(base: &Url, suffix: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}/{}", base.path().trim_end_matches('/'), suffix));
    url
}

fn configuration(reason: &'static str) -> TtsError {
    TtsError::Configuration {
        service: SERVICE,
        reason,
    }
}

fn http_error(status: u16) -> TtsError {
    TtsError::HttpStatus {
        service: SERVICE,
        status,
        reason: match status {
            400 | 422 => "参考音频、文本或参数无效，请检查服务日志",
            404 => "接口不存在，请检查 API 地址和服务版本",
            503 => "服务未就绪或模型加载失败",
            300..=399 => "服务返回重定向，已停止请求",
            _ => "服务未完成请求，请检查服务日志",
        },
    }
}

fn partial_switch_error() -> TtsError {
    TtsError::Protocol {
        service: SERVICE,
        reason: "SoVITS 权重可能已切换，但 GPT 权重未确认；请检查服务端状态",
    }
}

#[cfg(test)]
mod tests {
    use tokio::{net::TcpListener, sync::oneshot, time::timeout};

    use super::*;
    use crate::tts::test_http::{chunk, chunked_end, chunked_start, json_response, read_request};

    fn wav_fixture() -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&24_000_u32.to_le_bytes());
        wav.extend_from_slice(&48_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2_u32.to_le_bytes());
        wav.extend_from_slice(&[0x34, 0x12]);
        wav
    }

    #[tokio::test]
    async fn standard_api_streams_without_hidden_weight_switches() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (finish_sender, finish_receiver) = oneshot::channel();
        let wav = wav_fixture();
        let server_wav = wav.clone();
        let server = tokio::spawn(async move {
            let (mut tts_socket, _) = listener.accept().await.unwrap();
            let tts_request = read_request(&mut tts_socket).await;
            chunked_start(&mut tts_socket, "audio/wav").await;
            chunk(&mut tts_socket, &server_wav[..7]).await;
            chunk(&mut tts_socket, &server_wav[7..]).await;
            finish_receiver.await.unwrap();
            chunked_end(&mut tts_socket).await;
            tts_request
        });
        let mut config = SovitsConfig::new(format!("http://{address}/tts"), "server/voice.wav");
        config.reference_text = "参考文本".into();
        config.gpt_weights_path = Some("unused.ckpt".into());
        config.sovits_weights_path = Some("unused.pth".into());
        let client = SovitsClient::new(config).unwrap();
        let parent = CancellationToken::new();
        let mut audio = client.stream("你好", &parent).unwrap();
        let first = timeout(Duration::from_secs(3), audio.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first, wav[..12]);
        assert!(!server.is_finished());
        finish_sender.send(()).unwrap();
        let mut output = first;
        while let Some(next) = audio.recv().await {
            output.extend_from_slice(&next.unwrap());
        }
        assert_eq!(output, wav);
        let tts_request = server.await.unwrap();
        let headers_end = tts_request
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert!(tts_request.starts_with(b"POST /tts HTTP/1.1"));
        let body: Value = serde_json::from_slice(&tts_request[headers_end..]).unwrap();
        assert_eq!(body["ref_audio_path"], "server/voice.wav");
        assert_eq!(body["prompt_text"], "参考文本");
        assert_eq!(body["text_split_method"], "cut0");
        assert_eq!(body["streaming_mode"], true);
        assert!(body.get("gpt_weights_path").is_none());
    }

    #[tokio::test]
    async fn verified_atomic_extension_receives_per_request_weights() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let wav = wav_fixture();
        let server_wav = wav.clone();
        let server = tokio::spawn(async move {
            let (mut status_socket, _) = listener.accept().await.unwrap();
            let status_request = read_request(&mut status_socket).await;
            json_response(
                &mut status_socket,
                "200 OK",
                r#"{"protocol":1,"atomic_model_selection":true,"resident_model_reuse":true}"#,
            )
            .await;
            let (mut tts_socket, _) = listener.accept().await.unwrap();
            let tts_request = read_request(&mut tts_socket).await;
            chunked_start(&mut tts_socket, "audio/wav").await;
            chunk(&mut tts_socket, &server_wav).await;
            chunked_end(&mut tts_socket).await;
            (status_request, tts_request)
        });
        let mut config = SovitsConfig::new(format!("http://{address}"), "server/voice.wav");
        config.model_selection = SovitsModelSelection::PerRequestAtomic;
        config.gpt_weights_path = Some("A.ckpt".into());
        config.sovits_weights_path = Some("A.pth".into());
        let client = SovitsClient::new(config).unwrap();
        let audio = client
            .synthesize_wav("测试", &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(audio, wav);
        let (status_request, tts_request) = server.await.unwrap();
        assert!(status_request.starts_with(b"GET /kinoko/status HTTP/1.1"));
        assert!(tts_request.starts_with(b"POST /kinoko/tts HTTP/1.1"));
        let headers_end = tts_request
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        let body: Value = serde_json::from_slice(&tts_request[headers_end..]).unwrap();
        assert_eq!(body["gpt_weights_path"], "A.ckpt");
        assert_eq!(body["sovits_weights_path"], "A.pth");
        assert_eq!(body["tts"]["text"], "测试");
        assert_eq!(body["tts"]["streaming_mode"], false);
    }

    #[tokio::test]
    async fn explicit_standard_weight_switch_reports_partial_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sovits_socket, _) = listener.accept().await.unwrap();
            let first = read_request(&mut sovits_socket).await;
            json_response(&mut sovits_socket, "200 OK", r#"{"message":"success"}"#).await;
            let (mut gpt_socket, _) = listener.accept().await.unwrap();
            let second = read_request(&mut gpt_socket).await;
            json_response(
                &mut gpt_socket,
                "400 Bad Request",
                r#"{"secret":"reflected"}"#,
            )
            .await;
            (first, second)
        });
        let client =
            SovitsClient::new(SovitsConfig::new(format!("http://{address}"), "voice.wav")).unwrap();
        let error = client
            .switch_global_weights_explicit("A.ckpt", "A.pth", &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("可能已切换"));
        assert!(!error.to_string().contains("reflected"));
        let (first, second) = server.await.unwrap();
        assert!(first.starts_with(b"GET /set_sovits_weights?weights_path=A.pth HTTP/1.1"));
        assert!(second.starts_with(b"GET /set_gpt_weights?weights_path=A.ckpt HTTP/1.1"));
    }

    #[tokio::test]
    async fn status_error_does_not_fallback_or_send_tts() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            json_response(
                &mut socket,
                "503 Service Unavailable",
                r#"{"secret":"reflected"}"#,
            )
            .await;
            request
        });
        let mut config = SovitsConfig::new(format!("http://{address}"), "voice.wav");
        config.model_selection = SovitsModelSelection::PerRequestAtomic;
        config.gpt_weights_path = Some("A.ckpt".into());
        config.sovits_weights_path = Some("A.pth".into());
        let client = SovitsClient::new(config).unwrap();
        let mut stream = client.stream("测试", &CancellationToken::new()).unwrap();
        let error = stream.recv().await.unwrap().unwrap_err();
        assert!(matches!(error, TtsError::HttpStatus { status: 503, .. }));
        assert!(!error.to_string().contains("reflected"));
        assert!(
            server
                .await
                .unwrap()
                .starts_with(b"GET /kinoko/status HTTP/1.1")
        );
    }

    #[tokio::test]
    async fn atomic_mode_rejects_a_standard_server_without_posting_tts() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            json_response(&mut socket, "404 Not Found", "{}").await;
            request
        });
        let mut config = SovitsConfig::new(format!("http://{address}"), "voice.wav");
        config.model_selection = SovitsModelSelection::PerRequestAtomic;
        config.gpt_weights_path = Some("A.ckpt".into());
        config.sovits_weights_path = Some("A.pth".into());
        let client = SovitsClient::new(config).unwrap();
        let mut stream = client.stream("测试", &CancellationToken::new()).unwrap();
        let error = stream.recv().await.unwrap().unwrap_err();
        assert!(error.to_string().contains("未提供原子模型选择接口"));
        assert!(
            server
                .await
                .unwrap()
                .starts_with(b"GET /kinoko/status HTTP/1.1")
        );
    }

    #[test]
    fn atomic_mode_requires_both_weight_paths_before_network_use() {
        let mut config = SovitsConfig::new("http://127.0.0.1:9880", "voice.wav");
        config.model_selection = SovitsModelSelection::PerRequestAtomic;
        config.gpt_weights_path = Some("A.ckpt".into());
        assert!(matches!(
            SovitsClient::new(config),
            Err(TtsError::Configuration { .. })
        ));
    }
}
