"""Run an existing dots serve_api.py with explicit reference audio paths.

The source server and its model installation stay untouched. This module is
embedded in the desktop executable and run by the selected dots Python venv.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


CAPABILITY_ROUTE = "/danmakuvoice/capabilities"
CAPABILITY_VERSION = "danmakuvoice-dots-paths-v1"


def _local_audio_path(server: ModuleType, voice: str) -> str:
    candidate = Path(voice)
    # The user may select a file on any drive, UNC share, or extended Windows
    # path. HTTP access to this process is separately bound to loopback.
    if not candidate.is_absolute():
        raise server.HTTPException(status_code=400, detail="Invalid reference audio path")
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        raise server.HTTPException(status_code=404, detail="Reference audio not found") from None
    if not resolved.is_absolute():
        raise server.HTTPException(status_code=400, detail="Invalid reference audio path")
    if resolved.suffix.lower() not in server.AUDIO_SUFFIXES:
        raise server.HTTPException(status_code=400, detail="Unsupported reference audio format")
    if not resolved.is_file():
        raise server.HTTPException(status_code=404, detail="Reference audio not found")
    return str(resolved)


def install(server: ModuleType) -> None:
    """Patch only the resolver used by the existing REST and stream routes."""
    for name in ("app", "main", "build_parser", "resolve_voice", "synth", "tts_stream"):
        if not hasattr(server, name):
            raise RuntimeError("Unsupported dots API source")
    for name in ("synth", "tts_stream"):
        if "resolve_voice" not in getattr(server, name).__code__.co_names:
            raise RuntimeError("Unsupported dots API resolver contract")
    if any(route.path == CAPABILITY_ROUTE for route in server.app.routes):
        raise RuntimeError("Conflicting dots capability route")

    original_resolver = server.resolve_voice

    def resolve_voice(voice: str | None) -> tuple[str | None, None]:
        if voice and Path(voice).is_absolute():
            audio_path = _local_audio_path(server, voice)
        else:
            audio_path, _sidecar_text = original_resolver(voice)
        # A blank reference text in the desktop app means text-free cloning.
        # The old resolver otherwise reads a same-name .txt file implicitly.
        return audio_path, None

    server.resolve_voice = resolve_voice

    async def capabilities() -> dict[str, object]:
        return {
            "protocol": CAPABILITY_VERSION,
            "arbitrary_voice_paths": True,
            "reference_text_explicit": True,
        }

    server.app.add_api_route(
        CAPABILITY_ROUTE, capabilities, methods=["GET"], include_in_schema=False
    )


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("dots API source path is required")
    source = Path(sys.argv[1]).resolve(strict=True)
    sys.argv = [str(source), *sys.argv[2:]]
    # Direct `python serve_api.py` puts its parent on sys.path. Importing by
    # file path needs the same environment for existing sibling imports.
    sys.path.insert(0, str(source.parent))
    spec = importlib.util.spec_from_file_location("danmakuvoice_dots_server", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load dots API source")
    server = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = server
    spec.loader.exec_module(server)
    args = server.build_parser().parse_args(sys.argv[1:])
    if args.host != "127.0.0.1":
        raise RuntimeError("dots API must bind to 127.0.0.1")
    install(server)
    return server.main()


if __name__ == "__main__":
    raise SystemExit(main())
