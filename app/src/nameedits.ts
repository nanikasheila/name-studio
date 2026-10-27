// The changes to the name that the palettes, the inspector, the story band
// and the commands ask for: each one undoable step, with a status line that
// says what it did, and the pages it touched brought into view.
import { makeAlternative, useAlternative } from "./alternatives";
import { arrangePage, arrangePanel, clearFaces, fitSpills } from "./arrange";
import { layAside, takeFromAside } from "./aside";
import { addAutoTails } from "./autotail";
import type { PageEditor, Selection } from "./editor";
import { bounds } from "./geometry";
import { holdPanel, movePanelToPage, placeHeld } from "./hold";
import { moveIntoPanel, type LayerRef } from "./layers";
import type { Alternatives, Page, Panel, Point, Project } from "./model";
import { swapPanelContents } from "./panels";
import { panelsToTidy, tidyPanels } from "./tidy";
import { insertPage, newId, pageIndex } from "./project";
import { assignPanels, sortLines } from "./readingorder";
import { removePicked } from "./removal";
import { movePagesTo } from "./reorder";
import type { RoughChange } from "./roughpanel";
import { addMarkLayer, addRoughLayer, layerOf, markLayersOf, moveRoughLayer, moveStrokesToLayer, removeRoughLayer, renameRoughLayer, roughLayersOf, setRoughLayer } from "./roughlayers";
import { markPen } from "./toolmark";

/** The rough lines in a selection. */
export function pickedStrokes(s: Selection | null): string[] {
  if (!s) return [];
  if (s.kind === "stroke") return [s.id];
  return s.kind === "group" ? (s.items ?? []).filter((item) => item.kind === "stroke").map((item) => item.id) : [];
}

/** What the changes need from the editor around them. */
export interface NameEditsHost {
  readonly editor: PageEditor;
  project(): Project | null;
  /** Run a change as one undoable step. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  renderAll(): void;
  /** The layer palette shows what changed. */
  layersChanged(): void;
}

export class NameEdits {
  constructor(private readonly host: NameEditsHost) {}

  private get editor(): PageEditor {
    return this.host.editor;
  }

  private edit(change: (project: Project) => void): void {
    this.host.edit(change);
  }

  private status(message: string): void {
    this.host.status(message);
  }

  /** A change to the ラフ線のレイヤー, as one undoable step. */
  changeRough(change: RoughChange): void {
    const project = this.host.project();
    if (!project) return;
    let message = "";
    this.edit((p) => {
      switch (change.kind) {
        case "add": {
          const layer = addRoughLayer(p, `ラフ線 ${roughLayersOf(p).length + 1}`, () => newId(p, "rough"), layerOf(p, { layer: this.editor.roughLayer }).id);
          this.editor.roughLayer = layer.id;
          message = `レイヤー「${layer.name}」を足しました。ペンはこのレイヤーに描きます（名前はダブルクリックで変えられます）`;
          break;
        }
        case "addMarks": {
          const layer = addMarkLayer(p, () => newId(p, "rough"));
          markPen.layer = layer.id;
          message = `指示のレイヤー「${layer.name}」を作りました。指示ツール（R）でこの色で描きます`;
          break;
        }
        case "showMarks":
          for (const layer of markLayersOf(p)) setRoughLayer(p, layer.id, { hidden: !change.shown });
          message = change.shown ? "指示を出しました" : "指示を隠しました（CSP へは隠したレイヤーで書き出します）";
          break;
        case "rename":
          renameRoughLayer(p, change.id, change.name);
          break;
        case "look":
          setRoughLayer(p, change.id, change.change);
          break;
        case "move":
          moveRoughLayer(p, change.id, change.step);
          break;
        case "remove": {
          const { name, marks } = layerOf(p, { layer: change.id });
          const count = removeRoughLayer(p, change.id, change.mergeDown);
          message = change.mergeDown ? `「${name}」を下のレイヤーと結合しました（${count} 本）` : `レイヤー「${name}」を消しました（${marks ? "指示" : "ラフ線"} ${count} 本、Ctrl+Z で戻せます）`;
          break;
        }
        case "takeSelected": {
          const pageId = this.editor.selection?.pageId;
          const page = p.pages.find((one) => one.id === pageId);
          const count = page ? moveStrokesToLayer(p, page, pickedStrokes(this.editor.selection), change.id) : 0;
          message = `ラフ線 ${count} 本をレイヤー「${layerOf(p, { layer: change.id }).name}」へ移しました`;
          break;
        }
      }
    });
    // Lines that went hidden or locked cannot stay picked.
    const picked = pickedStrokes(this.editor.selection);
    if (picked.length && this.editor.selection) {
      const page = project.pages.find((one) => one.id === this.editor.selection?.pageId);
      const stuck = page?.strokes.some((stroke) => picked.includes(stroke.id) && (layerOf(project, stroke).hidden || layerOf(project, stroke).locked));
      if (stuck) this.editor.select(null);
    }
    if (message) this.status(message);
    this.editor.draw();
    this.host.layersChanged();
  }

