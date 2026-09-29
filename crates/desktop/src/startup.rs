//! Opt-in current-user Windows startup. No registry write occurs on load.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, RegCloseKey, RegCreateKeyExW,
    RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME: &str = "DanmakuVoice";
const MAX_VALUE_BYTES: u32 = 32 * 1024;

struct OpenKey(HKEY);

impl Drop for OpenKey {
    fn drop(&mut self) {
        // SAFETY: This handle was returned by RegOpenKeyExW in this module.
        unsafe { RegCloseKey(self.0) };
    }
}

fn wide_nul(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn open_run_key(access: u32) -> io::Result<Option<OpenKey>> {
    let mut handle = ptr::null_mut();
    let path = wide_nul(RUN_KEY);
    // SAFETY: path has a trailing NUL and handle points to writable storage.
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut handle) };
    match status {
        ERROR_SUCCESS => Ok(Some(OpenKey(handle))),
        ERROR_FILE_NOT_FOUND => Ok(None),
        other => Err(io::Error::from_raw_os_error(other as i32)),
    }
}

fn create_run_key() -> io::Result<OpenKey> {
    let mut handle = ptr::null_mut();
    let mut disposition = 0;
    let path = wide_nul(RUN_KEY);
    // SAFETY: path is NUL terminated; the two output pointers are writable.
    // The key belongs to the current user and needs no administrator rights.
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            ptr::null(),
            0,
            KEY_SET_VALUE,
            ptr::null(),
            &mut handle,
            &mut disposition,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(OpenKey(handle))
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

fn quoted(value: &OsStr) -> io::Result<Vec<u16>> {
    let units: Vec<u16> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "路径包含 NUL 字符",
        ));
    }
    let mut result = vec![b'"' as u16];
    let mut backslashes = 0;
    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
        } else if unit == b'"' as u16 {
            result.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
            result.push(unit);
            backslashes = 0;
        } else {
            result.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
            result.push(unit);
            backslashes = 0;
        }
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    result.push(b'"' as u16);
    Ok(result)
}

fn command_line(exe: &Path, data_dir: &Path) -> io::Result<Vec<u16>> {
    if !exe.is_absolute() || !data_dir.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "开机启动需要绝对路径",
        ));
    }
    let mut line = quoted(exe.as_os_str())?;
    line.extend(" --data-dir ".encode_utf16());
    line.extend(quoted(data_dir.as_os_str())?);
    Ok(line)
}

pub fn is_enabled(exe: &Path, data_dir: &Path) -> io::Result<bool> {
    if crate::package::installed_root()
        .map_err(io::Error::other)?
        .is_some()
    {
        let state = store_task()?.State().map_err(io::Error::other)?;
        return Ok(store_enabled(state));
    }
    let expected = command_line(exe, data_dir)?;
    let Some(key) = open_run_key(KEY_QUERY_VALUE)? else {
        return Ok(false);
    };
    let name = wide_nul(VALUE_NAME);
    let mut kind = 0;
    let mut byte_count = 0;
    // SAFETY: name is NUL terminated; output pointers are valid for writes.
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            ptr::null(),
            &mut kind,
            ptr::null_mut(),
            &mut byte_count,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if kind != REG_SZ || byte_count == 0 || byte_count > MAX_VALUE_BYTES || byte_count % 2 != 0 {
        return Ok(false);
    }
    let mut value = vec![0_u16; byte_count as usize / 2];
    // SAFETY: value provides byte_count writable bytes; name remains valid.
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            ptr::null(),
            &mut kind,
            value.as_mut_ptr().cast::<u8>(),
            &mut byte_count,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if kind != REG_SZ || byte_count % 2 != 0 {
        return Ok(false);
    }
    value.truncate(byte_count as usize / 2);
    if value.last() == Some(&0) {
        value.pop();
    }
    Ok(value == expected)
}

/// Called only from the user's explicit startup setting. It touches this
/// application's HKCU Run value and never requests administrator access.
pub fn set_enabled(exe: &Path, data_dir: &Path, enabled: bool) -> io::Result<()> {
    if crate::package::installed_root()
        .map_err(io::Error::other)?
        .is_some()
    {
        let task = store_task()?;
        if enabled {
            let state = task
                .RequestEnableAsync()
                .map_err(io::Error::other)?
                .join()
                .map_err(io::Error::other)?;
            if !store_enabled(state) {
                return Err(io::Error::other(
                    "Windows 已禁用开机启动，请在系统设置的「应用 → 启动」中允许 [DV-X16]",
                ));
            }
        } else {
            task.Disable().map_err(io::Error::other)?;
        }
        return Ok(());
    }
    // Portable copies and isolated --data-dir sessions share the HKCU Run key
    // name. Turning startup off in one copy must not remove another copy's
    // opt-in entry.
    if !enabled && !is_enabled(exe, data_dir)? {
        return Ok(());
    }
    let line = if enabled {
        Some(command_line(exe, data_dir)?)
    } else {
        None
    };
    let key = match open_run_key(KEY_SET_VALUE)? {
        Some(key) => key,
        None if enabled => create_run_key()?,
        None => return Ok(()),
    };
    let name = wide_nul(VALUE_NAME);
    let status = if let Some(mut line) = line {
        line.push(0);
        // SAFETY: key is open for writes, name and line are NUL terminated.
        unsafe {
            RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                REG_SZ,
                line.as_ptr().cast::<u8>(),
                (line.len() * 2) as u32,
            )
        }
    } else {
        // SAFETY: key is open for writes and name is NUL terminated.
        unsafe { RegDeleteValueW(key.0, name.as_ptr()) }
    };
    if status == ERROR_SUCCESS || (!enabled && status == ERROR_FILE_NOT_FOUND) {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

fn store_task() -> io::Result<windows::ApplicationModel::StartupTask> {
    windows::ApplicationModel::StartupTask::GetAsync(&windows_core::HSTRING::from(
        "DanmakuVoiceStartup",
    ))
    .map_err(io::Error::other)?
    .join()
    .map_err(io::Error::other)
}

fn store_enabled(state: windows::ApplicationModel::StartupTaskState) -> bool {
    use windows::ApplicationModel::StartupTaskState;
    state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_line_quotes_spaces_and_trailing_backslash() {
        let line = command_line(
            Path::new(r"C:\Program Files\DanmakuVoice\danmakuvoice.exe"),
            Path::new("C:\\Data Folder\\"),
        )
        .unwrap();
        assert_eq!(
            String::from_utf16(&line).unwrap(),
            r#""C:\Program Files\DanmakuVoice\danmakuvoice.exe" --data-dir "C:\Data Folder\\""#
        );
    }
}
