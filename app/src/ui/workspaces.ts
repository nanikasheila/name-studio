// 作業の配置 (as CSP's ワークスペース): the palettes, the way the pages are
// shown and the story band, set together for what is being done — 描く (the
// pages large, the pen's palettes), 全体を見る (every page on one canvas, the
// lists and the band) and CSP に渡す (what is still open before writing out).
// Each one keeps what is changed in it: switching away and back brings it as
// it was left, and 既定に戻す brings it as it comes. Beside them, arrangements
// of one's own (as CSP's ワークスペースの登録): the screen as it is, kept under
// a name, gone back to from the icon at the foot of the left icons; they too keep what is changed
// in them.
import { defaultLayout, readLayout, type DockLayout, type PaletteId } from "./dock";
import { localStore } from "../platform/settings";

export type WorkspaceId = "draw" | "overview" | "handoff";
export type ViewMode = "spread" | "single" | "continuous";
/** The story band: as it is, large (F6) or down to its buttons (Shift+F6). */
export type BandState = "strip" | "wide" | "folded";

export interface Workspace {
  docks: DockLayout;
  view: ViewMode;
  /** 連続: how many rows the spreads are in. */
  rows: number;
  band: BandState;
}

export interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  /** The button's id. */
  buttonId: string;
  keys: string[];
  tip: string;
}

export const WORKSPACES: WorkspaceDef[] = [
  {
    id: "draw",
    label: "描く",
    buttonId: "ws-draw",
    keys: ["Ctrl+1"],
    tip: "描く配置: ページを大きく、サブツールとレイヤーだけ。物語の帯はたたむ",
  },
  {
    id: "overview",
    label: "全体",
    buttonId: "ws-overview",
    keys: ["Ctrl+2"],
    tip: "全体を見る配置: 全ページを一枚に並べ、ページ・台本・付箋の一覧と物語の帯を出す",
  },
  {
    id: "handoff",
    label: "CSP",
    buttonId: "ws-handoff",
    keys: ["Ctrl+3"],
    tip: "CSP に渡す配置: ページ・付箋（未決）・保留とレイヤー・詳細。書き出す前に残りを確かめる",
  },
];

export const WORKSPACES_KEY = "namestudio.workspaces";
const IDS = WORKSPACES.map((w) => w.id);
const VIEWS: ViewMode[] = ["spread", "single", "continuous"];
const BANDS: BandState[] = ["strip", "wide", "folded"];

/** Each workspace as it comes. */
export function defaultWorkspace(id: WorkspaceId): Workspace {
  const docks = defaultLayout();
  const show = (side: "left" | "right", ...ids: PaletteId[]) => {
    for (const [key, palette] of Object.entries(docks.palettes)) if (palette.side === side) palette.shown = ids.includes(key as PaletteId);
    // In the order given, top to bottom.
    docks.order = [...docks.order.filter((x) => !ids.includes(x)), ...ids];
  };
  const put = (id: PaletteId, side: "left" | "right") => (docks.palettes[id].side = side);
  switch (id) {
    case "draw":
      show("left", "subtools", "toolprops", "layers");
      // The right column down to its icons: the details are a click away.
      docks.collapsed.right = true;
      return { docks, view: "spread", rows: 1, band: "folded" };
    case "overview":
      show("left", "pages", "script", "notes");
      return { docks, view: "continuous", rows: 2, band: "strip" };
    case "handoff":
      put("layers", "right");
      show("left", "pages", "notes", "held");
      show("right", "layers", "inspector");
      return { docks, view: "spread", rows: 1, band: "folded" };
  }
}

/** An arrangement of one's own: a name and what it shows. */
export interface MyWorkspace {
  name: string;
  workspace: Workspace;
}

/** A workspace by key: one of the three, or `my:<name>`. */
export type WorkspaceKey = WorkspaceId | `my:${string}`;
export const MAX_MINE = 12;
export const MAX_NAME = 30;

/** Which workspace is in use (null: none, as when the one in use was taken away), and the ones left as they were changed. */
export interface WorkspaceStore {
  current: WorkspaceKey | null;
  saved: Partial<Record<WorkspaceId, Workspace>>;
  mine: MyWorkspace[];
}

export const myKey = (name: string): WorkspaceKey => `my:${name}`;

