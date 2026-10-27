/// <reference types="vite/client" />
// Name Studio front end: puts the screens together. The start screen
// (startscreen.ts) and the sheet viewer (viewer.ts, sheetexport.ts) share the
// first workspace; name data is edited in the second (workbench.ts).
import { call, type Recovery } from "./backend";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { formatTime } from "./autosave";
import { setInstalledFonts } from "./fonts";
import { batchExportTask, runBatchExport } from "./batch";
import { appVersion, checkForUpdate } from "./updater";
import { applyNewNameDefaults } from "./namedefaults";
import type { Project } from "./model";
import { newProject } from "./project";
import { STRUCTURES } from "./structures";
import { adoptShape } from "./shapes";
import { libraryShapes, loadRecentNames, newNameDefaults } from "./prefs";
import { HelpBar, helpBarShown, showHelpBar } from "./helpbar";
import { HelpOverlay } from "./helpoverlay";
import type { HelpKind } from "./helptopics";
import { comboOf } from "./shortcuts";
import { Tour } from "./tour";
import { CommandPalette } from "./palette";
import { SheetExport } from "./sheetexport";
import { StartScreen } from "./startscreen";
import { SheetViewer } from "./viewer";
import { PROJECT_EXTENSION, Workbench } from "./workbench";
import { $, isTyping } from "./dom";
import { ImageImportDialog } from "./imageimport";

function setStatus(message: string): void {
  $("status").textContent = message;
}

let workspace: "viewer" | "editor" = "viewer";

const viewer = new SheetViewer(setStatus);
new SheetExport(() => viewer.sheetPath, setStatus);

const workbench = new Workbench(
  setStatus,
  (title) => {
    $("file-name").textContent = title;
    document.title = `${title} — Name Studio`;
  },
  (kind) => askHelp(kind),
);

// --- help ------------------------------------------------------------------------------

/** No name opened on this computer yet: the guide is offered (once) on the start screen and in the editor. */
const firstRun = loadRecentNames().length === 0;
const keysOf = (id: string) => workbench.shortcuts.keys(id);
const tour = new Tour({ keysOf });
const helpOverlay = new HelpOverlay({
  keysOf,
  actionFor: (combo) => workbench.shortcuts.actionFor(combo),
  tour: () => tour.start(workspace === "editor" ? "editor" : "start"),
  openShortcuts: () => $("shortcuts").click(),
});
const helpBar = new HelpBar({ editor: () => (workspace === "editor" ? workbench.editor : null), keysOf });

function askHelp(kind: HelpKind): void {
  if (kind === "overlay") helpOverlay.toggle();
  else if (kind === "tour") tour.start(workspace === "editor" ? "editor" : "start");
  else showHelpBar(!helpBarShown());
}

$("help").addEventListener("click", () => helpOverlay.toggle());
$("st-tour").addEventListener("click", () => {
  $<HTMLDialogElement>("settings-dialog").close();
  tour.start("editor");
});

function showWorkspace(next: "viewer" | "editor"): void {
  workspace = next;
  $("viewer").hidden = next !== "viewer";
  $("editor").hidden = next !== "editor";
  for (const node of document.querySelectorAll<HTMLElement>(".viewer-only")) node.hidden = next !== "viewer";
  for (const node of document.querySelectorAll<HTMLElement>(".editor-only")) node.hidden = next !== "editor";
  if (next === "editor") {
    workbench.editor.resize();
    // The start screen's guide gives way to the editor's (laid out first).
    tour.close();
    if (firstRun) requestAnimationFrame(() => tour.offer("editor"));
  } else {
    $("file-name").textContent = viewer.sheet?.fileName ?? "ファイルが開かれていません";
    document.title = "Name Studio";
    startScreen.render();
    viewer.resize();
  }
}

// --- opening -------------------------------------------------------------------------

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
    await openName(path);
    return;
  }
  showWorkspace("viewer");
  await viewer.open(path);
}

