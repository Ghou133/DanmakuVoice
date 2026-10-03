//! Experimental OBS overlay served to a browser source on this computer only.
//!
//! The page and its event stream listen on 127.0.0.1 and are gated by a random
//! token. Host and Origin checks keep other web pages (including DNS rebinding
//! attempts) from reading chat through the loopback port. The overlay is a
//! display copy: it never changes rules, the playback queue or credentials.

use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::broadcast,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

const PAGE: &str = include_str!("../overlay/overlay.html");
/// Fonts are embedded once with the WebView assets; Tauri stores each
/// `frontendDist` file under its file name.
const FONTS: &[&str] = &[
    "DanmakuVoiceSerifSC-Medium.woff2",
    "DanmakuVoiceSerifSC-Bold.woff2",
    "DanmakuVoiceSerifSC-Black.woff2",
    "InstrumentSerif-Regular.woff2",
    "InstrumentSerif-Italic.woff2",
];
const PORT_ATTEMPTS: u16 = 10;
const MAX_REQUEST_HEAD: usize = 8 * 1024;
const MAX_CLIENTS: usize = 8;
const REPLAY_ITEMS: usize = 12;
const KEEPALIVE: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
font-src 'self'; img-src 'self' https://*.hdslb.com data:; connect-src 'self'; base-uri 'none'; \
form-action 'none'; frame-ancestors 'none'";

/// Reads an embedded WebView asset by its flat `frontendDist` name.
pub type AssetLoader = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

#[derive(Clone, Debug)]
struct Frame {
    event: &'static str,
    data: Arc<str>,
}

impl Frame {
    fn new(event: &'static str, data: &Value) -> Self {
        Self {
            event,
            data: data.to_string().into(),
        }
    }

    fn encode(&self) -> String {
        format!("event: {}\ndata: {}\n\n", self.event, self.data)
    }
}

/// Browser-source size reported by a connected page.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ClientSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
struct HubState {
    token: String,
    config: Value,
    status: Value,
    reading: Value,
    items: VecDeque<Value>,
    seq: u64,
    clients: BTreeMap<u64, ClientSize>,
    next_client: u64,
}

/// Shared state between the application feed and every connected page.
pub struct OverlayHub {
    state: Mutex<HubState>,
    frames: broadcast::Sender<Frame>,
    /// Pages reset their message numbering when the app restarts.
    instance: String,
}

