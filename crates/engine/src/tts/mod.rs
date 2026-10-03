//! Transport clients for the supported speech services.
//!
//! A stream owns one synthesis request. Dropping it closes the request and its
//! bounded channel. The audio worker must still discard samples tagged with an
//! older playback generation after a skip or stop.

pub mod dobao;
pub mod dobao_auth;
pub mod dots;
pub mod fish;
pub mod sovits;

use std::future::Future;

use thiserror::Error;
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

/// Maximum queued network chunks per synthesis request.
pub const STREAM_CHANNEL_CAPACITY: usize = 8;
/// A large HTTP packet is split before entering the bounded channel.
pub const MAX_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioEncoding {
    /// A RIFF/WAVE stream. Its header and PCM frames may cross chunk boundaries.
    Wav,
    /// AAC with ADTS frame headers; frame boundaries may cross chunks.
    AacAdts,
    /// Little-endian, signed 16-bit PCM without a container header.
    PcmS16Le { sample_rate: u32, channels: u16 },
}

/// Errors intentionally contain neither a remote response body nor a URL,
/// request, API key, Cookie, or source exception.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum TtsError {
    #[error("{service} 配置无效：{reason} [{code}]", code = self.code())]
    Configuration {
        service: &'static str,
        reason: &'static str,
    },
    #[error("{service} 返回 HTTP {status}：{reason} [{code}]", code = self.code())]
    HttpStatus {
        service: &'static str,
        status: u16,
        reason: &'static str,
    },
    #[error("{service} {stage}请求失败：{reason} [{code}]", code = self.code())]
    Network {
        service: &'static str,
        stage: &'static str,
        reason: &'static str,
    },
    #[error("{service} 音频无效：{reason} [{code}]", code = self.code())]
    InvalidAudio {
        service: &'static str,
        reason: &'static str,
    },
    #[error("{service} 响应无效：{reason} [{code}]", code = self.code())]
    Protocol {
        service: &'static str,
        reason: &'static str,
    },
    #[error("语音请求已取消")]
    Cancelled,
}

impl TtsError {
    pub fn code(&self) -> String {
        let (service, kind) = match self {
            Self::Configuration { service, .. } => (*service, "01"),
            Self::HttpStatus {
                service,
                status: 401,
                ..
            } => (*service, "02"),
            Self::HttpStatus {
                service,
                status: 403,
                ..
            } => (*service, "03"),
            Self::HttpStatus {
                service,
                status: 429,
                ..
            } => (*service, "04"),
            Self::HttpStatus { service, .. } => (*service, "05"),
            Self::Network { service, .. } => (*service, "06"),
            Self::InvalidAudio { service, .. } => (*service, "07"),
            Self::Protocol { service, .. } => (*service, "08"),
            Self::Cancelled => return "DV-T009".into(),
        };
        let provider = match service {
            "豆包" => "D",
            "豆包扫码登录" => "Q",
            "Fish Audio" => "F",
            "GPT-SoVITS" => "S",
            "dots.tts" => "L",
            _ => "0",
        };
        format!("DV-T{provider}{kind}")
    }
}

/// A single TTS request's bounded stream. `cancel` stops network reads and
/// pending sends; `Drop` also aborts the task if the caller leaves early.
pub struct AudioStream {
    encoding: AudioEncoding,
    receiver: mpsc::Receiver<Result<Vec<u8>, TtsError>>,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
    task_checked: bool,
}

impl AudioStream {
    pub fn encoding(&self) -> AudioEncoding {
        self.encoding
    }

    pub async fn recv(&mut self) -> Option<Result<Vec<u8>, TtsError>> {
        if self.cancellation.is_cancelled() {
            return None;
        }
        let value = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => return None,
            value = self.receiver.recv() => value,
        };
        if value.is_none() && !self.task_checked {
            self.task_checked = true;
            // Closing the producer's channel is not necessarily a successful
            // EOF: a panic after partial audio must reach the playback worker.
            // The panic payload may contain secrets, so never expose it.
            let finished = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return None,
                result = &mut self.task => result,
            };
            if finished.is_err() && !self.cancellation.is_cancelled() {
                return Some(Err(TtsError::Protocol {
                    service: "语音",
                    reason: "合成任务异常结束",
                }));
            }
        }
        value
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
        self.task.abort();
    }
}

