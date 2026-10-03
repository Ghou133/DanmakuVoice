//! Incremental FFmpeg decode/resample/atempo process feeding the CPAL buffer.
//! The caller supplies an explicit executable path shipped with the app.

use crate::audio::{AudioError, AudioWriter};
use crate::tts::{AudioEncoding, AudioStream};
use crate::wav::{WavError, WavPcmParser};
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("找不到音频组件 ffmpeg.exe")]
    MissingFfmpeg,
    #[error("找不到音效文件")]
    MissingSound,
    #[error("音频播放已取消")]
    Cancelled,
    #[error("音频组件无法启动：{0}")]
    Start(#[source] io::Error),
    #[error("音频输入或输出中断：{0}")]
    Pipe(#[source] io::Error),
    #[error("语音服务失败：{0}")]
    Tts(String),
    #[error("音频组件无法解码此音频，退出码：{0:?}")]
    InvalidAudio(Option<i32>),
    #[error("音频管道关闭，音频组件退出码：{0:?}")]
    ProcessExit(Option<i32>),
    #[error("音频格式未对齐或数据截断")]
    Misaligned,
    #[error("WAV 流无效：{0}")]
    Wav(#[from] WavError),
    #[error("音频输出失败：{0}")]
    Output(#[from] AudioError),
    #[error("不支持的语速，范围为 0.5 到 2.0")]
    InvalidSpeed,
    #[error("不支持的语音音量，范围为 0 到 2.0")]
    InvalidVolume,
}

pub struct TtsPlayback<'a> {
    pub speed: f32,
    pub voice_volume: f32,
    pub speech_progress: &'a AtomicBool,
}

fn ensure_ffmpeg(path: &Path) -> Result<(), DecodeError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(DecodeError::MissingFfmpeg)
    }
}

fn output_args(command: &mut Command, output: &AudioWriter, speed: f32) -> Result<(), DecodeError> {
    if !speed.is_finite() || !(0.5..=2.0).contains(&speed) {
        return Err(DecodeError::InvalidSpeed);
    }
    command.args(["-vn", "-sn", "-dn"]);
    if (speed - 1.0).abs() > 0.0001 {
        command.args(["-af", &format!("atempo={speed:.4}")]);
    }
    command.args([
        "-ac",
        &output.channels.to_string(),
        "-ar",
        &output.sample_rate.to_string(),
        "-f",
        "f32le",
        "pipe:1",
    ]);
    Ok(())
}

fn base_command(path: &Path) -> Result<Command, DecodeError> {
    ensure_ffmpeg(path)?;
    let mut command = Command::new(path);
    #[cfg(windows)]
    hide_console(&mut command);
    command.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    command.kill_on_drop(true);
    command.stderr(Stdio::null());
    command.stdout(Stdio::piped());
    Ok(command)
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    command.creation_flags(CREATE_NO_WINDOW);
}

