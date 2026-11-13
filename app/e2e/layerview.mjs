// The レイヤー palette as CSP's: page and panel folders open and shut (one by
// one and all at once), each row has its ミニビュー (なし・小・大, kept), and
// rows are told apart by lines. Run: npm run e2e:layerview
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1439, strictPort: false } });
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
    const { sampleName } = await import("/src/domain/samplename.ts");
    window.nameStudio.show(sampleName());
  });
  await page.waitForTimeout(300);
  await page.locator("#tab-layers-edit").click();
  await page.waitForTimeout(300);
  const rows = () => page.locator("#layer-rows .layer-row").count();
  const all = await rows();
  check(all > 5, `the page's panels and what is in them are listed (${all} rows)`);
  check((await page.locator("#layer-rows .layer-page.layer-folder").count()) >= 1, "the page is a folder");
  const thumbs = await page.locator("#layer-rows canvas.layer-thumb").count();
  check(thumbs >= all, `each row has its ミニビュー (${thumbs})`);
  const inked = await page.locator("#layer-rows .layer-row.layer-folder canvas.layer-thumb").first().evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
    return dark;
  });
  check(inked > 10, `a panel's ミニビュー shows what is drawn in it (${inked} dark pixels)`);
  const border = await page.locator("#layer-rows .layer-row").first().evaluate((row) => getComputedStyle(row).borderBottomStyle);
  check(border === "solid", "rows are parted by a line");
  check((await page.locator("#rough-layers canvas.layer-thumb").count()) >= 1, "the ラフ線のレイヤー have their ミニビュー too");

  // A panel folder shut and opened.
  const panelFold = page.locator("#layer-rows .layer-row.layer-folder .layer-fold").first();
  await panelFold.click();
  await page.waitForTimeout(100);
  const shut = await rows();
  check(shut < all, `shutting a panel's folder hides its rows (${all} → ${shut})`);
  await page.locator("#layer-rows .layer-row.layer-folder .layer-fold").first().click();
  await page.waitForTimeout(100);
  check((await rows()) === all, "opening it lists them again");

  // All at once.
  await page.getByRole("button", { name: "▸ すべてたたむ" }).click();
  await page.waitForTimeout(100);
  const folded = await rows();
  check(folded === (await page.locator("#layer-rows .layer-row.layer-folder").count()), `すべてたたむ leaves only the panels (${folded})`);
  await page.getByRole("button", { name: "▾ すべて開く" }).click();
  await page.waitForTimeout(100);
  check((await rows()) === all, "すべて開く lists everything again");

  // The page folder.
  await page.locator("#layer-rows .layer-page.layer-folder").first().click();
  await page.waitForTimeout(100);
  check((await rows()) === 0, "shutting the page's folder hides its panels");
  await page.locator("#layer-rows .layer-page.layer-folder").first().click();
  await page.waitForTimeout(100);

  // The ミニビュー's size, kept.
  await page.locator('.layer-thumb-size button[data-size="large"]').click();
  await page.waitForTimeout(150);
  const width = await page.locator("#layer-rows canvas.layer-thumb").first().evaluate((c) => c.getBoundingClientRect().width);
  check(width > 50, `大 makes them bigger (${width}px)`);
  await page.locator('.layer-thumb-size button[data-size="none"]').click();
  await page.waitForTimeout(150);
  check(!(await page.locator("#layer-rows canvas.layer-thumb").count()), "なし shows none");
  check((await page.evaluate(() => localStorage.getItem("namestudio.layerThumbs"))) === "none", "and it is kept for the next start");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
