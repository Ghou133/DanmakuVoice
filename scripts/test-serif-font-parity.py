"""Compare actual font outlines against the pinned original Google font, independently.

python scripts/test-serif-font-parity.py NotoSerifSC-wght.ttf [--google-cache font-loading.json]
Needs fonttools and brotli. No network requests, desktop/account actions or fixture app logic.
The optional cache contains the independent real Google response bodies captured by the
font audit; source files are never replaced by production fonts.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("serif_build", ROOT / "scripts/build-serif-subset.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def outline(glyphs, name):
    glyph = glyphs[name]
    pen = DecomposingRecordingPen(glyphs)
    glyph.draw(pen)
    return pen.value, glyph.width


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("--google-cache", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "target/lake-font-rebuild/parity.json")
    args = parser.parse_args()
    original = build.verify_source(args.original)
    source_cmap = original.getBestCmap()
    wanted = {ord(char) for char in build.charset()}
    required = wanted & source_cmap.keys()
    fonts = {weight: TTFont(build.OUT / f"DanmakuVoiceSerifSC-{name}.woff2") for name, weight in build.WEIGHTS.items()}
    result = {"passed": True, "evidence": "Independent official full Google Noto Serif SC 2.003-H1 versus production subset: exact decomposed variable outlines and advances at 500/700/900. Optional real Google CDN subsets independently compared; no production font substitution on the reference.", "source": {"url": build.SOURCE_URL, "sha256": hashlib.sha256(args.original.read_bytes()).hexdigest(), "version": original["name"].getDebugName(5)}, "weights": {}, "googleCDN": {}, "failures": []}
    glyph_sets = {}
    for weight, font in fonts.items():
        cmap = font.getBestCmap()
        source_glyphs = original.getGlyphSet(location={"wght": weight})
        production_glyphs = font.getGlyphSet(location={"wght": weight})
        glyph_sets[weight] = (source_glyphs, production_glyphs)
        missing = sorted(required - cmap.keys())
        different = []
        for codepoint in sorted(cmap):
            if codepoint not in source_cmap or outline(source_glyphs, source_cmap[codepoint]) != outline(production_glyphs, cmap[codepoint]):
                different.append(f"U+{codepoint:04X}")
        info = {"characters": len(cmap), "requiredCharacters": len(required), "missingRequired": missing, "exactOutlineAndAdvanceMatches": len(cmap) - len(different), "differences": different, "variableAxes": [{"tag": axis.axisTag, "min": axis.minValue, "default": axis.defaultValue, "max": axis.maxValue} for axis in font["fvar"].axes]}
        result["weights"][str(weight)] = info
        if missing or different:
            result["failures"].append(f"weight {weight}: missing={len(missing)}, different={len(different)}")
        print(f"weight {weight}: {info['exactOutlineAndAdvanceMatches']}/{len(cmap)} outlines/advances exact; {len(missing)} missing required glyphs")
    if args.google_cache:
        audit = json.loads(args.google_cache.read_text(encoding="utf-8"))
        unique = {}
        for mode, page in audit["pages"].items():
            if not mode.startswith("original-"):
                continue
            for response in page["requests"]:
                if response.get("saved", "").endswith(".woff2") and "fonts.gstatic.com" in response["url"]:
                    file = args.google_cache.parent / response["saved"]
                    if hashlib.sha256(file.read_bytes()).hexdigest() != response["sha256"]:
                        raise AssertionError(f"cached Google response changed: {file}")
                    unique[response["sha256"]] = file
        for weight, font in fonts.items():
            checked = set()
            different = []
            cmap = font.getBestCmap()
            production_glyphs = glyph_sets[weight][1]
            for file in unique.values():
                cached = TTFont(file)
                if "fvar" not in cached:
                    continue
                cached_cmap = cached.getBestCmap()
                cached_glyphs = cached.getGlyphSet(location={"wght": weight})
                for codepoint in sorted(cached_cmap.keys() & cmap.keys() - checked):
                    checked.add(codepoint)
                    if outline(cached_glyphs, cached_cmap[codepoint]) != outline(production_glyphs, cmap[codepoint]):
                        different.append(f"U+{codepoint:04X}")
            result["googleCDN"][str(weight)] = {"independentCommonCharacters": len(checked), "exactOutlineAndAdvanceMatches": len(checked) - len(different), "differences": different}
            if different:
                result["failures"].append(f"real Google CDN weight {weight}: {len(different)} differences")
            print(f"independent Google CDN weight {weight}: {len(checked)-len(different)}/{len(checked)} outlines/advances exact")
    result["passed"] = not result["failures"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if not result["passed"]:
        raise SystemExit("font parity failed: " + "; ".join(result["failures"]))


if __name__ == "__main__":
    main()
