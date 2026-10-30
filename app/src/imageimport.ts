// ネーム画像を取り込む: a picture with all the pages of a name on it (a
// ミニネーム, a name sheet written out from CSP, thumbnails drawn on paper and
// scanned) cut into its pages and laid on the name's pages, one picture of
// the name each. The pages are found by minisplit.ts; this dialog shows what
// was found, numbered in reading order, to check before taking it in. A
// page found by mistake is left out with a click on it; one cut a little off
// (a frame drawn short, uneven margins) is put right by dragging its edges or
// corners, or moved by dragging its inside.
import { $ } from "./dom";
import { logError } from "./errorlog";
import type { Binding, PageFormat, Project, StoredImage } from "./model";
import {
  dragCell,
  fitAspect,
  findPages,
  gridPages,
  gripAt,
  gripCursor,
  guessOrder,
  orderCells,
  paperOf,
  placeOnPage,
  skewOf,
  turnGray,
  type FoundPages,
  type Gray,
  type Grip,
  type ImportFit,
  type PxBox,
  type ReadingOrder,
} from "./minisplit";
import { MAX_NAME_PICTURE_PX, placeNamePictures } from "./references";
import { grayOf } from "./pictures";
import { defaultPageFormat } from "./project";

export interface ImageImportHost {
  /** The open name, or null on the start screen (the picture makes a new name). */
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** A new name of `pages` pages for the picture, with this computer's defaults for new names. */
  newName(title: string, pages: number, binding: Binding): Project;
  /** The new name made from the picture, to open. */
  opened(project: Project, message: string): void;
  /** Pictures were laid on the open name from page `first` (1-based). */
  done(first: number, message: string): void;
  status(message: string): void;
}

/** The picture is looked at no larger than this (px on the long side) to find the pages. */
const LOOK_PX = 2400;
/** How near an edge of a page on the preview (px on screen) takes hold of it. */
const GRIP_PX = 6;
/** A drag shorter than this (px on screen) is a click. */
const DRAG_PX = 3;

const ORDER_LABELS: Record<ReadingOrder, string> = {
  rtl: "右上から左へ、段ごとに下へ（右綴じ）",
  ltr: "左上から右へ、段ごとに下へ（左綴じ）",
  "blocks-rtl": "右のかたまりから（かたまりの中は右上から左へ）",
  "blocks-ltr": "左のかたまりから（かたまりの中は左上から右へ）",
};

const FIT_LABELS: Record<ImportFit, string> = {
  inner: "内側の枠をネームの基本枠に（ネーム用紙）",
  trim: "ページの枠を仕上がり枠に",
  canvas: "ページの枠を用紙全体（キャンバス）に",
  basic: "ページの枠を基本枠に",
};

export class ImageImportDialog {
  private picture: ImageBitmap | null = null;
  private fileName = "";
  /** px of the picture looked at per px of the picture. */
  private lookScale = 1;
  /** How far the picture is tilted clockwise (degrees); the pages are found and cut out of it turned straight. */
  private skew = 0;
  private found: FoundPages | null = null;
  private gray: Gray | null = null;
  /** The pages in reading order (all of them, left out or not). */
  private cells: PxBox[] = [];
  /** Pages left out with a click (by their box). */
  private skipped = new Set<PxBox>();
  /** Where each page is drawn on the preview, for clicks. */
  private shown: { cell: PxBox; box: [number, number, number, number] }[] = [];
  /** Pages whose box was dragged to fit (by their box, changed in place). */
  private adjusted = new Set<PxBox>();
  /** px of the picture looked at per px on the preview. */
  private lookPerScreen = 1;
  /** A page's box being dragged: which, by what, from where. */
  private drag: { cell: PxBox; grip: Grip; from: PxBox; x: number; y: number; moved: boolean } | null = null;
  /** The click that ends a drag is not one that leaves the page out. */
  private dragged = false;
  private busy = false;

