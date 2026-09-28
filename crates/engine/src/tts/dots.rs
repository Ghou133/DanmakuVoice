//! Streaming client for the dots.tts HTTP API.
//!
//! The service accepts its own `/tts` JSON contract and emits PCM16 WAV. It
//! has no server-side speed or volume fields. Those are applied only to speech
//! by the playback pipeline (for speed, an incremental FFmpeg `atempo` stage).

use std::{path::Path, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, Url, redirect::Policy};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    AudioEncoding, AudioStream, TtsError, confirmed_loopback_offline, forward_wav_response,
    network_error, read_limited, spawn_stream,
};

const SERVICE: &str = "dots.tts";
const MAX_WAV_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
pub struct DotsHealth {
    pub status: String,
    pub ready: bool,
    pub needs_restart: bool,
    pub model_loaded: Option<bool>,
    pub stream_requests: Option<u64>,
    pub model_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub prompt_audio_ok: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DotsVoice {
    pub name: String,
    pub size_kb: f64,
    pub has_prompt_text: bool,
}

#[derive(Deserialize)]
struct VoicesResponse {
    voices: Vec<DotsVoice>,
}

#[derive(Clone, Debug)]
pub struct DotsConfig {
    /// Service root, `/tts`, or `/tts/stream`. No URL credentials are accepted.
    pub endpoint: String,
    /// Reference audio path on the dots.tts server, relative to its allowed
    /// reference directory, or its explicitly trusted local preset directory.
    pub voice: Option<String>,
    pub prompt_text: Option<String>,
    pub language: Option<String>,
    pub num_steps: Option<u8>,
    pub guidance_scale: Option<f32>,
    pub speaker_scale: Option<f32>,
    pub normalize_text: bool,
    pub timeout_secs: u64,
}

impl DotsConfig {
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            voice: None,
            prompt_text: None,
            language: None,
            num_steps: None,
            guidance_scale: None,
            speaker_scale: None,
            normalize_text: true,
            timeout_secs: 180,
        }
    }
}

#[derive(Clone)]
pub struct DotsClient {
    config: DotsConfig,
    endpoint: Url,
    http: Client,
}