/// Decode a TTS response as it arrives. PCM from dots.tts receives a local
/// `atempo` filter, never a server-side speed value. The per-voice gain applies
/// only to this speech fragment; the CPAL master gain applies to all audio.
pub async fn play_tts(
    ffmpeg_path: &Path,
    mut stream: AudioStream,
    output: &AudioWriter,
    job_id: u64,
    playback: TtsPlayback<'_>,
    cancel: &CancellationToken,
) -> Result<(), DecodeError> {
    if !playback.voice_volume.is_finite() || !(0.0..=2.0).contains(&playback.voice_volume) {
        return Err(DecodeError::InvalidVolume);
    }
    let encoding = stream.encoding();
    let mut wav_parser = if encoding == AudioEncoding::Wav {
        Some(WavPcmParser::default())
    } else {
        None
    };
    let mut initial_pcm = Vec::new();
    if let Some(parser) = wav_parser.as_mut() {
        while parser.format().is_none() {
            let packet = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(DecodeError::Cancelled),
                packet = stream.recv() => packet,
            };
            let packet = packet
                .ok_or(WavError::NoAudio)?
                .map_err(|error| DecodeError::Tts(error.to_string()))?;
            initial_pcm.extend(parser.feed(&packet)?);
        }
    }
    let mut command = base_command(ffmpeg_path)?;
    match encoding {
        AudioEncoding::Wav => {
            let format = wav_parser
                .as_ref()
                .and_then(WavPcmParser::format)
                .expect("header parsed");
            command.args([
                "-f",
                "s16le",
                "-ar",
                &format.sample_rate.to_string(),
                "-ac",
                &format.channels.to_string(),
            ]);
        }
        AudioEncoding::AacAdts => {
            command.args(["-f", "aac"]);
        }
        AudioEncoding::PcmS16Le {
            sample_rate,
            channels,
        } => {
            if sample_rate == 0 || channels == 0 {
                return Err(DecodeError::Misaligned);
            }
            command.args([
                "-f",
                "s16le",
                "-ar",
                &sample_rate.to_string(),
                "-ac",
                &channels.to_string(),
            ]);
        }
    }
    command.args(["-i", "pipe:0"]);
    output_args(&mut command, output, playback.speed)?;
    command.stdin(Stdio::piped());
    let mut child = command.spawn().map_err(DecodeError::Start)?;
    let mut stdin = child.stdin.take().expect("piped ffmpeg stdin");
    let stdout = child.stdout.take().expect("piped ffmpeg stdout");
    let feeder = async move {
        if !initial_pcm.is_empty() {
            stdin
                .write_all(&initial_pcm)
                .await
                .map_err(DecodeError::Pipe)?;
        }
        while let Some(chunk) = stream.recv().await {
            let bytes = chunk.map_err(|error| DecodeError::Tts(error.to_string()))?;
            if let Some(parser) = wav_parser.as_mut() {
                let pcm = parser.feed(&bytes)?;
                if !pcm.is_empty() {
                    stdin.write_all(&pcm).await.map_err(DecodeError::Pipe)?;
                }
            } else {
                stdin.write_all(&bytes).await.map_err(DecodeError::Pipe)?;
            }
        }
        if let Some(parser) = &wav_parser {
            parser.finish()?;
        }
        stdin.shutdown().await.map_err(DecodeError::Pipe)
    };
    let reader = read_pcm(
        stdout,
        output,
        job_id,
        playback.voice_volume,
        cancel,
        Some(playback.speech_progress),
    );
    let pipeline = async { tokio::try_join!(feeder, reader) };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DecodeError::Cancelled),
        result = pipeline => result.map(|_| ()),
    };
    finish_child(&mut child, result, cancel).await?;
    output.wait_until_drained(job_id, cancel).await?;
    Ok(())
}

/// Play one managed sound asset using the same device and FIFO slot. No voice
/// speed or voice gain touches this path.
pub async fn play_sound(
    ffmpeg_path: &Path,
    sound_path: &Path,
    output: &AudioWriter,
    job_id: u64,
    cancel: &CancellationToken,
) -> Result<(), DecodeError> {
    if !sound_path.is_file() {
        return Err(DecodeError::MissingSound);
    }
    let mut command = base_command(ffmpeg_path)?;
    command.arg("-i").arg(sound_path);
    output_args(&mut command, output, 1.0)?;
    command.stdin(Stdio::null());
    let mut child = command.spawn().map_err(DecodeError::Start)?;
    let stdout = child.stdout.take().expect("piped ffmpeg stdout");
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DecodeError::Cancelled),
        result = read_pcm(stdout, output, job_id, 1.0, cancel, None) => result,
    };
    finish_child(&mut child, result, cancel).await?;
    output.wait_until_drained(job_id, cancel).await?;
    Ok(())
}

