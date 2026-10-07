//! Minimal obs-websocket 5.x client for the experimental broadcast console.
//!
//! OBS Studio 28+ ships obs-websocket (Tools → WebSocket Server Settings). The
//! The console writes stream settings only on explicit go-live/end. A separate
//! bounded overlay recovery can update an already managed local browser source.
//! Status probes are read-only; no events are subscribed, and each operation
//! closes its connection.
//!
//! Protocol reference: obs-websocket 5.x protocol
//! (https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md).
//! Authentication: base64(sha256(base64(sha256(password + salt)) + challenge)).
use std::fmt;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use zeroize::Zeroizing;

pub const OBS_DEFAULT_HOST: &str = "127.0.0.1";
pub const OBS_DEFAULT_PORT: u16 = 4455;
/// Supported application input range for the configured video target bitrate.
pub const OBS_MIN_BITRATE_KBPS: u32 = 100;
pub const OBS_MAX_BITRATE_KBPS: u32 = 100_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const STEP_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const OUTPUT_POLL: Duration = Duration::from_millis(400);
const OUTPUT_WAIT_STEPS: u32 = 15;
const HOST_LIMIT: usize = 253;
const READY_POLL: Duration = Duration::from_millis(800);

// obs-websocket close codes (WebSocketCloseCode).
const CLOSE_AUTHENTICATION_FAILED: u16 = 4009;
const CLOSE_UNSUPPORTED_RPC_VERSION: u16 = 4010;
// obs-websocket request status codes (RequestStatus).
const STATUS_OUTPUT_RUNNING: i64 = 500;
const STATUS_OUTPUT_NOT_RUNNING: i64 = 501;
const STATUS_NOT_READY: i64 = 207;
const STATUS_RESOURCE_NOT_FOUND: i64 = 600;
/// Name of the browser source the overlay creates in OBS.
pub const OVERLAY_SOURCE_NAME: &str = "弹幕姬叠加层";

/// Saved non-secret connection choices. The WebSocket password is a separate
/// DPAPI-protected secret and never part of this value or configuration export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ObsSettings {
    /// Go live / end also start / stop the OBS stream.
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    /// Start a local OBS on go-live when it is not running.
    pub auto_launch: bool,
    /// User-chosen obs64.exe; `None` means the detected installation.
    pub executable: Option<String>,
}

impl Default for ObsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            host: OBS_DEFAULT_HOST.into(),
            port: OBS_DEFAULT_PORT,
            auto_launch: true,
            executable: None,
        }
    }
}

impl ObsSettings {
    /// A host name or IPv4 address only: no scheme, path, user info or port.
    pub fn is_valid(&self) -> bool {
        let host = self.host.as_str();
        self.port != 0
            && !host.is_empty()
            && host.len() <= HOST_LIMIT
            && host
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
            && !host.starts_with(['.', '-'])
            && !host.ends_with(['.', '-'])
            && !host.contains("..")
            && self
                .executable
                .as_deref()
                .is_none_or(crate::obs_process::is_valid_executable)
    }

    /// OBS can only be started for the person when it runs on this computer.
    pub fn is_local(&self) -> bool {
        let host = self.host.to_ascii_lowercase();
        host == "localhost"
            || host
                .parse::<std::net::Ipv4Addr>()
                .is_ok_and(|address| address.is_loopback())
    }

    fn url(&self) -> String {
        format!("ws://{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Error)]
pub enum ObsError {
    #[error(
        "无法连接 OBS（{0}）：请确认 OBS 已打开，并在「工具 → WebSocket 服务器设置」中开启服务器，端口与弹幕姬一致 [DV-OB01]"
    )]
    Connect(&'static str),
    #[error("OBS WebSocket 服务器启用了密码，请在“设置 → OBS 与开播 → OBS 连接”中填写 [DV-OB02]")]
    PasswordRequired,
    #[error("OBS WebSocket 密码不正确 [DV-OB03]")]
    AuthenticationFailed,
    #[error("OBS 返回了不支持的数据：{0}（需要 OBS 28 或更高版本） [DV-OB04]")]
    Protocol(&'static str),
    #[error("OBS 未能{action}：{reason} [DV-OB05]")]
    Request {
        action: &'static str,
        code: i64,
        reason: String,
    },
    #[error("等待 OBS 响应超时 [DV-OB06]")]
    Timeout,
    #[error("OBS 地址或端口无效 [DV-OB07]")]
    InvalidSettings,
    #[error("找不到 OBS 程序（obs64.exe），请在“设置 → OBS 与开播 → OBS 连接”中选择 [DV-OB08]")]
    NotInstalled,
    #[error("无法启动 OBS：{0} [DV-OB09]")]
    Launch(String),
    #[error(
        "OBS 已启动，但 {0} 秒内没有连上 WebSocket：请确认 OBS 已开启 WebSocket 服务器，或先处理 OBS 里的提示窗口 [DV-OB10]"
    )]
    NotReady(u64),
    #[error("OBS 码率设置：{0} [DV-OB11]")]
    Bitrate(&'static str),
    #[error("OBS 中同名来源不是弹幕姬管理的浏览器叠加层，请先重命名该来源再添加 [DV-OB12]")]
    OverlayConflict,
    #[error("叠加层地址只在本机有效，请将 OBS 连接地址设为 localhost 或 127.0.0.1 [DV-OB13]")]
    OverlayRemote,
    #[error("叠加层已由另一个应用窗口接管 [DV-OB15]")]
    OverlaySuperseded,
}

/// What a go-live push did in OBS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObsStartOutcome {
    /// Push settings were written and the stream output is active.
    Started,
    /// Start was accepted but the output was not active yet when we stopped waiting.
    Starting,
    /// OBS was already streaming; its settings were left untouched.
    AlreadyStreaming,
}

/// What an end-of-broadcast stop did in OBS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObsStopOutcome {
    Stopped,
    /// Stop was accepted but the output was still flushing when we stopped waiting.
    Stopping,
    NotStreaming,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ObsProbe {
    pub obs_version: String,
    pub websocket_version: String,
    pub streaming: bool,
}

/// The profile's configured video target, not the measured outgoing bitrate.
/// OBS Advanced mode keeps encoder settings in `streamEncoder.json`, which
/// obs-websocket 5 does not expose. Never substitute FFmpeg recording bitrate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ObsBitrate {
    pub bitrate_kbps: Option<u32>,
    pub output_mode: &'static str,
    pub editable: bool,
    pub outputs_active: bool,
    /// The websocket profile API saves a future target; it never reconfigures
    /// an encoder that is currently running.
    pub applies_next_stream: bool,
    pub reason: Option<&'static str>,
    pub min_kbps: u32,
    pub max_kbps: u32,
}

const ADVANCED_BITRATE_REASON: &str =
    "OBS 当前使用高级输出模式，请在 OBS 的「设置 → 输出 → 推流」中配置码率";
const ACTIVE_BITRATE_REASON: &str = "OBS 当前有输出运行；码率可以保存，下次开播生效";
const PROFILE_CHANGED_BITRATE_REASON: &str = "OBS 配置档已切换，请重新读取后检查码率";

/// Stream server and key handed to OBS. Debug output is redacted.
pub struct ObsPush<'a> {
    pub server: &'a str,
    pub key: &'a str,
}

impl fmt::Debug for ObsPush<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ObsPush([redacted])")
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// One identified obs-websocket session. Not reused across operations.
pub struct ObsConnection {
    socket: Socket,
    next_id: u64,
}

impl ObsConnection {
    pub async fn connect(settings: &ObsSettings, password: Option<&str>) -> Result<Self, ObsError> {
        if !settings.is_valid() {
            return Err(ObsError::InvalidSettings);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (socket, _) = timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(settings.url(), Some(config), true),
        )
        .await
        .map_err(|_| ObsError::Timeout)?
        .map_err(connect_error)?;
        let mut connection = Self { socket, next_id: 0 };
        let hello = connection.receive_op(0).await?;
        if hello.get("rpcVersion").and_then(Value::as_u64).unwrap_or(0) < 1 {
            return Err(ObsError::Protocol("RPC 版本"));
        }
        let mut identify = json!({"rpcVersion": 1, "eventSubscriptions": 0});
        if let Some(challenge) = hello.get("authentication") {
            let password = password.filter(|value| !value.is_empty());
            let Some(password) = password else {
                connection.close().await;
                return Err(ObsError::PasswordRequired);
            };
            let (Some(challenge), Some(salt)) = (
                challenge.get("challenge").and_then(Value::as_str),
                challenge.get("salt").and_then(Value::as_str),
            ) else {
                return Err(ObsError::Protocol("鉴权参数"));
            };
            identify["authentication"] =
                Value::String(authentication(password, salt, challenge).to_string());
        }
        let mut identify = json!({"op": 1, "d": identify});
        let sent = connection.send(&identify).await;
        scrub(&mut identify);
        sent?;
        connection.receive_op(2).await?;
        Ok(connection)
    }

