//! Optional local TTS process ownership. A configured directory is only used
//! for the default local voice; existing servers are probed and never adopted.

#[cfg(windows)]
use danmakuvoice_engine::owned_process::OwnedChild as Child;
use serde::Serialize;
#[cfg(not(windows))]
use std::process::Child;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    time::timeout,
};
use url::Url;

const DOTS_VOICE_SHIM: &str = include_str!("../python/dots_voice_shim.py");
const DOTS_CAPABILITY_VERSION: &str = "danmakuvoice-dots-paths-v1";
const LOCAL_SERVICE_LOG_LIMIT: usize = 128 * 1024;
const LOCAL_SERVICE_LOG_FILES: usize = 5;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Dots,
    GptSovits,
}

impl Kind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "dots" => Ok(Self::Dots),
            "gpt_sovits" => Ok(Self::GptSovits),
            _ => Err("只支持 dots.tts 或 GPT-SoVITS 本地服务".into()),
        }
    }

    fn health_route(self) -> &'static str {
        match self {
            Self::Dots => "health",
            Self::GptSovits => "openapi.json",
        }
    }
}

#[derive(Serialize)]
pub struct ServiceView<'a> {
    pub directory: Option<&'a Path>,
    pub endpoint: Option<&'a str>,
    pub state: &'static str,
    pub message: String,
    pub owned: bool,
    pub manual_stopped: bool,
}

pub struct ServiceState {
    pub directory: Option<PathBuf>,
    pub state: &'static str,
    pub message: String,
    process: Option<OwnedProcess>,
    owned_port: Option<u16>,
    pub generation: u64,
    pub observation: u64,
    pub endpoint: Option<String>,
    manual_stopped: bool,
}

impl ServiceState {
    pub fn new(directory: Option<PathBuf>) -> Self {
        let configured = directory.is_some();
        Self {
            directory,
            state: if configured {
                "unknown"
            } else {
                "unconfigured"
            },
            message: if configured {
                "尚未检查本地服务".into()
            } else {
                "尚未配置本地服务目录".into()
            },
            process: None,
            owned_port: None,
            generation: 0,
            observation: 0,
            endpoint: None,
            manual_stopped: false,
        }
    }

    pub fn view(&self) -> ServiceView<'_> {
        ServiceView {
            directory: self.directory.as_deref(),
            endpoint: self.endpoint.as_deref(),
            state: self.state,
            message: if self.state == "failed" {
                danmakuvoice_engine::error_codes::tag(&self.message, "DV-L01")
            } else {
                self.message.clone()
            },
            owned: self.process.is_some(),
            manual_stopped: self.manual_stopped,
        }
    }

    pub fn set(&mut self, state: &'static str, message: &'static str) {
        self.state = state;
        self.message = message.into();
    }

    /// Invalidate observations without adopting or stopping an external server.
    pub fn observe_endpoint(&mut self, endpoint: &str) {
        if self.endpoint.as_deref() != Some(endpoint) {
            self.endpoint = Some(endpoint.to_owned());
            self.generation = self.generation.wrapping_add(1);
            self.set("unknown", "服务地址已更新，尚未检查服务");
        }
    }

    pub fn stop_owned(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.process = None;
        self.owned_port = None;
        self.set("stopped", "本应用启动的服务已停止");
    }

    pub fn stop_manual(&mut self) {
        self.manual_stopped = true;
        self.stop_owned();
        self.set("stopped", "本次会话已暂停自动启动；外部服务不会被停止");
    }

    pub fn start_manual(&mut self) {
        self.manual_stopped = false;
        self.generation = self.generation.wrapping_add(1);
        self.set("checking", "正在检查本地服务");
    }

    pub fn resume_auto_start(&mut self) {
        self.manual_stopped = false;
        self.generation = self.generation.wrapping_add(1);
        self.set("checking", "正在检查本地服务");
    }

    pub fn auto_start_allowed(&self) -> bool {
        !self.manual_stopped
    }

    pub fn process_exited(&mut self) -> bool {
        if self.process.as_mut().is_some_and(OwnedProcess::exited) {
            self.process = None;
            self.owned_port = None;
            self.set("failed", "本地服务进程已退出，请检查安装目录");
            true
        } else {
            false
        }
    }

    pub fn switch_endpoint(&mut self, port: u16) {
        self.process_exited();
        if self.process.is_some() && self.owned_port != Some(port) {
            // Each provider owns at most one model process. Never report the
            // old listener as the selected voice's newly configured port.
            self.stop_owned();
        }
    }

    pub fn launch(
        &mut self,
        kind: Kind,
        endpoint: &Endpoint,
        app_data_dir: &Path,
    ) -> Result<(), String> {
        // A service can exit between status polls. An explicit start must not
        // mistake its stale process handle for a running service.
        self.switch_endpoint(endpoint.port);
        if self.process.is_some() {
            return Ok(());
        }
        let directory = self.directory.as_deref().ok_or("请先设置本地 TTS 目录")?;
        self.process = Some(OwnedProcess::launch(
            kind,
            directory,
            endpoint.port,
            app_data_dir,
        )?);
        self.owned_port = Some(endpoint.port);
        self.set("starting", "服务正在加载模型");
        Ok(())
    }
}

pub struct LocalServices {
    pub dots: ServiceState,
    pub gpt_sovits: ServiceState,
}

