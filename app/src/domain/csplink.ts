// Brushes taken from CLIP STUDIO PAINT's own tool list stay linked to the sub
// tool they came from (Brush.cspLink: its NodeUuid and a digest of its
// settings then). When CSP's tool list is read again, a sub tool whose
// settings differ from the digest was changed in CSP and the brush can follow
// it; a brush whose own settings differ was changed here and is left alone
// unless asked. Groups followed (追う) bring in sub tools added to them in CSP.
import type { Brush, CspLink, CspValue, Project } from "../model/model";
import { newId } from "./project";
import { brushFromSubTool, sourceLabel, type CspSubTool } from "./brush";

/** The group a sub tool is in, as the tool list shows it ("ペン / マーカー"). */
export function groupKey(tool: Pick<CspSubTool, "group">): string {
  return tool.group.join(" / ") || "サブツール";
}

/** FNV-1a over the text, from `seed`. */
function fnv(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A digest of a sub tool's settings that does not depend on the order of the columns. */
export function settingsStamp(settings: Readonly<Record<string, CspValue>>): string {
  const text = JSON.stringify(
    Object.keys(settings)
      .sort()
      .map((key) => [key, settings[key]]),
  );
  return [fnv(text, 0x811c9dc5), fnv(text, 0x01000193 ^ 0x5bd1e995)].map((h) => h.toString(16).padStart(8, "0")).join("");
}

export function linkOf(tool: CspSubTool): CspLink {
  return { uuid: tool.uuid, stamp: settingsStamp(tool.csp.settings), name: tool.name };
}

/** The brush taken from this sub tool: linked to it, or else (taken before links) with its name and place. */
export function brushFor<B extends Brush>(brushes: readonly B[], tool: CspSubTool): B | undefined {
  const kind = tool.kind === "eraser" ? "eraser" : "pen";
  return (
    brushes.find((b) => b.cspLink?.uuid === tool.uuid) ??
    brushes.find((b) => !b.cspLink && b.kind === kind && b.name === tool.name && b.source === sourceLabel(tool))
  );
}

/**
 * How a sub tool of CSP's list stands with the brushes taken:
 * - `new`: not taken.
 * - `same`: taken, and neither side changed since.
 * - `changed`: changed in CSP since it was taken (the brush was not).
 * - `edited`: changed here since it was taken (CSP's is as it was).
 * - `both`: changed on both sides.
 * - `differs`: taken before links were kept, and the settings are not the same now.
 */
export type ToolState = "new" | "same" | "changed" | "edited" | "both" | "differs";

export const STATE_LABELS: Record<ToolState, string> = {
  new: "",
  same: "取り込み済み",
  changed: "CSP で変わった",
  edited: "ここで直した",
  both: "両方で変わった",
  differs: "CSP と違う",
};

export function stateOf(tool: CspSubTool, brush: Brush | undefined): ToolState {
  if (!brush) return "new";
  const now = settingsStamp(tool.csp.settings);
  const mine = brush.csp ? settingsStamp(brush.csp.settings) : "";
  const link = brush.cspLink;
  if (!link) return mine === now ? "same" : "differs";
  const inCsp = now !== link.stamp;
  const here = mine !== link.stamp;
  if (inCsp && here) return "both";
  if (inCsp) return "changed";
  return here ? "edited" : "same";
}

/**
 * The brush of a sub tool, linked to it. Taken again over `existing`: the
 * same id, a name changed here kept, and sizes in mm at the resolution the
 * brush had.
 */
export function brushOfTool(tool: CspSubTool, dpi: number, existing?: Brush): Brush {
  const brush = brushFromSubTool(tool, existing?.csp?.dpi || dpi, existing?.id ?? "");
  // Its own rows: changed here, they must not change the list as read from CSP.
  if (brush.csp) brush.csp = structuredClone(brush.csp);
  brush.cspLink = linkOf(tool);
  const renamedHere = existing && existing.name !== (existing.cspLink?.name ?? existing.name);
  if (renamedHere) brush.name = existing.name;
  return brush;
}

/** What reading CSP's tool list again would change. */
export interface SyncPlan {
  /** Brushes changed in CSP only: they follow. */
  updates: { brush: Brush; tool: CspSubTool }[];
  /** Brushes changed both here and in CSP: left as they are unless chosen in the list. */
  conflicts: { brush: Brush; tool: CspSubTool }[];
  /** Sub tools new to a followed group. */
  additions: CspSubTool[];
}

export function syncPlan(tools: readonly CspSubTool[], brushes: readonly Brush[], follow: ReadonlySet<string>): SyncPlan {
  const plan: SyncPlan = { updates: [], conflicts: [], additions: [] };
  for (const tool of tools) {
    const brush = brushFor(brushes, tool);
    if (!brush) {
      if (follow.has(groupKey(tool))) plan.additions.push(tool);
      continue;
    }
    if (!brush.cspLink) continue;
    const state = stateOf(tool, brush);
    if (state === "changed") plan.updates.push({ brush, tool });
    else if (state === "both") plan.conflicts.push({ brush, tool });
  }
  return plan;
}

export function planSize(plan: SyncPlan): number {
  return plan.updates.length + plan.additions.length;
}

/** What each item of a plan is, with the settings it has in CSP: each is told (or followed) once. */
function itemKey(kind: string, tool: CspSubTool): string {
  return `${kind}:${tool.uuid}:${settingsStamp(tool.csp.settings)}`;
}

/** The plan without the items in `told`, which then holds them all. */
export function untold(plan: SyncPlan, told: Set<string>): SyncPlan {
  const fresh = (kind: string, tool: CspSubTool) => {
    const key = itemKey(kind, tool);
    if (told.has(key)) return false;
    told.add(key);
    return true;
  };
  return {
    updates: plan.updates.filter(({ tool }) => fresh("u", tool)),
    conflicts: plan.conflicts.filter(({ tool }) => fresh("c", tool)),
    additions: plan.additions.filter((tool) => fresh("a", tool)),
  };
}

/**
 * Take these sub tools into the project: over the brushes taken from them
 * before (same id, so lines drawn with them follow), or as new brushes.
 * Returns the brushes as they are now in the project.
 */
export function takeTools(project: Project, tools: readonly CspSubTool[], dpi: number): Brush[] {
  const taken: Brush[] = [];
  for (const tool of tools) {
    const existing = brushFor(project.brushes, tool);
    const brush = brushOfTool(tool, dpi, existing);
    if (existing) {
      for (const key of Object.keys(existing) as (keyof Brush)[]) if (!(key in brush)) delete existing[key];
      Object.assign(existing, brush, { id: existing.id });
      taken.push(existing);
    } else {
      brush.id = newId(project, "brush");
      project.brushes.push(brush);
      taken.push(brush);
    }
  }
  return taken;
}
