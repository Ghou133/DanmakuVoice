//! Current-user Windows DPAPI wrapper. No machine-wide protection flag is used.

use std::fmt;
use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("凭据为空 [DV-K01]")]
    Empty,
    #[error("凭据超过系统加密接口的长度限制 [DV-K02]")]
    TooLarge,
    #[error("Windows 凭据保护失败：{0} [DV-K03]")]
    Protect(std::io::Error),
    #[error("Windows 凭据解密失败：{0} [DV-K04]")]
    Unprotect(std::io::Error),
    #[error("凭据不是 UTF-8 文本 [DV-K05]")]
    Utf8,
    #[error("此平台不支持 Windows 凭据保护 [DV-K06]")]
    UnsupportedPlatform,
}

pub struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub fn as_str(&self) -> Result<&str, SecretError> {
        std::str::from_utf8(&self.0).map_err(|_| SecretError::Utf8)
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBytes([redacted])")
    }
}

#[cfg(windows)]
mod platform {
    use super::{SecretBytes, SecretError};
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    use zeroize::Zeroizing;

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, SecretError> {
        if plaintext.is_empty() {
            return Err(SecretError::Empty);
        }
        let length = u32::try_from(plaintext.len()).map_err(|_| SecretError::TooLarge)?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: length,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: input points to plaintext for this call; output is initialized
        // by Windows and immediately copied and freed with LocalFree.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretError::Protect(std::io::Error::last_os_error()));
        }
        // SAFETY: a successful CryptProtectData returns cbData valid bytes.
        let result =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        // SAFETY: DPAPI requires LocalFree on its output allocation.
        unsafe {
            LocalFree(output.pbData.cast());
        }
        Ok(result)
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<SecretBytes, SecretError> {
        if ciphertext.is_empty() {
            return Err(SecretError::Empty);
        }
        let length = u32::try_from(ciphertext.len()).map_err(|_| SecretError::TooLarge)?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: length,
            pbData: ciphertext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: input stays alive; output belongs to DPAPI until LocalFree.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretError::Unprotect(std::io::Error::last_os_error()));
        }
        // SAFETY: a successful CryptUnprotectData returns cbData valid bytes.
        let result = unsafe {
            Zeroizing::new(
                std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
            )
        };
        // SAFETY: the returned plaintext allocation is writable for cbData
        // bytes. Erase that original Win32 buffer before releasing it; the
        // Rust copy is erased by Zeroizing when its owner is dropped.
        unsafe {
            ptr::write_bytes(output.pbData, 0, output.cbData as usize);
            LocalFree(output.pbData.cast());
        }
        Ok(SecretBytes(result))
    }
}

#[cfg(windows)]
pub use platform::{protect, unprotect};

#[cfg(not(windows))]
pub fn protect(_plaintext: &[u8]) -> Result<Vec<u8>, SecretError> {
    Err(SecretError::UnsupportedPlatform)
}
#[cfg(not(windows))]
pub fn unprotect(_ciphertext: &[u8]) -> Result<SecretBytes, SecretError> {
    Err(SecretError::UnsupportedPlatform)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn current_user_roundtrip_and_redacted_debug() {
        let original = b"local-only-secret-example";
        let protected = protect(original).unwrap();
        assert_ne!(protected, original);
        let recovered = unprotect(&protected).unwrap();
        assert_eq!(recovered.as_bytes(), original);
        assert_eq!(format!("{recovered:?}"), "SecretBytes([redacted])");
    }
}
