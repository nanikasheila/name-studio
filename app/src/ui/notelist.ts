// 付箋の一覧 (the palette): every page's stickies in one place, the open
// questions of the name — narrowed to a colour or the pages on screen,
// picked one or several (listops.ts) to go to, to give another colour, to
// copy as text, or to take off as 済み; a new one stuck on the page worked on.
import { $, element } from "../platform/dom";
import { copyText, ListPicker, toolRow } from "./listops";
import type { Page, Project, Sticky, StickyColor } from "../model/model";
import { addSticky, linkLabel, removeSticky, STICKY_COLORS, STICKY_WIDTH_MM } from "../domain/stickies";

export interface NoteListHost {
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  goTo(pageId: string, kind: "sticky", id: string): void;
  focusPage(): Page | null;
  /** Page numbers (from 1) on screen now. */
  currentPages(): number[];
  status(message: string): void;
}

interface Shown {
  page: Page;
  index: number;
  sticky: Sticky;
}

const COLORS = Object.keys(STICKY_COLORS) as StickyColor[];

export class NoteList {
  readonly picker: ListPicker;
  /** The colours shown (none: all). */
  private readonly colors = new Set<StickyColor>();
  /** Only the pages on screen. */
  private here = false;

  constructor(private readonly host: NoteListHost) {
    const find = (id: string) => this.shown().find((s) => s.sticky.id === id);
    this.picker = new ListPicker($("side-notes"), {
      noun: "付箋",
      ids: () => this.shown().map((s) => s.sticky.id),
      open: (id) => {
        const s = find(id);
        if (s) this.host.goTo(s.page.id, "sticky", id);
      },
      insert: () => this.add(),
      remove: (ids) => this.done(ids),
      removeLabel: "済み（付箋を外す）",
      copy: (ids) => void this.copy(ids),
      rename: (id) => {
        const s = find(id);
        if (!s) return;
        this.host.goTo(s.page.id, "sticky", id);
        // The words are written in the inspector.
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#inspector textarea")?.focus());
      },
      extra: (ids) =>
        COLORS.map((color) => ({
          label: `${STICKY_COLORS[color].label}にする`,
          run: () => this.recolor(ids, color),
        })),
      empty: () => [{ label: "今のページに付箋を足す", keys: "Insert", run: () => this.add() }],
      changed: () => {
        const project = this.host.project();
        if (project) this.render(project);
      },
    });
  }

  private shown(project = this.host.project()): Shown[] {
    if (!project) return [];
    const here = new Set(this.host.currentPages().map((n) => n - 1));
    return project.pages.flatMap((page, index) =>
      (page.stickies ?? [])
        .filter((sticky) => (!this.colors.size || this.colors.has(sticky.color ?? "yellow")) && (!this.here || here.has(index)))
        .map((sticky) => ({ page, index, sticky })),
    );
  }

  /** A blank sticky at the top right of the page worked on, to write in. */
  private add(): void {
    const page = this.host.focusPage();
    const project = this.host.project();
    if (!page || !project) return;
    const [width] = project.pageFormat.canvasMm;
    let made: Sticky | null = null;
    this.host.edit((p) => {
      const on = p.pages.find((one) => one.id === page.id);
      if (on) made = addSticky(p, on, [Math.max(4, width - STICKY_WIDTH_MM - 8), 8 + (on.stickies?.length ?? 0) * 6]);
    });
    if (!made) return;
    const id = (made as Sticky).id;
    this.picker.pick([id]);
    this.host.goTo(page.id, "sticky", id);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#inspector textarea")?.focus());
    this.host.status("今のページに付箋を足しました。右の欄に書きます（元に戻すは Ctrl+Z）");
  }

  private done(ids: string[]): void {
    let count = 0;
    this.host.edit((p) => {
      for (const page of p.pages)
        for (const id of ids) {
          if (!page.stickies?.some((s) => s.id === id)) continue;
          removeSticky(page, id);
          count++;
        }
    });
    this.picker.clear();
    if (count) this.host.status(`付箋 ${count} 枚を済みにして外しました（元に戻すは Ctrl+Z）`);
  }

