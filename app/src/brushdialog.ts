// The dialog that takes pens and erasers over from CLIP STUDIO PAINT: from an
// exported sub tool (.sut) or from CSP's own tool list on this computer.
import { call, type CspToolLocations } from "./backend";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DEFAULT_BRUSH_DPI,
  addBrushes,
  brushFromSubTool,
  lengthMm,
  saveToLibrary,
  type CspSubTool,
} from "./brush";
import type { Brush, Project } from "./project";

export interface BrushDialogHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** The brushes just added (to choose one for the pen). */
  imported(brushes: Brush[]): void;
}

const ERASE_LABELS = { touched: "触れた部分", intersection: "交点まで", whole: "線全体" } as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class BrushDialog {
  private tools: CspSubTool[] = [];
  private readonly selected = new Set<number>();
  private locations: CspToolLocations | null = null;
  private filter = "";

  constructor(private readonly host: BrushDialogHost) {
    $("bd-read-csp").addEventListener("click", () => void this.readCsp());
    $("bd-pick-file").addEventListener("click", () => void this.pickFile());
    $("bd-import").addEventListener("click", () => this.importSelected());
    $<HTMLInputElement>("bd-filter").addEventListener("input", (event) => {
      this.filter = (event.target as HTMLInputElement).value.trim();
      this.render();
    });
    $<HTMLInputElement>("bd-dpi").addEventListener("input", () => this.render());
  }

  async open(): Promise<void> {
    if (!this.host.project()) return;
    $<HTMLDialogElement>("brush-dialog").showModal();
    this.render();
    this.locations ??= await call("csp_tool_locations").catch(() => ({ tools: null, materials: null }));
    const button = $<HTMLButtonElement>("bd-read-csp");
    button.disabled = !this.locations.tools;
    button.title = this.locations.tools ?? "この PC では CSP のツールの保存場所が見つかりませんでした";
  }

  private async readCsp(): Promise<void> {
    if (!this.locations?.tools) return;
    await this.read(this.locations.tools, false);
  }

  private async pickFile(): Promise<void> {
    const path = await open({
      multiple: false,
      filters: [{ name: "CSP のサブツール", extensions: ["sut", "todb"] }],
    });
    if (typeof path === "string") await this.read(path, true);
  }

  private async read(path: string, selectAll: boolean): Promise<void> {
    this.message("読み込み中…");
    try {
      this.tools = await call("read_csp_sub_tools", {
        path,
        materials: this.locations?.materials ?? null,
      });
    } catch (error) {
      this.message(`読み込めませんでした: ${error}`, true);
      return;
    }
    this.selected.clear();
    if (selectAll) this.tools.forEach((_, index) => this.selected.add(index));
    const pens = this.tools.filter((tool) => tool.kind === "pen").length;
    this.message(`ペン・ブラシ ${pens} 本、消しゴム ${this.tools.length - pens} 本が見つかりました。取り込むものを選んでください。`);
    this.render();
  }

  private dpi(): number {
    const value = Number($<HTMLInputElement>("bd-dpi").value);
    return value >= 72 && value <= 2400 ? value : DEFAULT_BRUSH_DPI;
  }

  private render(): void {
    const list = $("bd-list");
    list.replaceChildren();
    const groups = new Map<string, number[]>();
    this.tools.forEach((tool, index) => {
      const group = tool.group.join(" / ") || "サブツール";
      const text = `${group} ${tool.name}`;
      if (this.filter && !text.includes(this.filter)) return;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(index);
    });
    const dpi = this.dpi();
    for (const [group, indexes] of groups) {
      const heading = document.createElement("h3");
      const all = document.createElement("button");
      all.type = "button";
      all.textContent = "すべて";
      all.addEventListener("click", () => {
        const every = indexes.every((index) => this.selected.has(index));
        for (const index of indexes) {
          if (every) this.selected.delete(index);
          else this.selected.add(index);
        }
        this.render();
      });
      heading.append(group, all);
      list.append(heading);
      for (const index of indexes) list.append(this.row(this.tools[index], index, dpi));
    }
    $<HTMLButtonElement>("bd-import").disabled = this.selected.size === 0;
    $<HTMLButtonElement>("bd-import").textContent = this.selected.size ? `${this.selected.size} 本を取り込む` : "取り込む";
  }

  private row(tool: CspSubTool, index: number, dpi: number): HTMLElement {
    const row = document.createElement("label");
    row.className = "brush-row";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = this.selected.has(index);
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(index);
      else this.selected.delete(index);
      this.render();
    });
    let picture: HTMLElement;
    if (tool.tip) {
      const image = document.createElement("img");
      image.src = `data:image/png;base64,${tool.tip.pngBase64}`;
      image.alt = "";
      // The tip is white on transparent; show it dark on the white box.
      image.style.filter = "invert(1)";
      picture = image;
    } else {
      picture = document.createElement("span");
      picture.className = "round";
    }
    const name = document.createElement("span");
    name.textContent = tool.name;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = tool.kind === "eraser" ? `消しゴム（${ERASE_LABELS[tool.vectorErase ?? "touched"]}）` : "ペン";
    const meta = document.createElement("span");
    meta.className = "meta";
    const size = lengthMm(tool.size, dpi);
    const inputs = tool.sizeDynamics;
    const changes = [
      inputs?.pressure ? "筆圧" : "",
      inputs?.tilt ? "傾き" : "",
      inputs?.velocity ? "速度" : "",
      inputs?.random ? "ランダム" : "",
      tool.stabilization ? `手ブレ補正 ${tool.stabilization}${tool.stabilizationBySpeed ? "（速度）" : ""}` : "",
      tool.postCorrection ? `後補正 ${tool.postCorrection}` : "",
    ].filter(Boolean);
    meta.textContent = [`${size >= 1 ? size.toFixed(1) : size.toFixed(2)} mm`, ...changes].join("・");
    row.append(check, picture, name, badge, meta);
    return row;
  }

  private importSelected(): void {
    if (!this.selected.size) return;
    const dpi = this.dpi();
    const brushes = [...this.selected].sort((a, b) => a - b).map((index) => brushFromSubTool(this.tools[index], dpi, ""));
    let added: Brush[] = [];
    this.host.edit((project) => {
      added = addBrushes(project, brushes);
    });
    saveToLibrary(added);
    this.host.imported(added);
    this.message(`${added.length} 本を取り込みました。ツールバーで選べます。`);
    this.selected.clear();
    this.render();
  }

  private message(text: string, error = false): void {
    const node = $("bd-message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }
}
