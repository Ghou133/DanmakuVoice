#!/usr/bin/env python3
"""Compare a portable ZIP's Rust notices with the matching locked .crate files.

This is an artifact integrity check, not a legal conclusion. It uses only the
Python 3.11+ standard library and never extracts archive entries to disk.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tarfile
import tomllib
import zipfile


LICENSE_NAME = re.compile(
    r"^(?:license|licence|copying|notices?|attributions?|authors|patents|"
    r"copyright|credits)(?:[._-].*)?$",
    re.IGNORECASE,
)
ROOT_LICENSE_NAME = re.compile(r"^(?:license|licence|copying)(?:[._-].*)?$", re.IGNORECASE)
README_NAME = re.compile(r"^readme(?:[._-].*)?$", re.IGNORECASE)
COMMIT_LINE = re.compile(r"(?m)^Source Git commit: ([0-9a-f]{40})\r?$")


class AuditError(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_bytes(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        return archive.read(name)
    except KeyError as exc:
        raise AuditError(f"missing ZIP file: {name}") from exc


def read_json(archive: zipfile.ZipFile, name: str) -> dict:
    try:
        value = json.loads(read_bytes(archive, name).decode("utf-8-sig"))
    except (UnicodeError, ValueError) as exc:
        raise AuditError(f"invalid JSON: {name}") from exc
    if not isinstance(value, dict):
        raise AuditError(f"expected JSON object: {name}")
    return value


def unique_files(archive: zipfile.ZipFile) -> list[str]:
    names = [item.filename for item in archive.infolist() if not item.is_dir()]
    if len(names) != len(set(names)):
        raise AuditError(f"duplicate ZIP file names in {archive.filename}")
    return names


def key_for(package: dict) -> tuple[str, str]:
    return package["name"], package["versionInfo"]


def verify(portable_path: Path, source_path: Path) -> tuple[int, int, int]:
    with zipfile.ZipFile(portable_path) as portable, zipfile.ZipFile(source_path) as source:
        portable_names = unique_files(portable)
        unique_files(source)
        portable_root = "DanmakuVoice/"
        build = read_bytes(portable, portable_root + "BUILD-SOURCE.txt").decode("utf-8-sig")
        match = COMMIT_LINE.search(build)
        if not match:
            raise AuditError("portable ZIP does not identify a full source commit")
        commit = match.group(1)
        source_root = f"DanmakuVoice-source-{commit[:12]}/"
        source_commit = read_bytes(source, source_root + "SOURCE-COMMIT.txt").decode("utf-8-sig")
        if f"DanmakuVoice source commit: {commit}" not in source_commit:
            raise AuditError("portable and source ZIPs identify different commits")

        rust_root = portable_root + "third-party/Rust/"
        source_rust_root = source_root + "third-party/Rust/"
        spdx = read_json(portable, rust_root + "DEPENDENCIES.spdx.json")
        inventory = read_json(source, source_rust_root + "CRATE-ARCHIVES.json")
        selected = read_json(portable, rust_root + "LICENSE-SUPPLEMENTS.json")
        source_supplements = read_json(
            source, source_root + "third-party/license-supplements/manifest.json"
        )
        if selected.get("schemaVersion") != 1 or source_supplements.get("schemaVersion") != 1:
            raise AuditError("unsupported license supplement manifest")

        packages = {}
        for package in spdx["packages"]:
            key = key_for(package)
            if key in packages or not package.get("licenseDeclared"):
                raise AuditError(f"duplicate package or empty license declaration: {key}")
            packages[key] = package
        archives = {}
        for item in inventory["archives"]:
            key = item["name"], item["version"]
            if key in archives:
                raise AuditError(f"duplicate source archive inventory entry: {key}")
            archives[key] = item
        if not packages or packages.keys() != archives.keys():
            raise AuditError("portable SPDX and source crate inventory differ")

        try:
            lock = tomllib.loads(read_bytes(source, source_root + "Cargo.lock").decode("utf-8-sig"))
        except (UnicodeError, tomllib.TOMLDecodeError) as exc:
            raise AuditError("invalid source Cargo.lock") from exc
        lock_checksums = {}
        for item in lock["package"]:
            if item.get("source") == "registry+https://github.com/rust-lang/crates.io-index":
                key = item["name"], item["version"]
                if key in lock_checksums:
                    raise AuditError(f"duplicate crates.io package in Cargo.lock: {key}")
                lock_checksums[key] = item["checksum"]

        source_entries = {}
        for item in source_supplements["entries"]:
            key = item["package"], item["version"]
            if key in source_entries:
                raise AuditError(f"duplicate source supplement: {key}")
            source_entries[key] = item
        selected_entries = {}
        supplement_paths = set()
        for item in selected["entries"]:
            key = item["package"], item["version"]
            if key in selected_entries or key not in packages or source_entries.get(key) != item:
                raise AuditError(f"duplicate or mismatched selected supplement: {key}")
            selected_entries[key] = item
            for file in item["files"]:
                relative = file["path"]
                if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", relative):
                    raise AuditError(f"invalid supplement path: {relative}")
                if not re.fullmatch(r"[0-9a-fA-F]{64}", file["sha256"]):
                    raise AuditError(f"invalid supplement checksum: {relative}")
                supplement_paths.add(relative)
                portable_bytes = read_bytes(
                    portable, portable_root + "third-party/license-supplements/" + relative
                )
                source_bytes = read_bytes(
                    source, source_root + "third-party/license-supplements/" + relative
                )
                if portable_bytes != source_bytes or sha256(portable_bytes) != file["sha256"].lower():
                    raise AuditError(f"supplement differs from manifest or source: {relative}")
        supplement_prefix = portable_root + "third-party/license-supplements/"
        extra_supplements = {
            path[len(supplement_prefix) :]
            for path in portable_names
            if path.startswith(supplement_prefix)
        } - supplement_paths
        if extra_supplements:
            raise AuditError(f"unlisted portable supplements: {sorted(extra_supplements)}")

        copied = defaultdict(dict)
        license_prefix = rust_root + "licenses/"
        for path in portable_names:
            if not path.startswith(license_prefix):
                continue
            remainder = path[len(license_prefix) :]
            if "/" not in remainder:
                raise AuditError(f"unexpected Rust license file path: {path}")
            directory, relative = remainder.split("/", 1)
            if relative in copied[directory]:
                raise AuditError(f"duplicate Rust license path: {path}")
            copied[directory][relative] = path

        original_files = 0
        missing_root = set()
        for key in sorted(packages):
            name, version = key
            directory = f"{name}-{version}"
            item = archives[key]
            archive_name = directory + ".crate"
            if item["archive"] != archive_name or item["sha256"].lower() != lock_checksums.get(key):
                raise AuditError(f"source archive inventory differs from Cargo.lock: {directory}")
            crate_bytes = read_bytes(source, source_rust_root + "crate-archives/" + archive_name)
            if sha256(crate_bytes) != item["sha256"].lower():
                raise AuditError(f"crate bytes differ from Cargo.lock: {archive_name}")
            original = {}
            with tarfile.open(fileobj=io.BytesIO(crate_bytes), mode="r:gz") as crate:
                for member in crate:
                    if not member.isfile() or not member.name.startswith(directory + "/"):
                        continue
                    relative = member.name[len(directory) + 1 :]
                    if relative in original:
                        raise AuditError(f"duplicate path in .crate: {directory}/{relative}")
                    original[relative] = member
                expected = {
                    relative
                    for relative in original
                    if LICENSE_NAME.fullmatch(relative.rsplit("/", 1)[-1])
                    or relative.rsplit("/", 1)[-1] in ("UNLICENSE", "DRUID_LICENSE")
                }
                has_root_license = any(
                    "/" not in relative and ROOT_LICENSE_NAME.fullmatch(relative)
                    for relative in expected
                )
                if not has_root_license:
                    missing_root.add(key)
                    expected.update(
                        relative
                        for relative in original
                        if "/" not in relative and README_NAME.fullmatch(relative)
                    )
                actual = copied.pop(directory, {})
                if set(actual) != expected:
                    absent = sorted(expected - set(actual))
                    extra = sorted(set(actual) - expected)
                    raise AuditError(f"license file set differs for {directory}: missing={absent}, extra={extra}")
                for relative in sorted(expected):
                    original_bytes = crate.extractfile(original[relative]).read()
                    if original_bytes != read_bytes(portable, actual[relative]):
                        raise AuditError(f"license bytes differ from .crate: {directory}/{relative}")
                    original_files += 1
        if copied:
            raise AuditError(f"license files for undeclared packages: {sorted(copied)}")
        if missing_root != selected_entries.keys():
            raise AuditError(
                "packages needing supplements differ from selected supplements: "
                f"missing={sorted(missing_root - selected_entries.keys())}, "
                f"extra={sorted(selected_entries.keys() - missing_root)}"
            )

        notice = read_bytes(portable, rust_root + "NOTICE-REVIEW.md").decode("utf-8-sig")
        rows = [line for line in notice.splitlines() if line.startswith("| ")]
        if len(rows) != len(packages) + 2:
            raise AuditError("NOTICE-REVIEW.md has an unexpected package row count")
        for name, version in packages:
            marker = f"| {name} {version} |"
            if sum(row.startswith(marker) for row in rows) != 1:
                raise AuditError(f"NOTICE-REVIEW.md omits or duplicates {name} {version}")
        return len(packages), original_files, len(supplement_paths)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portable", required=True, type=Path, help="portable ZIP")
    parser.add_argument("--source", required=True, type=Path, help="matching source ZIP")
    args = parser.parse_args()
    try:
        packages, original_files, supplement_files = verify(args.portable, args.source)
    except (
        AuditError,
        OSError,
        KeyError,
        TypeError,
        ValueError,
        EOFError,
        zipfile.BadZipFile,
        tarfile.TarError,
    ) as exc:
        print(f"Rust license copy verification FAILED: {exc}", file=sys.stderr)
        return 1
    print(
        "Rust license copies match locked source: "
        f"{packages} packages, {original_files} original files, "
        f"{supplement_files} unique supplement files. Manual license review still required."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