impl OverlayHub {
    pub fn new() -> Arc<Self> {
        let (frames, _) = broadcast::channel(256);
        Arc::new(Self {
            state: Mutex::new(HubState {
                config: json!({}),
                status: json!({}),
                reading: Value::Null,
                ..HubState::default()
            }),
            frames,
            instance: uuid::Uuid::new_v4().simple().to_string(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn send(&self, frame: Frame) {
        // No receivers is normal while OBS is closed.
        let _ = self.frames.send(frame);
    }

    /// A changed token disconnects pages opened with the previous address.
    pub fn set_token(&self, token: &str) {
        let mut state = self.lock();
        if state.token == token {
            return;
        }
        let had_token = !state.token.is_empty();
        state.token = token.to_owned();
        drop(state);
        if had_token {
            self.send(Frame::new("reset", &json!({})));
        }
    }

    pub fn set_config(&self, config: Value) {
        let mut state = self.lock();
        if state.config == config {
            return;
        }
        state.config = config.clone();
        drop(state);
        self.send(Frame::new("config", &config));
    }

    pub fn set_status(&self, status: Value) {
        let mut state = self.lock();
        if state.status == status {
            return;
        }
        state.status = status.clone();
        drop(state);
        self.send(Frame::new("status", &status));
    }

    pub fn set_reading(&self, reading: Value) {
        let mut state = self.lock();
        if state.reading == reading {
            return;
        }
        state.reading = reading.clone();
        drop(state);
        self.send(Frame::new("reading", &reading));
    }

    /// Items carry an increasing `seq` so a page can match reading updates
    /// and ignore duplicates after a reconnect.
    pub fn publish_item(&self, mut item: Value) {
        let mut state = self.lock();
        state.seq += 1;
        item["seq"] = json!(state.seq);
        if state.items.len() == REPLAY_ITEMS {
            state.items.pop_front();
        }
        state.items.push_back(item.clone());
        drop(state);
        self.send(Frame::new("item", &item));
    }

    /// A new live session starts with an empty overlay.
    pub fn clear_items(&self) {
        let mut state = self.lock();
        if state.items.is_empty() {
            return;
        }
        state.items.clear();
        drop(state);
        self.send(Frame::new("clear", &json!({})));
    }

    pub fn clients(&self) -> Vec<ClientSize> {
        self.lock().clients.values().copied().collect()
    }

    pub fn has_clients(&self) -> bool {
        !self.lock().clients.is_empty()
    }

    fn token_matches(&self, candidate: &str) -> bool {
        let state = self.lock();
        let expected = state.token.as_bytes();
        let candidate = candidate.as_bytes();
        if expected.is_empty() || expected.len() != candidate.len() {
            return false;
        }
        expected
            .iter()
            .zip(candidate)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    }

    fn hello(&self) -> Frame {
        let state = self.lock();
        Frame::new(
            "hello",
            &json!({
                "instance": self.instance,
                "config": state.config,
                "status": state.status,
                "reading": state.reading,
                "items": state.items,
            }),
        )
    }

    fn register(&self, size: ClientSize) -> Option<u64> {
        let mut state = self.lock();
        if state.clients.len() >= MAX_CLIENTS {
            return None;
        }
        state.next_client += 1;
        let id = state.next_client;
        state.clients.insert(id, size);
        Some(id)
    }

    fn unregister(&self, id: u64) {
        self.lock().clients.remove(&id);
    }
}

struct ClientGuard {
    hub: Arc<OverlayHub>,
    id: u64,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.hub.unregister(self.id);
    }
}

/// A running loopback listener. Dropping it stops accepting and closes the
/// event streams it served.
pub struct OverlayServer {
    cancel: CancellationToken,
    port: u16,
}

impl Drop for OverlayServer {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl OverlayServer {
    /// Try the saved port first, then the next few, so an OBS scene keeps the
    /// same address unless another program took it. `0` asks the OS (tests).
    pub async fn bind(
        preferred: u16,
        hub: Arc<OverlayHub>,
        assets: AssetLoader,
    ) -> Result<Self, String> {
        let attempts = if preferred == 0 { 1 } else { PORT_ATTEMPTS };
        let mut last_error = None;
        for offset in 0..attempts {
            let Some(port) = preferred.checked_add(offset) else {
                break;
            };
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => {
                    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                    return Ok(Self::serve(listener, port, hub, assets));
                }
                Err(error) => last_error = Some(error),
            }
        }
        let reason = last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "端口无效".into());
        Err(format!(
            "OBS 叠加层无法使用本机端口 {preferred} 起的 {attempts} 个端口：{reason} [DV-O01]"
        ))
    }

    fn serve(listener: TcpListener, port: u16, hub: Arc<OverlayHub>, assets: AssetLoader) -> Self {
        let cancel = CancellationToken::new();
        let accept_cancel = cancel.clone();
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = accept_cancel.cancelled() => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, _)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                let hub = hub.clone();
                let assets = assets.clone();
                let cancel = accept_cancel.clone();
                tokio::spawn(async move {
                    handle(stream, port, hub, assets, cancel).await;
                });
            }
        });
        Self { cancel, port }
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

#[derive(Debug, Default, PartialEq)]
struct Request {
    method: String,
    path: String,
    query: BTreeMap<String, String>,
    host: Option<String>,
    origin: Option<String>,
}

impl Request {
    fn parse(head: &str) -> Option<Self> {
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split(' ');
        let method = first.next()?.to_owned();
        let target = first.next()?;
        if !first.next()?.starts_with("HTTP/1.") || !target.starts_with('/') {
            return None;
        }
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let query = query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                (key.to_owned(), value.to_owned())
            })
            .collect();
        let mut request = Self {
            method,
            path: path.to_owned(),
            query,
            ..Self::default()
        };
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim().to_owned();
            if name.eq_ignore_ascii_case("host") {
                request.host = Some(value);
            } else if name.eq_ignore_ascii_case("origin") {
                request.origin = Some(value);
            }
        }
        Some(request)
    }

    fn size(&self) -> ClientSize {
        let read = |key: &str, fallback: u32| {
            self.query
                .get(key)
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| (1..=16_384).contains(value))
                .unwrap_or(fallback)
        };
        ClientSize {
            width: read("w", 1920),
            height: read("h", 1080),
        }
    }
}

