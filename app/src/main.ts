// Name Studio front end: open a name sheet and look at it whole or spread by
// spread, or edit name data (see workbench.ts).
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { formatTime } from "./autosave";
import { batchExportTask, runBatchExport } from "./batch";
import { appVersion, checkForUpdate } from "./updater";
import { buildRequest, folderOf, summarize, type ExportForm, type ExportReport, type Fit } from "./export";
import { dialogueByPage, effectiveVisibility, initiallyHidden, spreads } from "./pages";
import { drawSheet, type PlacedImage, type Transform } from "./render";
import { newProject, type Project } from "./project";
import type { LayerView, PageCell, SheetView } from "./types";
import { PROJECT_EXTENSION, Workbench } from "./workbench";

const OVERVIEW_MAX_WIDTH = 4096;
const MARGIN = 24;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d")!;

interface State {
  sheet: SheetView | null;
  sheetPath: string;
  hidden: Set<number>;
  mode: "sheet" | "spread";
  spreadIndex: number;
  firstAlone: boolean;
  view: Transform | null;
  overviewFactor: number;
  overview: Map<number, PlacedImage>;
  /** Full-resolution crops per `${layerId}:${pageIndex}`. */
  regions: Map<string, PlacedImage | "loading">;
}

const state: State = {
  sheet: null,
  sheetPath: "",
  hidden: new Set(),
  mode: "sheet",
  spreadIndex: 0,
  firstAlone: true,
  view: null,
  overviewFactor: 1,
  overview: new Map(),
  regions: new Map(),
};

function setStatus(message: string): void {
  $("status").textContent = message;
}

async function pngToImage(bytes: ArrayBuffer): Promise<ImageBitmap | null> {
  if (bytes.byteLength === 0) return null;
  return createImageBitmap(new Blob([bytes], { type: "image/png" }));
}

