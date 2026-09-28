"""Smoke-test the minimal Windows FFmpeg with the engine's exact audio commands.

The reference FFmpeg only generates temporary fixtures; the candidate is the
decoder under test. No live service, account, or old FFmpeg file is modified.
"""

from __future__ import annotations

import argparse
import math
import pathlib
import struct
import subprocess
import tempfile
import wave


RATE = 24_000
FRAMES = RATE * 2


def run(executable: pathlib.Path, args: list[str], *, data: bytes | None = None) -> bytes:
    process = subprocess.run(
        [str(executable), "-hide_banner", "-nostdin", "-loglevel", "error", *args],
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=20,
    )
    if process.returncode:
        raise RuntimeError(
            f"{executable.name} returned {process.returncode}: "
            f"{process.stderr.decode(errors='replace')}"
        )
    return process.stdout


def estimate_pitch_hz(output: bytes, frames: int) -> float:
    """Count full negative-to-positive cycles in the middle of a clean tone."""
    window_frames = min(24_000, frames // 2)
    start = (frames - window_frames) // 2
    crossings = 0
    armed = False
    for frame in range(start, start + window_frames):
        left = struct.unpack_from("<f", output, frame * 8)[0]
        if left < -0.05:
            armed = True
        elif armed and left > 0.05:
            crossings += 1
            armed = False
    return crossings * 48_000 / window_frames


def validate(
    label: str, output: bytes, expected_frames: int, *, expected_pitch_hz: float | None = None
) -> None:
    if len(output) % 8:
        raise AssertionError(f"{label}: float32 stereo output is misaligned")
    frames = len(output) // 8
    if abs(frames - expected_frames) > 3_000:
        raise AssertionError(f"{label}: {frames} frames; expected ~{expected_frames}")
    samples = [item[0] for _, item in zip(range(10_000), struct.iter_unpack("<f", output))]
    if not samples or not all(math.isfinite(item) for item in samples):
        raise AssertionError(f"{label}: output contains no finite PCM")
    rms = math.sqrt(sum(item * item for item in samples) / len(samples))
    if not 0.02 <= rms <= 1:
        raise AssertionError(f"{label}: silent or clipped PCM (RMS {rms:.3f})")
    pitch_text = ""
    if expected_pitch_hz is not None:
        pitch = estimate_pitch_hz(output, frames)
        if abs(pitch - expected_pitch_hz) > 20:
            raise AssertionError(
                f"{label}: pitch {pitch:.1f} Hz; expected {expected_pitch_hz:.1f} Hz"
            )
        pitch_text = f", pitch {pitch:.1f} Hz"
    print(f"PASS {label}: {frames} frames, 48 kHz stereo f32le, RMS {rms:.3f}{pitch_text}")


def verify(candidate: pathlib.Path, reference: pathlib.Path | None, *, wav_smoke_only: bool = False) -> None:
    with tempfile.TemporaryDirectory(prefix="danmakuvoice-ffmpeg-") as temporary:
        folder = pathlib.Path(temporary)
        source = folder / "source.wav"
        pcm = bytearray()
        for index in range(FRAMES):
            sample = int(9_000 * math.sin(2 * math.pi * 440 * index / RATE))
            pcm.extend(struct.pack("<h", sample))
        with wave.open(str(source), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(RATE)
            writer.writeframes(pcm)

        # The legacy effect picker accepts WAV without constraining its PCM
        # encoding. Cover common unsigned 8-bit and telephony WAV payloads.
        source_u8 = folder / "source-u8.wav"
        with wave.open(str(source_u8), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(1)
            writer.setframerate(RATE)
            writer.writeframes(bytes(
                round(128 + 65 * math.sin(2 * math.pi * 440 * index / RATE))
                for index in range(FRAMES)
            ))
        if wav_smoke_only:
            output_options = ["-vn", "-sn", "-dn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]
            validate("WAV sound", run(candidate, ["-i", str(source), *output_options]), FRAMES * 2)
            validate("WAV unsigned 8-bit sound", run(candidate, ["-i", str(source_u8), *output_options]), FRAMES * 2)
            print("ALL PASS")
            return
        assert reference is not None

        codecs = {
            "wav": [],
            "mp3": ["-c:a", "libmp3lame", "-b:a", "96k"],
            "flac": ["-c:a", "flac"],
            "ogg": ["-c:a", "libvorbis", "-q:a", "4"],
            "m4a": ["-c:a", "aac", "-b:a", "96k"],
            "aac": ["-c:a", "aac", "-b:a", "96k", "-f", "adts"],
        }
        for extension, options in codecs.items():
            sound = source if extension == "wav" else folder / f"source.{extension}"
            if sound != source:
                run(reference, ["-y", "-i", str(source), *options, str(sound)])
            output_options = ["-vn", "-sn", "-dn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]
            if extension == "aac":
                output = run(candidate, ["-f", "aac", "-i", "pipe:0", *output_options], data=sound.read_bytes())
                validate("AAC ADTS pipe TTS", output, FRAMES * 2)
            else:
                output = run(candidate, ["-i", str(sound), *output_options])
                validate(f"{extension.upper()} sound", output, FRAMES * 2)

        output_options = ["-vn", "-sn", "-dn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"]
        validate("WAV unsigned 8-bit sound", run(candidate, ["-i", str(source_u8), *output_options]), FRAMES * 2)
        for wav_codec in ("pcm_alaw", "pcm_mulaw"):
            encoded = folder / f"{wav_codec}.wav"
            run(reference, ["-y", "-i", str(source), "-c:a", wav_codec, str(encoded)])
            validate(f"WAV {wav_codec} sound", run(candidate, ["-i", str(encoded), *output_options]), FRAMES * 2)

        output = run(
            candidate,
            ["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
             "-vn", "-sn", "-dn", "-af", "atempo=1.5000", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"],
            data=bytes(pcm),
        )
        validate("PCM pipe TTS atempo 1.5", output, round(FRAMES * 2 / 1.5), expected_pitch_hz=440)
    print("ALL PASS")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=pathlib.Path, required=True)
    parser.add_argument("--reference", type=pathlib.Path,
                        help="Existing full FFmpeg used only to encode fixtures")
    parser.add_argument("--wav-smoke-only", action="store_true",
                        help="Test S16 and unsigned 8-bit WAV without a reference encoder")
    args = parser.parse_args()
    if not args.candidate.is_file():
        parser.error("candidate must exist")
    if not args.wav_smoke_only and (args.reference is None or not args.reference.is_file()):
        parser.error("reference must exist for the full test")
    verify(args.candidate, args.reference, wav_smoke_only=args.wav_smoke_only)
