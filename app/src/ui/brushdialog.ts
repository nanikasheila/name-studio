// The dialog that takes pens and erasers over from CLIP STUDIO PAINT: CSP's
// own tool list on this computer, read as soon as it opens and shown as CSP's
// サブツール palette has it (ツール › グループ › サブツール), each with how
// it stands with what was taken (取り込み済み, CSP で変わった…); or an
// exported sub tool (.sut). What is taken from CSP's list stays linked to it
// and follows changes made there (csptools.ts); a group can be followed (追う)
// to take in what is added to it.
import { call } from "../platform/backend";
import { open } from "../platform/dialogs";
import { DEFAULT_BRUSH_DPI, addBrushes, brushFromSubTool, lengthMm, type CspSubTool } from "../domain/brush";
import { STATE_LABELS, brushFor, groupKey, stateOf, takeTools, type ToolState } from "../domain/csplink";
import { cspFollowed, saveToLibrary, setCspFollowed } from "../platform/prefs";
import type { Brush, Project } from "../model/model";
import { $, element } from "../platform/dom";
import { failureText } from "../platform/errortext";
import type { CspTools } from "./csptools";

export interface BrushDialogHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** The brushes just added (to choose one for the pen). */
  imported(brushes: Brush[]): void;
  readonly csp: CspTools;
}

const ERASE_LABELS = { touched: "触れた部分", intersection: "交点まで", whole: "線全体" } as const;

/** States that the quick choice 「変わったもの」 picks. */
const CHANGED: ReadonlySet<ToolState> = new Set(["changed", "both", "differs"]);

export class BrushDialog {
  private tools: CspSubTool[] = [];
  /** The tools are CSP's own list (taken ones stay linked to it), not a file. */
  private fromCsp = false;
  private readonly selected = new Set<number>();
  private filter = "";

  constructor(private readonly host: BrushDialogHost) {
    $("bd-read-csp").addEventListener("click", () => void this.readCsp(true));
    $("bd-pick-file").addEventListener("click", () => void this.pickFile());
    $("bd-import").addEventListener("click", () => this.importSelected());
    $("bd-pick-new").addEventListener("click", () => this.pickWhere((state) => state === "new"));
    $("bd-pick-changed").addEventListener("click", () => this.pickWhere((state) => CHANGED.has(state)));
    $("bd-pick-none").addEventListener("click", () => this.pickWhere(() => false));
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
    const locations = await this.host.csp.locations();
    const button = $<HTMLButtonElement>("bd-read-csp");
    button.disabled = !locations.tools;
    button.title = locations.tools ?? "この PC では CSP のツールの保存場所が見つかりませんでした";
    if (locations.tools && !(this.tools.length && !this.fromCsp)) await this.readCsp(false);
    else if (!locations.tools && !this.tools.length)
      this.message("この PC では CSP のツールの一覧が見つかりませんでした。CSP で書き出したサブツール（.sut）を選んでください。");
  }

  /** CSP's own list: read again only when CSP wrote it since (or `force`). */
  private async readCsp(force: boolean): Promise<void> {
    this.message("CSP のサブツールを読み込み中…");
    let tools: CspSubTool[] | null;
    try {
      tools = await this.host.csp.current(force);
    } catch (error) {
      this.message(failureText("読み込めませんでした", error), true);
      return;
    }
    if (!tools) return;
    const kept = this.fromCsp ? this.selectedUuids() : new Set<string>();
    this.tools = tools;
    this.fromCsp = true;
    this.selected.clear();
    this.tools.forEach((tool, index) => kept.has(tool.uuid) && this.selected.add(index));
    this.said();
    this.render();
  }

  private selectedUuids(): Set<string> {
    return new Set([...this.selected].map((index) => this.tools[index]?.uuid).filter((uuid): uuid is string => !!uuid));
  }

