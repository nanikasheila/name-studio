import { describe, expect, it } from "vitest";
import { column, movePalette } from "./dock";
import { defaultWorkspace, readWorkspaces, switchWorkspace, Workspaces, WORKSPACES_KEY, type Workspace } from "./workspaces";

const shownIn = (w: Workspace, side: "left" | "right") => column(w.docks, side).filter((id) => w.docks.palettes[id].shown);

describe("作業の配置", () => {
  it("comes with the palettes, the view and the band each use asks for", () => {
    const draw = defaultWorkspace("draw");
    expect(shownIn(draw, "left")).toEqual(["subtools", "layers"]);
    expect(draw.docks.collapsed.right).toBe(true);
    expect([draw.view, draw.band]).toEqual(["spread", "folded"]);
    const overview = defaultWorkspace("overview");
    expect(shownIn(overview, "left")).toEqual(["pages", "script", "notes"]);
    expect([overview.view, overview.rows, overview.band]).toEqual(["continuous", 2, "strip"]);
    const handoff = defaultWorkspace("handoff");
    expect(shownIn(handoff, "left")).toEqual(["pages", "notes", "held"]);
    expect(shownIn(handoff, "right")).toEqual(["layers", "inspector"]);
  });

  it("keeps what was changed in one when going to another, and brings it back", () => {
    const store = readWorkspaces(null);
    // The arrangement in use before any was chosen counts as 描く.
    const mine = defaultWorkspace("overview");
    movePalette(mine.docks, "cast", "right", null);
    const overview = switchWorkspace(store, mine, "overview");
    expect(store.current).toBe("overview");
    expect(overview).toEqual(defaultWorkspace("overview"));
    overview.docks.palettes.script.shown = false;
    const back = switchWorkspace(store, overview, "draw");
    expect(back.docks.palettes.cast.side).toBe("right");
    expect(switchWorkspace(store, back, "overview").docks.palettes.script.shown).toBe(false);
  });

  it("reads back what was kept, anything spoilt as it comes", () => {
    const kept = { current: "handoff", saved: { overview: { docks: { order: ["pages"] }, view: "sideways", rows: -1, band: "wide" }, other: {} } };
    const store = readWorkspaces(JSON.stringify(kept));
    expect(store.current).toBe("handoff");
    const overview = store.saved.overview!;
    expect([overview.view, overview.rows, overview.band]).toEqual(["continuous", 2, "wide"]);
    // Palettes left out of what was kept are where they go by default.
    expect(overview.docks.order).toHaveLength(9);
    expect(readWorkspaces("{not json").current).toBe("draw");
  });

  it("goes back to a workspace as it comes, and keeps the choice for the next start", () => {
    const items = new Map<string, string>();
    const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
    const applied: Workspace[] = [];
    let now = defaultWorkspace("draw");
    const host = { current: () => now, apply: (w: Workspace) => (applied.push(w), (now = w)), status: () => undefined };
    const workspaces = new Workspaces(host, storage);
    workspaces.use("handoff");
    now.docks.palettes.held.shown = false;
    workspaces.reset();
    expect(applied.at(-1)).toEqual(defaultWorkspace("handoff"));
    // Again on the one in use: nothing changes.
    workspaces.use("handoff");
    expect(applied).toHaveLength(2);
    expect(new Workspaces(host, storage).current).toBe("handoff");
    expect(JSON.parse(items.get(WORKSPACES_KEY)!).saved.handoff).toBeUndefined();
  });
});
