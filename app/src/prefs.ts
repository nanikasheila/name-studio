// What is kept on this computer for the next start, by what it is for. Each
// reads and writes through settings.ts (storage may be missing, blocked or
// full) and hands the modules that compute plain values, so that those never
// touch the browser's storage themselves.
import { withBrushes } from "./brush";
import { handSizesFrom, presetsFrom, type HandSizes, type SizePresets } from "./brushpicks";
import { EXPORT_MEMORIES, memoryFrom, memoryKey, withMemory, type ExportMemory } from "./exportmemory";
import { fillSettingsFrom, type FillSettings } from "./fillsettings";
import { defaultsFrom, defaultsOf, type NewNameDefaults } from "./namedefaults";
import { normalizeCurve, defaultPenSettings, parsePenSettings, type PenSettings } from "./pen";
import { forgotten, recentFrom, remembered, type RecentName } from "./recent";
import { localStore, readJson, readText, writeJson, writeText } from "./settings";
import { shapesFrom } from "./shapes";
import { snapFrom, type SnapSettings } from "./snapping";
import type { Brush, Project, StoryShape } from "./model";
import type { PanelFit } from "./panels";

// --- the page editor's choices ------------------------------------------------------

export const PANEL_CARRIES_KEY = "namestudio.panelCarries";
export const BALLOON_TEXT_KEY = "namestudio.balloonTextFollows";
export const SHOW_NOTES_KEY = "namestudio.showNotes";
export const SINGLE_PAGE_KEY = "namestudio.singlePage";
export const CONTINUOUS_KEY = "namestudio.continuous";
export const ROWS_KEY = "namestudio.rows";
export const PAGE_GAP_KEY = "namestudio.pageGap";
/** ヘルプの帯 under the window shown ("1") or not. */
export const HELP_BAR_KEY = "namestudio.helpBar";
/** The first-time guide seen (or closed): "editor" and "start" each once. */
export const TOUR_SEEN_KEY = "namestudio.tourSeen";

/** コマの入れ替え・保留コマを入れるとき: "stretch" (入れ替え先のコマに合わせる) or "keep" (縦横比を保つ). */
export const SWAP_FIT_KEY = "namestudio.swapFit";

/** How the contents go into another panel when panels swap (out of the box: fitted to the panel, as before). */
export function swapFit(): PanelFit {
  return readText(SWAP_FIT_KEY) === "keep" ? "keep" : "stretch";
}

export function setSwapFit(fit: PanelFit): void {
  writeText(SWAP_FIT_KEY, fit);
}

// --- 塗り -------------------------------------------------------------------------------

export const FILL_KEY = "namestudio.fill";

/** The fill tool's way, tone and settings kept on this computer (anything unreadable is the default). */
export function loadFillSettings(): FillSettings {
  return fillSettingsFrom(readJson(FILL_KEY, null));
}

export function saveFillSettings(settings: FillSettings): void {
  writeJson(FILL_KEY, settings);
}

// --- 吸着 ------------------------------------------------------------------------------

export const SNAP_KEY = "namestudio.snap";

/** The snap settings kept on this computer (anything unreadable is the default). */
export function loadSnap(): SnapSettings {
  return snapFrom(readJson(SNAP_KEY, null));
}

export function saveSnap(settings: SnapSettings): void {
  writeJson(SNAP_KEY, settings);
}

// --- この PC に置く型 --------------------------------------------------------------

const SHAPES_KEY = "namestudio.storyShapes";

/** Own shapes kept on this computer, to use in other names. */
export function libraryShapes(): StoryShape[] {
  return shapesFrom(readJson(SHAPES_KEY, []));
}

/** Keep (or update) an own shape on this computer. */
export function keepShape(shape: StoryShape): void {
  // Storage may be off; the shape still lives in the name.
  const kept = libraryShapes().filter((s) => s.id !== shape.id);
  kept.push(structuredClone(shape));
  writeJson(SHAPES_KEY, kept);
}

