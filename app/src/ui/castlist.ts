// 人物 (the palette): the characters, their voice (口調) and their lines, and
// managing them as the page list manages pages — put in, copied, moved (and
// dragged), copied to another name, merged into one, removed — by the
// buttons over the list, its right-click menu or keys (listops.ts).
import { ask } from "../platform/dialogs";
import {
  clipCharacters,
  type CharacterClip,
  duplicateCharacters,
  insertCharacter,
  linesOf,
  mergeCharacters,
  moveCharacters,
  pasteCharacters,
  removeCharacters,
} from "../domain/castops";
import { $, element } from "../platform/dom";
import { changeLooks, tidyLook } from "../domain/linelook";
import { lookFields } from "./lookfields";
import { dragSort } from "./dragsort";
import { canMove, moveRange } from "../domain/listorder";
import { type ListActions, ListPicker, toolRow } from "./listops";
import type { Project } from "../model/model";
import { SEPARATOR } from "./popupmenu";

export interface CastListHost {
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  goTo(pageId: string, kind: "line", id: string): void;
  status(message: string): void;
  /** 台本 with the search set to these words. */
  searchScript(words: string): void;
}

/** Characters copied (kept while the app runs, so they can be pasted into another name). */
let copied: CharacterClip | null = null;

export class CastList {
  readonly picker: ListPicker;
  private readonly actions: ListActions;
  /** Characters whose lines are listed. */
  private readonly open = new Set<string>();
  /** Characters whose フキダシ設定 is shown. */
  private readonly looksOpen = new Set<string>();

  constructor(private readonly host: CastListHost) {
    const ids = () => this.host.project()?.characters.map((c) => c.id) ?? [];
    const names = (list: string[]) => {
      const project = this.host.project();
      const named = list.map((id) => project?.characters.find((c) => c.id === id)?.name).filter(Boolean);
      return named.length > 2 ? `「${named[0]}」ほか ${named.length - 1} 人` : named.map((n) => `「${n}」`).join("");
    };
    this.actions = {
      noun: "人物",
      ids,
      insert: (after, at) => {
        const project = this.host.project();
        if (!project) return;
        const indexes = at.map((id) => project.characters.findIndex((c) => c.id === id)).filter((i) => i >= 0);
        const index = !indexes.length ? project.characters.length : after ? Math.max(...indexes) + 1 : Math.min(...indexes);
        let made = "";
        this.host.edit((p) => (made = insertCharacter(p, index).id));
        this.picker.pick([made]);
        this.rename(made);
      },
      duplicate: (list) => {
        let made: string[] = [];
        this.host.edit((p) => (made = duplicateCharacters(p, list).map((c) => c.id)));
        this.picker.pick(made);
        this.host.status(`${names(list)}を複製しました（セリフはもとの人物のままです）`);
      },
      remove: (list) => void this.remove(list),
      move: (list, to) => this.host.edit((p) => moveCharacters(p, list, to)),
      canMove: (list, to) => canMove(this.host.project()?.characters ?? [], (c) => c.id, list, to),
      copy: (list) => this.copy(list),
      cut: (list) => {
        this.copy(list);
        void this.remove(list);
      },
      paste: (before, at) => this.paste(before, at),
      canPaste: () => !!copied,
      rename: (id) => this.rename(id),
      extra: (list) => {
        const project = this.host.project();
        const first = project?.characters.find((c) => c.id === list[0]);
        if (!project || !first) return [];
        if (list.length > 1)
          return [
            {
              label: `選んだ ${list.length} 人を「${first.name}」1 人にまとめる`,
              title: "ほかの人のセリフ・感情・口調を、最初の人のものにして、ほかの人を消す（台本の取り込みで同じ人が 2 人になったときに）",
              run: () => this.merge(list),
            },
          ];
        return [
          { label: this.open.has(first.id) ? "セリフの一覧を閉じる" : "この人のセリフを並べる", run: () => this.toggle(first.id) },
          { label: "台本でこの人のセリフを探す", run: () => this.host.searchScript(first.name) },
          SEPARATOR,
          { label: "まとめる相手を選ぶには Ctrl+クリック", disabled: true, run: () => {} },
        ];
      },
      empty: () => [
        { label: "人物を足す", keys: "Insert", run: () => this.actions.insert?.(true, []) },
        { label: "貼り付け", keys: "Ctrl+V", disabled: !copied, run: () => this.paste(false, []) },
      ],
      changed: () => {
        const project = this.host.project();
        if (project) this.render(project);
      },
    };
    this.picker = new ListPicker($("side-cast"), this.actions);
  }

