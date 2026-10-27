// Pictures in the browser: a picture file (or pasted picture) taken in as a
// stored image, and stored images decoded to draw. What a reference is and
// where it lies is in references.ts; this is the part that needs the page.
import { MAX_IMAGE_PX } from "./references";
import type { StoredImage } from "./model";
import type { Gray } from "./minisplit";

/** A picture file (or pasted picture) made into a stored image, no larger than `MAX_IMAGE_PX`. */
/** The image's id is left empty, for the step that lays it on a page to give. */
export async function readImage(file: Blob, name: string): Promise<StoredImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  // Drawings with clear parts stay PNG; photos go as JPEG, much smaller.
  const keepPng = file.type === "image/png" && hasTransparency(ctx, width, height);
  const mime = keepPng ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.85));
  canvas.width = 0;
  if (!blob) throw new Error("画像を読めませんでした");
  return { id: "", name, mime, dataBase64: await toBase64(blob), widthPx: width, heightPx: height };
}

function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) return true;
  return false;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Decoded pictures by their data (the same picture twice is decoded once). */
const decoded = new Map<string, ImageBitmap | "loading" | "failed">();

/** The picture to draw, or null while it is decoded (`ready` is called when it is). */
export function pictureOf(image: StoredImage, ready: () => void): ImageBitmap | null {
  const key = image.dataBase64;
  const kept = decoded.get(key);
  if (kept instanceof ImageBitmap) return kept;
  if (kept) return null;
  decoded.set(key, "loading");
  void decodePicture(image)
    .then((bitmap) => {
      decoded.set(key, bitmap);
      ready();
    })
    .catch(() => decoded.set(key, "failed"));
  return null;
}

/** Decode a stored picture (for drawing it off screen, as in the export). */
export async function decodePicture(image: StoredImage): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(image.dataBase64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: image.mime }));
}

/**
 * A picture made small and grey to look at (`scale` of its size), keeping
 * its thin lines: each pixel is the darkest of the pixels it stands for, so
 * a frame a pixel wide stays a line where averaging would fade it away. The
 * picture is read a band at a time, never whole at its own size.
 */
export function grayOf(picture: CanvasImageSource & { width: number; height: number }, scale: number): Gray {
  const width = Math.max(1, Math.round(picture.width * scale));
  const height = Math.max(1, Math.round(picture.height * scale));
  // Each pixel looked at stands for k x k pixels read (no more than the picture has).
  const k = Math.max(1, Math.min(4, Math.round(1 / scale)));
  const band = 32;
  const canvas = document.createElement("canvas");
  canvas.width = width * k;
  canvas.height = band * k;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = new Uint8Array(width * height);
  const sy = picture.height / height;
  for (let top = 0; top < height; top += band) {
    const rows = Math.min(band, height - top);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture, 0, top * sy, picture.width, rows * sy, 0, 0, width * k, rows * k);
    const rgba = ctx.getImageData(0, 0, width * k, rows * k).data;
    const stride = width * k;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < width; x++) {
        let darkest = 255;
        for (let dy = 0; dy < k; dy++) {
          let p = ((y * k + dy) * stride + x * k) * 4;
          for (let dx = 0; dx < k; dx++, p += 4) {
            const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
            if (luma < darkest) darkest = luma;
          }
        }
        data[(top + y) * width + x] = Math.round(darkest);
      }
    }
  }
  canvas.width = 0;
  return { width, height, data };
}
