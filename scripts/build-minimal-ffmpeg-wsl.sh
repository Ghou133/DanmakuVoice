#!/usr/bin/env bash
# Build a narrowly scoped, LGPL Windows x64 FFmpeg for DanmakuVoice.
# Run under Ubuntu/WSL. Output defaults to dist/ffmpeg-probe, not a release.
set -euo pipefail

version=9.0.2
source_sha256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
release_key=FCF986EA15E6E293A5644F10B4322F04D67658D8
# Official tar.xz index timestamp: 2026-09-18 05:30:00 UTC. MinGW's export
# table otherwise embeds wall-clock time even when the PE header is zeroed.
export SOURCE_DATE_EPOCH=1789709400
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$script_dir/.." && pwd)
build_root=${DV_FFMPEG_BUILD_ROOT:-/tmp/danmakuvoice-ffmpeg-9.0.2}
output_dir=${1:-$repo_dir/dist/ffmpeg-probe}
jobs=${DV_FFMPEG_JOBS:-8}

for tool in curl gpg sha256sum tar gcc make nasm x86_64-w64-mingw32-gcc-win32 x86_64-w64-mingw32-objdump; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Missing build tool: %s\n' "$tool" >&2
        exit 1
    fi
done

mkdir -p "$build_root" "$output_dir" "$build_root/gnupg"
chmod 700 "$build_root/gnupg"
cd "$build_root"
source_archive="ffmpeg-$version.tar.xz"
source_signature="$script_dir/ffmpeg-verification/$source_archive.asc"
release_public_key="$script_dir/ffmpeg-verification/ffmpeg-devel.asc"
if [[ ! -f "$source_archive" ]]; then
    # The primary server may be unreachable from a CI runner. Mirrors are
    # transport only: the same pinned checksum and detached signature remain
    # mandatory regardless of where the archive was downloaded.
    temporary_archive="$source_archive.download.$$"
    for url in \
        "https://ffmpeg.org/releases/$source_archive" \
        "https://mirrors.slackware.com/slackware/slackware64-current/source/l/ffmpeg/$source_archive" \
        "https://mse.uk.distfiles.macports.org/ffmpeg/$source_archive"; do
        rm -f "$temporary_archive"
        if curl --fail --location --silent --show-error --connect-timeout 10 \
            --max-time 45 --retry 1 --retry-all-errors "$url" -o "$temporary_archive"; then
            # Fail closed on a checksum mismatch; do not silently try another
            # mirror after receiving unexpected content.
            if ! printf '%s  %s\n' "$source_sha256" "$temporary_archive" | sha256sum --check -; then
                rm -f "$temporary_archive"
                exit 1
            fi
            mv "$temporary_archive" "$source_archive"
            break
        fi
        printf 'FFmpeg download failed: %s\n' "$url" >&2
    done
    rm -f "$temporary_archive"
    if [[ ! -f "$source_archive" ]]; then
        echo 'Unable to download the FFmpeg source archive' >&2
        exit 1
    fi
fi
printf '%s  %s\n' "$source_sha256" "$source_archive" | sha256sum --check -
gpg --homedir "$build_root/gnupg" --import "$release_public_key" >/dev/null 2>&1
if ! gpg --homedir "$build_root/gnupg" --with-colons --fingerprint \
    | grep -Fq "$release_key"; then
    echo 'FFmpeg release key fingerprint mismatch' >&2
    exit 1
fi
signature_status=$(gpg --homedir "$build_root/gnupg" --status-fd 1 \
    --verify "$source_signature" "$source_archive")
if ! printf '%s\n' "$signature_status" | grep -Fq "[GNUPG:] VALIDSIG $release_key "; then
    echo 'FFmpeg archive was not signed by the pinned release key' >&2
    exit 1
fi

source_dir="$build_root/source"
if [[ ! -f "$source_dir/configure" ]]; then
    mkdir -p "$source_dir"
    tar -xf "$source_archive" -C "$source_dir" --strip-components=1
fi
cd "$source_dir"
if [[ -f ffbuild/config.mak ]]; then
    make distclean >/dev/null
fi

configure_options=(
    --target-os=mingw32
    --arch=x86_64
    --cross-prefix=x86_64-w64-mingw32-
    --cc=x86_64-w64-mingw32-gcc-win32
    --enable-static
    --disable-shared
    --enable-small
    --disable-debug
    --disable-doc
    --disable-autodetect
    --disable-network
    --disable-avdevice
    --disable-swscale
    --disable-hwaccels
    --disable-devices
    --disable-programs
    --enable-ffmpeg
    --disable-everything
    --enable-protocol=file,pipe
    --enable-demuxer=wav,mp3,flac,ogg,aac,mov,pcm_s16le
    --enable-muxer=pcm_f32le
    --enable-parser=aac,mpegaudio,flac,vorbis,opus
    --enable-decoder=aac,mp3,flac,vorbis,opus,alac,pcm_u8,pcm_alaw,pcm_mulaw,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le
    --enable-encoder=pcm_f32le
    --enable-filter=atempo,aresample,aformat,abuffer,abuffersink,anull
)
./configure "${configure_options[@]}" | tee "$build_root/configure.log"
if ! grep -Fq 'License: LGPL version 2.1 or later' "$build_root/configure.log"; then
    echo 'Unexpected FFmpeg license configuration' >&2
    exit 1
fi
make -j"$jobs" ffmpeg.exe | tee "$build_root/build.log"

cp ffmpeg.exe "$output_dir/ffmpeg.exe"
printf '\nCandidate (not a release): %s\n' "$output_dir/ffmpeg.exe"
stat -c 'Size: %s bytes' "$output_dir/ffmpeg.exe"
sha256sum "$output_dir/ffmpeg.exe"
x86_64-w64-mingw32-objdump -p "$output_dir/ffmpeg.exe" | grep 'DLL Name'
