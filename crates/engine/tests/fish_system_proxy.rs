//! Exercise the real Windows system-proxy path in an isolated process and
//! private registry tree. Never modify the user's Internet Settings or keys.
#![cfg(windows)]

use danmakuvoice_engine::tts::fish::{self, FishClient, FishConfig};
use std::{process::Command, ptr::null_mut, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::System::Registry::*;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

struct PrivateRegistry {
    key: HKEY,
    path: Vec<u16>,
}
impl PrivateRegistry {
    fn proxy(port: u16) -> Self {
        let path = wide(&format!(
            "Software\\DanmakuVoice-ProxyTest-{}",
            std::process::id()
        ));
        let mut key = null_mut();
        unsafe {
            assert_eq!(
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    null_mut(),
                    REG_OPTION_VOLATILE,
                    KEY_ALL_ACCESS,
                    null_mut(),
                    &mut key,
                    null_mut()
                ),
                0
            );
        }
        let registry = Self { key, path };
        let settings_path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
        let mut settings = null_mut();
        unsafe {
            assert_eq!(
                RegCreateKeyExW(
                    key,
                    settings_path.as_ptr(),
                    0,
                    null_mut(),
                    REG_OPTION_VOLATILE,
                    KEY_ALL_ACCESS,
                    null_mut(),
                    &mut settings,
                    null_mut()
                ),
                0
            );
            let enabled = 1u32.to_le_bytes();
            assert_eq!(
                RegSetValueExW(
                    settings,
                    wide("ProxyEnable").as_ptr(),
                    0,
                    REG_DWORD,
                    enabled.as_ptr(),
                    enabled.len() as u32
                ),
                0
            );
            let proxy = if std::env::var("DANMAKUVOICE_PROXY_TEST_MODE").as_deref() == Ok("shared")
            {
                wide(&format!("127.0.0.1:{port}"))
            } else {
                wide(&format!("http=127.0.0.1:{port};https=127.0.0.1:{port}"))
            };
            assert_eq!(
                RegSetValueExW(
                    settings,
                    wide("ProxyServer").as_ptr(),
                    0,
                    REG_SZ,
                    proxy.as_ptr().cast(),
                    (proxy.len() * 2) as u32
                ),
                0
            );
            RegCloseKey(settings);
            assert_eq!(RegOverridePredefKey(HKEY_CURRENT_USER, key), 0);
        }
        registry
    }
}
impl Drop for PrivateRegistry {
    fn drop(&mut self) {
        unsafe {
            RegOverridePredefKey(HKEY_CURRENT_USER, null_mut());
            RegCloseKey(self.key);
            RegDeleteTreeW(HKEY_CURRENT_USER, self.path.as_ptr());
        }
    }
}

#[test]
fn fish_account_voice_and_synthesis_follow_windows_proxy() {
    for mode in ["shared", "per-protocol"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "proxy_child", "--ignored", "--nocapture"])
            .env("DANMAKUVOICE_PROXY_TEST_CHILD", "1")
            .env("DANMAKUVOICE_PROXY_TEST_MODE", mode)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY")
            .env_remove("NO_PROXY")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires an explicitly selected live local HTTP proxy; sends no user credentials"]
async fn online_proxy_reaches_fish_credit_endpoint() {
    let port = std::env::var("DANMAKUVOICE_TEST_PROXY_PORT")
        .expect("explicit local proxy port required")
        .parse::<u16>()
        .unwrap();
    let _registry = PrivateRegistry::proxy(port);
    let error = fish::verify_api_key(
        "sk-test-only-invalid-key-123456789",
        &CancellationToken::new(),
    )
    .await
    .expect_err("Test-only key must not authenticate an account");
    assert!(
        matches!(
            error,
            danmakuvoice_engine::tts::TtsError::HttpStatus { status: 401, .. }
        ),
        "{error}"
    );
    println!(
        "Fish credit endpoint reached through Windows proxy: HTTP 401; no user credentials or synthesis used"
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "isolated helper invoked by the parent test"]
async fn proxy_child() {
    assert_eq!(
        std::env::var("DANMAKUVOICE_PROXY_TEST_CHILD").as_deref(),
        Ok("1")
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let _registry = PrivateRegistry::proxy(listener.local_addr().unwrap().port());
    let proxy = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut bytes = [0; 1024];
                let size = socket.read(&mut bytes).await.unwrap();
                assert!(size > 0 && request.len() < 8192);
                request.extend_from_slice(&bytes[..size]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("CONNECT api.fish.audio:443 HTTP/1.1\r\n"));
            assert!(!request.to_ascii_lowercase().contains("authorization"));
            assert!(!request.contains("test-only-proxy-key-123456789"));
            socket.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(8), async {
        let cancel = CancellationToken::new();
        assert!(
            fish::verify_api_key("test-only-proxy-key-123456789", &cancel)
                .await
                .is_err()
        );
        let client = FishClient::new(FishConfig::new(
            "test-only-proxy-key-123456789",
            fish::DEFAULT_VOICE_ID,
        ))
        .unwrap();
        assert!(client.voice_name(&cancel).await.is_err());
        let mut audio = client.stream("proxy routing test", &cancel).unwrap();
        assert!(audio.recv().await.unwrap().is_err());
        proxy.await.unwrap();
    })
    .await
    .expect("Fish requests bypassed the configured Windows proxy");
}
