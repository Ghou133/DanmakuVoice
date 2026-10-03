"""Create compressed release assets from an already verified binary/source pair."""
import argparse
import hashlib
import re
import shutil
import tomllib
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
from source_inventory import verify_development_pair

REPOSITORY = "https://github.com/Ghou133/DanmakuVoice"
APPLICATION_ZIP = "DanmakuVoice-windows-x64.zip"
ASSETS = (APPLICATION_ZIP, "DanmakuVoice.exe", "DanmakuVoice-source.zip",
          "DanmakuVoice-licenses.zip")


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_zip(path, files):
    # Fixed timestamps and stable ordering make repeat packaging deterministic.
    with ZipFile(path, "x", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, contents in sorted(files.items()):
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, contents, compresslevel=9)
    with ZipFile(path) as archive:
        if set(archive.namelist()) != set(files) or archive.testzip() is not None:
            raise ValueError(f"ZIP verification failed: {path}")
        for name, contents in files.items():
            if archive.read(name) != contents:
                raise ValueError(f"ZIP contents differ: {name}")


def package(audit, exe, source, output, commit, version, development=False):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A full source commit is required")
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("A stable major.minor.patch version is required")
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite release directory: {output}")
    binary = Path(exe).read_bytes()
    licenses = {}
    exact = {"LICENSE", "NOTICE.md", "docs/FFMPEG.md", "scripts/build-minimal-ffmpeg-wsl.sh",
             "third-party/FFmpeg/COPYING.LGPLv2.1", "third-party/FFmpeg/LICENSE.md"}
    with ZipFile(audit) as archive:
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError('Duplicate audit archive member')
        if archive.read("DanmakuVoice/danmakuvoice.exe") != binary:
            raise ValueError("EXE differs from verified audit package")
        provenance = archive.read("DanmakuVoice/BUILD-SOURCE.txt").decode("utf-8-sig")
        if f"Source Git commit: {commit}" not in provenance or (not development and not re.search(
                r"(?m)^Checkout clean before build: True\r*$", provenance)):
            raise ValueError("Audit package must identify the clean source commit")
        if not development and ('DanmakuVoice/WORKTREE-SOURCE.json' in archive.namelist()
                                or re.search(r'(?m)^Development snapshot: True\r*$', provenance)):
            raise ValueError('Development snapshots cannot be packaged as a formal release')
        for entry in archive.infolist():
            if entry.is_dir() or not entry.filename.startswith("DanmakuVoice/"):
                continue
            name = entry.filename.removeprefix("DanmakuVoice/")
            if name in exact or name.startswith(("third-party/Rust/", "third-party/license-supplements/")):
                if "\\" in name or ':' in name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
                    raise ValueError(f"Unsafe ZIP path: {name}")
                if name in licenses:
                    raise ValueError(f"Duplicate ZIP path: {name}")
                licenses[name] = archive.read(entry)
    if not exact.issubset(licenses) or "third-party/Rust/Cargo.lock" not in licenses:
        raise ValueError("Required license materials are missing")
    with ZipFile(source) as archive:
        if len(archive.namelist()) != len(set(archive.namelist())):
            raise ValueError('Duplicate source archive member')
        prefix = f"DanmakuVoice-source-{commit[:12]}/"
        source_commit = archive.read(prefix + "SOURCE-COMMIT.txt").decode("utf-8-sig")
        if f"DanmakuVoice source commit: {commit}" not in source_commit:
            raise ValueError("Source package does not match the release commit")
        if development:
            with ZipFile(audit) as audit_archive:
                snapshot = verify_development_pair(audit_archive, archive, commit)
        elif prefix + 'WORKTREE-SOURCE.json' in archive.namelist() or re.search(r'(?m)^Development snapshot: True\r*$', source_commit):
            raise ValueError('Development sources cannot be packaged as a formal release')
        manifest = tomllib.loads(archive.read(prefix + "Cargo.toml").decode("utf-8-sig"))
        if manifest["workspace"]["package"]["version"] != version:
            raise ValueError("Release version differs from source package")
        if archive.read(prefix + "Cargo.lock") != licenses["third-party/Rust/Cargo.lock"]:
            raise ValueError("Source and application Cargo.lock differ")
        licenses["ARTWORK.md"] = archive.read(prefix + "crates/desktop/icons/ARTWORK.md")
    release_url = f"{REPOSITORY}/releases/tag/v{version}"
    licenses["SOURCE-AVAILABILITY.txt"] = (
        f"DanmakuVoice {version}\nGit commit: {commit}\n"
        f"Matching source and all locked dependencies: {release_url}\n"
        "Download DanmakuVoice-source.zip from this same release.\n"
        "The source ZIP includes FFmpeg source and build scripts.\n"
    ).encode("utf-8")
    if development:
        licenses['SOURCE-AVAILABILITY.txt'] = (
            f'DanmakuVoice {version} local development snapshot\nBase Git commit: {commit}\n'
            f'Working-tree snapshot SHA-256: {snapshot}\n'
            'Uncommitted sources are included in the adjacent DanmakuVoice-source.zip.\n'
            'DEVELOPMENT VALIDATION ONLY - NOT A FORMAL RELEASE\n'
        ).encode('utf-8')
    # Inputs are fully inspected before creating an output directory. Failed outputs
    # are retained for inspection, never silently reused by a subsequent build.
    output.mkdir(parents=True)
    write_zip(output / APPLICATION_ZIP, {"DanmakuVoice.exe": binary})
    write_zip(output / "DanmakuVoice-licenses.zip", licenses)
    shutil.copyfile(exe, output / "DanmakuVoice.exe")
    shutil.copyfile(source, output / "DanmakuVoice-source.zip")
    notes = (
        f"下载 **[{APPLICATION_ZIP}]({REPOSITORY}/releases/download/v{version}/{APPLICATION_ZIP})**，"
        "完整解压后双击 `DanmakuVoice.exe`。更新前请退出旧程序，设置会保留。\n\n"
        "Windows 10/11 x64，需要 WebView2 Runtime。ZIP 内只有程序本体；"
        "许可材料单独提供为 `DanmakuVoice-licenses.zip`，"
        "同版 `DanmakuVoice-source.zip` 包含完整锁定源码和离线构建脚本。"
        "单独 EXE 附件保留用于兼容旧版更新检查。\n\n"
        f"版本：`{version}`，构建提交：`{commit}`。文件校验见 `SHA256SUMS.txt`。\n"
    )
    if development:
        notes = (
            f'本地开发快照，含未提交修改，非正式发行版。版本 `{version}`，基础提交 `{commit}`。\n\n'
            f'工作树 SHA-256：`{snapshot}`。源码按 `WORKTREE-SOURCE.json` 逐文件配对核验。\n\n'
            '解压 `DanmakuVoice-windows-x64.zip` 后运行 `DanmakuVoice.exe`。Windows x64，需 WebView2 Runtime。'
            '同目录提供完整源码、第三方许可与校验值；本流程不发布、不提交商店。\n'
        )
    (output / 'BUILD-SOURCE.txt').write_text(provenance, encoding='utf-8')
    (output / "RELEASE-NOTES.md").write_text(notes, encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text(
        "".join(f"{sha256(output / name)}  {name}\n" for name in (*ASSETS, 'BUILD-SOURCE.txt', 'RELEASE-NOTES.md')),
        encoding="utf-8", newline="\n")
    print(f"Release ZIP verified: {output / APPLICATION_ZIP} ({(output / APPLICATION_ZIP).stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("audit", "exe", "source", "output", "commit", "version"):
        parser.add_argument(f"--{flag}", required=True)
    parser.add_argument('--development', action='store_true', help='Local working-tree snapshot; never a formal release')
    package(**vars(parser.parse_args()))