export function forgetShape(id: string): void {
  writeJson(
    SHAPES_KEY,
    libraryShapes().filter((s) => s.id !== id),
  );
}

// --- brushes kept between projects ---------------------------------------------------

const BRUSHES_KEY = "name-studio.brushes";

/** Brushes taken from CSP before, in any project (this computer only). */
export function loadLibrary(): Brush[] {
  const brushes = readJson(BRUSHES_KEY, []);
  return Array.isArray(brushes) ? (brushes as Brush[]) : [];
}

export function saveToLibrary(brushes: Brush[]): void {
  // Storage full or blocked: the brushes still live in the project.
  writeJson(BRUSHES_KEY, withBrushes(loadLibrary(), brushes));
}

// --- ブラシサイズ: the round buttons, and the size each pen was last used at ---------

const SIZE_PRESETS_KEY = "namestudio.sizePresets";
const HAND_SIZES_KEY = "namestudio.handSizes";

export function loadSizePresets(): SizePresets {
  return presetsFrom(readJson(SIZE_PRESETS_KEY, null));
}

/** None: back to the sizes out of the box. */
export function saveSizePresets(presets: SizePresets | null): void {
  if (presets) writeJson(SIZE_PRESETS_KEY, presets);
  else writeText(SIZE_PRESETS_KEY, null);
}

export function loadHandSizes(): HandSizes {
  return handSizesFrom(readJson(HAND_SIZES_KEY, null));
}

export function saveHandSizes(sizes: HandSizes): void {
  writeJson(HAND_SIZES_KEY, sizes);
}

// --- 新しいネームの既定 -------------------------------------------------------------

export const NEW_NAME_KEY = "namestudio.newNameDefaults";

/** The kept defaults, or null when there are none (or they do not read). */
export function newNameDefaults(): NewNameDefaults | null {
  return defaultsFrom(readJson(NEW_NAME_KEY, null));
}

export function saveNewNameDefaults(project: Project): NewNameDefaults {
  const defaults = defaultsOf(project);
  if (Object.keys(defaults).length) writeJson(NEW_NAME_KEY, defaults);
  else writeText(NEW_NAME_KEY, null);
  return defaults;
}

// --- ペンタブレット ------------------------------------------------------------------

export const PEN_SETTINGS_KEY = "namestudio.pen";

type Listener = (settings: PenSettings) => void;

/** The settings in use; the editor and the dialog share one. */
export class PenPreferences {
  private value: PenSettings;
  private readonly listeners: Listener[] = [];

  constructor(private readonly storage: Storage | null = localStore()) {
    let text: string | null = null;
    try {
      text = this.storage?.getItem(PEN_SETTINGS_KEY) ?? null;
    } catch {
      // Unreadable storage: the defaults.
    }
    this.value = parsePenSettings(text);
  }

  get settings(): PenSettings {
    return this.value;
  }

  update(change: Partial<PenSettings>): void {
    this.value = { ...this.value, ...change };
    if (change.pressureCurve) this.value.pressureCurve = normalizeCurve(change.pressureCurve);
    try {
      this.storage?.setItem(PEN_SETTINGS_KEY, JSON.stringify(this.value));
    } catch {
      // Not kept for the next start; the setting still holds now.
    }
    for (const listener of this.listeners) listener(this.value);
  }

  reset(): void {
    this.update(defaultPenSettings());
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener);
  }
}

export const penPreferences = new PenPreferences();

// --- 命令パレット ------------------------------------------------------------------

export const RECENT_COMMANDS_KEY = "namestudio.recentCommands";

/** The commands used last, newest first. */
export function loadRecentCommands(): string[] {
  const kept = readJson(RECENT_COMMANDS_KEY, []);
  return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
}

export function saveRecentCommands(ids: string[]): void {
  writeJson(RECENT_COMMANDS_KEY, ids);
}