    async fn send(&mut self, message: &Value) -> Result<(), ObsError> {
        let text = Zeroizing::new(message.to_string());
        timeout(STEP_TIMEOUT, self.socket.send(Message::text(text.as_str())))
            .await
            .map_err(|_| ObsError::Timeout)?
            .map_err(|_| ObsError::Connect("连接已断开"))
    }

    /// Next message with the given op code; events (op 5) are skipped.
    async fn receive_op(&mut self, op: u64) -> Result<Value, ObsError> {
        self.receive_op_until(op, tokio::time::Instant::now() + STEP_TIMEOUT)
            .await
    }

    async fn receive_op_until(
        &mut self,
        op: u64,
        deadline: tokio::time::Instant,
    ) -> Result<Value, ObsError> {
        loop {
            let message = tokio::time::timeout_at(deadline, self.socket.next())
                .await
                .map_err(|_| ObsError::Timeout)?;
            let message = match message {
                Some(Ok(message)) => message,
                Some(Err(_)) | None => return Err(ObsError::Connect("连接已断开")),
            };
            let text = match message {
                Message::Text(text) => text,
                Message::Close(frame) => {
                    return Err(match frame.map(|frame| u16::from(frame.code)) {
                        Some(CLOSE_AUTHENTICATION_FAILED) => ObsError::AuthenticationFailed,
                        Some(CLOSE_UNSUPPORTED_RPC_VERSION) => ObsError::Protocol("RPC 版本"),
                        _ => ObsError::Connect("OBS 关闭了连接"),
                    });
                }
                Message::Binary(_) => return Err(ObsError::Protocol("二进制消息")),
                _ => continue,
            };
            let value: Value =
                serde_json::from_str(text.as_str()).map_err(|_| ObsError::Protocol("消息格式"))?;
            match value.get("op").and_then(Value::as_u64) {
                Some(found) if found == op => {
                    return value
                        .get("d")
                        .cloned()
                        .ok_or(ObsError::Protocol("消息格式"));
                }
                Some(_) => continue,
                None => return Err(ObsError::Protocol("消息格式")),
            }
        }
    }

    async fn request(
        &mut self,
        request_type: &'static str,
        action: &'static str,
        data: Option<Value>,
    ) -> Result<Value, ObsError> {
        let deadline = tokio::time::Instant::now() + STEP_TIMEOUT;
        self.next_id += 1;
        let id = format!("dv-{}", self.next_id);
        let mut body = json!({"requestType": request_type, "requestId": id});
        if let Some(data) = data {
            body["requestData"] = data;
        }
        // Request data can carry the stream key; overwrite it once it is sent.
        let mut message = json!({"op": 6, "d": body});
        let sent = self.send(&message).await;
        scrub(&mut message);
        sent?;
        loop {
            let response = self.receive_op_until(7, deadline).await?;
            if response.get("requestId").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            let status = response
                .get("requestStatus")
                .ok_or(ObsError::Protocol("请求状态"))?;
            if status.get("result").and_then(Value::as_bool) == Some(true) {
                return Ok(response.get("responseData").cloned().unwrap_or(Value::Null));
            }
            let code = status.get("code").and_then(Value::as_i64).unwrap_or(0);
            let comment = status.get("comment").and_then(Value::as_str);
            return Err(ObsError::Request {
                action,
                code,
                reason: request_reason(code, comment),
            });
        }
    }

    pub async fn version(&mut self) -> Result<(String, String), ObsError> {
        let data = self.request("GetVersion", "读取版本", None).await?;
        let text = |key: &str| {
            data.get(key)
                .and_then(Value::as_str)
                .map(|value| value.chars().take(32).collect::<String>())
                .ok_or(ObsError::Protocol("版本信息"))
        };
        Ok((text("obsVersion")?, text("obsWebSocketVersion")?))
    }

    pub async fn stream_active(&mut self) -> Result<bool, ObsError> {
        let data = self
            .request("GetStreamStatus", "读取推流状态", None)
            .await?;
        data.get("outputActive")
            .and_then(Value::as_bool)
            .ok_or(ObsError::Protocol("推流状态"))
    }

    async fn profile_parameter(
        &mut self,
        category: &'static str,
        name: &'static str,
    ) -> Result<String, ObsError> {
        let data = self
            .request(
                "GetProfileParameter",
                "读取输出配置",
                Some(json!({"parameterCategory": category, "parameterName": name})),
            )
            .await?;
        profile_parameter_value(&data)
    }

    async fn outputs_active(&mut self) -> Result<bool, ObsError> {
        let data = self.request("GetOutputList", "读取输出状态", None).await?;
        let outputs = data["outputs"]
            .as_array()
            .ok_or(ObsError::Protocol("输出列表"))?;
        let mut active = false;
        for output in outputs {
            active |= output["outputActive"]
                .as_bool()
                .ok_or(ObsError::Protocol("输出状态"))?;
        }
        Ok(active)
    }

    async fn current_profile(&mut self) -> Result<String, ObsError> {
        let data = self
            .request("GetProfileList", "读取当前配置档", None)
            .await?;
        data["currentProfileName"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 1024)
            .map(str::to_owned)
            .ok_or(ObsError::Protocol("当前配置档"))
    }

    /// Read only the current streaming target. All encoders in Simple mode use
    /// SimpleOutput/VBitrate; Advanced mode has no corresponding websocket API.
    pub async fn bitrate(&mut self) -> Result<ObsBitrate, ObsError> {
        let mode = self.profile_parameter("Output", "Mode").await?;
        let (output_mode, bitrate_kbps, unsupported) = match mode.to_ascii_lowercase().as_str() {
            "simple" => {
                let value = self.profile_parameter("SimpleOutput", "VBitrate").await?;
                let bitrate = value
                    .parse::<u32>()
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or(ObsError::Protocol("视频码率"))?;
                ("simple", Some(bitrate), None)
            }
            "advanced" => ("advanced", None, Some(ADVANCED_BITRATE_REASON)),
            _ => return Err(ObsError::Protocol("输出模式")),
        };
        let outputs_active = self.outputs_active().await?;
        let reason = unsupported.or(outputs_active.then_some(ACTIVE_BITRATE_REASON));
        Ok(ObsBitrate {
            bitrate_kbps,
            output_mode,
            editable: unsupported.is_none(),
            outputs_active,
            applies_next_stream: true,
            reason,
            min_kbps: OBS_MIN_BITRATE_KBPS,
            max_kbps: OBS_MAX_BITRATE_KBPS,
        })
    }

    /// Persist the video target for the next stream start, including while
    /// outputs are active. SetProfileParameter only saves profile configuration;
    /// it does not update a running encoder. Do not change encoder/output mode.
    pub async fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<ObsBitrate, ObsError> {
        validate_bitrate(bitrate_kbps)?;
        let profile = self.current_profile().await?;
        let current = self.bitrate().await?;
        if !current.editable {
            return Err(ObsError::Bitrate(ADVANCED_BITRATE_REASON));
        }
        // Recheck mode and profile identity before writing. OBS exposes no
        // conditional profile write, so external changes are also checked on
        // readback rather than claiming an atomic transaction.
        if !self
            .profile_parameter("Output", "Mode")
            .await?
            .eq_ignore_ascii_case("simple")
        {
            return Err(ObsError::Bitrate(ADVANCED_BITRATE_REASON));
        }
        if self.current_profile().await? != profile {
            return Err(ObsError::Bitrate(PROFILE_CHANGED_BITRATE_REASON));
        }
        self.request(
            "SetProfileParameter",
            "保存视频码率",
            Some(json!({
                "parameterCategory": "SimpleOutput",
                "parameterName": "VBitrate",
                "parameterValue": bitrate_kbps.to_string(),
            })),
        )
        .await?;
        let saved = self.bitrate().await?;
        if self.current_profile().await? != profile {
            return Err(ObsError::Bitrate(PROFILE_CHANGED_BITRATE_REASON));
        }
        if saved.output_mode != "simple" || saved.bitrate_kbps != Some(bitrate_kbps) {
            return Err(ObsError::Bitrate(
                "OBS 读取的码率与保存值不一致，请刷新后检查",
            ));
        }
        Ok(saved)
    }

    /// Replace the current profile's stream service with a custom RTMP target.
    pub async fn set_custom_stream(&mut self, push: &ObsPush<'_>) -> Result<(), ObsError> {
        let data = json!({
            "streamServiceType": "rtmp_custom",
            "streamServiceSettings": {
                "server": push.server,
                "key": push.key,
                "use_auth": false,
                "bwtest": false,
            },
        });
        self.request("SetStreamServiceSettings", "写入推流设置", Some(data))
            .await
            .map(|_| ())
    }

    pub async fn start_stream(&mut self) -> Result<(), ObsError> {
        self.request("StartStream", "开始推流", None)
            .await
            .map(|_| ())
    }

    pub async fn stop_stream(&mut self) -> Result<(), ObsError> {
        self.request("StopStream", "停止推流", None)
            .await
            .map(|_| ())
    }

