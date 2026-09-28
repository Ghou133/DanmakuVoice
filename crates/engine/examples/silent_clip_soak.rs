//! Opt-in sustained playback probe using the real scheduler, FFmpeg, and CPAL.
//! It generates a silent managed sound asset in an isolated temporary profile.
//! This does not exercise Bilibili, TTS, the desktop UI, or audible output.

use danmakuvoice_engine::{
    audio::{AudioOutput, OutputSelection},
    model::LiveEvent,
    playback::{PlaybackExecutor, PreparedPlayback},
    rules::{EventTemplates, RuleSet, SoundRule},
    scheduler::{self, JobOrigin, JobState},
    storage::DataStore,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio::time::{Duration, timeout};

fn silent_wav(seconds: u32) -> Vec<u8> {
    const SAMPLE_RATE: u32 = 48_000;
    let data_bytes = SAMPLE_RATE * seconds * 2;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    wav.resize(44 + data_bytes as usize, 0);
    wav
}

fn args() -> Result<(PathBuf, Duration, u32), String> {
    let mut args = std::env::args().skip(1);
    let ffmpeg = PathBuf::from(
        args.next()
            .ok_or("用法：silent_clip_soak <ffmpeg.exe> <秒数> [音效秒数]")?,
    );
    if !ffmpeg.is_file() {
        return Err("找不到指定的 FFmpeg 可执行文件".into());
    }
    let seconds: u64 = args
        .next()
        .ok_or("缺少持续时间（秒）")?
        .parse()
        .map_err(|_| "持续时间必须是整数秒")?;
    let clip_seconds: u32 = args
        .next()
        .unwrap_or_else(|| "4".into())
        .parse()
        .map_err(|_| "音效时长必须是整数秒")?;
    if !(30..=3600).contains(&seconds) || !(1..=10).contains(&clip_seconds) || args.next().is_some()
    {
        return Err("持续时间须为 30 到 3600 秒，音效时长须为 1 到 10 秒".into());
    }
    Ok((ffmpeg, Duration::from_secs(seconds), clip_seconds))
}

fn clean_own_profile(profile: &Path, expected_name: &str) -> std::io::Result<()> {
    let temp = std::fs::canonicalize(std::env::temp_dir())?;
    let target = std::fs::canonicalize(profile)?;
    if target.parent() != Some(temp.as_path())
        || target.file_name().and_then(|name| name.to_str()) != Some(expected_name)
        || !expected_name.starts_with(&format!("DanmakuVoice-silent-soak-{}-", std::process::id()))
    {
        return Err(std::io::Error::other("隔离目录不在预期临时位置，拒绝清理"));
    }
    std::fs::remove_dir_all(target)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (ffmpeg, duration, clip_seconds) = args()?;
    let profile_name = format!(
        "DanmakuVoice-silent-soak-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let profile = std::env::temp_dir().join(&profile_name);
    std::fs::create_dir(&profile)?;
    let source = profile.join("source.wav");
    std::fs::write(&source, silent_wav(clip_seconds))?;
    let mut store = DataStore::open(profile.join("data"))?;
    let asset = store.import_asset(&source, "隔离静音音效")?;
    let rules = RuleSet {
        templates: EventTemplates {
            danmaku: "{message}".into(),
            ..Default::default()
        },
        sounds: vec![SoundRule {
            trigger: "静".into(),
            asset_id: asset.id,
        }],
        ..Default::default()
    };
    let preview = rules.preview(&LiveEvent::danmaku(1, None, "测试", "静"), &[], &[])?;
    assert!(!preview.needs_tts() && preview.has_playable_audio());
    let plan = PreparedPlayback::from_store(&store, &preview, None)?;

    // Both the generated PCM and master gain are zero. CPAL still opens a real
    // default device and drains the same bounded output ring as the desktop.
    let output = AudioOutput::open(&OutputSelection::Default, 0.0)?;
    let executor = PlaybackExecutor::new(output.writer.clone(), &ffmpeg)?;
    let queue = scheduler::spawn(Arc::new(executor));
    queue.start().await?;
    let began = Instant::now();
    let mut played = 0_u64;
    let mut previous_report = Duration::ZERO;
    eprintln!(
        "SOAK_START pid={} device={} profile={} seconds={} clip_seconds={}",
        std::process::id(),
        output.device_name,
        profile.display(),
        duration.as_secs(),
        clip_seconds
    );
    while began.elapsed() < duration {
        let id = queue
            .submit_prepared(preview.clone(), JobOrigin::Live, plan.clone())
            .await
            .map_err(|error| format!("入队失败：{error:?}"))?;
        let mut updates = queue.state();
        timeout(Duration::from_secs(15), async {
            loop {
                let snapshot = updates.borrow().clone();
                if let Some(record) = snapshot.history.iter().find(|entry| entry.id == id) {
                    assert_eq!(record.state, JobState::Played, "{record:?}");
                    assert!(snapshot.pending.len() <= 64);
                    assert!(snapshot.history.len() <= 100);
                    return;
                }
                updates.changed().await.expect("调度器意外关闭");
            }
        })
        .await
        .map_err(|_| format!("任务 {id} 在 15 秒内未完成"))?;
        played += 1;
        if began.elapsed().saturating_sub(previous_report) >= Duration::from_secs(30) {
            previous_report = began.elapsed();
            eprintln!(
                "SOAK_PROGRESS elapsed_secs={} played={} ring_samples={} underruns={}",
                began.elapsed().as_secs(),
                played,
                output.writer.queued_samples(),
                output.writer.underruns()
            );
        }
    }
    queue.stop_all().await?;
    let snapshot = queue.state().borrow().clone();
    assert!(!snapshot.accepting && snapshot.current.is_none() && snapshot.pending.is_empty());
    assert_eq!(output.writer.queued_samples(), 0);
    eprintln!(
        "SOAK_DONE elapsed_secs={} played={} history={} ring_samples={} underruns={}",
        began.elapsed().as_secs(),
        played,
        snapshot.history.len(),
        output.writer.queued_samples(),
        output.writer.underruns()
    );
    drop(store);
    drop(queue);
    drop(output);
    clean_own_profile(&profile, &profile_name)?;
    eprintln!("SOAK_CLEANED profile={}", profile.display());
    Ok(())
}