  private async pickFile(): Promise<void> {
    const path = await open({
      multiple: false,
      filters: [{ name: "CSP のサブツール", extensions: ["sut", "todb"] }],
    });
    if (typeof path !== "string") return;
    this.message("読み込み中…");
    try {
      this.tools = await call("read_csp_sub_tools", { path, materials: (await this.host.csp.locations()).materials });
    } catch (error) {
      this.message(failureText("読み込めませんでした", error), true);
      return;
    }
    this.fromCsp = false;
    this.selected.clear();
    this.tools.forEach((_, index) => this.selected.add(index));
    this.said();
    this.render();
  }

  private said(): void {
    const pens = this.tools.filter((tool) => tool.kind === "pen").length;
    const from = this.fromCsp ? "CSP のサブツールのうち" : "ファイルに";
    const changed = this.fromCsp ? this.tools.filter((tool) => CHANGED.has(this.state(tool))).length : 0;
    this.message(
      `${from}ペン・ブラシ ${pens} 本、消しゴム ${this.tools.length - pens} 本が見つかりました${changed ? `（取り込んだあと CSP で変わったもの ${changed} 本）` : ""}。取り込むものを選んでください。`,
    );
  }

  private state(tool: CspSubTool): ToolState {
    const project = this.host.project();
    return project ? stateOf(tool, brushFor(project.brushes, tool)) : "new";
  }

  private dpi(): number {
    const value = Number($<HTMLInputElement>("bd-dpi").value);
    return value >= 72 && value <= 2400 ? value : DEFAULT_BRUSH_DPI;
  }

  private pickWhere(test: (state: ToolState) => boolean): void {
    this.selected.clear();
    this.tools.forEach((tool, index) => {
      if (this.shown(tool) && test(this.state(tool))) this.selected.add(index);
    });
    this.render();
  }

  private shown(tool: CspSubTool): boolean {
    return !this.filter || `${groupKey(tool)} ${tool.name}`.includes(this.filter);
  }

  /** A button that turns all of `indexes` on, or off when they all are. */
  private allButton(indexes: readonly number[], label: string): HTMLButtonElement {
    const all = element("button", { type: "button", textContent: "すべて", title: `${label}をまとめて選ぶ・外す` });
    all.addEventListener("click", () => {
      const every = indexes.every((index) => this.selected.has(index));
      for (const index of indexes) {
        if (every) this.selected.delete(index);
        else this.selected.add(index);
      }
      this.render();
    });
    return all;
  }

  private render(): void {
    const list = $("bd-list");
    const scroll = list.scrollTop;
    list.replaceChildren();
    // CSP's palette: tools (ペン, 鉛筆, 筆…), their groups, the sub tools, in CSP's order.
    const tools = new Map<string, Map<string, number[]>>();
    this.tools.forEach((tool, index) => {
      if (!this.shown(tool)) return;
      const top = tool.group[0] ?? "サブツール";
      const group = groupKey(tool);
      if (!tools.has(top)) tools.set(top, new Map());
      const groups = tools.get(top)!;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(index);
    });
    const dpi = this.dpi();
    const followed = cspFollowed();
    for (const [top, groups] of tools) {
      const every = [...groups.values()].flat();
      const section = element("section", { className: "bd-tool" });
      const title = element("h3", {}, element("span", { textContent: top }), element("small", { textContent: `${every.length} 本` }));
      if (groups.size > 1) title.append(this.allButton(every, `「${top}」の全部`));
      section.append(title);
      for (const [group, indexes] of groups) {
        const heading = element("h4", {}, element("span", { textContent: group.split(" / ").slice(1).join(" / ") || top }));
        heading.append(this.allButton(indexes, `「${group}」`));
        if (this.fromCsp) heading.append(this.followBox(group, followed.has(group)));
        section.append(heading);
        for (const index of indexes) section.append(this.row(this.tools[index], index, dpi));
      }
      list.append(section);
    }
    list.scrollTop = scroll;
    for (const id of ["bd-pick-new", "bd-pick-changed", "bd-pick-none"]) $<HTMLButtonElement>(id).disabled = !this.tools.length;
    $("bd-picks").hidden = !this.fromCsp;
    $<HTMLButtonElement>("bd-import").disabled = this.selected.size === 0;
    $<HTMLButtonElement>("bd-import").textContent = this.selected.size ? `${this.selected.size} 本を取り込む` : "取り込む";
  }

