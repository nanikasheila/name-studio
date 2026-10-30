// Rough images read from a name's source sheet (ネーム用紙), by layer and
// crop: read once, kept while the name is open, drawn when they come.
import { call } from "./backend";
import type { RoughImage } from "./model";

const ROUGH_MAX_HEIGHT = 1600;

export interface RoughCacheHost {
  /** The sheet the name was taken from, if any. */
  sheet(): string | undefined;
  status(message: string): void;
  /** A rough came in: draw the pages again. */
  arrived(): void;
}

/** A rough that could not be read, and why. */
interface Failed {
  failed: string;
}

export class RoughCache {
  private images = new Map<string, ImageBitmap | "loading" | Failed>();

  constructor(private readonly host: RoughCacheHost) {}

  /** Another name (or version of it): what was read goes. */
  clear(): void {
    this.images = new Map();
  }

  /** A rough as drawn so far, starting to load it when it is not there yet. */
  get(rough: RoughImage): CanvasImageSource | null {
    const sheet = this.host.sheet();
    const cached = sheet ? this.images.get(keyOf(sheet, rough)) : undefined;
    if (cached instanceof ImageBitmap) return cached;
    if (!cached && sheet) void this.load(rough).then((image) => image && this.host.arrived());
    return null;
  }

  /** Why a rough cannot be read (reading it if not tried yet), or null when it can. */
  async problem(rough: RoughImage): Promise<string | null> {
    const sheet = this.host.sheet();
    if (!sheet) return "元のネーム用紙が記録されていません";
    if (await this.load(rough)) return null;
    const cached = this.images.get(keyOf(sheet, rough));
    return cached && typeof cached === "object" && "failed" in cached ? cached.failed : "読めませんでした";
  }

  /** Pixels of a rough from the source sheet (null when the sheet cannot be read). */
  async load(rough: RoughImage): Promise<ImageBitmap | null> {
    const sheet = this.host.sheet();
    if (!sheet) return null;
    // By sheet too: the name pointed at another sheet reads its roughs afresh.
    const key = keyOf(sheet, rough);
    const cached = this.images.get(key);
    if (cached instanceof ImageBitmap) return cached;
    if (cached && cached !== "loading") return null;
    // Kept in the map it was asked for: a name opened meanwhile has its own.
    const images = this.images;
    images.set(key, "loading");
    try {
      const bytes = await call("rough_image", {
        sheet,
        layerId: rough.layerId,
        crop: rough.sheetCrop,
        maxHeight: ROUGH_MAX_HEIGHT,
      });
      const image = bytes.byteLength ? await createImageBitmap(new Blob([bytes], { type: "image/png" })) : null;
      images.set(key, image ?? { failed: "ラフの画像が空です" });
      return image;
    } catch (error) {
      images.set(key, { failed: String(error) });
      this.host.status(`ラフ画像を読めませんでした（元のネーム用紙が必要です）: ${error}`);
      return null;
    }
  }
}

function keyOf(sheet: string, rough: RoughImage): string {
  return `${sheet}|${rough.layerId}:${rough.sheetCrop.join(",")}`;
}
