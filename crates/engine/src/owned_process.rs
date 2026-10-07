//! Windows children enter their private kill-on-close job during CreateProcess.
//! Assigning a running child afterward leaves a race where descendants escape.

use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::Path,
    process::{Command, ExitStatus},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_MORE_DATA, HANDLE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::{
        JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Pipes::CreatePipe,
        Threading::{
            CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcess,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION,
            PROCESS_SYNCHRONIZE, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
            UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

pub struct OwnedChild {
    process: OwnedHandle,
    job: OwnedHandle,
    id: u32,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
}

struct Attributes(Vec<usize>);
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: this aligned allocation holds one initialized attribute list.
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
    }
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value = value.encode_wide().collect::<Vec<_>>();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in process argument",
        ));
    }
    value.push(0);
    Ok(value)
}

fn quote(value: &OsStr, output: &mut Vec<u16>) -> io::Result<()> {
    let value = wide(value)?;
    output.push(b'"' as u16);
    let mut slashes = 0;
    for &unit in &value[..value.len() - 1] {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            b'\\' as u16,
            if unit == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        output.push(unit);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
    Ok(())
}

/// Launch an independent GUI program without inheriting any parent handles.
/// In particular, concurrent owned-process pipe creation must not let this
/// long-lived program retain a decoder's stdout and prevent EOF.
pub fn spawn_detached(executable: &Path, directory: &Path, arguments: &[&OsStr]) -> io::Result<()> {
    let application = wide(executable.as_os_str())?;
    let directory = wide(directory.as_os_str())?;
    let mut command = Vec::new();
    quote(executable.as_os_str(), &mut command)?;
    for argument in arguments {
        command.push(b' ' as u16);
        quote(argument, &mut command)?;
    }
    command.push(0);
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..unsafe { std::mem::zeroed() }
    };
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: all strings and structures remain valid for this call. Handle
    // inheritance is explicitly disabled; the OS supplies the environment.
    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            directory.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // Closing the observation handles leaves this independent process running.
    drop(unsafe { OwnedHandle::from_raw_handle(process.hThread) });
    drop(unsafe { OwnedHandle::from_raw_handle(process.hProcess) });
    Ok(())
}

fn inheritable(handle: HANDLE) -> io::Result<OwnedHandle> {
    let mut copy = std::ptr::null_mut();
    // SAFETY: duplicate a live local handle; the returned handle has one owner.
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut copy,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(copy) })
}

fn pipe(input: bool) -> io::Result<(File, OwnedHandle)> {
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    // SAFETY: receive two noninheritable handles; only the child end is duplicated.
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let (read, write) = unsafe {
        (
            OwnedHandle::from_raw_handle(read),
            OwnedHandle::from_raw_handle(write),
        )
    };
    if input {
        Ok((File::from(write), inheritable(read.as_raw_handle())?))
    } else {
        Ok((File::from(read), inheritable(write.as_raw_handle())?))
    }
}

