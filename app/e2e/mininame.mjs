// ミニネーム and ネーム画像, through the screens: a name sheet picture made into
// a new name from the start screen (its 32 touching pages found, read half by
// half, laid by their inner frame on the 基本枠); a name written out as a
// ミニネーム (PNG and a one-page PDF) and taken back in, page for page, onto
// the trim; undo; a picture of the name that no longer reads is named before
// anything is written (stop, or write without it), and so are the roughs of a
// name sheet moved since (stop, choose the sheet again, or write without
// them). Each page carries a bar at its own height, so that a page
// out of order or out of place is seen.
// Run: npm run e2e:mininame (-- --shots <dir> keeps the pictures).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
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
  await page.addInitScript(() => {
    window.__dialogs = [];
    window.__asked = [];
    window.__answer = (command, args) => {
      switch (command) {
        case "plugin:dialog|message": {
          // Asked before writing: the button the test picks (the first, or the second when it declines).
          window.__asked.push(args.message);
          const three = args.buttons?.YesNoCancelCustom;
          if (three) return three[window.__roughChoice ?? 2];
          const custom = args.buttons?.OkCancelCustom;
          return custom ? custom[window.__decline ? 1 : 0] : "Ok";
        }
        case "plugin:dialog|open":
          window.__opened = args.options;
          return window.__sheetPicked ?? null;
        case "rough_image": {
          // The sheet the name was made from was moved: only the one chosen again reads.
          window.__roughReads = (window.__roughReads ?? []).concat(args.sheet);
          if (!args.sheet.startsWith("D:")) throw `${args.sheet}: 指定されたファイルが見つかりません。 (os error 2)`;
          const canvas = new OffscreenCanvas(40, 60);
          canvas.getContext("2d").fillRect(0, 0, 40, 60);
          return canvas.convertToBlob({ type: "image/png" }).then((blob) => blob.arrayBuffer());
        }
        case "write_binary_file":
        case "write_pdf":
          return null;
        case "plugin:dialog|save":
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
  await page.evaluate(() => localStorage.clear());

  /** For each page of the open name: where its picture of the name lies (mm) and where in it the bar is (0–1 of its height). */
  const pictures = () =>
    page.evaluate(async () => {
      const project = window.nameStudio.workbench.project;
      const out = [];
      for (const p of project.pages) {
        const names = (p.references ?? []).filter((r) => r.kind === "name");
        if (names.length !== 1) {
          out.push({ count: names.length });
          continue;
        }
        const stored = project.images.find((i) => i.id === names[0].image);
        const bytes = Uint8Array.from(atob(stored.dataBase64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: stored.mime }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        // The longest dark run down the middle column is the bar.
        const x = Math.round(bitmap.width * 0.5);
        const column = ctx.getImageData(x, 0, 1, bitmap.height).data;
        let best = { length: 0, at: -1 };
        let start = -1;
        for (let y = 0; y <= bitmap.height; y++) {
          const dark = y < bitmap.height && column[y * 4] < 100;
          if (dark && start < 0) start = y;
          if (!dark && start >= 0) {
            if (y - start > best.length) best = { length: y - start, at: (start + y) / 2 / bitmap.height };
            start = -1;
          }
        }
        // The blue frame inside (a name sheet's 基本枠), where there is one: its lines across the middle.
        const blue = (data, k) => data[k * 4 + 2] > data[k * 4] + 60;
        const across = ctx.getImageData(0, Math.round(bitmap.height / 2), bitmap.width, 1).data;
        const down = ctx.getImageData(Math.round(bitmap.width * 0.4), 0, 1, bitmap.height).data;
        const xs = [...Array(bitmap.width).keys()].filter((k) => blue(across, k));
        const ys = [...Array(bitmap.height).keys()].filter((k) => blue(down, k));
        const [x0, y0, x1, y1] = names[0].box;
        const inner = xs.length && ys.length
          ? [x0 + ((xs[0] + 0.5) / bitmap.width) * (x1 - x0), y0 + ((ys[0] + 0.5) / bitmap.height) * (y1 - y0), x0 + ((xs.at(-1) + 0.5) / bitmap.width) * (x1 - x0), y0 + ((ys.at(-1) + 0.5) / bitmap.height) * (y1 - y0)]
          : null;
        out.push({ count: 1, box: names[0].box, bar: best.at, opacity: names[0].opacity, inner });
      }
      return out;
    });
  const boxes = () => page.evaluate(async () => {
    const { trimBox, basicBox } = await import("/src/pagebox.ts");
    const format = window.nameStudio.workbench.project.pageFormat;
    return { trim: trimBox(format), basic: basicBox(format) };
  });

  // --- a name sheet picture into a new name, from the start screen ---------------------------
  // Two halves of 4 x 4 pages (right half first), the pages of a row touching, a 基本枠 inside each, as CSP writes a name sheet out.
  const SHEET = { left: [100, 1460], top: 80, w: 300, h: 425, gap: 24, inset: [36, 40] };
  const sheet = await page.evaluate((S) => {
    const canvas = document.createElement("canvas");
    canvas.width = 2900;
    canvas.height = 2000;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let number = 0;
    for (const left of [S.left[1], S.left[0]]) {
      for (let row = 0; row < 4; row++) {
        for (let column = 3; column >= 0; column--) {
          number++;
          const x = left + column * S.w;
          const y = S.top + row * (S.h + S.gap);
          ctx.strokeStyle = "#111";
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 1.5, y + 1.5, S.w - 3, S.h - 3);
          ctx.strokeStyle = "#3355cc";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + S.inset[0], y + S.inset[1], S.w - 2 * S.inset[0], S.h - 2 * S.inset[1]);
          ctx.fillStyle = "#c00";
          ctx.font = "16px sans-serif";
          ctx.fillText(String(number), x + 6, y + 20);
          // The bar: lower on each later page.
          ctx.fillStyle = "#000";
          ctx.fillRect(x + S.w * 0.3, y + S.h * (0.12 + number * 0.022), S.w * 0.4, 6);
          // A panel line reaching the inner frame.
          ctx.fillRect(x + S.w * 0.65, y + S.inset[1], 2, S.h - 2 * S.inset[1]);
        }
      }
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, SHEET);
  if (shots) writeFileSync(`${shots}/sheet.png`, Buffer.from(sheet, "base64"));

  await page.locator("#start-image").click();
  const dialog = page.locator("#image-import-dialog");
  check(await dialog.evaluate((d) => d.open), "ネーム画像から… opens the dialog on the start screen");
  check((await page.locator("#ii-title").textContent()).includes("新しいネーム"), "to make a new name");
  await page.setInputFiles("#ii-input", { name: "第4話ネーム用紙.png", mimeType: "image/png", buffer: Buffer.from(sheet, "base64") });
  await page.waitForFunction(() => document.getElementById("ii-summary").textContent.includes("見つけました"));
  const summary = await page.locator("#ii-summary").textContent();
  check(summary.includes("32 ページ見つけました"), `the 32 touching pages are found (${summary.slice(0, 20)})`);
  check((await page.locator("#ii-order").inputValue()) === "blocks-rtl", "read half by half, the right half first");
  check((await page.locator("#ii-fit").inputValue()) === "inner", "laid by the frame inside the pages");
  if (shots) await dialog.screenshot({ path: `${shots}/dialog-sheet.png` });
  await page.locator("#ii-run").click();
  await page.waitForFunction(() => window.nameStudio.workbench.project?.pages.length === 32);
  check(!(await dialog.evaluate((d) => d.open)), "the dialog closes");
  check((await page.locator("#file-name").textContent()).includes("第4話ネーム用紙"), "the new name is named after the picture");
  {
    const got = await pictures();
    const { basic } = await boxes();
    check(got.every((p) => p.count === 1), "each of the 32 pages has its picture of the name");
    const bars = got.map((p) => p.bar);
    const inOrder = bars.every((bar, i) => i === 0 || bar > bars[i - 1]);
    check(inOrder, `the pages are in reading order (bars ${bars.slice(0, 5).map((b) => b.toFixed(3)).join(" ")} …)`);
    // The 基本枠 of the picture (its inner frame) lies on the name's 基本枠.
    // The inner frame's shape is not quite the 基本枠's: fitted inside it, centred, on every page.
    let off = 0;
    let fitted = true;
    for (const { inner } of got) {
      if (!inner) {
        fitted = false;
        continue;
      }
      off = Math.max(off, ...inner.map((v, k) => Math.abs(v - basic[k])));
      const centred = Math.abs((inner[0] + inner[2]) / 2 - (basic[0] + basic[2]) / 2) < 1 && Math.abs((inner[1] + inner[3]) / 2 - (basic[1] + basic[3]) / 2) < 1;
      const touches = Math.min(Math.abs(inner[2] - inner[0] - (basic[2] - basic[0])), Math.abs(inner[3] - inner[1] - (basic[3] - basic[1]))) < 1;
      if (!(centred && touches)) {
        fitted = false;
        console.log(JSON.stringify({ inner, basic }));
      }
    }
    check(fitted, `the inner frame is fitted to the 基本枠 (centred, ${off.toFixed(1)} mm at most off an edge)`);
  }
  if (shots) await page.locator("#editor-canvas").screenshot({ path: `${shots}/sheet-imported.png` });

  // --- a name written out as a ミニネーム and taken back in -----------------------------------
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    const { trimBox } = await import("/src/pagebox.ts");
    const { addLine } = await import("/src/dialogue.ts");
    const project = newProject("ミニネームの往復", 7);
    const [x0, y0, x1, y1] = trimBox(project.pageFormat);
    project.pages.forEach((p, i) => {
      const y = y0 + (y1 - y0) * (0.12 + i * 0.1);
      p.fills = [{ id: `fill${i}`, shape: [[x0 + 60, y], [x1 - 60, y], [x1 - 60, y + 9], [x0 + 60, y + 9]], tone: "black" }];
      addLine(project, p, [x0 + 30, y0 + 40], `${i + 1} ページ`);
    });
    window.nameStudio.show(project);
  });
  await page.locator("#name-export").click();
  await page.locator("#ne-kind-mini").click();
  check((await page.locator("#ne-summary").textContent()).includes("1 枚のミニネーム"), "the export says it makes one sheet");
  await page.evaluate(() => window.__dialogs.push("C:\\out\\往復_ミニネーム.png"));
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => document.getElementById("ne-message").textContent.includes("ミニネームを書き出しました"));
  const written = await page.evaluate(() => {
    const call = window.__calls.filter((c) => c.command === "write_binary_file").at(-1);
    const body = call.args;
    const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
    const bytes = body.subarray(4 + length);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { path: meta.path, png: btoa(binary) };
  });
  check(written.path === "C:\\out\\往復_ミニネーム.png", "the ミニネーム is written where it was asked");
  const png = Buffer.from(written.png, "base64");
  check(png.subarray(1, 4).toString() === "PNG", "as a PNG");
  if (shots) writeFileSync(`${shots}/mininame.png`, png);
  console.log(`     ${await page.locator("#ne-message").textContent()}`);

  // The same as a one-page PDF.
  await page.locator("#ne-mini-format").selectOption("pdf");
  await page.evaluate(() => window.__dialogs.push("C:\\out\\往復_ミニネーム.pdf"));
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => window.__calls.some((c) => c.command === "write_pdf"));
  const pdf = await page.evaluate(() => {
    const body = window.__calls.filter((c) => c.command === "write_pdf").at(-1).args;
    const length = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
    return JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length)));
  });
  check(pdf.pages.length === 1 && pdf.path.endsWith(".pdf") && pdf.pages[0].widthMm > pdf.pages[0].heightMm, "and as a PDF of one landscape page");
  await page.keyboard.press("Escape");

  // Back in: onto a name of 3 pages (the rest are added).
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("取り込み先", 3));
  });
  await page.locator("#image-import").click();
  check((await page.locator("#ii-title").textContent()) === "ネーム画像を取り込む", "取り込む… opens the dialog for the open name");
  await page.setInputFiles("#ii-input", { name: "往復_ミニネーム.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => document.getElementById("ii-summary").textContent.includes("見つけました"));
  const second = await page.locator("#ii-summary").textContent();
  check(second.includes("7 ページ見つけました") && second.includes("足りない 4 ページを足す"), `its 7 pages are found, 4 to add (${second.slice(0, 40)})`);
  check((await page.locator("#ii-order").inputValue()) === "rtl", "read row by row, right to left");
  check((await page.locator("#ii-fit").inputValue()) === "trim", "laid on the trim");
  if (shots) await dialog.screenshot({ path: `${shots}/dialog-mini.png` });
  // A click leaves a page out, another takes it back.
  const firstPage = await page.evaluate(async () => {
    const { miniSheet, MINI_DEFAULTS } = await import("/src/mininame.ts");
    const { newProject } = await import("/src/project.ts");
    const sheet = miniSheet(newProject("x", 7), MINI_DEFAULTS, true);
    const [x0, y0, x1, y1] = sheet.pages[0].box;
    const canvas = document.getElementById("ii-preview");
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / sheet.widthMm, rect.height / sheet.heightMm);
    const left = rect.left + (rect.width - sheet.widthMm * scale) / 2;
    const top = rect.top + (rect.height - sheet.heightMm * scale) / 2;
    return { x: left + ((x0 + x1) / 2) * scale, y: top + ((y0 + y1) / 2) * scale };
  });
  await page.mouse.click(firstPage.x, firstPage.y);
  const leftOut = await page.locator("#ii-summary").textContent();
  check(leftOut.includes("6 ページ見つけました（1 枚は外した）") && leftOut.includes("1〜6 ページ"), "a click on page 1 leaves it out");
  await page.mouse.click(firstPage.x, firstPage.y);
  check((await page.locator("#ii-summary").textContent()).includes("7 ページ見つけました。"), "another takes it back");
  await page.locator("#ii-run").click();
  await page.waitForFunction(() => window.nameStudio.workbench.project?.pages.length === 7);
  {
    const got = await pictures();
    const { trim } = await boxes();
    check(got.every((p) => p.count === 1), "each of the 7 pages has its picture");
    const off = Math.max(...got.flatMap((p) => p.box.map((v, k) => Math.abs(v - trim[k]))));
    if (off >= 0.8) console.log(JSON.stringify({ trim, boxes: got.map((p) => p.box) }));
    check(off < 0.8, `each lies on the trim (${off.toFixed(2)} mm at most off)`);
    const expected = got.map((_, i) => 0.12 + i * 0.1 + 4.5 / (trim[3] - trim[1]));
    const worst = Math.max(...got.map((p, i) => Math.abs(p.bar - expected[i])));
    check(worst < 0.01, `page for page, in order (bars ${got.map((p) => p.bar.toFixed(3)).join(" ")})`);
    check((await page.locator("#status").textContent()).includes("1〜7 ページに取り込みました"), "the status says where they went");
  }
  if (shots) await page.locator("#editor-canvas").screenshot({ path: `${shots}/mini-imported.png` });
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  const undone = await page.evaluate(() => window.nameStudio.workbench.project.pages.map((p) => (p.references ?? []).length));
  check(undone.length === 3 && undone.every((n) => n === 0), "Ctrl+Z takes the pictures and the added pages back in one step");

  // The same sheet printed and scanned a degree askew, on cream paper: turned straight, then cut.
  const scanned = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f3efe4";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((1 * Math.PI) / 180);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(bitmap, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
  }, written.png);
  await page.evaluate(async () => {
    const { newProject } = await import("/src/project.ts");
    window.nameStudio.show(newProject("スキャンから", 7));
  });
  await page.locator("#image-import").click();
  await page.setInputFiles("#ii-input", { name: "スキャン.jpg", mimeType: "image/jpeg", buffer: Buffer.from(scanned, "base64") });
  await page.waitForFunction(() => document.getElementById("ii-summary").textContent.includes("見つけました"));
  const tilted = await page.locator("#ii-summary").textContent();
  check(tilted.includes("7 ページ見つけました") && tilted.includes("1.00° 傾いていた"), `a sheet scanned askew: its 7 pages, the tilt seen (${tilted.slice(0, 50)})`);
  if (shots) await dialog.screenshot({ path: `${shots}/dialog-scan.png` });
  await page.locator("#ii-run").click();
  await page.waitForFunction(() => window.nameStudio.workbench.project?.pages.every((p) => (p.references ?? []).length === 1));
  {
    const got = await pictures();
    const { trim } = await boxes();
    const off = Math.max(...got.flatMap((p) => p.box.map((v, k) => Math.abs(v - trim[k]))));
    check(off < 1, `each straightened page lies on the trim (${off.toFixed(2)} mm at most off)`);
    const expected = got.map((_, i) => 0.12 + i * 0.1 + 4.5 / (trim[3] - trim[1]));
    const worst = Math.max(...got.map((p, i) => Math.abs(p.bar - expected[i])));
    check(worst < 0.01, `page for page, the bars level (bars ${got.map((p) => p.bar.toFixed(3)).join(" ")})`);
  }
  if (shots) await page.locator("#editor-canvas").screenshot({ path: `${shots}/scan-imported.png` });

  // A picture of the name that no longer reads (its data spoilt): said, with its page, before anything is written.
  await page.evaluate(() => {
    const project = window.nameStudio.workbench.project;
    const third = project.images.find((image) => image.id === project.pages[2].references[0].image);
    third.name = "スキャン3.jpg";
    third.dataBase64 = btoa("not a picture");
  });
  const pdfs = () => page.evaluate(() => window.__calls.filter((c) => c.command === "write_pdf").length);
  const before = await pdfs();
  await page.locator("#name-export").click();
  await page.locator("#ne-kind-mini").click();
  await page.evaluate(() => {
    window.__decline = true;
    window.__dialogs.push("C:\\out\\壊れた画像.pdf");
  });
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => document.getElementById("ne-message").textContent.includes("書き出しをやめました"));
  const asked = await page.evaluate(() => window.__asked.at(-1) ?? "");
  check(asked.startsWith("読めない画像が 1 枚あります") && asked.includes("3 ページ「スキャン3.jpg」（画像として読めません）"), `the export names the picture and its page first (${asked.split("\n")[1]})`);
  check((await pdfs()) === before && (await page.evaluate(() => window.__dialogs.length)) === 1, "やめる: nothing is written, not even a file asked for");
  await page.evaluate(() => {
    window.__decline = false;
  });
  await page.locator("#ne-run").click();
  await page.waitForFunction((n) => window.__calls.filter((c) => c.command === "write_pdf").length > n, before);
  check((await page.locator("#ne-message").textContent()).includes("ミニネームを書き出しました"), "除いて書き出す: the ミニネーム is written without it");
  await page.keyboard.press("Escape");

  // The name sheet the roughs are read from, moved since: said before anything is written.
  await page.evaluate(() => {
    const project = window.nameStudio.workbench.project;
    project.source = { path: "C:\\ネーム\\第4話_ネーム.clip", resolution: 600, cells: [] };
    project.pages[1].roughs.push({ id: "rough-1", layerId: 12, layerName: "ラフ", sheetCrop: [0, 0, 400, 600], box: [20, 20, 120, 170] });
    window.__dialogs.push("C:\\out\\ラフ.png", "C:\\out\\ラフ.png", "C:\\out\\ラフ.png");
  });
  const minis = () => page.evaluate(() => window.__calls.filter((c) => c.command === "write_binary_file" || c.command === "write_pdf").length);
  await page.locator("#name-export").click();
  await page.locator("#ne-kind-mini").click();
  await page.selectOption("#ne-mini-format", "png");
  const stopped = await minis();
  await page.evaluate(() => {
    window.__roughChoice = 2;
  });
  await page.locator("#ne-run").click();
  await page.waitForFunction(() => window.__asked.at(-1)?.startsWith("元のネーム用紙のラフ"));
  await page.waitForFunction(() => document.getElementById("ne-message").textContent.includes("書き出しをやめました"));
  const roughNote = await page.evaluate(() => window.__asked.at(-1));
  check(
    roughNote.split("\n")[1] === "・ページ: 2" && roughNote.includes("第4話_ネーム.clip") && roughNote.includes("見つかりません"),
    `the export names the sheet, the page and why (${roughNote.split("\n").slice(0, 2).join(" / ")})`,
  );
  check((await minis()) === stopped && (await page.evaluate(() => window.__dialogs.length)) === 3, "やめる (roughs): nothing is written, not even a file asked for");

  // ネーム用紙を選び直す: the name points at the sheet chosen, the roughs read from it, and it is written.
  await page.evaluate(() => {
    window.__roughChoice = 0;
    window.__sheetPicked = "D:\\移した\\第4話_ネーム.clip";
  });
  await page.locator("#ne-run").click();
  await page.waitForFunction((n) => window.__calls.filter((c) => c.command === "write_binary_file" || c.command === "write_pdf").length > n, stopped);
  const relinked = await page.evaluate(() => ({
    sheet: window.nameStudio.workbench.project.source.path,
    read: window.__roughReads.at(-1),
    from: window.__opened?.defaultPath,
  }));
  check(relinked.sheet === "D:\\移した\\第4話_ネーム.clip" && relinked.read === relinked.sheet, `選び直す: the name keeps the sheet chosen and reads the rough from it (${JSON.stringify(relinked)})`);
  check(relinked.from === "C:\\ネーム\\第4話_ネーム.clip", "the file dialog starts at the sheet the name had");
  check((await page.locator("#ne-message").textContent()).includes("ミニネームを書き出しました"), "選び直す: the ミニネーム is written with the rough");
  await page.keyboard.press("Escape");

  // Undone, the old sheet again: ラフを除いて書き出す writes it, the name keeps its roughs.
  await page.keyboard.press("Control+z");
  check((await page.evaluate(() => window.nameStudio.workbench.project.source.path)) === "C:\\ネーム\\第4話_ネーム.clip", "choosing the sheet again is one step undone");
  const relinkedCount = await minis();
  await page.evaluate(() => {
    window.__roughChoice = 1;
  });
  await page.locator("#name-export").click();
  await page.locator("#ne-run").click();
  await page.waitForFunction((n) => window.__calls.filter((c) => c.command === "write_binary_file" || c.command === "write_pdf").length > n, relinkedCount);
  check((await page.locator("#ne-message").textContent()).includes("ミニネームを書き出しました"), "ラフを除いて書き出す: written without it");
  check((await page.evaluate(() => window.nameStudio.workbench.project.pages[1].roughs.length)) === 1, "the name itself keeps the rough");
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