impl Drop for AudioStream {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub(crate) fn spawn_stream<F, Fut>(
    encoding: AudioEncoding,
    parent: &CancellationToken,
    producer: F,
) -> AudioStream
where
    F: FnOnce(mpsc::Sender<Result<Vec<u8>, TtsError>>, CancellationToken) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), TtsError>> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    let cancellation = parent.child_token();
    let task_token = cancellation.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = producer(sender.clone(), task_token.clone()).await {
            let _ = send_item(&sender, &task_token, Err(error)).await;
        }
    });
    AudioStream {
        encoding,
        receiver,
        cancellation,
        task,
        task_checked: false,
    }
}

pub(crate) async fn send_item(
    sender: &mpsc::Sender<Result<Vec<u8>, TtsError>>,
    cancellation: &CancellationToken,
    item: Result<Vec<u8>, TtsError>,
) -> bool {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => false,
        result = sender.send(item) => result.is_ok(),
    }
}

pub(crate) async fn send_bytes(
    sender: &mpsc::Sender<Result<Vec<u8>, TtsError>>,
    cancellation: &CancellationToken,
    bytes: &[u8],
) -> bool {
    for part in bytes.chunks(MAX_CHUNK_BYTES) {
        if !send_item(sender, cancellation, Ok(part.to_vec())).await {
            return false;
        }
    }
    true
}

pub(crate) fn network_error(
    service: &'static str,
    error: &reqwest::Error,
    received: bool,
) -> TtsError {
    let stage = if received {
        "收到部分音频后"
    } else {
        "尚未收到音频时"
    };
    network_error_at(service, error, stage)
}

pub(crate) fn network_error_at(
    service: &'static str,
    error: &reqwest::Error,
    stage: &'static str,
) -> TtsError {
    let reason = if error.is_timeout() {
        "连接或接收超时"
    } else if error.is_connect() {
        "无法连接服务"
    } else if error.is_body() || error.is_decode() {
        "音频传输中断"
    } else {
        "网络传输失败"
    };
    TtsError::Network {
        service,
        stage,
        reason,
    }
}

/// Windows may time out instead of refusing an unused loopback port. Call
/// this only after a failed HTTP health probe: an exclusive bind then proves
/// that 127.0.0.1 has no listener. Occupied and remote ports remain uncertain.
pub(crate) async fn confirmed_loopback_offline(
    endpoint: &reqwest::Url,
    cancellation: &CancellationToken,
) -> Result<bool, TtsError> {
    if endpoint.host_str() != Some("127.0.0.1") {
        return Ok(false);
    }
    let Some(port) = endpoint.port_or_known_default() else {
        return Ok(false);
    };
    let bind = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
        result = tokio::net::TcpListener::bind(("127.0.0.1", port)) => result,
    };
    Ok(bind.is_ok())
}

pub(crate) async fn read_limited(
    response: reqwest::Response,
    cancellation: &CancellationToken,
    service: &'static str,
    stage: &'static str,
    max_bytes: usize,
) -> Result<Vec<u8>, TtsError> {
    use futures_util::StreamExt;

    let mut packets = response.bytes_stream();
    let mut body = Vec::new();
    loop {
        let packet = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(TtsError::Cancelled),
            result = packets.next() => result,
        };
        let Some(packet) = packet else { break };
        let packet = packet.map_err(|error| network_error_at(service, &error, stage))?;
        if body.len().saturating_add(packet.len()) > max_bytes {
            return Err(TtsError::Protocol {
                service,
                reason: "响应超过大小上限",
            });
        }
        body.extend_from_slice(&packet);
    }
    Ok(body)
}

