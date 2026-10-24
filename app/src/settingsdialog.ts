// 設定: the ネーム's own settings (コマ間, kept in its file) and this
// computer's (the room between spreads, 吸着). Changes apply at once.
import { $ } from "./dom";
import { PAGE_GAP_KEY, type PageEditor } from "./editor";
import { GRID_GAP_MM } from "./layout";
import { gutters, setBinding, setGutters, type Project } from "./project";
import { writeNumber } from "./settings";
import { DEFAULT_SNAP, MAX_GRID_MM, MIN_GRID_MM, saveSnap, type SnapSettings } from "./snapping";

export interface SettingsHost {
  readonly editor: PageEditor;
  project(): Project | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  /** The snap settings changed (the grid box beside the panel tool shows them). */
  snapChanged(): void;
}

const SNAP_BOXES: [keyof SnapSettings, string][] = [
  ["axis", "st-snap-axis"],
  ["panels", "st-snap-panels"],
  ["frame", "st-snap-frame"],
  ["grid", "st-snap-grid"],
];

export class SettingsDialog {
  constructor(private readonly host: SettingsHost) {
    const number = (id: string) => $<HTMLInputElement>(id);
    for (const id of ["st-gutter-across", "st-gutter-down"]) {
      number(id).addEventListener("change", () => {
        const across = Number(number("st-gutter-across").value);
        const down = Number(number("st-gutter-down").value);
        this.host.edit((project) => setGutters(project, { across, down }));
        this.render();
        const now = this.host.project();
        if (now) this.host.status(`コマ間を 左右 ${gutters(now).across} mm・上下 ${gutters(now).down} mm にしました（これから割るコマに効きます）`);
      });
    }
    $<HTMLSelectElement>("st-binding").addEventListener("change", (event) => {
      const binding = (event.target as HTMLSelectElement).value === "left" ? "left" : "right";
      const turnText = $<HTMLInputElement>("st-binding-text").checked;
      this.host.edit((project) => setBinding(project, binding, turnText));
      this.render();
      this.host.status(binding === "left" ? "左綴じにしました（左から右へ読みます）" : "右綴じにしました（右から左へ読みます）");
    });
    number("st-page-gap").addEventListener("input", () => {
      const value = Number(number("st-page-gap").value);
      if (!Number.isFinite(value)) return;
      this.host.editor.setPageGap(value);
      writeNumber(PAGE_GAP_KEY, this.host.editor.pageGapMm);
    });
    number("st-page-gap").addEventListener("change", () => this.render());
    for (const [key, id] of SNAP_BOXES) {
      $<HTMLInputElement>(id).addEventListener("change", (event) => {
        this.changeSnap({ [key]: (event.target as HTMLInputElement).checked });
      });
    }
    number("st-grid-mm").addEventListener("change", () => {
      const value = Number(number("st-grid-mm").value);
      if (Number.isFinite(value) && value >= MIN_GRID_MM && value <= MAX_GRID_MM) this.changeSnap({ gridMm: value });
      this.render();
    });
    $("st-reset").addEventListener("click", () => {
      this.host.editor.setPageGap(GRID_GAP_MM);
      writeNumber(PAGE_GAP_KEY, GRID_GAP_MM);
      this.changeSnap({ ...DEFAULT_SNAP });
      this.render();
      this.host.status("この PC の設定（ページの間隔・吸着）を初期に戻しました");
    });
  }

  open(): void {
    this.render();
    $<HTMLDialogElement>("settings-dialog").showModal();
  }

  /** Part of the snap settings changed, kept for the next start. */
  changeSnap(change: Partial<SnapSettings>): void {
    this.host.editor.snapping = { ...this.host.editor.snapping, ...change };
    saveSnap(this.host.editor.snapping);
    this.host.snapChanged();
    this.render();
    this.host.editor.draw();
  }

  private render(): void {
    const project = this.host.project();
    const gaps = project ? gutters(project) : null;
    for (const [id, value] of [
      ["st-gutter-across", gaps?.across],
      ["st-gutter-down", gaps?.down],
    ] as const) {
      const field = $<HTMLInputElement>(id);
      field.disabled = !gaps;
      if (document.activeElement !== field) field.value = value === undefined ? "" : String(value);
    }
    const binding = $<HTMLSelectElement>("st-binding");
    binding.value = project?.binding ?? "right";
    binding.disabled = !project;
    const gap = $<HTMLInputElement>("st-page-gap");
    if (document.activeElement !== gap) gap.value = String(this.host.editor.pageGapMm);
    const snap = this.host.editor.snapping;
    for (const [key, id] of SNAP_BOXES) $<HTMLInputElement>(id).checked = snap[key] as boolean;
    const grid = $<HTMLInputElement>("st-grid-mm");
    if (document.activeElement !== grid) grid.value = String(snap.gridMm);
    grid.disabled = !snap.grid;
  }
}
