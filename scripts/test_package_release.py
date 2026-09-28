"""Release packaging gates, using small archives rather than a live build."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).with_name("package-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.commit = "1" * 40
        self.exe = self.root / "app.exe"
        self.exe.write_bytes(b"MZ" + b"test executable" * 200)
        self.audit = self.root / "audit.zip"
        self.source = self.root / "source.zip"
        self.out = self.root / "release"
        self.audit_files = {
            "danmakuvoice.exe": self.exe.read_bytes(),
            "BUILD-SOURCE.txt": f"Source Git commit: {self.commit}\nCheckout clean before build: True\n".encode(),
            **{name: b"license" for name in ("LICENSE", "NOTICE.md", "docs/FFMPEG.md",
                "scripts/build-minimal-ffmpeg-wsl.sh", "third-party/FFmpeg/COPYING.LGPLv2.1",
                "third-party/FFmpeg/LICENSE.md", "third-party/Rust/Cargo.lock",
                "third-party/Rust/licenses/example/LICENSE", "third-party/license-supplements/example/LICENSE")},
            "PROGRESS.md": b"Not for the application ZIP",
            "third-party/FFmpeg/ffmpeg.tar.xz": b"Sources stay in the separate source ZIP",
        }
        self.source_files = {
            "SOURCE-COMMIT.txt": f"DanmakuVoice source commit: {self.commit}".encode(),
            "Cargo.toml": b'[workspace.package]\nversion = "0.2.1"\n',
            "Cargo.lock": b"license", "crates/desktop/icons/ARTWORK.md": b"artwork",
        }

    def package(self, version="0.2.1"):
        for path, prefix, files in (
            (self.audit, "DanmakuVoice/", self.audit_files),
            (self.source, f"DanmakuVoice-source-{self.commit[:12]}/", self.source_files),
        ):
            with ZipFile(path, "w") as archive:
                for name, contents in files.items():
                    archive.writestr(prefix + name, contents)
        release.package(self.audit, self.exe, self.source, self.out, self.commit, version)

    def test_compressed_root_exe_licenses_checksums_and_determinism(self):
        self.package()
        with ZipFile(self.out / release.APPLICATION_ZIP) as archive:
            self.assertEqual(archive.read("DanmakuVoice.exe"), self.exe.read_bytes())
            self.assertLess(archive.getinfo("DanmakuVoice.exe").compress_size, self.exe.stat().st_size)
            self.assertEqual(archive.namelist(), ["DanmakuVoice.exe"])
            self.assertEqual(archive.testzip(), None)
        with ZipFile(self.out / "DanmakuVoice-licenses.zip") as archive:
            self.assertIn("third-party/license-supplements/example/LICENSE", archive.namelist())
            self.assertNotIn("DanmakuVoice.exe", archive.namelist())
        for line in (self.out / "SHA256SUMS.txt").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(release.sha256(self.out / name), digest)
        self.assertNotIn(b"\r", (self.out / "SHA256SUMS.txt").read_bytes())
        first_hash = release.sha256(self.out / release.APPLICATION_ZIP)
        self.out = self.root / "second"
        self.package()
        self.assertEqual(release.sha256(self.out / release.APPLICATION_ZIP), first_hash)

    def test_rejects_overwrite(self):
        self.out.mkdir()
        with self.assertRaises(FileExistsError):
            self.package()

    def test_rejects_mismatched_binary_before_output(self):
        self.exe.write_bytes(b"wrong binary")
        with self.assertRaisesRegex(ValueError, "EXE differs"):
            self.package()
        self.assertFalse(self.out.exists())

    def test_rejects_mismatched_version_or_lock(self):
        with self.assertRaisesRegex(ValueError, "version differs"):
            self.package("0.3.0")
        self.source_files["Cargo.lock"] = b"different"
        with self.assertRaisesRegex(ValueError, "Cargo.lock differ"):
            self.package()

    def test_rejects_dirty_or_wrong_source_commit(self):
        self.audit_files["BUILD-SOURCE.txt"] = b"Checkout clean before build: False"
        with self.assertRaisesRegex(ValueError, "clean source commit"):
            self.package()

    def test_rejects_missing_license_or_unsafe_archive_path(self):
        del self.audit_files["LICENSE"]
        with self.assertRaisesRegex(ValueError, "license materials"):
            self.package()
        self.audit_files["LICENSE"] = b"license"
        self.audit_files["third-party/Rust/../../escape"] = b"bad"
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP path"):
            self.package()


if __name__ == "__main__":
    unittest.main()
