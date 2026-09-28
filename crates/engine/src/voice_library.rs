//! Read-only GPT-SoVITS model discovery and original-file reference profiles.
//!
//! The pairing rule follows kinoko7danmaku's `sovits_models.py`: scan only
//! corresponding version directories, prefer equal stems, then compare names
//! after removing a trailing training-step suffix. Checkpoints are never read.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::Provider;
use crate::tts::sovits::SovitsLanguage;

const VERSIONS: [&str; 6] = ["v1", "v2", "v2Pro", "v2ProPlus", "v3", "v4"];
const MAX_SCAN_FILES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 16;

#[derive(Debug, Error)]
pub enum ModelScanError {
    #[error("请选择包含 api_v2.py 的 GPT-SoVITS 安装目录")]
    InvalidInstallation,
    #[error("模型目录读取失败：{0}")]
    Io(#[from] io::Error),
    #[error("模型目录文件数量或深度超出扫描上限")]
    ScanLimit,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelPair {
    pub name: String,
    pub version: String,
    pub gpt_path: PathBuf,
    pub sovits_path: PathBuf,
}

impl ModelPair {
    pub fn label(&self) -> String {
        format!("{} · {}", self.name, self.version)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelIssueKind {
    MissingSovits,
    AmbiguousSovits,
    UnpairedSovits,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelIssue {
    pub version: String,
    pub path: PathBuf,
    pub kind: ModelIssueKind,
    pub candidates: Vec<PathBuf>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelScan {
    pub pairs: Vec<ModelPair>,
    pub issues: Vec<ModelIssue>,
}

/// Discover model pairs without opening `.ckpt` or `.pth` contents. Symlinked
/// directories and files are skipped so scans stay within the chosen tree.
pub fn scan_sovits_models(root: &Path) -> Result<ModelScan, ModelScanError> {
    if !root.join("api_v2.py").is_file() {
        return Err(ModelScanError::InvalidInstallation);
    }
    let root = root.canonicalize()?;
    let mut scan = ModelScan::default();
    let mut visited = 0;
    for version in VERSIONS {
        let suffix = if version == "v1" {
            String::new()
        } else {
            format!("_{version}")
        };
        let gpts = collect_weights(
            &root.join(format!("GPT_weights{suffix}")),
            "ckpt",
            &mut visited,
        )?;
        let sovits = collect_weights(
            &root.join(format!("SoVITS_weights{suffix}")),
            "pth",
            &mut visited,
        )?;
        let mut used = Vec::new();
        for gpt in gpts {
            let stem = gpt.file_stem().and_then(|name| name.to_str()).unwrap_or("");
            let exact: Vec<&PathBuf> = sovits
                .iter()
                .filter(|path| path.file_stem().and_then(|name| name.to_str()) == Some(stem))
                .collect();
            let matches = if exact.is_empty() {
                sovits
                    .iter()
                    .filter(|path| {
                        path.file_stem()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| model_name(name) == model_name(stem))
                    })
                    .collect::<Vec<_>>()
            } else {
                exact
            };
            if matches.len() == 1 {
                let sovits_path = matches[0].clone();
                used.push(sovits_path.clone());
                scan.pairs.push(ModelPair {
                    name: model_name(stem).to_owned(),
                    version: version.to_owned(),
                    gpt_path: gpt,
                    sovits_path,
                });
            } else {
                scan.issues.push(ModelIssue {
                    version: version.to_owned(),
                    path: gpt,
                    kind: if matches.is_empty() {
                        ModelIssueKind::MissingSovits
                    } else {
                        ModelIssueKind::AmbiguousSovits
                    },
                    candidates: matches.into_iter().cloned().collect(),
                });
            }
        }
        for path in sovits {
            if !used.contains(&path) {
                scan.issues.push(ModelIssue {
                    version: version.to_owned(),
                    path,
                    kind: ModelIssueKind::UnpairedSovits,
                    candidates: Vec::new(),
                });
            }
        }
    }
    Ok(scan)
}

fn collect_weights(
    root: &Path,
    extension: &str,
    visited: &mut usize,
) -> Result<Vec<PathBuf>, ModelScanError> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_SCAN_DEPTH {
            return Err(ModelScanError::ScanLimit);
        }
        let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(fs::DirEntry::path);
        for entry in entries {
            *visited += 1;
            if *visited > MAX_SCAN_FILES {
                return Err(ModelScanError::ScanLimit);
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                stack.push((path, depth + 1));
            } else if file_type.is_file()
                && path
                    .extension()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case(extension))
            {
                result.push(path);
            }
        }
    }
    result.sort();
    Ok(result)
}

fn model_name(stem: &str) -> &str {
    let mut candidate = stem;
    if let Some(prefix) = strip_training_suffix(candidate, b'l') {
        candidate = prefix;
    }
    if let Some(prefix) = strip_training_suffix(candidate, b's') {
        candidate = prefix;
    }
    strip_training_suffix(candidate, b'e').unwrap_or(stem)
}

fn strip_training_suffix(stem: &str, letter: u8) -> Option<&str> {
    let split = stem.rfind(['-', '_'])?;
    let suffix = stem.get(split + 1..)?.as_bytes();
    if suffix.len() >= 2
        && suffix[0].eq_ignore_ascii_case(&letter)
        && suffix[1..].iter().all(u8::is_ascii_digit)
    {
        stem.get(..split)
    } else {
        None
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReferenceRole {
    /// Stable custom role name chosen by the user for dots.tts.
    Dots { role: String },
    /// Exact pair of paths selected from `scan_sovits_models`.
    GptSovits {
        gpt_weights_path: String,
        sovits_weights_path: String,
    },
}

impl ReferenceRole {
    pub fn provider(&self) -> Provider {
        match self {
            Self::Dots { .. } => Provider::Dots,
            Self::GptSovits { .. } => Provider::GptSovits,
        }
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::Dots { role } => valid_label(role, 256),
            Self::GptSovits {
                gpt_weights_path,
                sovits_weights_path,
            } => valid_label(gpt_weights_path, 4096) && valid_label(sovits_weights_path, 4096),
        }
    }

    pub(crate) fn storage_key(&self) -> String {
        // String-only serialization is infallible. Normalizing separators and
        // case on Windows mirrors old os.path.normcase behavior.
        let normalized = match self {
            Self::Dots { role } => Self::Dots { role: role.clone() },
            Self::GptSovits {
                gpt_weights_path,
                sovits_weights_path,
            } => Self::GptSovits {
                gpt_weights_path: normalize_model_path(gpt_weights_path),
                sovits_weights_path: normalize_model_path(sovits_weights_path),
            },
        };
        serde_json::to_string(&normalized).expect("reference role contains only strings")
    }
}

fn normalize_model_path(path: &str) -> String {
    if cfg!(windows) {
        let path = path.replace('/', "\\").to_lowercase();
        if let Some(server_path) = path.strip_prefix("\\\\?\\unc\\") {
            format!("\\\\{server_path}")
        } else {
            path.strip_prefix("\\\\?\\").unwrap_or(&path).to_owned()
        }
    } else {
        path.to_owned()
    }
}

fn valid_label(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReferenceProfile {
    pub connection_id: String,
    pub role: ReferenceRole,
    /// Original absolute file chosen by the user. It is never copied.
    pub audio_path: String,
    pub reference_text: String,
    /// GPT-SoVITS API code, e.g. `auto` or `all_zh`.
    pub reference_language: String,
    /// GPT-SoVITS API code, e.g. `auto` or `all_zh`.
    pub text_language: String,
    pub text_free: bool,
}

impl ReferenceProfile {
    pub fn is_valid(&self) -> bool {
        if !valid_label(&self.connection_id, 256)
            || !self.role.is_valid()
            || !Path::new(&self.audio_path).is_absolute()
            || self.audio_path.len() > 4096
            || self.reference_text.len() > 8192
        {
            return false;
        }
        match self.role {
            ReferenceRole::Dots { .. } => true,
            ReferenceRole::GptSovits { .. } => {
                SovitsLanguage::from_api_code(&self.reference_language).is_some()
                    && SovitsLanguage::from_api_code(&self.text_language).is_some()
                    && (self.text_free || !self.reference_text.trim().is_empty())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_version_exact_first_and_ambiguous_pairs_are_visible() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("api_v2.py"), b"").unwrap();
        let gpt = temp.path().join("GPT_weights_v2/sub");
        let sovits = temp.path().join("SoVITS_weights_v2/other");
        fs::create_dir_all(&gpt).unwrap();
        fs::create_dir_all(&sovits).unwrap();
        for name in ["Alice-e15.ckpt", "Bob-e2.ckpt", "Cora-e3.ckpt"] {
            fs::write(gpt.join(name), b"not opened").unwrap();
        }
        for name in [
            "Alice-e15.pth",
            "Alice_e6_s2370_l32.pth",
            "Bob_e6_s2370_l32.pth",
            "Cora_e1.pth",
            "Cora_e2.pth",
        ] {
            fs::write(sovits.join(name), b"not opened").unwrap();
        }
        // A same-name file in another version must not pair with v2.
        let wrong_version = temp.path().join("SoVITS_weights_v3");
        fs::create_dir_all(&wrong_version).unwrap();
        fs::write(wrong_version.join("Nobody_e1.pth"), b"").unwrap();

        let scan = scan_sovits_models(temp.path()).unwrap();
        assert_eq!(scan.pairs.len(), 2);
        assert_eq!(scan.pairs[0].name, "Alice");
        assert!(scan.pairs[0].sovits_path.ends_with("Alice-e15.pth"));
        assert_eq!(scan.pairs[1].name, "Bob");
        assert!(scan.pairs[1].sovits_path.ends_with("Bob_e6_s2370_l32.pth"));
        assert!(scan.issues.iter().any(|issue| {
            issue.kind == ModelIssueKind::AmbiguousSovits && issue.path.ends_with("Cora-e3.ckpt")
        }));
        assert!(scan.issues.iter().any(|issue| {
            issue.kind == ModelIssueKind::UnpairedSovits && issue.path.ends_with("Nobody_e1.pth")
        }));
    }

    #[test]
    fn pair_key_normalizes_windows_path_spellings_and_profile_checks_languages() {
        let first = ReferenceRole::GptSovits {
            gpt_weights_path: "C:/Models/A.ckpt".into(),
            sovits_weights_path: "C:/Models/B.pth".into(),
        };
        let second = ReferenceRole::GptSovits {
            gpt_weights_path: "c:\\models\\a.ckpt".into(),
            sovits_weights_path: "c:\\models\\b.pth".into(),
        };
        if cfg!(windows) {
            assert_eq!(first.storage_key(), second.storage_key());
            let verbatim = ReferenceRole::GptSovits {
                gpt_weights_path: "\\\\?\\C:\\Models\\A.ckpt".into(),
                sovits_weights_path: "\\\\?\\C:\\Models\\B.pth".into(),
            };
            assert_eq!(first.storage_key(), verbatim.storage_key());
        }
        let mut profile = ReferenceProfile {
            connection_id: "gpt".into(),
            role: first,
            audio_path: std::env::current_dir()
                .unwrap()
                .join("reference.wav")
                .to_string_lossy()
                .into_owned(),
            reference_text: "这是一段参考文本".into(),
            reference_language: "all_zh".into(),
            text_language: "auto".into(),
            text_free: false,
        };
        assert!(profile.is_valid());
        profile.text_language = "invalid".into();
        assert!(!profile.is_valid());
    }
}