impl DotsClient {
    pub fn new(config: DotsConfig) -> Result<Self, TtsError> {
        if !(5..=600).contains(&config.timeout_secs) {
            return Err(configuration("超时须在 5 到 600 秒之间"));
        }
        if config.num_steps.is_some_and(|n| !(1..=64).contains(&n)) {
            return Err(configuration("采样步数须在 1 到 64 之间"));
        }
        for value in [config.guidance_scale, config.speaker_scale]
            .into_iter()
            .flatten()
        {
            if !value.is_finite() || !(0.0 < value && value <= 10.0) {
                return Err(configuration("引导参数须大于 0 且不超过 10"));
            }
        }
        let endpoint = normalize_endpoint(&config.endpoint)?;
        let http = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|_| configuration("无法创建 HTTP 客户端"))?;
        Ok(Self {
            config,
            endpoint,
            http,
        })
    }

    /// A read-only readiness check. `503` is parsed because the resident API
    /// uses it to report a structured model error.
    pub async fn health(&self, cancellation: &CancellationToken) -> Result<DotsHealth, TtsError> {
        self.get_json("health", cancellation, true).await
    }

    /// Queue-time, read-only preflight. An incompatible absolute-path server
    /// is an error rather than an offline signal that could trigger a paid
    /// fallback. No synthesis request is sent here.
    pub async fn readiness(&self, cancellation: &CancellationToken) -> Result<bool, TtsError> {
        let health =
            match tokio::time::timeout(Duration::from_millis(1_200), self.health(cancellation))
                .await
            {
                Ok(Ok(health)) => health,
                Ok(Err(TtsError::Cancelled)) => return Err(TtsError::Cancelled),
                Ok(Err(error)) => {
                    if matches!(error, TtsError::Network { .. })
                        && confirmed_loopback_offline(&self.endpoint, cancellation).await?
                    {
                        return Ok(false);
                    }
                    return Err(error);
                }
                Err(_) => {
                    if confirmed_loopback_offline(&self.endpoint, cancellation).await? {
                        return Ok(false);
                    }
                    return Err(TtsError::Network {
                        service: SERVICE,
                        stage: "检查服务时",
                        reason: "连接或接收超时",
                    });
                }
            };
        if health.model_loaded.is_none() || health.stream_requests.is_none() {
            return Err(TtsError::Protocol {
                service: SERVICE,
                reason: "该地址不是兼容的 dots.tts 服务",
            });
        }
        if !health.ready
            || health.model_loaded != Some(true)
            || health.needs_restart
            || health.status != "ok"
        {
            return Ok(false);
        }
        if self
            .config
            .voice
            .as_deref()
            .is_some_and(|voice| Path::new(voice).is_absolute())
        {
            self.require_absolute_reference(cancellation).await?;
        }
        Ok(true)
    }

    /// List reference files exposed by the server's configured `ref_dir`.
    /// The server does not include its separate trusted preset directory here.
    pub async fn voices(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<DotsVoice>, TtsError> {
        let response: VoicesResponse = self.get_json("voices", cancellation, false).await?;
        Ok(response.voices)
    }

    /// Start one incremental `/tts/stream` request. The caller owns the
    /// returned stream; no request is retried after partial playback.
    pub fn stream(&self, text: &str, parent: &CancellationToken) -> Result<AudioStream, TtsError> {
        if parent.is_cancelled() {
            return Err(TtsError::Cancelled);
        }
        let body = self.request_body(text)?;
        let client = self.http.clone();
        let reference_check = self
            .config
            .voice
            .as_deref()
            .is_some_and(|voice| Path::new(voice).is_absolute())
            .then(|| self.clone());
        let url = self.stream_url();
        Ok(spawn_stream(
            AudioEncoding::Wav,
            parent,
            move |sender, cancellation| async move {
                if let Some(check) = reference_check {
                    check.require_absolute_reference(&cancellation).await?;
                }
                let response = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Ok(()),
                    result = client.post(url).json(&body).send() =>
                        result.map_err(|error| network_error(SERVICE, &error, false))?,
                };
                if !response.status().is_success() {
                    return Err(http_error(response.status().as_u16()));
                }
                forward_wav_response(response, &sender, &cancellation, SERVICE).await
            },
        ))
    }

    /// Request the complete `/tts` WAV for operations that explicitly need a
    /// whole result. The maximum body size is enforced while reading.
    pub async fn synthesize_wav(
        &self,
        text: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, TtsError> {
        if cancellation.is_cancelled() {
            return Err(TtsError::Cancelled);
        }
        if self
            .config
            .voice
            .as_deref()
            .is_some_and(|voice| Path::new(voice).is_absolute())
        {
            self.require_absolute_reference(cancellation).await?;
        }
        let body = self.request_body(text)?;
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = self.http.post(self.endpoint.clone()).json(&body).send() =>
                result.map_err(|error| network_error(SERVICE, &error, false))?,
        };
        if !response.status().is_success() {
            return Err(http_error(response.status().as_u16()));
        }
        if !wav_content_type(response.headers().get(reqwest::header::CONTENT_TYPE)) {
            return Err(TtsError::InvalidAudio {
                service: SERVICE,
                reason: "响应不是 WAV 音频",
            });
        }
        let mut packets = response.bytes_stream();
        let mut audio = Vec::new();
        loop {
            let packet = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
                result = packets.next() => result,
            };
            let Some(packet) = packet else { break };
            let packet =
                packet.map_err(|error| network_error(SERVICE, &error, !audio.is_empty()))?;
            if audio.len().saturating_add(packet.len()) > MAX_WAV_BYTES {
                return Err(TtsError::InvalidAudio {
                    service: SERVICE,
                    reason: "响应超过 64 MiB 上限",
                });
            }
            audio.extend_from_slice(&packet);
        }
        if audio.len() < 44 || &audio[..4] != b"RIFF" || &audio[8..12] != b"WAVE" {
            return Err(TtsError::InvalidAudio {
                service: SERVICE,
                reason: "缺少完整 RIFF/WAVE 音频",
            });
        }
        Ok(audio)
    }

    fn request_body(&self, text: &str) -> Result<Value, TtsError> {
        if text.trim().is_empty() {
            return Err(configuration("朗读文本不能为空"));
        }
        let mut body = Map::new();
        body.insert("text".into(), json!(text));
        body.insert("normalize_text".into(), json!(self.config.normalize_text));
        for (name, value) in [
            ("voice", self.config.voice.as_deref()),
            ("prompt_text", self.config.prompt_text.as_deref()),
            ("language", self.config.language.as_deref()),
        ] {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                body.insert(name.into(), json!(value.trim()));
            }
        }
        for (name, value) in [
            ("num_steps", self.config.num_steps.map(|n| json!(n))),
            (
                "guidance_scale",
                self.config.guidance_scale.map(|n| json!(n)),
            ),
            ("speaker_scale", self.config.speaker_scale.map(|n| json!(n))),
        ] {
            if let Some(value) = value {
                body.insert(name.into(), value);
            }
        }
        Ok(Value::Object(body))
    }

    fn stream_url(&self) -> Url {
        let mut url = self.endpoint.clone();
        url.set_path(&format!("{}/stream", self.endpoint.path()));
        url
    }

    fn route_url(&self, route: &str) -> Url {
        let mut url = self.endpoint.clone();
        let prefix = self.endpoint.path().strip_suffix("/tts").unwrap_or("");
        url.set_path(&format!("{prefix}/{route}"));
        url
    }

    async fn require_absolute_reference(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<(), TtsError> {
        const UNSUPPORTED: &str =
            "当前 dots 服务不支持原路径参考音频，请在声音设置中启动或检查本应用管理的 dots 服务";
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            self.get_json::<Value>("danmakuvoice/capabilities", cancellation, false),
        )
        .await;
        match response {
            Ok(Err(TtsError::Cancelled)) => Err(TtsError::Cancelled),
            Ok(Ok(value))
                if value.get("protocol").and_then(Value::as_str)
                    == Some("danmakuvoice-dots-paths-v1")
                    && value.get("arbitrary_voice_paths").and_then(Value::as_bool)
                        == Some(true)
                    && value
                        .get("reference_text_explicit")
                        .and_then(Value::as_bool)
                        == Some(true) =>
            {
                Ok(())
            }
            _ => Err(configuration(UNSUPPORTED)),
        }
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        route: &str,
        cancellation: &CancellationToken,
        allow_503: bool,
    ) -> Result<T, TtsError> {
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = self.http.get(self.route_url(route)).send() =>
                result.map_err(|error| network_error(SERVICE, &error, false))?,
        };
        if !response.status().is_success() && !(allow_503 && response.status().as_u16() == 503) {
            return Err(http_error(response.status().as_u16()));
        }
        let bytes = read_limited(
            response,
            cancellation,
            SERVICE,
            "读取服务信息时",
            128 * 1024,
        )
        .await?;
        serde_json::from_slice(&bytes).map_err(|_| TtsError::Protocol {
            service: SERVICE,
            reason: "服务信息不是预期的 JSON 格式",
        })
    }
}