enum Route {
    Respond {
        status: &'static str,
        content_type: &'static str,
        body: Vec<u8>,
        cache: &'static str,
    },
    Events(ClientSize),
}

fn text(status: &'static str, message: &str) -> Route {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>超绝可爱弹幕姬</title>\
         <body style=\"margin:0;font:16px sans-serif;color:#fff;background:transparent\">\
         <p style=\"margin:24px;padding:12px 16px;background:rgba(20,18,28,.8);border-radius:10px;display:inline-block\">{message}</p>"
    );
    Route::Respond {
        status,
        content_type: "text/html; charset=utf-8",
        body: body.into_bytes(),
        cache: "no-store",
    }
}

fn route(request: &Request, port: u16, hub: &OverlayHub, assets: &AssetLoader) -> Route {
    if request.method != "GET" {
        return text("405 Method Not Allowed", "只支持 GET");
    }
    let local = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let host_ok = request
        .host
        .as_deref()
        .is_some_and(|host| local.iter().any(|item| item.eq_ignore_ascii_case(host)));
    let origin_ok = request.origin.as_deref().is_none_or(|origin| {
        local
            .iter()
            .any(|item| origin.eq_ignore_ascii_case(&format!("http://{item}")))
    });
    if !host_ok || !origin_ok {
        return text("403 Forbidden", "只允许本机 OBS 直接打开");
    }
    let token_ok = request
        .query
        .get("token")
        .is_some_and(|token| hub.token_matches(token));
    match request.path.as_str() {
        "/overlay" if token_ok => Route::Respond {
            status: "200 OK",
            content_type: "text/html; charset=utf-8",
            body: PAGE.as_bytes().to_vec(),
            cache: "no-store",
        },
        "/overlay/events" if token_ok => Route::Events(request.size()),
        "/overlay" | "/overlay/events" => text(
            "403 Forbidden",
            "叠加层地址已失效，请在弹幕姬“设置 → OBS 叠加层”中复制新地址。",
        ),
        "/favicon.ico" => Route::Respond {
            status: "204 No Content",
            content_type: "text/plain",
            body: Vec::new(),
            cache: "max-age=86400",
        },
        path => match path.strip_prefix("/overlay/fonts/") {
            // Tauri answers unknown asset names with index.html, so only real
            // WOFF2 data is served as a font.
            Some(name) if FONTS.contains(&name) => match assets(name) {
                Some(body) if body.starts_with(b"wOF2") => Route::Respond {
                    status: "200 OK",
                    content_type: "font/woff2",
                    body,
                    cache: "max-age=86400",
                },
                _ => text("404 Not Found", "字体不可用"),
            },
            _ => text("404 Not Found", "页面不存在"),
        },
    }
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            buffer.truncate(end);
            return Ok(String::from_utf8(buffer).ok());
        }
        if buffer.len() > MAX_REQUEST_HEAD {
            return Ok(None);
        }
    }
}

fn response_head(status: &str, content_type: &str, length: Option<usize>, cache: &str) -> String {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nCache-Control: {cache}\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: {PAGE_CSP}\r\n"
    );
    match length {
        Some(length) => head.push_str(&format!(
            "Content-Length: {length}\r\nConnection: close\r\n"
        )),
        None => head.push_str("Connection: keep-alive\r\n"),
    }
    head.push_str("\r\n");
    head
}

async fn handle(
    mut stream: TcpStream,
    port: u16,
    hub: Arc<OverlayHub>,
    assets: AssetLoader,
    cancel: CancellationToken,
) {
    let Ok(Ok(Some(head))) = timeout(Duration::from_secs(5), read_head(&mut stream)).await else {
        return;
    };
    let Some(request) = Request::parse(&head) else {
        let head = response_head("400 Bad Request", "text/plain", Some(0), "no-store");
        let _ = timeout(WRITE_TIMEOUT, stream.write_all(head.as_bytes())).await;
        return;
    };
    match route(&request, port, &hub, &assets) {
        Route::Respond {
            status,
            content_type,
            body,
            cache,
        } => {
            let head = response_head(status, content_type, Some(body.len()), cache);
            let _ = timeout(WRITE_TIMEOUT, async {
                stream.write_all(head.as_bytes()).await?;
                stream.write_all(&body).await?;
                stream.shutdown().await
            })
            .await;
        }
        Route::Events(size) => stream_events(stream, hub, size, cancel).await,
    }
}