pub(crate) async fn forward_wav_response(
    response: reqwest::Response,
    sender: &mpsc::Sender<Result<Vec<u8>, TtsError>>,
    cancellation: &CancellationToken,
    service: &'static str,
) -> Result<(), TtsError> {
    use futures_util::StreamExt;

    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE);
    if content_type.is_some_and(|value| {
        value.to_str().map_or(true, |text| {
            !matches!(
                text.split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "audio/wav" | "audio/x-wav" | "application/octet-stream"
            )
        })
    }) {
        return Err(TtsError::InvalidAudio {
            service,
            reason: "响应不是 WAV 音频",
        });
    }
    let mut packets = response.bytes_stream();
    let mut prefix = Vec::with_capacity(12);
    let mut emitted = false;
    loop {
        let packet = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            result = packets.next() => result,
        };
        let Some(packet) = packet else { break };
        let packet = packet.map_err(|error| network_error(service, &error, emitted))?;
        let mut data = packet.as_ref();
        if prefix.len() < 12 {
            let count = (12 - prefix.len()).min(data.len());
            prefix.extend_from_slice(&data[..count]);
            data = &data[count..];
            if prefix.len() == 12 {
                if &prefix[..4] != b"RIFF" || &prefix[8..12] != b"WAVE" {
                    return Err(TtsError::InvalidAudio {
                        service,
                        reason: "缺少 RIFF/WAVE 文件头",
                    });
                }
                if !send_bytes(sender, cancellation, &prefix).await {
                    return Ok(());
                }
                emitted = true;
            }
        }
        if !data.is_empty() && !send_bytes(sender, cancellation, data).await {
            return Ok(());
        }
    }
    if !emitted {
        return Err(TtsError::InvalidAudio {
            service,
            reason: "响应在 WAV 文件头完成前结束",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn producer_panic_after_audio_is_reported_instead_of_successful_eof() {
        let parent = CancellationToken::new();
        let mut stream = spawn_stream(
            AudioEncoding::PcmS16Le {
                sample_rate: 24_000,
                channels: 1,
            },
            &parent,
            |sender, cancellation| async move {
                assert!(send_bytes(&sender, &cancellation, &[1, 0]).await);
                panic!("private response or credential");
            },
        );
        assert_eq!(stream.recv().await.unwrap().unwrap(), [1, 0]);
        let error = stream.recv().await.unwrap().unwrap_err();
        assert!(matches!(error, TtsError::Protocol { .. }));
        assert!(!error.to_string().contains("private"));
        assert!(stream.recv().await.is_none());
    }

    #[tokio::test]
    async fn cancelled_stream_does_not_report_producer_abort_as_failure() {
        let parent = CancellationToken::new();
        let mut stream = spawn_stream(AudioEncoding::Wav, &parent, |_, token| async move {
            token.cancelled().await;
            Ok(())
        });
        parent.cancel();
        assert!(stream.recv().await.is_none());
    }
}

#[cfg(test)]
pub(crate) mod test_http {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };

    pub async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0, "client closed before sending HTTP headers");
            request.extend_from_slice(&buffer[..count]);
            assert!(request.len() < 32 * 1024);
            if let Some(offset) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                break offset + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        while request.len() < header_end + length {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0, "client closed before sending HTTP body");
            request.extend_from_slice(&buffer[..count]);
            assert!(request.len() < 32 * 1024);
        }
        request
    }

    pub async fn chunked_start(socket: &mut TcpStream, content_type: &str) {
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    pub async fn chunk(socket: &mut TcpStream, bytes: &[u8]) {
        socket
            .write_all(format!("{:X}\r\n", bytes.len()).as_bytes())
            .await
            .unwrap();
        socket.write_all(bytes).await.unwrap();
        socket.write_all(b"\r\n").await.unwrap();
    }

    pub async fn chunked_end(socket: &mut TcpStream) {
        socket.write_all(b"0\r\n\r\n").await.unwrap();
    }

    pub async fn json_response(socket: &mut TcpStream, status: &str, json: &str) {
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }
}
