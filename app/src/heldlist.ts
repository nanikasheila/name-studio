// 保留 (the palette): panels waiting for a place, with the page each is meant
// for, and pages taken out of the name. Each is picked one or several
// (listops.ts) to put on a page, copy, move in the list, mean for the page
// worked on, or drop; a held panel is dragged onto a page to put it there.
import { $, element, plainButton } from "./dom";
import type { Selection } from "./editor";
import { heldThumbnail, pageGlyph } from "./glyph";
import { duplicateHeld, moveHeld, removeHeld, setHeldNear } from "./heldops";
import { canMove } from "./listorder";
import { ListPicker, toolRow } from "./listops";
import type { HeldPanel, HeldPages, Page, Panel, Point, Project } from "./model";
import { restoreHeldPages } from "./pageops";
import type { MenuItem } from "./popupmenu";

/** What a held panel is carried as when dragged from the 保留 list. */
export const HELD_TYPE = "application/x-name-studio-held";

/** The held panel being dragged from the 保留 list (a drag's data cannot be read until the drop). */
let heldDragged: string | null = null;
export function draggedHeld(): string | null {
  return heldDragged;
}

export interface HeldListHost {
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  selection(): Selection | null;
  focusPage(): Page | null;
  currentPages(): number[];
  openPage(number: number): void;
  status(message: string): void;
  /** Put a held panel on `page`: into `panel`, at `point`, or where it was. */
  putHeld(id: string, page: Page, point?: Point, panel?: Panel): void;
  /** Lay a held panel in the 欄外 above `page`, or (null) take it out of the 欄外. */
  layHeld(id: string, page: Page | null): void;
}

export class HeldList {
  readonly picker: ListPicker;

  constructor(private readonly host: HeldListHost) {
    const ids = () => {
      const project = this.host.project();
      return [...(project?.held ?? []).map((h) => h.id), ...(project?.heldPages ?? []).map((h) => h.id)];
    };
    const list = (kind: "panel" | "pages", picked: string[]) => {
      const project = this.host.project();
      return kind === "panel" ? (project?.held ?? []).filter((h) => picked.includes(h.id)) : (project?.heldPages ?? []).filter((h) => picked.includes(h.id));
    };
    this.picker = new ListPicker($("side-held"), {
      noun: "保留",
      ids,
      duplicate: (picked) => this.duplicate(picked),
      remove: (picked) => this.removeMany(picked),
      move: (picked, to) => this.host.edit((p) => moveHeld(p, picked, to)),
      canMove: (picked, to) => {
        const project = this.host.project();
        return canMove(project?.held ?? [], (h) => h.id, picked, to) || canMove(project?.heldPages ?? [], (h) => h.id, picked, to);
      },
      extra: (picked) => {
        const panels = list("panel", picked) as HeldPanel[];
        const pages = list("pages", picked) as HeldPages[];
        const items: MenuItem[] = [];
        const focus = this.host.focusPage();
        const project = this.host.project();
        const at = focus && project ? project.pages.findIndex((p) => p.id === focus.id) : -1;
        if (panels.length === 1) items.push(...this.panelItems(panels[0]));
        if (panels.length && focus) {
          items.push({ label: `「このあたり」を ${at + 1} ページに`, title: "置きたいページを、今のページにする", run: () => this.near(panels, focus.id) });
          items.push({ label: "「このあたり」を未定に", run: () => this.near(panels, undefined) });
        }
        if (pages.length === 1) {
          items.push({ label: "元の場所に戻す", run: () => this.putBack(pages[0], "back", "元の場所") });
          if (focus) items.push({ label: `${at + 1} ページの後ろに戻す`, run: () => this.putBack(pages[0], at + 1, `${at + 2} ページ`) });
        }
        return items;
      },
      changed: () => {
        const project = this.host.project();
        if (project) this.render(project);
      },
    });
  }

  private panelItems(h: HeldPanel): MenuItem[] {
    const project = this.host.project();
    const target = this.host.selection()?.kind === "panel" ? this.host.selection() : null;
    const aside = !!h.at && !!project?.pages.some((p) => p.id === h.near);
    return [
      { label: "このページに置く", title: "今のページの、元と同じ位置に置く", run: () => this.put(h) },
      { label: "選んだコマへ", disabled: !target, title: "選んでいるコマに中身を合わせて入れる", run: () => this.into(h) },
      { label: aside ? "欄外から下げる" : "欄外に置く", run: () => this.lay(h, aside) },
    ];
  }