  constructor(private readonly host: ImageImportHost) {
    const input = $<HTMLInputElement>("ii-input");
    $("ii-pick").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) void this.read(file);
    });
    for (const id of ["ii-split", "ii-rows", "ii-columns"]) $(id).addEventListener("change", () => this.find());
    $("ii-order").addEventListener("change", () => this.arrange());
    for (const id of ["ii-fit", "ii-start"]) $(id).addEventListener("change", () => this.render());
    // A new name's binding: the reading order follows it.
    $("ii-binding").addEventListener("change", () => {
      if (this.found) $<HTMLSelectElement>("ii-order").value = guessOrder(this.found.cells, this.rightToLeft());
      this.arrange();
    });
    const preview = $<HTMLCanvasElement>("ii-preview");
    preview.addEventListener("click", (event) => {
      if (this.dragged) this.dragged = false;
      else this.toggleAt(event);
    });
    preview.addEventListener("pointerdown", (event) => this.grab(event));
    preview.addEventListener("pointermove", (event) => this.dragTo(event));
    preview.addEventListener("pointerup", () => this.letGo());
    preview.addEventListener("pointercancel", () => this.letGo());
    $("ii-run").addEventListener("click", () => void this.run());
    $<HTMLSelectElement>("ii-order").replaceChildren(...Object.entries(ORDER_LABELS).map(([value, label]) => new Option(label, value)));
    $<HTMLDialogElement>("image-import-dialog").addEventListener("close", () => this.forget());
  }

  /** Opens the dialog: into the open name, or (none open) to make a new one; the file is chosen first. */
  open(): void {
    const project = this.host.project();
    $("ii-title").textContent = project ? "ネーム画像を取り込む" : "ネーム画像から新しいネームを作る";
    for (const id of ["ii-into", "ii-into-row"]) $(id).hidden = !project;
    for (const id of ["ii-new", "ii-binding"]) $(id).hidden = !!project;
    $<HTMLInputElement>("ii-start").value = "1";
    $<HTMLSelectElement>("ii-binding").value = "right";
    this.message("");
    this.render();
    $<HTMLDialogElement>("image-import-dialog").showModal();
    if (!this.picture) $("ii-pick").click();
  }

  /** A picture file dropped or chosen elsewhere, taken in with the dialog. */
  async openWith(file: File): Promise<void> {
    this.open();
    await this.read(file);
  }

  private forget(): void {
    this.picture?.close();
    this.picture = null;
    this.gray = null;
    this.found = null;
    this.cells = [];
    this.skipped.clear();
    this.adjusted.clear();
    this.fileName = "";
  }

  private message(text: string, error = false): void {
    const node = $("ii-message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }

  private async read(file: File): Promise<void> {
    this.message("画像を読んでいます…");
    try {
      const picture = await createImageBitmap(file);
      this.forget();
      this.picture = picture;
      this.fileName = file.name.replace(/\.[^.]+$/, "");
      this.lookScale = Math.min(1, LOOK_PX / Math.max(picture.width, picture.height));
      const gray = grayOf(picture, this.lookScale);
      this.skew = skewOf(gray);
      this.gray = this.skew ? turnGray(gray, -this.skew, paperOf(gray).paper) : gray;
      $("ii-file").textContent = file.name;
      $("ii-file").title = file.name;
      $<HTMLSelectElement>("ii-split").value = "auto";
      this.message("");
      this.find(true);
    } catch (error) {
      this.message(`画像を読めませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
      logError(error);
    }
  }

  /** The format the pages are laid on: the open name's, or a new name's. */
  private format() {
    return this.host.project()?.pageFormat ?? defaultPageFormat();
  }

  private rightToLeft(): boolean {
    const project = this.host.project();
    return project ? project.binding === "right" : $<HTMLSelectElement>("ii-binding").value !== "left";
  }

  /** Find the pages again (a new picture, or another way to cut it); `fresh`: choose the order and fit for it. */
  private find(fresh = false): void {
    if (!this.gray) return this.render();
    const grid = $<HTMLSelectElement>("ii-split").value === "grid";
    if (grid) {
      const rows = Math.max(1, Math.min(40, Number($<HTMLInputElement>("ii-rows").value) || 1));
      const columns = Math.max(1, Math.min(40, Number($<HTMLInputElement>("ii-columns").value) || 1));
      this.found = { cells: gridPages(this.gray, rows, columns), inner: null, paper: 255, tolerance: 0 };
    } else {
      this.found = findPages(this.gray, fitAspect(this.format(), "trim"));
    }
    this.skipped.clear();
    this.adjusted.clear();
    if (fresh || grid) {
      $<HTMLSelectElement>("ii-order").value = grid ? (this.rightToLeft() ? "rtl" : "ltr") : guessOrder(this.found.cells, this.rightToLeft());
    }
    if (fresh) {
      $<HTMLSelectElement>("ii-fit").value = this.found.inner ? "inner" : "trim";
      // A picture with no page found: an even grid to start from.
      if (!grid && !this.found.cells.length) {
        $<HTMLSelectElement>("ii-split").value = "grid";
        return this.find();
      }
    }
    this.arrange();
  }

  private arrange(): void {
    this.cells = this.found ? orderCells(this.found.cells, $<HTMLSelectElement>("ii-order").value as ReadingOrder) : [];
    this.render();
  }

  private taken(): PxBox[] {
    return this.cells.filter((cell) => !this.skipped.has(cell));
  }

  private fit(): ImportFit {
    const fit = $<HTMLSelectElement>("ii-fit").value as ImportFit;
    return fit === "inner" && !this.found?.inner ? "trim" : fit;
  }

  /** The preview with the pages numbered, the fields that apply and what 取り込む will do. */
  private render(): void {
    const grid = $<HTMLSelectElement>("ii-split").value === "grid";
    for (const id of ["ii-grid-label", "ii-grid"]) $(id).hidden = !grid;
    const fit = $<HTMLSelectElement>("ii-fit");
    const inner = !!this.found?.inner;
    fit.replaceChildren(...(Object.keys(FIT_LABELS) as ImportFit[]).filter((value) => value !== "inner" || inner).map((value) => new Option(FIT_LABELS[value], value)));
    fit.value = this.fit();
    this.drawPreview();
    const taken = this.taken();
    const run = $<HTMLButtonElement>("ii-run");
    run.disabled = this.busy || !taken.length;
    const project = this.host.project();
    if (!this.picture) {
      $("ii-summary").textContent = "画像を選んでください（PNG・JPEG など）";
      return;
    }
    const changes = [this.skipped.size ? `${this.skipped.size} 枚は外した` : "", this.adjusted.size ? `${this.adjusted.size} 枚は範囲を直した` : ""].filter(Boolean);
    const left = changes.length ? `（${changes.join("・")}）` : "";
    const tilt = this.skew ? `画像が ${Math.abs(this.skew).toFixed(2)}° 傾いていたので、まっすぐに直して切り分けます。` : "";
    const found = `${taken.length} ページ見つけました${left}。${tilt}`;
    if (project) {
      const start = this.start();
      const last = start + taken.length - 1;
      const more = Math.max(0, last - project.pages.length);
      $("ii-summary").textContent =
        `${found}${start}〜${last} ページに置きます${more ? `（足りない ${more} ページを足す）` : ""}。前に取り込んだネーム画像は置き換え、描いたもの・資料画像はそのままです。` +
        "違うところで分かれていたら、分け方・読む順を変えるか、余分なページを押して外してください。枠がずれたページは、辺・角のドラッグで範囲を、中のドラッグで位置を直せます。";
    } else {
      $("ii-summary").textContent = `${found}${taken.length} ページの新しいネーム「${this.fileName || "ネーム"}」を作ります。違うところで分かれていたら、分け方・読む順を変えるか、余分なページを押して外してください。枠がずれたページは、辺・角のドラッグで範囲を、中のドラッグで位置を直せます。`;
    }
  }

  private start(): number {
    return Math.max(1, Math.round(Number($<HTMLInputElement>("ii-start").value) || 1));
  }

  private drawPreview(): void {
    const canvas = $<HTMLCanvasElement>("ii-preview");
    const ctx = canvas.getContext("2d")!;
    const ratio = window.devicePixelRatio || 1;
    const room = { width: canvas.clientWidth || 720, height: canvas.clientHeight || 380 };
    canvas.width = Math.round(room.width * ratio);
    canvas.height = Math.round(room.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, room.width, room.height);
    this.shown = [];
    if (!this.picture) return;
    const scale = Math.min(room.width / this.picture.width, room.height / this.picture.height);
    this.lookPerScreen = this.lookScale / scale;
    const left = (room.width - this.picture.width * scale) / 2;
    const top = (room.height - this.picture.height * scale) / 2;
    ctx.save();
    this.straighten(ctx, left + (this.picture.width * scale) / 2, top + (this.picture.height * scale) / 2);
    ctx.drawImage(this.picture, left, top, this.picture.width * scale, this.picture.height * scale);
    ctx.restore();
    const at = (value: number) => (value / this.lookScale) * scale;
    let number = this.host.project() ? this.start() : 1;
    for (const cell of this.cells) {
      const box: [number, number, number, number] = [left + at(cell[0]), top + at(cell[1]), left + at(cell[2]), top + at(cell[3])];
      this.shown.push({ cell, box });
      const skipped = this.skipped.has(cell);
      const [x0, y0, x1, y1] = box;
      ctx.fillStyle = skipped ? "rgba(80, 80, 80, 0.55)" : "rgba(47, 111, 219, 0.10)";
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = skipped ? "#777777" : "#2f6fdb";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.75, y0 + 0.75, x1 - x0 - 1.5, y1 - y0 - 1.5);
      // The corners to drag, as small squares (filled where the box was put right by hand).
      ctx.fillStyle = this.adjusted.has(cell) ? ctx.strokeStyle : "#ffffff";
      for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      }
      if (!skipped && this.found?.inner && this.fit() === "inner") {
        const [l, t, r, b] = this.found.inner;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(47, 111, 219, 0.7)";
        ctx.strokeRect(x0 + (x1 - x0) * l, y0 + (y1 - y0) * t, (x1 - x0) * (r - l), (y1 - y0) * (b - t));
        ctx.setLineDash([]);
      }
      const size = Math.max(10, Math.min(22, (x1 - x0) * 0.32));
      ctx.font = `bold ${size}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = skipped ? "×" : String(number++);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(label, (x0 + x1) / 2, (y0 + y1) / 2);
      ctx.fillStyle = skipped ? "#444444" : "#1f4fa8";
      ctx.fillText(label, (x0 + x1) / 2, (y0 + y1) / 2);
    }
  }

  /** Where the pointer is on the preview (px on screen). */
  private pointAt(event: PointerEvent | MouseEvent): [number, number] {
    const rect = $<HTMLCanvasElement>("ii-preview").getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  /** What the pointer would take hold of: an edge or corner of any page first, else the page it is in. */
  private gripUnder(x: number, y: number): { cell: PxBox; grip: Grip } | null {
    let inside: { cell: PxBox; grip: Grip } | null = null;
    for (const { cell, box } of this.shown) {
      const grip = gripAt(box, x, y, GRIP_PX);
      if (grip && grip !== "move") return { cell, grip };
      if (grip) inside ??= { cell, grip };
    }
    return inside;
  }

  private grab(event: PointerEvent): void {
    this.dragged = false;
    if (event.button !== 0 || this.busy) return;
    const [x, y] = this.pointAt(event);
    const under = this.gripUnder(x, y);
    if (!under) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.drag = { ...under, from: [...under.cell], x, y, moved: false };
  }

  /** Dragging: the page's box follows; not dragging: the pointer shows what a drag would do. */
  private dragTo(event: PointerEvent): void {
    const [x, y] = this.pointAt(event);
    const canvas = event.currentTarget as HTMLElement;
    if (!this.drag) {
      canvas.style.cursor = gripCursor(this.gripUnder(x, y)?.grip ?? null);
      return;
    }
    const drag = this.drag;
    if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < DRAG_PX) return;
    drag.moved = true;
    const k = this.lookPerScreen;
    const size: [number, number] = [this.picture!.width * this.lookScale, this.picture!.height * this.lookScale];
    // The box is changed in place: it stays the same page in the order and among the ones left out.
    drag.cell.splice(0, 4, ...dragCell(drag.from, drag.grip, (x - drag.x) * k, (y - drag.y) * k, size, 8));
    this.adjusted.add(drag.cell);
    this.drawPreview();
  }

  private letGo(): void {
    if (!this.drag) return;
    this.dragged = this.drag.moved;
    this.drag = null;
    if (this.dragged) this.render();
  }

  /** A click on a page of the preview leaves it out (or takes it back). */
  private toggleAt(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
    const hit = this.shown.find(({ box }) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
    if (!hit) return;
    if (this.skipped.has(hit.cell)) this.skipped.delete(hit.cell);
    else this.skipped.add(hit.cell);
    this.render();
  }

  /** Turns what is drawn next straight about (x, y), when the picture is tilted. */
  private straighten(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    if (!this.skew) return;
    ctx.translate(x, y);
    ctx.rotate((-this.skew * Math.PI) / 180);
    ctx.translate(-x, -y);
  }

  /** Each page cut out of the full picture (turned straight), made no larger than MAX_NAME_PICTURE_PX. */
  private async cut(cell: PxBox, index: number): Promise<StoredImage> {
    const picture = this.picture!;
    const [x0, y0, x1, y1] = cell.map((value) => value / this.lookScale);
    // A tilted picture's page may reach past its edge once turned; the paper fills in.
    const sx = this.skew ? Math.floor(x0) : Math.max(0, Math.floor(x0));
    const sy = this.skew ? Math.floor(y0) : Math.max(0, Math.floor(y0));
    const sw = Math.max(1, (this.skew ? Math.ceil(x1) : Math.min(picture.width, Math.ceil(x1))) - sx);
    const sh = Math.max(1, (this.skew ? Math.ceil(y1) : Math.min(picture.height, Math.ceil(y1))) - sy);
    const scale = Math.min(1, MAX_NAME_PICTURE_PX / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    if (this.skew) {
      ctx.setTransform(scale, 0, 0, scale, -sx * scale, -sy * scale);
      this.straighten(ctx, picture.width / 2, picture.height / 2);
      ctx.drawImage(picture, 0, 0);
    } else {
      ctx.drawImage(picture, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    const { width, height } = canvas;
    canvas.width = 0;
    if (!blob) throw new Error("ページの画像を作れませんでした");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { id: "", name: `${this.fileName} ${index + 1}`, mime: "image/jpeg", dataBase64: btoa(binary), widthPx: width, heightPx: height };
  }

  private async run(): Promise<void> {
    const taken = this.taken();
    if (!this.picture || !taken.length || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const fit = this.fit();
      const inner = fit === "inner" ? this.found?.inner ?? null : null;
      const images: StoredImage[] = [];
      for (const [index, cell] of taken.entries()) {
        this.message(`ページを切り出しています… ${index + 1} / ${taken.length}`);
        images.push(await this.cut(cell, index));
      }
      const laid = (format: PageFormat) => images.map((image) => ({ image, box: placeOnPage(format, fit, image.widthPx, image.heightPx, inner) }));
      const project = this.host.project();
      $<HTMLDialogElement>("image-import-dialog").close();
      const how = `（${FIT_LABELS[fit]}）`;
      if (project) {
        const first = this.start();
        let added = 0;
        this.host.edit((p) => {
          added = placeNamePictures(p, first - 1, laid(p.pageFormat));
        });
        const more = added ? `、ページを ${added} 枚足しました` : "";
        this.host.done(first, `ネーム画像を ${first}〜${first + images.length - 1} ページに取り込みました${how}${more}。資料ツール（I）で動かす・濃さを変えられます。元に戻すは Ctrl+Z`);
      } else {
        const title = this.fileName || "ネーム";
        const binding: Binding = $<HTMLSelectElement>("ii-binding").value === "left" ? "left" : "right";
        const made = this.host.newName(title, images.length, binding);
        placeNamePictures(made, 0, laid(made.pageFormat));
        this.host.opened(made, `ネーム画像から ${images.length} ページのネーム「${title}」を作りました${how}。資料ツール（I）で動かす・濃さを変えられます`);
      }
    } catch (error) {
      this.message(`取り込めませんでした: ${error instanceof Error ? error.message : String(error)}`, true);
      logError(error);
    } finally {
      this.busy = false;
      if ($<HTMLDialogElement>("image-import-dialog").open) this.render();
    }
  }
}