fn configuration(reason: &'static str) -> TtsError {
    TtsError::Configuration {
        service: SERVICE,
        reason,
    }
}

fn normalize_endpoint(value: &str) -> Result<Url, TtsError> {
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
        .strip_suffix("/tts/stream")
        .map(|s| format!("{s}/tts"))
        .or_else(|| path.ends_with("/tts").then(|| path.to_string()))
        .unwrap_or_else(|| format!("{path}/tts"));
    url.set_path(&path);
    Ok(url)
}

fn wav_content_type(value: Option<&reqwest::header::HeaderValue>) -> bool {
    value.is_none_or(|value| {
        value.to_str().is_ok_and(|text| {
            matches!(
                text.split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "audio/wav" | "audio/x-wav" | "application/octet-stream"
            )
        })
    })
}

fn http_error(status: u16) -> TtsError {
    let reason = match status {
        400 | 422 => "请求参数或参考音频无效",
        404 => "接口或参考音频不存在",
        503 => "服务未就绪或推理失败，请检查服务日志",
        _ => "服务未完成合成，请检查服务日志",
    };
    TtsError::HttpStatus {
        service: SERVICE,
        status,
        reason,
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
    async fn custom_post_stream_yields_before_http_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (finish_sender, finish_receiver) = oneshot::channel();
        let wav = wav_fixture();
        let server_wav = wav.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            chunked_start(&mut socket, "audio/wav").await;
            chunk(&mut socket, &server_wav[..9]).await;
            chunk(&mut socket, &server_wav[9..]).await;
            finish_receiver.await.unwrap();
            chunked_end(&mut socket).await;
            request
        });
        let mut config = DotsConfig::new(format!("http://{address}"));
        config.voice = Some("reference.wav".into());
        config.prompt_text = Some("参考文本".into());
        config.num_steps = Some(12);
        let client = DotsClient::new(config).unwrap();
        let parent = CancellationToken::new();
        let mut audio = client.stream("你好", &parent).unwrap();
        assert_eq!(audio.encoding(), AudioEncoding::Wav);
        let first = timeout(Duration::from_secs(3), audio.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(&first, &wav[..12]);
        assert!(!server.is_finished());
        finish_sender.send(()).unwrap();
        let mut output = first;
        while let Some(next) = audio.recv().await {
            output.extend_from_slice(&next.unwrap());
        }
        assert_eq!(output, wav);
        let request = server.await.unwrap();
        let headers_end = request
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert!(
            String::from_utf8_lossy(&request[..headers_end])
                .starts_with("POST /tts/stream HTTP/1.1")
        );
        let body: Value = serde_json::from_slice(&request[headers_end..]).unwrap();
        assert_eq!(body["text"], "你好");
        assert_eq!(body["voice"], "reference.wav");
        assert_eq!(body["prompt_text"], "参考文本");
        assert_eq!(body["num_steps"], 12);
        assert!(body.get("speed").is_none());
    }

    #[test]
    fn endpoint_normalization_rejects_embedded_credentials() {
        let url = normalize_endpoint("http://127.0.0.1:9881/tts/stream").unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:9881/tts");
        assert!(normalize_endpoint("https://person:secret@example.com/tts").is_err());
        assert!(normalize_endpoint("http://localhost/tts?token=secret").is_err());
    }

    #[tokio::test]
    async fn health_and_voices_read_actual_custom_routes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut health_socket, _) = listener.accept().await.unwrap();
            let health_request = read_request(&mut health_socket).await;
            json_response(
                &mut health_socket,
                "503 Service Unavailable",
                r#"{"status":"error","ready":false,"needs_restart":true,"model_name":"dots.tts-2p","sample_rate":24000,"prompt_audio_ok":false}"#,
            )
            .await;
            let (mut voices_socket, _) = listener.accept().await.unwrap();
            let voices_request = read_request(&mut voices_socket).await;
            json_response(
                &mut voices_socket,
                "200 OK",
                r#"{"ref_dir":"private-path","voices":[{"name":"sample.wav","size_kb":12.5,"has_prompt_text":true}]}"#,
            )
            .await;
            (health_request, voices_request)
        });
        let client = DotsClient::new(DotsConfig::new(format!("http://{address}/tts"))).unwrap();
        let cancellation = CancellationToken::new();
        let health = client.health(&cancellation).await.unwrap();
        assert_eq!(health.status, "error");
        assert!(!health.ready);
        assert!(health.needs_restart);
        let voices = client.voices(&cancellation).await.unwrap();
        assert_eq!(voices.len(), 1);
        assert_eq!(voices[0].name, "sample.wav");
        assert!(voices[0].has_prompt_text);
        let (health_request, voices_request) = server.await.unwrap();
        assert!(health_request.starts_with(b"GET /health HTTP/1.1"));
        assert!(voices_request.starts_with(b"GET /voices HTTP/1.1"));
    }

    #[tokio::test]
    async fn absolute_reference_refuses_legacy_service_before_synthesis() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            json_response(&mut socket, "404 Not Found", "{}").await;
            request
        });
        let mut config = DotsConfig::new(format!("http://{address}"));
        config.voice = Some(r"C:\reference\voice.wav".into());
        let client = DotsClient::new(config).unwrap();
        let cancellation = CancellationToken::new();
        let mut audio = client.stream("你好", &cancellation).unwrap();
        let error = audio.recv().await.unwrap().unwrap_err().to_string();
        assert!(error.contains("本应用管理的 dots 服务"));
        let request = server.await.unwrap();
        assert!(request.starts_with(b"GET /danmakuvoice/capabilities HTTP/1.1"));
    }
}