  private put(h: HeldPanel): void {
    const page = this.host.focusPage();
    if (page) this.host.putHeld(h.id, page);
  }

  private into(h: HeldPanel): void {
    const project = this.host.project();
    const target = this.host.selection();
    const page = project?.pages.find((p) => p.id === target?.pageId);
    const panel = target?.kind === "panel" ? page?.panels.find((p) => p.id === target.id) : undefined;
    if (page && panel) this.host.putHeld(h.id, page, undefined, panel);
  }

  private lay(h: HeldPanel, aside: boolean): void {
    const project = this.host.project();
    const page = aside ? null : (project?.pages.find((p) => p.id === h.near) ?? this.host.focusPage());
    if (aside || page) this.host.layHeld(h.id, page);
  }

  private near(panels: HeldPanel[], pageId: string | undefined): void {
    const ids = panels.map((h) => h.id);
    let count = 0;
    this.host.edit((p) => (count = setHeldNear(p, ids, pageId)));
    if (count) this.host.status(`保留のコマ ${count} つの「このあたり」を変えました`);
  }

  private putBack(held: HeldPages, target: number | "back", what: string): void {
    const project = this.host.project();
    if (!project) return;
    let pages: Page[] = [];
    this.host.edit((p) => (pages = restoreHeldPages(p, held.id, target)));
    const first = pages[0] && this.host.project()?.pages.findIndex((p) => p.id === pages[0].id);
    if (first !== undefined && first >= 0) this.host.openPage(first + 1);
    if (pages.length) this.host.status(`保留のページ ${pages.length} 枚を${what}に戻しました（元に戻すは Ctrl+Z）`);
  }

