// ペンのカーソル (設定 › ペン・キー, ペン設定, 命令パレット): each kind shows as
// it says on the pages (the pen's size as a circle, with a cross or not; a
// cross, a dot or nothing as the system's cursor), and no cursor stays where
// the pen was: the pages are drawn into their picture and never read back
// from the screen (a desynchronized canvas can give back a frame shown
// before, with the cursor in it).
// Run: npm run e2e:cursor
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
  // Every time the editor's own canvas is drawn from (read back), counted.
  await page.addInitScript(() => {
    window.readBack = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
      if (image instanceof HTMLCanvasElement && image.id === "editor-canvas") window.readBack++;
      return draw.call(this, image, ...rest);
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    window.nameStudio.show(newProject("カーソル", 2));
    const wb = window.nameStudio.workbench;
    wb.editor.showPage(1);
    wb.editor.fitView();
    wb.setTool("pen");
  });
  await page.waitForTimeout(300);

  const cdp = await page.context().newCDPSession(page);
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const at = (mm) =>
    page.evaluate((mm) => {
      const wb = window.nameStudio.workbench;
      return wb.editor.clientOf(wb.project.pages[0].id, mm);
    }, mm);
  const pen = (type, [x, y], pressure = 0, buttons = 0) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" && !buttons ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "pen",
      force: pressure,
    });
  const hover = async (point) => {
    await pen("mouseMoved", point);
    await settle();
  };
  async function line(points) {
    await pen("mouseMoved", points[0]);
    await pen("mousePressed", points[0], 0.5, 1);
    for (const point of points.slice(1)) await pen("mouseMoved", point, 0.5, 1);
    await pen("mouseReleased", points[points.length - 1]);
    await settle();
  }
  /** How dark the screen is at a point (0: black … 765: white). */
  const lightAt = (x, y) =>
    page.evaluate(
      ([x, y]) => {
        const canvas = document.getElementById("editor-canvas");
        const box = canvas.getBoundingClientRect();
        const scale = canvas.width / box.width;
        const [r, g, b, a] = canvas
          .getContext("2d")
          .getImageData(Math.round((x - box.left) * scale), Math.round((y - box.top) * scale), 1, 1).data;
        return a ? r + g + b : 765;
      },
      [x, y],
    );
  /** The darkest point on a small square around a point (the cursor's lines are 1 px). */
  const darkestNear = async ([x, y], reach = 1) => {
    let darkest = 765;
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -reach; dy <= reach; dy++) darkest = Math.min(darkest, await lightAt(x + dx, y + dy));
    return darkest;
  };
  const choose = (look) =>
    page.evaluate((look) => {
      const select = document.getElementById("st-pen-cursor");
      select.value = look;
      select.dispatchEvent(new Event("change"));
    }, look);
  const radiusOf = (widthMm) =>
    page.evaluate((widthMm) => {
      const editor = window.nameStudio.workbench.editor;
      editor.penWidthMm = widthMm;
      return Math.max((widthMm / 2) * editor.slots[0].scale, 2);
    }, widthMm);
  const cssCursor = () => page.evaluate(() => document.getElementById("editor-canvas").style.cursor);

  await page.evaluate(() => window.nameStudio.workbench.settingsDialog.open());
  const options = await page.evaluate(() => [...document.getElementById("st-pen-cursor").options].map((o) => o.value));
  check(
    JSON.stringify(options) === JSON.stringify(["brush", "circle", "circleCross", "cross", "dot", "none"]),
    `設定 › ペン・キー lists the kinds (${options.join(", ")})`,
  );
  check((await page.inputValue("#st-pen-cursor")) === "brush", "out of the box: the brush's size (as before)");
  const sampleDrawn = await page.evaluate(() => {
    const canvas = document.getElementById("st-pen-cursor-look");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 100) dark++;
    return dark;
  });
  check(sampleDrawn > 20, `the setting shows how the cursor looks (${sampleDrawn} dark pixels)`);
  // Searching finds it.
  await page.fill("#st-search", "十字");
  check(await page.isVisible("#st-pen-cursor"), "searching the settings for 十字 finds ペンのカーソル");
  await page.fill("#st-search", "");
  // The kinds are chosen with the settings' list below; the pen goes over the pages with the dialog closed.
  await page.evaluate(() => document.getElementById("settings-dialog")?.close?.());
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => !document.querySelector("dialog[open]")), "the settings closed");

  const p = await at([60, 120]);
  const q = await at([140, 260]);
  // Each kind: what shows at the pen (a big pen: no cross with the brush's size; a thin one: with it).
  const big = await radiusOf(8);
  const looks = {};
  for (const look of options) {
    await choose(look);
    await hover([p[0] + 1, p[1]]);
    await hover(p);
    looks[look] = {
      css: await cssCursor(),
      ring: await darkestNear([p[0], p[1] - big]),
      tick: await darkestNear([p[0], p[1] - big - 4]),
    };
  }
  // The lines are 1 px, half on each of two pixels: grey, not black.
  const dark = (v) => v < 600;
  check(
    looks.brush.css === "none" && dark(looks.brush.ring) && !dark(looks.brush.tick),
    `ブラシの大きさ: a circle the pen's size (big pen, ${big.toFixed(1)} px: no cross)`,
  );
  check(looks.circle.css === "none" && dark(looks.circle.ring) && !dark(looks.circle.tick), "◯ だけ: the circle");
  check(
    looks.circleCross.css === "none" && dark(looks.circleCross.ring) && dark(looks.circleCross.tick),
    "◯ ＋ 十字: the circle with a cross around it",
  );
  check(looks.cross.css === "crosshair" && !dark(looks.cross.ring), "十字: the system's cross, no circle drawn");
  check(looks.dot.css.startsWith("url(") && !dark(looks.dot.ring), "点: a dot, no circle drawn");
  check(looks.none.css === "none" && !dark(looks.none.ring) && !dark(looks.none.tick), "出さない: nothing at all");

  // A thin pen: ブラシの大きさ puts a cross around it, ◯ だけ does not.
  const thin = await radiusOf(0.4);
  const thinTick = async (look) => {
    await choose(look);
    await hover([p[0] + 1, p[1]]);
    await hover(p);
    return darkestNear([p[0], p[1] - thin - 4]);
  };
  check(dark(await thinTick("brush")), "ブラシの大きさ: a thin pen gets a cross so it can be seen");
  check(!dark(await thinTick("circle")), "◯ だけ: no cross even for a thin pen");
  await page.click("#pen-settings");
  check((await page.inputValue("#pen-cursor")) === "circle", "ペン設定 shows the same kind");
  await page.keyboard.press("Escape");

  // No cursor stays behind: hover at P, then draw lines elsewhere, move away, draw again.
  await radiusOf(8);
  await choose("brush");
  await hover(p);
  check(dark(await darkestNear([p[0], p[1] - big])), "the cursor shows at the pen");
  const before = await page.evaluate(() => window.readBack);
  for (let n = 0; n < 4; n++) {
    await line(Array.from({ length: 30 }, (_, i) => [q[0] + i * 4, q[1] + n * 12 + Math.sin(i / 4) * 6]));
    await hover([q[0] - 30, q[1] + n * 12]);
  }
  await page.evaluate(() => window.nameStudio.workbench.editor.zoomBy?.(1.1));
  await settle();
  await hover([q[0] - 40, q[1]]);
  const stayed = await darkestNear([p[0], p[1] - big]);
  check(!dark(stayed), `after drawing elsewhere no cursor stays where the pen was (${stayed})`);
  const readBack = (await page.evaluate(() => window.readBack)) - before;
  check(readBack === 0, `the pages are never read back from the screen (${readBack})`);

  // 命令パレット: the next kind each time, round to the first.
  const kinds = [];
  for (let i = 0; i < options.length; i++) {
    await page.evaluate(() => window.nameStudio.workbench.run("pen.cursorNext"));
    kinds.push(await page.evaluate(async () => (await import("/src/platform/prefs.ts")).penPreferences.settings.cursor));
  }
  check(
    JSON.stringify(kinds) === JSON.stringify([...options.slice(1), options[0]]),
    `「ペンのカーソルの形を切り替える」 goes through them in turn (${kinds.join(" → ")})`,
  );
  check(
    await page.evaluate(() => localStorage.getItem("namestudio.pen")?.includes('"cursor":"brush"') ?? true),
    "the kind is kept on this computer",
  );

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
