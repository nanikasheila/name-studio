// Saving keeps to the name it was started for: a save that ends after another
// name was opened leaves that one alone, the export dialog does not carry one
// unsaved name's folder over to the next, a series file that could not be
// written stays in view with a way to try again, the save state beside the
// name says where the changes are kept (and a failure until a save works),
// closing with changes offers to save, not save or go back, and the smallest
// window keeps its buttons on screen. Run: npm run e2e:saving
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const A = "C:\\ネーム\\A.namestudio";
const B = "C:\\ネーム\\B.namestudio";

const server = await createServer({ root, logLevel: "error", server: { port: 1441, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__files = {};
    window.__dialogs = [];
    // A save can be held until the test lets it go; the series file can refuse to be written.
    window.__hold = null;
    window.__seriesFails = false;
    window.__answer = async (command, args) => {
      switch (command) {
        case "save_project": {
          const length = new DataView(args.buffer, args.byteOffset).getUint32(0, true);
          const meta = JSON.parse(new TextDecoder().decode(args.subarray(4, 4 + length)));
          const text = new TextDecoder().decode(args.subarray(4 + length));
          if (window.__hold) await window.__hold;
          if (window.__saveFails) throw new Error("ディスクがいっぱいです");
          window.__files[meta.path] = text;
          return null;
        }
        case "load_series":
          if (!(args.path in window.__files)) throw new Error(`no file: ${args.path}`);
          return JSON.parse(window.__files[args.path]);
        case "save_series":
          if (window.__seriesFails) throw new Error("読み取り専用です");
          window.__files[args.path] = args.text;
          return null;
        case "discard_recovery":
          window.__discarded = (window.__discarded ?? 0) + 1;
          return null;
        case "plugin:dialog|save":
        case "plugin:dialog|open":
          return window.__dialogs.shift() ?? null;
        case "plugin:dialog|message": {
          // Asked before closing: the button the test picks, by its label.
          const buttons = args.buttons?.YesNoCancelCustom;
          if (buttons && window.__pick !== undefined) return buttons[window.__pick];
          return "Yes";
        }
        default:
          return undefined;
      }
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const show = (path, title) =>
    page.evaluate(
      async ([path, title]) => {
        const { newProject } = await import("/src/project.ts");
        window.nameStudio.show(newProject(title, 2));
        window.nameStudio.workbench.show(newProject(title, 2), path, "");
      },
      [path, title],
    );
  const settle = () => page.waitForTimeout(200);
  const saveState = () => page.locator("#save-state").textContent();
  const file = (path) => page.evaluate((path) => (path in window.__files ? JSON.parse(window.__files[path]) : null), path);
  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      return { title: wb.project.title, path: wb.session.path, dirty: wb.session.dirty, status: document.getElementById("status").textContent };
    });

  // 1. A is being saved when B is opened.
  await show(A, "A");
  await page.evaluate(() => {
    window.__release = null;
    window.__hold = new Promise((resolve) => (window.__release = resolve));
    window.__saving = window.nameStudio.workbench.save();
  });
  await settle();
  check((await saveState()) === "保存中…", `the save state shows a save being written (${await saveState()})`);
  await show(B, "B");
  await page.evaluate(async () => {
    window.__hold = null;
    window.__release();
    await window.__saving;
  });
  await settle();
  let now = await state();
  check(now.title === "B" && now.path === B, `B keeps its own file after A's save ends (${now.path})`);
  check((await file(A))?.title === "A", "A's save wrote A");
  await page.evaluate(() => window.nameStudio.workbench.save());
  check((await file(B))?.title === "B" && (await file(A))?.title === "A", "B's next save goes to B, not to A");
  check(/^保存済み \d\d:\d\d$/.test(await saveState()), `and the save state says it is in the file, and when (${await saveState()})`);
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    wb.begin();
    wb.project.title = "B1";
    wb.commit();
  });
  check((await saveState()) === "未保存の変更あり", `a change not yet in the file (${await saveState()})`);
  // A save that fails stays in view until a save works.
  await page.evaluate(() => (window.__saveFails = true));
  await page.evaluate(() => window.nameStudio.workbench.save());
  await page.evaluate(() => window.nameStudio.workbench.setStatus?.("別の操作"));
  const failedState = page.locator("#save-state[data-tone=error]");
  check((await failedState.textContent()) === "保存できませんでした", "a failed save shows in the save state, after other messages too");
  check((await failedState.getAttribute("title")).includes("ディスクがいっぱいです"), "with why, on hover");
  await page.evaluate(() => (window.__saveFails = false));
  await page.evaluate(() => window.nameStudio.workbench.save());
  check((await saveState()).startsWith("保存済み"), `the next save that works clears it (${await saveState()})`);

  // Saves one after another: the later one lands last.
  await page.evaluate(() => {
    window.__hold = new Promise((resolve) => (window.__release = resolve));
    const wb = window.nameStudio.workbench;
    window.__first = wb.save();
    wb.project.title = "B2";
    window.__hold2 = wb.save();
  });
  await settle();
  await page.evaluate(async () => {
    window.__hold = null;
    window.__release();
    await Promise.all([window.__first, window.__hold2]);
  });
  check((await file(B))?.title === "B2", "two saves in a row: the newer one is what stays in the file");

  // Closing with changes not saved: go back, save and go on, or go on without saving.
  const close = (pick) =>
    page.evaluate(async (pick) => {
      const wb = window.nameStudio.workbench;
      wb.begin();
      wb.project.title = `閉じる${pick}`;
      wb.commit();
      window.__pick = pick;
      const going = await wb.confirmDiscard();
      window.__pick = undefined;
      return { going, dirty: wb.session.dirty, discarded: window.__discarded ?? 0 };
    }, pick);
  const back = await close(2);
  check(!back.going && back.dirty, "closing with changes: 「戻る」 stays with the name, changes kept");
  const saving = await close(0);
  check(saving.going && !saving.dirty && (await file(B))?.title === "閉じる0", "「保存して続ける」 saves to its file and goes on");
  const before = saving.discarded;
  const dropping = await close(1);
  check(dropping.going && dropping.discarded === before + 1 && (await file(B))?.title === "閉じる0", "「保存しないで続ける」 goes on without writing the file, and drops the recovery copy");

  // 2. The export dialog: unsaved A, then unsaved B.
  await show(null, "未保存A");
  check((await saveState()) === "未保存", `a name without a file says so (${await saveState()})`);
  await page.evaluate(() => {
    const dialog = window.nameStudio.workbench.exportDialog;
    dialog.open();
    dialog.form.outDir = "C:/review-output-A";
    document.getElementById("name-export-dialog").close();
  });
  await show(null, "未保存B");
  const form = await page.evaluate(() => {
    const dialog = window.nameStudio.workbench.exportDialog;
    dialog.open();
    const form = { ...dialog.form };
    document.getElementById("name-export-dialog").close();
    return form;
  });
  check(form.outDir === "" && form.workName === "未保存B", `unsaved B does not get A's folder or title (${form.outDir} / ${form.workName})`);
  await page.evaluate(() => {
    const dialog = window.nameStudio.workbench.exportDialog;
    dialog.open();
    dialog.form.outDir = "C:/out-B";
    document.getElementById("name-export-dialog").close();
  });
  // Save As keeps the name, and so its export settings.
  await page.evaluate((path) => window.__dialogs.push(path), B);
  await page.evaluate(() => window.nameStudio.workbench.save(true));
  const kept = await page.evaluate(() => {
    const dialog = window.nameStudio.workbench.exportDialog;
    dialog.open();
    const outDir = dialog.form.outDir;
    document.getElementById("name-export-dialog").close();
    return outDir;
  });
  check(kept === "C:/out-B", `after Save As the same name keeps its export folder (${kept})`);

  // 3. The series file cannot be written.
  const SERIES = "C:\\ネーム\\作品.nameseries";
  await show(A, "第1話");
  await page.evaluate((path) => window.__dialogs.push(path), SERIES);
  await page.click("#series-create").catch(() => undefined);
  await page.evaluate(async () => {
    // The palette may be closed: create it through the panel itself.
    if (!document.getElementById("series-create")) await window.nameStudio.workbench.seriesPanel.create();
  });
  await settle();
  check((await file(SERIES)) !== null, "the series is made");
  await page.evaluate(() => {
    window.__seriesFails = true;
    window.nameStudio.workbench.project.characters.push({ id: "new", name: "新しい人" });
  });
  const saved = await page.evaluate(() => window.nameStudio.workbench.save());
  await settle();
  now = await state();
  const alert = page.locator(".alert", { hasText: "シリーズ" });
  check(saved && now.status.includes("シリーズには未反映"), `the status says the series is behind (${now.status})`);
  check(await alert.isVisible(), "an alert about the series stays in view");
  check((await saveState()).endsWith("シリーズ未反映"), `and the save state says so (${await saveState()})`);
  await page.evaluate(() => window.nameStudio.workbench.setStatus?.("別の操作"));
  check(await alert.isVisible(), "and is still there after other messages");
  await page.evaluate(() => (window.__seriesFails = false));
  await alert.locator("button.alert-action").click();
  await settle();
  check(!(await alert.isVisible()), "「もう一度」 writes it and the alert goes");
  check(!(await saveState()).includes("シリーズ"), `and the save state no longer mentions the series (${await saveState()})`);
  check((await file(SERIES))?.shared?.characters?.some((c) => c.name === "新しい人"), "the series has the new character");

  // 4. The smallest window keeps everything on screen.
  for (const [width, height] of [
    [900, 600],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await settle();
    const fit = await page.evaluate(() => {
      const right = (id) => document.getElementById(id).getBoundingClientRect().right;
      return {
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        exportRight: right("name-export"),
        saveRight: right("save"),
        undoRight: right("undo"),
        stateRight: right("save-state"),
      };
    });
    check(fit.scroll <= fit.inner, `${width}×${height}: no sideways scrolling (${fit.scroll} ≤ ${fit.inner})`);
    check(
      Math.max(fit.exportRight, fit.saveRight, fit.undoRight, fit.stateRight) <= fit.inner,
      `${width}×${height}: save, its state, undo and export are on screen (${Math.round(fit.exportRight)})`,
    );
  }
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
