"""Offline contract checks for the embedded dots launcher."""

from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

import dots_voice_shim as shim


class FakeHTTPException(Exception):
    def __init__(self, *, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail


class FakeApp:
    def __init__(self) -> None:
        self.routes: list[object] = []
        self.handlers: dict[str, object] = {}

    def add_api_route(self, path: str, handler: object, **_kwargs: object) -> None:
        self.handlers[path] = handler


def fake_server() -> ModuleType:
    server = ModuleType("fake_dots")
    server.HTTPException = FakeHTTPException
    server.AUDIO_SUFFIXES = (".wav", ".mp3", ".flac", ".m4a", ".ogg")
    server.app = FakeApp()
    server.main = lambda: 0
    server.build_parser = lambda: None
    exec(
        "def resolve_voice(voice): return (voice or 'default.wav', 'sidecar text')\n"
        "def synth(request): return resolve_voice(request)\n"
        "async def tts_stream(request): return resolve_voice(request)\n",
        server.__dict__,
    )
    return server


class DotsVoiceShimTests(unittest.TestCase):
    def test_absolute_reference_keeps_original_file_and_ignores_sidecar(self) -> None:
        server = fake_server()
        shim.install(server)
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "voice.wav"
            sidecar = audio.with_suffix(".txt")
            audio.write_bytes(b"offline audio fixture")
            sidecar.write_text("hidden sidecar text", encoding="utf-8")
            before = audio.read_bytes()
            self.assertEqual(server.synth(str(audio)), (str(audio.resolve()), None))
            self.assertEqual(
                asyncio.run(server.tts_stream(str(audio))), (str(audio.resolve()), None)
            )
            self.assertEqual(audio.read_bytes(), before)
            self.assertEqual(sidecar.read_text(encoding="utf-8"), "hidden sidecar text")
            with self.assertRaises(FakeHTTPException) as missing:
                server.resolve_voice(str(audio.with_name("missing.wav")))
            self.assertEqual(missing.exception.status_code, 404)
            with self.assertRaises(FakeHTTPException) as unsupported:
                server.resolve_voice(str(sidecar))
            self.assertEqual(unsupported.exception.status_code, 400)

    def test_relative_reference_delegates_but_never_uses_sidecar(self) -> None:
        server = fake_server()
        shim.install(server)
        self.assertEqual(server.resolve_voice("relative.wav"), ("relative.wav", None))
        self.assertEqual(server.resolve_voice(None), ("default.wav", None))
        handler = server.app.handlers[shim.CAPABILITY_ROUTE]
        self.assertEqual(
            asyncio.run(handler()),
            {
                "protocol": shim.CAPABILITY_VERSION,
                "arbitrary_voice_paths": True,
                "reference_text_explicit": True,
            },
        )

    def test_python_c_launcher_preserves_server_args_and_forces_loopback(self) -> None:
        fake_source = '''
import argparse
import sys
class App:
    routes = []
    def add_api_route(self, path, handler, **kwargs):
        assert path == "/danmakuvoice/capabilities"
app = App()
class HTTPException(Exception):
    pass
AUDIO_SUFFIXES = (".wav",)
def resolve_voice(voice): return (voice, "sidecar")
def synth(request): return resolve_voice(request)
async def tts_stream(request): return resolve_voice(request)
def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host")
    return parser
def main():
    assert sys.argv[0] == __file__
    assert resolve_voice("voice.wav") == ("voice.wav", None)
    print("shim-ready")
    return 0
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "serve_api.py"
            source.write_text(fake_source, encoding="utf-8")
            command = [sys.executable, "-u", "-c", Path(shim.__file__).read_text(encoding="utf-8"), str(source)]
            good = subprocess.run(
                [*command, "--host", "127.0.0.1"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertIn("shim-ready", good.stdout)
            bad = subprocess.run(
                [*command, "--host", "0.0.0.0"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(bad.returncode, 0)
            self.assertNotIn("shim-ready", bad.stdout)


if __name__ == "__main__":
    unittest.main()