async fn finish_child(
    child: &mut Child,
    result: Result<(), DecodeError>,
    cancel: &CancellationToken,
) -> Result<(), DecodeError> {
    if let Err(error) = result {
        // A broken stdin pipe often means the decoder has already crashed.
        // Preserve its exit code instead of replacing it with a pipe error.
        if matches!(error, DecodeError::Pipe(_)) {
            let status = tokio::select! {
                biased;
                _ = cancel.cancelled() => None,
                result = tokio::time::timeout(std::time::Duration::from_millis(250), child.wait()) => result.ok().and_then(Result::ok),
            };
            if let Some(status) = status
                && !status.success()
            {
                return Err(DecodeError::ProcessExit(status.code()));
            }
        }
        let _ = child.kill().await;
        return Err(error);
    }
    let status = tokio::select! {
        biased;
        _ = cancel.cancelled() => { let _ = child.kill().await; return Err(DecodeError::Cancelled); },
        status = child.wait() => status.map_err(DecodeError::Pipe)?,
    };
    if !status.success() {
        return Err(DecodeError::InvalidAudio(status.code()));
    }
    Ok(())
}

async fn read_pcm<R: AsyncRead + Unpin>(
    mut reader: R,
    output: &AudioWriter,
    job_id: u64,
    voice_volume: f32,
    cancel: &CancellationToken,
    speech_progress: Option<&AtomicBool>,
) -> Result<(), DecodeError> {
    let frame_bytes = usize::from(output.channels) * 4;
    let mut carry = Vec::with_capacity(frame_bytes);
    let mut samples = Vec::with_capacity(16 * 1024 / 4);
    let mut input = [0u8; 16 * 1024];
    loop {
        let count = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(DecodeError::Cancelled),
            count = reader.read(&mut input) => count.map_err(DecodeError::Pipe)?,
        };
        if count == 0 {
            break;
        }
        carry.extend_from_slice(&input[..count]);
        let complete = (carry.len() / frame_bytes) * frame_bytes;
        if complete == 0 {
            continue;
        }
        samples.clear();
        for bytes in carry[..complete].as_chunks::<4>().0 {
            let sample = f32::from_le_bytes(*bytes);
            samples.push((sample * voice_volume).clamp(-1.0, 1.0));
        }
        if let Some(progress) = speech_progress {
            output
                .push_interleaved_marked(job_id, &samples, cancel, progress)
                .await?;
        } else {
            output.push_interleaved(job_id, &samples, cancel).await?;
        }
        carry.drain(..complete);
    }
    if !carry.is_empty() {
        return Err(DecodeError::Misaligned);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_exit_probe_child() {
        if std::env::var_os("DANMAKUVOICE_DECODER_EXIT_PROBE").is_some() {
            std::process::exit(37);
        }
    }

    #[tokio::test]
    async fn broken_pipe_preserves_decoder_exit_code() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "ffmpeg::tests::decoder_exit_probe_child"])
            .env("DANMAKUVOICE_DECODER_EXIT_PROBE", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        hide_console(&mut command);
        let mut child = command.spawn().unwrap();
        child.wait().await.unwrap();
        let result = finish_child(
            &mut child,
            Err(DecodeError::Pipe(io::Error::from(
                io::ErrorKind::BrokenPipe,
            ))),
            &CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Err(DecodeError::ProcessExit(Some(37)))));
    }

    use crate::audio::test_writer;
    use crate::tts::{send_bytes, spawn_stream};
    use tokio::sync::oneshot;
    use tokio::time::{Duration, sleep, timeout};

    #[cfg(windows)]
    #[test]
    fn windows_console_probe_child() {
        if std::env::var_os("DANMAKUVOICE_CONSOLE_PROBE_CHILD").is_none() {
            return;
        }
        use windows_sys::Win32::System::Console::GetConsoleWindow;

        // SAFETY: Read-only query for the current process's console window.
        assert!(unsafe { GetConsoleWindow() }.is_null());
        println!("pipe-ok");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_hidden_child_keeps_stdout_pipe() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "ffmpeg::tests::windows_console_probe_child",
            "--nocapture",
        ]);
        command.env("DANMAKUVOICE_CONSOLE_PROBE_CHILD", "1");
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);
        hide_console(&mut command);

        let output = timeout(Duration::from_secs(5), command.output())
            .await
            .expect("child timed out")
            .expect("child did not start");
        assert!(
            output.status.success(),
            "hidden child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("pipe-ok"));
    }

    fn streaming_wav() -> Vec<u8> {
        let frames = 24_000usize;
        let mut wav = Vec::with_capacity(44 + frames * 2);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&u32::MAX.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&u32::MAX.to_le_bytes());
        for index in 0..frames {
            let sample: i16 = if (index / 120) % 2 == 0 { 1200 } else { -1200 };
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }

    #[tokio::test]
    async fn real_ffmpeg_begins_before_source_finishes() {
        let Some(ffmpeg) = std::env::var_os("DANMAKUVOICE_TEST_FFMPEG") else {
            return;
        };
        let path = std::path::PathBuf::from(ffmpeg);
        let input = streaming_wav();
        let split = 44 + 24_000;
        let (first_tx, first_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let cancel = CancellationToken::new();
        let stream = spawn_stream(
            AudioEncoding::Wav,
            &cancel,
            move |sender, token| async move {
                send_bytes(&sender, &token, &input[..split]).await;
                let _ = first_tx.send(());
                let _ = release_rx.await;
                send_bytes(&sender, &token, &input[split..]).await;
                Ok(())
            },
        );
        let writer = test_writer(48_000, 2, 400_000);
        writer.activate(7);
        let task_writer = writer.clone();
        let task_cancel = cancel.clone();
        let mut task = tokio::spawn(async move {
            let speech_progress = AtomicBool::new(false);
            play_tts(
                &path,
                stream,
                &task_writer,
                7,
                TtsPlayback {
                    speed: 1.5,
                    voice_volume: 1.0,
                    speech_progress: &speech_progress,
                },
                &task_cancel,
            )
            .await
        });
        timeout(Duration::from_secs(3), first_rx)
            .await
            .unwrap()
            .unwrap();
        let mut first_audio = false;
        for _ in 0..200 {
            if writer.queued_samples() > 0 {
                first_audio = true;
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        assert!(
            first_audio,
            "FFmpeg produced no PCM before source completion"
        );
        let _ = release_tx.send(());
        let mut samples = 0usize;
        let result = timeout(Duration::from_secs(10), async {
            loop {
                tokio::select! {
                    result = &mut task => break result,
                    _ = sleep(Duration::from_millis(5)) => samples += writer.take_test_samples().len(),
                }
            }
        }).await.unwrap().unwrap();
        assert!(result.is_ok(), "FFmpeg pipeline failed: {result:?}");
        samples += writer.take_test_samples().len();
        assert!(
            samples > 48_000,
            "decoded and resampled samples were missing"
        );
    }

    #[tokio::test]
    async fn disconnected_output_stops_a_backpressured_ffmpeg_pipeline() {
        let Some(ffmpeg) = std::env::var_os("DANMAKUVOICE_TEST_FFMPEG") else {
            return;
        };
        let input = vec![0x20u8; 24_000 * 2 * 3];
        let cancel = CancellationToken::new();
        let stream = spawn_stream(
            AudioEncoding::PcmS16Le {
                sample_rate: 24_000,
                channels: 1,
            },
            &cancel,
            move |sender, token| async move {
                send_bytes(&sender, &token, &input).await;
                Ok(())
            },
        );
        let writer = test_writer(48_000, 1, 512);
        writer.activate(23);
        let task_writer = writer.clone();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let speech_progress = AtomicBool::new(false);
            play_tts(
                Path::new(&ffmpeg),
                stream,
                &task_writer,
                23,
                TtsPlayback {
                    speed: 1.0,
                    voice_volume: 1.0,
                    speech_progress: &speech_progress,
                },
                &task_cancel,
            )
            .await
        });
        timeout(Duration::from_secs(5), async {
            while writer.queued_samples() == 0 {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("FFmpeg never produced PCM");
        writer.disconnect_test_device();
        let result = timeout(Duration::from_secs(5), task)
            .await
            .expect("disconnected output left FFmpeg running")
            .unwrap();
        assert!(matches!(
            result,
            Err(DecodeError::Output(AudioError::Disconnected))
        ));
        writer.deactivate_if(23);
        assert!(
            writer
                .render_test_frames(512)
                .iter()
                .all(|sample| *sample == 0.0)
        );
    }
}
