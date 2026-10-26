// Each name remembers how it was written out last, and 「前回と同じ設定で書き出す」
// (Ctrl+Shift+E) writes it out again without a question. Run: npm run e2e:exportagain
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const A = "C:\\ネーム\\第4話.namestudio";
const B = "C:\\ネーム\\第5話.namestudio";

const server = await createServer({ root, logLevel: "error", server: { port: 1437, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript({ path: fileURLToPath(new URL("tauri-mock.js", import.meta.url)) });
  await page.addInitScript(() => {
    window.__dialogs = [];
    window.__answer = (command) => {
      switch (command) {
        case "write_text_file":
          return null;
        case "plugin:dialog|save":
        case "plugin:dialog|open":
          return window.__dialogs.shift() ?? null;
        default:
          return undefined;
      }
    };
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.nameStudio);
  const show = (path, title) =>
    page.evaluate(
      async ([path, title]) => {
        const { newProject } = await import("/src/project.ts");
        window.nameStudio.show(newProject(title, 4));
        window.nameStudio.workbench.show(newProject(title, 4), path, "");
      },
      [path, title],
    );
  const calls = (command) => page.evaluate((command) => window.__calls.filter((c) => c.command === command).map((c) => c.args), command);
  const message = () => page.locator("#ne-message").textContent();
  const dialog = page.locator("#name-export-dialog");
  const settle = () => page.waitForTimeout(200);

  await show(A, "第4話");
  await page.keyboard.press("Control+Shift+E");
  await settle();
  check(await dialog.evaluate((d) => d.open), "the first time, Ctrl+Shift+E opens the export dialog");
  check((await message()).includes("まだ書き出していません"), "and says the settings are kept from the first export on");

  await page.locator("#ne-kind-text").click();
  await page.evaluate(() => window.__dialogs.push("C:\\out\\第4話_台本.txt"));
  await page.locator("#ne-run").click();
  await settle();
  check((await calls("write_text_file")).at(-1)?.path === "C:\\out\\第4話_台本.txt", "the script is written where it was asked");
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("namestudio.exportMemory")));
  const mine = kept["c:/ネーム/第4話.namestudio"];
  check(mine?.kind === "text" && mine.files.text === "C:\\out\\第4話_台本.txt", "how the name was written out is kept for it");
  await page.keyboard.press("Escape");

  const asked = (await calls("plugin:dialog|save")).length;
  await page.keyboard.press("Control+Shift+E");
  await settle();
  check((await calls("write_text_file")).length === 2, "Ctrl+Shift+E writes it out again");
  check((await calls("plugin:dialog|save")).length === asked, "without asking where");
  check((await message()).startsWith("書き出しました"), "and the dialog shows it was done");
  check((await page.locator("#status").textContent()).includes("書き出しました"), "and so does the status");
  await page.keyboard.press("Escape");

  // Another name starts from its own last export, never from this one's folder.
  await page.evaluate(
    ([key, now]) => {
      const kept = JSON.parse(localStorage.getItem("namestudio.exportMemory"));
      kept[key] = {
        timeMs: now,
        kind: "csp",
        form: { template: "", outDir: "C:\\out\\第5話", fit: "basic", makeWork: true, workTemplate: "", workName: "第5話", storyIndex: "5" },
        mode: "builtin",
        panels: "masks",
        editable: true,
        draftRough: true,
        notes: false,
        pdf: { area: "trim", dpi: 300 },
        files: {},
      };
      localStorage.setItem("namestudio.exportMemory", JSON.stringify(kept));
    },
    ["c:/ネーム/第5話.namestudio", Date.now()],
  );
  await show(B, "第5話");
  await page.locator("#name-export").click();
  await settle();
  check((await page.locator("#ne-out-dir").textContent()) === "C:\\out\\第5話", "another name opens with its own folder");
  check(await page.locator("#ne-kind-csp").evaluate((b) => b.classList.contains("active")), "and its own kind of export");
  check((await page.locator("#ne-panels").inputValue()) === "masks" && !(await page.locator("#ne-notes").isChecked()), "and its own layer choices");
  check((await page.locator("#ne-story-index").inputValue()) === "5", "and its story number");
  await page.keyboard.press("Escape");

  await show(A, "第4話");
  await page.locator("#name-export").click();
  await settle();
  check((await page.locator("#ne-out-dir").textContent()) === "未選択", "back on the first name, not the other name's folder");
  check(await page.locator("#ne-kind-text").evaluate((b) => b.classList.contains("active")), "but the first name's own settings");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await page.locator("#command-palette input").fill("前回");
  check((await page.locator("#command-palette .cmdp-item.current .cmdp-label").textContent()) === "前回と同じ設定で書き出す", "the command palette finds it");
  check((await page.locator("#command-palette .cmdp-item.current .cmdp-keys").textContent()) === "Ctrl+Shift+E", "with its keys");
  await page.keyboard.press("Escape");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