    async fn wait_for_output(&mut self, active: bool) -> Result<bool, ObsError> {
        for _ in 0..OUTPUT_WAIT_STEPS {
            if self.stream_active().await? == active {
                return Ok(true);
            }
            sleep(OUTPUT_POLL).await;
        }
        Ok(false)
    }

    pub async fn close(mut self) {
        let _ = timeout(Duration::from_secs(1), self.socket.close(None)).await;
    }
}

/// Version and stream state for the settings "test" button. Changes nothing.
pub async fn probe(settings: &ObsSettings, password: Option<&str>) -> Result<ObsProbe, ObsError> {
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = async {
        let (obs_version, websocket_version) = connection.version().await?;
        let streaming = connection.stream_active().await?;
        Ok(ObsProbe {
            obs_version,
            websocket_version,
            streaming,
        })
    }
    .await;
    connection.close().await;
    result
}

fn profile_parameter_value(data: &Value) -> Result<String, ObsError> {
    let value = data
        .get("parameterValue")
        .filter(|value| !value.is_null())
        .or_else(|| data.get("defaultParameterValue"));
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .map(str::to_owned)
        .ok_or(ObsError::Protocol("输出配置参数"))
}

pub fn validate_bitrate(bitrate_kbps: u32) -> Result<(), ObsError> {
    if !(OBS_MIN_BITRATE_KBPS..=OBS_MAX_BITRATE_KBPS).contains(&bitrate_kbps) {
        return Err(ObsError::Bitrate("视频码率须为 100–100000 Kbps 的整数"));
    }
    Ok(())
}

/// Explicit details-panel read. No credential-bearing requests or writes.
pub async fn bitrate(
    settings: &ObsSettings,
    password: Option<&str>,
) -> Result<ObsBitrate, ObsError> {
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = connection.bitrate().await;
    connection.close().await;
    result
}

/// An explicit save persists only the next stream's video target and verifies
/// the stored value. It does not reconfigure an active encoder.
pub async fn set_bitrate(
    settings: &ObsSettings,
    password: Option<&str>,
    bitrate_kbps: u32,
) -> Result<ObsBitrate, ObsError> {
    validate_bitrate(bitrate_kbps)?;
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = connection.set_bitrate(bitrate_kbps).await;
    connection.close().await;
    result
}

/// Go live in OBS: write the push target and start streaming. An already
/// active OBS stream is left alone, because its destination cannot change
/// while it runs and the person may be streaming somewhere on purpose.
pub async fn start(
    settings: &ObsSettings,
    password: Option<&str>,
    push: &ObsPush<'_>,
) -> Result<ObsStartOutcome, ObsError> {
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = async {
        if connection.stream_active().await? {
            return Ok(ObsStartOutcome::AlreadyStreaming);
        }
        connection.set_custom_stream(push).await?;
        match connection.start_stream().await {
            Ok(()) => {}
            Err(ObsError::Request {
                code: STATUS_OUTPUT_RUNNING,
                ..
            }) => return Ok(ObsStartOutcome::AlreadyStreaming),
            Err(error) => return Err(error),
        }
        Ok(if connection.wait_for_output(true).await? {
            ObsStartOutcome::Started
        } else {
            ObsStartOutcome::Starting
        })
    }
    .await;
    connection.close().await;
    result
}

/// End in OBS before the Bilibili room closes, so viewers do not see a cut
/// feed and OBS does not keep retrying a closed ingest.
pub async fn stop(
    settings: &ObsSettings,
    password: Option<&str>,
) -> Result<ObsStopOutcome, ObsError> {
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = async {
        if !connection.stream_active().await? {
            return Ok(ObsStopOutcome::NotStreaming);
        }
        match connection.stop_stream().await {
            Ok(()) => {}
            Err(ObsError::Request {
                code: STATUS_OUTPUT_NOT_RUNNING,
                ..
            }) => return Ok(ObsStopOutcome::NotStreaming),
            Err(error) => return Err(error),
        }
        Ok(if connection.wait_for_output(false).await? {
            ObsStopOutcome::Stopped
        } else {
            ObsStopOutcome::Stopping
        })
    }
    .await;
    connection.close().await;
    result
}

/// Wait for an OBS that was just started: its WebSocket server comes up only
/// after plugins load, and early requests may answer "not ready" (207).
pub async fn wait_until_ready(
    settings: &ObsSettings,
    password: Option<&str>,
    limit: Duration,
) -> Result<(), ObsError> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let attempt = async {
            let mut connection = ObsConnection::connect(settings, password).await?;
            let result = connection.stream_active().await.map(|_| ());
            connection.close().await;
            result
        }
        .await;
        match attempt {
            Ok(()) => return Ok(()),
            Err(
                ObsError::Connect(_)
                | ObsError::Timeout
                | ObsError::Request {
                    code: STATUS_NOT_READY,
                    ..
                },
            ) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(ObsError::NotReady(limit.as_secs()));
                }
                sleep(READY_POLL).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Result of putting the overlay browser source into OBS.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OverlaySourceOutcome {
    /// A new input was created.
    pub created: bool,
    /// Existing input settings changed; false for an identical address and size.
    pub updated: bool,
    /// A disconnected, active managed browser was explicitly reloaded.
    pub refreshed: bool,
    /// The input was added to the current scene by this call.
    pub added_to_scene: bool,
    /// False only for `update_only` when OBS has no such source.
    pub found: bool,
    pub scene: String,
    pub width: u64,
    pub height: u64,
}

/// A successful transport probe remains available even when the source itself
/// cannot be repaired (for example a same-name input belonging to the user).
pub struct ObsOverlayResult {
    pub probe: ObsProbe,
    pub overlay: Result<OverlaySourceOutcome, ObsError>,
    /// True even if OBS did not confirm the refresh; do not blindly retry it.
    pub refresh_attempted: bool,
}

/// Recognize only this app's loopback overlay endpoint, never arbitrary local
/// browser pages. The original token may be stale; repairing it is the purpose
/// of this check. Do not include the address in diagnostics.
fn managed_overlay_url(address: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(address) else {
        return false;
    };
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || url.port().is_none_or(|port| port == 0)
        || url.path() != "/overlay"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let mut token_seen = false;
    let mut dimensions = [false; 2];
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "token" if !token_seen => {
                if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return false;
                }
                token_seen = true;
            }
            "w" | "h" => {
                let index = usize::from(key == "h");
                if dimensions[index]
                    || !value
                        .parse::<u64>()
                        .is_ok_and(|value| (1..=16384).contains(&value))
                {
                    return false;
                }
                dimensions[index] = true;
            }
            _ => return false,
        }
    }
    token_seen
}

fn validate_overlay_target(settings: &ObsSettings, address: &str) -> Result<(), ObsError> {
    if !settings.is_valid() {
        return Err(ObsError::InvalidSettings);
    }
    if !settings.is_local() {
        return Err(ObsError::OverlayRemote);
    }
    if !managed_overlay_url(address) {
        return Err(ObsError::InvalidSettings);
    }
    Ok(())
}

/// Create (or update) the overlay browser source in the current program
/// scene, sized to the OBS base canvas. With `update_only`, only an existing
/// source's address and size change; nothing is created or added.
pub async fn put_overlay_source(
    settings: &ObsSettings,
    password: Option<&str>,
    url: &str,
    update_only: bool,
) -> Result<OverlaySourceOutcome, ObsError> {
    validate_overlay_target(settings, url)?;
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = put_overlay_source_on(&mut connection, url, update_only, || true).await;
    connection.close().await;
    result
}

/// Read transport status and then repair/add the source on one short-lived
/// connection. Source errors never masquerade as a failed connection probe.
pub async fn probe_and_put_overlay_source(
    settings: &ObsSettings,
    password: Option<&str>,
    url: &str,
    update_only: bool,
) -> Result<ObsOverlayResult, ObsError> {
    probe_and_recover_overlay_source(
        settings,
        password,
        url,
        update_only,
        false,
        || false,
        || true,
    )
    .await
}

/// Recovery can reload only an existing, owned, active browser. The final
/// health callback prevents a newly reconnected page being needlessly reset.
pub async fn probe_and_recover_overlay_source(
    settings: &ObsSettings,
    password: Option<&str>,
    url: &str,
    update_only: bool,
    refresh_disconnected: bool,
    can_refresh: impl Fn() -> bool,
    can_mutate: impl Fn() -> bool,
) -> Result<ObsOverlayResult, ObsError> {
    validate_overlay_target(settings, url)?;
    let mut connection = ObsConnection::connect(settings, password).await?;
    let result = async {
        let (obs_version, websocket_version) = connection.version().await?;
        let streaming = connection.stream_active().await?;
        let mut refresh_attempted = false;
        let overlay = match put_overlay_source_on(&mut connection, url, update_only,&can_mutate).await {
            Ok(mut found) => async {
                if update_only && found.found && !found.updated && refresh_disconnected && can_refresh() {
                    let active = connection.request("GetSourceActive","读取叠加层活动状态",
                        Some(json!({"sourceName":OVERLAY_SOURCE_NAME}))).await?;
                    let active = active["videoActive"].as_bool().ok_or(ObsError::Protocol("来源活动状态"))?;
                    if active && can_refresh() {
                        if !can_mutate() {return Err(ObsError::OverlaySuperseded);}
                        refresh_attempted = true;
                        connection.request("PressInputPropertiesButton","重新连接叠加层页面",
                            Some(json!({"inputName":OVERLAY_SOURCE_NAME,"propertyName":"refreshnocache"}))).await?;
                        found.refreshed = true;
                    }
                }
                Ok(found)
            }.await,
            Err(error) => Err(error),
        };
        Ok(ObsOverlayResult {
            probe: ObsProbe {
                obs_version,
                websocket_version,
                streaming,
            },
            overlay,
            refresh_attempted,
        })
    }
    .await;
    connection.close().await;
    result
}

