// Drawing a name sheet (or part of it) onto a 2D canvas.
import type { LayerView, Rect, SheetView, TextView } from "./types";

/** Sheet pixels → screen pixels: `screen = sheet * scale + offset`. */
export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** A raster image placed on the sheet (sheet pixel box). */
export interface PlacedImage {
  image: CanvasImageSource;
  box: Rect;
}

const INK = "#1b1a18";
// Characters that are turned 90° in vertical writing.
const ROTATED = new Set(["ー", "－", "―", "—", "〜", "～", "…", "‥", "(", ")", "（", "）", "「", "」", "『", "』", "[", "]", "【", "】", "-", "=", "＝"]);
// Small punctuation that sits in the upper right of its cell when vertical.
const SHIFTED = new Set(["、", "。", "，", "．", "っ", "ゃ", "ゅ", "ょ", "ッ", "ャ", "ュ", "ョ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ァ", "ィ", "ゥ", "ェ", "ォ"]);

export function drawSheet(
  ctx: CanvasRenderingContext2D,
  sheet: SheetView,
  visible: Map<number, boolean>,
  images: (layer: LayerView) => PlacedImage[],
  t: Transform,
): void {
  for (const layer of sheet.layers) {
    if (!visible.get(layer.id)) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (layer.kind === "paper") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(t.offsetX, t.offsetY, sheet.canvas.widthPx * t.scale, sheet.canvas.heightPx * t.scale);
    }
    for (const placed of images(layer)) {
      const { box } = placed;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        placed.image,
        box.x0 * t.scale + t.offsetX,
        box.y0 * t.scale + t.offsetY,
        (box.x1 - box.x0) * t.scale,
        (box.y1 - box.y0) * t.scale,
      );
    }
    drawVectors(ctx, layer, t);
    for (const text of layer.texts) drawText(ctx, text, t);
    ctx.restore();
  }
}

function drawVectors(ctx: CanvasRenderingContext2D, layer: LayerView, t: Transform): void {
  ctx.strokeStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const vector of layer.vectors) {
    if (vector.points.length < 2) continue;
    ctx.lineWidth = Math.max(vector.brushSize * t.scale, 0.6);
    ctx.beginPath();
    vector.points.forEach(([x, y], index) => {
      const sx = x * t.scale + t.offsetX;
      const sy = y * t.scale + t.offsetY;
      if (index === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    if (vector.closed) ctx.closePath();
    ctx.stroke();
  }
}

function fontFamily(text: TextView): string {
  const preferred = text.fontName ? `"${text.fontName}", ` : "";
  return `${preferred}"Yu Gothic", "Hiragino Sans", "Noto Sans JP", sans-serif`;
}

/** Draw one text block inside its box: vertical columns right to left, or horizontal lines. */
export function drawText(ctx: CanvasRenderingContext2D, text: TextView, t: Transform): void {
  if (!text.bbox || !text.text) return;
  const [x0, y0, x1, y1] = text.bbox;
  const size = text.fontSizePx * t.scale;
  const left = x0 * t.scale + t.offsetX;
  const top = y0 * t.scale + t.offsetY;
  const right = x1 * t.scale + t.offsetX;
  if (size < 2.5) {
    // Too small to read: show where the text is.
    ctx.fillStyle = "rgba(47, 111, 219, 0.35)";
    ctx.fillRect(left, top, Math.max(right - left, 1), Math.max((y1 - y0) * t.scale, 1));
    return;
  }
  ctx.fillStyle = text.color ?? INK;
  ctx.font = `${text.bold ? "bold " : ""}${size}px ${fontFamily(text)}`;
  const lines = text.text.replace(/\r\n?/g, "\n").split("\n");
  const pitch = size * 1.15;
  if (!text.vertical) {
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((line, index) => ctx.fillText(line, left, top + index * pitch));
    return;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, column) => {
    const cx = right - size / 2 - column * pitch;
    [...line].forEach((char, row) => {
      const cy = top + size / 2 + row * size;
      if (ROTATED.has(char)) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(char, 0, 0);
        ctx.restore();
      } else if (SHIFTED.has(char)) {
        ctx.fillText(char, cx + size * 0.12, cy - size * 0.12);
      } else {
        ctx.fillText(char, cx, cy);
      }
    });
  });
}
