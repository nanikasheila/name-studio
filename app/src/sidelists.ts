// The lists in the palettes beside the pages: ページ, 台本, 人物, 付箋 and
// 保留. Each is drawn again from the project when it changes; what a click
// does goes back to the workbench.
import { $, element, plainButton } from "./dom";
import type { Selection } from "./editor";
import { heldThumbnail, pageGlyph } from "./glyph";
import { addCharacter, removeCharacter } from "./cast";
import type { Page, Panel, Point, Project } from "./model";
import { PageList, type PageListHost } from "./pagelist";
import { dropHeldPages, restoreHeldPages } from "./pageops";
import { linkLabel, removeSticky, STICKY_COLORS } from "./stickies";

/** What a held panel is carried as when dragged from the 保留 list. */
export const HELD_TYPE = "application/x-name-studio-held";

/** The held panel being dragged from the 保留 list (a drag's data cannot be read until the drop). */
let heldDragged: string | null = null;
export function draggedHeld(): string | null {
  return heldDragged;
}

export interface SideListsHost extends PageListHost {
  edit(change: (project: Project) => void): void;
  selection(): Selection | null;
  /** Show page `number` with `selection` picked. */
  showSelected(number: number, selection: Selection): void;
  goTo(pageId: string, kind: "line" | "sticky" | "panel", id: string): void;
  /** Put a held panel on `page`: into `panel`, at `point`, or where it was. */
  putHeld(id: string, page: Page, point?: Point, panel?: Panel): void;
  /** Lay a held panel in the 欄外 above `page`, or (null) take it out of the 欄外. */
  layHeld(id: string, page: Page | null): void;
  /** The dialog for taking in a script or a plot. */
  openScript(): void;
}

export class SideLists {
  /** Characters whose lines are listed in the 人物 tab. */
  private readonly openCast = new Set<string>();
  /** ページ管理: the page list. */
  readonly pageList: PageList;
  /** 台本: the words searched for (kept while the list is drawn again). */
  private scriptQuery = "";

  constructor(private readonly host: SideListsHost) {
    this.pageList = new PageList(host);
  }

  /** ページ: the work's name and number, and each page (pagelist.ts). */
  pages(project: Project): void {
    this.pageList.render(project);
  }

  /** 台本: every line of dialogue, page by page; a search keeps the lines with those words or speaker. */
  script(project: Project): void {
    const take = element("button", { textContent: "台本・プロットを取り込む…", title: "Markdown の台本（コマとセリフ）か、プロット（ページごとの文）を取り込む" });
    take.addEventListener("click", () => this.host.openScript());
    const search = element("input", { type: "search", className: "script-search", value: this.scriptQuery, placeholder: "セリフ・話す人で探す" });
    const rows = element("div", { className: "script-rows" });
    // Only the rows are drawn again as it is typed in, so the field keeps its caret.
    search.addEventListener("input", () => {
      this.scriptQuery = search.value;
      rows.replaceChildren(...this.scriptRows(project));
    });
    rows.replaceChildren(...this.scriptRows(project));
    $("side-script").replaceChildren(element("div", { className: "side-actions top" }, take), search, rows);
  }

  private scriptRows(project: Project): HTMLElement[] {
    const names = new Map(project.characters.map((character) => [character.id, character.name]));
    const words = this.scriptQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const picked = this.host.selection();
    const children: HTMLElement[] = [];
    let found = 0;
    project.pages.forEach((page, index) => {
      const lines = page.lines
        .map((line) => ({ line, who: line.kind === "narration" ? "N" : line.kind === "sfx" ? "音" : (names.get(line.speaker ?? "") ?? "？") }))
        .filter(({ line, who }) => {
          const hay = `${who} ${line.text.replace(/\s+/g, "")}`.toLowerCase();
          return words.every((word) => hay.includes(word));
        });
      if (words.length && !lines.length) return;
      found += lines.length;
      children.push(element("div", { className: "script-page", textContent: `${index + 1} ページ` }));
      for (const { line, who } of lines) {
        const selected = picked?.kind === "line" && picked.id === line.id;
        const row = element(
          "div",
          { className: `script-line ${line.kind}${selected ? " current" : ""}` },
          element("span", { className: "who", textContent: who }),
          element("span", { className: "text", textContent: line.text.replace(/\s+/g, " ") }),
        );
        row.addEventListener("click", () => this.host.showSelected(index + 1, { kind: "line", pageId: page.id, id: line.id }));
        children.push(row);
      }
    });
    if (words.length) children.unshift(element("p", { className: "hint", textContent: found ? `${found} 件` : "見つかりません" }));
    else if (!children.length) children.push(element("p", { className: "hint", textContent: "ページがありません" }));
    return children;
  }