  private recolor(ids: string[], color: StickyColor): void {
    this.host.edit((p) => {
      for (const page of p.pages)
        for (const sticky of page.stickies ?? []) {
          if (!ids.includes(sticky.id)) continue;
          if (color === "yellow") delete sticky.color;
          else sticky.color = color;
        }
    });
  }

  private async copy(ids: string[]): Promise<void> {
    const shown = this.shown().filter((s) => ids.includes(s.sticky.id));
    const text = shown.map((s) => `${s.index + 1}p ${s.sticky.text.trim() || "（空の付箋）"}`).join("\n");
    const ok = await copyText(text);
    this.host.status(ok ? `付箋 ${shown.length} 枚の文をコピーしました` : "クリップボードに入れられませんでした");
  }

  render(project: Project): void {
    const all = project.pages.reduce((sum, page) => sum + (page.stickies?.length ?? 0), 0);
    const shown = this.shown(project);
    const items = shown.map(({ page, index, sticky }) => {
      const swatch = element("span", { className: "swatch" });
      swatch.style.background = STICKY_COLORS[sticky.color ?? "yellow"].fill;
      const text = element("span", { className: "note-text", textContent: sticky.text.trim() || "（空の付箋）" });
      const about = linkLabel(page, sticky);
      const where = element("span", {
        className: "count",
        textContent: `${index + 1}`,
        title: about ? `${index + 1} ページの${about}` : `${index + 1} ページ`,
      });
      if (about) text.append(element("small", { className: "note-link", textContent: ` → ${about}` }));
      const row = element(
        "div",
        { className: "note-item", title: "押すとこの付箋へ（Ctrl・Shift で複数選ぶ・右クリックで色・コピー・済み）" },
        swatch,
        where,
        text,
      );
      const done = element("button", {
        className: "small",
        textContent: "済み",
        title: "決まったので付箋を外す（Delete・元に戻すで戻せます）",
      });
      done.addEventListener("click", (event) => {
        event.stopPropagation();
        this.done([sticky.id]);
      });
      row.append(done);
      return this.picker.row(row, sticky.id);
    });
    // 絞り込み: a colour, the pages on screen.
    const filters = element("div", { className: "note-filters", title: "色・今のページで絞り込む" });
    for (const color of COLORS) {
      const chip = element("button", {
        type: "button",
        className: `note-filter${this.colors.has(color) ? " active" : ""}`,
        title: `${STICKY_COLORS[color].label}の付箋だけ（もう一度で全部）`,
      });
      chip.style.setProperty("--chip", STICKY_COLORS[color].fill);
      chip.setAttribute("aria-label", `${STICKY_COLORS[color].label}の付箋だけ`);
      chip.setAttribute("aria-pressed", String(this.colors.has(color)));
      chip.addEventListener("click", () => {
        if (this.colors.has(color)) this.colors.delete(color);
        else this.colors.add(color);
        this.render(project);
      });
      filters.append(chip);
    }
    const here = element("button", {
      type: "button",
      className: `note-filter here${this.here ? " active" : ""}`,
      textContent: "このページ",
      title: "画面に出ているページの付箋だけ",
    });
    here.setAttribute("aria-pressed", String(this.here));
    here.addEventListener("click", () => {
      this.here = !this.here;
      this.render(project);
    });
    filters.append(here);
    const picked = this.picker.targets();
    const tools = toolRow(
      [
        { id: "note-add", text: "＋", title: "今のページに付箋を足す（Insert）", run: () => this.add(), disabled: !this.host.focusPage() },
        {
          id: "note-done",
          text: "済み",
          title: "選んだ付箋を外す（Delete・元に戻すで戻せます）",
          run: () => this.done(picked),
          disabled: !picked.length,
        },
      ],
      `${shown.length === all ? `${all} 枚` : `${shown.length} / ${all} 枚`}${picked.length > 1 ? `・${picked.length} 枚選択中` : ""}`,
    );
    const head = element("p", {
      className: "hint",
      textContent: all
        ? shown.length
          ? "押すとその付箋へ。Ctrl・Shift で複数選んで、右クリックで色・コピー・済み。"
          : "絞り込みに合う付箋はありません。"
        : "付箋はありません。付箋ツールでページに貼るか、＋（Insert）で今のページに足すと、ここに集まります。",
    });
    $("side-notes").replaceChildren(tools, filters, head, ...items);
  }
}