impl LocalServices {
    pub fn new(dots: Option<PathBuf>, gpt_sovits: Option<PathBuf>) -> Self {
        Self {
            dots: ServiceState::new(dots),
            gpt_sovits: ServiceState::new(gpt_sovits),
        }
    }

    pub fn get_mut(&mut self, kind: Kind) -> &mut ServiceState {
        match kind {
            Kind::Dots => &mut self.dots,
            Kind::GptSovits => &mut self.gpt_sovits,
        }
    }

    pub fn stop_owned(&mut self) {
        self.dots.stop_owned();
        self.gpt_sovits.stop_owned();
    }
}

pub struct Endpoint {
    base: Url,
    host: String,
    pub port: u16,
}

impl Endpoint {
    pub fn parse(kind: Kind, value: &str) -> Result<Self, String> {
        let mut url = Url::parse(value).map_err(|_| "本地服务地址无效")?;
        let host = url.host_str().ok_or("本地服务地址无效")?;
        if url.scheme() != "http"
            || !matches!(host, "127.0.0.1" | "localhost")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("自动启动仅支持无凭据的本机 HTTP 地址".into());
        }
        let path = url.path().trim_end_matches('/');
        let valid_path = match kind {
            Kind::Dots => matches!(path, "" | "/tts" | "/tts/stream"),
            Kind::GptSovits => matches!(path, "" | "/tts" | "/kinoko/tts"),
        };
        if !valid_path {
            return Err("本地服务地址路径无效".into());
        }
        let port = url.port_or_known_default().ok_or("本地服务端口无效")?;
        let host = host.to_owned();
        url.set_path("/");
        Ok(Self {
            base: url,
            host,
            port,
        })
    }

    fn health_url(&self, kind: Kind) -> Url {
        self.base.join(kind.health_route()).expect("fixed route")
    }

    fn dots_capability_url(&self) -> Url {
        self.base
            .join("danmakuvoice/capabilities")
            .expect("fixed route")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Health {
    Ready,
    Offline,
    Unready,
    LegacyDots,
    Foreign,
    Timeout,
}

/// A short, read-only check that never sends text or credentials. A listener
/// with an unknown response is occupied: it must not trigger another server.
pub async fn probe(kind: Kind, endpoint: &Endpoint) -> Health {
    match timeout(
        Duration::from_millis(800),
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    {
        Ok(Ok(_)) => {}
        _ => {
            // On some Windows network stacks an unused loopback port times
            // out instead of refusing. A temporary bind distinguishes that
            // from a listener we must leave untouched.
            return if TcpListener::bind(("127.0.0.1", endpoint.port))
                .await
                .is_ok()
            {
                Health::Offline
            } else {
                Health::Foreign
            };
        }
    }
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return Health::Foreign;
    };
    if kind == Kind::GptSovits {
        return match tokio::time::timeout(
            Duration::from_millis(1_500),
            danmakuvoice_engine::tts::sovits::service_status(
                &client,
                endpoint.base.as_str(),
                &tokio_util::sync::CancellationToken::new(),
            ),
        )
        .await
        {
            Ok(Ok(_)) => Health::Ready,
            Ok(Err(danmakuvoice_engine::tts::TtsError::HttpStatus { status: 503, .. })) => {
                Health::Unready
            }
            Err(_) => Health::Timeout,
            _ => Health::Foreign,
        };
    }
    let Ok(response) = client.get(endpoint.health_url(kind)).send().await else {
        return Health::Foreign;
    };
    let status = response.status();
    if !status.is_success()
        && !(kind == Kind::Dots && status == reqwest::StatusCode::SERVICE_UNAVAILABLE)
    {
        return Health::Foreign;
    }
    let Some(value) = limited_json(response).await else {
        return Health::Foreign;
    };
    match kind {
        Kind::Dots => {
            let Some(ready) = value.get("ready").and_then(serde_json::Value::as_bool) else {
                return Health::Foreign;
            };
            let old_dots_shape = value
                .get("model_loaded")
                .and_then(serde_json::Value::as_bool)
                .is_some()
                && value
                    .get("stream_requests")
                    .and_then(serde_json::Value::as_u64)
                    .is_some();
            let capability = match client.get(endpoint.dots_capability_url()).send().await {
                Ok(response) if response.status().is_success() => limited_json(response).await,
                _ => None,
            };
            let supported = capability.as_ref().is_some_and(|capability| {
                capability
                    .get("protocol")
                    .and_then(serde_json::Value::as_str)
                    == Some(DOTS_CAPABILITY_VERSION)
                    && capability
                        .get("arbitrary_voice_paths")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                    && capability
                        .get("reference_text_explicit")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
            });
            if !supported {
                return if old_dots_shape {
                    Health::LegacyDots
                } else {
                    Health::Foreign
                };
            }
            if ready && status.is_success() {
                Health::Ready
            } else {
                Health::Unready
            }
        }
        Kind::GptSovits => unreachable!("GPT-SoVITS uses the shared engine inspection"),
    }
}

async fn limited_json(mut response: reqwest::Response) -> Option<serde_json::Value> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 256 * 1024 => {
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            _ => return None,
        }
    }
    serde_json::from_slice(&body).ok()
}

struct LaunchSpec {
    executable: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
}

