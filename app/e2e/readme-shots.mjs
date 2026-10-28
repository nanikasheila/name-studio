// The pictures in the README (docs/images): the app in a browser with the
// made-up name of e2e/demoname.js, the screens as stills and three short
// moving pictures of the work (コマ割り, ペン, セリフ) driven with the mouse
// as a person would. Needs ffmpeg for the GIFs and Japanese fonts (Noto CJK).
// Run: node e2e/readme-shots.mjs [out dir]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ?? fileURLToPath(new URL("../../docs/images", import.meta.url));
mkdirSync(out, { recursive: true });

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
  await page.evaluate(async () => {
    const { demoName } = await import("/e2e/demoname.js");
    window.nameStudio.show(demoName());
  });
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

  // Moving pictures: a fresh page in 単独, one tool at a time.
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
  let clip = null;
  /** Zoom and pan so that the page's `box` (mm) fills `height` px of the screen in its middle; the pictures are of it. */
  const look = async ([x0, y0, x1, y1], height) => {
    await page.evaluate(
      ([box, height]) => {
        const { editor, project } = window.nameStudio.workbench;
        const id = project.pages[0].id;
        const stage = document.getElementById("editor-canvas").getBoundingClientRect();
        const [ax, ay] = editor.clientOf(id, [box[0], box[1]]);
        const [, by] = editor.clientOf(id, [box[2], box[3]]);
        editor.view.zoomAbout([ax - stage.left, ay - stage.top], (editor.view.zoom * height) / (by - ay));
        editor.draw();
        const [cx, cy] = editor.clientOf(id, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
        editor.view.dragBy(stage.left + stage.width / 2 - cx, stage.top + stage.height / 2 - cy);
        editor.draw();
      },
      [[x0, y0, x1, y1], height],
    );
    await settle(300);
    const [ax, ay] = await at([x0, y0]);
    const [bx, by] = await at([x1, y1]);
    clip = { x: Math.round(ax), y: Math.round(ay), width: Math.round(bx - ax), height: Math.round(by - ay) };
  };

  /** Frames of what `act` does, made into a GIF that waits a while on the last frame. */
  async function film(name, act) {
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    let n = 0;
    const frame = async () => page.screenshot({ path: join(dir, `f${String(n++).padStart(4, "0")}.png`), clip });
    /** The mouse to `to` in steps, a frame each. */
    const glide = async (from, to, steps, down = false) => {
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
        if (i % (down ? 1 : 2) === 0) await frame();
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

  /** Drag from `a` to `b` (mm on page 1), filmed. */
  const drag = async ({ glide, hold, frame }, a, b, steps = 14) => {
    const [from, to] = [await at(a), await at(b)];
    await glide(await page.evaluate(() => window.__last ?? [0, 0]), from, 6);
    await page.mouse.down();
    await frame();
    await glide(from, to, steps, true);
    await page.mouse.up();
    await hold(5);
    await page.evaluate((p) => (window.__last = p), to);
  };

  await look([44, 62, 253, 358], 680);
  await tool("コマ割り").click();
  await page.mouse.move(clip.x + clip.width - 40, clip.y + 40);
  await page.evaluate(([x, y]) => (window.__last = [x, y]), [clip.x + clip.width - 40, clip.y + 40]);
  await film("komawari", async (f) => {
    await f.hold(6);
    await drag(f, [50, 160], [247, 160]);
    await drag(f, [150, 70], [150, 165]);
    await drag(f, [50, 262], [247, 248]);
    await drag(f, [110, 255], [128, 350]);
  });

  await look([52, 66, 245, 166], 400);
  await tool("ペン").click();
  await film("pen", async (f) => {
    const head = (cx, cy, r) => Array.from({ length: 25 }, (_, i) => [cx + Math.cos((i / 24) * 6.5) * r, cy + Math.sin((i / 24) * 6.5) * r]);
    const strokes = [
      head(196, 112, 13),
      [[185, 125], [174, 145], [170, 156]],
      [[207, 125], [218, 145], [222, 156]],
      [[190, 111], [193, 111]],
      [[199, 111], [202, 111]],
      head(100, 116, 11),
      [[90, 127], [80, 145], [77, 156]],
      [[110, 127], [120, 145], [123, 156]],
    ];
    await f.hold(4);
    for (const points of strokes) {
      const first = await at(points[0]);
      await f.glide(await page.evaluate(() => window.__last ?? [0, 0]), first, 4);
      await page.mouse.down();
      for (let i = 1; i < points.length; i++) {
        const [from, to] = [await at(points[i - 1]), await at(points[i])];
        await f.glide(from, to, points.length > 4 ? 1 : 6, true);
      }
      await page.mouse.up();
      await page.evaluate((p) => (window.__last = p), await at(points.at(-1)));
    }
  });

  await tool("セリフ").click();
  await film("serifu", async (f) => {
    const target = await at([226, 104]);
    await f.glide(await page.evaluate(() => window.__last ?? [0, 0]), target, 8);
    await page.mouse.click(...target);
    await f.hold(4);
    for (const key of "はじめまして") {
      await page.keyboard.type(key);
      await f.hold(2);
    }
    await page.keyboard.press("Control+Enter");
    await f.hold(4);
    const second = await at([136, 102]);
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