/** Opens name data; false when it could not be read. */
async function openName(path: string, failedNote = ""): Promise<boolean> {
  try {
    await workbench.load(path);
    showWorkspace("editor");
    return true;
  } catch (error) {
    setStatus(`開けませんでした${failedNote}: ${error}`);
    return false;
  }
}

function newName(): void {
  void (async () => {
    if (!(await workbench.confirmDiscard())) return;
    const dialog = $<HTMLDialogElement>("new-dialog");
    const shape = $<HTMLSelectElement>("nn-shape");
    shape.replaceChildren(new Option("なし（あとで選べる）", ""));
    for (const s of [...Object.values(STRUCTURES), ...libraryShapes()]) shape.append(new Option(s.label, s.id));
    dialog.returnValue = "";
    const kind = $<HTMLSelectElement>("nn-binding");
    const showKind = () => ($("nn-scroll-hint").hidden = kind.value !== "scroll");
    kind.onchange = showKind;
    showKind();
    dialog.showModal();
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "ok") return;
        const pages = Math.max(1, Math.min(400, Number.parseInt($<HTMLInputElement>("nn-pages").value, 10) || 16));
        const title = $<HTMLInputElement>("nn-title").value.trim() || "新しいネーム";
        const kind = $<HTMLSelectElement>("nn-binding").value;
        const project = newProject(title, pages, kind === "left" || kind === "scroll" ? kind : "right");
        const usedDefaults = applyNewNameDefaults(project, newNameDefaults());
        if ($<HTMLInputElement>("nn-target").checked) project.plan = { targetPages: pages };
        const kept = libraryShapes().find((s) => s.id === shape.value);
        if (kept) adoptShape(project, kept);
        else if (shape.value) project.plan = { ...(project.plan ?? {}), structure: shape.value };
        showWorkspace("editor");
        workbench.show(project, null, `${pages} ページの白紙のネーム「${title}」を作りました${usedDefaults ? "（設定の「新しいネームの既定」を使いました）" : ""}`);
      },
      { once: true },
    );
  })();
}

/** ネーム画像を取り込む: into the open name, or (from the start screen) as a new name. */
const imageImport = new ImageImportDialog({
  project: () => (workspace === "editor" ? workbench.project : null),
  edit: (change) => workbench.edit(change),
  newName: (title, pages, binding) => {
    const project = newProject(title, pages, binding);
    applyNewNameDefaults(project, newNameDefaults());
    return project;
  },
  opened: (project, message) => {
    showWorkspace("editor");
    workbench.show(project, null, message);
  },
  done: (first, message) => {
    workbench.editor.showPage(first);
    workbench.renderAll();
    setStatus(message);
  },
  status: setStatus,
});

async function nameFromImage(): Promise<void> {
  if (workspace === "editor" || !(await workbench.confirmDiscard())) return;
  imageImport.open();
}

$("image-import").addEventListener("click", () => imageImport.open());

const startScreen = new StartScreen({
  openFile: () => void openFile(),
  newName,
  fromImage: () => void nameFromImage(),
  openName: async (path) => (await workbench.confirmDiscard()) ? openName(path, "（最近のネームの一覧から外しました）") : true,
});

/** Ctrl+K before a name is open: open, new, the names opened last, and the open sheet's two actions. */
const startPalette = new CommandPalette(
  {
    commands: () => [
      ...startScreen.commands(),
      ...(viewer.sheet
        ? [
            { id: "sheet.import", label: "このネーム用紙を編集する", group: "ネーム用紙", keys: [], words: "取り込む ネームデータ", run: () => ($("import-project").click(), true) },
            { id: "sheet.export", label: "ページに書き出す", group: "ネーム用紙", keys: [], words: "CSP 分割", run: () => ($("export").click(), true) },
          ]
        : []),
    ],
    keysOf: (id) => (id === "start.open" ? ["Ctrl+O"] : []),
    run: (command) => void command.run(),
    status: setStatus,
    remembers: false,
  },
  "start-palette",
);

