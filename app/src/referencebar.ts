// 資料画像 around the page editor: the 資料 tool's bar (how faint, take off),
// pictures laid on a page from a file, the clipboard or a drop, and the
// clipboard mark that tells a picture copied elsewhere from a copy made here.
// Moving and sizing a picture is the 資料 tool's (toolreference.ts).
import { $ } from "./dom";
import { isTyping, type PageEditor, type Tool } from "./editor";
import { logError } from "./errorlog";
import { showAlert } from "./alerts";
import type { Page, Point, Project, StoredImage } from "./model";
import { readImage } from "./pictures";
import { newId } from "./project";
import { addReference, opacityOf, removeReference } from "./references";

/** What the 資料 bar needs from the editor around it. */
export interface ReferenceBarHost {
  readonly editor: PageEditor;
  project(): Project | null;
  /** Run a change as one undoable step. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  setTool(tool: Tool): void;
  /** A number field that shows on the page as it changes and is one undo step. */
  liveNumber(field: HTMLInputElement, apply: (value: number) => void): void;
}

export class ReferenceBar {
  /** What the last copy here put on the system clipboard ("failed" when it could not), to tell it from a picture copied later. */
  private copyMark: string | null = null;
  /** The browser's paste event came after Ctrl+V. */
  private pasteHandled = true;

  constructor(private readonly host: ReferenceBarHost) {}

  private get editor(): PageEditor {
    return this.host.editor;
  }

  /** The picture chosen with the 資料 tool, and its page. */
  private chosen() {
    const chosen = this.editor.reference;
    const page = chosen && this.host.project()?.pages.find((p) => p.id === chosen.pageId);
    const reference = page?.references?.find((r) => r.id === chosen!.id);
    return page && reference ? { page, reference } : null;
  }

  render(): void {
    const chosen = this.chosen();
    const opacity = $<HTMLInputElement>("reference-opacity");
    opacity.disabled = !chosen;
    if (chosen) opacity.value = String(opacityOf(chosen.reference));
    $<HTMLButtonElement>("reference-remove").disabled = !chosen;
  }

  /** The tool in hand changed: a picture stays chosen only with the 資料 tool. */
  toolChanged(tool: Tool): void {
    if (tool !== "reference" && this.editor.reference) this.editor.chooseReference(null);
    this.render();
  }

  /** The chosen picture moved by the arrow keys (mm). */
  nudgeChosen(dx: number, dy: number): boolean {
    const chosen = this.chosen();
    if (!chosen) return false;
    this.host.edit(() => {
      const [x0, y0, x1, y1] = chosen.reference.box;
      chosen.reference.box = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
    });
    return true;
  }

  removeChosen(): void {
    const chosen = this.chosen();
    if (!chosen) return;
    this.host.edit(() => removeReference(chosen.page, chosen.reference.id));
    this.editor.chooseReference(null);
    this.host.status("資料画像を外しました（Ctrl+Z で戻せます）");
  }

  /**
   * Picture files (or a pasted picture) laid on a page: the page under the
   * pointer (or dropped on), else the one worked on. Each is made smaller when
   * large, kept once in the name, and chosen with the 資料 tool to move at once.
   */
  async pasteImages(files: File[], where?: { page: Page; point?: Point }): Promise<boolean> {
    const project = this.host.project();
    const pictures = files.filter((file) => file.type.startsWith("image/"));
    if (!project || !pictures.length) return false;
    const target = where ?? this.editor.pasteTarget();
    if (!target) return false;
    this.host.status("画像を読み込んでいます…");
    try {
      const images: StoredImage[] = [];
      for (const file of pictures) images.push(await readImage(file, file.name || "貼り付けた画像"));
      if (this.host.project() !== project || !project.pages.includes(target.page)) return false;
      let last: string | null = null;
      this.host.edit(() => {
        images.forEach((image, i) => {
          // Numbered inside the step, so undo takes the number back with the picture.
          image.id = newId(project, "image");
          const at = target.point && ([target.point[0] + i * 8, target.point[1] + i * 8] as Point);
          last = addReference(project, target.page, image, at).id;
        });
      });
      if (this.editor.tool !== "reference") this.host.setTool("reference");
      if (last) this.editor.chooseReference({ pageId: target.page.id, id: last });
      const number = project.pages.indexOf(target.page) + 1;
      this.host.status(`${number} ページに資料画像を貼りました。ドラッグで動かし、角で大きさを変えます`);
      return true;
    } catch (error) {
      showAlert("reference", `画像を貼れませんでした: ${error instanceof Error ? error.message : String(error)}`, "error", 8);
      logError(error);
      return false;
    }
  }

  /**
   * Copy here, marking the system clipboard so a later Ctrl+V knows whether
   * a picture there came after it (and so is the one meant).
   */
  copyItems(): boolean {
    if (!this.editor.copy()) return false;
    const mark = `name-studio:${Date.now()}`;
    this.copyMark = "failed";
    if (!navigator.clipboard) return true;
    void navigator.clipboard
      .writeText(mark)
      .then(() => (this.copyMark = mark))
      .catch(() => (this.copyMark = "failed"));
    return true;
  }

  /** Ctrl+V: the browser's paste event comes next, with the clipboard's picture if there is one; where it does not come, what was copied here is pasted. */
  paste(): void {
    this.pasteHandled = false;
    window.setTimeout(() => {
      if (!this.pasteHandled) this.editor.paste();
    }, 60);
  }

  bind(): void {
    const file = $<HTMLInputElement>("reference-file");
    $("reference-add").addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const files = [...(file.files ?? [])];
      file.value = "";
      const page = this.editor.focusPage();
      void this.pasteImages(files, page ? { page } : undefined);
    });
    this.host.liveNumber($<HTMLInputElement>("reference-opacity"), (value) => {
      const chosen = this.chosen();
      if (chosen) chosen.reference.opacity = Math.min(1, value);
    });
    $("reference-remove").addEventListener("click", () => this.removeChosen());
    // Ctrl+V: a picture on the clipboard (copied after the last copy made here) is laid on the page.
    document.addEventListener("paste", (event) => {
      this.pasteHandled = true;
      if (!this.host.project() || isTyping(event) || document.querySelector("dialog[open]")) return;
      if (!$("editor-canvas").getClientRects().length) return;
      const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      const ours = this.copyMark === "failed" || (this.copyMark !== null && event.clipboardData?.getData("text/plain") === this.copyMark);
      if (files.length && !ours) {
        event.preventDefault();
        void this.pasteImages(files);
      } else if (this.editor.paste()) event.preventDefault();
    });
    // Picture files dropped from outside on a page.
    const canvas = $("editor-canvas");
    canvas.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    canvas.addEventListener("drop", (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.some((f) => f.type.startsWith("image/"))) return;
      event.preventDefault();
      const where = this.editor.pageAtClient(event.clientX, event.clientY);
      void this.pasteImages(files, where ?? undefined);
    });
  }
}
