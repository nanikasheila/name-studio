// Does a desynchronized (低遅延) canvas give back, when drawn from, a frame
// shown before? name-studio's editor (before the fix) drew the pages onto
// its desynchronized screen and then copied the screen into its picture of
// the pages; if the copy holds the frame before (with the pen's cursor in
// it), that cursor stays on the pages.
// Each trial: frame 1 shows a black square (the cursor) at A over white.
// Frame 2 clears, paints white (the pages), copies the screen into another
// canvas (the old keepCache), then draws the cursor at B. The copy should be
// all white; black at A means it held the frame shown before.
// Run on a PC with a GPU (Windows: Edge is the engine of WebView2): node e2e/desyncprobe.mjs [msedge|chrome|chromium]
import { chromium } from "playwright";

const channel = process.argv[2] ?? "msedge";
const browser = await chromium.launch({ channel: channel === "chromium" ? undefined : channel, headless: process.env.HEADLESS === "1" });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.setContent("<body style='margin:0;background:#888'></body>");
const result = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const out = {};
  for (const desynchronized of [true, false]) {
    const c = document.createElement("canvas");
    c.width = 800;
    c.height = 600;
    document.body.replaceChildren(c);
    const ctx = c.getContext("2d", { desynchronized });
    const cache = document.createElement("canvas");
    cache.width = 800;
    cache.height = 600;
    const cc = cache.getContext("2d");
    let stale = 0;
    let partial = 0;
    const trials = 120;
    for (let i = 0; i < trials; i++) {
      const ax = 50 + ((i * 37) % 600);
      const bx = 50 + (((i + 7) * 53) % 600);
      // Frame 1: the pages and the cursor at A.
      await frame();
      ctx.clearRect(0, 0, 800, 600);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = "#000";
      ctx.fillRect(ax, 300, 12, 12);
      // Frame 2: drawn anew, copied, the cursor at B.
      await frame();
      ctx.clearRect(0, 0, 800, 600);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 300 - 50, 800, 400);
      ctx.fillRect(0, 0, 800, 600);
      cc.clearRect(0, 0, 800, 600);
      cc.drawImage(c, 0, 0);
      const px = cc.getImageData(ax + 6, 306, 1, 1).data;
      const top = cc.getImageData(400, 10, 1, 1).data;
      if (px[0] < 128 && px[3] > 0) stale++;
      if (top[3] === 0) partial++;
      ctx.fillStyle = "#000";
      ctx.fillRect(bx, 300, 12, 12);
    }
    out[desynchronized ? "desynchronized" : "normal"] = { trials, staleCursorInCopy: stale, emptyCopy: partial };
  }
  out.userAgent = navigator.userAgent;
  return out;
});
console.log(JSON.stringify({ channel, ...result }, null, 2));
await browser.close();
