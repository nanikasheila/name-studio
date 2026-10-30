// 作業の配置 (as CSP's ワークスペース): the palettes, the way the pages are
// shown and the story band, set together for what is being done — 描く (the
// pages large, the pen's palettes), 全体を見る (every page on one canvas, the
// lists and the band) and CSP に渡す (what is still open before writing out).
// Each one keeps what is changed in it: switching away and back brings it as
// it was left, and 既定に戻す brings it as it comes.
import { defaultLayout, readLayout, type DockLayout, type PaletteId } from "./dock";
import { localStore } from "./settings";

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
  { id: "draw", label: "描く", buttonId: "ws-draw", keys: ["Ctrl+1"], tip: "描く配置: ページを大きく、サブツールとレイヤーだけ。物語の帯はたたむ" },
  { id: "overview", label: "全体", buttonId: "ws-overview", keys: ["Ctrl+2"], tip: "全体を見る配置: 全ページを一枚に並べ、ページ・台本・付箋の一覧と物語の帯を出す" },
  { id: "handoff", label: "CSP", buttonId: "ws-handoff", keys: ["Ctrl+3"], tip: "CSP に渡す配置: ページ・付箋（未決）・保留とレイヤー・詳細。書き出す前に残りを確かめる" },
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
      show("left", "subtools", "layers");
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

/** Which workspace is in use, and the ones left as they were changed. */
export interface WorkspaceStore {
  current: WorkspaceId;
  saved: Partial<Record<WorkspaceId, Workspace>>;
}

/** The kept workspaces (anything unreadable: as they come; the arrangement in use counts as 描く until another is chosen). */
export function readWorkspaces(text: string | null): WorkspaceStore {
  const store: WorkspaceStore = { current: "draw", saved: {} };
  if (!text) return store;
  try {
    const kept = JSON.parse(text) as Partial<{ current: string; saved: Record<string, Partial<Workspace>> }>;
    if (IDS.includes(kept.current as WorkspaceId)) store.current = kept.current as WorkspaceId;
    for (const id of IDS) {
      const w = kept.saved?.[id];
      if (!w || typeof w !== "object") continue;
      const fallback = defaultWorkspace(id);
      store.saved[id] = {
        docks: readLayout(w.docks ? JSON.stringify(w.docks) : null),
        view: VIEWS.includes(w.view as ViewMode) ? (w.view as ViewMode) : fallback.view,
        rows: Number.isInteger(w.rows) && (w.rows as number) > 0 ? (w.rows as number) : fallback.rows,
        band: BANDS.includes(w.band as BandState) ? (w.band as BandState) : fallback.band,
      };
    }
  } catch {
    // As they come.
  }
  return store;
}

/** Leave the current workspace as `now` is and go to `to`: what to show (as it was left, or as it comes). */
export function switchWorkspace(store: WorkspaceStore, now: Workspace, to: WorkspaceId): Workspace {
  store.saved[store.current] = structuredClone(now);
  store.current = to;
  return structuredClone(store.saved[to] ?? defaultWorkspace(to));
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

  get current(): WorkspaceId {
    return this.store.current;
  }

  /** Go to `id` (again on the one in use: nothing changes). */
  use(id: WorkspaceId): void {
    const def = WORKSPACES.find((w) => w.id === id)!;
    if (id === this.store.current) {
      this.host.status(`今は「${def.label}」の配置です（既定に戻すのはコマンドの「配置を既定に戻す」）`);
      return;
    }
    this.host.apply(switchWorkspace(this.store, this.host.current(), id));
    this.keep();
    this.host.status(`「${def.label}」の配置にしました（${def.tip.split(": ")[1]}）。欄を動かすとこの配置に覚えます`);
  }

  /** The one in use, as it comes. */
  reset(): void {
    delete this.store.saved[this.store.current];
    this.host.apply(defaultWorkspace(this.store.current));
    this.keep();
    const def = WORKSPACES.find((w) => w.id === this.store.current)!;
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
