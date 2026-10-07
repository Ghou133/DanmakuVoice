"""Rebuild the bundled serif font in crates/desktop/ui/fonts/.

Source: official Google Fonts Noto Serif SC 2.003-H1 variable TrueType font, SIL OFL 1.1.
Its SHA256 is pinned below. Keep the variable interpolation tables: making static TrueType
instances rounds fractional coordinates at weights 500/700 and changes the reference outlines.
Subset to all GB2312 hanzi (6763) + every hanzi used by crates/desktop/ui + Latin and CJK
punctuation, rename "DanmakuVoice Serif SC", and preserve the three existing asset names.
The three files contain identical variable font bytes; CSS selects exactly 500, 700 or 900,
matching the original Lake Google Fonts declarations (including 400 selecting the 500 face).
Characters outside the subset fall back per glyph to the next family in --serif.

Usage:  python scripts/build-serif-subset.py <NotoSerifSC[wght].ttf>
Needs:  pip install fonttools brotli
"""
import re
import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "crates" / "desktop" / "ui"
OUT = UI / "fonts"
FAMILY = "DanmakuVoice Serif SC"
WEIGHTS = {"Medium": 500, "Bold": 700, "Black": 900}
SOURCE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf"
SOURCE_SHA256 = "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9"
SOURCE_VERSION = "Version 2.003-H1"


def charset() -> str:
    chars = set()
    for hi in range(0xB0, 0xF8):  # GB2312 hanzi rows: level 1 (B0-D7) + level 2 (D8-F7)
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    for path in UI.glob("*"):
        if path.suffix in {".html", ".js", ".mjs", ".css"} and ".test." not in path.name:
            chars |= set(re.findall(r"[㐀-鿿豈-﫿]", path.read_text(encoding="utf-8")))
    ranges = [(0x20, 0x7F), (0xA0, 0x100), (0x2010, 0x2070), (0x3000, 0x3040), (0xFF01, 0xFF5F)]
    for lo, hi in ranges:
        chars |= {chr(c) for c in range(lo, hi)}
    chars |= set("←→↑↓·…※№℃×÷★☆○●▲▼♡♥￥")
    return "".join(sorted(chars))


def verify_source(source: Path) -> TTFont:
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise SystemExit(f"source SHA256 differs from the independently audited Google font: {SOURCE_SHA256}")
    font = TTFont(source)
    if not (font["name"].getDebugName(5) or "").startswith(SOURCE_VERSION):
        raise SystemExit("expected Google Noto Serif SC 2.003-H1")
    if "glyf" not in font or "fvar" not in font or "gvar" not in font:
        raise SystemExit("expected the original variable TrueType outlines")
    return font


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    verify_source(source).close()
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        text = Path(tmp) / "chars.txt"
        text.write_text(charset(), encoding="utf-8")
        subset = Path(tmp) / "subset.woff2"
        subprocess.run(
            [sys.executable, "-m", "fontTools.subset", str(source), f"--text-file={text}",
             "--flavor=woff2", "--layout-features=*", "--name-IDs=*", f"--output-file={subset}"],
            check=True,
        )
        font = TTFont(subset)
        for record in font["name"].names:
            if record.nameID in (1, 16, 21):
                record.string = FAMILY
            elif record.nameID == 4:
                record.string = f"{FAMILY} Variable"
            elif record.nameID == 3:
                record.string = "2.003-H1;DanmakuVoice;DanmakuVoiceSerifSC"
            elif record.nameID == 6:
                record.string = "DanmakuVoiceSerifSC"
            elif record.toUnicode().startswith("NotoSerifSC-"):
                record.string = record.toUnicode().replace("NotoSerifSC-", "DanmakuVoiceSerifSC-", 1)
        font["name"].setName(
            "Subset of Google Fonts Noto Serif SC 2.003-H1 (GB2312 + app UI glyphs), renamed "
            "for DanmakuVoice. Original variable outlines/interpolation retained; not the original font.",
            10, 3, 1, 0x409)
        font.flavor = "woff2"
        font.save(subset)
        data = subset.read_bytes()
        for weight in WEIGHTS:
            out = OUT / f"DanmakuVoiceSerifSC-{weight}.woff2"
            out.write_bytes(data)
            print(f"{out.relative_to(ROOT)}  {out.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