async function openFile(): Promise<void> {
  if (!(await workbench.confirmDiscard())) return;
  const path = await open({
    multiple: false,
    filters: [
      { name: "ネームデータとネーム用紙", extensions: [PROJECT_EXTENSION, "clip"] },
      { name: "ネームデータ", extensions: [PROJECT_EXTENSION] },
      { name: "CLIP STUDIO PAINT のネーム用紙", extensions: ["clip"] },
    ],
  });
  if (typeof path !== "string") return;
  if (path.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`)) {
    try {
      await workbench.load(path);
      showWorkspace("editor");
    } catch (error) {
      setStatus(`開けませんでした: ${error}`);
    }
    return;
  }
  await openSheet(path);
}

async function openSheet(path: string): Promise<void> {
  showWorkspace("viewer");
  setStatus("読み込み中…");
  try {
    const started = performance.now();
    const sheet = await invoke<SheetView>("open_sheet", { path });
    state.sheet = sheet;
    state.sheetPath = path;
    state.hidden = initiallyHidden(sheet.layers);
    state.overview = new Map();
    state.regions = new Map();
    state.spreadIndex = 0;
    state.view = null;
    state.overviewFactor = Math.max(1, Math.ceil(sheet.canvas.widthPx / OVERVIEW_MAX_WIDTH));
    $("file-name").textContent = sheet.fileName;
    $("empty").hidden = true;
    for (const id of ["mode-sheet", "mode-spread", "next", "prev", "export", "import-project"]) {
      $<HTMLButtonElement>(id).disabled = false;
    }
    renderPanels();
    draw();
    await loadOverview(sheet);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const warnings = sheet.warnings.length ? ` ／ ${sheet.warnings.join(" ／ ")}` : "";
    setStatus(`${sheet.cells.length} ページ、レイヤー ${sheet.layers.length} 枚（${seconds} 秒）${warnings}`);
  } catch (error) {
    setStatus(`開けませんでした: ${error}`);
  }
}

async function loadOverview(sheet: SheetView): Promise<void> {
  const factor = state.overviewFactor;
  await Promise.all(
    sheet.layers
      .filter((layer) => layer.hasPixels)
      .map(async (layer) => {
        const bytes = await invoke<ArrayBuffer>("layer_overview", { layerId: layer.id, factor });
        const image = await pngToImage(bytes);
        if (!image || state.sheet !== sheet) return;
        const [x, y] = layer.pixelOrigin;
        state.overview.set(layer.id, {
          image,
          box: { x0: x, y0: y, x1: x + image.width * factor, y1: y + image.height * factor },
        });
        draw();
      }),
  );
}

function requestRegion(layer: LayerView, cell: PageCell): void {
  const key = `${layer.id}:${cell.index}`;
  if (state.regions.has(key)) return;
  state.regions.set(key, "loading");
  const box = cell.rect;
  const region = [Math.floor(box.x0), Math.floor(box.y0), Math.ceil(box.x1), Math.ceil(box.y1)];
  const sheet = state.sheet;
  invoke<ArrayBuffer>("layer_region", { layerId: layer.id, region })
    .then(pngToImage)
    .then((image) => {
      if (!image || state.sheet !== sheet) return;
      const [x0, y0, x1, y1] = region;
      state.regions.set(key, { image, box: { x0, y0, x1, y1 } });
      draw();
    })
    .catch((error) => setStatus(`画像を読めませんでした: ${error}`));
}

function resizeCanvas(): void {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function stageSize(): { width: number; height: number } {
  const { width, height } = canvas.getBoundingClientRect();
  return { width, height };
}

function fitSheet(sheet: SheetView): Transform {
  const { width, height } = stageSize();
  const scale = Math.min((width - 2 * MARGIN) / sheet.canvas.widthPx, (height - 2 * MARGIN) / sheet.canvas.heightPx);
  return {
    scale,
    offsetX: (width - sheet.canvas.widthPx * scale) / 2,
    offsetY: (height - sheet.canvas.heightPx * scale) / 2,
  };
}

function currentSpreads(): [number | null, number | null][] {
  return spreads(state.sheet?.cells.length ?? 0, state.firstAlone);
}

function draw(): void {
  const { width, height } = stageSize();
  ctx.clearRect(0, 0, width, height);
  const sheet = state.sheet;
  if (!sheet) return;
  const visible = effectiveVisibility(sheet.layers, state.hidden);
  if (state.mode === "sheet") drawOverview(sheet, visible);
  else drawSpread(sheet, visible);
  updatePager();
}

function drawOverview(sheet: SheetView, visible: Map<number, boolean>): void {
  state.view ??= fitSheet(sheet);
  const t = state.view;
  drawSheet(ctx, sheet, visible, (layer) => {
    const placed = state.overview.get(layer.id);
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

function drawSpread(sheet: SheetView, visible: Map<number, boolean>): void {
  const pair = currentSpreads()[state.spreadIndex];
  if (!pair) return;
  const [rightPage, leftPage] = pair;
  const cellOf = (page: number | null) => (page === null ? null : sheet.cells[page - 1] ?? null);
  const right = cellOf(rightPage);
  const left = cellOf(leftPage);
  const sample = right ?? left;
  if (!sample) return;
  const { width, height } = stageSize();
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
      requestRegion(layer, cell);
      const region = state.regions.get(`${layer.id}:${cell.index}`);
      if (region && region !== "loading") return [region];
      const overview = state.overview.get(layer.id);
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

function updatePager(): void {
  const all = currentSpreads();
  const label = $("page-label");
  if (state.mode === "sheet" || !all.length) {
    label.textContent = state.sheet ? `全 ${state.sheet.cells.length} ページ` : "-";
    return;
  }
  const pages = all[state.spreadIndex].filter((page): page is number => page !== null).sort((a, b) => a - b);
  label.textContent = `${pages.join("–")} / ${state.sheet!.cells.length}`;
}

function setMode(mode: "sheet" | "spread"): void {
  state.mode = mode;
  $("mode-sheet").classList.toggle("active", mode === "sheet");
  $("mode-spread").classList.toggle("active", mode === "spread");
  draw();
}

function showPage(page: number): void {
  const index = currentSpreads().findIndex((pair) => pair.includes(page));
  if (index >= 0) state.spreadIndex = index;
  setMode("spread");
}

function flip(step: number): void {
  if (state.mode === "sheet") setMode("spread");
  const count = currentSpreads().length;
  state.spreadIndex = Math.min(Math.max(state.spreadIndex + step, 0), Math.max(count - 1, 0));
  draw();
}

const KIND_LABELS: Record<string, string> = {
  raster: "ラスター", vector: "ベクター", text: "テキスト", folder: "フォルダー", frame_folder: "コマ枠",
  paper: "用紙", story_info: "作品情報", other: "その他",
};

function renderPanels(): void {
  const sheet = state.sheet;
  if (!sheet) return;
  const visible = effectiveVisibility(sheet.layers, state.hidden);
  const layersPanel = $("panel-layers");
  layersPanel.replaceChildren(
    ...[...sheet.layers].reverse().map((layer) => {
      const row = document.createElement("label");
      row.className = `layer${visible.get(layer.id) ? "" : " dim"}`;
      row.style.paddingLeft = `${10 + layer.depth * 14}px`;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !state.hidden.has(layer.id);
      box.addEventListener("change", () => {
        if (box.checked) state.hidden.delete(layer.id);
        else state.hidden.add(layer.id);
        renderPanels();
        draw();
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
  const linesPanel = $("panel-lines");
  const pages = dialogueByPage(sheet, visible);
  linesPanel.replaceChildren(
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
      block.addEventListener("click", () => showPage(index + 1));
      return block;
    }),
  );
}

function selectTab(tab: "layers" | "lines"): void {
  $("tab-layers").classList.toggle("active", tab === "layers");
  $("tab-lines").classList.toggle("active", tab === "lines");
  $("panel-layers").hidden = tab !== "layers";
  $("panel-lines").hidden = tab !== "lines";
}

// Overview: wheel zooms around the pointer, drag pans, double click opens a page.
canvas.addEventListener("wheel", (event) => {
  if (state.mode !== "sheet" || !state.view) return;
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * 0.0015);
  const { offsetX, offsetY } = event;
  const view = state.view;
  view.offsetX = offsetX - (offsetX - view.offsetX) * factor;
  view.offsetY = offsetY - (offsetY - view.offsetY) * factor;
  view.scale *= factor;
  draw();
}, { passive: false });

let drag: { x: number; y: number } | null = null;
canvas.addEventListener("pointerdown", (event) => {
  if (state.mode !== "sheet") return;
  drag = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag || !state.view) return;
  state.view.offsetX += event.clientX - drag.x;
  state.view.offsetY += event.clientY - drag.y;
  drag = { x: event.clientX, y: event.clientY };
  draw();
});
canvas.addEventListener("pointerup", () => (drag = null));
canvas.addEventListener("dblclick", (event) => {
  const sheet = state.sheet;
  if (!sheet || !state.view || state.mode !== "sheet") return;
  const x = (event.offsetX - state.view.offsetX) / state.view.scale;
  const y = (event.offsetY - state.view.offsetY) / state.view.scale;
  const cell = sheet.cells.find((c) => c.rect.x0 <= x && x <= c.rect.x1 && c.rect.y0 <= y && y <= c.rect.y1);
  if (cell) showPage(cell.index);
});

window.addEventListener("keydown", (event) => {
  if (workspace === "editor") {
    if (workbench.handleKey(event)) event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void openFile();
    return;
  }
  if (!state.sheet) return;
  // Right-bound book: the next page is to the left.
  if (event.key === "ArrowLeft") flip(1);
  if (event.key === "ArrowRight") flip(-1);
  if (event.key === "Escape") setMode("sheet");
});

$("open").addEventListener("click", openFile);
$("mode-sheet").addEventListener("click", () => {
  state.view = null;
  setMode("sheet");
});
$("mode-spread").addEventListener("click", () => setMode("spread"));
$("next").addEventListener("click", () => flip(1));
$("prev").addEventListener("click", () => flip(-1));
$<HTMLInputElement>("first-alone").addEventListener("change", (event) => {
  state.firstAlone = (event.target as HTMLInputElement).checked;
  state.spreadIndex = 0;
  draw();
});
$("tab-layers").addEventListener("click", () => selectTab("layers"));
$("tab-lines").addEventListener("click", () => selectTab("lines"));
window.addEventListener("resize", () => {
  workbench.editor.resize();
  if (workspace === "editor") workbench.renderAll();
  resizeCanvas();
  if (state.mode === "sheet") state.view = null;
  draw();
});
resizeCanvas();

// --- writing pages -------------------------------------------------------

const exportForm: ExportForm = {
  template: "",
  outDir: "",
  fit: "basic",
  makeWork: true,
  workTemplate: "",
  workName: "",
  storyIndex: "",
};

function showExportForm(): void {
  const show = (id: string, path: string) => {
    $(id).textContent = path || "未選択";
    $(id).title = path;
  };
  show("export-template", exportForm.template);
  show("export-out-dir", exportForm.outDir);
  show("export-work-template", exportForm.workTemplate);
  $<HTMLSelectElement>("export-fit").value = exportForm.fit;
  $<HTMLInputElement>("export-make-work").checked = exportForm.makeWork;
  $("work-fields").hidden = !exportForm.makeWork;
  $<HTMLInputElement>("export-work-name").value = exportForm.workName;
  $<HTMLInputElement>("export-story-index").value = exportForm.storyIndex;
}

function exportMessage(text: string, error = false): void {
  const message = $("export-message");
  message.textContent = text;
  message.classList.toggle("error", error);
}

async function openExport(): Promise<void> {
  if (!state.sheet) return;
  try {
    const defaults = await invoke<{ workTemplate: string | null; workName: string }>("export_defaults");
    if (!exportForm.workTemplate && defaults.workTemplate) exportForm.workTemplate = defaults.workTemplate;
    exportForm.workName ||= defaults.workName;
  } catch (error) {
    setStatus(String(error));
  }
  showExportForm();
  exportMessage("");
  $<HTMLDialogElement>("export-dialog").showModal();
}

async function pick(field: "template" | "workTemplate" | "outDir"): Promise<void> {
  const start = exportForm[field] ? folderOf(exportForm[field]) : folderOf(state.sheetPath);
  const path =
    field === "outDir"
      ? await open({ directory: true, defaultPath: exportForm.outDir || start })
      : await open({
          multiple: false,
          defaultPath: start || undefined,
          filters:
            field === "template"
              ? [{ name: "CLIP STUDIO PAINT のページ", extensions: ["clip"] }]
              : [{ name: "CLIP STUDIO PAINT EX の作品", extensions: ["cmc"] }],
        });
  if (typeof path === "string") exportForm[field] = path;
  showExportForm();
  exportMessage("");
}

async function runExport(): Promise<void> {
  exportForm.fit = $<HTMLSelectElement>("export-fit").value as Fit;
  exportForm.makeWork = $<HTMLInputElement>("export-make-work").checked;
  exportForm.workName = $<HTMLInputElement>("export-work-name").value;
  exportForm.storyIndex = $<HTMLInputElement>("export-story-index").value;
  const request = buildRequest(exportForm, state.sheetPath);
  if (typeof request === "string") {
    exportMessage(request, true);
    return;
  }
  const button = $<HTMLButtonElement>("export-run");
  button.disabled = true;
  exportMessage("書き出し中…");
  const started = performance.now();
  try {
    const report = await invoke<ExportReport>("export_pages", { request });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    exportMessage(summarize(report).join("\n"));
    setStatus(`${report.pages.length} ページを ${exportForm.outDir} に書き出しました（${seconds} 秒）`);
  } catch (error) {
    exportMessage(String(error), true);
  } finally {
    button.disabled = false;
  }
}

$("export").addEventListener("click", openExport);
$("pick-template").addEventListener("click", () => pick("template"));
$("pick-out-dir").addEventListener("click", () => pick("outDir"));
$("pick-work-template").addEventListener("click", () => pick("workTemplate"));
$("export-make-work").addEventListener("change", (event) => {
  exportForm.makeWork = (event.target as HTMLInputElement).checked;
  $("work-fields").hidden = !exportForm.makeWork;
});
$("export-run").addEventListener("click", runExport);

// --- editing name data ---------------------------------------------------------

let workspace: "viewer" | "editor" = "viewer";

const workbench = new Workbench(setStatus, (title) => {
  $("file-name").textContent = title;
  document.title = `${title} — Name Studio`;
});

function showWorkspace(next: "viewer" | "editor"): void {
  workspace = next;
  $("viewer").hidden = next !== "viewer";
  $("editor").hidden = next !== "editor";
  for (const node of document.querySelectorAll<HTMLElement>(".viewer-only")) node.hidden = next !== "viewer";
  for (const node of document.querySelectorAll<HTMLElement>(".editor-only")) node.hidden = next !== "editor";
  if (next === "editor") workbench.editor.resize();
  else {
    $("file-name").textContent = state.sheet?.fileName ?? "ファイルが開かれていません";
    document.title = "Name Studio";
    resizeCanvas();
    draw();
  }
}

$("new-project").addEventListener("click", async () => {
  if (!(await workbench.confirmDiscard())) return;
  showWorkspace("editor");
  workbench.show(newProject("新しいネーム", 16), null, "16 ページの白紙のネームを作りました。左の「ページ」で作品名を付けられます");
});

$("import-project").addEventListener("click", async () => {
  if (!state.sheetPath || !(await workbench.confirmDiscard())) return;
  try {
    showWorkspace("editor");
    await workbench.importSheet(state.sheetPath);
  } catch (error) {
    showWorkspace("viewer");
    setStatus(`取り込めませんでした: ${error}`);
  }
});

$("save").addEventListener("click", () => void workbench.save());

void getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await workbench.confirmDiscard())) event.preventDefault();
});

interface Recovery {
  path: string | null;
  timeMs: number;
  project: Project;
}

/** Offer back a project autosave kept when the app stopped before it was saved. */
async function offerRecovery(): Promise<void> {
  let recoveries: Recovery[];
  try {
    recoveries = await invoke<Recovery[]>("pending_recoveries");
  } catch {
    return;
  }
  const recovery = recoveries?.[0];
  if (!recovery) return;
  const where = recovery.path ?? "（まだ保存していないネーム）";
  const restore = await ask(
    `前回、保存しないまま終わったネームがあります。\n\n${recovery.project.title}（${recovery.project.pages.length} ページ、${formatTime(recovery.timeMs)} の自動保存）\n${where}\n\n復元しますか？「いいえ」で控えを消します。`,
    { title: "Name Studio", kind: "warning" },
  );
  if (restore) {
    showWorkspace("editor");
    workbench.showRecovered(recovery.project, recovery.path, recovery.timeMs);
  } else {
    await invoke("discard_recovery", { path: recovery.path }).catch(() => undefined);
  }
}

async function start(): Promise<void> {
  const version = await appVersion();
  if (version) $("app-version").textContent = `v${version}`;
  // Started from the command line to write a name out: no update or recovery questions.
  const batch = await batchExportTask();
  if (batch) {
    await runBatchExport(batch, setStatus);
    return;
  }
  await checkForUpdate({
    status: setStatus,
    busy: () => workbench.project !== null,
    prepare: () => workbench.confirmDiscard(),
  });
  await offerRecovery();
}

void start();
