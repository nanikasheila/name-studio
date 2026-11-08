// 台本 (the palette): every line of dialogue, page by page, searched by its
// words or speaker; lines picked one or several (listops.ts) to go to, to
// write again in place (F2), to copy as script text, to give another
// speaker or kind all at once, or to remove.
import { ask } from "@tauri-apps/plugin-dialog";
import { KIND_LABELS, setLineKind } from "./dialogue";
import { $, element } from "./dom";
import type { Selection } from "./editor";
import { copyText, ListPicker, toolRow } from "./listops";
import type { Line, LineKind, Page, Project } from "./model";
import { linesText, scriptText } from "./nameexport";
import { SEPARATOR } from "./popupmenu";
import { removePicked } from "./removal";

export interface ScriptListHost {
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  selection(): Selection | null;
  /** Show page `number` with `selection` picked. */
  showSelected(number: number, selection: Selection): void;
  /** Write the line again on the page, where it is. */
  editLine(pageId: string, lineId: string): void;
  openScript(): void;
  status(message: string): void;
}

interface Shown {
  page: Page;
  index: number;
  line: Line;
  who: string;
}

const KINDS: LineKind[] = ["speech", "thought", "narration", "sfx", "aside"];

export class ScriptList {
  readonly picker: ListPicker;
  /** The words searched for (kept while the list is drawn again). */
  private query = "";

  constructor(private readonly host: ScriptListHost) {
    const shown = () => {
      const project = this.host.project();
      return project ? this.shown(project) : [];
    };
    const find = (id: string) => shown().find((s) => s.line.id === id);
    this.picker = new ListPicker($("side-script"), {
      noun: "セリフ",
      ids: () => shown().map((s) => s.line.id),
      open: (id) => {
        const s = find(id);
        if (s) this.host.showSelected(s.index + 1, { kind: "line", pageId: s.page.id, id });
      },
      remove: (ids) => void this.remove(ids),
      copy: (ids) => void this.copy(ids),
      cut: (ids) => void this.copy(ids).then(() => this.remove(ids)),
      rename: (id) => {
        const s = find(id);
        if (s) this.host.editLine(s.page.id, id);
      },
      extra: (ids) => {
        const project = this.host.project();
        if (!project) return [];
        return [
          ...project.characters.map((character) => ({ label: `話者を「${character.name}」に`, run: () => this.setSpeaker(ids, character.id) })),
          { label: "話者をなしに", run: () => this.setSpeaker(ids, null) },
          SEPARATOR,
          ...KINDS.map((kind) => ({ label: `${KIND_LABELS[kind]}にする`, run: () => this.setKind(ids, kind) })),
        ];
      },
      empty: () => [
        { label: "台本・プロットを取り込む…", run: () => this.host.openScript() },
        { label: "台本をすべてコピー", run: () => void this.copyAll() },
      ],
      changed: () => {
        const project = this.host.project();
        if (project) this.render(project);
      },
    });
  }

  private shown(project: Project): Shown[] {
    const names = new Map(project.characters.map((character) => [character.id, character.name]));
    const words = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return project.pages.flatMap((page, index) =>
      page.lines
        .map((line) => ({ page, index, line, who: line.kind === "narration" ? "N" : line.kind === "sfx" ? "音" : (names.get(line.speaker ?? "") ?? "？") }))
        .filter(({ line, who }) => {
          const hay = `${who} ${line.text.replace(/\s+/g, "")}`.toLowerCase();
          return words.every((word) => hay.includes(word));
        }),
    );
  }

  /** Search for these words (from the 人物 list). */
  search(words: string): void {
    this.query = words;
    const project = this.host.project();
    if (project) this.render(project);
  }

  private async copy(ids: string[]): Promise<void> {
    const project = this.host.project();
    if (!project || !ids.length) return;
    const ok = await copyText(linesText(project, ids));
    this.host.status(ok ? `セリフ ${ids.length} 件を台本の形でコピーしました（ほかのアプリに貼り付けられます）` : "クリップボードに入れられませんでした");
  }