fn launch_spec(kind: Kind, directory: &Path, port: u16) -> Result<LaunchSpec, String> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("请选择存在的本地 TTS 安装目录".into());
    }
    let root = process_path(
        directory
            .canonicalize()
            .map_err(|_| "本地 TTS 安装目录无法访问")?,
    )?;
    let (executable, args) = match kind {
        Kind::Dots => {
            let reference_dir = dots_reference_dir(&root)?;
            let executable = root.join(".venv/Scripts/python.exe");
            let server = root
                .parent()
                .ok_or("dots.tts 目录结构不完整")?
                .join("serve_api.py");
            if !root.join("start_api_2p.bat").is_file()
                || !root.join("pretrained_models/dots.tts-2p").is_dir()
                || !server.is_file()
                || !executable.is_file()
            {
                return Err("dots.tts 目录缺少 2p 模型、启动入口或 Python 环境".into());
            }
            (
                executable,
                vec![
                    "-B".into(),
                    "-u".into(),
                    "-c".into(),
                    DOTS_VOICE_SHIM.into(),
                    server.to_string_lossy().into_owned(),
                    "--model".into(),
                    "pretrained_models/dots.tts-2p".into(),
                    "--num-steps".into(),
                    "10".into(),
                    "--host".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    port.to_string(),
                    "--ref-dir".into(),
                    reference_dir.to_string_lossy().into_owned(),
                    "--no-auto-voice".into(),
                    "--language".into(),
                    "zh".into(),
                    "--normalize-text".into(),
                    "--optimize".into(),
                ],
            )
        }
        Kind::GptSovits => {
            let executable = root.join("runtime/python.exe");
            if !root.join("api_v2.py").is_file() || !executable.is_file() {
                return Err("GPT-SoVITS 目录缺少 api_v2.py 或 runtime/python.exe".into());
            }
            let extension = root.join("kinoko_sovits_api.py");
            let custom_config = root.join("kinoko-tts-infer.yaml");
            let (server, config) = if extension.is_file() && custom_config.is_file() {
                (extension, custom_config)
            } else {
                (
                    root.join("api_v2.py"),
                    root.join("GPT_SoVITS/configs/tts_infer.yaml"),
                )
            };
            if !config.is_file() {
                return Err("GPT-SoVITS 目录缺少推理配置文件".into());
            }
            (
                executable,
                vec![
                    "-B".into(),
                    "-u".into(),
                    "-s".into(),
                    server.to_string_lossy().into_owned(),
                    "-a".into(),
                    "127.0.0.1".into(),
                    "-p".into(),
                    port.to_string(),
                    "-c".into(),
                    config.to_string_lossy().into_owned(),
                ],
            )
        }
    };
    Ok(LaunchSpec {
        executable,
        cwd: root,
        args,
    })
}

pub fn validate_directory(kind: Kind, directory: &Path) -> Result<PathBuf, String> {
    Ok(launch_spec(kind, directory, 9881)?.cwd)
}

fn dots_reference_dir(root: &Path) -> Result<PathBuf, String> {
    let parent = root.parent().ok_or("dots.tts 目录结构不完整")?;
    let candidate = parent.join("myvoice");
    let metadata = match std::fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
        Err(_) => return Err("dots.tts 的 myvoice 目录无法访问".into()),
    };
    let mut redirected = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        redirected |= metadata.file_attributes() & 0x400 != 0;
    }
    if redirected || !metadata.is_dir() {
        return Err("dots.tts 的 myvoice 目录不能是链接或文件".into());
    }
    let resolved = process_path(
        candidate
            .canonicalize()
            .map_err(|_| "dots.tts 的 myvoice 目录无法访问")?,
    )?;
    if resolved.parent() != Some(parent) {
        return Err("dots.tts 的 myvoice 目录不在安装目录同级".into());
    }
    Ok(resolved)
}

/// Windows canonicalization adds a `\\?\` device prefix. The upstream
/// GPT-SoVITS i18n module calls `os.path.relpath(__file__)`, which treats that
/// spelling and an ordinary drive path as different mounts. Keep the
/// resolved target while passing a normal path spelling to Python.
fn process_path(path: PathBuf) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let value = path.to_str().ok_or("本地 TTS 目录路径无效")?;
        let normalized = if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{rest}")
        } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
            if rest.as_bytes().get(1) != Some(&b':') {
                return Err("本地 TTS 目录使用了不支持的设备路径".into());
            }
            rest.to_owned()
        } else {
            return Ok(path);
        };
        if normalized.encode_utf16().count() >= 240 {
            return Err("本地 TTS 目录路径过长".into());
        }
        Ok(PathBuf::from(normalized))
    }
    #[cfg(not(windows))]
    {
        Ok(path)
    }
}

struct OwnedProcess {
    child: Child,
}

