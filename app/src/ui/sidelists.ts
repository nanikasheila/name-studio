// The lists in the palettes beside the pages: ページ, 台本, 人物, 付箋 and
// 保留. Each is drawn again from the project when it changes; what a click
// does goes back to the workbench. Each list is managed with the same keys
// and menu as the page list (listops.ts).
import { CastList } from "./castlist";
import type { Selection } from "./editor";
import { AssistPanel } from "./assistpanel";
import type { HelpCommand } from "../editing/apphelp";
import { $ } from "../platform/dom";
import { HeldList } from "./heldlist";
import type { Page, Panel, Point, Project, RoughImage } from "../model/model";
import { NoteList } from "./notelist";
import { PageList, type PageListHost } from "./pagelist";
import { ScriptList } from "./scriptlist";

export { draggedHeld, HELD_TYPE } from "./heldlist";

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
  /** Write a line again on the page, where it is. */
  editLine(pageId: string, lineId: string): void;
  /** Bring a palette on screen. */
  openPalette(id: "script"): void;
  /** The open name's file (null: not saved yet). */
  path(): string | null;
  rough(rough: RoughImage): Promise<CanvasImageSource | null>;
  /** Every command (the AI's help lists them with their keys). */
  commands(): readonly HelpCommand[];
  undo(): void;
  redo(): void;
  /** Which name and how far along its changes: another value after any change, undo or opening. */
  version(): string;
  /** Put `project` in place of the open name, as one step that can be undone. */
  restore(project: Project): void;
}

export class SideLists {
  /** ページ管理: the page list. */
  readonly pageList: PageList;
  readonly scriptList: ScriptList;
  readonly castList: CastList;
  readonly noteList: NoteList;
  readonly heldList: HeldList;
  /** 相談: AI に相談 (assistpanel.ts). */
  readonly assistPanel: AssistPanel;

  constructor(host: SideListsHost) {
    this.pageList = new PageList(host);
    this.scriptList = new ScriptList(host);
    this.castList = new CastList({
      project: () => host.project(),
      edit: (change) => host.edit(change),
      goTo: (pageId, kind, id) => host.goTo(pageId, kind, id),
      status: (message) => host.status(message),
      searchScript: (words) => {
        host.openPalette("script");
        this.scriptList.search(words);
      },
    });
    this.noteList = new NoteList(host);
    this.heldList = new HeldList(host);
    this.assistPanel = new AssistPanel(host);
  }

  /** 相談: talk the name over with an AI (assistpanel.ts); a 変更の案 being tried follows every change, open or not. */
  assist(open: boolean): void {
    this.assistPanel.sync();
    if (open) this.assistPanel.render($("side-assist"));
  }

  /** ページ: the work's name and number, and each page (pagelist.ts). */
  pages(project: Project): void {
    this.pageList.render(project);
  }

  /** 台本: every line of dialogue, page by page (scriptlist.ts). */
  script(project: Project): void {
    this.scriptList.render(project);
  }

  /** 人物: the characters, their voice, and their lines (castlist.ts). */
  cast(project: Project): void {
    this.castList.render(project);
  }

  /** 付箋の一覧 (notelist.ts). */
  notes(project: Project): void {
    this.noteList.render(project);
  }

  /** 保留: panels waiting for a place, and pages taken out (heldlist.ts). */
  held(project: Project): void {
    this.heldList.render(project);
  }
}