  private copy(list: string[]): void {
    const project = this.host.project();
    if (!project || !list.length) return;
    copied = clipCharacters(project, list);
    this.host.status(
      `人物 ${list.length} 人をコピーしました。人物の一覧で Ctrl+V で貼り付けます（ほかのネームにも。同じ名前の人がいれば足しません）`,
    );
  }

  private paste(before: boolean, at: string[]): void {
    const clip = copied;
    const project = this.host.project();
    if (!clip || !project) {
      this.host.status("コピーした人物がありません（人物の一覧で選んで Ctrl+C）");
      return;
    }
    const indexes = at.map((id) => project.characters.findIndex((c) => c.id === id)).filter((i) => i >= 0);
    const index = !indexes.length ? project.characters.length : before ? Math.min(...indexes) : Math.max(...indexes) + 1;
    let result = { added: [] as string[], skipped: 0 };
    this.host.edit((p) => {
      const { added, skipped } = pasteCharacters(p, clip, index);
      result = { added: added.map((c) => c.id), skipped };
    });
    if (result.added.length) this.picker.pick(result.added);
    this.host.status(
      `人物 ${result.added.length} 人を貼り付けました${result.skipped ? `（同じ名前の人がいる ${result.skipped} 人は足していません）` : ""}${result.added.length ? "（元に戻すは Ctrl+Z）" : ""}`,
    );
  }

  private async remove(list: string[]): Promise<void> {
    const project = this.host.project();
    if (!project || !list.length) return;
    const lines = linesOf(project, list);
    const who = list.length === 1 ? `「${project.characters.find((c) => c.id === list[0])?.name ?? ""}」` : `人物 ${list.length} 人`;
    if (
      lines &&
      !(await ask(`${who}を消しますか？（セリフ ${lines} 件の話者が空になります。元に戻すで戻せます）`, {
        title: "Name Studio",
        kind: "warning",
      }))
    )
      return;
    let count = 0;
    this.host.edit((p) => (count = removeCharacters(p, list)));
    if (count) this.host.status(`${who}を消しました（元に戻すは Ctrl+Z）`);
  }

  private merge(list: string[]): void {
    const project = this.host.project();
    const into = project?.characters.find((c) => c.id === list[0]);
    if (!into) return;
    let moved = 0;
    this.host.edit((p) => (moved = mergeCharacters(p, into.id, list)));
    this.picker.pick([into.id]);
    this.host.status(`${list.length} 人を「${into.name}」にまとめました（セリフ ${moved} 件を「${into.name}」に。元に戻すは Ctrl+Z）`);
  }

  private toggle(id: string): void {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    const project = this.host.project();
    if (project) this.render(project);
  }

  /** F2: the name field of the row, to type in. */
  private rename(id: string): void {
    const field = this.picker.container.querySelector<HTMLInputElement>(`[data-list-id="${CSS.escape(id)}"] input.cast-name`);
    field?.focus();
    field?.select();
  }