impl OwnedProcess {
    fn launch(
        kind: Kind,
        directory: &Path,
        port: u16,
        app_data_dir: &Path,
    ) -> Result<Self, String> {
        let spec = launch_spec(kind, directory, port)?;
        if !app_data_dir.is_absolute() || !app_data_dir.is_dir() {
            return Err("应用数据目录无效".into());
        }
        let stderr_log = create_service_log(app_data_dir, kind)?;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        match kind {
            Kind::Dots => {
                let cache = app_data_dir.join("cache/dots");
                let inductor = cache.join("inductor");
                let triton = cache.join("triton");
                std::fs::create_dir_all(&inductor)
                    .and_then(|()| std::fs::create_dir_all(&triton))
                    .map_err(|_| "无法创建 dots.tts 应用缓存目录")?;
                command
                    .env_remove("HTTP_PROXY")
                    .env_remove("HTTPS_PROXY")
                    .env_remove("http_proxy")
                    .env_remove("https_proxy")
                    .env("NO_PROXY", "127.0.0.1,localhost")
                    .env("PYTHONIOENCODING", "utf-8")
                    .env("PYTHONUNBUFFERED", "1")
                    .env("TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER", "0")
                    .env("TORCHINDUCTOR_CACHE_DIR", inductor)
                    .env("TRITON_CACHE_DIR", triton)
                    .env("DOTS_TTS_LOW_VRAM", "1");
            }
            Kind::GptSovits => {
                let mut paths = vec![spec.cwd.join("runtime"), spec.cwd.clone()];
                if let Some(path) = std::env::var_os("PATH") {
                    paths.extend(std::env::split_paths(&path));
                }
                command
                    .env(
                        "PATH",
                        std::env::join_paths(paths).map_err(|_| "服务环境路径无效")?,
                    )
                    .env("PYTHONIOENCODING", "utf-8")
                    .env("NO_PROXY", "127.0.0.1,localhost,::1");
            }
        }
        #[cfg(windows)]
        {
            Self::spawn_owned(command, stderr_log)
        }
        #[cfg(not(windows))]
        {
            let _ = command;
            let _ = stderr_log;
            Err("本地服务自动启动仅支持 Windows".into())
        }
    }

    #[cfg(windows)]
    fn spawn_owned(command: Command, stderr_log: File) -> Result<Self, String> {
        let mut child = Child::spawn(&command, false, false, true)
            .map_err(|error| format!("无法安全启动本地 TTS 服务：{error}"))?;
        start_stderr_capture(&mut child, stderr_log)?;
        Ok(Self { child })
    }

    fn exited(&mut self) -> bool {
        self.child.try_wait().is_ok_and(|status| status.is_some())
    }
}

fn create_service_log(app_data_dir: &Path, kind: Kind) -> Result<File, String> {
    let log_dir = app_data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|_| "无法创建本地服务诊断目录")?;
    let metadata = std::fs::symlink_metadata(&log_dir).map_err(|_| "无法读取本地服务诊断目录")?;
    if !metadata.is_dir() || redirected(&metadata) {
        return Err("本地服务诊断目录不能是链接或特殊文件".into());
    }
    let provider = match kind {
        Kind::Dots => "dots",
        Kind::GptSovits => "gpt-sovits",
    };
    let path = log_dir.join(format!("{provider}-stderr-{}.log", uuid::Uuid::new_v4()));
    let log = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "无法创建本地服务诊断日志".to_owned())?;
    prune_service_logs(&log_dir, provider, &path);
    Ok(log)
}

fn redirected(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn prune_service_logs(directory: &Path, provider: &str, current: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let prefix = format!("{provider}-stderr-");
    let mut old = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path == current {
                return None;
            }
            let name = entry.file_name();
            let id = name.to_str()?.strip_prefix(&prefix)?.strip_suffix(".log")?;
            if !uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id) {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.is_file() || redirected(&metadata) {
                return None;
            }
            Some((metadata.modified().ok()?, path))
        })
        .collect::<Vec<_>>();
    old.sort_unstable_by(|left, right| right.cmp(left));
    for (_, path) in old.into_iter().skip(LOCAL_SERVICE_LOG_FILES - 1) {
        // The directory contains only direct entries. Recheck immediately
        // before deleting a recognized owned log; preserve redirected files.
        if std::fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.is_file() && !redirected(&metadata))
        {
            // A still-open capture on Windows may temporarily refuse deletion.
            // Retention is retried at the next launch without blocking startup.
            let _ = std::fs::remove_file(path);
        }
    }
}

fn start_stderr_capture(child: &mut Child, mut log: File) -> Result<(), String> {
    let stderr = child.stderr.take().ok_or("无法读取本地服务诊断输出")?;
    std::thread::Builder::new()
        .name("local-tts-stderr".into())
        .spawn(move || capture_bounded_stderr(stderr, &mut log))
        .map_err(|_| "无法启动本地服务诊断任务".to_owned())?;
    Ok(())
}

