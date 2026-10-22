"""Compare the Rust `inspect` output with the Python reference implementation.

Why: The Rust core is a port of ``name_splitter.csp``. Until it is the only
     implementation, every file must summarize identically in both.
How: Builds the synthetic test files from ``tests/csp_fixtures.py`` (plus any
     .clip / .cmc given on the command line, e.g. real files kept outside the
     repository), runs ``inspect --pixels`` in both and compares the JSON.

Usage (from the csp-name-splitter root, after ``cargo build --release`` in
name-studio/):
    python name-studio/tools/compare_with_python.py [extra files...]
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from PIL import Image  # noqa: E402

from csp_fixtures import (  # noqa: E402
    FixtureLayer, build_clip, build_cmc, build_text_attributes, rectangle,
)
from name_splitter.csp import inspect_file  # noqa: E402

BINARY = ROOT / "name-studio" / "target" / "release" / ("name-studio-cli.exe" if sys.platform == "win32" else "name-studio-cli")
FLOAT_TOLERANCE = 1e-9


def _sample_image(width: int, height: int) -> Image.Image:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (10, 10, 40, 40))
    image.paste((0, 0, 255, 128), (300, 260, 310, 270))
    return image


def build_fixtures(folder: Path) -> list[Path]:
    page = build_clip(folder / "page.clip", 320, 280, [
        FixtureLayer(main_id=2, name="用紙", layer_type=1584),
        FixtureLayer(main_id=3, name="下描き", image=_sample_image(320, 280), opacity=128),
        FixtureLayer(main_id=4, name="コマ 1", layer_type=0, folder=1, is_frame=True, children=[
            FixtureLayer(main_id=5, name="線画", image=_sample_image(320, 280), gray=True),
            FixtureLayer(main_id=6, name="セリフ", layer_type=0, text="こんにちは" * 10, offset=(-5, 7)),
            FixtureLayer(main_id=7, name="ベクター", layer_type=0, is_vector=True, visibility=0),
        ]),
        FixtureLayer(main_id=8, name="フォルダー", layer_type=0, folder=17),
    ])
    sheet = build_clip(folder / "sheet.clip", 600, 300, [
        FixtureLayer(main_id=2, name="用紙", layer_type=1584),
        FixtureLayer(main_id=3, name="枠", layer_type=0, offset=(10, -5),
                     vector_objects=[rectangle(20, 30, 120, 230), rectangle(320, 30, 420, 230)]),
        FixtureLayer(main_id=4, name="セリフ", layer_type=0, text="こんにちは", offset=(7, 3),
                     text_attributes=build_text_attributes((40, 50, 60, 150), 8.0),
                     text_attribute_array=[build_text_attributes((70, 80, 90, 180), 9.0, "源ノ角ゴシック")]),
        FixtureLayer(main_id=5, name="ラフ", offset=(3, 4), image=_sample_image(600, 300)),
    ], double_page=True)
    work = build_cmc(folder / "work.cmc", ["page0001.clip", "page0002.clip", "page0003.clip"], order=[0, 2, 1])
    return [page, sheet, work]


def rust_inspect(path: Path) -> object:
    result = subprocess.run([str(BINARY), "inspect", str(path), "--pixels"],
                            capture_output=True, check=True, text=True, encoding="utf-8")
    return json.loads(result.stdout)


def differences(python: object, rust: object, where: str = "$") -> list[str]:
    if isinstance(python, dict) and isinstance(rust, dict):
        found = []
        if list(python) != list(rust):
            found.append(f"{where}: keys {list(python)} != {list(rust)}")
        for key in python.keys() & rust.keys():
            if key != "path":
                found += differences(python[key], rust[key], f"{where}.{key}")
        return found
    if isinstance(python, (list, tuple)) and isinstance(rust, list):
        if len(python) != len(rust):
            return [f"{where}: length {len(python)} != {len(rust)}"]
        return [item for index, (a, b) in enumerate(zip(python, rust)) for item in differences(a, b, f"{where}[{index}]")]
    if isinstance(python, bool) or isinstance(rust, bool):
        return [] if python is rust else [f"{where}: {python!r} != {rust!r}"]
    if isinstance(python, (int, float)) and isinstance(rust, (int, float)):
        return [] if abs(python - rust) <= FLOAT_TOLERANCE else [f"{where}: {python!r} != {rust!r}"]
    return [] if python == rust else [f"{where}: {python!r} != {rust!r}"]


def main(extra: list[str]) -> int:
    if not BINARY.exists():
        print(f"Build the Rust CLI first: {BINARY} not found", file=sys.stderr)
        return 2
    failures = 0
    with tempfile.TemporaryDirectory() as temp:
        for path in build_fixtures(Path(temp)) + [Path(item) for item in extra]:
            python = json.loads(json.dumps(inspect_file(path, include_pixels=True), ensure_ascii=False))
            found = differences(python, rust_inspect(path))
            print(f"{'OK  ' if not found else 'DIFF'} {path.name}")
            for line in found[:20]:
                print(f"     {line}")
            failures += bool(found)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