impl OwnedChild {
    /// Only explicit pipe flags are used; Command supplies executable/args/env/cwd.
    /// Environment inherits the host plus overrides (env_clear is unsupported).
    /// The executable must be an absolute path, so Windows never searches the cwd.
    pub fn spawn(command: &Command, stdin: bool, stdout: bool, stderr: bool) -> io::Result<Self> {
        if !std::path::Path::new(command.get_program()).is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "owned executable must be absolute",
            ));
        }
        let application = wide(command.get_program())?;
        let mut line = Vec::new();
        quote(command.get_program(), &mut line)?;
        for arg in command.get_args() {
            line.push(b' ' as u16);
            quote(arg, &mut line)?;
        }
        line.push(0);
        let cwd = command
            .get_current_dir()
            .map(|path| wide(path.as_os_str()))
            .transpose()?;
        // Service environment overrides use Windows' case-insensitive keys.
        let mut environment = std::env::vars_os().collect::<Vec<_>>();
        for (key, value) in command.get_envs() {
            environment.retain(|(existing, _)| {
                !existing
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&key.to_string_lossy())
            });
            if let Some(value) = value {
                environment.push((key.to_owned(), value.to_owned()));
            }
        }
        environment.sort_by_cached_key(|(key, _)| key.to_string_lossy().to_uppercase());
        let mut block = Vec::new();
        for (key, value) in environment {
            let mut pair = key;
            pair.push("=");
            pair.push(value);
            block.extend(wide(&pair)?);
        }
        block.push(0);
        let null = OpenOptions::new().read(true).write(true).open("NUL")?;
        let mut parent_pipes = Vec::new();
        let mut child_pipes = Vec::new();
        for (index, enabled) in [stdin, stdout, stderr].into_iter().enumerate() {
            if enabled {
                let (parent, child) = pipe(index == 0)?;
                parent_pipes.push(Some(parent));
                child_pipes.push(child);
            } else {
                parent_pipes.push(None);
                child_pipes.push(inheritable(null.as_raw_handle())?);
            }
        }
        let handles = child_pipes
            .iter()
            .map(AsRawHandle::as_raw_handle)
            .collect::<Vec<_>>();
        // SAFETY: unnamed, noninheritable private job, owned on success.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: fixed-size information and live job handle.
        if unsafe {
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut size = 0;
        // SAFETY: first call obtains the required allocation size.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut size) };
        let mut allocation = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(allocation.as_mut_ptr().cast(), 2, 0, &mut size)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut attributes = Attributes(allocation);
        let list = attributes.0.as_mut_ptr().cast();
        // SAFETY: both backing arrays remain alive until CreateProcessW returns.
        for (attribute, pointer, bytes) in [
            (
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles.as_slice()),
            ),
            (
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                (&raw const raw).cast(),
                std::mem::size_of_val(&raw),
            ),
        ] {
            if unsafe {
                UpdateProcThreadAttribute(
                    list,
                    0,
                    attribute as usize,
                    pointer,
                    bytes,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of_val(&startup) as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = list;
        let mut process = PROCESS_INFORMATION::default();
        // SAFETY: all pointers refer to live, terminated UTF-16 buffers or
        // initialized Win32 structures. Only our three stdio handles inherit.
        let ok = unsafe {
            CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                block.as_ptr().cast(),
                cwd.as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                &startup.StartupInfo,
                &mut process,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let process_handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
        drop(unsafe { OwnedHandle::from_raw_handle(process.hThread) });
        Ok(Self {
            process: process_handle,
            job,
            id: process.dwProcessId,
            stdin: parent_pipes[0].take(),
            stdout: parent_pipes[1].take(),
            stderr: parent_pipes[2].take(),
        })
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: owned process handle stays live through both calls.
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => return Ok(None),
            _ => return Err(io::Error::last_os_error()),
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(ExitStatus::from_raw(code)))
    }

    pub fn blocking_wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: this job contains only this spawn and its descendants.
        if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub async fn kill(&mut self) -> io::Result<()> {
        self.terminate()?;
        self.wait().await.map(|_| ())
    }

    fn tree_handles(&self) -> Vec<OwnedHandle> {
        let mut buffer = vec![0usize; 128];
        loop {
            // SAFETY: aligned storage is larger than the variable-length header.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.job.as_raw_handle(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    std::mem::size_of_val(buffer.as_slice()) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok != 0 {
                let info = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
                let count = (info.NumberOfProcessIdsInList as usize).min(buffer.len() - 1);
                let pids =
                    unsafe { std::slice::from_raw_parts(info.ProcessIdList.as_ptr(), count) };
                return pids
                    .iter()
                    .filter_map(|pid| {
                        // Only IDs returned by our private Job; never process-name matching.
                        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, *pid as u32) };
                        (!raw.is_null()).then(|| unsafe { OwnedHandle::from_raw_handle(raw) })
                    })
                    .collect();
            }
            if io::Error::last_os_error().raw_os_error() != Some(ERROR_MORE_DATA as i32)
                || buffer.len() >= 131_072
            {
                return Vec::new();
            }
            buffer.resize(buffer.len() * 2, 0);
        }
    }

    fn reap_tree(&self) {
        let handles = self.tree_handles();
        let _ = self.terminate();
        let deadline = Instant::now() + Duration::from_secs(2);
        for handle in &handles {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u32;
            // Job accounting may reach zero before process teardown closes sockets.
            unsafe { WaitForSingleObject(handle.as_raw_handle(), remaining) };
        }
        let started = Instant::now();
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: query our private job into a fixed-size writable value.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&raw mut accounting).cast(),
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0
                || accounting.ActiveProcesses == 0
                || started.elapsed() >= Duration::from_secs(2)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.reap_tree();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    fn fixture(mode: &str, directory: &std::path::Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "owned_process::tests::process_fixture",
                "--nocapture",
            ])
            .env("DV_OWNED_FIXTURE", mode)
            .env("DV_OWNED_DIRECTORY", directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[test]
    fn process_fixture() {
        let detached_directory = std::env::current_dir().unwrap();
        let detached = detached_directory.join("detached-fixture.txt").is_file();
        let mode = match std::env::var("DV_OWNED_FIXTURE") {
            Ok(mode) => mode,
            Err(_) if detached => "leaf".to_owned(),
            Err(_) => return,
        };
        let directory = if detached {
            detached_directory
        } else {
            std::path::PathBuf::from(std::env::var_os("DV_OWNED_DIRECTORY").unwrap())
        };
        if mode == "handles" {
            use windows_sys::Win32::System::Threading::GetProcessHandleCount;
            let count = || {
                let mut count = 0;
                assert_ne!(
                    unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) },
                    0
                );
                count
            };
            let command = Command::new(directory.join("missing.exe"));
            // Warm up the OS process-creation path before measuring whether
            // repeated failures accumulate handles.
            let cold = count();
            for _ in 0..20 {
                assert!(OwnedChild::spawn(&command, true, true, true).is_err());
            }
            let before = count();
            for _ in 0..200 {
                assert!(OwnedChild::spawn(&command, true, true, true).is_err());
            }
            let after = count();
            std::fs::write(
                directory.join("handles.json"),
                serde_json::json!({"cold":cold,"before":before,"after":after,"warmup":20,"failed_spawns":200}).to_string(),
            )
            .unwrap();
            assert_eq!(before, after);
            return;
        }
        if mode == "host" {
            let _owned =
                OwnedChild::spawn(&fixture("service", &directory), false, false, false).unwrap();
            std::thread::sleep(Duration::from_secs(60));
        } else if mode == "service" {
            // Deliberately no grace period: descendants must belong from birth.
            let mut child = fixture("leaf", &directory).spawn().unwrap();
            child.wait().unwrap();
        } else {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let record = serde_json::json!({"pid":std::process::id(),"port":listener.local_addr().unwrap().port()});
            std::fs::write(directory.join("ready.tmp"), record.to_string()).unwrap();
            std::fs::rename(directory.join("ready.tmp"), directory.join("ready.json")).unwrap();
            std::thread::sleep(Duration::from_secs(60));
            drop(listener);
        }
    }

    fn ready(directory: &std::path::Path) -> (u32, u16) {
        let started = Instant::now();
        loop {
            if let Ok(text) = std::fs::read_to_string(directory.join("ready.json")) {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                return (
                    value["pid"].as_u64().unwrap() as u32,
                    value["port"].as_u64().unwrap() as u16,
                );
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "fixture did not start"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    struct DirectChild(std::process::Child);
    impl Drop for DirectChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn assert_released(port: u16) {
        let started = Instant::now();
        loop {
            if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
                drop(listener);
                return;
            }
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "owned port {port} survived"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn stopped_tree_releases_port_before_restart_and_preserves_external_listener() {
        let external = tempfile::tempdir().unwrap();
        let _control = DirectChild(fixture("leaf", external.path()).spawn().unwrap());
        let (_, control_port) = ready(external.path());
        for _ in 0..6 {
            let directory = tempfile::tempdir().unwrap();
            let owned =
                OwnedChild::spawn(&fixture("service", directory.path()), false, false, false)
                    .unwrap();
            let (pid, port) = ready(directory.path());
            drop(owned);
            assert!(
                TcpListener::bind(("127.0.0.1", port)).is_ok(),
                "port not released when stop returned"
            );
            assert!(TcpStream::connect(("127.0.0.1", control_port)).is_ok());
            println!(
                "owned descendant {pid}, port {port}: released; external port {control_port}: preserved"
            );
        }
    }

    #[test]
    fn abrupt_host_exit_kills_owned_descendants_and_listener() {
        let directory = tempfile::tempdir().unwrap();
        let mut host = DirectChild(fixture("host", directory.path()).spawn().unwrap());
        let (pid, port) = ready(directory.path());
        // Terminate only the direct host: its Rust Drop code cannot run.
        host.0.kill().unwrap();
        host.0.wait().unwrap();
        assert_released(port);
        println!("abrupt host exit: descendant {pid}, port {port} released by kernel job");
    }

    #[test]
    fn failed_spawn_releases_pipe_handles_and_private_job() {
        let directory = tempfile::tempdir().unwrap();
        let command = Command::new(directory.path().join("missing.exe"));
        for _ in 0..20 {
            assert!(OwnedChild::spawn(&command, true, true, true).is_err());
        }
        // Count in a separate process so unrelated parallel tests cannot
        // affect the measurement of pipe/job failure cleanup.
        let mut host =
            OwnedChild::spawn(&fixture("handles", directory.path()), false, false, true).unwrap();
        let status = host.blocking_wait().unwrap();
        let counts: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.path().join("handles.json")).unwrap())
                .unwrap();
        assert!(status.success(), "handle fixture failed: {counts}");
        assert_eq!(counts["before"], counts["after"]);
        println!("isolated failed-spawn handle counts: {counts}");
    }

    #[test]
    fn detached_program_does_not_inherit_transient_owned_pipes() {
        use std::io::Read;
        use windows_sys::Win32::System::Threading::{PROCESS_TERMINATE, TerminateProcess};
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("detached-fixture.txt"), "test only").unwrap();
        // Force the race deterministically: a child-side inheritable pipe is
        // alive throughout independent-process creation.
        let (mut reader, child_end) = pipe(false).unwrap();
        spawn_detached(
            &std::env::current_exe().unwrap(),
            directory.path(),
            &[
                OsStr::new("--exact"),
                OsStr::new("owned_process::tests::process_fixture"),
                OsStr::new("--nocapture"),
            ],
        )
        .unwrap();
        let (pid, port) = ready(directory.path());
        let process = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!process.is_null());
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        drop(child_end);
        let (send, receive) = std::sync::mpsc::channel();
        let reading = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = send.send(reader.read_to_end(&mut bytes));
        });
        let eof = receive.recv_timeout(Duration::from_secs(2));
        let still_listening = TcpStream::connect(("127.0.0.1", port)).is_ok();
        // Cleanup only the process created above, even if the assertion fails.
        unsafe {
            TerminateProcess(process.as_raw_handle(), 0);
            WaitForSingleObject(process.as_raw_handle(), 5000);
        }
        reading.join().unwrap();
        assert_eq!(eof.unwrap().unwrap(), 0);
        assert!(
            still_listening,
            "independent program must remain alive after pipe EOF"
        );
    }
}
