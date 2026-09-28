//! Checks only this project's public stable GitHub releases. No credentials,
//! installation paths or account details leave the machine.
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const REPOSITORY: &str = "https://github.com/Ghou133/DanmakuVoice";
pub const RELEASES: &str = "https://github.com/Ghou133/DanmakuVoice/releases/latest";
const API: &str = "https://api.github.com/repos/Ghou133/DanmakuVoice/releases/latest";
const MAX_RESPONSE: usize = 1024 * 1024;
const CACHE_TIME: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
pub struct UpdateInfo {
    pub current_version: &'static str,
    pub latest_version: Option<String>,
    pub status: &'static str,
    pub release_url: String,
    pub download_url: Option<String>,
}

impl UpdateInfo {
    fn no_release() -> Self {
        Self {
            current_version: env!("CARGO_PKG_VERSION"),
            latest_version: None,
            status: "no_release",
            release_url: RELEASES.into(),
            download_url: None,
        }
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    state: String,
    size: u64,
}

fn parse_release(bytes: &[u8], current: &str) -> Result<UpdateInfo, String> {
    let release: Release =
        serde_json::from_slice(bytes).map_err(|_| "GitHub 返回的版本信息格式无效，请稍后重试")?;
    let version = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .map_err(|_| "GitHub 版本号格式无效")?;
    if release.draft || release.prerelease || !version.pre.is_empty() {
        return Ok(UpdateInfo::no_release());
    }
    let current = Version::parse(current).map_err(|_| "当前程序版本号无效")?;
    // Build metadata cannot trigger an upgrade, and older releases never downgrade.
    let newer = version.cmp_precedence(&current).is_gt();
    let release_url = format!("{REPOSITORY}/releases/tag/{}", release.tag_name);
    // Prefer the compressed distribution; keep support for older EXE-only releases.
    let download = ["DanmakuVoice-windows-x64.zip", "DanmakuVoice.exe"]
        .iter()
        .find_map(|name| {
            let expected = format!("{REPOSITORY}/releases/download/{}/{name}", release.tag_name);
            release
                .assets
                .iter()
                .any(|asset| {
                    asset.name == *name
                        && asset.browser_download_url == expected
                        && asset.state == "uploaded"
                        && asset.size > 0
                })
                .then_some(expected)
        });
    Ok(UpdateInfo {
        status: if newer { "available" } else { "up_to_date" },
        latest_version: Some(version.to_string()),
        release_url,
        download_url: if newer { download } else { None },
        ..UpdateInfo::no_release()
    })
}

fn http_error(status: StatusCode) -> String {
    match status {
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            "GitHub 暂时限制了检查频率，请稍后重试或打开发布页面".into()
        }
        _ => format!("GitHub 检查失败（HTTP {}），请稍后重试", status.as_u16()),
    }
}

