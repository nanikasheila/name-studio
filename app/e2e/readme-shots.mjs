// The pictures in the README (docs/images): the app in a browser with the
// made-up name of e2e/demoname.js, the screens as stills and short moving
// pictures of the work (コマ割り, ペン, セリフ, 入れ替え, 保留) driven with the
// mouse as a person would. Needs ffmpeg for the GIFs and Japanese fonts (Noto CJK).
// The rough lines come from the author's drawings traced into lines (a JSON
// file kept outside the repository: README_ART, or the project's shared folder);
// without it simple figures stand in.
// Run: node e2e/readme-shots.mjs [out dir]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ?? fileURLToPath(new URL("../../docs/images", import.meta.url));
mkdirSync(out, { recursive: true });
const artPath = process.env.README_ART ?? "/mnt/project-files/readme-art/art.json";
const art = existsSync(artPath) ? JSON.parse(readFileSync(artPath, "utf8")) : null;
if (!art) console.warn(`no drawings at ${artPath}: simple figures stand in`);

const server = await createServer({ root, logLevel: "error", server: { port: 1461, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    // The version as a release shows it, and the export dialog's folders answered as a PC would.
    window.__answer = (command) => (command === "plugin:app|version" ? "0.2.94" : undefined);
    // A pointer drawn into the page: a headless browser shows none in its pictures.
    addEventListener("DOMContentLoaded", () => {
      const dot = document.createElement("div");
      dot.id = "shot-pointer";
      dot.style.cssText =
        "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid #fff;background:rgba(30,30,30,.55);box-shadow:0 0 0 1px rgba(0,0,0,.4);pointer-events:none;z-index:99999;display:none;transition:transform .05s";
      document.body.append(dot);
      addEventListener("pointermove", (e) => {
        dot.style.display = window.__pointer ? "block" : "none";
        dot.style.left = `${e.clientX}px`;
        dot.style.top = `${e.clientY}px`;
      }, true);
      addEventListener("pointerdown", () => (dot.style.transform = "scale(.65)"), true);
      addEventListener("pointerup", () => (dot.style.transform = ""), true);
    });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const settle = (ms = 300) => page.waitForTimeout(ms);
  const shot = (name, options = {}) => page.screenshot({ path: join(out, `${name}.png`), ...options });
  const viewButton = (label) => page.locator("#page-nav button", { hasText: label }).first();
  const tool = (label) => page.locator("#editor-tools button", { hasText: label }).first();
  const clientOf = (pageNumber, mm) =>
    page.evaluate(([n, mm]) => window.nameStudio.workbench.editor.clientOf(window.nameStudio.workbench.project.pages[n - 1].id, mm), [pageNumber, mm]);

  // The start screen.
  await settle(500);
  await shot("start");

  // The editor on the spread of pages 2 and 3.
  await page.evaluate(async (art) => {
    const { demoName } = await import("/e2e/demoname.js");
    window.nameStudio.show(demoName(art));
  }, art);
  await settle(600);
  await page.evaluate(() => window.nameStudio.workbench.editor.showPage(2));
  await settle(500);
  // Pick page 2 (an empty place on it), so that the right-hand panel tells of it.
  const [px, py] = await clientOf(2, [150, 395]);
  await page.mouse.click(px, py);
  await settle(400);
  await shot("editor");

  // 物語の帯を大きく (F6): the shape of the story, the scenes, the emotion curves and the pages.
  await page.keyboard.press("F6");
  await settle(700);
  await shot("story");
  await page.keyboard.press("F6");
  await settle(500);

  // 連続: every page on one canvas.
  await viewButton("連続").click();
  await settle(600);
  await page.evaluate(() => window.nameStudio.workbench.editor.setRows(2));
  await page.keyboard.press("Control+Alt+0");
  await settle(800);
  await shot("continuous");
  await viewButton("見開き").click();
  await settle(500);

  // 読む (F5): the name as the book.
  await page.keyboard.press("F5");
  await page.waitForFunction(() => document.querySelector("#reader .reader-caption")?.textContent);
  await settle(500);
  await shot("reader");
  await page.keyboard.press("Escape");
  await settle(400);

  // The export dialog.
  await page.locator("#name-export").click();
  await settle(600);
  await shot("export");
  await page.keyboard.press("Escape");
  await settle(300);

  let clip = null;
  /**
   * Zoom and pan so that the box from `a` (mm on page `pa`) to `b` (mm on page `pb`) fills
   * `height` px of the screen in its middle; the pictures are of it.
   */
  const look = async (pa, a, pb, b, height) => {
    await page.evaluate(
      ([pa, a, pb, b, height]) => {
        const { editor, project } = window.nameStudio.workbench;
        const [ida, idb] = [project.pages[pa - 1].id, project.pages[pb - 1].id];
        const stage = document.getElementById("editor-canvas").getBoundingClientRect();
        const [ax, ay] = editor.clientOf(ida, a);
        const [, by] = editor.clientOf(idb, b);
        editor.view.zoomAbout([ax - stage.left, ay - stage.top], (editor.view.zoom * height) / (by - ay));
        editor.draw();
        const [cx, cy] = editor.clientOf(ida, a);
        const [dx, dy] = editor.clientOf(idb, b);
        editor.view.dragBy(stage.left + stage.width / 2 - (cx + dx) / 2, stage.top + stage.height / 2 - (cy + dy) / 2);
        editor.draw();
      },
      [pa, a, pb, b, height],
    );
    await settle(300);
    const [ax, ay] = await clientOf(pa, a);
    const [bx, by] = await clientOf(pb, b);
    // No more than the canvas: not the bars round it.
    const r = await page.locator("#editor-canvas").boundingBox();
    const [x0, y0] = [Math.max(ax, r.x), Math.max(ay, r.y)];
    const [x1, y1] = [Math.min(bx, r.x + r.width), Math.min(by, r.y + r.height)];
    clip = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
  };

  /** Frames of what `act` does, made into a GIF that waits a while on the last frame. */
  async function film(name, act) {
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    let n = 0;
    const frame = async () => page.screenshot({ path: join(dir, `f${String(n++).padStart(4, "0")}.png`), clip });
    /** The mouse to `to` in steps, a frame every `every` of them. */
    const glide = async (from, to, steps, every = 2) => {
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
        if (i % every === 0 || i === steps) await frame();
      }
    };
    const hold = async (frames) => {
      for (let i = 0; i < frames; i++) await frame();
    };
    await act({ frame, glide, hold });
    await hold(18);
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-framerate", "12", "-i", join(dir, "f%04d.png"),
      "-vf", "split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none",
      "-loop", "0", join(out, `${name}.gif`),
    ]);
    rmSync(dir, { recursive: true, force: true });
  }
  let last = [0, 0];
  /** Drag from `from` to `to` (px), filmed: to it, press, along, let go. */
  const drag = async ({ glide, hold, frame }, from, to, steps = 14) => {
    await glide(last, from, 6);
    await page.mouse.down();
    await frame();
    await glide(last = from, to, steps, 1);
    await page.mouse.up();
    await hold(5);
    last = to;
  };
  const stage = async () => {
    const r = await page.locator("#editor-canvas").boundingBox();
    return [r.x + r.width - 30, r.y + 30];
  };

  // コマの入れ替え: page 3's last panel dragged by its number onto page 2's last one.
  await page.evaluate(() => window.nameStudio.workbench.editor.showPage(2));
  await settle(400);
  await tool("選択").click();
  await look(3, [44, 62], 2, [253, 358], 580);
  await page.evaluate(() => (window.__pointer = true));
  const badge = (pageNumber, mm) =>
    page.evaluate(
      ([n, mm]) => {
        const { editor, project } = window.nameStudio.workbench;
        const slot = editor.slots.find((s) => s.page.id === project.pages[n - 1].id);
        const { panelAt, panelBadge } = window.nameStudio.hittest;
        const { x, y } = panelBadge(slot, panelAt(slot.page, mm), project.pageFormat, project.pageFormat.canvasMm[0]);
        return editor.clientOf(slot.page.id, [(x - slot.x) / slot.scale, (y - slot.y) / slot.scale]);
      },
      [pageNumber, mm],
    );
  last = await stage();
  await page.mouse.move(...last);
  await film("swap", async (f) => {
    await f.hold(6);
    await drag(f, await badge(3, [150, 320]), await clientOf(2, [150, 320]), 22);
    await f.hold(8);
    // And back by the other: a variation tried and put back.
    await drag(f, await badge(2, [150, 200]), await clientOf(2, [100, 120]), 18);
  });

  // 保留: a panel of page 6 taken off into the 欄外, and later put into the empty panel of page 7.
  await page.evaluate(() => window.nameStudio.workbench.editor.showPage(6));
  await settle(400);
  await look(7, [30, -95], 6, [267, 365], 640);
  last = await stage();
  await page.mouse.move(...last);
  await film("hold", async (f) => {
    await f.hold(6);
    // Pick the panel by its border, so that the panel (not a line in it) is chosen.
    const pick = await page.evaluate(() => {
      const { project } = window.nameStudio.workbench;
      const panel = [...project.pages[5].panels].sort((a, b) => a.order - b.order)[2];
      const xs = panel.shape.map(([x]) => x);
      const ys = panel.shape.map(([, y]) => y);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys) - 0.3];
    });
    const on = await clientOf(6, pick);
    await f.glide(last, on, 10);
    await page.mouse.click(...on);
    last = on;
    await f.hold(5);
    const button = await page.locator(".action-bar button", { hasText: "保留" }).first().boundingBox();
    const press = [button.x + button.width / 2, button.y + button.height / 2];
    await f.glide(last, press, 8);
    await page.mouse.click(...press);
    last = press;
    await settle(200);
    await f.hold(10);
    const held = await page.evaluate(() => window.nameStudio.workbench.project.held.at(-1).at);
    await drag(f, await clientOf(6, [held[0] + 40, held[1] + 40]), await clientOf(7, [104, 124]), 26);
    await f.hold(4);
  });
  await page.evaluate(() => (window.__pointer = false));

  // Moving pictures of the tools: a fresh page in 単独, one tool at a time.
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { addPanel } = await import("/src/panels.ts");
    const { rectShape } = await import("/src/geometry.ts");
    const { basicBox } = await import("/src/pagebox.ts");
    const project = newProject("サンプル", 2);
    addPanel(project, project.pages[0], rectShape(basicBox(project.pageFormat)));
    window.nameStudio.show(project);
  });
  await settle(500);
  await viewButton("単独").click();
  await settle(500);
  await page.evaluate(() => (window.__pointer = true));
  const at = (mm) => clientOf(1, mm);

  await look(1, [44, 62], 1, [253, 358], 680);
  await tool("コマ割り").click();
  last = [clip.x + clip.width - 40, clip.y + 40];
  await page.mouse.move(...last);
  await film("komawari", async (f) => {
    await f.hold(6);
    for (const [a, b] of [[[50, 160], [247, 160]], [[150, 70], [150, 165]], [[50, 262], [247, 248]], [[110, 255], [128, 350]]])
      await drag(f, await at(a), await at(b));
  });

  // ペン: two of the author's figures drawn line by line (or two simple ones).
  await look(1, [52, 66], 1, [245, 166], 400);
  await tool("ペン").click();
  const figures = art
    ? [
        [art.chibi_hai, [176, 84, 238, 164]],
        [art.chibi_oo, [60, 90, 124, 164]],
      ]
    : [];
  await film("pen", async (f) => {
    // From mm to the screen once: the view stays as it is while drawing.
    const [o, u] = [await at([0, 0]), await at([100, 100])];
    const px = ([x, y]) => [o[0] + ((u[0] - o[0]) * x) / 100, o[1] + ((u[1] - o[1]) * y) / 100];
    const head = (cx, cy, r) => Array.from({ length: 25 }, (_, i) => [cx + Math.cos((i / 24) * 6.5) * r, cy + Math.sin((i / 24) * 6.5) * r]);
    const strokes = figures.length
      ? figures.flatMap(([crop, [x0, y0, x1, y1]]) => {
          const scale = Math.min((x1 - x0) / crop.w, (y1 - y0) / crop.h);
          const mm = ([x, y]) => [x0 + x * scale, y0 + y * scale];
          // Top to bottom, as one draws a figure: the head first.
          return [...crop.paths].sort((a, b) => Math.min(...a.map((q) => q[1])) - Math.min(...b.map((q) => q[1]))).map((path) => path.map(mm));
        })
      : [
          head(196, 112, 13), [[185, 125], [174, 145], [170, 156]], [[207, 125], [218, 145], [222, 156]],
          [[190, 111], [193, 111]], [[199, 111], [202, 111]],
          head(100, 116, 11), [[90, 127], [80, 145], [77, 156]], [[110, 127], [120, 145], [123, 156]],
        ];
    const total = strokes.reduce((n, points) => n + points.length, 0);
    // About 150 frames of drawing, however many lines there are.
    const every = Math.max(1, Math.round(total / 150));
    let moves = 0;
    await f.hold(4);
    for (const points of strokes) {
      const first = px(points[0]);
      await page.mouse.move(...first);
      await page.mouse.down();
      for (const point of points.slice(1)) {
        const [x, y] = px(point);
        await page.mouse.move(x, y, { steps: 2 });
        if (++moves % every === 0) await f.frame();
      }
      await page.mouse.up();
      last = px(points.at(-1));
    }
  });

  await tool("セリフ").click();
  await film("serifu", async (f) => {
    const target = await at([166, 96]);
    await f.glide(last, target, 8);
    await page.mouse.click(...target);
    await f.hold(4);
    for (const key of "はじめまして") {
      await page.keyboard.type(key);
      await f.hold(2);
    }
    await page.keyboard.press("Control+Enter");
    await f.hold(4);
    const second = await at([136, 100]);
    await f.glide(target, second, 8);
    await page.mouse.click(...second);
    await f.hold(3);
    for (const key of "よろしく！") {
      await page.keyboard.type(key);
      await f.hold(2);
    }
    await page.keyboard.press("Control+Enter");
    await f.hold(3);
    // しっぽ: each one turned to the one who speaks (the button in the panel on the right).
    await f.glide(second, await at([150, 160]), 6);
    await page.keyboard.press("Escape");
    await settle(200);
    await page.locator("button", { hasText: "しっぽのないセリフにしっぽを付ける" }).click();
    await f.hold(3);
  });
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`pictures in ${out}`);
