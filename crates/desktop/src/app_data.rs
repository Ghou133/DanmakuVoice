//! Stable per-user logical data location. Windows may virtualize Store I/O.
//!
//! Never derive configuration storage from the executable, its version, the
//! working directory, or a launcher's LOCALAPPDATA environment override.
//! Returning the logical path does not disable package file virtualization.
use std::path::PathBuf;

#[cfg(windows)]
pub fn local_app_data() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_LocalAppData, KF_FLAG_NO_PACKAGE_REDIRECTION, SHGetKnownFolderPath},
    };
    let mut pointer = std::ptr::null_mut();
    // SAFETY: Windows allocates the UTF-16 result for the current user. The
    // pointer is released exactly once with the matching COM allocator below.
    let status = unsafe {
        SHGetKnownFolderPath(
            &FOLDERID_LocalAppData,
            KF_FLAG_NO_PACKAGE_REDIRECTION as u32,
            std::ptr::null_mut(),
            &mut pointer,
        )
    };
    if status < 0 || pointer.is_null() {
        if !pointer.is_null() {
            // SAFETY: Even on failure, a non-null result belongs to COM.
            unsafe { CoTaskMemFree(pointer.cast()) };
        }
        return Err(format!(
            "无法找到 Windows AppData 目录（系统代码 {status:#x}）"
        ));
    }
    // SAFETY: A successful SHGetKnownFolderPath result is NUL-terminated UTF-16.
    let result = unsafe {
        let mut length = 0;
        while *pointer.add(length) != 0 {
            length += 1;
        }
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(pointer, length));
        CoTaskMemFree(pointer.cast());
        PathBuf::from(path)
    };
    if !result.is_absolute() {
        return Err("Windows 返回了无效的 AppData 目录".into());
    }
    Ok(result)
}

#[cfg(not(windows))]
pub fn local_app_data() -> Result<PathBuf, String> {
    Err("无法找到 Windows AppData 目录，请检查用户环境".into())
}

pub fn default_directory() -> Result<PathBuf, String> {
    Ok(local_app_data()?.join("DanmakuVoice"))
}
