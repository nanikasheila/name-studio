// まとめて設定: several セリフ (over a 見開き's two pages), コマ, rough lines
// and 塗り picked together get their common fields in the right panel. A
// field whose things differ shows mixed; a change sets them all, one undo step.
// Run: npm run e2e:bulkedit
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1453, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const { addLine } = await import("/src/domain/dialogue.ts");
    const { addPanel } = await import("/src/domain/panels.ts");
    const { addCharacter } = await import("/src/domain/cast.ts");
    const { rectShape } = await import("/src/model/geometry.ts");
    const project = newProject("まとめて", 4);
    const [, right, left] = project.pages;
    addCharacter(project, "ストラ");
    addCharacter(project, "エイコ");
    const a = addLine(project, right, [60, 80], "うわ");
    const b = addLine(project, right, [100, 120], "あなたは");
    const c = addLine(project, left, [120, 100], "そうなの");
    a.speaker = project.characters[0].id;
    b.speaker = project.characters[0].id;
    c.speaker = project.characters[1].id;
    b.fontSizePt = 16;
    a.edge = true;
    a.tails = [{ tip: [40, 110] }];
    addPanel(project, right, rectShape([20, 20, 90, 100]));
    addPanel(project, right, rectShape([100, 20, 170, 100])).border = "thick";
    right.strokes.push(
      {
        id: "s1",
        points: [
          [50, 160, 1],
          [80, 170, 1],
        ],
        widthMm: 0.4,
        closed: false,
      },
      {
        id: "s2",
        points: [
          [60, 180, 1],
          [90, 190, 1],
        ],
        widthMm: 0.4,
        closed: false,
        color: "#ff0000",
      },
    );
    window.nameStudio.show(project);
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(2);
    wb.editor.fitView();
    wb.setTool("select");
  });
  await page.waitForTimeout(300);
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pick = (items) =>
    page.evaluate((items) => {
      const wb = window.nameStudio.workbench;
      const right = wb.project.pages[1];
      const left = wb.project.pages[2];
      const resolved = items.map(([kind, which, index]) => {
        const on = which === "left" ? left : right;
        const list = { line: on.lines, panel: on.panels, stroke: on.strokes }[kind];
        const item = { kind, id: list[index].id };
        return which === "left" ? { ...item, pageId: left.id } : item;
      });
      wb.editor.select({ kind: "group", pageId: right.id, id: "group", items: resolved });
    }, items);
  const lines = () =>
    page.evaluate(() => {
      const [, right, left] = window.nameStudio.workbench.project.pages;
      return [...right.lines, ...left.lines].map((l) => ({
        speaker: l.speaker,
        size: l.fontSizePt,
        edge: !!l.edge,
        shape: l.balloonShape,
        font: l.font,
        kind: l.kind,
        vertical: l.vertical,
        tails: (l.tails ?? []).map((t) => t.style),
      }));
    });
  const field = (section, label) => page.locator(`#inspector .bulk-${section} label`, { hasText: new RegExp(`^${label}`) });
  const undo = async () => {
    await blur();
    await page.keyboard.press("Control+z");
    await settle();
  };

  // Three セリフ over the 見開き: one section, mixed fields shown as such.
  await pick([
    ["line", "right", 0],
    ["line", "right", 1],
    ["line", "left", 0],
  ]);
  await settle();
  check((await page.locator("#inspector .bulk-line h3").textContent()) === "セリフ 3 個", "the right panel has a セリフ 3 個 section");
  const speaker = field("line", "話者").locator("select");
  check((await speaker.inputValue()) === "__mixed", "話者 differs: shown as いろいろ");
  const size = field("line", "文字の大きさ").locator("input");
  check((await size.inputValue()) === "" && (await size.getAttribute("placeholder")) === "（いろいろ）", "文字の大きさ differs: empty");
  const edge = field("line", "白縁").locator("input");
  check(await edge.evaluate((box) => box.indeterminate), "白縁 differs: half-ticked");
  check((await page.locator("#editor-actions select, .action-bar select").first().count()) === 1, "the bar beside them has their 種類");

  // 話者 for all, one undo step.
  const firstId = await page.evaluate(() => window.nameStudio.workbench.project.characters[1].id);
  await speaker.selectOption(firstId);
  await settle();
  let now = await lines();
  check(
    now.every((l) => l.speaker === firstId),
    "話者 set for all three (over both pages)",
  );
  check((await field("line", "話者").locator("select").inputValue()) === firstId, "…and shown as one now");
  await undo();
  now = await lines();
  check(now[0].speaker !== firstId && now[2].speaker === firstId, "one Ctrl+Z puts every 話者 back");

  // 文字の大きさ typed in: all the same size.
  await pick([
    ["line", "right", 0],
    ["line", "right", 1],
    ["line", "left", 0],
  ]);
  await settle();
  await field("line", "文字の大きさ").locator("input").fill("18");
  await field("line", "文字の大きさ").locator("input").press("Enter");
  await settle();
  now = await lines();
  check(
    now.every((l) => l.size === 18),
    "文字の大きさ 18 for all",
  );
  await undo();
  now = await lines();
  check(now[1].size === 16 && now[0].size !== 18, "one Ctrl+Z puts the sizes back");

  // 白縁 ticked, 形, 縦書き, フォント, しっぽ.
  await pick([
    ["line", "right", 0],
    ["line", "right", 1],
    ["line", "left", 0],
  ]);
  await settle();
  await field("line", "白縁").locator("input").click();
  await settle();
  check(
    (await lines()).every((l) => l.edge),
    "白縁 on for all",
  );
  await field("line", "フキダシの形").locator("select").selectOption("cloud");
  await settle();
  check(
    (await lines()).every((l) => l.shape === "cloud"),
    "フキダシの形 for all",
  );
  await field("line", "しっぽの形").locator("select").selectOption("bubbles");
  await settle();
  check((await lines())[0].tails.join() === "bubbles", "しっぽの形 for every tail");
  const font = field("line", "フォント").locator("input[type=text]");
  await font.fill("メイリオ");
  await font.press("Enter");
  await settle();
  check(
    (await lines()).every((l) => l.font === "メイリオ"),
    "フォント for all",
  );
  await field("line", "フォント").locator(".font-clear").click();
  await settle();
  check(
    (await lines()).every((l) => l.font === undefined),
    "× clears the フォント of all",
  );
  const kindSelect = field("line", "種類").locator("select");
  await kindSelect.selectOption("kind:thought");
  await settle();
  check(
    (await lines()).every((l) => l.kind === "thought"),
    "種類 for all",
  );

  // Two panels: 枠線 mixed (solid / thick), set to 破線 for both.
  await pick([
    ["panel", "right", 0],
    ["panel", "right", 1],
  ]);
  await settle();
  check((await page.locator("#inspector .bulk-panel h3").textContent()) === "コマ 2 つ", "two panels: a コマ 2 つ section");
  const border = field("panel", "枠線$|枠線（").first().locator("select");
  check((await border.inputValue()) === "__mixed", "枠線 differs: いろいろ");
  await border.selectOption("dashed");
  await settle();
  const borders = await page.evaluate(() => window.nameStudio.workbench.project.pages[1].panels.map((p) => p.border));
  check(borders.join() === "dashed,dashed", "枠線 破線 for both");
  await field("panel", "上").locator("input").click();
  await settle();
  const bled = await page.evaluate(async () => {
    const { isBled } = await import("/src/domain/koma.ts");
    const project = window.nameStudio.workbench.project;
    return project.pages[1].panels.map((p) => isBled(p, "top", project.pageFormat));
  });
  check(bled.join() === "true,true", "裁ち切り（上）for both");

  // Rough lines: 太さ, 色.
  await pick([
    ["stroke", "right", 0],
    ["stroke", "right", 1],
  ]);
  await settle();
  const width = field("stroke", "太さ").locator("input");
  check((await width.inputValue()) === "0.4", "線の太さ alike: shown");
  await width.fill("1.2");
  await settle();
  await page.waitForTimeout(800);
  const strokes = () => page.evaluate(() => window.nameStudio.workbench.project.pages[1].strokes.map((s) => [s.widthMm, s.color]));
  check(
    (await strokes()).every(([w]) => w === 1.2),
    "線の太さ 1.2 for both (live)",
  );
  await field("stroke", "色").locator("button", { hasText: "黒に戻す" }).click();
  await settle();
  check(
    (await strokes()).every(([, color]) => color === undefined),
    "黒に戻す for both",
  );

  // Mixed: a section for each kind.
  await pick([
    ["line", "right", 0],
    ["panel", "right", 0],
    ["stroke", "right", 0],
  ]);
  await settle();
  check(
    (await page.locator("#inspector .bulk-kind h3").allTextContents()).join("・") === "セリフ 1 個・コマ 1 つ・線 1 本",
    "セリフ・コマ・線 picked together: a section each",
  );

  // One rough line on its own: 太さ and 色 too.
  await page.evaluate(() => {
    const wb = window.nameStudio.workbench;
    wb.editor.select({ kind: "stroke", pageId: wb.project.pages[1].id, id: "s1" });
  });
  await settle();
  check((await page.locator("#inspector label", { hasText: "太さ" }).count()) === 1, "one rough line: its 太さ in the right panel");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
