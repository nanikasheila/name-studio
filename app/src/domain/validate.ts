// The checks the Rust side runs when a name is loaded or saved
// (crates/name-model/src/validate.rs), here for what changes a name without
// the app's screens: the AI's 変更の案 and the Skills' command line. A name
// that fails them would not open, so a change that leaves one is not kept.
import type { Project } from "../model/model";
import { FORMAT_VERSION } from "./project";

/** The trailing number of an id made by `newId` ("line40" → 40). */
function idNumber(id: string): number | null {
  const digits = id.replace(/^\D*/, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

/** Problems found in a name, in Japanese, as the Rust side words them. Empty when it is sound. */
export function validate(project: Project): string[] {
  const problems: string[] = [];
  if (project.formatVersion > FORMAT_VERSION) {
    problems.push(`新しい版のツールで保存されたファイルです（形式 ${project.formatVersion}、このツールは ${FORMAT_VERSION} まで）`);
  }
  const ids = new Set<string>();
  const checkId = (id: string) => {
    if (!id) problems.push("id が空の要素があります");
    else if (ids.has(id)) problems.push(`id ${id} が重複しています`);
    else ids.add(id);
  };
  const characters = new Set(project.characters.map((c) => c.id));
  const images = new Set((project.images ?? []).map((i) => i.id));
  const spreads = new Map<string, number[]>();
  const pageNumber = (id: string) => {
    const index = project.pages.findIndex((page) => page.id === id);
    return index < 0 ? null : index + 1;
  };
  for (const character of project.characters) checkId(character.id);
  project.pages.forEach((page, index) => {
    const number = index + 1;
    checkId(page.id);
    const panels = new Set(page.panels.map((p) => p.id));
    for (const panel of page.panels) {
      checkId(panel.id);
      if (panel.shape.length < 3) problems.push(`${number} ページのコマ ${panel.id} の頂点が足りません`);
      if (panel.spread) spreads.set(panel.spread, [...(spreads.get(panel.spread) ?? []), number]);
      if ((panel.openEdges ?? []).some((edge) => edge >= panel.shape.length))
        problems.push(`${number} ページのコマ ${panel.id} の開いた辺の番号が範囲外です`);
    }
    for (const breakout of page.breakouts ?? []) {
      checkId(breakout.id);
      if (breakout.shape.length < 3) problems.push(`${number} ページのはみ出し ${breakout.id} の頂点が足りません`);
    }
    const lines = new Set(page.lines.map((l) => l.id));
    for (const line of page.lines) {
      checkId(line.id);
      if (line.speaker !== undefined && !characters.has(line.speaker))
        problems.push(`${number} ページのセリフ ${line.id} の話者 ${line.speaker} がいません`);
      if (line.panel !== undefined && !panels.has(line.panel))
        problems.push(`${number} ページのセリフ ${line.id} のコマ ${line.panel} がありません`);
      if (line.linkTo !== undefined && (line.linkTo === line.id || !lines.has(line.linkTo))) {
        problems.push(`${number} ページのセリフ ${line.id} のつなぎ先 ${line.linkTo} が同じページにありません`);
      }
    }
    for (const stroke of page.strokes) checkId(stroke.id);
    for (const rough of page.roughs) checkId(rough.id);
    for (const reference of page.references ?? []) {
      checkId(reference.id);
      if (!images.has(reference.image)) problems.push(`${number} ページの資料画像 ${reference.id} の画像 ${reference.image} がありません`);
    }
  });
  for (const brush of project.brushes ?? []) {
    checkId(brush.id);
    if (!(Number.isFinite(brush.sizeMm) && brush.sizeMm > 0)) problems.push(`ブラシ「${brush.name}」の大きさが正しくありません`);
  }
  for (const image of project.images ?? []) checkId(image.id);
  for (const [spread, pages] of spreads) {
    const facing = pages.length === 2 && Math.abs(pages[0] - pages[1]) === 1;
    if (pages.length > 2 || (pages.length === 2 && !facing)) problems.push(`見開きのコマ ${spread} が隣り合う 2 ページに分かれていません`);
  }
  for (const scene of project.scenes) {
    checkId(scene.id);
    const [first, last] = [pageNumber(scene.firstPage), pageNumber(scene.lastPage)];
    if (first === null || last === null) problems.push(`シーン「${scene.title}」のページがありません`);
    else if (first > last) problems.push(`シーン「${scene.title}」の最初と最後のページが逆です`);
  }
  for (const point of project.emotions) {
    if (!characters.has(point.character)) problems.push(`感情の値の登場人物 ${point.character} がいません`);
    if (pageNumber(point.page) === null) problems.push(`感情の値のページ ${point.page} がありません`);
    if (!(point.value >= -1 && point.value <= 1)) problems.push(`感情の値 ${point.value} が -1〜1 の範囲外です`);
  }
  const numbers = [...ids].map(idNumber).filter((n): n is number => n !== null);
  const highest = numbers.length ? Math.max(...numbers) : null;
  if (highest !== null && highest >= project.nextId) problems.push(`next_id ${project.nextId} が使用済みの id 番号 ${highest} 以下です`);
  return problems;
}