/** A name as it is kept: trimmed, one line, not too long. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function readWorkspace(w: Partial<Workspace>, fallback: Workspace): Workspace {
  return {
    docks: readLayout(w.docks ? JSON.stringify(w.docks) : null),
    view: VIEWS.includes(w.view as ViewMode) ? (w.view as ViewMode) : fallback.view,
    rows: Number.isInteger(w.rows) && (w.rows as number) > 0 ? (w.rows as number) : fallback.rows,
    band: BANDS.includes(w.band as BandState) ? (w.band as BandState) : fallback.band,
  };
}

/** The kept workspaces (anything unreadable: as they come; the arrangement in use counts as 描く until another is chosen). */
export function readWorkspaces(text: string | null): WorkspaceStore {
  const store: WorkspaceStore = { current: "draw", saved: {}, mine: [] };
  if (!text) return store;
  try {
    const kept = JSON.parse(text) as Partial<{
      current: string | null;
      saved: Record<string, Partial<Workspace>>;
      mine: Partial<{ name: unknown; workspace: Partial<Workspace> }>[];
    }>;
    for (const id of IDS) {
      const w = kept.saved?.[id];
      if (!w || typeof w !== "object") continue;
      store.saved[id] = readWorkspace(w, defaultWorkspace(id));
    }
    for (const m of Array.isArray(kept.mine) ? kept.mine : []) {
      const name = typeof m?.name === "string" ? cleanName(m.name) : "";
      if (!name || store.mine.some((x) => x.name === name) || store.mine.length >= MAX_MINE) continue;
      const w = m.workspace && typeof m.workspace === "object" ? m.workspace : {};
      store.mine.push({ name, workspace: readWorkspace(w, defaultWorkspace("draw")) });
    }
    if (IDS.includes(kept.current as WorkspaceId)) store.current = kept.current as WorkspaceId;
    else if (kept.current === null) store.current = null;
    else if (typeof kept.current === "string" && store.mine.some((m) => myKey(m.name) === kept.current))
      store.current = kept.current as WorkspaceKey;
  } catch {
    // As they come.
  }
  return store;
}

const mineOf = (store: WorkspaceStore, key: WorkspaceKey | null) => store.mine.find((m) => myKey(m.name) === key);

/** Keep `now` as the workspace in use is left. */
function leave(store: WorkspaceStore, now: Workspace): void {
  const current = store.current;
  if (current === null) return;
  const mine = mineOf(store, current);
  if (mine) mine.workspace = structuredClone(now);
  else if (IDS.includes(current as WorkspaceId)) store.saved[current as WorkspaceId] = structuredClone(now);
}

/** Leave the current workspace as `now` is and go to `to`: what to show (as it was left, or as it comes; null: no such one). */
export function switchWorkspace(store: WorkspaceStore, now: Workspace, to: WorkspaceKey): Workspace | null {
  const mine = mineOf(store, to);
  if (!mine && !IDS.includes(to as WorkspaceId)) return null;
  leave(store, now);
  store.current = to;
  return structuredClone(mine ? mine.workspace : (store.saved[to as WorkspaceId] ?? defaultWorkspace(to as WorkspaceId)));
}

/** Keep `now` under `name` (one of that name is replaced) and make it the one in use. False: the name is empty or there are too many. */
export function saveAs(store: WorkspaceStore, now: Workspace, name: string): boolean {
  const clean = cleanName(name);
  if (!clean) return false;
  const same = store.mine.find((m) => m.name === clean);
  if (!same && store.mine.length >= MAX_MINE) return false;
  // What was changed in the one left is kept there, unless it is the one replaced.
  if (store.current !== myKey(clean)) leave(store, now);
  if (same) same.workspace = structuredClone(now);
  else store.mine.push({ name: clean, workspace: structuredClone(now) });
  store.current = myKey(clean);
  return true;
}

/** Take one of one's own away (the screen stays as it is; if it was in use, none is). */
export function removeMine(store: WorkspaceStore, name: string): void {
  store.mine = store.mine.filter((m) => m.name !== name);
  if (store.current === myKey(name)) store.current = null;
}