async fn put_overlay_source_on(
    connection: &mut ObsConnection,
    url: &str,
    update_only: bool,
    can_mutate: impl Fn() -> bool,
) -> Result<OverlaySourceOutcome, ObsError> {
    let video = connection
        .request("GetVideoSettings", "读取画布大小", None)
        .await?;
    let size = |key: &str| {
        video
            .get(key)
            .and_then(Value::as_u64)
            .filter(|value| (1..=16384).contains(value))
            .ok_or(ObsError::Protocol("画布大小"))
    };
    let (width, height) = (size("baseWidth")?, size("baseHeight")?);
    let scene_data = connection
        .request("GetCurrentProgramScene", "读取当前场景", None)
        .await?;
    let scene = scene_data
        .get("currentProgramSceneName")
        .or_else(|| scene_data.get("sceneName"))
        .and_then(Value::as_str)
        .ok_or(ObsError::Protocol("当前场景"))?
        .to_owned();
    let source_settings =
        json!({"url": url, "width": width, "height": height, "is_local_file": false});
    let existing = connection
        .request(
            "GetInputSettings",
            "读取叠加层来源",
            Some(json!({"inputName": OVERLAY_SOURCE_NAME})),
        )
        .await;
    let mut updated = false;
    let created = match existing {
        Ok(existing) => {
            let current = &existing["inputSettings"];
            if existing["inputKind"] != "browser_source"
                || !current["url"].as_str().is_some_and(managed_overlay_url)
            {
                return Err(ObsError::OverlayConflict);
            }
            // GetInputSettings omits defaults. Preserve the user's browser
            // CSS, shutdown and restart_when_active choices via overlay=true.
            // A missing is_local_file is the browser plugin's default false.
            updated = current["url"] != url
                || current["width"].as_u64() != Some(width)
                || current["height"].as_u64() != Some(height)
                || current["is_local_file"].as_bool().unwrap_or(false);
            if updated {
                if !can_mutate() {
                    return Err(ObsError::OverlaySuperseded);
                }
                connection
                    .request(
                        "SetInputSettings",
                        "更新叠加层来源",
                        Some(json!({"inputName": OVERLAY_SOURCE_NAME, "inputSettings": source_settings, "overlay": true})),
                    )
                    .await?;
            }
            false
        }
        Err(ObsError::Request {
            code: STATUS_RESOURCE_NOT_FOUND,
            ..
        }) if update_only => {
            return Ok(OverlaySourceOutcome {
                created: false,
                updated: false,
                refreshed: false,
                added_to_scene: false,
                found: false,
                scene,
                width,
                height,
            });
        }
        Err(ObsError::Request {
            code: STATUS_RESOURCE_NOT_FOUND,
            ..
        }) => {
            if !can_mutate() {
                return Err(ObsError::OverlaySuperseded);
            }
            connection
                .request(
                    "CreateInput",
                    "添加叠加层来源",
                    Some(json!({
                        "sceneName": scene,
                        "inputName": OVERLAY_SOURCE_NAME,
                        "inputKind": "browser_source",
                        "inputSettings": source_settings,
                        "sceneItemEnabled": true,
                    })),
                )
                .await?;
            true
        }
        Err(error) => return Err(error),
    };
    let mut added_to_scene = created;
    if !created && !update_only {
        let present = connection
            .request(
                "GetSceneItemId",
                "查找场景中的叠加层",
                Some(json!({"sceneName": scene, "sourceName": OVERLAY_SOURCE_NAME})),
            )
            .await;
        match present {
            Ok(present) => {
                let item_id = present["sceneItemId"]
                    .as_u64()
                    .ok_or(ObsError::Protocol("场景来源编号"))?;
                let enabled = connection
                    .request(
                        "GetSceneItemEnabled",
                        "读取叠加层可见性",
                        Some(json!({"sceneName": scene, "sceneItemId": item_id})),
                    )
                    .await?;
                match enabled["sceneItemEnabled"].as_bool() {
                    Some(true) => {}
                    Some(false) => {
                        if !can_mutate() {
                            return Err(ObsError::OverlaySuperseded);
                        }
                        connection.request("SetSceneItemEnabled", "显示叠加层来源",
                                Some(json!({"sceneName": scene, "sceneItemId": item_id, "sceneItemEnabled": true}))).await?;
                    }
                    None => return Err(ObsError::Protocol("场景来源可见性")),
                }
            }
            Err(ObsError::Request {
                code: STATUS_RESOURCE_NOT_FOUND,
                ..
            }) => {
                if !can_mutate() {
                    return Err(ObsError::OverlaySuperseded);
                }
                connection
                        .request(
                            "CreateSceneItem",
                            "把叠加层加入当前场景",
                            Some(json!({"sceneName": scene, "sourceName": OVERLAY_SOURCE_NAME, "sceneItemEnabled": true})),
                        )
                        .await?;
                added_to_scene = true;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(OverlaySourceOutcome {
        created,
        updated,
        refreshed: false,
        added_to_scene,
        found: true,
        scene,
        width,
        height,
    })
}

fn authentication(password: &str, salt: &str, challenge: &str) -> Zeroizing<String> {
    let mut first = Sha256::new();
    first.update(password.as_bytes());
    first.update(salt.as_bytes());
    let secret = Zeroizing::new(STANDARD.encode(first.finalize()));
    let mut second = Sha256::new();
    second.update(secret.as_bytes());
    second.update(challenge.as_bytes());
    Zeroizing::new(STANDARD.encode(second.finalize()))
}

fn connect_error(error: tokio_tungstenite::tungstenite::Error) -> ObsError {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::Io(io) => ObsError::Connect(match io.kind() {
            std::io::ErrorKind::ConnectionRefused => "连接被拒绝",
            std::io::ErrorKind::TimedOut => "连接超时",
            std::io::ErrorKind::NotFound => "找不到该地址",
            _ => "网络错误",
        }),
        Error::Url(_) => ObsError::InvalidSettings,
        Error::Http(_) | Error::HttpFormat(_) => {
            ObsError::Connect("该端口不是 OBS WebSocket 服务器")
        }
        _ => ObsError::Connect("握手失败"),
    }
}

fn request_reason(code: i64, comment: Option<&str>) -> String {
    match code {
        STATUS_OUTPUT_RUNNING => "OBS 正在推流".into(),
        STATUS_OUTPUT_NOT_RUNNING => "OBS 当前没有推流".into(),
        STATUS_NOT_READY => "OBS 尚未准备好，请稍后重试".into(),
        _ => match comment {
            Some(comment) if !comment.trim().is_empty() => format!(
                "{}（代码 {code}）",
                comment
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(160)
                    .collect::<String>()
            ),
            _ => format!("代码 {code}"),
        },
    }
}

/// Overwrite every string in a JSON value before it is dropped.
fn scrub(value: &mut Value) {
    match value {
        Value::String(text) => zeroize::Zeroize::zeroize(text),
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::Object(map) => map.values_mut().for_each(scrub),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    #[tokio::test]
    async fn unrelated_frames_cannot_extend_a_request_deadline() {
        for wrong_id in [false, true] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let endpoint = format!("ws://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                loop {
                    let frame = if wrong_id {
                        Message::text(json!({"op":7,"d":{"requestId":"wrong"}}).to_string())
                    } else {
                        Message::Ping(vec![1].into())
                    };
                    if socket.send(frame).await.is_err() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            });
            let (socket, _) = tokio_tungstenite::connect_async(endpoint).await.unwrap();
            let mut connection = ObsConnection { socket, next_id: 0 };
            let deadline = tokio::time::Instant::now() + Duration::from_millis(100);
            let result = timeout(Duration::from_millis(500), async {
                loop {
                    connection.receive_op_until(7, deadline).await?;
                }
                #[allow(unreachable_code)]
                Ok::<(), ObsError>(())
            })
            .await
            .expect("unrelated messages extended the deadline");
            assert!(matches!(result, Err(ObsError::Timeout)));
            drop(connection);
            server.abort();
        }
    }

    /// Hello values from the obs-websocket protocol documentation; the expected
    /// string was computed independently (Python hashlib/base64) for this test.
    #[test]
    fn authentication_follows_the_two_step_protocol_hash() {
        let password = "supersecretpassword";
        let salt = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=";
        let challenge = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=";
        assert_eq!(
            authentication(password, salt, challenge).as_str(),
            "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4="
        );
    }

    #[test]
    fn settings_accept_only_plain_hosts_and_ports() {
        assert!(ObsSettings::default().is_valid());
        for host in ["localhost", "192.168.1.20", "obs-pc.lan"] {
            assert!(
                ObsSettings {
                    host: host.into(),
                    ..ObsSettings::default()
                }
                .is_valid(),
                "{host}"
            );
        }
        for host in [
            "",
            "ws://127.0.0.1",
            "127.0.0.1:4455",
            "a/b",
            "user@host",
            ".x",
            "x..y",
            "x-",
        ] {
            assert!(
                !ObsSettings {
                    host: host.into(),
                    ..ObsSettings::default()
                }
                .is_valid(),
                "{host}"
            );
        }
        assert!(
            !ObsSettings {
                port: 0,
                ..ObsSettings::default()
            }
            .is_valid()
        );
    }

    #[derive(Default, Clone)]
    struct Fake {
        password: Option<&'static str>,
        streaming: bool,
        refuse_start: bool,
        /// After StopStream, how many GetStreamStatus replies still say active.
        stop_lag: u32,
        /// GetStreamStatus answers 207 (not ready) this many times first.
        not_ready: u32,
        /// The overlay input already exists / is already in the scene.
        source_exists: bool,
        source_in_scene: bool,
        source_settings: Option<Value>,
        input_kind: Option<&'static str>,
        scene_item_disabled: bool,
        source_active: bool,
        refuse_refresh: bool,
        /// Connections served before the fake stops (0 means 1).
        connections: usize,
        output_mode: Option<&'static str>,
        bitrate: Option<&'static str>,
        profile_name: Option<Value>,
        change_profile_on_recheck: bool,
        change_profile_after_write: bool,
        output_list: Option<Value>,
        activate_on_recheck: bool,
        advanced_on_recheck: bool,
        refuse_bitrate_write: bool,
        ignore_bitrate_write: bool,
    }

    #[derive(Default, Debug)]
    struct Seen {
        requests: Vec<String>,
        service: Option<Value>,
        identified: bool,
        sources: Vec<(String, Value)>,
        profile_writes: Vec<Value>,
    }

    /// A loopback obs-websocket stand-in that follows the documented message
    /// flow. Returns its port and a handle with what it saw.
    async fn fake_obs(fake: Fake) -> (u16, tokio::task::JoinHandle<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (port, tokio::spawn(serve(listener, fake)))
    }

    async fn serve(listener: TcpListener, fake: Fake) -> Seen {
        let mut seen = Seen::default();
        let mut not_ready = fake.not_ready;
        let mut source_exists = fake.source_exists;
        let mut source_in_scene = fake.source_in_scene;
        let mut source_settings = fake.source_settings.clone().unwrap_or_else(|| {
            json!({
                "url":"http://127.0.0.1:47822/overlay?token=abcdef0123456789abcdef0123456789",
                "width":640,"height":360,"is_local_file":false
            })
        });
        let mut scene_item_enabled = !fake.scene_item_disabled;
        for _ in 0..fake.connections.max(1) {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut streaming = fake.streaming;
            let mut lag = 0;
            let mut profile_bitrate = fake.bitrate.unwrap_or("2500").to_owned();
            let mut mode_reads = 0;
            let mut output_reads = 0;
            let mut profile_reads = 0;
            let salt = "c2FsdA==";
            let challenge = "Y2hhbGxlbmdl";
            let mut hello = json!({"obsWebSocketVersion": "5.5.2", "rpcVersion": 1});
            if fake.password.is_some() {
                hello["authentication"] = json!({"challenge": challenge, "salt": salt});
            }
            socket
                .send(Message::text(json!({"op": 0, "d": hello}).to_string()))
                .await
                .unwrap();
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else { break };
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                let d = &value["d"];
                match value["op"].as_u64().unwrap() {
                    1 => {
                        assert_eq!(d["eventSubscriptions"], 0);
                        if let Some(password) = fake.password {
                            let expected = authentication(password, salt, challenge);
                            if d["authentication"].as_str() != Some(expected.as_str()) {
                                let _ = socket
                                    .send(Message::Close(Some(CloseFrame {
                                        code: CloseCode::from(CLOSE_AUTHENTICATION_FAILED),
                                        reason: "Authentication failed.".into(),
                                    })))
                                    .await;
                                break;
                            }
                        }
                        seen.identified = true;
                        // An unrelated event must be skipped by the client.
                        socket
                            .send(Message::text(
                                json!({"op": 5, "d": {"eventType": "Noise"}}).to_string(),
                            ))
                            .await
                            .unwrap();
                        socket
                            .send(Message::text(
                                json!({"op": 2, "d": {"negotiatedRpcVersion": 1}}).to_string(),
                            ))
                            .await
                            .unwrap();
                    }
                    6 => {
                        let kind = d["requestType"].as_str().unwrap().to_owned();
                        seen.requests.push(kind.clone());
                        let (ok, code, data) = match kind.as_str() {
                            "GetVersion" => (
                                true,
                                100,
                                json!({"obsVersion": "31.0.0", "obsWebSocketVersion": "5.5.2"}),
                            ),
                            "GetProfileList" => {
                                profile_reads += 1;
                                let name = if (fake.change_profile_on_recheck && profile_reads > 1)
                                    || (fake.change_profile_after_write
                                        && !seen.profile_writes.is_empty())
                                {
                                    json!("Different profile")
                                } else {
                                    fake.profile_name
                                        .clone()
                                        .unwrap_or_else(|| json!("Default"))
                                };
                                (
                                    true,
                                    100,
                                    json!({"currentProfileName":name,"profiles":["Default","Different profile"]}),
                                )
                            }
                            "GetProfileParameter" => {
                                let parameter = &d["requestData"];
                                let value = match (
                                    parameter["parameterCategory"].as_str().unwrap(),
                                    parameter["parameterName"].as_str().unwrap(),
                                ) {
                                    ("Output", "Mode") => {
                                        mode_reads += 1;
                                        if fake.advanced_on_recheck && mode_reads > 1 {
                                            "Advanced".to_owned()
                                        } else {
                                            fake.output_mode.unwrap_or("Simple").to_owned()
                                        }
                                    }
                                    ("SimpleOutput", "VBitrate") => profile_bitrate.clone(),
                                    other => panic!("unexpected profile parameter {other:?}"),
                                };
                                (
                                    true,
                                    100,
                                    json!({"parameterValue": value,"defaultParameterValue":null}),
                                )
                            }
                            "GetOutputList" => {
                                output_reads += 1;
                                let data = fake.output_list.clone().unwrap_or_else(|| {
                                    json!({"outputs":[{"outputName":"stream", "outputActive":
                                        streaming || (fake.activate_on_recheck && output_reads > 1)}]})
                                });
                                (true, 100, data)
                            }
                            "SetProfileParameter" => {
                                let parameter = d["requestData"].clone();
                                assert_eq!(parameter["parameterCategory"], "SimpleOutput");
                                assert_eq!(parameter["parameterName"], "VBitrate");
                                seen.profile_writes.push(parameter.clone());
                                if fake.refuse_bitrate_write {
                                    (false, 403, Value::Null)
                                } else {
                                    if !fake.ignore_bitrate_write {
                                        profile_bitrate = parameter["parameterValue"]
                                            .as_str()
                                            .unwrap()
                                            .to_owned();
                                    }
                                    (true, 100, Value::Null)
                                }
                            }
                            "GetStreamStatus" if not_ready > 0 => {
                                not_ready -= 1;
                                (false, STATUS_NOT_READY, Value::Null)
                            }
                            "GetVideoSettings" => (
                                true,
                                100,
                                json!({"baseWidth": 2560, "baseHeight": 1440, "outputWidth": 1920, "outputHeight": 1080}),
                            ),
                            "GetCurrentProgramScene" => (
                                true,
                                100,
                                json!({"currentProgramSceneName": "游戏场景", "sceneName": "游戏场景"}),
                            ),
                            "GetInputSettings" if source_exists => (
                                true,
                                100,
                                json!({"inputSettings": source_settings, "inputKind": fake.input_kind.unwrap_or("browser_source")}),
                            ),
                            "GetInputSettings" => (false, STATUS_RESOURCE_NOT_FOUND, Value::Null),
                            "GetSceneItemId" if source_in_scene => {
                                (true, 100, json!({"sceneItemId": 7}))
                            }
                            "GetSceneItemId" => (false, STATUS_RESOURCE_NOT_FOUND, Value::Null),
                            "GetSceneItemEnabled" => {
                                (true, 100, json!({"sceneItemEnabled":scene_item_enabled}))
                            }
                            "GetSourceActive" => (
                                true,
                                100,
                                json!({"videoActive":fake.source_active,"videoShowing":fake.source_active}),
                            ),
                            "PressInputPropertiesButton" => {
                                let request = d["requestData"].clone();
                                assert_eq!(request["inputName"], OVERLAY_SOURCE_NAME);
                                assert_eq!(request["propertyName"], "refreshnocache");
                                seen.sources.push((kind.clone(), request));
                                if fake.refuse_refresh {
                                    (false, 403, Value::Null)
                                } else {
                                    (true, 100, Value::Null)
                                }
                            }
                            "CreateInput"
                            | "SetInputSettings"
                            | "CreateSceneItem"
                            | "SetSceneItemEnabled" => {
                                seen.sources.push((kind.clone(), d["requestData"].clone()));
                                if kind == "CreateInput" || kind == "SetInputSettings" {
                                    for (key, value) in
                                        d["requestData"]["inputSettings"].as_object().unwrap()
                                    {
                                        source_settings[key] = value.clone();
                                    }
                                }
                                if kind == "CreateInput" {
                                    source_exists = true;
                                    source_in_scene = true;
                                }
                                if kind == "CreateSceneItem" {
                                    source_in_scene = true;
                                }
                                if kind == "SetSceneItemEnabled" {
                                    scene_item_enabled =
                                        d["requestData"]["sceneItemEnabled"].as_bool().unwrap();
                                }
                                (true, 100, Value::Null)
                            }
                            "GetStreamStatus" => {
                                let active = if lag > 0 {
                                    lag -= 1;
                                    true
                                } else {
                                    streaming
                                };
                                (
                                    true,
                                    100,
                                    json!({"outputActive": active, "outputReconnecting": false}),
                                )
                            }
                            "SetStreamServiceSettings" => {
                                seen.service = Some(d["requestData"].clone());
                                (true, 100, Value::Null)
                            }
                            "StartStream" if fake.refuse_start => (false, 702, Value::Null),
                            "StartStream" if streaming => {
                                (false, STATUS_OUTPUT_RUNNING, Value::Null)
                            }
                            "StartStream" => {
                                streaming = true;
                                (true, 100, Value::Null)
                            }
                            "StopStream" if !streaming => {
                                (false, STATUS_OUTPUT_NOT_RUNNING, Value::Null)
                            }
                            "StopStream" => {
                                streaming = false;
                                lag = fake.stop_lag;
                                (true, 100, Value::Null)
                            }
                            _ => (false, 204, Value::Null),
                        };
                        let mut status = json!({"result": ok, "code": code});
                        if code == 702 {
                            status["comment"] = json!("Failed to start output.");
                        }
                        let mut reply = json!({"requestType": kind, "requestId": d["requestId"], "requestStatus": status});
                        if !data.is_null() {
                            reply["responseData"] = data;
                        }
                        socket
                            .send(Message::text(json!({"op": 7, "d": reply}).to_string()))
                            .await
                            .unwrap();
                    }
                    other => panic!("unexpected op {other}"),
                }
            }
        }
        seen
    }

    fn local(port: u16) -> ObsSettings {
        ObsSettings {
            enabled: true,
            host: "127.0.0.1".into(),
            port,
            ..ObsSettings::default()
        }
    }

    const PUSH: ObsPush<'static> = ObsPush {
        server: "rtmp://live-push.example.invalid/live-bvc/",
        key: "?streamname=fictional-stream-key",
    };

    #[test]
    fn bitrate_input_and_profile_values_require_valid_integers_and_strings() {
        for value in [100, 6000, 100_000] {
            validate_bitrate(value).unwrap();
        }
        for value in [0, 99, 100_001, u32::MAX] {
            assert!(matches!(validate_bitrate(value), Err(ObsError::Bitrate(_))));
        }
        assert_eq!(
            profile_parameter_value(&json!({"parameterValue":null,"defaultParameterValue":"2500"}))
                .unwrap(),
            "2500"
        );
        for data in [
            json!({}),
            json!({"parameterValue":2500}),
            json!({"parameterValue":""}),
            json!({"parameterValue":"x".repeat(65)}),
        ] {
            assert!(matches!(
                profile_parameter_value(&data),
                Err(ObsError::Protocol(_))
            ));
        }
    }

    #[tokio::test]
    async fn bitrate_read_is_transient_and_advanced_is_explicitly_unsupported() {
        for mode in ["Simple", "Advanced"] {
            let (port, server) = fake_obs(Fake {
                output_mode: Some(mode),
                ..Fake::default()
            })
            .await;
            let found = bitrate(&local(port), None).await.unwrap();
            let seen = server.await.unwrap();
            assert!(seen.profile_writes.is_empty());
            assert!(seen.service.is_none());
            assert!(found.applies_next_stream);
            if mode == "Simple" {
                assert_eq!(found.bitrate_kbps, Some(2500));
                assert!(found.editable);
                assert_eq!(
                    seen.requests,
                    [
                        "GetProfileParameter",
                        "GetProfileParameter",
                        "GetOutputList"
                    ]
                );
            } else {
                assert_eq!(found.bitrate_kbps, None);
                assert_eq!(found.output_mode, "advanced");
                assert!(!found.editable);
                assert_eq!(found.reason, Some(ADVANCED_BITRATE_REASON));
                assert_eq!(seen.requests, ["GetProfileParameter", "GetOutputList"]);
            }
        }
    }

    #[tokio::test]
    async fn bitrate_save_checks_mode_and_profile_then_verifies_the_written_target() {
        let (port, server) = fake_obs(Fake::default()).await;
        let found = set_bitrate(&local(port), None, 6000).await.unwrap();
        assert_eq!(found.bitrate_kbps, Some(6000));
        assert!(found.editable);
        assert!(found.applies_next_stream);
        let seen = server.await.unwrap();
        assert_eq!(
            seen.requests,
            [
                "GetProfileList",
                "GetProfileParameter",
                "GetProfileParameter",
                "GetOutputList",
                "GetProfileParameter",
                "GetProfileList",
                "SetProfileParameter",
                "GetProfileParameter",
                "GetProfileParameter",
                "GetOutputList",
                "GetProfileList",
            ]
        );
        assert_eq!(
            seen.profile_writes,
            [json!({
                "parameterCategory":"SimpleOutput", "parameterName":"VBitrate", "parameterValue":"6000",
            })]
        );
        assert!(seen.service.is_none());
    }

    #[tokio::test]
    async fn bitrate_save_allows_running_outputs_and_only_saves_next_stream_configuration() {
        let mut cases = vec![
            Fake {
                streaming: true,
                ..Fake::default()
            },
            Fake {
                activate_on_recheck: true,
                ..Fake::default()
            },
        ];
        for kind in [
            "stream",
            "record",
            "replay_buffer",
            "virtualcam",
            "plugin_output",
        ] {
            cases.push(Fake {
                output_list: Some(json!({"outputs":[
                    {"outputName":"idle_stream", "outputActive":false},
                    {"outputName":kind, "outputActive":true},
                ]})),
                ..Fake::default()
            });
        }
        for fake in cases {
            let (port, server) = fake_obs(fake).await;
            let found = set_bitrate(&local(port), None, 6000).await.unwrap();
            assert_eq!(found.bitrate_kbps, Some(6000));
            assert!(found.editable);
            assert!(found.outputs_active);
            assert!(found.applies_next_stream);
            assert_eq!(found.reason, Some(ACTIVE_BITRATE_REASON));
            assert_eq!(
                serde_json::to_value(found).unwrap()["applies_next_stream"],
                true
            );
            let seen = server.await.unwrap();
            assert_eq!(
                seen.profile_writes,
                [json!({
                    "parameterCategory":"SimpleOutput", "parameterName":"VBitrate", "parameterValue":"6000",
                })]
            );
            // No stop/start, output/encoder reconfiguration, source creation or
            // stream-service request is part of this operation.
            assert!(seen.requests.iter().all(|request| matches!(
                request.as_str(),
                "GetProfileList" | "GetProfileParameter" | "GetOutputList" | "SetProfileParameter"
            )));
            assert!(seen.service.is_none());
            assert!(seen.sources.is_empty());
        }
    }

    #[tokio::test]
    async fn bitrate_save_rejects_advanced_or_changed_profiles_without_writing() {
        for fake in [
            Fake {
                output_mode: Some("Advanced"),
                streaming: true,
                ..Fake::default()
            },
            Fake {
                advanced_on_recheck: true,
                ..Fake::default()
            },
            Fake {
                change_profile_on_recheck: true,
                ..Fake::default()
            },
        ] {
            let (port, server) = fake_obs(fake).await;
            assert!(matches!(
                set_bitrate(&local(port), None, 6000).await,
                Err(ObsError::Bitrate(_))
            ));
            assert!(server.await.unwrap().profile_writes.is_empty());
        }
        // A switch after the single write is reported without a speculative
        // retry into the newly selected profile.
        let (port, server) = fake_obs(Fake {
            change_profile_after_write: true,
            ..Fake::default()
        })
        .await;
        assert!(matches!(
            set_bitrate(&local(port), None, 6000).await,
            Err(ObsError::Bitrate(PROFILE_CHANGED_BITRATE_REASON))
        ));
        assert_eq!(server.await.unwrap().profile_writes.len(), 1);
    }

    #[tokio::test]
    async fn bitrate_reads_fail_closed_on_malformed_mode_bitrate_or_output_status() {
        let cases = [
            Fake {
                profile_name: Some(Value::Null),
                ..Fake::default()
            },
            Fake {
                profile_name: Some(json!(42)),
                ..Fake::default()
            },
            Fake {
                profile_name: Some(json!("")),
                ..Fake::default()
            },
            Fake {
                output_mode: Some("Experimental"),
                ..Fake::default()
            },
            Fake {
                bitrate: Some("6000.5"),
                ..Fake::default()
            },
            Fake {
                bitrate: Some("0"),
                ..Fake::default()
            },
            Fake {
                output_list: Some(json!({"outputs":[{"outputName":"record"}]})),
                ..Fake::default()
            },
            Fake {
                output_list: Some(json!({"outputs":[{"outputActive":true}, {}]})),
                ..Fake::default()
            },
            Fake {
                output_list: Some(json!({})),
                ..Fake::default()
            },
        ];
        for fake in cases {
            let (port, server) = fake_obs(fake).await;
            assert!(matches!(
                set_bitrate(&local(port), None, 6000).await,
                Err(ObsError::Protocol(_))
            ));
            assert!(server.await.unwrap().profile_writes.is_empty());
        }
    }

    #[tokio::test]
    async fn bitrate_write_errors_and_failed_readback_are_reported_without_retry() {
        for ignored in [false, true] {
            let (port, server) = fake_obs(Fake {
                refuse_bitrate_write: !ignored,
                ignore_bitrate_write: ignored,
                ..Fake::default()
            })
            .await;
            let error = set_bitrate(&local(port), None, 6000).await.unwrap_err();
            if ignored {
                assert!(matches!(error, ObsError::Bitrate(_)));
            } else {
                assert!(matches!(error, ObsError::Request { code: 403, .. }));
            }
            assert_eq!(server.await.unwrap().profile_writes.len(), 1);
        }
        // Invalid input is rejected before a socket or any output changes.
        assert!(matches!(
            set_bitrate(&local(1), None, 99).await,
            Err(ObsError::Bitrate(_))
        ));
    }

    #[tokio::test]
    async fn go_live_writes_custom_rtmp_target_and_starts() {
        let (port, server) = fake_obs(Fake {
            password: Some("fictional-password"),
            ..Fake::default()
        })
        .await;
        let outcome = start(&local(port), Some("fictional-password"), &PUSH)
            .await
            .unwrap();
        assert_eq!(outcome, ObsStartOutcome::Started);
        let seen = server.await.unwrap();
        assert_eq!(
            seen.requests,
            [
                "GetStreamStatus",
                "SetStreamServiceSettings",
                "StartStream",
                "GetStreamStatus"
            ]
        );
        let service = seen.service.unwrap();
        assert_eq!(service["streamServiceType"], "rtmp_custom");
        assert_eq!(service["streamServiceSettings"]["server"], PUSH.server);
        assert_eq!(service["streamServiceSettings"]["key"], PUSH.key);
        assert_eq!(service["streamServiceSettings"]["use_auth"], false);
        assert!(!format!("{PUSH:?}").contains("fictional"));
    }

    #[tokio::test]
    async fn an_active_obs_stream_is_left_untouched() {
        let (port, server) = fake_obs(Fake {
            streaming: true,
            ..Fake::default()
        })
        .await;
        let outcome = start(&local(port), None, &PUSH).await.unwrap();
        assert_eq!(outcome, ObsStartOutcome::AlreadyStreaming);
        let seen = server.await.unwrap();
        assert_eq!(seen.requests, ["GetStreamStatus"]);
        assert!(seen.service.is_none());
    }

    #[tokio::test]
    async fn end_stops_and_waits_for_the_output_to_finish() {
        let (port, server) = fake_obs(Fake {
            streaming: true,
            stop_lag: 2,
            ..Fake::default()
        })
        .await;
        assert_eq!(
            stop(&local(port), None).await.unwrap(),
            ObsStopOutcome::Stopped
        );
        let seen = server.await.unwrap();
        assert_eq!(
            seen.requests,
            [
                "GetStreamStatus",
                "StopStream",
                "GetStreamStatus",
                "GetStreamStatus",
                "GetStreamStatus"
            ]
        );

        let (port, server) = fake_obs(Fake::default()).await;
        assert_eq!(
            stop(&local(port), None).await.unwrap(),
            ObsStopOutcome::NotStreaming
        );
        assert_eq!(server.await.unwrap().requests, ["GetStreamStatus"]);
    }

    #[tokio::test]
    async fn password_problems_and_refusals_are_reported_with_codes() {
        let (port, server) = fake_obs(Fake {
            password: Some("right"),
            ..Fake::default()
        })
        .await;
        let error = probe(&local(port), None).await.unwrap_err();
        assert!(matches!(error, ObsError::PasswordRequired), "{error}");
        assert!(error.to_string().ends_with("[DV-OB02]"));
        assert!(!server.await.unwrap().identified);

        let (port, server) = fake_obs(Fake {
            password: Some("right"),
            ..Fake::default()
        })
        .await;
        let error = probe(&local(port), Some("wrong")).await.unwrap_err();
        assert!(matches!(error, ObsError::AuthenticationFailed), "{error}");
        assert!(!server.await.unwrap().identified);

        let (port, server) = fake_obs(Fake {
            refuse_start: true,
            ..Fake::default()
        })
        .await;
        let error = start(&local(port), None, &PUSH).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "OBS 未能开始推流：Failed to start output.（代码 702） [DV-OB05]"
        );
        server.await.unwrap();
    }

    const OVERLAY_URL: &str =
        "http://127.0.0.1:47823/overlay?token=0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn overlay_source_is_created_in_the_current_scene_at_canvas_size() {
        let (port, server) = fake_obs(Fake::default()).await;
        let outcome = put_overlay_source(&local(port), None, OVERLAY_URL, false)
            .await
            .unwrap();
        assert_eq!(
            outcome,
            OverlaySourceOutcome {
                created: true,
                updated: false,
                refreshed: false,
                added_to_scene: true,
                found: true,
                scene: "游戏场景".into(),
                width: 2560,
                height: 1440
            }
        );
        let seen = server.await.unwrap();
        assert_eq!(seen.sources.len(), 1);
        let (kind, data) = &seen.sources[0];
        assert_eq!(kind, "CreateInput");
        assert_eq!(data["sceneName"], "游戏场景");
        assert_eq!(data["inputName"], OVERLAY_SOURCE_NAME);
        assert_eq!(data["inputKind"], "browser_source");
        assert_eq!(data["inputSettings"]["url"], OVERLAY_URL);
        assert_eq!(data["inputSettings"]["width"], 2560);
        assert_eq!(data["inputSettings"]["height"], 1440);
    }

    #[tokio::test]
    async fn an_existing_overlay_source_is_updated_and_added_once() {
        let (port, server) = fake_obs(Fake {
            source_exists: true,
            ..Fake::default()
        })
        .await;
        let outcome = put_overlay_source(&local(port), None, OVERLAY_URL, false)
            .await
            .unwrap();
        assert!(!outcome.created && outcome.added_to_scene && outcome.found);
        let kinds: Vec<_> = server
            .await
            .unwrap()
            .sources
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(kinds, ["SetInputSettings", "CreateSceneItem"]);

        let (port, server) = fake_obs(Fake {
            source_exists: true,
            source_in_scene: true,
            ..Fake::default()
        })
        .await;
        let outcome = put_overlay_source(&local(port), None, OVERLAY_URL, false)
            .await
            .unwrap();
        assert!(!outcome.created && !outcome.added_to_scene);
        let kinds: Vec<_> = server
            .await
            .unwrap()
            .sources
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(kinds, ["SetInputSettings"]);

        // After a new overlay address, only an existing source is touched.
        let (port, server) = fake_obs(Fake::default()).await;
        let outcome = put_overlay_source(&local(port), None, OVERLAY_URL, true)
            .await
            .unwrap();
        assert!(!outcome.found && !outcome.created);
        assert!(server.await.unwrap().sources.is_empty());
    }

    #[tokio::test]
    async fn a_starting_obs_is_waited_for_until_its_websocket_is_ready() {
        // Nothing listens yet, as right after OBS was launched.
        let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        let server = tokio::spawn(async move {
            sleep(Duration::from_millis(1200)).await;
            let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            serve(
                listener,
                Fake {
                    not_ready: 1,
                    connections: 2,
                    ..Fake::default()
                },
            )
            .await
        });
        wait_until_ready(&local(port), None, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(
            server.await.unwrap().requests,
            ["GetStreamStatus", "GetStreamStatus"]
        );

        let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        let error = wait_until_ready(&local(port), None, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(matches!(error, ObsError::NotReady(1)), "{error}");
        assert!(error.to_string().ends_with("[DV-OB10]"));

        // A wrong password is not something waiting can fix.
        let (port, server) = fake_obs(Fake {
            password: Some("right"),
            ..Fake::default()
        })
        .await;
        let error = wait_until_ready(&local(port), Some("wrong"), Duration::from_secs(10))
            .await
            .unwrap_err();
        assert!(matches!(error, ObsError::AuthenticationFailed), "{error}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn overlay_repeat_is_read_only_and_updates_preserve_browser_options() {
        let (port, server) = fake_obs(Fake {
            source_exists: true,
            source_in_scene: true,
            connections: 2,
            source_settings: Some(json!({"url": OVERLAY_URL,"width":2560,"height":1440,
                "shutdown":true,"restart_when_active":true,"css":"custom css"})),
            ..Fake::default()
        })
        .await;
        for _ in 0..2 {
            let outcome = put_overlay_source(&local(port), None, OVERLAY_URL, false)
                .await
                .unwrap();
            assert!(
                outcome.found && !outcome.updated && !outcome.created && !outcome.added_to_scene
            );
        }
        let seen = server.await.unwrap();
        assert!(
            seen.sources.is_empty(),
            "identical add must not reload a browser"
        );
        assert_eq!(
            seen.requests
                .iter()
                .filter(|request| *request == "GetSceneItemEnabled")
                .count(),
            2
        );

        let (port, server) = fake_obs(Fake {
            source_exists: true,
            scene_item_disabled: true,
            ..Fake::default()
        })
        .await;
        assert!(
            put_overlay_source(&local(port), None, OVERLAY_URL, true)
                .await
                .unwrap()
                .updated
        );
        let seen = server.await.unwrap();
        assert_eq!(seen.sources.len(), 1);
        let data = &seen.sources[0].1;
        assert_eq!(seen.sources[0].0, "SetInputSettings");
        assert_eq!(data["overlay"], true);
        assert_eq!(data["inputSettings"].as_object().unwrap().len(), 4);
        assert!(data["inputSettings"].get("shutdown").is_none());
        assert!(data["inputSettings"].get("restart_when_active").is_none());
        assert!(
            !seen
                .requests
                .iter()
                .any(|request| request == "GetSceneItemEnabled")
        );
    }

    #[tokio::test]
    async fn explicit_overlay_add_enables_a_hidden_item_but_recovery_never_does() {
        let (port, server) = fake_obs(Fake {
            source_exists: true,
            source_in_scene: true,
            scene_item_disabled: true,
            connections: 2,
            ..Fake::default()
        })
        .await;
        put_overlay_source(&local(port), None, OVERLAY_URL, false)
            .await
            .unwrap();
        put_overlay_source(&local(port), None, OVERLAY_URL, false)
            .await
            .unwrap();
        let seen = server.await.unwrap();
        let changes: Vec<_> = seen.sources.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(changes, ["SetInputSettings", "SetSceneItemEnabled"]);
        assert_eq!(seen.sources[1].1["sceneItemEnabled"], true);
    }

    #[tokio::test]
    async fn overlay_collision_is_not_overwritten_and_probe_stays_successful() {
        for (kind, address) in [
            ("image_source", OVERLAY_URL),
            ("browser_source", "https://example.org/user-page"),
            (
                "browser_source",
                "http://127.0.0.1:47823/other?token=0123456789abcdef0123456789abcdef",
            ),
            (
                "browser_source",
                "http://127.0.0.1:47823/overlay?token=not-a-managed-token",
            ),
        ] {
            let (port, server) = fake_obs(Fake {
                source_exists: true,
                input_kind: Some(kind),
                source_settings: Some(json!({"url":address})),
                connections: 2,
                ..Fake::default()
            })
            .await;
            for update_only in [true, false] {
                let result =
                    probe_and_put_overlay_source(&local(port), None, OVERLAY_URL, update_only)
                        .await
                        .unwrap();
                assert_eq!(result.probe.obs_version, "31.0.0");
                assert!(matches!(result.overlay, Err(ObsError::OverlayConflict)));
            }
            let seen = server.await.unwrap();
            assert!(seen.sources.is_empty());
            assert!(
                !seen.requests.iter().any(
                    |request| request == "SetStreamServiceSettings" || request == "StartStream"
                )
            );
        }
    }

    #[tokio::test]
    async fn overlay_rejects_remote_obs_and_unmanaged_destination_before_connecting() {
        let settings = ObsSettings {
            host: "192.0.2.1".into(),
            ..ObsSettings::default()
        };
        assert!(matches!(
            put_overlay_source(&settings, None, OVERLAY_URL, false).await,
            Err(ObsError::OverlayRemote)
        ));
        for address in [
            "https://example.org",
            "http://127.0.0.1:4455/overlay?token=bad",
            "http://127.0.0.1:4455/overlay?token=0123456789abcdef0123456789abcdef&token=0123456789abcdef0123456789abcdef",
        ] {
            assert!(matches!(
                put_overlay_source(&local(1), None, address, true).await,
                Err(ObsError::InvalidSettings)
            ));
        }
        assert!(
            !ObsSettings {
                host: "127.example.org".into(),
                ..ObsSettings::default()
            }
            .is_local()
        );
    }

    #[tokio::test]
    async fn disconnected_source_refresh_requires_owned_active_input_and_final_health_check() {
        for (active, healthy_at_last_check, should_refresh) in [
            (true, false, true),
            (false, false, false),
            (true, true, false),
        ] {
            let (port, server) = fake_obs(Fake {
                source_exists: true,
                source_in_scene: true,
                source_active: active,
                source_settings: Some(json!({"url":OVERLAY_URL,"width":2560,"height":1440})),
                ..Fake::default()
            })
            .await;
            let calls = std::cell::Cell::new(0);
            let result = probe_and_recover_overlay_source(
                &local(port),
                None,
                OVERLAY_URL,
                true,
                true,
                || {
                    let count = calls.get();
                    calls.set(count + 1);
                    !(healthy_at_last_check && count > 0)
                },
                || true,
            )
            .await
            .unwrap();
            assert_eq!(result.refresh_attempted, should_refresh);
            assert_eq!(result.overlay.unwrap().refreshed, should_refresh);
            let seen = server.await.unwrap();
            assert_eq!(
                seen.sources
                    .iter()
                    .filter(|(kind, _)| kind == "PressInputPropertiesButton")
                    .count(),
                usize::from(should_refresh)
            );
            assert!(
                !seen
                    .sources
                    .iter()
                    .any(|(kind, _)| kind == "SetInputSettings"
                        || kind == "SetSceneItemEnabled"
                        || kind.starts_with("Create"))
            );
        }
    }

    #[tokio::test]
    async fn refresh_refusal_keeps_transport_success_and_records_an_ambiguous_attempt() {
        let (port, server) = fake_obs(Fake {
            source_exists: true,
            source_active: true,
            refuse_refresh: true,
            source_settings: Some(json!({"url":OVERLAY_URL,"width":2560,"height":1440})),
            ..Fake::default()
        })
        .await;
        let result = probe_and_recover_overlay_source(
            &local(port),
            None,
            OVERLAY_URL,
            true,
            true,
            || true,
            || true,
        )
        .await
        .unwrap();
        assert_eq!(result.probe.obs_version, "31.0.0");
        assert!(result.refresh_attempted);
        assert!(matches!(
            result.overlay,
            Err(ObsError::Request { code: 403, .. })
        ));
        assert_eq!(server.await.unwrap().sources.len(), 1);
    }

    #[tokio::test]
    async fn probe_reports_versions_and_unreachable_obs_is_a_connect_error() {
        let (port, server) = fake_obs(Fake::default()).await;
        let found = probe(&local(port), None).await.unwrap();
        assert_eq!(
            found,
            ObsProbe {
                obs_version: "31.0.0".into(),
                websocket_version: "5.5.2".into(),
                streaming: false
            }
        );
        server.await.unwrap();

        let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = unused.local_addr().unwrap().port();
        drop(unused);
        let error = probe(&local(port), None).await.unwrap_err();
        assert!(matches!(error, ObsError::Connect(_)), "{error}");
        assert!(error.to_string().ends_with("[DV-OB01]"));
        let invalid = ObsSettings {
            host: "ws://x".into(),
            ..local(port)
        };
        assert!(matches!(
            probe(&invalid, None).await.unwrap_err(),
            ObsError::InvalidSettings
        ));
    }

    #[tokio::test]
    async fn superseded_owner_cannot_update_or_reload_a_source_after_reading_it() {
        for identical in [false, true] {
            let (port, server) = fake_obs(Fake {
                source_exists: true,
                source_active: true,
                source_settings: identical
                    .then(|| json!({"url":OVERLAY_URL,"width":2560,"height":1440})),
                ..Fake::default()
            })
            .await;
            let result = probe_and_recover_overlay_source(
                &local(port),
                None,
                OVERLAY_URL,
                true,
                true,
                || true,
                || false,
            )
            .await
            .unwrap();
            assert!(matches!(result.overlay, Err(ObsError::OverlaySuperseded)));
            assert!(!result.refresh_attempted);
            assert!(
                server.await.unwrap().sources.is_empty(),
                "latest-owner check must run immediately before a write"
            );
        }
    }
}
