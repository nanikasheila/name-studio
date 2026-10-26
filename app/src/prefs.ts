// What is kept on this computer for the next start, by what it is for. Each
// reads and writes through settings.ts (storage may be missing, blocked or
// full) and hands the modules that compute plain values, so that those never
// touch the browser's storage themselves.
import { withBrushes } from "./brush";
import { defaultsFrom, defaultsOf, type NewNameDefaults } from "./namedefaults";
import { normalizeCurve, defaultPenSettings, parsePenSettings, type PenSettings } from "./pen";
import { localStore, readJson, writeJson, writeText } from "./settings";
import { shapesFrom } from "./shapes";
import { snapFrom, type SnapSettings } from "./snapping";
import type { Brush, Project, StoryShape } from "./model";

// --- the page editor's choices ------------------------------------------------------

export const PANEL_CARRIES_KEY = "namestudio.panelCarries";
export const BALLOON_TEXT_KEY = "namestudio.balloonTextFollows";
export const SHOW_NOTES_KEY = "namestudio.showNotes";
export const SINGLE_PAGE_KEY = "namestudio.singlePage";
export const CONTINUOUS_KEY = "namestudio.continuous";
export const ROWS_KEY = "namestudio.rows";
export const PAGE_GAP_KEY = "namestudio.pageGap";

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
