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
    #[error("{service} 配置无效：{reason}")]
    Configuration {
        service: &'static str,
        reason: &'static str,
    },
    #[error("{service} 返回 HTTP {status}：{reason}")]
    HttpStatus {
        service: &'static str,
        status: u16,
        reason: &'static str,
    },
    #[error("{service} {stage}请求失败：{reason}")]
    Network {
        service: &'static str,
        stage: &'static str,
        reason: &'static str,
    },
    #[error("{service} 音频无效：{reason}")]
    InvalidAudio {
        service: &'static str,
        reason: &'static str,
    },
    #[error("{service} 响应无效：{reason}")]
    Protocol {
        service: &'static str,
        reason: &'static str,
    },
    #[error("语音请求已取消")]
    Cancelled,
}

/// A single TTS request's bounded stream. `cancel` stops network reads and
/// pending sends; `Drop` also aborts the task if the caller leaves early.
pub struct AudioStream {
    encoding: AudioEncoding,
    receiver: mpsc::Receiver<Result<Vec<u8>, TtsError>>,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
}

impl AudioStream {
    pub fn encoding(&self) -> AudioEncoding {
        self.encoding
    }

    pub async fn recv(&mut self) -> Option<Result<Vec<u8>, TtsError>> {
        if self.cancellation.is_cancelled() {
            return None;
        }
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => None,
            value = self.receiver.recv() => value,
        }
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
