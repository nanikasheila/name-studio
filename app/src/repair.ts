// Mending a project before it is saved. Saving checks the project (Rust's
// validate) and refuses one with problems; a single loose end (a line whose
// speaker was removed, two items with one id) would then stop saving and
// autosave alike. What can be mended without guessing is mended here, the
// same checks in the same order, and each mend is told.
import type { Project } from "./model";
import { FORMAT_VERSION, newId } from "./project";

/** Mend what the save check would refuse; returns what was mended (empty when nothing). */
export function repair(project: Project): string[] {
  const mended: string[] = [];
  const note = (message: string) => mended.push(message);
  if ((project.formatVersion ?? FORMAT_VERSION) > FORMAT_VERSION) return mended;

  // Ids: empty or used twice → a new one (references keep the first holder).
  const seen = new Set<string>();
  const fresh = <T extends { id: string }>(item: T, prefix: string, what: string) => {
    if (item.id && !seen.has(item.id)) {
      seen.add(item.id);
      return;
    }
    const old = item.id;
    item.id = newId(project, prefix);
    seen.add(item.id);
    note(old ? `${what}の id ${old} が重複していたので ${item.id} にしました` : `${what}の空の id を ${item.id} にしました`);
  };
  // nextId first, so new ids never meet old ones.
  const numbers = allIds(project).map(idNumber).filter((n): n is number => n !== null);
  const highest = numbers.length ? Math.max(...numbers) : -1;
  if (highest >= project.nextId) {
    project.nextId = highest + 1;
    note(`次の id 番号を ${project.nextId} にしました`);
  }

  for (const character of project.characters) fresh(character, "character", "登場人物");
  const characters = new Set(project.characters.map((c) => c.id));
  const images = new Set((project.images ?? []).map((image) => image.id));
  project.pages.forEach((page, index) => {
    const number = index + 1;
    fresh(page, "page", "ページ");
    page.panels = page.panels.filter((panel) => {
      if (panel.shape.length >= 3) return true;
      note(`${number} ページの頂点の足りないコマ ${panel.id} を外しました`);
      return false;
    });
    for (const panel of page.panels) {
      fresh(panel, "panel", `${number} ページのコマ`);
      if (panel.openEdges?.some((edge) => edge >= panel.shape.length)) {
        panel.openEdges = panel.openEdges.filter((edge) => edge < panel.shape.length);
        note(`${number} ページのコマ ${panel.id} の開いた辺を直しました`);
      }
    }
    page.breakouts = page.breakouts.filter((breakout) => {
      if (breakout.shape.length >= 3) return true;
      note(`${number} ページの頂点の足りないはみ出し ${breakout.id} を外しました`);
      return false;
    });
    for (const breakout of page.breakouts) fresh(breakout, "breakout", `${number} ページのはみ出し`);
    const panels = new Set(page.panels.map((panel) => panel.id));
    for (const line of page.lines) fresh(line, "line", `${number} ページのセリフ`);
    const lines = new Set(page.lines.map((line) => line.id));
    for (const line of page.lines) {
      if (line.speaker && !characters.has(line.speaker)) {
        delete line.speaker;
        note(`${number} ページのセリフ ${line.id} の話者（いない人物）を外しました`);
      }
      if (line.panel && !panels.has(line.panel)) {
        delete line.panel;
        note(`${number} ページのセリフ ${line.id} のコマ（ないコマ）を外しました`);
      }
      if (line.linkTo && (line.linkTo === line.id || !lines.has(line.linkTo))) {
        delete line.linkTo;
        note(`${number} ページのセリフ ${line.id} のつなぎ先を外しました`);
      }
    }
    for (const stroke of page.strokes) fresh(stroke, "stroke", `${number} ページのラフ線`);
    for (const rough of page.roughs) fresh(rough, "rough", `${number} ページのラフ画像`);
    if (page.references) {
      for (const reference of page.references) fresh(reference, "reference", `${number} ページの資料画像`);
      page.references = page.references.filter((reference) => {
        if (images.has(reference.image)) return true;
        note(`${number} ページの資料画像 ${reference.id}（画像が見つからない）を外しました`);
        return false;
      });
      if (!page.references.length) delete page.references;
    }
  });
  for (const brush of project.brushes ?? []) {
    fresh(brush, "brush", "ブラシ");
    if (!(Number.isFinite(brush.sizeMm) && brush.sizeMm > 0)) {
      brush.sizeMm = 0.5;
      note(`ブラシ「${brush.name}」の大きさを 0.5 mm にしました`);
    }
  }
  for (const image of project.images ?? []) fresh(image, "image", "資料画像の画像");
  // 見開きのコマ: the halves must be on two facing pages.
  const spreads = new Map<string, number[]>();
  project.pages.forEach((page, index) => {
    for (const panel of page.panels) if (panel.spread) spreads.set(panel.spread, [...(spreads.get(panel.spread) ?? []), index]);
  });
  for (const [spread, pages] of spreads) {
    const facing = pages.length === 2 && Math.abs(pages[0] - pages[1]) === 1;
    if (pages.length <= 2 && (pages.length < 2 || facing)) continue;
    for (const page of project.pages) for (const panel of page.panels) if (panel.spread === spread) delete panel.spread;
    note(`見開きのコマ ${spread} を普通のコマにしました（隣り合う 2 ページに分かれていなかったため）`);
  }
  const pageNumber = (id: string) => project.pages.findIndex((page) => page.id === id);
  project.scenes = project.scenes.filter((scene) => {
    fresh(scene, "scene", "シーン");
    const [first, last] = [pageNumber(scene.firstPage), pageNumber(scene.lastPage)];
    if (first < 0 || last < 0) {
      note(`ページのないシーン「${scene.title}」を外しました`);
      return false;
    }
    if (first > last) {
      [scene.firstPage, scene.lastPage] = [scene.lastPage, scene.firstPage];
      note(`シーン「${scene.title}」の最初と最後のページを入れ替えました`);
    }
    return true;
  });
  project.emotions = project.emotions.filter((point) => {
    if (!characters.has(point.character) || pageNumber(point.page) < 0) {
      note("いない人物かないページの感情の値を外しました");
      return false;
    }
    if (!(point.value >= -1 && point.value <= 1)) {
      point.value = Number.isFinite(point.value) ? Math.max(-1, Math.min(1, point.value)) : 0;
      note("範囲外の感情の値を -1〜1 に収めました");
    }
    return true;
  });
  return mended;
}

/** Every id the save check counts (for the next id number). */
function allIds(project: Project): string[] {
  const ids: string[] = [
    ...project.characters.map((c) => c.id),
    ...(project.brushes ?? []).map((b) => b.id),
    ...project.scenes.map((s) => s.id),
    ...(project.images ?? []).map((i) => i.id),
  ];
  for (const page of project.pages) {
    ids.push(page.id);
    for (const list of [page.panels, page.breakouts, page.lines, page.strokes, page.roughs, page.references ?? []]) for (const item of list) ids.push(item.id);
  }
  return ids;
}

/** The trailing number of an id as Rust reads it ("line40" → 40; none when anything but digits follows the first digit). */
function idNumber(id: string): number | null {
  const digits = id.replace(/^\D+/, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
}
