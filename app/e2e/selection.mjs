// 選択の決まり: what is picked is what is shown as picked. Taking up a tool
// that does not keep the selection lets it go (Delete and the arrows then
// never act on it); picking from elsewhere takes up the select tool; things
// with no handles of their own show the transform frame at once; the arrows,
// 反転 and Delete do what a drag and the frame do; Alt + drag moves a panel
// without snapping; 資料: Delete, the arrows and Esc work on the chosen picture.
// Run: npm run e2e:selection
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1446, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem("namestudio.storyHeight", JSON.stringify({ strip: 354 })));
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // Four pages; page 2 cut into two panels, a rough line in the top one, a fill in the bottom one.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const { basicBox } = await import("/src/pagebox.ts");
    const { addFill } = await import("/src/strokes.ts");
    const project = newProject("選択", 4);
    for (const p of project.pages) addPanel(project, p, rectShape(basicBox(project.pageFormat)));
    const [x0, y0, x1, y1] = basicBox(project.pageFormat);
    const page = project.pages[1];
    page.panels = [];
    addPanel(project, page, rectShape([x0, y0, x1, (y0 + y1) / 2 - 2]));
    addPanel(project, page, rectShape([x0, (y0 + y1) / 2 + 2, x1, y1]));
    page.strokes.push({ id: "stroke-a", points: [[x0 + 20, y0 + 20, 1], [x0 + 60, y0 + 50, 1], [x0 + 90, y0 + 25, 1]], widthMm: 0.4 });
    addFill(project, page, rectShape([x0 + 10, y1 - 60, x0 + 50, y1 - 20]));
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    wb.editor.fitView();
  });
  await page.waitForTimeout(300);

  const state = () =>
    page.evaluate(() => {
      const wb = window.nameStudio.workbench;
      const page = wb.project.pages[1];
      return {
        selection: wb.editor.selection,
        tool: wb.editor.tool,
        activeButton: document.querySelector("#editor-tools .active")?.id ?? null,
        frame: !!wb.editor.frameGeometry(),
        pages: wb.editor.currentPages(),
        panels: page.panels.map((p) => ({ id: p.id, shape: p.shape })),
        stroke: page.strokes.find((s) => s.id === "stroke-a")?.points.map(([x, y]) => [x, y]),
        fill: page.fills?.[0]?.shape,
        bar: !document.querySelector(".action-bar")?.hidden,
      };
    });
  const tool = (name) => page.evaluate((name) => window.nameStudio.workbench.setTool(name), name);
  const at = (mm) => page.evaluate((mm) => { const wb = window.nameStudio.workbench; return wb.editor.clientOf(wb.project.pages[1].id, mm); }, mm);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function drag(points, keys = []) {
    for (const key of keys) await page.keyboard.down(key);
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let s = 1; s <= 6; s++) await page.mouse.move(ax + ((bx - ax) * s) / 6, ay + ((by - ay) * s) / 6);
    }
    await page.mouse.up();
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await settle();
  }
  const click = async (mm, keys) => drag([await at(mm)], keys);
  const box = await page.evaluate(async () => {
    const { basicBox } = await import("/src/pagebox.ts");
    return basicBox(window.nameStudio.workbench.project.pageFormat);
  });
  const [x0, y0, x1, y1] = box;
  const top = [(x0 + x1) / 2 + 30, y0 + 70];
  const bottom = [(x0 + x1) / 2 + 30, y1 - 40];
  const fillAt = [x0 + 30, y1 - 40];
  const lineAt = [x0 + 60, y0 + 50];

  // A panel picked, then the pen taken up: the selection goes, and the arrows turn the pages again.
  await tool("select");
  await click(top);
  let s = await state();
  check(s.selection?.kind === "panel" && s.bar, "the select tool picks a panel, with its action bar");
  await page.keyboard.press("KeyP");
  s = await state();
  check(s.tool === "pen" && s.selection === null, "taking up the pen lets the panel go");
  const before = s;
  await page.keyboard.press("ArrowLeft");
  s = await state();
  check(JSON.stringify(s.panels) === JSON.stringify(before.panels), "with the pen, ← moves no panel");
  check(JSON.stringify(s.pages) !== JSON.stringify(before.pages), "with the pen, ← turns the pages");
  await page.evaluate(() => window.nameStudio.workbench.editor.showPage(2));
  await settle();

  // Picked from elsewhere (a list, a paste) with the pen in hand: the select tool is taken up, its button too.
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    wb.editor.select({ kind: "stroke", pageId: wb.project.pages[1].id, id: "stroke-a" });
  });
  s = await state();
  check(s.tool === "select" && s.activeButton === "tool-select" && s.selection?.kind === "stroke", "picking with the pen in hand takes up the select tool (button too)");
  check(s.frame, "a rough line shows the transform frame at once");

  // A fill shows the frame at once too; a panel only with 変形.
  await click(fillAt);
  s = await state();
  check(s.selection?.kind === "fill" && s.frame, "a fill shows the transform frame at once");
  await click(bottom);
  s = await state();
  check(s.selection?.kind === "panel" && !s.frame, "a panel shows its corners, not the frame");

  // 反転 works on a panel without 変形, what is drawn in it with it (Esc first: the bar over the bottom panel lies on the top one).
  await page.keyboard.press("Escape");
  await click(top);
  const unflipped = (await state()).stroke;
  const flipped = await page.evaluate(() => window.nameStudio.workbench.run("flip.horizontal"));
  s = await state();
  check(flipped && JSON.stringify(s.stroke) !== JSON.stringify(unflipped), "左右反転 of a panel (no 変形) turns it with its rough line");
  await page.keyboard.press("Control+z");
  await settle();

  // The arrows move a panel as a drag does: with what is drawn in it.
  await click(top);
  const still = await state();
  await page.keyboard.press("ArrowRight");
  s = await state();
  const moved = (a, b) => a.some((p, i) => Math.abs(p[0] - b[i][0]) > 0.01);
  const panelMoved = moved(s.panels.find((p) => p.id === still.selection.id).shape, still.panels.find((p) => p.id === still.selection.id).shape);
  check(panelMoved && moved(s.stroke, still.stroke), "→ moves the panel and its rough line with it");
  await page.keyboard.press("Control+z");
  await settle();

  // Alt + drag a panel: moved without snapping, not swapped.
  const plain = await state();
  const [ax, ay] = await at(top);
  await drag([[ax, ay], [ax + 7, ay + 5]], ["Alt"]);
  s = await state();
  const id = plain.panels[0].id;
  check(
    s.panels.length === plain.panels.length && moved(s.panels.find((p) => p.id === id).shape, plain.panels.find((p) => p.id === id).shape),
    "Alt + drag moves the panel (the number is for swapping)",
  );
  await page.keyboard.press("Control+z");
  await settle();

  // Esc lets go; Delete then takes nothing away.
  await click(lineAt);
  await page.keyboard.press("Escape");
  s = await state();
  check(s.selection === null, "Esc lets the selection go");
  const strokes = await page.evaluate(() => window.nameStudio.workbench.project.pages[1].strokes.length);
  await page.keyboard.press("Delete");
  check((await page.evaluate(() => window.nameStudio.workbench.project.pages[1].strokes.length)) === strokes, "Delete with nothing picked takes nothing");

  // 資料: a picture pasted is chosen; the arrows move it, Esc lets it go, Delete takes it away.
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    canvas.getContext("2d").fillRect(0, 0, 40, 30);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    const wb = window.nameStudio.workbench;
    await wb.references.pasteImages([new File([blob], "a.png", { type: "image/png" })], { page: wb.project.pages[1] });
  });
  await settle();
  const picture = () => page.evaluate(() => ({ chosen: window.nameStudio.workbench.editor.reference, boxes: (window.nameStudio.workbench.project.pages[1].references ?? []).map((r) => r.box) }));
  let p = await picture();
  check(p.chosen && p.boxes.length === 1, "a pasted picture is chosen with the 資料 tool");
  await page.keyboard.press("ArrowDown");
  const q = await picture();
  check(q.boxes[0][1] > p.boxes[0][1], "↓ moves the chosen picture");
  await page.keyboard.press("Escape");
  p = await picture();
  check(p.chosen === null && p.boxes.length === 1, "Esc lets the picture go");
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    const page = wb.project.pages[1];
    wb.editor.chooseReference({ pageId: page.id, id: page.references[0].id });
  });
  await page.keyboard.press("Delete");
  p = await picture();
  check(p.boxes.length === 0, "Delete takes the chosen picture away");

  // The text tool keeps the line it places; its handles are the select tool's.
  await tool("text");
  await click([x1 - 40, y0 + 40]);
  await page.keyboard.type("あ");
  await page.mouse.click(5, 500);
  s = await state();
  check(s.tool === "text", "the text tool stays in hand");

  check(errors.length === 0, `no errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