  /** 人物: the characters, their voice, and their lines. */
  cast(project: Project): void {
    const rows = project.characters.map((character) => {
      const name = element("input", { type: "text", value: character.name });
      name.addEventListener("change", () => this.host.edit(() => (character.name = name.value.trim() || character.name)));
      const color = element("input", { type: "color", value: character.color ?? "#2f6fdb" });
      color.addEventListener("change", () => this.host.edit(() => (character.color = color.value)));
      const said = project.pages.flatMap((page, index) => page.lines.filter((l) => l.speaker === character.id).map((line) => ({ page, index, line })));
      const remove = element("button", { className: "danger", textContent: "消す", title: `セリフ ${said.length} 件の話者が空になります` });
      remove.addEventListener("click", () => this.host.edit((p) => removeCharacter(p, character.id)));
      // 口調: kept beside the name, to write the dialogue in voice.
      const tone = element("textarea", { className: "tone", rows: 2, placeholder: "口調のメモ（一人称・語尾・口ぐせ）", value: character.tone ?? "" });
      tone.addEventListener("change", () => {
        const text = tone.value.trim();
        // Also fires on the blur when the list is drawn again: only a real change is an edit.
        if (text === (character.tone ?? "")) return;
        this.host.edit(() => {
          if (text) character.tone = text;
          else delete character.tone;
        });
      });
      // その人のセリフを並べて、口調が揃っているか見る。
      const open = this.openCast.has(character.id);
      const toggle = element("button", { className: "count", textContent: `${open ? "▾" : "▸"} ${said.length}`, title: "この人のセリフを並べる" });
      toggle.addEventListener("click", () => {
        if (open) this.openCast.delete(character.id);
        else this.openCast.add(character.id);
        this.cast(project);
      });
      const list = open
        ? [
            element(
              "ol",
              { className: "cast-lines" },
              ...said.map(({ page, index, line }) => {
                const item = element("li", { textContent: `${index + 1}  ${line.text.replace(/\s+/g, "")}`, title: "このセリフへ" });
                item.addEventListener("click", () => this.host.goTo(page.id, "line", line.id));
                return item;
              }),
            ),
          ]
        : [];
      return element("div", { className: "cast-block" }, element("div", { className: "cast-item" }, color, name, toggle, remove), tone, ...list);
    });
    const add = element("button", { textContent: "人物を足す" });
    add.addEventListener("click", () => this.host.edit((p) => addCharacter(p, `人物${p.characters.length + 1}`)));
    const hint = element("p", { className: "hint", textContent: "セリフを選んで、右の欄で話者を選べます。数を押すとその人のセリフを並べます。" });
    $("side-cast").replaceChildren(...rows, element("div", { className: "side-actions" }, add), hint);
  }

  /** 付箋の一覧: every page's stickies in one place, the open questions of the name. */
  notes(project: Project): void {
    const items = project.pages.flatMap((page, index) =>
      (page.stickies ?? []).map((sticky) => {
        const swatch = element("span", { className: "swatch" });
        swatch.style.background = STICKY_COLORS[sticky.color ?? "yellow"].fill;
        const text = element("span", { className: "note-text", textContent: sticky.text.trim() || "（空の付箋）" });
        const about = linkLabel(page, sticky);
        const where = element("span", { className: "count", textContent: `${index + 1}`, title: about ? `${index + 1} ページの${about}` : `${index + 1} ページ` });
        if (about) text.append(element("small", { className: "note-link", textContent: ` → ${about}` }));
        const row = element("div", { className: "note-item", title: "この付箋へ" }, swatch, where, text);
        row.addEventListener("click", () => this.host.goTo(page.id, "sticky", sticky.id));
        const done = element("button", { className: "small", textContent: "済み", title: "決まったので付箋を外す（元に戻すで戻せます）" });
        done.addEventListener("click", (event) => {
          event.stopPropagation();
          this.host.edit(() => removeSticky(page, sticky.id));
        });
        row.append(done);
        return row;
      }),
    );
    const head = element("p", {
      className: "hint",
      textContent: items.length
        ? `付箋 ${items.length} 枚（未決のこと）。押すとその付箋へ、決まったら「済み」。`
        : "付箋はありません。付箋ツールでページに貼ると、ここに集まります。",
    });
    $("side-notes").replaceChildren(head, ...items);
  }