  /** レイヤー: a panel dropped on another swaps their contents; anything else moves into the panel. */
  dropLayer(ref: LayerRef, to: { pageId: string; panelId: string }): void {
    const project = this.host.project();
    const from = project?.pages.find((p) => p.id === ref.pageId);
    const page = project?.pages.find((p) => p.id === to.pageId);
    const panel = page?.panels.find((p) => p.id === to.panelId);
    if (!project || !from || !page || !panel) return;
    if (ref.kind === "panel") {
      const source = from.panels.find((p) => p.id === ref.id);
      if (!source || source === panel) return;
      this.edit((project) => swapPanelContents(from, source, page, panel, project.binding));
      this.status(`コマ ${source.order} とコマ ${panel.order} の中身を入れ替えました`);
      return;
    }
    let moved = false;
    this.edit(() => {
      moved = moveIntoPanel(from, ref, page, panel);
      for (const p of new Set([from, page])) {
        assignPanels(p);
        sortLines(p, this.host.project()?.binding);
      }
    });
    if (moved) this.status(`コマ ${panel.order} へ移しました（元に戻すは Ctrl+Z）`);
  }

  /** Move pages by dragging and keep the same pages in view. */
  movePages(first: number, last: number, target: number): void {
    const project = this.host.project();
    if (!project) return;
    const shown = this.editor.currentPages().map((number) => project.pages[number - 1]?.id);
    let moved = false;
    this.edit((p) => (moved = movePagesTo(p, first, last, target)));
    if (!moved) return;
    const index = project.pages.findIndex((page) => page.id === shown[0]);
    if (index >= 0) this.editor.showPage(index + 1);
    const count = last - first + 1;
    this.status(`${count === 1 ? `${first + 1} ページ` : `${first + 1}–${last + 1} ページ`}を動かしました（元に戻すは Ctrl+Z）`);
    this.host.renderAll();
  }

  /** A blank page after `page`, shown. */
  addPageAfter(page: Page): void {
    let at = -1;
    this.edit((p) => {
      at = p.pages.findIndex((other) => other.id === page.id) + 1;
      if (at > 0) insertPage(p, at);
    });
    if (at > 0) {
      this.editor.showPage(at + 1);
      this.host.renderAll();
      this.status(`${at + 1} ページを足しました（元に戻すは Ctrl+Z）`);
    }
  }

  /** Put a held panel on `page`: into `panel`, at `point`, or where it was. */
  putHeld(id: string, page: Page, point?: Point, panel?: Panel): void {
    const held = this.host.project()?.held?.find((h) => h.id === id);
    if (!held) return;
    let placed: Panel | null = null;
    this.edit((p) => {
      const at = p.pages.find((x) => x.id === page.id);
      const into = panel && at?.panels.find((x) => x.id === panel.id);
      if (at) placed = placeHeld(p, at, held, point, into);
    });
    if (!placed) return;
    const index = this.host.project()!.pages.findIndex((x) => x.id === page.id);
    this.editor.showPage(index + 1);
    this.editor.select({ kind: "panel", pageId: page.id, id: (placed as Panel).id });
    this.status(
      panel
        ? `保留のコマの中身を ${index + 1} ページのコマ ${(placed as Panel).order} に入れました`
        : `保留のコマを ${index + 1} ページに置きました（コマ ${(placed as Panel).order}）`,
    );
    this.host.renderAll();
  }

  /** Take the selected panel off its page into 保留, laid in the 欄外 above the page. */
  holdSelected(page: Page, panel: Panel): void {
    const index = this.host.project()!.pages.indexOf(page);
    this.edit((p) => {
      const at = p.pages.find((x) => x.id === page.id);
      const target = at?.panels.find((x) => x.id === panel.id);
      if (at && target) layAside(p, holdPanel(p, at, target), at);
    });
    this.editor.select(null);
    this.status(`${index + 1} ページのコマ ${panel.order} を中身ごと保留にして、ページの上の欄外に置きました（ページへドラッグで戻せます。一覧は「保留」）`);
    this.host.renderAll();
  }

