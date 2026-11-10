// 使われ方 (設定 › この PC › 使われ方): the commands run by key and from the
// palette, the tools taken up and the exports written are counted on this
// computer only (nothing is sent: no command goes to the Rust side for it),
// shown most first by name, can be turned off, copied as text and cleared.
// Run: npm run e2e:usage
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const server = await createServer({ root, logLevel: "error", server: { port: 1492, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await context.addInitScript(() => {
    localStorage.setItem("namestudio.largeOffered", "1");
    // 消す… is asked first: the test says yes (the label of the first button).
    window.__answer = (command, args) => (command === "plugin:dialog|message" ? (args.buttons?.OkCancelCustom?.[0] ?? "Ok") : undefined);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  await page.evaluate(async () => {
    const { sampleName } = await import("/src/domain/samplename.ts");
    window.nameStudio.show(sampleName());
  });
  await page.waitForTimeout(300);
  await page
    .locator("#editor-canvas")
    .click({ position: { x: 5, y: 5 } })
    .catch(() => undefined);
  // The pen tool twice by key, back to 選択, and a page turned.
  for (const key of ["p", "v", "p", "v"]) await page.keyboard.press(key);
  await page.keyboard.press("ArrowLeft");
  // A command from the palette.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("画面のヘルプ");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");

  const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.usage") ?? "null"));
  await page.waitForTimeout(2500);
  const usage = await kept();
  check(usage?.days === 1, `the day is counted (${usage?.days})`);
  check(usage?.counts.tool.pen?.count === 2, `the pen taken up twice is counted (${JSON.stringify(usage?.counts.tool)})`);
  const commands = Object.keys(usage?.counts.command ?? {});
  check(
    commands.some((id) => id.startsWith("tool.")),
    `keys count as commands (${commands})`,
  );
  check(
    commands.some((id) => id.startsWith("help.")),
    `and so does the palette (${commands})`,
  );
  const sent = await page.evaluate(() => window.__calls.filter((call) => /usage|telemetry|analytics/i.test(call.command)).length);
  check(sent === 0, "nothing about it goes to the Rust side, let alone out");

  await page.click("#settings");
  await page.locator(".settings-nav-item", { hasText: "使われ方" }).click();
  const pane = page.locator('.settings-pane[data-pane="usage"]');
  check(await pane.isVisible(), "設定 › この PC › 使われ方 shows it");
  const tools = await pane.locator(".usage-kind", { hasText: "よく使う道具" }).textContent();
  check(tools.includes("ペン") && tools.includes("2 回"), `the tools by name, with how often (${tools})`);
  check((await page.locator("#st-usage-since").textContent()).includes("使った日 1 日"), "and on how many days");

  await page.locator("#st-usage-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(copied.startsWith("Name Studio の使われ方") && copied.includes("ペン: 2 回"), "it copies as text");

  await page.locator("#st-usage-on").uncheck();
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.keyboard.press("v");
  check((await kept()).counts.tool.pen.count === 2 && (await kept()).on === false, "turned off, nothing more is counted");

  await page.click("#settings");
  await page.locator(".settings-nav-item", { hasText: "使われ方" }).click();
  await page.locator("#st-usage-clear").click();
  await page.waitForTimeout(200);
  const cleared = await kept();
  check(Object.keys(cleared.counts.tool).length === 0 && cleared.on === false, "消す forgets it all (counting stays off)");
  check((await pane.locator(".usage-kind").first().textContent()).includes("まだありません"), "and the pane says there is nothing yet");
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
