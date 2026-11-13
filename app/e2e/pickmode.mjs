// 範囲選択で選ぶもの (選択ツールの上の段・設定 › 操作): out of the box a drag
// around things picks what it surrounds (rough lines mostly inside, dialogue
// whose middle is, panels wholly inside); 「かかったもの」 picks anything the
// drawn outline touches at all. The choice is kept on this computer, and the
// bar and the settings show the same.
// Run: npm run e2e:pickmode
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1452, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  // Page 2: a rough line running out of the drag to the right, dialogue whose box it only clips,
  // a panel whose corner it reaches into, and a short line wholly inside.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addLine } = await import("/src/domain/dialogue.ts");
    const { addPanel } = await import("/src/domain/panels.ts");
    const { rectShape } = await import("/src/model/geometry.ts");
    const project = newProject("かかったもの", 3);
    const target = project.pages[1];
    target.strokes.push({
      id: "long",
      points: [50, 75, 100, 125, 150].map((x) => [x, 100, 1]),
      widthMm: 0.4,
      closed: false,
    });
    target.strokes.push({
      id: "short",
      points: [
        [50, 120, 1],
        [60, 125, 1],
      ],
      widthMm: 0.4,
      closed: false,
    });
    const line = addLine(project, target, [80, 150], "ちょっと");
    line.box = [65, 140, 95, 160];
    addPanel(project, target, rectShape([60, 200, 200, 300]));
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    wb.editor.fitView();
    wb.setTool("select");
  });
  await page.waitForTimeout(300);

  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (mm) =>
    page.evaluate((mm) => {
      const wb = window.nameStudio.workbench;
      return wb.editor.clientOf(wb.project.pages[1].id, mm);
    }, mm);
  async function lasso([x0, y0, x1, y1]) {
    const points = [await at([x0, y0]), await at([x1, y0]), await at([x1, y1]), await at([x0, y1]), await at([x0, y0 + 1])];
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      for (let s = 1; s <= 6; s++) await page.mouse.move(ax + ((bx - ax) * s) / 6, ay + ((by - ay) * s) / 6);
    }
    await page.mouse.up();
    await settle();
  }
  const picked = () =>
    page.evaluate(() => {
      const s = window.nameStudio.workbench.editor.selection;
      if (!s) return [];
      const items = s.kind === "group" ? s.items : [{ kind: s.kind, id: s.id }];
      return items.map((item) => `${item.kind}:${item.id}`).sort();
    });
  const bar = () =>
    page.evaluate(() => ({
      shown: !document.getElementById("pick-modes").hidden,
      inside: document.getElementById("pick-inside").classList.contains("active"),
      touch: document.getElementById("pick-touch").classList.contains("active"),
      stored: localStorage.getItem("namestudio.pickMode"),
    }));
  const panelId = await page.evaluate(() => window.nameStudio.workbench.project.pages[1].panels[0].id);
  const lineId = await page.evaluate(() => window.nameStudio.workbench.project.pages[1].lines[0].id);
  const area = [40, 80, 70, 220];

  let b = await bar();
  check(b.shown && b.inside && !b.touch, "the select tool's bar shows 「囲んだもの」 chosen out of the box");
  await lasso(area);
  let got = await picked();
  check(got.length === 1 && got[0] === "stroke:short", `囲んだもの: only the line wholly inside is picked (${got.join(", ")})`);

  await page.click("#pick-touch");
  b = await bar();
  check(b.touch && !b.inside && b.stored === "touch", "「かかったもの」 is chosen and kept on this computer");
  await page.evaluate(() => window.nameStudio.workbench.editor.select(null));
  await lasso(area);
  got = await picked();
  const want = [`line:${lineId}`, `panel:${panelId}`, "stroke:long", "stroke:short"].sort();
  check(
    JSON.stringify(got) === JSON.stringify(want),
    `かかったもの: the lines, dialogue and panel it touches are picked (${got.join(", ")})`,
  );

  // The settings show the same and change the bar.
  await page.evaluate(() => window.nameStudio.workbench.settingsDialog.open());
  check((await page.inputValue("#st-pick-mode")) === "touch", "設定 › 操作 shows 「少しでもかかったもの」");
  await page.evaluate(() => {
    const select = document.getElementById("st-pick-mode");
    select.value = "inside";
    select.dispatchEvent(new Event("change"));
  });
  b = await bar();
  check(b.inside && !b.touch && b.stored === "inside", "choosing in the settings changes the bar and what is kept");
  await page.keyboard.press("Escape");

  // Other tools do not show it.
  await page.evaluate(() => window.nameStudio.workbench.setTool("pen"));
  check(!(await bar()).shown, "the choice is shown only for the select tool");

  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");