window.addEventListener("keydown", (event) => {
  if (workspace === "editor") {
    if (workbench.handleKey(event)) event.preventDefault();
    return;
  }
  if (startPalette.isOpen) return;
  const combo = comboOf(event);
  if (combo && !isTyping(event) && keysOf("help.overlay").includes(combo)) {
    event.preventDefault();
    helpOverlay.toggle();
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey;
  // 開く・新しいネーム with their keys as set (Ctrl+O, Ctrl+N), as in the editor.
  if (combo && (keysOf("button.open").includes(combo) || keysOf("button.new-project").includes(combo))) {
    event.preventDefault();
    if (keysOf("button.open").includes(combo)) void openFile();
    else newName();
  } else if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startPalette.open();
  } else if (viewer.handleKey(event)) {
    event.preventDefault();
  }
});

$("open").addEventListener("click", openFile);
$("new-project").addEventListener("click", newName);

window.addEventListener("resize", () => {
  workbench.editor.resize();
  if (workspace === "editor") workbench.renderAll();
  viewer.resize();
});

$("import-project").addEventListener("click", async () => {
  if (!viewer.sheetPath || !(await workbench.confirmDiscard())) return;
  try {
    showWorkspace("editor");
    await workbench.importSheet(viewer.sheetPath);
  } catch (error) {
    showWorkspace("viewer");
    setStatus(`取り込めませんでした: ${error}`);
  }
});

$("save").addEventListener("click", () => void workbench.save());

void getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await workbench.confirmDiscard())) event.preventDefault();
});

/** Offer back a project autosave kept when the app stopped before it was saved. */
async function offerRecovery(): Promise<void> {
  let recoveries: Recovery[];
  try {
    recoveries = await call("pending_recoveries");
  } catch {
    return;
  }
  const recovery = recoveries?.[0];
  if (!recovery) return;
  const where = recovery.path ?? "（まだ保存していないネーム）";
  const restore = await ask(
    `前回、保存しないまま終わったネームがあります。\n\n${recovery.project.title}（${recovery.project.pages.length} ページ、${formatTime(recovery.timeMs)} の自動保存）\n${where}${recovery.problems?.length ? `\n（直せる問題が ${recovery.problems.length} か所あります。復元すると直します）` : ""}\n\n復元しますか？「いいえ」で控えを消します。`,
    { title: "Name Studio", kind: "warning" },
  );
  if (restore) {
    showWorkspace("editor");
    workbench.showRecovered(recovery.project, recovery.path, recovery.timeMs);
  } else {
    await call("discard_recovery", { path: recovery.path }).catch(() => undefined);
  }
}

/** The fonts on this computer, to choose from and to draw and write out dialogue in. */
async function loadFonts(): Promise<void> {
  try {
    setInstalledFonts(await call("list_fonts"));
    workbench.renderAll();
  } catch {
    // In a plain browser: the usual fonts are offered by name.
  }
}

async function start(): Promise<void> {
  startScreen.render();
  const version = await appVersion();
  if (version) $("app-version").textContent = `v${version}`;
  // Before a command-line export too: the dialogue goes to CSP in its fonts.
  await loadFonts();
  // Started from the command line to write a name out: no update or recovery questions.
  const batch = await batchExportTask();
  if (batch) {
    await runBatchExport(batch, setStatus);
    return;
  }
  // Work left unsaved comes first: the update check can wait on the network.
  await offerRecovery();
  if (firstRun && workspace === "viewer") tour.offer("start");
  await checkForUpdate({
    status: setStatus,
    busy: () => workbench.project !== null,
    prepare: () => workbench.confirmDiscard(),
  });
}

// An error nothing caught: the change under way is undone (never half done),
// the person is told, and the log keeps it.
window.addEventListener("error", (event) => workbench.failed(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => workbench.failed(event.reason));

void start();

// Development only: open name data from a test script (no file dialog without Tauri).
if (import.meta.env.DEV) {
  Object.assign(window, {
    nameStudio: {
      workbench,
      helpBar,
      show(project: Project) {
        showWorkspace("editor");
        workbench.show(project, null, "");
      },
    },
  });
}