  /** 保留: panels waiting for a place, with the page each is meant for. */
  held(project: Project): void {
    const held = project.held ?? [];
    const shown = new Set(this.host.currentPages().map((n) => project.pages[n - 1]?.id));
    const target = this.host.selection()?.kind === "panel" ? this.host.selection() : null;
    const items = held.map((h) => {
      const near = element("select", { title: "このあたりのページに入れたい" });
      near.append(element("option", { value: "", textContent: "ページ未定" }));
      project.pages.forEach((page, index) => near.append(element("option", { value: page.id, textContent: `${index + 1} ページあたり` })));
      near.value = project.pages.some((p) => p.id === h.near) ? h.near! : "";
      near.addEventListener("change", () =>
        this.host.edit(() => {
          if (near.value) h.near = near.value;
          else delete h.near;
        }),
      );
      const words = h.lines
        .map((l) => l.text.replace(/\s+/g, ""))
        .filter(Boolean)
        .join(" / ");
      const put = plainButton("このページに置く", () => {
        const page = this.host.focusPage();
        if (page) this.host.putHeld(h.id, page);
      });
      put.title = "今のページの、元と同じ位置に置く（ページへドラッグしても置けます）";
      const into = plainButton("選んだコマへ", () => {
        const page = project.pages.find((p) => p.id === target?.pageId);
        const panel = page?.panels.find((p) => p.id === target?.id);
        if (page && panel) this.host.putHeld(h.id, page, undefined, panel);
      });
      into.title = "選んでいるコマに、中身（セリフ・ラフ線）を合わせて入れる";
      into.disabled = !target;
      const aside = h.at && project.pages.some((p) => p.id === h.near);
      const lay = plainButton(aside ? "欄外から下げる" : "欄外に置く", () => {
        const page = aside ? null : (project.pages.find((p) => p.id === h.near) ?? this.host.focusPage());
        if (aside || page) this.host.layHeld(h.id, page);
      });
      lay.title = aside ? "ページの外（欄外）から下げて、この一覧だけに置く" : "「このあたり」のページ（未定なら今のページ）の上の欄外に置いて、紙面で見えるようにする";
      const drop = plainButton("消す", () => this.host.edit((p) => (p.held = (p.held ?? []).filter((x) => x.id !== h.id))));
      drop.className = "danger small";
      const item = element(
        "div",
        { className: `held-item${h.near && shown.has(h.near) ? " near" : ""}`, draggable: true, title: "ページへドラッグして置く。コマの上で離すと、そのコマに中身を入れる（縦横比を保つかは 設定 › 操作）" },
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
      return item;
    });
    const head = element("p", {
      className: "hint",
      textContent: held.length
        ? `保留のコマ ${held.length}。ページへドラッグで置く（コマの上で離すと中身をそのコマへ）。ページの外へドラッグすると欄外に置けます。`
        : "保留のコマはありません。コマを選んで「保留」を押すと、中身ごとページの上の欄外へ移ります（ここにも並びます）。置き場所が決まったら、ページへドラッグして戻します。",
    });
    $("side-held").replaceChildren(head, ...items, ...this.heldPages(project));
  }

  /** 保留のページ: pages taken out of the name, to put back where they were or elsewhere. */
  private heldPages(project: Project): HTMLElement[] {
    const list = project.heldPages ?? [];
    if (!list.length) return [element("p", { className: "hint", textContent: "保留のページはありません。ページ一覧で右クリック ›「保留にする」で、ページを外して取っておけます。" })];
    const rows = list.map((held) => {
      const at = held.after ? project.pages.findIndex((p) => p.id === held.after) : -1;
      const where = held.after ? (at >= 0 ? `${at + 1} ページの後ろにあった` : "元の場所はもうありません") : "先頭にあった";
      const show = (pages: Page[]) => {
        const first = pages[0] && project.pages.findIndex((p) => p.id === pages[0].id);
        if (first !== undefined && first >= 0) this.host.openPage(first + 1);
      };
      const putBack = (target: number | "back", what: string) => {
        let pages: Page[] = [];
        this.host.edit((p) => (pages = restoreHeldPages(p, held.id, target)));
        show(pages);
        if (pages.length) this.host.status(`保留のページ ${pages.length} 枚を${what}に戻しました（元に戻すは Ctrl+Z）`);
      };
      const back = plainButton("元の場所に戻す", () => putBack("back", "元の場所"));
      back.title = where;
      const focus = this.host.focusPage();
      const here = plainButton("今のページの後ろに戻す", () => {
        const index = focus ? project.pages.findIndex((p) => p.id === focus.id) : -1;
        putBack(index + 1, `${index + 2} ページ`);
      });
      here.disabled = !focus;
      const drop = plainButton("消す", () => this.host.edit((p) => dropHeldPages(p, held.id)));
      drop.className = "danger small";
      drop.title = "保留のページを捨てる（元に戻すで戻せます）";
      const memo = held.pages.map((p) => p.memo.split("\n")[0]).filter(Boolean).join(" / ");
      return element(
        "div",
        { className: "held-item held-pages", title: where },
        element("div", { className: "held-page-glyphs" }, ...held.pages.map((p) => pageGlyph(project, p, 28))),
        element(
          "div",
          { className: "held-body" },
          element("div", { className: "held-words", textContent: `${held.pages.length} ページ・${where}` }),
          ...(memo ? [element("div", { className: "held-note", textContent: memo })] : []),
          element("div", { className: "held-actions" }, back, here, drop),
        ),
      );
    });
    return [element("h3", { className: "held-heading", textContent: `保留のページ ${list.length}` }), ...rows];
  }
}