  /** 追う: what is in the group now and what is added to it in CSP is taken in. */
  private followBox(group: string, on: boolean): HTMLElement {
    const box = element("input", { type: "checkbox", checked: on });
    box.addEventListener("change", () => {
      const groups = cspFollowed();
      if (box.checked) groups.add(group);
      else groups.delete(group);
      setCspFollowed(groups);
      if (box.checked) {
        const fresh = this.tools.filter((tool) => groupKey(tool) === group && this.state(tool) === "new");
        const taken = fresh.length ? this.take(fresh) : [];
        this.message(
          `「${group}」を追います: ${taken.length ? `まだだった ${taken.length} 本を取り込みました。` : ""}CSP でこのグループに足したペン・消しゴムも取り込みます。`,
        );
      } else {
        this.message(`「${group}」を追うのをやめました（取り込んだものはそのまま、CSP での変更には合わせます）。`);
      }
      this.render();
    });
    return element("label", { className: "bd-follow", title: "CSP でこのグループに足したペン・消しゴムも、自動で取り込む" }, box, "追う");
  }

  private row(tool: CspSubTool, index: number, dpi: number): HTMLElement {
    const row = element("label", { className: "brush-row" });
    const check = element("input", { type: "checkbox", checked: this.selected.has(index) });
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(index);
      else this.selected.delete(index);
      this.render();
    });
    let picture: HTMLElement;
    if (tool.tip) {
      // The tip is white on transparent; show it dark on the white box.
      picture = element("img", { src: `data:image/png;base64,${tool.tip.pngBase64}`, alt: "" });
      picture.style.filter = "invert(1)";
    } else {
      picture = element("span", { className: "round" });
    }
    const name = element("span", { textContent: tool.name });
    const badge = element("span", {
      className: "badge",
      textContent: tool.kind === "eraser" ? `消しゴム（${ERASE_LABELS[tool.vectorErase ?? "touched"]}）` : "ペン",
    });
    const state = this.state(tool);
    const mark = element("span", { className: `bd-state ${state}`, textContent: STATE_LABELS[state] });
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
    const meta = element("span", {
      className: "meta",
      textContent: [`${size >= 1 ? size.toFixed(1) : size.toFixed(2)} mm`, ...changes].join("・"),
    });
    row.append(check, picture, name, mark, badge, meta);
    return row;
  }

  /** Take these into the name (linked to CSP's list when they are from it), as one undoable step. */
  private take(tools: readonly CspSubTool[]): Brush[] {
    const dpi = this.dpi();
    this.host.csp.dpi = dpi;
    let added: Brush[] = [];
    this.host.edit((project) => {
      added = this.fromCsp
        ? takeTools(project, tools, dpi)
        : addBrushes(
            project,
            tools.map((tool) => brushFromSubTool(tool, dpi, "")),
          );
    });
    if (!added.length) return added;
    saveToLibrary(added);
    this.host.imported(added);
    return added;
  }

  private importSelected(): void {
    if (!this.selected.size) return;
    const added = this.take([...this.selected].sort((a, b) => a - b).map((index) => this.tools[index]));
    this.message(
      `${added.length} 本を取り込みました。サブツールの欄で選べます。${this.fromCsp ? "CSP で設定を変えると、こちらも合わせます（設定 › ペン・キー）。" : ""}`,
    );
    this.selected.clear();
    this.render();
  }

  private message(text: string, error = false): void {
    const node = $("bd-message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }
}