fn capture_bounded_stderr<R: Read, W: Write>(mut stderr: R, mut log: W) {
    let mut stored = 0;
    let mut buffer = [0_u8; 4096];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let keep = count.min(LOCAL_SERVICE_LOG_LIMIT - stored);
                if keep > 0 {
                    if log.write_all(&buffer[..keep]).is_err() {
                        break;
                    }
                    stored += keep;
                }
                // Continue draining after the limit so child stderr never
                // blocks the model process.
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[cfg(windows)]
    #[test]
    fn owned_process_child_fixture() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

        let Ok(mode) = std::env::var("DANMAKUVOICE_PROCESS_FIXTURE") else {
            return;
        };
        if mode == "exit" {
            return;
        }
        if mode == "parent" {
            let mut grandchild = Command::new(std::env::current_exe().unwrap());
            grandchild
                .args([
                    "--exact",
                    "local_service::tests::owned_process_child_fixture",
                ])
                .env("DANMAKUVOICE_PROCESS_FIXTURE", "grandchild")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);
            let mut grandchild = grandchild.spawn().unwrap();
            let marker = std::env::var_os("DANMAKUVOICE_PROCESS_MARKER").unwrap();
            std::fs::write(marker, grandchild.id().to_string()).unwrap();
            grandchild.wait().unwrap();
            return;
        }
        std::thread::sleep(Duration::from_secs(30));
    }

    #[cfg(windows)]
    fn fixture_command(mode: &str, marker: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "local_service::tests::owned_process_child_fixture",
            ])
            .env("DANMAKUVOICE_PROCESS_FIXTURE", mode)
            .env("DANMAKUVOICE_PROCESS_MARKER", marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command
    }

    #[cfg(windows)]
    pub(crate) fn running_owned_service_fixture(
        directory: &Path,
        kind: Kind,
        endpoint: &str,
    ) -> ServiceState {
        let log = File::create(directory.join("owned-fixture.log")).unwrap();
        let process =
            OwnedProcess::spawn_owned(fixture_command("idle", &directory.join("unused.pid")), log)
                .unwrap();
        let mut state = ServiceState::new(Some(directory.to_owned()));
        state.process = Some(process);
        state.owned_port = Some(Endpoint::parse(kind, endpoint).unwrap().port);
        state.observe_endpoint(endpoint);
        state.set("ready", "Isolated process fixture is running");
        state
    }

    #[cfg(windows)]
    #[test]
    fn owned_process_drop_terminates_descendants_across_restarts() {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0,
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        };

        let temp = tempfile::tempdir().unwrap();
        for cycle in 0..6 {
            let marker = temp.path().join(format!("child-{cycle}.pid"));
            let log = File::create(temp.path().join(format!("child-{cycle}.log"))).unwrap();
            let owned = OwnedProcess::spawn_owned(fixture_command("parent", &marker), log).unwrap();
            let parent_pid = owned.child.id();
            let grandchild_pid = std::time::Instant::now();
            let grandchild_pid = loop {
                if let Ok(value) = std::fs::read_to_string(&marker) {
                    break value.parse::<u32>().unwrap();
                }
                assert!(grandchild_pid.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(20));
            };
            let handles = [parent_pid, grandchild_pid].map(|pid| {
                // SAFETY: The IDs came from live child processes created by
                // this fixture. OwnedHandle closes each successful handle.
                let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                assert!(!raw.is_null(), "fixture process {pid} vanished early");
                unsafe { OwnedHandle::from_raw_handle(raw) }
            });
            drop(owned);
            for handle in &handles {
                use std::os::windows::io::AsRawHandle;
                // SAFETY: A live owned process handle remains valid while we wait.
                let result = unsafe { WaitForSingleObject(handle.as_raw_handle(), 5_000) };
                assert_eq!(result, WAIT_OBJECT_0, "owned process remained after stop");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn explicit_restart_reaps_an_exited_owned_process_before_launch() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("unused.pid");
        let log = File::create(temp.path().join("child.log")).unwrap();
        let mut owned = OwnedProcess::spawn_owned(fixture_command("exit", &marker), log).unwrap();
        owned.child.blocking_wait().unwrap();
        let mut state = ServiceState::new(Some(temp.path().join("invalid-install")));
        state.process = Some(owned);
        let endpoint = Endpoint::parse(Kind::Dots, "http://127.0.0.1:19881").unwrap();
        assert!(state.launch(Kind::Dots, &endpoint, temp.path()).is_err());
        assert!(
            state.process.is_none(),
            "stale process prevented new launch"
        );
    }

    #[cfg(windows)]
    #[test]
    fn changing_a_managed_service_port_releases_the_previous_process() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("unused.pid");
        let log = File::create(temp.path().join("child.log")).unwrap();
        let owned = OwnedProcess::spawn_owned(fixture_command("grandchild", &marker), log).unwrap();
        let mut state = ServiceState::new(None);
        state.process = Some(owned);
        state.owned_port = Some(9881);
        state.switch_endpoint(9881);
        assert!(state.view().owned, "same endpoint should reuse its process");
        state.switch_endpoint(19881);
        assert!(!state.view().owned, "old endpoint process stayed owned");
        assert_eq!(state.owned_port, None);
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"offline fixture").unwrap();
    }

    fn stderr_category(app_data: &Path) -> String {
        let Ok(entries) = std::fs::read_dir(app_data.join("logs")) else {
            return "log unavailable".into();
        };
        let mut report = Vec::new();
        for entry in entries.flatten() {
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let output = String::from_utf8_lossy(&bytes);
            let kinds = [
                "Traceback",
                "ModuleNotFoundError",
                "FileNotFoundError",
                "PermissionError",
                "RuntimeError",
                "ImportError",
                "AssertionError",
                "OSError",
                "ValueError",
                "TypeError",
                "AttributeError",
                "KeyError",
                "SystemExit",
                "SyntaxError",
                "CUDA out of memory",
            ]
            .into_iter()
            .filter(|kind| output.contains(kind))
            .collect::<Vec<_>>();
            let frames = output
                .lines()
                .filter_map(|line| {
                    let line = line.trim();
                    let file = line.strip_prefix("File \"")?.split('"').next()?;
                    let name = Path::new(file).file_name()?.to_str()?;
                    let number = line.split(", line ").nth(1)?.split(',').next()?;
                    let drive = file
                        .get(..2)
                        .filter(|part| part.ends_with(':'))
                        .unwrap_or("?");
                    Some(format!("{name}:{number}@{drive}"))
                })
                .rev()
                .take(5)
                .collect::<Vec<_>>();
            let mount = output
                .lines()
                .find(|line| line.starts_with("ValueError: path is on mount"))
                .map(|line| {
                    let parts = line
                        .split('\'')
                        .filter(|part| part.len() == 2 && part.ends_with(':'))
                        .collect::<Vec<_>>();
                    format!("{parts:?}")
                })
                .unwrap_or_default();
            report.push(format!(
                "{} bytes, categories={kinds:?}, frames={frames:?}, mounts={mount}",
                bytes.len()
            ));
        }
        report.join("; ")
    }

    #[test]
    fn dots_launch_uses_existing_sibling_myvoice_and_2p_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("dots.tts");
        let myvoice = temp.path().join("myvoice");
        std::fs::create_dir_all(&myvoice).unwrap();
        touch(&temp.path().join("serve_api.py"));
        touch(&root.join("start_api_2p.bat"));
        touch(&root.join(".venv/Scripts/python.exe"));
        std::fs::create_dir_all(root.join("pretrained_models/dots.tts-2p")).unwrap();
        let spec = launch_spec(Kind::Dots, &root, 9881).unwrap();
        let ref_arg = spec.args.iter().position(|arg| arg == "--ref-dir").unwrap();
        assert_eq!(
            Path::new(&spec.args[ref_arg + 1]),
            process_path(myvoice.canonicalize().unwrap()).unwrap()
        );
        assert!(spec.args.contains(&"--optimize".to_owned()));
        assert_eq!(spec.args[0..3], ["-B", "-u", "-c"]);
        assert!(spec.args[3].contains("arbitrary_voice_paths"));
        assert!(spec.args[4].ends_with("serve_api.py"));
        assert!(spec.args.contains(&"--no-auto-voice".to_owned()));
        assert!(spec.args.contains(&"9881".to_owned()));
        std::fs::remove_dir(&myvoice).unwrap();
        // Per-preset absolute references do not depend on a populated myvoice.
        assert!(validate_directory(Kind::Dots, &root).is_ok());
    }

    #[test]
    fn manual_stop_suppresses_auto_start_until_explicit_start() {
        let mut service = ServiceState::new(Some(PathBuf::from("C:/dots.tts")));
        assert!(service.auto_start_allowed());
        service.stop_manual();
        assert!(!service.auto_start_allowed());
        assert!(service.view().manual_stopped);
        assert_eq!(service.view().state, "stopped");
        service.start_manual();
        assert!(service.auto_start_allowed());
        assert!(!service.view().manual_stopped);
    }

    #[test]
    fn local_stderr_log_is_private_to_app_data_and_size_limited() {
        let app_data = tempfile::tempdir().unwrap();
        let log = create_service_log(app_data.path(), Kind::Dots).unwrap();
        let data = vec![b'x'; LOCAL_SERVICE_LOG_LIMIT + 4096];
        capture_bounded_stderr(std::io::Cursor::new(data), log);
        let files = std::fs::read_dir(app_data.path().join("logs"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].metadata().unwrap().len(),
            LOCAL_SERVICE_LOG_LIMIT as u64
        );
    }

    #[test]
    fn repeated_service_launch_logs_are_bounded_and_preserve_unowned_files() {
        let app_data = tempfile::tempdir().unwrap();
        let directory = app_data.path().join("logs");
        std::fs::create_dir_all(&directory).unwrap();
        let user_log = directory.join("dots-stderr-manual.log");
        std::fs::write(&user_log, b"user diagnostics").unwrap();
        let other_provider =
            directory.join(format!("gpt-sovits-stderr-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&other_provider, b"other provider diagnostics").unwrap();
        for _ in 0..20 {
            let log = create_service_log(app_data.path(), Kind::Dots).unwrap();
            capture_bounded_stderr(std::io::Cursor::new(b"diagnostic output"), log);
        }
        let files = std::fs::read_dir(&directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(files.len(), LOCAL_SERVICE_LOG_FILES + 2);
        assert_eq!(std::fs::read(user_log).unwrap(), b"user diagnostics");
        assert_eq!(
            std::fs::read(other_provider).unwrap(),
            b"other provider diagnostics"
        );
    }

    #[cfg(windows)]
    #[test]
    fn service_log_redirection_is_rejected_and_rotation_preserves_link_targets() {
        let app_data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::windows::fs::symlink_dir(outside.path(), app_data.path().join("logs")).unwrap();
        assert!(create_service_log(app_data.path(), Kind::Dots).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);

        let app_data = tempfile::tempdir().unwrap();
        let directory = app_data.path().join("logs");
        std::fs::create_dir_all(&directory).unwrap();
        let target = outside.path().join("diagnostic.log");
        std::fs::write(&target, b"outside diagnostics").unwrap();
        let link = directory.join(format!("dots-stderr-{}.log", uuid::Uuid::new_v4()));
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        for _ in 0..10 {
            drop(create_service_log(app_data.path(), Kind::Dots).unwrap());
        }
        assert!(link.exists());
        assert_eq!(std::fs::read(target).unwrap(), b"outside diagnostics");
    }

    #[test]
    fn gpt_launch_uses_existing_extension_without_writing_old_installation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        touch(&root.join("runtime/python.exe"));
        touch(&root.join("api_v2.py"));
        touch(&root.join("GPT_SoVITS/configs/tts_infer.yaml"));
        let standard = launch_spec(Kind::GptSovits, root, 9880).unwrap();
        assert!(standard.args.iter().any(|arg| arg.ends_with("api_v2.py")));
        #[cfg(windows)]
        assert!(!standard.cwd.to_string_lossy().starts_with("\\\\?\\"));
        touch(&root.join("kinoko_sovits_api.py"));
        touch(&root.join("kinoko-tts-infer.yaml"));
        let extended = launch_spec(Kind::GptSovits, root, 9880).unwrap();
        assert!(
            extended
                .args
                .iter()
                .any(|arg| arg.ends_with("kinoko_sovits_api.py"))
        );
    }

    #[test]
    fn only_loopback_service_roots_are_launchable() {
        assert_eq!(
            Endpoint::parse(Kind::Dots, "http://127.0.0.1:9881/tts/stream")
                .unwrap()
                .port,
            9881
        );
        for value in [
            "http://example.com:9881",
            "https://127.0.0.1:9881",
            "http://user:secret@127.0.0.1:9881",
            "http://127.0.0.1:9881/other",
            "http://127.0.0.1:9881/?token=secret",
        ] {
            assert!(Endpoint::parse(Kind::Dots, value).is_err());
        }
    }

    #[tokio::test]
    async fn gpt_route_names_without_compatible_methods_are_foreign() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint::parse(
            Kind::GptSovits,
            &format!("http://{}", listener.local_addr().unwrap()),
        )
        .unwrap();
        let task = tokio::spawn(async move {
            let mut responses = 0;
            while responses < 2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let size = socket.read(&mut request).await.unwrap();
                if size == 0 {
                    continue;
                }
                let (status, body) = if request[..size].starts_with(b"GET /kinoko/status ") {
                    ("404 Not Found", "{}")
                } else {
                    assert!(request[..size].starts_with(b"GET /openapi.json "));
                    (
                        "200 OK",
                        r#"{"paths":{"/tts":{"get":{}},"/set_gpt_weights":{"post":{}},"/set_sovits_weights":{"get":{}}}}"#,
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                responses += 1;
            }
        });
        assert_eq!(probe(Kind::GptSovits, &endpoint).await, Health::Foreign);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn occupied_unknown_port_is_never_considered_offline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                if socket.read(&mut request).await.unwrap() > 0 {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                        .await
                        .unwrap();
                }
            }
        });
        let endpoint = Endpoint::parse(Kind::Dots, &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(Kind::Dots, &endpoint).await, Health::Foreign);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn unused_loopback_port_is_offline_even_if_connect_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let endpoint = Endpoint::parse(Kind::Dots, &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(Kind::Dots, &endpoint).await, Health::Offline);
    }

    #[tokio::test]
    async fn shim_capability_is_required_for_dots_ready_without_synthesis() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                let size = socket.read(&mut request).await.unwrap();
                if size > 0 {
                    let route = String::from_utf8_lossy(&request[..size]);
                    let body = if route.contains("GET /health") {
                        r#"{"ready":true,"model_loaded":true,"stream_requests":0}"#
                    } else {
                        assert!(route.contains("GET /danmakuvoice/capabilities"));
                        r#"{"protocol":"danmakuvoice-dots-paths-v1","arbitrary_voice_paths":true,"reference_text_explicit":true}"#
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                }
            }
        });
        let endpoint = Endpoint::parse(Kind::Dots, &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(Kind::Dots, &endpoint).await, Health::Ready);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn old_dots_without_path_capability_is_not_ready() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                let size = socket.read(&mut request).await.unwrap();
                if size == 0 {
                    continue;
                }
                let route = String::from_utf8_lossy(&request[..size]);
                let body = if route.contains("GET /health") {
                    r#"{"ready":true,"model_loaded":true,"stream_requests":0}"#
                } else {
                    assert!(route.contains("GET /danmakuvoice/capabilities"));
                    "{}"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let endpoint = Endpoint::parse(Kind::Dots, &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(Kind::Dots, &endpoint).await, Health::LegacyDots);
        task.await.unwrap();
    }

    /// Opt-in local integration: launches the selected existing dots model on
    /// an isolated loopback port. It never plays audio or touches cloud APIs.
    #[tokio::test]
    #[ignore = "requires an explicitly selected local dots installation and reference WAV"]
    async fn live_dots_shim_absolute_reference_and_owned_cleanup() {
        let directory = PathBuf::from(std::env::var_os("DANMAKUVOICE_DOTS_DIR").unwrap());
        let reference = PathBuf::from(std::env::var_os("DANMAKUVOICE_DOTS_REFERENCE").unwrap());
        let port = std::env::var("DANMAKUVOICE_DOTS_LIVE_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        assert!(directory.is_dir() && reference.is_file());
        let endpoint = Endpoint::parse(Kind::Dots, &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(Kind::Dots, &endpoint).await, Health::Offline);
        let app_data = tempfile::tempdir().unwrap();
        let mut owned =
            OwnedProcess::launch(Kind::Dots, &directory, port, app_data.path()).unwrap();
        let mut ready = false;
        for _ in 0..120 {
            if owned.exited() {
                break;
            }
            match probe(Kind::Dots, &endpoint).await {
                Health::Ready => {
                    ready = true;
                    break;
                }
                Health::Offline | Health::Unready | Health::Timeout => {
                    tokio::time::sleep(Duration::from_secs(3)).await
                }
                Health::LegacyDots | Health::Foreign => break,
            }
        }
        assert!(ready, "isolated dots shim did not become ready");
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap();
        let mut response = client
            .post(format!("http://127.0.0.1:{port}/tts/stream"))
            .json(&serde_json::json!({
                "text": "你好。",
                "voice": reference,
                "prompt_text": "",
            }))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert!(
            response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .is_some_and(|value| value.as_bytes().starts_with(b"audio/wav"))
        );
        let mut bytes = 0usize;
        let mut header = Vec::new();
        while let Some(chunk) = response.chunk().await.unwrap() {
            bytes += chunk.len();
            assert!(bytes <= 8 * 1024 * 1024, "unexpectedly large short audio");
            if header.len() < 12 {
                header.extend_from_slice(&chunk[..chunk.len().min(12 - header.len())]);
            }
        }
        assert!(bytes > 44);
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(&header[8..12], b"WAVE");
        drop(owned);
        let mut stopped = false;
        for _ in 0..20 {
            if probe(Kind::Dots, &endpoint).await == Health::Offline {
                stopped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(stopped, "owned dots process did not release its port");
        println!("dots-shim-live: HTTP 200, WAV bytes={bytes}, owned port closed");
    }

    /// Opt-in local acceptance against an existing GPT-SoVITS installation.
    /// The isolated process uses only loopback and a temporary app-data root.
    #[tokio::test]
    #[ignore = "requires explicit local GPT-SoVITS model pair and reference audio"]
    async fn live_gpt_sovits_atomic_pair_reference_and_owned_cleanup() {
        use danmakuvoice_engine::tts::sovits::{
            SovitsClient, SovitsConfig, SovitsLanguage, SovitsMode, SovitsModelSelection,
        };
        use tokio_util::sync::CancellationToken;

        let directory = PathBuf::from(std::env::var_os("DANMAKUVOICE_GPT_DIR").unwrap());
        let reference = PathBuf::from(std::env::var_os("DANMAKUVOICE_GPT_REFERENCE").unwrap());
        let gpt_weight = PathBuf::from(std::env::var_os("DANMAKUVOICE_GPT_WEIGHT").unwrap());
        let sovits_weight = PathBuf::from(std::env::var_os("DANMAKUVOICE_SOVITS_WEIGHT").unwrap());
        let reference_text = std::env::var("DANMAKUVOICE_GPT_REFERENCE_TEXT").unwrap();
        let port = std::env::var("DANMAKUVOICE_GPT_LIVE_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        assert!(directory.is_dir() && reference.is_file());
        assert!(gpt_weight.is_file() && sovits_weight.is_file());
        assert!(!reference_text.trim().is_empty());
        let endpoint =
            Endpoint::parse(Kind::GptSovits, &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(Kind::GptSovits, &endpoint).await, Health::Offline);
        let app_data = tempfile::tempdir().unwrap();
        let mut owned =
            OwnedProcess::launch(Kind::GptSovits, &directory, port, app_data.path()).unwrap();
        let mut ready = false;
        for _ in 0..120 {
            if owned.exited() {
                break;
            }
            match probe(Kind::GptSovits, &endpoint).await {
                Health::Ready => {
                    ready = true;
                    break;
                }
                Health::Offline | Health::Unready | Health::Timeout => {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
                Health::LegacyDots | Health::Foreign => break,
            }
        }
        assert!(
            ready,
            "isolated GPT-SoVITS did not become ready: {}; pythonpath_set={}",
            stderr_category(app_data.path()),
            std::env::var_os("PYTHONPATH").is_some()
        );

        let base = format!("http://127.0.0.1:{port}");
        let mut config = SovitsConfig::new(&base, reference.to_string_lossy().into_owned());
        config.reference_text = reference_text;
        config.reference_text_free = false;
        config.text_language = SovitsLanguage::Chinese;
        config.reference_language = SovitsLanguage::Chinese;
        config.model_selection = SovitsModelSelection::PerRequestAtomic;
        config.gpt_weights_path = Some(gpt_weight.to_string_lossy().into_owned());
        config.sovits_weights_path = Some(sovits_weight.to_string_lossy().into_owned());
        config.timeout_secs = 240;
        let client = SovitsClient::new(config).unwrap();
        let cancel = CancellationToken::new();
        assert_eq!(
            client.mode(&cancel).await.unwrap(),
            SovitsMode::AtomicExtension
        );
        let mut audio = client.stream("你好。", &cancel).unwrap();
        let mut bytes = 0usize;
        let mut header = Vec::new();
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(300), audio.recv())
            .await
            .unwrap()
        {
            let chunk = chunk.unwrap();
            bytes += chunk.len();
            assert!(bytes <= 16 * 1024 * 1024, "unexpectedly large short audio");
            if header.len() < 12 {
                header.extend_from_slice(&chunk[..chunk.len().min(12 - header.len())]);
            }
        }
        assert!(bytes > 44);
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(&header[8..12], b"WAVE");
        let status: serde_json::Value = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("{base}/kinoko/status"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let active = status.get("active_model").unwrap();
        assert_eq!(
            PathBuf::from(active["gpt_weights_path"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            gpt_weight.canonicalize().unwrap()
        );
        assert_eq!(
            PathBuf::from(active["sovits_weights_path"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            sovits_weight.canonicalize().unwrap()
        );
        assert!(reference.is_file());
        assert!(!app_data.path().join("references").exists());
        drop(owned);
        let mut stopped = false;
        for _ in 0..20 {
            if probe(Kind::GptSovits, &endpoint).await == Health::Offline {
                stopped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(stopped, "owned GPT-SoVITS did not release its port");
        println!(
            "gpt-sovits-live: atomic pair, reference and Chinese language accepted, WAV bytes={bytes}, owned port closed"
        );
    }
}
