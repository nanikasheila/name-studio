// CLIP STUDIO PAINT's own tool list on this computer (Tool/EditImageTool.todb):
// where it is, read from a copy once and again only when CSP has written it
// since, and CSP と合わせる: after a name opens and whenever the window comes
// back, the pens and erasers taken from it follow what was changed in CSP
// (settings › ペン・キー: follow, say so, or leave them), and groups followed
// (追う) bring in what was added to them there. Brushes changed here as well
// are left alone and named.
import { call, type CspToolLocations } from "../platform/backend";
import { showAlert } from "../platform/alerts";
import { DEFAULT_BRUSH_DPI, type CspSubTool } from "../domain/brush";
import { brushOfTool, planSize, syncPlan, takeTools, untold, type SyncPlan } from "../domain/csplink";
import { cspFollowed, cspSyncMode, loadLibrary, saveToLibrary } from "../platform/prefs";
import type { Brush, Project } from "../model/model";

export interface CspToolsHost {
  project(): Project | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  undo(): void;
  /** The brushes now in the name changed (the name is drawn again by the edit itself). */
  brushesChanged(brushes: Brush[]): void;
  /** Open the list of CSP's sub tools. */
  openList(): void;
}

/** Not more often than this when the window comes back again and again. */
const CHECK_GAP_MS = 2000;
const ALERT = "csp-sync";

function names(brushes: readonly { name: string }[]): string {
  const shown = brushes.slice(0, 4).map((b) => `「${b.name}」`);
  return brushes.length > 4 ? `${shown.join("")}ほか ${brushes.length - 4} 本` : shown.join("");
}

export class CspTools {
  private located: CspToolLocations | null = null;
  private tools: CspSubTool[] | null = null;
  private stamp = "";
  private reading: Promise<CspSubTool[] | null> | null = null;
  private lastCheck = 0;
  /** What was told about (or followed) already: not again, also after it is undone. */
  private readonly told = new Set<string>();
  /** The resolution sizes in px were last turned into mm at, in the list. */
  dpi = DEFAULT_BRUSH_DPI;

  constructor(private readonly host: CspToolsHost) {}

  async locations(): Promise<CspToolLocations> {
    this.located ??= await call("csp_tool_locations").catch(() => ({ tools: null, materials: null }));
    return this.located;
  }

  /** CSP's sub tools as they are now (read again only when CSP wrote its list since); null without CSP. */
  current(force = false): Promise<CspSubTool[] | null> {
    this.reading ??= this.read(force).finally(() => (this.reading = null));
    return this.reading;
  }

  private async read(force: boolean): Promise<CspSubTool[] | null> {
    const { tools: path, materials } = await this.locations();
    if (!path) return null;
    const stamp = await call("csp_tool_stamp", { path }).catch(() => null);
    if (!stamp) return null;
    const key = `${stamp.modifiedMs}:${stamp.size}`;
    if (!force && this.tools && key === this.stamp) return this.tools;
    this.tools = await call("read_csp_sub_tools", { path, materials });
    this.stamp = key;
    return this.tools;
  }

  /** After a name opens and when the window comes back: follow what changed in CSP. */
  async check(): Promise<void> {
    // CSP may be writing its list just now: the next time the window comes back.
    await this.follow().catch(() => {});
  }

  private async follow(): Promise<void> {
    const mode = cspSyncMode();
    if (mode === "off" || Date.now() - this.lastCheck < CHECK_GAP_MS) return;
    this.lastCheck = Date.now();
    const project = this.host.project();
    if (!project || (!project.brushes.some((b) => b.cspLink) && !cspFollowed().size)) {
      if (mode === "auto") await this.followLibrary();
      return;
    }
    const tools = await this.current();
    if (!tools || this.host.project() !== project) return;
    if (mode === "auto") this.followLibraryWith(tools);
    const plan = untold(syncPlan(tools, project.brushes, cspFollowed()), this.told);
    if (!planSize(plan) && !plan.conflicts.length) return;
    const kept = plan.conflicts.length
      ? `${names(plan.conflicts.map(({ brush }) => brush))}は Name Studio でも直してあるので、そのままにしました（一覧で選ぶと CSP のものにします）。`
      : "";
    if (!planSize(plan)) {
      showAlert(ALERT, `CSP で変えたペン・消しゴムのうち、${kept}`, "info", undefined, [
        { label: "一覧で選ぶ", run: () => this.host.openList() },
      ]);
      return;
    }
    const what = this.planText(plan);
    if (mode === "auto") {
      this.apply(plan);
      showAlert(ALERT, `CSP に合わせました: ${what}。${kept}`, "info", kept ? undefined : 12, [
        { label: "元に戻す", run: () => this.host.undo() },
        { label: "一覧", run: () => this.host.openList() },
      ]);
    } else {
      showAlert(ALERT, `CSP で変わりました: ${what}。${kept}`, "info", undefined, [
        { label: "合わせる", run: () => this.apply(plan) },
        { label: "一覧で選ぶ", run: () => this.host.openList() },
      ]);
    }
  }

  private planText(plan: SyncPlan): string {
    return [
      plan.updates.length ? `${names(plan.updates.map(({ brush }) => brush))}の設定` : "",
      plan.additions.length ? `追っているグループに増えた${names(plan.additions)}を取り込み` : "",
    ]
      .filter(Boolean)
      .join("、");
  }

  /** Take what the plan names into the name, as one undoable step, and keep it for other names. */
  apply(plan: SyncPlan): Brush[] {
    const tools = [...plan.updates.map(({ tool }) => tool), ...plan.additions];
    let taken: Brush[] = [];
    this.host.edit((project) => {
      taken = takeTools(project, tools, this.dpi);
    });
    if (!taken.length) return taken;
    saveToLibrary(taken);
    this.host.brushesChanged(taken);
    return taken;
  }

  /** The brushes kept on this computer follow CSP too (no name open, or ones this name does not have). */
  private async followLibrary(): Promise<void> {
    if (!loadLibrary().some((b) => b.cspLink)) return;
    const tools = await this.current().catch(() => null);
    if (tools) this.followLibraryWith(tools);
  }

  private followLibraryWith(tools: readonly CspSubTool[]): void {
    const library = loadLibrary();
    const updates = syncPlan(tools, library, new Set()).updates;
    if (updates.length) saveToLibrary(updates.map(({ brush, tool }) => brushOfTool(tool, this.dpi, brush)));
  }
}
