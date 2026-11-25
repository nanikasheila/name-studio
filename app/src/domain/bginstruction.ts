// 指示.json: a background request as data, for name-blockout (and any tool
// that draws backgrounds from it). The format is name-blockout's contract,
// schema/v1/instruction.schema.json in github.com/nanikasheila/name-blockout:
// one file per request, a shot per panel with its picture (the paper box and
// dpi), its words, its perspective ruler as the author drew it (paper mm),
// the camera this app works out from it (a hint name-blockout checks its own
// against), the place and things. 依頼.md stays the words for an AI; this is
// what a tool reads. Pure.
import { bounds } from "../model/geometry";
import type { Project } from "../model/model";
import {
  backgroundBox,
  backgroundOf,
  boxPixels,
  findPanel,
  horizonAcross,
  nextTake,
  panelLabel,
  panelNumber,
  type BackgroundTake,
} from "./background";
import { cameraFit } from "./bgcamera";
import { lookInstruction } from "./bglook";
import { applyAnswers } from "./bgreview";
import type { BackgroundRequest } from "./bgrequest";
import { rulerOf } from "./bgruler";

export { INSTRUCTION_FILE } from "./background";
export const INSTRUCTION_FORMAT = "name-blockout/instruction";
export const INSTRUCTION_VERSION = 1;
export const INSTRUCTION_SCHEMA = "https://raw.githubusercontent.com/nanikasheila/name-blockout/main/schema/v1/instruction.schema.json";

type Pt = [number, number];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pt = ([x, y]: readonly number[]): Pt => [r3(x), r3(y)];
const one = (text: string | undefined) => text?.trim().replace(/\s*\n\s*/g, " / ") || undefined;

/** The shot for one panel (none when the panel is gone). */
export function instructionShot(
  project: Project,
  panelId: string,
  dpi: number,
  takes: readonly BackgroundTake[],
): Record<string, unknown> | null {
  const found = findPanel(project, panelId);
  if (!found) return null;
  const { page, panel } = found;
  const bg = backgroundOf(panel);
  const box = backgroundBox(project.pageFormat, panel);
  const shot: Record<string, unknown> = {
    id: panel.id,
    label: panelLabel(project, page, panel),
    page: project.pages.indexOf(page) + 1,
    order: panelNumber(page, panel),
    stage: lookInstruction(panel).stage,
    frame: {
      boxMm: box,
      dpi,
      sizePx: boxPixels(box, dpi),
      shapeMm: panel.shape.map(pt),
      ...(panel.openEdges?.length ? { openEdges: [...panel.openEdges] } : {}),
    },
  };
  const dialogue = page.lines
    .filter((line) => line.panel === panel.id && line.text.trim())
    .map((line) => `${project.characters.find((c) => c.id === line.speaker)?.name ?? ""}「${line.text.replace(/\s*\n\s*/g, "")}」`);
  const intent = {
    ...(bg.none ? { none: true } : {}),
    ...(one(bg.brief) ? { brief: one(bg.brief) } : {}),
    ...(bg.camera ? { camera: bg.camera } : {}),
    ...(one(panel.note) ? { memo: one(panel.note) } : {}),
    ...(dialogue.length ? { dialogue } : {}),
    ...(one(page.memo) ? { pageMemo: one(page.memo) } : {}),
  };
  if (Object.keys(intent).length) shot.intent = intent;
  const ruler = rulerOf(panel);
  if (ruler.horizon) {
    shot.ruler = {
      points: ruler.vanishing.length,
      horizonMm: horizonAcross(panel, ruler.horizon).map(pt),
      ...(ruler.vanishing.length ? { vanishingMm: ruler.vanishing.map(pt) } : {}),
      ...(ruler.guides.length ? { guidesMm: ruler.guides.map((line) => line.map(pt)) } : {}),
    };
    const fit = cameraFit(panel, box, dpi);
    if (fit)
      shot.camera = {
        hint: {
          mode: fit.mode,
          points: fit.points,
          lensMm: fit.lensMm,
          focalPx: fit.focalPx,
          lensFromPoints: fit.lensFromPoints,
          shiftX: fit.shiftX,
          shiftY: fit.shiftY,
          tiltDeg: fit.tiltDeg,
          rollDeg: fit.rollDeg,
          turnsDeg: fit.turnsDeg,
        },
      };
  }
  if (bg.place?.trim()) shot.place = { asset: bg.place.trim() };
  const objects = (bg.objects ?? []).map((object) => ({
    id: object.id,
    label: object.label,
    shapeMm: boxShape(object.shape),
    ...(object.asset?.trim() ? { asset: object.asset.trim() } : {}),
  }));
  if (objects.length) shot.objects = objects;
  const far = (bg.far ?? []).map((layer) => ({
    kind: layer.kind,
    ...(layer.kind === "panorama" && layer.asset?.trim() ? { asset: layer.asset.trim() } : {}),
    ...(layer.kind === "panorama" && layer.turnDeg ? { turnDeg: layer.turnDeg } : {}),
    ...(layer.kind !== "panorama" && layer.seed !== undefined ? { seed: layer.seed } : {}),
  }));
  if (far.length) shot.far = far;
  const { look } = lookInstruction(panel);
  if (look) shot.look = look;
  // The author's answers to name-blockout's questions that have no field here, and those left to its guess.
  applyAnswers(shot, bg.answers);
  shot.output = { take: String(nextTake(takes, panel.id)) };
  return shot;
}

/** 物の範囲 as name-studio keeps it: a box (its outline's bounds), four corners clockwise. */
function boxShape(shape: readonly Pt[] | readonly number[][]): Pt[] {
  const [x0, y0, x1, y1] = bounds(shape as Pt[]);
  return [pt([x0, y0]), pt([x1, y0]), pt([x1, y1]), pt([x0, y1])];
}

/** 指示.json for a request (as an object; JSON.stringify it to write). */
export function requestInstruction(
  project: Project,
  request: BackgroundRequest,
  takes: readonly BackgroundTake[],
  app?: { version?: string; createdAt?: string },
): Record<string, unknown> {
  const shots = request.targets.flatMap((target) => {
    const shot = instructionShot(project, target.panel, request.dpi, takes);
    return shot ? [shot] : [];
  });
  return {
    $schema: INSTRUCTION_SCHEMA,
    format: INSTRUCTION_FORMAT,
    formatVersion: INSTRUCTION_VERSION,
    createdBy: { app: "name-studio", ...(app?.version ? { version: app.version } : {}) },
    request: {
      id: request.stamp,
      ...(app?.createdAt ? { createdAt: app.createdAt } : {}),
      ...(request.note.trim() ? { note: request.note.trim() } : {}),
    },
    work: {
      title: project.title,
      paperMm: [...project.pageFormat.canvasMm],
      binding: project.binding,
      ...(project.backgrounds?.brief?.trim() ? { worldBrief: project.backgrounds.brief.trim() } : {}),
    },
    folders: { background: request.folder, ...(request.assets ? { assets: request.assets.folder } : {}) },
    shots,
  };
}