async fn write_frame(writer: &mut tokio::net::tcp::OwnedWriteHalf, data: &str) -> Result<(), ()> {
    match timeout(WRITE_TIMEOUT, writer.write_all(data.as_bytes())).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

async fn stream_events(
    stream: TcpStream,
    hub: Arc<OverlayHub>,
    size: ClientSize,
    cancel: CancellationToken,
) {
    // Subscribe before taking the hello snapshot so no update falls between.
    let mut frames = hub.frames.subscribe();
    let (mut reader, mut writer) = stream.into_split();
    let Some(id) = hub.register(size) else {
        let head = response_head("503 Service Unavailable", "text/plain", Some(0), "no-store");
        let _ = write_frame(&mut writer, &head).await;
        return;
    };
    let _guard = ClientGuard {
        hub: hub.clone(),
        id,
    };
    let head = response_head(
        "200 OK",
        "text/event-stream; charset=utf-8",
        None,
        "no-store",
    );
    let opening = format!("{head}retry: 2000\n\n{}", hub.hello().encode());
    if write_frame(&mut writer, &opening).await.is_err() {
        return;
    }
    let mut discard = [0u8; 256];
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => break,
            read = reader.read(&mut discard) => match read {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            },
            frame = frames.recv() => match frame {
                Ok(frame) => {
                    let reset = frame.event == "reset";
                    if write_frame(&mut writer, &frame.encode()).await.is_err() || reset {
                        break;
                    }
                    continue;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => hub.hello().encode(),
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = tokio::time::sleep(KEEPALIVE) => ": ping\n\n".to_owned(),
        };
        if write_frame(&mut writer, &next).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    fn assets() -> AssetLoader {
        Arc::new(|name: &str| match name {
            "InstrumentSerif-Regular.woff2" => Some(b"wOF2".to_vec()),
            // Tauri's fallback for a missing asset is the app page itself.
            _ => Some(b"<!doctype html>".to_vec()),
        })
    }

    async fn server() -> (OverlayServer, Arc<OverlayHub>) {
        let hub = OverlayHub::new();
        hub.set_token("0123456789abcdef0123456789abcdef");
        let server = OverlayServer::bind(0, hub.clone(), assets()).await.unwrap();
        (server, hub)
    }

    async fn get(port: u16, target: &str, extra: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    #[test]
    fn requests_parse_paths_queries_and_security_headers() {
        let request = Request::parse(
            "GET /overlay/events?token=abc&w=3840&h=1728 HTTP/1.1\r\nHOST: localhost:9\r\nOrigin: http://localhost:9",
        )
        .unwrap();
        assert_eq!(request.path, "/overlay/events");
        assert_eq!(request.query["token"], "abc");
        assert_eq!(request.host.as_deref(), Some("localhost:9"));
        assert_eq!(request.origin.as_deref(), Some("http://localhost:9"));
        assert_eq!(
            request.size(),
            ClientSize {
                width: 3840,
                height: 1728
            }
        );
        let odd = Request::parse("GET /x?w=0&h=99999 HTTP/1.1").unwrap();
        assert_eq!(
            odd.size(),
            ClientSize {
                width: 1920,
                height: 1080
            }
        );
        assert!(Request::parse("GET overlay HTTP/1.1").is_none());
        assert!(Request::parse("garbage").is_none());
    }

    #[tokio::test]
    async fn page_requires_token_loopback_host_and_same_origin() {
        let (server, _hub) = server().await;
        let port = server.port();
        let ok = get(port, "/overlay?token=0123456789abcdef0123456789abcdef", "").await;
        assert!(ok.starts_with("HTTP/1.1 200 OK"));
        assert!(ok.contains("Content-Security-Policy: default-src 'none'"));
        assert!(ok.contains("<!doctype html>"));
        let wrong = get(port, "/overlay?token=0123456789abcdef0123456789abcdee", "").await;
        assert!(wrong.starts_with("HTTP/1.1 403"));
        assert!(!wrong.contains("EventSource"));
        let missing = get(port, "/overlay", "").await;
        assert!(missing.starts_with("HTTP/1.1 403"));
        // A rebinding page reaches the port under a foreign host name.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                b"GET /overlay?token=0123456789abcdef0123456789abcdef HTTP/1.1\r\nHost: evil.example\r\n\r\n",
            )
            .await
            .unwrap();
        let mut rebinding = String::new();
        stream.read_to_string(&mut rebinding).await.unwrap();
        assert!(rebinding.starts_with("HTTP/1.1 403"));
        let cross = get(
            port,
            "/overlay/events?token=0123456789abcdef0123456789abcdef",
            "Origin: https://evil.example\r\n",
        )
        .await;
        assert!(cross.starts_with("HTTP/1.1 403"));
        let font = get(port, "/overlay/fonts/InstrumentSerif-Regular.woff2", "").await;
        assert!(font.starts_with("HTTP/1.1 200 OK") && font.ends_with("wOF2"));
        let missing = get(port, "/overlay/fonts/InstrumentSerif-Italic.woff2", "").await;
        assert!(missing.starts_with("HTTP/1.1 404") && missing.contains("字体不可用"));
        let traversal = get(port, "/overlay/fonts/../app.js", "").await;
        assert!(traversal.starts_with("HTTP/1.1 404"));
        let post = {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream
                .write_all(
                    format!("POST /overlay HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
                )
                .await
                .unwrap();
            let mut text = String::new();
            stream.read_to_string(&mut text).await.unwrap();
            text
        };
        assert!(post.starts_with("HTTP/1.1 405"));
    }

    #[tokio::test]
    async fn events_replay_state_stream_updates_and_track_clients() {
        let (server, hub) = server().await;
        let port = server.port();
        hub.set_config(json!({"style":"spine"}));
        hub.publish_item(json!({"kind":"danmaku","message":"早"}));
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (read, mut write) = stream.into_split();
        write
            .write_all(
                format!(
                    "GET /overlay/events?token=0123456789abcdef0123456789abcdef&w=2560&h=1600 HTTP/1.1\r\nHost: localhost:{port}\r\nOrigin: http://localhost:{port}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut lines = tokio::io::BufReader::new(read).lines();
        let mut next_data = async || loop {
            let line = timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if let Some(data) = line.strip_prefix("data: ") {
                return serde_json::from_str::<Value>(data).unwrap();
            }
        };
        let hello = next_data().await;
        assert_eq!(hello["config"]["style"], "spine");
        assert_eq!(hello["items"][0]["message"], "早");
        assert_eq!(hello["items"][0]["seq"], 1);
        assert_eq!(
            hub.clients(),
            vec![ClientSize {
                width: 2560,
                height: 1600
            }]
        );
        hub.publish_item(json!({"kind":"danmaku","message":"晚上好"}));
        let item = next_data().await;
        assert_eq!(item["message"], "晚上好");
        assert_eq!(item["seq"], 2);
        hub.set_status(json!({"connection":"connected"}));
        hub.set_status(json!({"connection":"connected"}));
        hub.set_reading(json!({"job_id":4,"played_ms":120}));
        assert_eq!(next_data().await["connection"], "connected");
        assert_eq!(next_data().await["job_id"], 4);
        // A new token closes pages opened with the old address.
        hub.set_token("ffffffffffffffffffffffffffffffff");
        assert_eq!(next_data().await, json!({}));
        timeout(Duration::from_secs(5), async {
            while hub.has_clients() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        drop(write);
    }

    #[tokio::test]
    async fn closing_the_page_releases_its_client_slot() {
        let (server, hub) = server().await;
        let port = server.port();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /overlay/events?token=0123456789abcdef0123456789abcdef HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut first = [0u8; 64];
        let _ = stream.read(&mut first).await.unwrap();
        assert!(hub.has_clients());
        drop(stream);
        timeout(Duration::from_secs(5), async {
            while hub.has_clients() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        drop(server);
    }
}