// --- 最近のネーム --------------------------------------------------------------------

export const RECENT_NAMES_KEY = "namestudio.recentNames";

/** The names opened or saved last, newest first. */
export function loadRecentNames(): RecentName[] {
  return recentFrom(readJson(RECENT_NAMES_KEY, []));
}

/** Keep a name opened or saved now at the top of the start screen's list. */
export function rememberName(path: string, project: Pick<Project, "title" | "pages">): void {
  writeJson(RECENT_NAMES_KEY, remembered(loadRecentNames(), { path, title: project.title, pages: project.pages.length, timeMs: Date.now() }));
}

export function forgetName(path: string): void {
  writeJson(RECENT_NAMES_KEY, forgotten(loadRecentNames(), path));
}

// --- 書き出しの設定（ネームごと） ------------------------------------------------------

export const EXPORT_MEMORY_KEY = "namestudio.exportMemory";

function exportMemories(): Record<string, ExportMemory> {
  const kept = readJson(EXPORT_MEMORY_KEY, {});
  if (typeof kept !== "object" || kept === null || Array.isArray(kept)) return {};
  const read: Record<string, ExportMemory> = {};
  for (const [key, value] of Object.entries(kept)) {
    const memory = memoryFrom(value);
    if (memory) read[key] = memory;
  }
  return read;
}

/** How the name at `path` was written out last on this computer, if it was. */
export function loadExportMemory(path: string): ExportMemory | null {
  return exportMemories()[memoryKey(path)] ?? null;
}

export function keepExportMemory(path: string, memory: ExportMemory): void {
  writeJson(EXPORT_MEMORY_KEY, withMemory(exportMemories(), path, memory));
}

// --- セリフだけ反映の結果（ネームごと、最後の 1 回） ----------------------------------------

export const LAST_UPDATE_KEY = "namestudio.lastDialogueUpdate";

/** The last セリフだけ反映 of a name: what it did on each page, to go there again. */
export interface LastDialogueUpdate {
  timeMs: number;
  outDir: string;
  /** The result in a line. */
  first: string;
  rows: { pages: number[]; text: string; attention: boolean }[];
}

function lastUpdateFrom(value: unknown): LastDialogueUpdate | null {
  const kept = value as Partial<LastDialogueUpdate> | null;
  if (typeof kept?.timeMs !== "number" || typeof kept.first !== "string" || typeof kept.outDir !== "string" || !Array.isArray(kept.rows)) return null;
  const rows = kept.rows.filter(
    (row) => typeof row?.text === "string" && Array.isArray(row.pages) && row.pages.length > 0 && row.pages.every((page) => Number.isInteger(page) && page > 0),
  );
  return { timeMs: kept.timeMs, outDir: kept.outDir, first: kept.first, rows: rows.map((row) => ({ pages: row.pages, text: row.text, attention: !!row.attention })) };
}

function lastUpdates(): Record<string, unknown> {
  const kept = readJson(LAST_UPDATE_KEY, {});
  return typeof kept === "object" && kept !== null && !Array.isArray(kept) ? (kept as Record<string, unknown>) : {};
}

export function loadLastUpdate(path: string): LastDialogueUpdate | null {
  return lastUpdateFrom(lastUpdates()[memoryKey(path)]);
}

/** Keeps `update` as the name's last; the names updated longest ago go beyond `EXPORT_MEMORIES`. */
export function keepLastUpdate(path: string, update: LastDialogueUpdate): void {
  const all = Object.entries({ ...lastUpdates(), [memoryKey(path)]: update })
    .map(([key, value]) => [key, lastUpdateFrom(value)] as const)
    .filter((entry): entry is readonly [string, LastDialogueUpdate] => entry[1] !== null)
    .sort((a, b) => b[1].timeMs - a[1].timeMs)
    .slice(0, EXPORT_MEMORIES);
  writeJson(LAST_UPDATE_KEY, Object.fromEntries(all));
}
