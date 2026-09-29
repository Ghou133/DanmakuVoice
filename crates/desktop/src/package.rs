//! Resolve the OS package identity, never infer it from a filename or a marker.
use std::path::PathBuf;

#[cfg(windows)]
pub fn installed_root() -> Result<Option<PathBuf>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS},
        Storage::Packaging::Appx::GetCurrentPackagePath,
    };
    let mut length = 0;
    // SAFETY: The first call obtains the required UTF-16 buffer size.
    let result = unsafe { GetCurrentPackagePath(&mut length, std::ptr::null_mut()) };
    if result == APPMODEL_ERROR_NO_PACKAGE {
        return Ok(None);
    }
    if result != ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 32768 {
        return Err(format!("无法读取应用安装信息（系统代码 {result}）[DV-X15]"));
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: The buffer has the size returned by Windows and lives through the call.
    let result = unsafe { GetCurrentPackagePath(&mut length, buffer.as_mut_ptr()) };
    if result != ERROR_SUCCESS || length == 0 || length as usize > buffer.len() {
        return Err(format!("无法读取应用安装目录（系统代码 {result}）[DV-X15]"));
    }
    buffer.truncate(length as usize - 1);
    Ok(Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer))))
}

#[cfg(not(windows))]
pub fn installed_root() -> Result<Option<PathBuf>, String> {
    Ok(None)
}
