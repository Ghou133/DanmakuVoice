//! Find and start a local OBS Studio for the broadcast console.
//!
//! Used only on an explicit go-live or "start OBS" click, and only when the
//! saved OBS address is this computer. A user-chosen program must be named
//! `obs64.exe`; nothing else is ever started from these settings. OBS is
//! started with its own folder as the working directory (OBS looks up its
//! data relative to it) and is not tied to this app's lifetime.
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::{Command, Stdio};

use crate::obs::ObsError;

pub const OBS_EXECUTABLE: &str = "obs64.exe";
const PATH_LIMIT: usize = 1024;

/// An absolute path whose file name is obs64.exe (any letter case).
pub fn is_valid_executable(path: &str) -> bool {
    let candidate = Path::new(path);
    path.len() <= PATH_LIMIT
        && !path.chars().any(char::is_control)
        && candidate.is_absolute()
        && candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(OBS_EXECUTABLE))
}

/// OBS from the installer's registry entry, the default install folder or
/// the default Steam library. `None` when none of them exists.
pub fn find_installed() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        const RELATIVE: &str = "bin\\64bit\\obs64.exe";
        for root in [
            windows_registry::LOCAL_MACHINE,
            windows_registry::CURRENT_USER,
        ] {
            if let Ok(directory) = root
                .open("SOFTWARE\\OBS Studio")
                .and_then(|key| key.get_string(""))
            {
                let candidate = Path::new(directory.trim()).join(RELATIVE);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        let defaults = [
            ("ProgramFiles", "obs-studio"),
            ("ProgramW6432", "obs-studio"),
            ("ProgramFiles(x86)", "Steam\\steamapps\\common\\OBS Studio"),
        ];
        for (variable, folder) in defaults {
            if let Some(base) = std::env::var_os(variable) {
                let candidate = PathBuf::from(base).join(folder).join(RELATIVE);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// The program to start: the saved choice if it still exists, otherwise the
/// detected installation.
pub fn resolve(configured: Option<&str>) -> Result<PathBuf, ObsError> {
    match configured {
        Some(path) if is_valid_executable(path) && Path::new(path).is_file() => Ok(path.into()),
        Some(_) => Err(ObsError::NotInstalled),
        None => find_installed().ok_or(ObsError::NotInstalled),
    }
}

/// Whether an `obs64.exe` process is running for any user session visible
/// to this one. Starting a second OBS would only show OBS's own
/// "already running" prompt, so callers check this first.
pub fn is_running() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        };
        // SAFETY: a process snapshot handle is owned here and closed below.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return false;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        // SAFETY: `entry` is a properly sized PROCESSENTRY32W for this snapshot.
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while more {
            let length = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..length])
                .eq_ignore_ascii_case(OBS_EXECUTABLE)
            {
                found = true;
                break;
            }
            // SAFETY: as above.
            more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        // SAFETY: the snapshot handle came from CreateToolhelp32Snapshot.
        unsafe { CloseHandle(snapshot) };
        found
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Start OBS without waiting for it. The child is released, so OBS keeps
/// running when this app exits.
pub fn launch(executable: &Path) -> Result<(), ObsError> {
    if !is_valid_executable(&executable.to_string_lossy()) {
        return Err(ObsError::NotInstalled);
    }
    let directory = executable.parent().ok_or(ObsError::NotInstalled)?;
    #[cfg(windows)]
    let launched = crate::owned_process::spawn_detached(executable, directory, &[]);
    #[cfg(not(windows))]
    let launched = Command::new(executable)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop);
    launched.map_err(|error| {
        ObsError::Launch(match error.kind() {
            std::io::ErrorKind::NotFound => "程序文件不存在".to_owned(),
            std::io::ErrorKind::PermissionDenied => "没有权限运行，请检查安全软件".to_owned(),
            _ => match error.raw_os_error() {
                Some(code) => format!("系统错误 {code}"),
                None => "系统错误".to_owned(),
            },
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_obs64_paths_are_accepted() {
        let directory = std::env::temp_dir();
        let good = directory.join("OBS64.EXE");
        assert!(is_valid_executable(&good.to_string_lossy()));
        for bad in [
            directory.join("cmd.exe").to_string_lossy().into_owned(),
            directory
                .join("obs64.exe.bat")
                .to_string_lossy()
                .into_owned(),
            "obs64.exe".to_owned(),
            "bin\\64bit\\obs64.exe".to_owned(),
            format!("{}\nobs64.exe", directory.display()),
        ] {
            assert!(!is_valid_executable(&bad), "{bad}");
        }
    }

    #[test]
    fn a_saved_program_must_still_exist() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("obs64.exe");
        assert!(matches!(
            resolve(Some(&missing.to_string_lossy())),
            Err(ObsError::NotInstalled)
        ));
        std::fs::write(&missing, b"").unwrap();
        assert_eq!(resolve(Some(&missing.to_string_lossy())).unwrap(), missing);
        let other = temp.path().join("notepad.exe");
        std::fs::write(&other, b"").unwrap();
        assert!(resolve(Some(&other.to_string_lossy())).is_err());
        assert!(launch(&other).is_err());
    }
}