  /** The selected panel into 保留 (the command); false when no panel is selected. */
  holdSelection(): boolean {
    const selection = this.editor.selection;
    const page = selection && this.host.project()?.pages.find((p) => p.id === selection.pageId);
    const panel = selection?.kind === "panel" ? page?.panels.find((p) => p.id === selection.id) : undefined;
    if (page && panel) this.holdSelected(page, panel);
    return !!panel;
  }

  /**
   * 整える (清書) on the page worked on: the panels selected there, else its
   * 仮のコマ, else all its panels; false when there is nothing to tidy.
   */
  tidyPanels(): boolean {
    const project = this.host.project();
    const selection = this.editor.selection;
    const page = (selection && project?.pages.find((p) => p.id === selection.pageId)) || this.editor.focusPage();
    if (!project || !page) return false;
    const chosen =
      selection?.pageId !== page.id ? [] : selection.kind === "panel" ? [selection.id] : selection.kind === "group" ? (selection.items ?? []).filter((item) => item.kind === "panel").map((item) => item.id) : [];
    const targets = panelsToTidy(page, chosen);
    if (!targets.length) {
      this.status("整えるコマがありません");
      return false;
    }
    const drafts = targets.filter((panel) => panel.draft).length;
    let result = { tidied: 0, kept: 0 };
    this.edit((p) => {
      const at = p.pages.find((x) => x.id === page.id);
      if (at) result = tidyPanels(p, at, targets.map((panel) => panel.id));
    });
    const index = project.pages.indexOf(page) + 1;
    const what = drafts === targets.length ? "仮のコマ" : "コマ";
    this.status(
      result.kept
        ? `${index} ページの${what} ${result.tidied} 個を整えました（${result.kept} 個は形が読み取れず、そのまま）`
        : `${index} ページの${what} ${result.tidied} 個を整えました（線をそろえ、コマ間を設定の幅に。元に戻すは Ctrl+Z）`,
    );
    this.host.renderAll();
    return true;
  }

  /** Lay a held panel in the 欄外 of `page`: with its middle at `point` (mm on the page, off it), else above the page. */
  layHeld(id: string, page: Page, point?: Point): void {
    this.edit((p) => {
      const held = p.held?.find((h) => h.id === id);
      const at = p.pages.find((x) => x.id === page.id);
      if (!held || !at) return;
      if (!point) {
        layAside(p, held, at);
        return;
      }
      const [x0, y0, x1, y1] = bounds(held.panel.shape);
      held.near = at.id;
      held.at = [point[0] - (x1 - x0) / 2, point[1] - (y1 - y0) / 2];
    });
    const index = this.host.project()!.pages.findIndex((x) => x.id === page.id);
    if (!point) this.editor.showPage(index + 1);
    this.status(`保留のコマを ${index + 1} ページの欄外に置きました（ページへドラッグで置けます）`);
    this.host.renderAll();
  }

  /** Take a held panel out of the 欄外 (it stays in the 保留 list). */
  unlayHeld(id: string): void {
    this.edit((p) => {
      const held = p.held?.find((h) => h.id === id);
      if (held) takeFromAside(held);
    });
    this.status("保留のコマを欄外から下げました（保留の一覧に残っています）");
    this.host.renderAll();
  }

  /** Move the selected panel with what is in it to another page. */
  moveSelectedTo(page: Page, panel: Panel, to: Page): void {
    let moved: Panel | null = null;
    this.edit((p) => {
      const from = p.pages.find((x) => x.id === page.id);
      const target = from?.panels.find((x) => x.id === panel.id);
      const dest = p.pages.find((x) => x.id === to.id);
      if (from && target && dest) moved = movePanelToPage(p, from, target, dest);
    });
    if (!moved) return;
    const index = this.host.project()!.pages.findIndex((x) => x.id === to.id);
    this.editor.showPage(index + 1);
    this.editor.select({ kind: "panel", pageId: to.id, id: (moved as Panel).id });
    this.status(`コマを中身ごと ${index + 1} ページへ移しました（コマ ${(moved as Panel).order}）。重なったら動かすか、コマ割りで整えてください`);
    this.host.renderAll();
  }

