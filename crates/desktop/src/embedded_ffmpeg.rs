//! MSIX runs FFmpeg directly from its protected package directory. Unpackaged
//! builds retain the existing verified cache for local development and legacy use.

use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const SHA256: &str = "8fb7ecc11f4f7a441ae7075a81c984289250b166e78dedf51900bbeb1a96ef4d";
const FFMPEG: &[u8] = include_bytes!("../embedded/ffmpeg.exe");

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir
        .join("cache")
        .join("ffmpeg")
        .join(format!("ffmpeg-{SHA256}.exe"))
}

fn valid_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !plain_file(&metadata) => {
            return Err(io::Error::other("音频组件缓存文件是重定向或特殊文件"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    }
    match fs::read(path) {
        Ok(bytes) => Ok(digest(&bytes) == SHA256),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn not_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

#[cfg(not(windows))]
fn not_reparse_point(metadata: &fs::Metadata) -> bool {
    !metadata.file_type().is_symlink()
}

fn plain_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && not_reparse_point(metadata)
}

fn plain_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && not_reparse_point(metadata)
}

fn ensure_directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    if !plain_directory(&fs::symlink_metadata(path)?) {
        return Err(io::Error::other("音频组件缓存目录是重定向或特殊目录"));
    }
    Ok(())
}

#[cfg(windows)]
fn replace_atomically(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: Both pointers refer to terminated UTF-16 paths and live for
    // the duration of this call. Both files are in the same cache directory.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_atomically(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

fn materialize(data_dir: &Path) -> io::Result<PathBuf> {
    if digest(FFMPEG) != SHA256 {
        return Err(io::Error::other("内置 FFmpeg 与已核验版本不符"));
    }
    let target = path(data_dir);
    let cache = target.parent().expect("managed FFmpeg path has parent");
    ensure_directory(&data_dir.join("cache"))?;
    ensure_directory(cache)?;
    if valid_file(&target)? {
        return Ok(target);
    }

    let temporary = cache.join(format!(".ffmpeg-{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(FFMPEG)?;
        file.sync_all()?;
        drop(file);

        // Replacement is atomic even when another instance repairs a damaged
        // cache at the same time. An in-use valid EXE may refuse replacement.
        if let Err(error) = replace_atomically(&temporary, &target)
            && !valid_file(&target)?
        {
            return Err(error);
        }
        if !valid_file(&target)? {
            return Err(io::Error::other("音频组件缓存校验失败"));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result.map(|()| target)
}

pub fn ensure(data_dir: &Path) -> Result<PathBuf, String> {
    if let Some(root) = crate::package::installed_root()? {
        return packaged_binary(&root).map_err(|error| {
            format!("应用安装包中的音频组件缺失或损坏，请通过 Microsoft Store 修复或重新安装：{error} [DV-C09]")
        });
    }
    materialize(data_dir).map_err(|error| {
        format!(
            "无法准备内置音频组件（{}）：{error}。请检查用户数据目录的写入权限 [DV-C08]",
            path(data_dir).display()
        )
    })
}

fn packaged_binary(root: &Path) -> io::Result<PathBuf> {
    // Do not copy this file to AppData: its trust is tied to the installed MSIX.
    // Never fall back to the embedded bytes if an installed package is damaged.
    let target = root.join("ffmpeg.exe");
    if !valid_file(&target)? {
        return Err(io::Error::other("FFmpeg 文件校验失败"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_ffmpeg_stays_in_the_package_and_rejects_damage() {
        let root = tempfile::tempdir().unwrap();
        assert!(packaged_binary(root.path()).is_err());
        let target = root.path().join("ffmpeg.exe");
        fs::write(&target, FFMPEG).unwrap();
        assert_eq!(packaged_binary(root.path()).unwrap(), target);
        assert!(!root.path().join("cache").exists());
        fs::write(&target, b"damaged").unwrap();
        assert!(packaged_binary(root.path()).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"damaged");
    }

    #[test]
    fn embedded_binary_matches_pinned_hash_and_repairs_cache() {
        let data = tempfile::tempdir().unwrap();
        let binary = ensure(data.path()).unwrap();
        assert_eq!(digest(&fs::read(&binary).unwrap()), SHA256);
        fs::write(&binary, b"corrupted").unwrap();
        assert_eq!(ensure(data.path()).unwrap(), binary);
        assert_eq!(digest(&fs::read(&binary).unwrap()), SHA256);
    }

    #[test]
    fn simultaneous_launches_share_one_verified_binary() {
        let data = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..6)
                .map(|_| scope.spawn(|| ensure(data.path())))
                .collect();
            for job in jobs {
                assert_eq!(job.join().unwrap().unwrap(), path(data.path()));
            }
        });
        assert!(valid_file(&path(data.path())).unwrap());
    }

    #[test]
    fn simultaneous_repairs_never_remove_the_verified_binary() {
        let data = tempfile::tempdir().unwrap();
        let binary = path(data.path());
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(&binary, b"corrupted").unwrap();
        std::thread::scope(|scope| {
            let jobs: Vec<_> = (0..6)
                .map(|_| scope.spawn(|| ensure(data.path())))
                .collect();
            for job in jobs {
                assert_eq!(job.join().unwrap().unwrap(), binary);
            }
        });
        assert!(valid_file(&binary).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn cache_directory_redirection_is_rejected() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::windows::fs::symlink_dir(outside.path(), data.path().join("cache")).unwrap();
        assert!(ensure(data.path()).unwrap_err().contains("重定向"));
        assert!(!outside.path().join("ffmpeg").exists());
    }

    #[cfg(windows)]
    #[test]
    fn materialized_ffmpeg_decodes_pcm_without_path_lookup() {
        use std::process::{Command, Stdio};

        let data = tempfile::tempdir().unwrap();
        let binary = ensure(data.path()).unwrap();
        let mut child = Command::new(binary)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "s16le",
                "-ar",
                "24000",
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-ac",
                "1",
                "-ar",
                "48000",
                "-f",
                "f32le",
                "pipe:1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&vec![0u8; 4_800])
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.len() >= 9_600);
    }
}