  render(project: Project): void {
    const held = project.held ?? [];
    const shown = new Set(this.host.currentPages().map((n) => project.pages[n - 1]?.id));
    const target = this.host.selection()?.kind === "panel" ? this.host.selection() : null;
    const items = held.map((h) => {
      const near = element("select", { title: "このあたりのページに入れたい" });
      near.append(element("option", { value: "", textContent: "ページ未定" }));
      project.pages.forEach((page, index) => near.append(element("option", { value: page.id, textContent: `${index + 1} ページあたり` })));
      near.value = project.pages.some((p) => p.id === h.near) ? h.near! : "";
      near.addEventListener("change", () => this.host.edit((p) => setHeldNear(p, [h.id], near.value || undefined)));
      const words = h.lines
        .map((l) => l.text.replace(/\s+/g, ""))
        .filter(Boolean)
        .join(" / ");
      const put = plainButton("このページに置く", () => this.put(h));
      put.title = "今のページの、元と同じ位置に置く（ページへドラッグしても置けます）";
      const into = plainButton("選んだコマへ", () => this.into(h));
      into.title = "選んでいるコマに、中身（セリフ・ラフ線）を合わせて入れる";
      into.disabled = !target;
      const aside = !!h.at && project.pages.some((p) => p.id === h.near);
      const lay = plainButton(aside ? "欄外から下げる" : "欄外に置く", () => this.lay(h, aside));
      lay.title = aside ? "ページの外（欄外）から下げて、この一覧だけに置く" : "「このあたり」のページ（未定なら今のページ）の上の欄外に置いて、紙面で見えるようにする";
      const drop = plainButton("消す", () => this.removeOne(h.id));
      drop.className = "danger small";
      const item = element(
        "div",
        {
          className: `held-item${h.near && shown.has(h.near) ? " near" : ""}`,
          draggable: true,
          title: "ページへドラッグして置く。コマの上で離すと、そのコマに中身を入れる（縦横比を保つかは 設定 › 操作）。押して選ぶ（Ctrl・Shift で複数）・右クリックでメニュー",
        },
        heldThumbnail(project, h),
        element(
          "div",
          { className: "held-body" },
          element("div", { className: "held-words", textContent: words || h.panel.note || "（セリフなし）" }),
          ...(h.panel.note && words ? [element("div", { className: "held-note", textContent: h.panel.note })] : []),
          near,
          ...(aside ? [element("div", { className: "held-note", textContent: `欄外（${project.pages.findIndex((p) => p.id === h.near) + 1} ページのそば）に置いてあります` })] : []),
          element("div", { className: "held-actions" }, put, into, lay, drop),
        ),
      );
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(HELD_TYPE, h.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        heldDragged = h.id;
      });
      item.addEventListener("dragend", () => (heldDragged = null));
      return this.picker.row(item, h.id);
    });
    const picked = this.picker.targets();
    const tools = toolRow(
      [
        { id: "held-duplicate", text: "複製", title: "選んだ保留のコマを複製（Ctrl+D）", run: () => this.duplicate(picked), disabled: !held.some((h) => picked.includes(h.id)) },
        { id: "held-delete", text: "削除", title: "選んだ保留を捨てる（Delete・元に戻すで戻せます）", run: () => this.removeMany(picked), disabled: !picked.length },
      ],
      picked.length > 1 ? `${picked.length} つ選択中` : "",
    );
    const head = element("p", {
      className: "hint",
      textContent: held.length
        ? `保留のコマ ${held.length}。ページへドラッグで置く（コマの上で離すと中身をそのコマへ）。ページの外へドラッグすると欄外に置けます。`
        : "保留のコマはありません。コマを選んで「保留」を押すと、中身ごとページの上の欄外へ移ります（ここにも並びます）。置き場所が決まったら、ページへドラッグして戻します。",
    });
    $("side-held").replaceChildren(tools, head, ...items, ...this.heldPages(project));
  }

  private duplicate(picked: string[]): void {
    let made: string[] = [];
    this.host.edit((p) => (made = duplicateHeld(p, picked).map((h) => h.id)));
    if (made.length) this.picker.pick(made);
    else this.host.status("複製できるのは保留のコマです");
  }

  private removeOne(id: string): void {
    this.removeMany([id]);
  }

  private removeMany(picked: string[]): void {
    let count = 0;
    this.host.edit((p) => (count = removeHeld(p, picked)));
    this.picker.clear();
    if (count) this.host.status(`保留 ${count} つを捨てました（元に戻すは Ctrl+Z）`);
  }

  /** 保留のページ: pages taken out of the name, to put back where they were or elsewhere. */
  private heldPages(project: Project): HTMLElement[] {
    const list = project.heldPages ?? [];
    if (!list.length) return [element("p", { className: "hint", textContent: "保留のページはありません。ページ一覧で右クリック ›「保留にする」で、ページを外して取っておけます。" })];
    const rows = list.map((held) => {
      const at = held.after ? project.pages.findIndex((p) => p.id === held.after) : -1;
      const where = held.after ? (at >= 0 ? `${at + 1} ページの後ろにあった` : "元の場所はもうありません") : "先頭にあった";
      const back = plainButton("元の場所に戻す", () => this.putBack(held, "back", "元の場所"));
      back.title = where;
      const focus = this.host.focusPage();
      const here = plainButton("今のページの後ろに戻す", () => {
        const index = focus ? project.pages.findIndex((p) => p.id === focus.id) : -1;
        this.putBack(held, index + 1, `${index + 2} ページ`);
      });
      here.disabled = !focus;
      const drop = plainButton("消す", () => this.removeOne(held.id));
      drop.className = "danger small";
      drop.title = "保留のページを捨てる（元に戻すで戻せます）";
      const memo = held.pages.map((p) => p.memo.split("\n")[0]).filter(Boolean).join(" / ");
      const row = element(
        "div",
        { className: "held-item held-pages", title: `${where}。押して選ぶ（Ctrl・Shift で複数）・右クリックでメニュー` },
        element("div", { className: "held-page-glyphs" }, ...held.pages.map((p) => pageGlyph(project, p, 28))),
        element(
          "div",
          { className: "held-body" },
          element("div", { className: "held-words", textContent: `${held.pages.length} ページ・${where}` }),
          ...(memo ? [element("div", { className: "held-note", textContent: memo })] : []),
          element("div", { className: "held-actions" }, back, here, drop),
        ),
      );
      return this.picker.row(row, held.id);
    });
    return [element("h3", { className: "held-heading", textContent: `保留のページ ${list.length}` }), ...rows];
  }
}