  render(project: Project): void {
    const targets = this.picker.targets();
    const rows = project.characters.map((character) => {
      const name = element("input", { type: "text", className: "cast-name", value: character.name, title: "名前（F2 でも直せます）" });
      name.addEventListener("change", () => this.host.edit(() => (character.name = name.value.trim() || character.name)));
      name.addEventListener("keydown", (event) => {
        // Enter or Esc: back to the list's keys.
        if (event.key === "Enter" || event.key === "Escape") {
          if (event.key === "Escape") name.value = character.name;
          this.picker.container.focus({ preventScroll: true });
        }
      });
      const color = element("input", { type: "color", value: character.color ?? "#2f6fdb", title: "色" });
      color.addEventListener("change", () => this.host.edit(() => (character.color = color.value)));
      const said = project.pages.flatMap((page, index) =>
        page.lines.filter((l) => l.speaker === character.id).map((line) => ({ page, index, line })),
      );
      // 口調: kept beside the name, to write the dialogue in voice.
      const tone = element("textarea", {
        className: "tone",
        rows: 2,
        placeholder: "口調のメモ（一人称・語尾・口ぐせ）",
        value: character.tone ?? "",
      });
      tone.addEventListener("change", () => {
        const text = tone.value.trim();
        // Also fires on the blur when the list is drawn again: only a real change is an edit.
        if (text === (character.tone ?? "")) return;
        this.host.edit(() => {
          if (text) character.tone = text;
          else delete character.tone;
        });
      });
      // フキダシ設定: the look of what this character says (over its kind's or type's).
      const look = element("details", { className: "cast-look", open: this.looksOpen.has(character.id) });
      const set = Object.keys(character.look ?? {}).length;
      const summary = element("summary", {
        textContent: `フキダシ設定${set ? `（${set} 項目）` : ""}`,
        title: "この人のセリフの形・フォント・大きさ・白抜き・白縁（ナレーションや「人物に従わない」種類は別）",
      });
      // Kept at once (the toggle event comes later, after a redraw may have replaced it).
      summary.addEventListener("click", () => (look.open ? this.looksOpen.delete(character.id) : this.looksOpen.add(character.id)));
      look.append(
        summary,
        ...lookFields(character.look ?? {}, "種類のまま", (next) => {
          let count = 0;
          this.host.edit((p) => {
            count = changeLooks(p, () => {
              const tidy = tidyLook(next);
              if (tidy) character.look = tidy;
              else delete character.look;
            });
          });
          this.host.status(`${character.name}のフキダシ設定を変えました${count ? `（セリフ ${count} 個も変わりました）` : ""}`);
        }),
      );
      // その人のセリフを並べて、口調が揃っているか見る。
      const open = this.open.has(character.id);
      const toggle = element("button", {
        className: "count",
        textContent: `${open ? "▾" : "▸"} ${said.length}`,
        title: "この人のセリフを並べる",
      });
      toggle.addEventListener("click", () => this.toggle(character.id));
      const grip = element("span", {
        className: "list-grip",
        textContent: "⋮⋮",
        title: "押して選ぶ（Ctrl・Shift で複数）・ドラッグで並べ替え・右クリックでメニュー",
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
      const block = element(
        "div",
        { className: "cast-block" },
        element("div", { className: "cast-item" }, grip, color, name, toggle),
        tone,
        look,
        ...list,
      );
      return this.picker.row(block, character.id);
    });
    dragSort(rows, {
      axis: "y",
      handle: (row) => row.querySelector<HTMLElement>(".list-grip") ?? row,
      drop: (first, last, target) =>
        this.host.edit((p) => {
          const next = moveRange(p.characters, first, last, target);
          if (next) p.characters = next;
        }),
    });
    const picked = targets.length;
    const tools = toolRow(
      [
        {
          id: "cast-add",
          text: "＋",
          title: "人物を足す（選んだ人の後ろに。Insert・Shift+Insert で前に）",
          run: () => this.actions.insert?.(true, targets),
        },
        {
          id: "cast-duplicate",
          text: "複製",
          title: "選んだ人を複製（Ctrl+D）",
          run: () => this.actions.duplicate?.(targets),
          disabled: !picked,
        },
        {
          id: "cast-merge",
          text: "まとめる",
          title: "選んだ人（Ctrl+クリックで 2 人以上）を最初の人 1 人にまとめる",
          run: () => this.merge(targets),
          disabled: picked < 2,
        },
        {
          id: "cast-delete",
          text: "削除",
          title: "選んだ人を消す（Delete・セリフの話者は空に。元に戻すで戻せます）",
          run: () => void this.remove(targets),
          disabled: !picked,
        },
      ],
      `${project.characters.length} 人${picked > 1 ? `・${picked} 人選択中` : ""}`,
    );
    const hint = element("p", {
      className: "hint",
      textContent: project.characters.length
        ? "⋮⋮ を押して選び（Ctrl・Shift で複数）、右クリックでメニュー。数を押すとその人のセリフを並べます。セリフの話者は右の欄で選べます。"
        : "人物はいません。＋ か Insert で足せます（台本を取り込むと話者が人物になります）。",
    });
    $("side-cast").replaceChildren(tools, ...rows, hint);
  }
}
