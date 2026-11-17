// The pictures a background request sends: each panel's background box as
// the name shows it (rough, dialogue, the border in blue, 背景の指示 in green
// and orange, no background adopted before), and the pages they are on.
import type { Page, Project } from "../model/model";
import type { SessionFile } from "../platform/backend";
import { backgroundBox, findPanel, isBackground } from "../domain/background";
import { pagePicture, panelPicture, type BackgroundTarget } from "../domain/bgrequest";
import { drawBackgroundGuides } from "../render/backgrounds";
import { loadTips, tracePath, type MmToPx } from "../render/pagedraw";
import { useFonts } from "../domain/fonts";
import { useStyle } from "../domain/style";
import { drawFlatPage, flatPictures, pagePictures, releasePictures, type RoughLoader } from "./flatpage";
import { encode } from "./nameexport";

/** A panel's picture is drawn at this resolution (enough to see the rough, small enough to send). */
export const PANEL_PICTURE_DPI = 150;
const BORDER = "#2f6fdb";

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The pictures of a request, as files of the background folder. */
export async function requestPictures(
  project: Project,
  stamp: string,
  targets: readonly BackgroundTarget[],
  rough: RoughLoader,
): Promise<SessionFile[]> {
  useFonts(project.fonts);
  useStyle(project.style);
  await loadTips(project.brushes);
  const files: SessionFile[] = [];
  const pages = new Set<number>();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  for (const target of targets) {
    const found = findPanel(project, target.panel);
    if (!found) continue;
    const { page, panel } = found;
    pages.add(project.pages.indexOf(page) + 1);
    const [x0, y0, x1, y1] = backgroundBox(project.pageFormat, panel);
    const scale = PANEL_PICTURE_DPI / 25.4;
    canvas.width = Math.max(1, Math.round((x1 - x0) * scale));
    canvas.height = Math.max(1, Math.round((y1 - y0) * scale));
    const m: MmToPx = { scale, x: -x0 * scale, y: -y0 * scale };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // The rough as it is, without a background laid in before.
    const bare: Page = { ...page, references: page.references?.filter((reference) => !isBackground(reference)) };
    const pictures = await flatPictures(project, [bare], rough);
    drawFlatPage(ctx, project, bare, m, pictures);
    releasePictures(pictures);
    ctx.save();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 3;
    tracePath(ctx, panel.shape, m, true);
    ctx.stroke();
    ctx.restore();
    drawBackgroundGuides(ctx, page, m, 2, panel);
    files.push({ path: panelPicture(stamp, panel.id), base64: base64(await encode(canvas, "image/png")) });
  }
  canvas.width = 0;
  for (const picture of await pagePictures(project, [...pages], rough, 72))
    files.push({ path: pagePicture(stamp, picture.number), base64: picture.base64 });
  return files;
}