async fn fetch(client: &Client, api: &str) -> Result<UpdateInfo, String> {
    let mut response = client
        .get(api)
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络后重试")?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(UpdateInfo::no_release());
    }
    if response.status() != StatusCode::OK {
        return Err(http_error(response.status()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err("GitHub 版本信息超出大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 GitHub 版本信息失败，请重试")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err("GitHub 版本信息超出大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_release(&bytes, env!("CARGO_PKG_VERSION"))
}

#[derive(Default)]
pub struct UpdateChecker(Mutex<Option<(Instant, Result<UpdateInfo, String>)>>);

impl UpdateChecker {
    pub async fn check(&self, network_disabled: bool) -> Result<UpdateInfo, String> {
        if network_disabled {
            return Err("离线测试模式不检查更新".into());
        }
        let mut cache = self.0.lock().await;
        if let Some((time, result)) = &*cache
            && time.elapsed() < CACHE_TIME
        {
            return result.clone();
        }
        let client = Client::builder()
            .user_agent(concat!("DanmakuVoice/", env!("CARGO_PKG_VERSION")))
            .default_headers(
                [
                    (
                        reqwest::header::ACCEPT,
                        "application/vnd.github+json".parse().unwrap(),
                    ),
                    (
                        reqwest::header::HeaderName::from_static("x-github-api-version"),
                        "2026-03-10".parse().unwrap(),
                    ),
                ]
                .into_iter()
                .collect(),
            )
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "无法初始化更新检查")?;
        let result = fetch(&client, API).await;
        *cache = Some((Instant::now(), result.clone()));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str) -> serde_json::Value {
        json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":[{
            "name":"DanmakuVoice.exe","state":"uploaded","size":123,
            "browser_download_url":format!("{REPOSITORY}/releases/download/{tag}/DanmakuVoice.exe")
        }]})
    }

    #[test]
    fn semantic_versions_ignore_build_metadata_and_never_downgrade() {
        for (tag, current, expected) in [
            ("v0.10.0", "0.9.0", "available"),
            ("0.2.0", "0.2.0", "up_to_date"),
            ("v0.1.0", "0.2.0", "up_to_date"),
            ("v0.2.0+build9", "0.2.0+build1", "up_to_date"),
            ("v0.2.0", "0.2.0-rc.1", "available"),
            ("v0.3.0-beta.1", "0.2.0", "no_release"),
        ] {
            let info = parse_release(&serde_json::to_vec(&release(tag)).unwrap(), current).unwrap();
            assert_eq!(info.status, expected, "{tag}");
            assert_eq!(info.download_url.is_some(), expected == "available");
        }
    }

    #[test]
    fn rejects_bad_tags_and_untrusted_downloads() {
        for tag in ["latest", "v1", "v1.2.3/../../other", "v01.2.3"] {
            assert!(parse_release(&serde_json::to_vec(&release(tag)).unwrap(), "0.2.0").is_err());
        }
        for field in ["draft", "prerelease"] {
            let mut data = release("v1.0.0");
            data[field] = json!(true);
            assert_eq!(
                parse_release(&serde_json::to_vec(&data).unwrap(), "0.2.0")
                    .unwrap()
                    .status,
                "no_release"
            );
        }
        for value in [
            "https://example.com/evil.exe",
            "https://github.com/other/repo/releases/download/v1.0.0/DanmakuVoice.exe",
        ] {
            let mut data = release("v1.0.0");
            data["assets"][0]["browser_download_url"] = json!(value);
            assert!(
                parse_release(&serde_json::to_vec(&data).unwrap(), "0.2.0")
                    .unwrap()
                    .download_url
                    .is_none()
            );
        }
        let mut data = release("v1.0.0");
        data["assets"] = json!([]);
        assert!(
            parse_release(&serde_json::to_vec(&data).unwrap(), "0.2.0")
                .unwrap()
                .download_url
                .is_none()
        );
    }

    #[test]
    fn prefers_zip_and_falls_back_only_to_valid_exe() {
        let mut data = release("v1.0.0");
        let zip_url = format!("{REPOSITORY}/releases/download/v1.0.0/DanmakuVoice-windows-x64.zip");
        let zip = json!({"name":"DanmakuVoice-windows-x64.zip", "state":"uploaded",
            "size":42, "browser_download_url":zip_url});
        data["assets"].as_array_mut().unwrap().push(zip.clone());
        let parse = |data: &serde_json::Value| {
            parse_release(&serde_json::to_vec(data).unwrap(), "0.2.0").unwrap()
        };
        assert_eq!(parse(&data).download_url.as_deref(), Some(zip_url.as_str()));
        // GitHub may return assets in either order, including EXE first.
        data["assets"].as_array_mut().unwrap().reverse();
        assert_eq!(parse(&data).download_url.as_deref(), Some(zip_url.as_str()));
        for (field, bad_value) in [
            (
                "browser_download_url",
                json!("https://example.com/evil.zip"),
            ),
            ("state", json!("starter")),
            ("size", json!(0)),
            ("name", json!("DanmakuVoice-source.zip")),
        ] {
            data["assets"][0] = zip.clone();
            data["assets"][0][field] = bad_value;
            assert!(
                parse(&data)
                    .download_url
                    .unwrap()
                    .ends_with("/DanmakuVoice.exe")
            );
            let zip_only = json!({"tag_name":"v1.0.0", "draft":false, "prerelease":false,
                "assets":[data["assets"][0].clone()]});
            assert!(parse(&zip_only).download_url.is_none());
        }
        data["assets"] = json!([zip]);
        assert_eq!(parse(&data).download_url.as_deref(), Some(zip_url.as_str()));
    }

    #[tokio::test]
    async fn offline_and_cached_checks_make_no_requests() {
        let checker = UpdateChecker::default();
        assert!(checker.check(true).await.unwrap_err().contains("离线"));
        *checker.0.lock().await = Some((Instant::now(), Ok(UpdateInfo::no_release())));
        assert_eq!(checker.check(false).await.unwrap().status, "no_release");
        *checker.0.lock().await = Some((Instant::now(), Err("cached error".into())));
        assert_eq!(checker.check(false).await.unwrap_err(), "cached error");
    }

    #[tokio::test]
    async fn http_failures_and_bounded_responses() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, length, expected) in [
            (404, "", 0, "no_release"),
            (403, "", 0, "频率"),
            (429, "", 0, "频率"),
            (500, "", 0, "HTTP 500"),
            (200, "not json", 8, "格式无效"),
            (200, "", MAX_RESPONSE + 1, "大小限制"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).await.unwrap();
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}"
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
            });
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            let result = fetch(&client, &format!("http://{addr}")).await;
            if status == 404 {
                assert_eq!(result.unwrap().status, expected);
            } else {
                assert!(result.unwrap_err().contains(expected));
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    #[ignore = "requires the public GitHub release; run explicitly after publication"]
    async fn published_release_is_current() {
        let info = UpdateChecker::default().check(false).await.unwrap();
        assert_eq!(info.status, "up_to_date");
        assert_eq!(
            info.latest_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }
}