  /** しっぽを付ける: on one page, or on every page. Returns how many were added. */
  addTails(pageId?: string): number {
    let added = 0;
    this.edit((p) => {
      for (const page of p.pages) if (!pageId || page.id === pageId) added += addAutoTails(page, p.binding);
    });
    this.status(added ? `しっぽ ${added} 本を話者（コマのラフ）へ向けて付けました。丸い先をドラッグで直せます（元に戻すは Ctrl+Z）` : "しっぽのないセリフはありません");
    return added;
  }

  /** セリフの並べ直し: a panel's dialogue, or every panel's on the page. */
  arrange(pageId: string, panelId?: string): void {
    let moved = 0;
    this.edit((p) => {
      const page = p.pages.find((x) => x.id === pageId);
      const panel = page?.panels.find((x) => x.id === panelId);
      if (!page) return;
      moved = panel ? arrangePanel(p, page, panel) : arrangePage(p, page);
    });
    this.status(moved ? `セリフ ${moved} 個を読む順に並べ直しました（元に戻すは Ctrl+Z）` : "並べ直すセリフがありません（コマの中のセリフだけを並べます）");
  }

  /** はみ出したセリフ: the panels with dialogue spilling out laid out again. */
  fitSpills(): number {
    let redone = 0;
    this.edit((p) => (redone = fitSpills(p)));
    this.status(redone ? `はみ出したセリフのあるコマ ${redone} 個を並べ直しました（元に戻すは Ctrl+Z）` : "はみ出したセリフはありません");
    return redone;
  }

  /** Dialogue over a face moved off it. */
  clearFaces(): number {
    let moved = 0;
    this.edit((p) => (moved = clearFaces(p)));
    this.status(moved ? `顔にかかっていたセリフ ${moved} 個をずらしました（元に戻すは Ctrl+Z）` : "顔にかかるセリフはありません");
    return moved;
  }

  /** 別案: copy pages `first`..`last` as a new option and edit it. */
  makeOption(first: number, last: number): void {
    let set: Alternatives | null = null;
    this.edit((p) => (set = makeAlternative(p, first, last)));
    if (!set) {
      this.status("一部のページがほかの別案に入っているため、この範囲の別案は作れません");
      return;
    }
    const made = set as Alternatives;
    this.showSet(made);
    const name = made.options.find((option) => option.id === made.active)?.name;
    this.status(`別案「${name}」を作りました。元の案と比べるには「比べる…」`);
  }

  useOption(set: Alternatives, optionId: string): void {
    this.edit((p) => useAlternative(p, set.id, optionId));
    this.showSet(set);
    this.status(`「${set.options.find((option) => option.id === optionId)?.name}」にしました（元に戻すは Ctrl+Z）`);
  }

  /** Show the first page of a set's option in use. */
  showSet(set: Alternatives): void {
    const project = this.host.project();
    if (!project) return;
    const index = pageIndex(project, set.pageIds[0]);
    if (index < 0) return;
    this.editor.selection = null;
    this.editor.showPage(index + 1);
    this.host.renderAll();
  }

  /** Take one しっぽ off a line; the line stays selected. */
  removeTail(pageId: string, lineId: string, index: number): void {
    let removed = false;
    this.edit((project) => {
      const line = project.pages.find((p) => p.id === pageId)?.lines.find((l) => l.id === lineId);
      if (!line?.tails?.[index]) return;
      line.tails = line.tails.filter((_, i) => i !== index);
      if (!line.tails.length) delete line.tails;
      removed = true;
    });
    if (!removed) return;
    this.editor.select({ kind: "line", pageId, id: lineId });
    this.status(`${index + 1} 本目のしっぽを消しました（元に戻すは Ctrl+Z）`);
  }

  /** What is selected on the page goes (a chosen しっぽ alone, when one is). */
  deleteSelection(): void {
    const s = this.editor.selection;
    if (!s) return;
    if (s.kind === "line" && s.tail !== undefined) {
      const line = this.host
        .project()
        ?.pages.find((p) => p.id === s.pageId)
        ?.lines.find((l) => l.id === s.id);
      if (line?.tails?.[s.tail]) {
        this.removeTail(s.pageId, line.id, s.tail);
        return;
      }
    }
    this.edit((project) => removePicked(project, s));
    this.editor.select(null);
  }
}
