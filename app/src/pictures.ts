// Pictures in the browser: a picture file (or pasted picture) taken in as a
// stored image, and stored images decoded to draw. What a reference is and
// where it lies is in references.ts; this is the part that needs the page.
import { MAX_IMAGE_PX } from "./references";
import type { StoredImage } from "./model";

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
