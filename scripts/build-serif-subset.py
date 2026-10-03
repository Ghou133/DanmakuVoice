"""Rebuild the bundled serif font in crates/desktop/ui/fonts/.

Source: Noto Serif CJK 2.002 OTC files (https://github.com/notofonts/noto-cjk, SIL OFL 1.1),
e.g. NotoSerifCJK-Medium.ttc / -Bold.ttc / -Black.ttc. The SC face is extracted, subset to
all GB2312 hanzi (6763) + every hanzi used by crates/desktop/ui + Latin and CJK punctuation,
and renamed "DanmakuVoice Serif SC" (a Modified Version under OFL; the reserved name "Source"
is not used). Characters outside the subset fall back per glyph to the next family in --serif.

Usage:  python scripts/build-serif-subset.py <dir containing NotoSerifCJK-*.ttc>
Needs:  pip install fonttools brotli
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "crates" / "desktop" / "ui"
OUT = UI / "fonts"
FAMILY = "DanmakuVoice Serif SC"
WEIGHTS = {"Medium": 500, "Bold": 700, "Black": 900}  # 400 is served by Medium (see styles.css)
FEATURES = "kern,palt,halt,vert,vrt2,locl"


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


def sc_face(collection: TTCollection) -> TTFont:
    for face in collection.fonts:
        family = face["name"].getDebugName(16) or face["name"].getDebugName(1)
        if family.startswith("Noto Serif CJK SC"):
            return face
    raise SystemExit("no SC face in collection")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source_dir = Path(sys.argv[1])
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        text = Path(tmp) / "chars.txt"
        text.write_text(charset(), encoding="utf-8")
        for weight in WEIGHTS:
            otf = Path(tmp) / f"sc-{weight}.otf"
            sc_face(TTCollection(str(source_dir / f"NotoSerifCJK-{weight}.ttc"))).save(otf)
            out = OUT / f"DanmakuVoiceSerifSC-{weight}.woff2"
            subprocess.run(
                [sys.executable, "-m", "fontTools.subset", str(otf), f"--text-file={text}",
                 "--flavor=woff2", f"--layout-features={FEATURES}", "--no-hinting",
                 "--desubroutinize", "--name-IDs=*", f"--output-file={out}"],
                check=True,
            )
            font = TTFont(out)
            ps_name = f"DanmakuVoiceSerifSC-{weight}"
            names = font["name"]
            for record in names.names:
                if record.nameID in (1, 16, 21):
                    record.string = FAMILY
                elif record.nameID == 4:
                    record.string = f"{FAMILY} {weight}"
                elif record.nameID == 3:
                    record.string = f"2.002;DanmakuVoice;{ps_name}"
                elif record.nameID == 6:
                    record.string = ps_name
            names.setName(
                "Subset of Noto Serif CJK SC 2.002 (GB2312 + app UI glyphs), renamed for "
                "DanmakuVoice. Not the original font.", 10, 3, 1, 0x409)
            cff = font["CFF "].cff
            cff.fontNames = [ps_name]
            cff.topDictIndex[0].FullName = f"{FAMILY} {weight}"
            cff.topDictIndex[0].FamilyName = FAMILY
            font.flavor = "woff2"
            font.save(out)
            print(f"{out.relative_to(ROOT)}  {out.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
