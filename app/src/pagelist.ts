// ページ管理: the page list (ページ palette). Each page with its memo, amount
// of text and part of the story; pages picked one, several (Ctrl / Shift +
// click) or by the arrows; inserted, duplicated, deleted, held (保留), copied
// and moved by its buttons, its right-click menu or keys. The changes
// themselves are in pageops.ts.
import { ask } from "@tauri-apps/plugin-dialog";
import { alternativesOf } from "./alternatives";
import { sceneOf } from "./cast";
import { textAmount } from "./dialogue";
import { $, element } from "./dom";
import { pageGlyph } from "./glyph";
import { keyLabel } from "./helptopics";
import { heldNear } from "./hold";
import { setSpreadPage, spreadPair } from "./koma";
import type { Page, Project } from "./model";
import {
  cannotRemove,
  clipPages,
  deletePages,
  duplicatePages,
  holdPages,
  insertBlankPages,
  type PageClip,
  pastePages,
  runsOf,
  trailingEmptyIds,
  withPartners,
} from "./pageops";
import { dragSort } from "./dragsort";
import { closeMenu, type MenuItem, openMenu, SEPARATOR } from "./popupmenu";
import { insertPage, pageIndex, pageIsEmpty } from "./project";
import { pageBlock } from "./reorder";
import { pageParts } from "./shapes";

export interface PageListHost {
  /** The open name. */
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  /** Page numbers (from 1) on screen now. */
  currentPages(): number[];
  /** The page the person is working on. */
  focusPage(): Page | null;
  /** Show page `number` with nothing selected. */
  openPage(number: number): void;
  movePages(first: number, last: number, target: number): void;
  makeOption(first: number, last: number): void;
  status(message: string): void;
  /** Whether the first page stands alone (見開き pair the pages after it). */
  firstAlone(): boolean;
  /** A command's keys as set. */
  keysOf(command: string): string[];
}

/** Pages copied in the list (kept while the app runs, so they can be pasted into another name). */
let copied: PageClip | null = null;

/** "3 ページ", "3–4 ページ", "3 ページほか 2 ページ". */
function pagesLabel(indexes: readonly number[]): string {
  const runs = runsOf(indexes);
  if (!runs.length) return "";
  const [first, last] = runs[0];
  const head = first === last ? `${first + 1} ページ` : `${first + 1}–${last + 1} ページ`;
  const rest = indexes.length - (last - first + 1);
  return rest > 0 ? `${head}ほか ${rest} ページ` : head;
}

export class PageList {
  /** Pages picked in the list (ids); used while the page worked on stays the one they were picked with. */
  private picked = new Set<string>();
  /** The page worked on when they were picked. */
  private pickedFor: string | null = null;
  /** Where Shift + click or Shift + arrow extends from. */
  private anchor: string | null = null;
  /** How many pages the button at the bottom adds. */
  private addCount = 1;