  private async copyAll(): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    const ok = await copyText(scriptText(project));
    this.host.status(ok ? "台本をすべてコピーしました（「台本・プロットを取り込む」でも読めます）" : "クリップボードに入れられませんでした");
  }

  private async remove(ids: string[]): Promise<void> {
    const project = this.host.project();
    if (!project || !ids.length) return;
    if (ids.length > 1 && !(await ask(`セリフ ${ids.length} 件を消しますか？（元に戻すで戻せます）`, { title: "Name Studio", kind: "warning" }))) return;
    const where = project.pages.flatMap((page) => page.lines.filter((line) => ids.includes(line.id)).map((line) => ({ pageId: page.id, id: line.id })));
    this.host.edit((p) => {
      for (const { pageId, id } of where) removePicked(p, { kind: "line", pageId, id });
    });
    this.picker.clear();
    this.host.status(`セリフ ${where.length} 件を消しました（元に戻すは Ctrl+Z）`);
  }

  private setSpeaker(ids: string[], speaker: string | null): void {
    let count = 0;
    this.host.edit((p) => {
      for (const page of p.pages)
        for (const line of page.lines) {
          if (!ids.includes(line.id)) continue;
          if (speaker) line.speaker = speaker;
          else delete line.speaker;
          count++;
        }
    });
    const name = speaker ? this.host.project()?.characters.find((c) => c.id === speaker)?.name : null;
    this.host.status(`セリフ ${count} 件の話者を${name ? `「${name}」` : "なし"}にしました`);
  }

  private setKind(ids: string[], kind: LineKind): void {
    let count = 0;
    this.host.edit((p) => {
      for (const page of p.pages)
        for (const line of page.lines) {
          if (!ids.includes(line.id) || line.kind === kind) continue;
          setLineKind(p, line, kind);
          count++;
        }
    });
    this.host.status(`セリフ ${count} 件を${KIND_LABELS[kind]}にしました`);
  }

  render(project: Project): void {
    const take = element("button", { textContent: "台本・プロットを取り込む…", title: "Markdown の台本（コマとセリフ）か、プロット（ページごとの文）を取り込む" });
    take.addEventListener("click", () => this.host.openScript());
    const search = element("input", { type: "search", className: "script-search", value: this.query, placeholder: "セリフ・話す人で探す" });
    const rows = element("div", { className: "script-rows" });
    // Only the rows are drawn again as it is typed in, so the field keeps its caret.
    search.addEventListener("input", () => {
      this.query = search.value;
      rows.replaceChildren(...this.rows(project));
    });
    search.addEventListener("keydown", (event) => {
      // ↓ from the search: into the list.
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        this.picker.container.focus({ preventScroll: true });
      }
    });
    rows.replaceChildren(...this.rows(project));
    const picked = this.picker.targets();
    const tools = toolRow(
      [
        { id: "script-copy", text: "コピー", title: "選んだセリフ（なければ全部）を台本の形でコピー（Ctrl+C）", run: () => void (picked.length ? this.copy(picked) : this.copyAll()) },
        { id: "script-delete", text: "削除", title: "選んだセリフを消す（Delete・元に戻すで戻せます）", run: () => void this.remove(picked), disabled: !picked.length },
      ],
      picked.length > 1 ? `${picked.length} 件選択中` : "",
    );
    $("side-script").replaceChildren(element("div", { className: "side-actions top" }, take), tools, search, rows);
  }

  private rows(project: Project): HTMLElement[] {
    const words = this.query.trim();
    const picked = this.host.selection();
    const children: HTMLElement[] = [];
    let lastPage = -1;
    const shown = this.shown(project);
    for (const { page, index, line, who } of shown) {
      if (index !== lastPage) {
        children.push(element("div", { className: "script-page", textContent: `${index + 1} ページ` }));
        lastPage = index;
      }
      const selected = picked?.kind === "line" && picked.id === line.id;
      const row = element(
        "div",
        { className: `script-line ${line.kind}${selected ? " current" : ""}`, title: "押すとこのセリフへ（F2 でその場で直す・右クリックで話者・種類・コピー・削除）" },
        element("span", { className: "who", textContent: who }),
        element("span", { className: "text", textContent: line.text.replace(/\s+/g, " ") }),
      );
      row.addEventListener("dblclick", () => this.host.editLine(page.id, line.id));
      children.push(this.picker.row(row, line.id));
    }
    if (words) children.unshift(element("p", { className: "hint", textContent: shown.length ? `${shown.length} 件` : "見つかりません" }));
    else if (!children.length) children.push(element("p", { className: "hint", textContent: project.pages.length ? "セリフがありません" : "ページがありません" }));
    return children;
  }
}
