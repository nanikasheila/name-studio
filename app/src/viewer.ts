// The sheet viewer: a CLIP STUDIO PAINT name sheet (.clip) looked at whole or
// spread by spread, its layers shown or hidden and its dialogue read page by
// page, before it is written out (sheetexport.ts) or taken in as name data.
import { call } from "./backend";
import { $ } from "./dom";
import { dialogueByPage, effectiveVisibility, initiallyHidden, spreads } from "./pages";
import { drawSheet, type PlacedImage, type Transform } from "./render";
import type { LayerView, PageCell, SheetView } from "./types";

const OVERVIEW_MAX_WIDTH = 4096;
const MARGIN = 24;

const KIND_LABELS: Record<string, string> = {
  raster: "ラスター", vector: "ベクター", text: "テキスト", folder: "フォルダー", frame_folder: "コマ枠",
  paper: "用紙", story_info: "作品情報", other: "その他",
};

async function pngToImage(bytes: ArrayBuffer): Promise<ImageBitmap | null> {
  if (bytes.byteLength === 0) return null;
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

export class SheetViewer {
  private readonly canvas = $<HTMLCanvasElement>("canvas");
  private readonly ctx = this.canvas.getContext("2d")!;
  private sheetView: SheetView | null = null;
  private path = "";
  private hidden = new Set<number>();
  private mode: "sheet" | "spread" = "sheet";
  private spreadIndex = 0;
  private firstAlone = true;
  private view: Transform | null = null;
  private overviewFactor = 1;
  private overview = new Map<number, PlacedImage>();
  /** Full-resolution crops per `${layerId}:${pageIndex}`. */
  private regions = new Map<string, PlacedImage | "loading">();
  private drag: { x: number; y: number } | null = null;

  constructor(private readonly setStatus: (message: string) => void) {
    this.wireCanvas();
    $("mode-sheet").addEventListener("click", () => {
      this.view = null;
      this.setMode("sheet");
    });
    $("mode-spread").addEventListener("click", () => this.setMode("spread"));
    $("next").addEventListener("click", () => this.flip(1));
    $("prev").addEventListener("click", () => this.flip(-1));
    $<HTMLInputElement>("first-alone").addEventListener("change", (event) => {
      this.firstAlone = (event.target as HTMLInputElement).checked;
      this.spreadIndex = 0;
      this.draw();
    });
    $("tab-layers").addEventListener("click", () => this.selectTab("layers"));
    $("tab-lines").addEventListener("click", () => this.selectTab("lines"));
    this.resize();
  }

  /** The sheet open now, if any. */
  get sheet(): SheetView | null {
    return this.sheetView;
  }

  /** Where the open sheet is ("" when none is). */
  get sheetPath(): string {
    return this.path;
  }

  async open(path: string): Promise<void> {
    this.setStatus("読み込み中…");
    try {
      const started = performance.now();
      const sheet = await call("open_sheet", { path });
      this.sheetView = sheet;
      this.path = path;
      this.hidden = initiallyHidden(sheet.layers);
      this.overview = new Map();
      this.regions = new Map();
      this.spreadIndex = 0;
      this.view = null;
      // A power of two: the overview halves the stored blocks (1/2, 1/4, ...).
      this.overviewFactor = 2 ** Math.ceil(Math.log2(Math.max(1, sheet.canvas.widthPx / OVERVIEW_MAX_WIDTH)));
      $("file-name").textContent = sheet.fileName;
      $("empty").hidden = true;
      // The start screen gives way to the sheet and its layer list.
      $("viewer").classList.remove("start");
      this.resize();
      for (const id of ["mode-sheet", "mode-spread", "next", "prev", "export", "import-project"]) {
        $<HTMLButtonElement>(id).disabled = false;
      }
      this.renderPanels();
      this.draw();
      await this.loadOverview(sheet);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const warnings = sheet.warnings.length ? ` ／ ${sheet.warnings.join(" ／ ")}` : "";
      this.setStatus(`${sheet.cells.length} ページ、レイヤー ${sheet.layers.length} 枚（${seconds} 秒）${warnings}`);
    } catch (error) {
      this.setStatus(`開けませんでした: ${error}`);
    }
  }

  /** The viewer's keys: ← → turn the spreads (right-bound: the next page is to the left), Esc shows the whole sheet. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.sheetView) return false;
    if (event.key === "ArrowLeft") this.flip(1);
    else if (event.key === "ArrowRight") this.flip(-1);
    else if (event.key === "Escape") this.setMode("sheet");
    else return false;
    return true;
  }

  /** After the window or the stage changed size. */
  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (this.mode === "sheet") this.view = null;
    this.draw();
  }

  draw(): void {
    const { width, height } = this.stageSize();
    this.ctx.clearRect(0, 0, width, height);
    const sheet = this.sheetView;
    if (!sheet) return;
    const visible = effectiveVisibility(sheet.layers, this.hidden);
    if (this.mode === "sheet") this.drawOverview(sheet, visible);
    else this.drawSpread(sheet, visible);
    this.updatePager();
  }

  private async loadOverview(sheet: SheetView): Promise<void> {
    const factor = this.overviewFactor;
    await Promise.all(
      sheet.layers
        .filter((layer) => layer.hasPixels)
        .map(async (layer) => {
          const bytes = await call("layer_overview", { layerId: layer.id, factor });
          const image = await pngToImage(bytes);
          if (!image || this.sheetView !== sheet) return;
          const [x, y] = layer.pixelOrigin;
          const [width, height] = layer.pixelSize ?? [image.width * factor, image.height * factor];
          this.overview.set(layer.id, {
            image,
            box: { x0: x, y0: y, x1: x + width, y1: y + height },
          });
          this.draw();
        }),
    );
  }

  private requestRegion(layer: LayerView, cell: PageCell): void {
    const key = `${layer.id}:${cell.index}`;
    if (this.regions.has(key)) return;
    this.regions.set(key, "loading");
    const box = cell.rect;
    const region = [Math.floor(box.x0), Math.floor(box.y0), Math.ceil(box.x1), Math.ceil(box.y1)];
    const sheet = this.sheetView;
    call("layer_region", { layerId: layer.id, region })
      .then(pngToImage)
      .then((image) => {
        if (!image || this.sheetView !== sheet) return;
        const [x0, y0, x1, y1] = region;
        this.regions.set(key, { image, box: { x0, y0, x1, y1 } });
        this.draw();
      })
      .catch((error) => this.setStatus(`画像を読めませんでした: ${error}`));
  }

  private stageSize(): { width: number; height: number } {
    const { width, height } = this.canvas.getBoundingClientRect();
    return { width, height };
  }

  private fitSheet(sheet: SheetView): Transform {
    const { width, height } = this.stageSize();
    const scale = Math.min((width - 2 * MARGIN) / sheet.canvas.widthPx, (height - 2 * MARGIN) / sheet.canvas.heightPx);
    return {
      scale,
      offsetX: (width - sheet.canvas.widthPx * scale) / 2,
      offsetY: (height - sheet.canvas.heightPx * scale) / 2,
    };
  }

  private currentSpreads(): [number | null, number | null][] {
    return spreads(this.sheetView?.cells.length ?? 0, this.firstAlone);
  }

  private drawOverview(sheet: SheetView, visible: Map<number, boolean>): void {
    const ctx = this.ctx;
    this.view ??= this.fitSheet(sheet);
    const t = this.view;
    drawSheet(ctx, sheet, visible, (layer) => {
      const placed = this.overview.get(layer.id);
      return placed ? [placed] : [];
    }, t);
    ctx.save();
    ctx.font = "bold 13px sans-serif";
    for (const cell of sheet.cells) {
      const x = cell.rect.x0 * t.scale + t.offsetX;
      const y = cell.rect.y0 * t.scale + t.offsetY;
      ctx.strokeStyle = "rgba(47, 111, 219, 0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, (cell.rect.x1 - cell.rect.x0) * t.scale, (cell.rect.y1 - cell.rect.y0) * t.scale);
      ctx.fillStyle = "rgba(47, 111, 219, 0.9)";
      ctx.fillText(String(cell.index), x + 4, y + 15);
    }
    ctx.restore();
  }

  private drawSpread(sheet: SheetView, visible: Map<number, boolean>): void {
    const ctx = this.ctx;
    const pair = this.currentSpreads()[this.spreadIndex];
    if (!pair) return;
    const [rightPage, leftPage] = pair;
    const cellOf = (page: number | null) => (page === null ? null : sheet.cells[page - 1] ?? null);
    const right = cellOf(rightPage);
    const left = cellOf(leftPage);
    const sample = right ?? left;
    if (!sample) return;
    const { width, height } = this.stageSize();
    const cellW = sample.rect.x1 - sample.rect.x0;
    const cellH = sample.rect.y1 - sample.rect.y0;
    const scale = Math.min((width - 3 * MARGIN) / (2 * cellW), (height - 2 * MARGIN - 20) / cellH);
    const pageW = cellW * scale;
    const top = (height - cellH * scale - 20) / 2;
    const leftX = (width - 2 * pageW) / 2;
    const slots: [PageCell | null, number][] = [
      [left, leftX],
      [right, leftX + pageW],
    ];
    for (const [cell, x] of slots) {
      if (!cell) continue;
      const t: Transform = { scale, offsetX: x - cell.rect.x0 * scale, offsetY: top - cell.rect.y0 * scale };
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, top, pageW, cellH * scale);
      ctx.clip();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      drawSheet(ctx, sheet, visible, (layer) => {
        if (!layer.hasPixels) return [];
        this.requestRegion(layer, cell);
        const region = this.regions.get(`${layer.id}:${cell.index}`);
        if (region && region !== "loading") return [region];
        const overview = this.overview.get(layer.id);
        return overview ? [overview] : [];
      }, t);
      ctx.restore();
      ctx.fillStyle = "#f4f3f0";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${cell.index}`, x + pageW / 2, top + cellH * scale + 16);
    }
    // Gutter between the pages.
    ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
    ctx.beginPath();
    ctx.moveTo(leftX + pageW, top);
    ctx.lineTo(leftX + pageW, top + cellH * scale);
    ctx.stroke();
  }

  private updatePager(): void {
    const all = this.currentSpreads();
    const label = $("page-label");
    if (this.mode === "sheet" || !all.length) {
      label.textContent = this.sheetView ? `全 ${this.sheetView.cells.length} ページ` : "-";
      return;
    }
    const pages = all[this.spreadIndex].filter((page): page is number => page !== null).sort((a, b) => a - b);
    label.textContent = `${pages.join("–")} / ${this.sheetView!.cells.length}`;
  }

  private setMode(mode: "sheet" | "spread"): void {
    this.mode = mode;
    $("mode-sheet").classList.toggle("active", mode === "sheet");
    $("mode-spread").classList.toggle("active", mode === "spread");
    this.draw();
  }

  private showPage(page: number): void {
    const index = this.currentSpreads().findIndex((pair) => pair.includes(page));
    if (index >= 0) this.spreadIndex = index;
    this.setMode("spread");
  }

  private flip(step: number): void {
    if (this.mode === "sheet") this.setMode("spread");
    const count = this.currentSpreads().length;
    this.spreadIndex = Math.min(Math.max(this.spreadIndex + step, 0), Math.max(count - 1, 0));
    this.draw();
  }

  private renderPanels(): void {
    const sheet = this.sheetView;
    if (!sheet) return;
    const visible = effectiveVisibility(sheet.layers, this.hidden);
    $("panel-layers").replaceChildren(
      ...[...sheet.layers].reverse().map((layer) => {
        const row = document.createElement("label");
        row.className = `layer${visible.get(layer.id) ? "" : " dim"}`;
        row.style.paddingLeft = `${10 + layer.depth * 14}px`;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !this.hidden.has(layer.id);
        box.addEventListener("change", () => {
          if (box.checked) this.hidden.delete(layer.id);
          else this.hidden.add(layer.id);
          this.renderPanels();
          this.draw();
        });
        const name = document.createElement("span");
        name.textContent = layer.name || "(名前なし)";
        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = KIND_LABELS[layer.kind] ?? layer.kind;
        row.append(box, name, kind);
        return row;
      }),
    );
    const pages = dialogueByPage(sheet, visible);
    $("panel-lines").replaceChildren(
      ...pages.map((lines, index) => {
        const block = document.createElement("div");
        block.className = "page-lines";
        const title = document.createElement("h3");
        title.textContent = `${index + 1} ページ`;
        block.append(title);
        if (!lines.length) {
          const none = document.createElement("div");
          none.className = "none";
          none.textContent = "セリフなし";
          block.append(none);
        }
        for (const line of lines) {
          const p = document.createElement("p");
          p.textContent = line.text.replace(/\s+/g, " ");
          p.title = line.layerName;
          block.append(p);
        }
        block.addEventListener("click", () => this.showPage(index + 1));
        return block;
      }),
    );
  }

  private selectTab(tab: "layers" | "lines"): void {
    $("tab-layers").classList.toggle("active", tab === "layers");
    $("tab-lines").classList.toggle("active", tab === "lines");
    $("panel-layers").hidden = tab !== "layers";
    $("panel-lines").hidden = tab !== "lines";
  }

  /** Overview: wheel zooms around the pointer, drag pans, double click opens a page. */
  private wireCanvas(): void {
    const canvas = this.canvas;
    canvas.addEventListener("wheel", (event) => {
      if (this.mode !== "sheet" || !this.view) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      const { offsetX, offsetY } = event;
      const view = this.view;
      view.offsetX = offsetX - (offsetX - view.offsetX) * factor;
      view.offsetY = offsetY - (offsetY - view.offsetY) * factor;
      view.scale *= factor;
      this.draw();
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => {
      if (this.mode !== "sheet") return;
      this.drag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || !this.view) return;
      this.view.offsetX += event.clientX - this.drag.x;
      this.view.offsetY += event.clientY - this.drag.y;
      this.drag = { x: event.clientX, y: event.clientY };
      this.draw();
    });
    canvas.addEventListener("pointerup", () => (this.drag = null));
    canvas.addEventListener("dblclick", (event) => {
      const sheet = this.sheetView;
      if (!sheet || !this.view || this.mode !== "sheet") return;
      const x = (event.offsetX - this.view.offsetX) / this.view.scale;
      const y = (event.offsetY - this.view.offsetY) / this.view.scale;
      const cell = sheet.cells.find((c) => c.rect.x0 <= x && x <= c.rect.x1 && c.rect.y0 <= y && y <= c.rect.y1);
      if (cell) this.showPage(cell.index);
    });
  }
}
