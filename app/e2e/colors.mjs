// カラー: the 描画色 palette (circle, sliders, swatches, characters' colours),
// the pen and the fill drawing in it, スポイト (the button, Alt + click) and X.
// Run: npm run e2e:colors
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1441, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/domain/project.ts");
    const project = newProject("色", 2);
    project.characters = [{ id: "c1", name: "ミオ", color: "#d23c78" }];
    window.nameStudio.show(project);
  });
  await page.waitForTimeout(300);
  await page.locator("#tab-color").click();
  await page.waitForTimeout(200);
  const main = () => page.evaluate(() => document.querySelector(".color-hex").value);
  check((await main()) === "#000000", "the 描画色 starts black");
  check((await page.locator('.color-swatch.named[title="ミオ"]').count()) === 1, "the characters' colours are in the colour set");
  await page.locator('.color-swatch.named[title="ミオ"]').click();
  check((await main()) === "#d23c78", "a character's colour becomes the 描画色");

  // The circle: the square sets saturation and value.
  const wheel = await page.locator(".color-wheel").boundingBox();
  await page.mouse.click(wheel.x + wheel.width / 2 + 25, wheel.y + wheel.height / 2 - 25);
  const picked = await main();
  check(picked !== "#d23c78" && /^#[0-9a-f]{6}$/.test(picked), `the circle sets a colour (${picked})`);
  await page.locator(".color-hex").fill("#3a7bd5");
  await page.locator(".color-hex").press("Enter");
  check((await main()) === "#3a7bd5", "the hex field sets it");
  const hue = await page.locator('.color-slider input[aria-label="H"]').inputValue();
  check(Math.abs(Number(hue) - 215) <= 2, `the sliders follow (H ${hue})`);

  // The pen draws in it, and it is remembered as used.
  const box = await page.locator("#editor-canvas").boundingBox();
  const at = [box.x + box.width / 2 - 140, box.y + box.height / 2];
  await page.keyboard.press("p");
  await page.mouse.move(...at);
  await page.mouse.down();
  await page.mouse.move(at[0] + 60, at[1] + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const stroke = await page.evaluate(() => {
    const all = window.nameStudio.workbench.project.pages.flatMap((p) => p.strokes);
    return all[all.length - 1];
  });
  check(stroke?.color === "#3a7bd5", `the pen draws in the 描画色 (${stroke?.color})`);
  check((await page.locator('.color-history .color-swatch[data-color="#3a7bd5"]').count()) === 1, "and it goes into the カラー履歴");

  // X swaps メイン and サブ; black draws with no colour of its own.
  await page.keyboard.press("x");
  check((await main()) === "#ffffff", "X swaps the 描画色 with the サブ");
  await page.keyboard.press("x");
  await page.locator(".color-black").click();
  await page.mouse.move(at[0], at[1] + 40);
  await page.mouse.down();
  await page.mouse.move(at[0] + 60, at[1] + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const plain = await page.evaluate(() => {
    const all = window.nameStudio.workbench.project.pages.flatMap((p) => p.strokes);
    return all[all.length - 1];
  });
  check(plain && plain.color === undefined, "black lines keep no colour");

  // スポイト: Alt + click with the pen picks the colour under it.
  const onLine = await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector("#editor-canvas");
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const ctx = canvas.getContext("2d");
      // The darkest pixel near the middle of the blue line.
      let best = null;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const [r, g, b] = ctx.getImageData(Math.round((x - rect.left + dx) * ratio), Math.round((y - rect.top + dy) * ratio), 1, 1).data;
          if (b > r + 60 && (!best || r + g < best.sum)) best = { x: x + dx, y: y + dy, sum: r + g };
        }
      return best;
    },
    { x: at[0] + 30, y: at[1] + 10 },
  );
  await page.keyboard.down("Alt");
  await page.mouse.click(onLine?.x ?? at[0] + 30, onLine?.y ?? at[1] + 10);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(100);
  const sampled = await main();
  check(sampled !== "#000000" && /^#[0-9a-f]{6}$/.test(sampled), `Alt + click picks the colour off the page (${sampled})`);

  // The fill in 描画色.
  await page.locator(".color-swatch[data-color='#4caf50']").first().click();
  await page.keyboard.press("g");
  await page.waitForTimeout(100);
  await page.locator("#fill-color").click();
  const fillAt = [box.x + box.width / 2 - 200, box.y + box.height / 2 + 100];
  await page.mouse.move(...fillAt);
  await page.mouse.down();
  for (const [dx, dy] of [
    [40, 0],
    [40, 40],
    [0, 40],
    [0, 0],
  ])
    await page.mouse.move(fillAt[0] + dx, fillAt[1] + dy, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const fill = await page.evaluate(() => {
    const all = window.nameStudio.workbench.project.pages.flatMap((p) => p.fills ?? []);
    return all[all.length - 1];
  });
  check(fill?.color === "#4caf50", `the fill in 描画色 takes it (${fill?.color})`);

  // The colours are kept for the next start.
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.colors")));
  check(kept?.main === "#4caf50" && kept.history.includes("#3a7bd5"), "the colours are kept for the next start");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