  constructor(private readonly host: PageListHost) {
    const list = $("side-pages");
    list.tabIndex = 0;
    list.addEventListener("keydown", (event) => {
      if (event.target !== list && (event.target as HTMLElement).closest("input, textarea, select, button")) return;
      if (this.handleKey(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    list.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest("input, textarea")) return;
      event.preventDefault();
      // On no page: the menu for the end of the name.
      if (!(event.target as HTMLElement).closest(".page-item")) this.openMenuAt(null, event.clientX, event.clientY);
    });
    // Pressing elsewhere (the canvas keeps the focus where it was) ends the list's keys: Delete there is the canvas's.
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (document.activeElement === list && !list.contains(event.target as Node)) list.blur();
      },
      true,
    );
  }

  /** The pages the list's commands act on, in page order: the picked ones, else the page worked on. */
  targets(project: Project | null = this.host.project()): number[] {
    if (!project) return [];
    const focus = this.host.focusPage();
    if (this.picked.size && focus && focus.id === this.pickedFor) {
      const indexes = [...this.picked].map((id) => pageIndex(project, id)).filter((i) => i >= 0);
      if (indexes.length) return indexes.sort((a, b) => a - b);
    }
    const at = focus ? pageIndex(project, focus.id) : -1;
    return at >= 0 ? [at] : [];
  }

  private pick(ids: Iterable<string>, show?: string): void {
    this.picked = new Set(ids);
    const project = this.host.project();
    if (show && project) {
      const at = pageIndex(project, show);
      // Showing it re-draws the list, with the pages picked for it.
      this.pickedFor = show;
      if (at >= 0) this.host.openPage(at + 1);
    } else this.pickedFor = this.host.focusPage()?.id ?? null;
  }

  /** The list, drawn again from the project. */
  render(project: Project): void {
    const title = element("input", { type: "text", value: project.title, placeholder: "作品名" });
    title.addEventListener("change", () => this.host.edit((p) => (p.title = title.value.trim())));
    const story = element("input", { type: "number", min: "0", value: project.storyIndex === undefined ? "" : String(project.storyIndex), placeholder: "話数" });
    story.addEventListener("change", () =>
      this.host.edit((p) => {
        const value = parseInt(story.value, 10);
        if (Number.isInteger(value) && value >= 0) p.storyIndex = value;
        else delete p.storyIndex;
      }),
    );
    const work = element("div", { className: "cast-item work" }, title, story);
    const current = new Set(this.host.currentPages());
    const targets = new Set(this.targets(project));
    const many = targets.size > 1;
    const parts = pageParts(project);
    const items = project.pages.map((page, index) => {
      const scene = sceneOf(project, page.id);
      const sceneLabel = scene && scene.firstPage === page.id ? element("span", { className: "scene", textContent: scene.title }) : "";
      const part = parts[index];
      const held = heldNear(project, index, index).length;
      // The part of the story on the picture; the help bar tells what the list does (helptopics.ts side-pages).
      const glyph = pageGlyph(project, page);
      if (part) glyph.append(Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "title"), { textContent: part.name }));
      const item = element(
        "div",
        {
          className: `page-item${current.has(index + 1) ? " current" : ""}${many && targets.has(index) ? " picked" : ""}${part ? " tinted" : ""}`,
        },
        glyph,
        element("span", { className: "number", textContent: String(index + 1) }),
        element("span", { className: "memo" }, sceneLabel, page.memo.split("\n")[0] || ""),
        ...this.optionTag(project, page),
        element(
          "span",
          {
            className: "count",
            title: `コマ ${page.panels.length}・字 ${textAmount(page)}${page.stickies?.length ? `・付箋 ${page.stickies.length}` : ""}（コマの濃さはセリフの量）`,
          },
          `${textAmount(page)}字`,
          ...(page.stickies?.length ? [element("span", { className: "sticky-count", textContent: String(page.stickies.length) })] : []),
          ...(held ? [element("span", { className: "held-count", title: "このあたりに入れたい保留のコマ", textContent: `保${held}` })] : []),
        ),
      );
      item.dataset.page = page.id;
      if (part) item.style.setProperty("--part", part.color);
      item.addEventListener("click", (event) => this.clicked(project, index, event));
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Right click on a page not picked: that page alone.
        if (!targets.has(index)) this.pick([page.id], page.id);
        this.openMenuAt(index, event.clientX, event.clientY);
      });
      return item;
    });
    // Drag a page (a 見開き moves as a pair; picked pages in a row move together) to put it elsewhere.
    dragSort(items, {
      axis: "y",
      block: (index) => this.dragBlock(project, index),
      drop: (first, last, target) => this.host.movePages(first, last, target),
    });
    const tools = element("div", { className: "page-tools" }, ...this.toolButtons(project));
    const count = element("input", { type: "number", id: "add-page-count", min: "1", max: "100", value: String(this.addCount), title: "足すページ数" });
    count.addEventListener("change", () => (this.addCount = Math.max(1, Math.min(100, Math.round(Number(count.value)) || 1))));
    const add = element("button", { id: "add-pages", textContent: "ページを最後に足す" });
    add.addEventListener("click", () => {
      const n = Math.max(1, Math.min(100, Math.round(Number(count.value)) || 1));
      this.host.edit((p) => {
        for (let i = 0; i < n; i++) insertPage(p, p.pages.length);
      });
    });
    $("side-pages").replaceChildren(work, tools, ...items, element("div", { className: "side-actions add-pages" }, count, add));
  }

  /** The 別案 in use on a page, for the page list. */
  private optionTag(project: Project, page: Page): HTMLElement[] {
    const set = alternativesOf(project, page.id);
    const option = set?.options.find((o) => o.id === set.active);
    return option ? [element("span", { className: "option-tag", textContent: option.name, title: `別案 ${set!.options.length} つのうち使用中の案` })] : [];
  }

  /** How a command's keys read, with the list's own key when it has none. */
  private keys(command: string, fallback: string): string {
    return this.host.keysOf(command).map(keyLabel).join(" / ") || fallback;
  }

  /** The pages a drag from page `index` moves: the picked run it is in, else it with its 見開き partner. */
  private dragBlock(project: Project, index: number): [number, number] {
    const targets = this.targets(project);
    if (targets.length > 1 && targets.includes(index)) {
      const runs = runsOf(withPartners(project, targets));
      if (runs.length === 1) return runs[0];
    }
    return pageBlock(project, index);
  }

  private clicked(project: Project, index: number, event: MouseEvent): void {
    const page = project.pages[index];
    const focus = this.host.focusPage();
    if (event.ctrlKey || event.metaKey) {
      // Add or take out one page; the page worked on stays.
      const picked = new Set(this.targets(project).map((i) => project.pages[i].id));
      if (picked.has(page.id) && picked.size > 1) picked.delete(page.id);
      else picked.add(page.id);
      this.anchor = page.id;
      this.picked = picked;
      this.pickedFor = focus?.id ?? null;
      this.render(project);
      return;
    }
    if (event.shiftKey) {
      const from = this.anchor ? pageIndex(project, this.anchor) : focus ? pageIndex(project, focus.id) : index;
      const [a, b] = [Math.min(from < 0 ? index : from, index), Math.max(from < 0 ? index : from, index)];
      this.picked = new Set(project.pages.slice(a, b + 1).map((p) => p.id));
      this.pickedFor = focus?.id ?? null;
      this.render(project);
      return;
    }
    this.anchor = page.id;
    this.picked = new Set();
    this.host.openPage(index + 1);
  }

  /** The buttons over the list: they act on the picked pages (or the page worked on). */
  private toolButtons(project: Project): HTMLElement[] {
    const targets = this.targets(project);
    const label = pagesLabel(targets);
    const button = (id: string, text: string, title: string, run: () => void, disabled = false) => {
      const b = element("button", { id, type: "button", className: "small", textContent: text, title, disabled });
      b.addEventListener("click", run);
      return b;
    };
    const removable = !cannotRemove(project, targets.map((i) => project.pages[i].id));
    const key = (command: string, fallback: string) => this.keys(command, fallback);
    return [
      button("page-insert-before", "＋前", `${label}の前に白紙のページを入れる（Shift+Insert）`, () => this.insert(false)),
      button("page-insert-after", "＋後", `${label}の後ろに白紙のページを入れる（${key("page.add", "Insert")}）`, () => this.insert(true)),
      button("page-duplicate", "複製", `${label}を複製して後ろに入れる（${key("page.duplicate", "Ctrl+D")}）`, () => this.duplicate()),
      button("page-hold", "保留", `${label}をネームから外して「保留」の欄に取っておく（戻せます）`, () => this.hold(), !removable),
      button("page-delete", "削除", `${label}を消す（${key("page.delete", "Delete")}・元に戻すで戻せます）`, () => void this.remove(), !removable),
      element("span", {
        className: "page-tools-note",
        textContent: `${project.pages.length} ページ${project.plan?.targetPages ? `（目標 ${project.plan.targetPages}）` : ""}${targets.length > 1 ? `・${targets.length} ページ選択中` : ""}`,
      }),
    ];
  }

  /** The page menu from elsewhere (the story band): for page `index`, with the picked pages when it is one of them. */
  menuFor(index: number, x: number, y: number): void {
    const project = this.host.project();
    const page = project?.pages[index];
    if (!project || !page) return;
    if (!this.targets(project).includes(index)) this.pick([page.id], page.id);
    this.openMenuAt(index, x, y);
  }

  /** The menu for pages (`index` the page pressed; null: on no page). */
  openMenuAt(index: number | null, x: number, y: number): void {
    const project = this.host.project();
    if (!project) return;
    const targets = index === null ? [] : this.targets(project);
    if (index === null || !targets.length) {
      openMenu(
        [
          { label: "最後に白紙のページを足す", run: () => this.insertAt(project.pages.length - 1, true) },
          { label: "最後に見開き（2 ページ）を足す", run: () => this.insertAt(project.pages.length - 1, true, 2) },
          { label: "最後に貼り付け", keys: "Ctrl+V", disabled: !copied, run: () => this.paste(project.pages.length) },
          SEPARATOR,
          { label: "すべてのページを選ぶ", keys: "Ctrl+A", run: () => this.selectAll() },
        ],
        x,
        y,
        "ページ",
      );
      return;
    }
    const ids = targets.map((i) => project.pages[i].id);
    const label = pagesLabel(targets);
    const runs = runsOf(withPartners(project, targets));
    const oneRun = runs.length === 1;
    const [first, last] = runs[0];
    const blocked = cannotRemove(project, ids);
    const empties = trailingEmptyIds(project, pageIsEmpty);
    const single = targets.length === 1 ? project.pages[targets[0]] : null;
    const pair = single && !project.scroll ? spreadPair(project, single, this.host.firstAlone()) : null;
    const joined = !!pair?.[0].joinNext;
    const key = (command: string, fallback: string) => this.keys(command, fallback);
    const items: (MenuItem | typeof SEPARATOR)[] = [
      { label: `前に白紙のページを入れる`, keys: "Shift+Insert", run: () => this.insert(false) },
      { label: `後ろに白紙のページを入れる`, keys: key("page.add", "Insert"), run: () => this.insert(true) },
      { label: "後ろに見開き（2 ページ）を入れる", run: () => this.insert(true, 2) },
      { label: `複製して後ろに入れる`, keys: key("page.duplicate", "Ctrl+D"), title: "見開きは 2 ページ一緒に複製します", run: () => this.duplicate() },
      SEPARATOR,
      { label: "コピー", keys: "Ctrl+C", title: "ほかのネームにも貼り付けられます", run: () => this.copy() },
      { label: "切り取り", keys: "Ctrl+X", disabled: !!blocked, run: () => void this.cut() },
      { label: "前に貼り付け", keys: "Ctrl+Shift+V", disabled: !copied, run: () => this.paste(first) },
      { label: "後ろに貼り付け", keys: "Ctrl+V", disabled: !copied, run: () => this.paste(last + 1) },
      SEPARATOR,
      { label: "1 つ前へ", keys: "Alt+↑", disabled: !oneRun || first === 0, run: () => this.move(-1) },
      { label: "1 つ後ろへ", keys: "Alt+↓", disabled: !oneRun || last === project.pages.length - 1, run: () => this.move(1) },
      { label: "先頭へ", disabled: !oneRun || first === 0, run: () => this.host.movePages(first, last, 0) },
      { label: "最後へ", disabled: !oneRun || last === project.pages.length - 1, run: () => this.host.movePages(first, last, project.pages.length) },
      SEPARATOR,
      ...(pair
        ? [
            {
              label: joined ? "CSP の見開きページをやめる" : "CSP で 1 枚の見開きページにする",
              title: `${pageIndex(project, pair[0].id) + 1}–${pageIndex(project, pair[1].id) + 1} ページ`,
              run: () => this.host.edit((p) => setSpreadPage(p, single!, this.host.firstAlone(), !joined)),
            } satisfies MenuItem,
          ]
        : []),
      { label: "別案を作る", disabled: !oneRun, title: "このページ（続いたページ）の別のバージョンを作って比べる", run: () => this.host.makeOption(first, last) },
      { label: "保留にする（外して取っておく）", disabled: !!blocked, title: blocked ?? "「保留」の欄に移します。元の場所やほかの場所に戻せます", run: () => this.hold() },
      SEPARATOR,
      { label: `${label}を削除`, keys: key("page.delete", "Delete"), danger: true, disabled: !!blocked, title: blocked ?? "元に戻すで戻せます", run: () => void this.remove() },
      ...(empties.length ? [{ label: `最後の空のページ ${empties.length} 枚を削除`, run: () => void this.remove(empties) } satisfies MenuItem] : []),
    ];
    openMenu(items, x, y, `${label}のメニュー`);
  }

  // --- what the list does ---------------------------------------------------

  /** Blank pages in front of the first target (`after` false) or behind the last. */
  insert(after: boolean, count = 1): void {
    const targets = this.targets();
    if (!targets.length) return;
    this.insertAt(after ? targets[targets.length - 1] : targets[0], after, count);
  }

  private insertAt(index: number, after: boolean, count = 1): void {
    let added: Page[] = [];
    this.host.edit((p) => (added = insertBlankPages(p, index, after, count)));
    const project = this.host.project();
    if (!added.length || !project) return;
    this.pick(
      added.map((page) => page.id),
      added[0].id,
    );
    const at = pageIndex(project, added[0].id);
    this.host.status(`${at + 1}${added.length > 1 ? `–${at + added.length}` : ""} ページに白紙のページを入れました（元に戻すは Ctrl+Z）`);
  }

  duplicate(): void {
    const targets = this.targets();
    if (!targets.length) return;
    let copies: Page[] = [];
    this.host.edit((p) => (copies = duplicatePages(p, targets)));
    const project = this.host.project();
    if (!copies.length || !project) return;
    this.pick(
      copies.map((page) => page.id),
      copies[0].id,
    );
    this.host.status(`${pagesLabel(copies.map((c) => pageIndex(project, c.id)))}に複製しました（元に戻すは Ctrl+Z）`);
  }

  /** Delete the target pages (or `ids`), asking first when something is on them. */
  async remove(ids?: string[]): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    const indexes = ids ? ids.map((id) => pageIndex(project, id)).filter((i) => i >= 0) : this.targets(project);
    const going = indexes.map((i) => project.pages[i].id);
    const why = cannotRemove(project, going);
    if (why) {
      this.host.status(why);
      return;
    }
    const label = pagesLabel(indexes);
    const filled = indexes.filter((i) => !pageIsEmpty(project.pages[i])).length;
    if (filled && !(await ask(`${label}を消しますか？（中身のあるページ ${filled} 枚。元に戻すで戻せます）`, { title: "Name Studio", kind: "warning" }))) return;
    const first = Math.min(...indexes);
    let done = false;
    this.host.edit((p) => (done = deletePages(p, going)));
    if (!done) return;
    this.afterRemoval(first);
    this.host.status(`${label}を消しました（元に戻すは Ctrl+Z）`);
  }

  /** From elsewhere (a scene's menu): pages `ids` picked, held or deleted. */
  act(what: "pick" | "hold" | "delete", ids: string[]): void {
    const project = this.host.project();
    if (!project || !ids.length) return;
    if (what === "delete") {
      void this.remove(ids);
      return;
    }
    this.pick(ids, ids[0]);
    if (what === "hold") this.hold();
    else this.host.status(`${pagesLabel(ids.map((id) => pageIndex(project, id)))}を選びました（ページ一覧でコピー・移動・保留などができます）`);
  }

  /** Take the target pages out to the 保留 list. */
  hold(): void {
    const project = this.host.project();
    if (!project) return;
    const targets = this.targets(project);
    const going = targets.map((i) => project.pages[i].id);
    const why = cannotRemove(project, going);
    if (why) {
      this.host.status(why);
      return;
    }
    let held = 0;
    this.host.edit((p) => (held = holdPages(p, going).length));
    if (!held) return;
    this.afterRemoval(Math.min(...targets));
    this.host.status(`${pagesLabel(targets)}を保留にしました。「保留」の欄から元の場所やほかの場所に戻せます（元に戻すは Ctrl+Z）`);
  }

  private afterRemoval(first: number): void {
    const project = this.host.project();
    if (!project) return;
    this.picked = new Set();
    this.host.openPage(Math.min(first, project.pages.length - 1) + 1);
  }

  copy(): void {
    const project = this.host.project();
    const targets = this.targets();
    if (!project || !targets.length) return;
    copied = clipPages(project, targets);
    this.host.status(`${pagesLabel(withPartners(project, targets))}をコピーしました。ページ一覧で Ctrl+V（後ろに）・Ctrl+Shift+V（前に）で貼り付けます。ほかのネームにも貼り付けられます`);
  }

  async cut(): Promise<void> {
    this.copy();
    const project = this.host.project();
    if (!project || !copied) return;
    // The copied pages (with their partners) go.
    const going = withPartners(project, this.targets(project)).map((i) => project.pages[i].id);
    await this.remove(going);
  }

  /** Paste the copied pages in front of page `target` (`pages.length`: at the end). */
  paste(target: number): void {
    const clip = copied;
    if (!clip) {
      this.host.status("コピーしたページがありません（ページ一覧でページを選んで Ctrl+C）");
      return;
    }
    let pasted: Page[] = [];
    this.host.edit((p) => (pasted = pastePages(p, clip, target)));
    if (!pasted.length || !this.host.project()) return;
    this.pick(
      pasted.map((page) => page.id),
      pasted[0].id,
    );
    this.host.status(`${pasted.length} ページを貼り付けました（元に戻すは Ctrl+Z）`);
  }

  /** The picked pages (in one run) one place earlier or later, past the whole 見開き next to them. */
  move(step: -1 | 1): void {
    const project = this.host.project();
    if (!project) return;
    const runs = runsOf(withPartners(project, this.targets(project)));
    if (runs.length !== 1) {
      this.host.status("続いたページを選ぶと動かせます");
      return;
    }
    const [first, last] = runs[0];
    if (step < 0 && first > 0) this.host.movePages(first, last, pageBlock(project, first - 1)[0]);
    if (step > 0 && last < project.pages.length - 1) this.host.movePages(first, last, pageBlock(project, last + 1)[1] + 1);
  }

  selectAll(): void {
    const project = this.host.project();
    if (!project) return;
    this.picked = new Set(project.pages.map((page) => page.id));
    this.pickedFor = this.host.focusPage()?.id ?? null;
    this.render(project);
  }

  /** Keys while the list has the focus. True when the key was used. */
  private handleKey(event: KeyboardEvent): boolean {
    const project = this.host.project();
    if (!project) return false;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    const targets = this.targets(project);
    if (ctrl && !event.altKey) {
      switch (key.toLowerCase()) {
        case "a":
          this.selectAll();
          return true;
        case "c":
          this.copy();
          return true;
        case "x":
          void this.cut();
          return true;
        case "v":
          if (targets.length) this.paste(event.shiftKey ? targets[0] : runsOf(withPartners(project, targets)).at(-1)![1] + 1);
          else this.paste(project.pages.length);
          return true;
        case "d":
          if (event.shiftKey) return false;
          this.duplicate();
          return true;
      }
      return false;
    }
    if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      this.move(key === "ArrowUp" ? -1 : 1);
      return true;
    }
    if (event.altKey) return false;
    if (key === "Delete" || key === "Backspace") {
      void this.remove();
      return true;
    }
    if (key === "Insert") {
      this.insert(!event.shiftKey);
      return true;
    }
    if (key === "Escape" && this.picked.size) {
      this.picked = new Set();
      this.render(project);
      return true;
    }
    if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      const at = targets[0];
      const item = at === undefined ? null : $("side-pages").querySelector<HTMLElement>(`.page-item[data-page="${project.pages[at].id}"]`);
      const box = item?.getBoundingClientRect();
      this.openMenuAt(at ?? null, box ? box.left + 24 : 40, box ? box.bottom : 40);
      return true;
    }
    if (key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End") {
      const focus = this.host.focusPage();
      const from = focus ? pageIndex(project, focus.id) : 0;
      const to = key === "Home" ? 0 : key === "End" ? project.pages.length - 1 : Math.max(0, Math.min(project.pages.length - 1, from + (key === "ArrowUp" ? -1 : 1)));
      if (event.shiftKey) {
        // Extend from the anchor; the page worked on moves along.
        const anchor = this.anchor ? pageIndex(project, this.anchor) : from;
        const [a, b] = [Math.min(anchor, to), Math.max(anchor, to)];
        if (!this.anchor) this.anchor = project.pages[from].id;
        this.pick(
          project.pages.slice(a, b + 1).map((p) => p.id),
          project.pages[to].id,
        );
      } else {
        this.anchor = project.pages[to].id;
        this.picked = new Set();
        this.host.openPage(to + 1);
      }
      $("side-pages").querySelector<HTMLElement>(`.page-item[data-page="${project.pages[to].id}"]`)?.scrollIntoView({ block: "nearest" });
      return true;
    }
    return false;
  }

  /** Close the menu (when the name changes under it). */
  close(): void {
    closeMenu();
  }
}