/** Call one of one's own something else. False: the new name is empty or taken. */
export function renameMine(store: WorkspaceStore, from: string, to: string): boolean {
  const clean = cleanName(to);
  const mine = store.mine.find((m) => m.name === from);
  if (!mine || !clean || (clean !== from && store.mine.some((m) => m.name === clean))) return false;
  if (store.current === myKey(from)) store.current = myKey(clean);
  mine.name = clean;
  return true;
}

/** Put one of one's own `step` places up (-) or down (+). */
export function moveMine(store: WorkspaceStore, name: string, step: number): void {
  const at = store.mine.findIndex((m) => m.name === name);
  const to = Math.max(0, Math.min(store.mine.length - 1, at + step));
  if (at < 0 || to === at) return;
  const [m] = store.mine.splice(at, 1);
  store.mine.splice(to, 0, m);
}

/** What the workspaces change on the screen, and read back from it. */
export interface WorkspaceHost {
  /** The palettes, the view and the band as they are now. */
  current(): Workspace;
  /** Show `workspace` (the focus mode left, if on). */
  apply(workspace: Workspace): void;
  status(message: string): void;
}

export class Workspaces {
  private readonly store: WorkspaceStore;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = localStore(),
  ) {
    this.store = readWorkspaces(this.storage?.getItem(WORKSPACES_KEY) ?? null);
  }

  get current(): WorkspaceKey | null {
    return this.store.current;
  }

  /** The arrangements of one's own, in order. */
  get mine(): readonly string[] {
    return this.store.mine.map((m) => m.name);
  }

  /** The name of the one of one's own in use, if one is. */
  get currentMine(): string | null {
    return this.store.mine.find((m) => myKey(m.name) === this.store.current)?.name ?? null;
  }

  /** Go to `key` (again on the one in use: nothing changes). */
  use(key: WorkspaceKey): void {
    const def = WORKSPACES.find((w) => w.id === key);
    const label = def?.label ?? key.slice(3);
    if (key === this.store.current) {
      this.host.status(def ? `今は「${label}」の配置です（既定に戻すのはコマンドの「配置を既定に戻す」）` : `今は「${label}」の配置です`);
      return;
    }
    const to = switchWorkspace(this.store, this.host.current(), key);
    if (!to) return;
    this.host.apply(to);
    this.keep();
    this.host.status(
      def
        ? `「${label}」の配置にしました（${def.tip.split(": ")[1]}）。欄を動かすとこの配置に覚えます`
        : `「${label}」の配置にしました。欄を動かすとこの配置に覚えます`,
    );
  }

  /** The screen as it is, kept as `name` and in use. */
  saveAs(name: string): boolean {
    const clean = cleanName(name);
    const replaced = this.store.mine.some((m) => m.name === clean);
    if (!saveAs(this.store, this.host.current(), name)) {
      this.host.status(clean ? `名前をつけた配置は ${MAX_MINE} までです。使わないものを消してください` : "名前を入れてください");
      return false;
    }
    this.keep();
    this.host.status(`今の配置を「${clean}」${replaced ? "に上書きしました" : "として残しました"}（左の端の配置のアイコンから戻れます）`);
    return true;
  }

  remove(name: string): void {
    removeMine(this.store, name);
    this.keep();
    this.host.status(`配置「${name}」を消しました（画面はそのまま）`);
  }

  rename(from: string, to: string): boolean {
    const ok = renameMine(this.store, from, to);
    if (ok) this.keep();
    else this.host.status(cleanName(to) ? `「${cleanName(to)}」はもうあります` : "名前を入れてください");
    return ok;
  }

  move(name: string, step: number): void {
    moveMine(this.store, name, step);
    this.keep();
  }

  /** The one in use, as it comes (one of one's own: as it was kept is all it has, so nothing changes). */
  reset(): void {
    const current = this.store.current;
    if (!current || !IDS.includes(current as WorkspaceId)) {
      this.host.status("既定に戻せるのは 描く・全体・CSP の配置です");
      return;
    }
    const id = current as WorkspaceId;
    delete this.store.saved[id];
    this.host.apply(defaultWorkspace(id));
    this.keep();
    const def = WORKSPACES.find((w) => w.id === id)!;
    this.host.status(`「${def.label}」の配置を既定に戻しました`);
  }

  private keep(): void {
    try {
      this.storage?.setItem(WORKSPACES_KEY, JSON.stringify(this.store));
    } catch {
      // Not kept for the next start; the arrangement still holds now.
    }
  }
}
