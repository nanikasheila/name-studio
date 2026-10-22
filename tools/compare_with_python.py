"""Compare the Rust `inspect` output with the Python reference implementation.

Why: The Rust core is a port of ``name_splitter.csp``. Until it is the only
     implementation, every file must summarize identically in both.
How: Builds the synthetic test files from ``tests/csp_fixtures.py`` (plus any
     .clip / .cmc given on the command line, e.g. real files kept outside the
     repository), runs ``inspect --pixels`` in both and compares the JSON.
     Then splits a synthetic name sheet with both ``split`` commands and
     compares what they wrote: the summaries, every database row (ids that
     are random by design are masked), the vector and text data byte for
     byte, and the pixels within a small resampling tolerance.

The Python reference lives in the csp-name-splitter repository. Point
``CSP_NAME_SPLITTER`` at a checkout of it (default: a sibling folder).

Usage (after ``cargo build --release -p name-cli``):
    CSP_NAME_SPLITTER=../csp-name-splitter python tools/compare_with_python.py [extra files...]
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = Path(os.environ.get("CSP_NAME_SPLITTER", ROOT.parent / "csp-name-splitter")).resolve()
if not (REFERENCE / "name_splitter" / "csp").is_dir():
    sys.exit(f"Python reference not found at {REFERENCE}; set CSP_NAME_SPLITTER")
sys.path[:0] = [str(REFERENCE), str(REFERENCE / "tests")]

import sqlite3  # noqa: E402
import struct  # noqa: E402

from PIL import Image, ImageChops  # noqa: E402

from csp_fixtures import (  # noqa: E402
    FixtureLayer, build_clip, build_cmc, build_text_attributes, rectangle,
)
from name_splitter.app.cli import main as python_cli  # noqa: E402
from name_splitter.csp import inspect_file  # noqa: E402
from name_splitter.csp.container import open_sqlite_bytes, read_csf_container  # noqa: E402
from name_splitter.csp.text_attributes import build_tlv  # noqa: E402
from name_splitter.csp.clip_reader import read_clip  # noqa: E402
from name_splitter.csp.name_layout import detect_document_cells  # noqa: E402

BINARY = ROOT / "target" / "release" / ("name-studio-cli.exe" if sys.platform == "win32" else "name-studio-cli")
FLOAT_TOLERANCE = 1e-9
# Resampling is not byte-identical to Pillow's fixed-point filters.
PIXEL_TOLERANCE = 8
BBOX_TOLERANCE = 2
# Values that are random by design (file and layer ids) or derived from them.
MASKED_COLUMNS = {"LayerUuid", "ExternalID", "Offset", "BlockData", "VectorData", "ImageData",
                  "LinkWriteYear", "LinkWriteMonth", "LinkWriteDay", "LinkWriteHour", "LinkWriteMinute",
                  "LinkWriteSecond"}


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
    spreads = [rectangle(x, y, x + 260, y + 120) for x in (20, 320) for y in (20, 160)]
    frames = [rectangle(x + dx, y + 10, x + dx + 110, y + 110) for x in (20, 320) for y in (20, 160) for dx in (10, 140)]
    name = build_clip(folder / "name.clip", 600, 300, [
        FixtureLayer(main_id=2, name="用紙", layer_type=1584),
        FixtureLayer(main_id=3, name="枠", layer_type=0, vector_objects=spreads + frames),
        FixtureLayer(main_id=4, name="コマ", layer_type=0, offset=(2, 3), vector_objects=[rectangle(40, 40, 90, 90)]),
    ], double_page=True)
    work = build_cmc(folder / "work.cmc", ["page0001.clip", "page0002.clip", "page0003.clip"], order=[0, 2, 1])
    return [page, sheet, name, work]


def build_split_inputs(folder: Path) -> tuple[Path, Path]:
    """The name sheet and template of the Python split tests (tests/test_csp_split_write.py)."""
    right_spread = [rectangle(840, 40, 1560, 560), rectangle(860, 60, 1190, 540), rectangle(1210, 60, 1540, 540)]
    sketch = Image.new("RGBA", (1600, 600), (0, 0, 0, 0))
    sketch.paste((0, 0, 0, 255), (1290, 290, 1310, 310))
    sketch.paste((200, 40, 40, 128), (300, 100, 420, 180))
    sheet_folder, template_folder = folder / "sheet", folder / "template"
    sheet_folder.mkdir()
    template_folder.mkdir()
    preview = Image.new("RGBA", (800, 300), (255, 255, 255, 255))
    preview.paste((255, 0, 0, 255), (645, 145, 655, 155))
    sheet = build_clip(sheet_folder / "sheet.clip", 1600, 600, [
        FixtureLayer(main_id=2, name="用紙", layer_type=1584),
        FixtureLayer(main_id=10, name="テンプレート", layer_type=0, folder=1, children=[
            FixtureLayer(main_id=11, name="右", layer_type=0, vector_objects=right_spread),
            FixtureLayer(main_id=12, name="左", layer_type=0, offset=(-800, 0), vector_objects=right_spread),
        ]),
        FixtureLayer(main_id=20, name="下描き", image=sketch),
        FixtureLayer(main_id=30, name="ネーム", layer_type=0, folder=1, children=[
            FixtureLayer(main_id=21, name="線", layer_type=0, vector_objects=[(0x11, [(1250, 100), (1500, 500)])]),
        ]),
        FixtureLayer(main_id=23, name="セリフ", layer_type=0, text="あ",
                     text_attributes=build_text_attributes((900, 100, 960, 300), 4.0)),
    ], preview=preview, double_page=True, editable=True)
    story = build_tlv([(0x0B, struct.pack("<4I", 1, 0, len("作品 3話"), 26)), (0x20, struct.pack("<i", 900))])
    template = build_clip(template_folder / "page.clip", 400, 560, [
        FixtureLayer(main_id=2, name="用紙", layer_type=1584),
        FixtureLayer(main_id=3, name="レイヤー 1", image=Image.new("RGBA", (400, 560), (0, 0, 0, 0))),
        FixtureLayer(main_id=4, name="(作品情報)", layer_type=800, text="作品 3話", text_attributes=story),
    ], preview=Image.new("RGBA", (200, 280), (255, 255, 255, 255)), editable=True)
    build_cmc(sheet_folder / "name.cmc", ["sheet.clip"])
    return sheet, template


def database_rows(path: Path) -> dict[str, list[list[object]]]:
    """Every row of every table, sorted, with random ids masked."""
    if path.suffix == ".cmc":
        database = sqlite3.connect(path)
    else:
        database = open_sqlite_bytes(read_csf_container(path).sqlite_bytes)
    try:
        tables = [row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
        result = {}
        for table in tables:
            columns = [row[1] for row in database.execute(f'PRAGMA table_info("{table}")')]
            rows = []
            for row in database.execute(f'SELECT * FROM "{table}"'):
                values = []
                for column, value in zip(columns, row):
                    if column in MASKED_COLUMNS and value not in (None, b"", ""):
                        value = "<masked>"
                    elif isinstance(value, bytes):
                        value = value.hex()
                    values.append(value)
                rows.append(values)
            result[table] = [columns] + sorted(rows, key=repr)
    finally:
        # Windows cannot delete the temporary folder while the file is open.
        database.close()
    return result


def external_payloads(path: Path) -> dict[str, list[bytes]]:
    """Vector payloads per layer id (the pixels are compared decoded)."""
    container = read_csf_container(path)
    database = open_sqlite_bytes(container.sqlite_bytes)
    tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master")}
    if "VectorObjectList" not in tables:
        return {}
    payloads: dict[str, list[bytes]] = {}
    for layer_id, data in database.execute("SELECT LayerId, VectorData FROM VectorObjectList ORDER BY MainId"):
        payload = container.external_payload(bytes(data).decode()) if data else None
        payloads.setdefault(str(layer_id), []).append(payload or b"")
    return payloads


def pixel_differences(python_path: Path, rust_path: Path) -> list[str]:
    python_document, rust_document = read_clip(python_path), read_clip(rust_path)
    found = []
    for layer in python_document.iter_layers():
        expected = python_document.render_layer_pixels(layer)
        actual = rust_document.render_layer_pixels(rust_document.find_layer(layer.main_id))
        if expected is None or actual is None:
            if (expected is None) != (actual is None):
                found.append(f"layer {layer.main_id}: stored pixels {expected is not None} != {actual is not None}")
            continue
        worst = max(high for _, high in ImageChops.difference(expected, actual).getextrema())
        if worst > PIXEL_TOLERANCE:
            found.append(f"layer {layer.main_id}: pixels differ by up to {worst}")
    return found


def summary_differences(python: object, rust: object, where: str = "$") -> list[str]:
    """Like ``differences``, but pixel bounding boxes may move by a pixel or two."""
    if where.endswith(".stored_pixels.bbox") and isinstance(python, list) and isinstance(rust, list):
        if len(python) == len(rust) and all(abs(a - b) <= BBOX_TOLERANCE for a, b in zip(python, rust)):
            return []
    if isinstance(python, dict) and isinstance(rust, dict):
        return [item for key in python.keys() | rust.keys() if key != "path"
                for item in summary_differences(python.get(key), rust.get(key), f"{where}.{key}")]
    if isinstance(python, list) and isinstance(rust, list) and len(python) == len(rust):
        return [item for index, (a, b) in enumerate(zip(python, rust))
                for item in summary_differences(a, b, f"{where}[{index}]")]
    return differences(python, rust, where)


def compare_split(folder: Path) -> list[tuple[str, list[str]]]:
    sheet, template = build_split_inputs(folder)
    options = ["--template", str(template), "--fit", "cell", "--cmc", "第1話", "--story-index", "12"]
    python_out, rust_out = folder / "python", folder / "rust"
    if python_cli(["split", str(sheet), "--out-dir", str(python_out), *options]) != 0:
        return [("split", ["the Python split failed"])]
    subprocess.run([str(BINARY), "split", str(sheet), "--out-dir", str(rust_out), *options],
                   capture_output=True, check=True)
    results = []
    names = sorted(path.name for path in python_out.iterdir())
    rust_names = sorted(path.name for path in rust_out.iterdir())
    if names != rust_names:
        return [("split", [f"files {names} != {rust_names}"])]
    for name in names:
        python_path, rust_path = python_out / name, rust_out / name
        found = summary_differences(json.loads(json.dumps(inspect_file(python_path, include_pixels=True))),
                                    json.loads(json.dumps(inspect_file(rust_path, include_pixels=True))))
        found += differences(database_rows(python_path), database_rows(rust_path), "db")
        if python_path.suffix == ".clip":
            found += [] if external_payloads(python_path) == external_payloads(rust_path) else ["vector data differs"]
            found += pixel_differences(python_path, rust_path)
        results.append((f"split/{name}", found))
    return results


def run_rust(*args: str) -> object:
    result = subprocess.run([str(BINARY), *args], capture_output=True, check=True, text=True, encoding="utf-8")
    return json.loads(result.stdout)


def python_cells(path: Path) -> list[dict[str, object]]:
    def rect(value):
        return None if value is None else {"x0": value.x0, "y0": value.y0, "x1": value.x1, "y1": value.y1}
    return [
        {"index": cell.index, "rect": rect(cell.rect), "frame": rect(cell.frame), "spread_side": cell.spread_side}
        for cell in detect_document_cells(read_clip(path))
    ]


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
            found = differences(python, run_rust("inspect", str(path), "--pixels"))
            if path.suffix == ".clip":
                found += differences(python_cells(path), run_rust("cells", str(path)), "cells")
            print(f"{'OK  ' if not found else 'DIFF'} {path.name}")
            for line in found[:20]:
                print(f"     {line}")
            failures += bool(found)
        for name, found in compare_split(Path(temp)):
            print(f"{'OK  ' if not found else 'DIFF'} {name}")
            for line in found[:20]:
                print(f"     {line}")
            failures += bool(found)
    return 1 if failures else 0


if __name__ == "__main__":
    # Windows consoles default to a legacy code page; the work names are Japanese.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
