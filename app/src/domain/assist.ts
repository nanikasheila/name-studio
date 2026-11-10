// AI に相談: what an AI is shown of a name (ネームの要約, in words it can
// read: pages, panels in reading order, dialogue, memos, the story), and the
// changes it may hand back (変更の案): a list of operations in JSON, applied
// with the same functions the screens use, so that what an AI proposes is
// what the user could have done by hand. The app's 相談 palette and the
// Skills' command line (skill/namestudio.ts) both use this.
import { BORDER_LABELS, EFFECT_LABELS, FILL_LABELS, PATTERNS, patternPanels, replacePanels } from "./koma";
import { addCharacter, putScene, setEmotion } from "./cast";
import { addLine, fitLine, KIND_LABELS, mostlyHalfWidth, setLineKind, textAmount } from "./dialogue";
import { area, bounds, boxCenter, rectShape } from "../model/geometry";
import type { BalloonShape, BoxMm, Character, Line, LineKind, Page, Panel, Project, StickyColor } from "../model/model";
import { basicBox } from "./pagebox";
import { deletePages, insertBlankPages } from "./pageops";
import { gutters, movePage, newId, pageIndex } from "./project";
import { assignPanels, sortLines } from "./readingorder";
import { applyScript, panelBoxes, parseScript, placeAfter, retext } from "./scriptimport";
import { addSticky, linkSticky } from "./stickies";
import { planAdvice } from "./story";
import { STRUCTURES } from "./structures";
import { validate } from "./validate";

// --- ネームの要約 ------------------------------------------------------------------------

export interface BriefOptions {
  /** Only these pages (1-based, inclusive) in detail; the rest as a line each. */
  pages?: [number, number];
  /** The pages the user is on (1-based), marked as such. */
  current?: number[];
}

const SHAPE_LABELS: Partial<Record<BalloonShape, string>> = {
  ellipse: "楕円",
  rounded: "角丸",
  box: "四角",
  polygon: "多角形",
  cloud: "モコモコ",
  spike: "トゲ",
  burst: "爆発",
  wavy: "ふるえ",
  flash: "ウニフラ",
  electric: "電子音",
  dashed: "破線",
  none: "フキダシなし",
  custom: "取り込んだ形",
};

/** Where a box lies on the basic frame, in words (右上, 中央…). */
function placeWords(project: Project, box: BoxMm): string {
  const frame = basicBox(project.pageFormat);
  const [cx, cy] = boxCenter(box);
  const fx = (cx - frame[0]) / (frame[2] - frame[0]);
  const fy = (cy - frame[1]) / (frame[3] - frame[1]);
  const v = fy < 0.34 ? "上" : fy > 0.66 ? "下" : "中";
  const h = fx < 0.34 ? "左" : fx > 0.66 ? "右" : "";
  if (v === "中" && !h) return "中央";
  return `${v === "中" ? "中段" : v}${h}`;
}

/** How big a panel is against the basic frame. */
function sizeWords(project: Project, panel: Panel): string {
  const frame = basicBox(project.pageFormat);
  const share = area(panel.shape) / ((frame[2] - frame[0]) * (frame[3] - frame[1]));
  const percent = Math.round(share * 100);
  return `${share >= 0.45 ? "大" : share >= 0.2 ? "中" : "小"}・${percent}%`;
}

const oneLine = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n/g, "／").trim();

/** Dialogue without the breaks the balloon put in (words in Latin letters keep a space): the AI writes it unbroken too. */
const unbroken = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n/g, mostlyHalfWidth(text) ? " " : "").trim();

function speakerName(project: Project, line: Line): string {
  return project.characters.find((c) => c.id === line.speaker)?.name ?? "";
}

/** A line of dialogue as the brief shows it: `[line12] 名前「…」`, with its kind and balloon when not plain speech. */
function lineWords(project: Project, line: Line): string {
  const name = speakerName(project, line);
  const tags = [line.kind !== "speech" ? KIND_LABELS[line.kind] : "", line.balloonShape && line.balloonShape !== "auto" ? SHAPE_LABELS[line.balloonShape] : "", line.emphasis ? "強調" : ""].filter(Boolean);
  return `[${line.id}]${tags.length ? `（${tags.join("・")}）` : ""} ${name}「${unbroken(line.text)}」`;
}

function panelWords(project: Project, panel: Panel, number: number): string {
  const extras = [
    panel.border && panel.border !== "solid" ? BORDER_LABELS[panel.border] : "",
    panel.fill && panel.fill !== "none" ? FILL_LABELS[panel.fill] : "",
    panel.effect && panel.effect !== "none" ? EFFECT_LABELS[panel.effect] : "",
    panel.spread ? "見開きのコマ" : "",
    panel.draft ? "仮のコマ" : "",
    (panel.z ?? 0) > 0 ? "はめ込み" : "",
  ].filter(Boolean);
  const head = `コマ${number}（${placeWords(project, bounds(panel.shape))}・${sizeWords(project, panel)}${extras.length ? `・${extras.join("・")}` : ""}）`;
  return panel.note ? `${head} 演出メモ: ${oneLine(panel.note)}` : head;
}

/** One page in detail: its memo, its panels in reading order with their dialogue, the rest. */
function pageWords(project: Project, page: Page, number: number, current: boolean): string[] {
  const out: string[] = [];
  const flags = [current ? "いま開いているページ" : "", page.joinNext ? "次のページと見開き" : ""].filter(Boolean);
  out.push(`### p${number}${flags.length ? `（${flags.join("・")}）` : ""}`);
  if (page.memo.trim()) out.push(`メモ: ${oneLine(page.memo)}`);
  const panels = [...page.panels].sort((a, b) => a.order - b.order);
  panels.forEach((panel, k) => {
    out.push(`- ${panelWords(project, panel, k + 1)}`);
    for (const line of page.lines.filter((l) => l.panel === panel.id)) out.push(`  - ${lineWords(project, line)}`);
  });
  const loose = page.lines.filter((line) => !line.panel || !panels.some((p) => p.id === line.panel));
  if (loose.length) {
    out.push(panels.length ? "- コマの外のセリフ" : "- セリフ（コマ割りはまだ）");
    for (const line of loose) out.push(`  - ${lineWords(project, line)}`);
  }
  if (!panels.length && !page.lines.length) out.push("- （コマもセリフもまだない）");
  for (const sticky of page.stickies ?? []) out.push(`- 付箋: ${oneLine(sticky.text)}`);
  const drawn = [
    page.strokes.length ? `ラフ線 ${page.strokes.length} 本` : "",
    page.roughs.length ? `取り込んだラフ ${page.roughs.length} 枚` : "",
    (page.fills ?? []).length ? `塗り ${(page.fills ?? []).length}` : "",
    (page.references ?? []).length ? `資料画像 ${(page.references ?? []).length} 枚` : "",
  ].filter(Boolean);
  if (drawn.length) out.push(`- 絵: ${drawn.join("・")}`);
  return out;
}

/** A page as one line, for the pages outside the range asked for. */
function pageLine(project: Project, page: Page, number: number): string {
  const said = page.lines.slice(0, 2).map((line) => `${speakerName(project, line)}「${unbroken(line.text).slice(0, 20)}」`).join(" ");
  const memo = page.memo.trim() ? ` メモ: ${oneLine(page.memo).slice(0, 40)}` : "";
  return `- p${number}: コマ ${page.panels.length}・セリフ ${page.lines.length}（${textAmount(page)} 字）${memo}${said ? ` ${said}` : ""}`;
}

/** The name in words for an AI to read: the story, then each page with its panels in reading order and its dialogue. */
export function nameBrief(project: Project, options: BriefOptions = {}): string {
  const out: string[] = [];
  const count = project.pages.length;
  out.push(`# ネーム「${project.title || "（無題）"}」${project.storyIndex ? ` 第${project.storyIndex}話` : ""}`);
  const facts = [
    project.scroll ? "縦スクロール（上から下へ読む）" : project.binding === "right" ? "右綴じ（ページもコマも右から左へ読む・縦書き）" : "左綴じ（左から右へ読む・横書き）",
    `${count} ページ`,
    project.plan?.targetPages ? `目標 ${project.plan.targetPages} ページ` : "",
    project.plan?.structure ? `話の型: ${STRUCTURES[project.plan.structure as keyof typeof STRUCTURES]?.label ?? project.plan.shapes?.find((s) => s.id === project.plan?.structure)?.label ?? project.plan.structure}` : "",
    project.author ? `作者: ${project.author}` : "",
  ].filter(Boolean);
  out.push(facts.join("・"));
  const frame = project.pageFormat.basicMm;
  out.push(`紙面: 基本枠 ${frame[0]}×${frame[1]} mm（位置は基本枠に対して。コマの % は基本枠に占める広さ）`);
  if (project.characters.length) {
    out.push("", "## 登場人物");
    for (const c of project.characters) out.push(`- ${c.name}（${c.id}）${c.tone ? ` 口調: ${oneLine(c.tone)}` : ""}`);
  }
  if (project.scenes.length) {
    out.push("", "## シーン");
    for (const scene of project.scenes) {
      const [a, b] = [pageIndex(project, scene.firstPage) + 1, pageIndex(project, scene.lastPage) + 1];
      out.push(`- p${a}〜p${b}「${scene.title}」${scene.storyTime ? `（${scene.storyTime}）` : ""}${scene.summary ? ` ${oneLine(scene.summary)}` : ""}`);
    }
  }
  if (project.emotions.length) {
    out.push("", "## 感情の推移（-1 つらい 〜 +1 よい）");
    for (const c of project.characters) {
      const points = project.emotions.filter((p) => p.character === c.id).sort((a, b) => pageIndex(project, a.page) - pageIndex(project, b.page));
      if (points.length) out.push(`- ${c.name}: ${points.map((p) => `p${pageIndex(project, p.page) + 1} ${p.value > 0 ? "+" : ""}${p.value.toFixed(1)}${p.note ? `（${oneLine(p.note)}）` : ""}`).join("、")}`);
    }
  }
  const advice = planAdvice(project);
  if (advice.length) {
    out.push("", "## 構成の気づき（アプリが数えたもの）");
    for (const item of advice) out.push(`- ${item.level === "warn" ? "⚠ " : ""}${item.text}`);
  }
  out.push("", "## ページ");
  const [from, to] = options.pages ?? [1, count];
  const current = new Set(options.current ?? []);
  project.pages.forEach((page, index) => {
    const number = index + 1;
    if (number >= from && number <= to) out.push(...pageWords(project, page, number, current.has(number)));
    else out.push(pageLine(project, page, number));
  });
  if ((project.held ?? []).length || (project.heldPages ?? []).length) {
    out.push("", "## 保留（まだ置き場所を決めていないもの）");
    for (const held of project.held ?? []) {
      const said = held.lines.map((line) => lineWords(project, line)).join(" ");
      out.push(`- 保留コマ${held.panel.note ? ` 演出メモ: ${oneLine(held.panel.note)}` : ""}${said ? ` ${said}` : ""}`);
    }
    for (const held of project.heldPages ?? []) out.push(`- 保留のページ ${held.pages.length} 枚`);
  }
  return out.join("\n");
}

// --- 変更の案 ------------------------------------------------------------------------

/** A page by its number (1-based, as the brief shows it), at the time the operation runs. */
type PageRef = number;
/** A panel by its number on the page in reading order (1-based), or its id. */
type PanelRef = number | string;

export type AssistOp =
  | { op: "script"; text: string; startPage?: PageRef; update?: boolean; pattern?: string }
  | { op: "setTitle"; title: string }
  | { op: "setPageMemo"; page: PageRef; memo: string; append?: boolean }
  | { op: "addPages"; after?: number; count?: number; memos?: string[] }
  | { op: "deletePages"; pages: PageRef[] }
  | { op: "movePage"; page: PageRef; to: PageRef }
  | { op: "panels"; page: PageRef; pattern?: string; count?: number }
  | { op: "setPanelNote"; page: PageRef; panel: PanelRef; note: string; append?: boolean }
  | { op: "addLine"; page: PageRef; panel?: PanelRef; text: string; speaker?: string; kind?: LineKind; shape?: BalloonShape; after?: string }
  | { op: "setLine"; line: string; text?: string; speaker?: string | null; kind?: LineKind; shape?: BalloonShape }
  | { op: "removeLine"; line: string }
  | { op: "addSticky"; page: PageRef; text: string; panel?: PanelRef; line?: string; color?: StickyColor }
  | { op: "addCharacter"; name: string; tone?: string }
  | { op: "setCharacter"; character: string; name?: string; tone?: string }
  | { op: "setScene"; title: string; firstPage: PageRef; lastPage: PageRef; summary?: string; storyTime?: string }
  | { op: "setEmotion"; character: string; page: PageRef; value: number | null; note?: string }
  | { op: "setPlan"; targetPages?: number | null; structure?: string | null };

export type AssistOpName = AssistOp["op"];

const LINE_KINDS: LineKind[] = ["speech", "thought", "narration", "sfx", "aside"];
const SHAPES = Object.keys(SHAPE_LABELS).filter((shape) => shape !== "custom") as BalloonShape[];
const STICKY_COLOR_NAMES: StickyColor[] = ["yellow", "pink", "blue", "green"];

/**
 * What each operation is, for the AI (the system prompt, SKILL.md and the
 * command line's `ops` show this). Every operation is listed; a test checks it.
 */
export const OPS_GUIDE: Record<AssistOpName, string> = {
  script: '台本をネームに流し込む（アプリの「台本の取り込み」と同じ）。{"op":"script","text":"### 1ページ\\n[1]\\n太郎「おはよう」\\n...","startPage":1}。コマのないページにはコマを作る。"update":true で既にあるセリフを台本に合わせて直す。"pattern" はコマ割りの型',
  setTitle: '題名を変える。{"op":"setTitle","title":"…"}',
  setPageMemo: 'ページのメモ（何を描くページか）を書く。{"op":"setPageMemo","page":3,"memo":"…","append":true}（append で書き足す）',
  addPages: 'ページを足す。{"op":"addPages","after":3,"count":2,"memos":["…","…"]}（after:0 で先頭に）',
  deletePages: 'ページを消す。{"op":"deletePages","pages":[5,6]}（1 枚は残す）',
  movePage: 'ページを動かす。{"op":"movePage","page":5,"to":2}',
  panels: `コマ割りをし直す（中のセリフ・ラフは前のコマの順に新しいコマへ）。{"op":"panels","page":3,"pattern":"basic4"} または {"op":"panels","page":3,"count":5}（均等に）。pattern: ${PATTERNS.map((p) => `${p.id}=${p.label}`).join("、")}`,
  setPanelNote: 'コマの演出メモ（カメラ・間・何のコマか）を書く。{"op":"setPanelNote","page":3,"panel":2,"note":"…"}（panel は読む順の番号か id）',
  addLine: `セリフを足す（コマの中の読む順の位置に置く）。{"op":"addLine","page":3,"panel":2,"speaker":"太郎","text":"…","kind":"speech","after":"line12"}。kind: ${LINE_KINDS.map((k) => `${k}=${KIND_LABELS[k]}`).join("、")}。shape（フキダシの形）: ${SHAPES.map((s) => `${s}=${SHAPE_LABELS[s]}`).join("、")}。いない話者は人物に足す`,
  setLine: 'セリフを直す。{"op":"setLine","line":"line12","text":"…","speaker":"花子","kind":"thought","shape":"spike"}（line は要約の [line12]。speaker:null で話者なし）',
  removeLine: 'セリフを消す。{"op":"removeLine","line":"line12"}',
  addSticky: `付箋を貼る（提案やコメントを紙面に残す）。{"op":"addSticky","page":3,"panel":2,"text":"…","color":"pink"}（panel か line で紐づけ。color: ${STICKY_COLOR_NAMES.join("/")}）`,
  addCharacter: '人物を足す。{"op":"addCharacter","name":"…","tone":"口調のメモ"}',
  setCharacter: '人物を直す。{"op":"setCharacter","character":"太郎","name":"…","tone":"…"}',
  setScene: 'シーンを置く（重なるシーンと置き換え）。{"op":"setScene","title":"…","firstPage":1,"lastPage":4,"summary":"…","storyTime":"1日目 朝"}',
  setEmotion: '人物の感情の値を置く（-1〜1、null で消す）。{"op":"setEmotion","character":"太郎","page":5,"value":-0.6,"note":"…"}',
  setPlan: `目標ページ数・話の型。{"op":"setPlan","targetPages":24,"structure":"kishotenketsu"}（structure: ${Object.entries(STRUCTURES).map(([id, s]) => `${id}=${s.label}`).join("、")}）`,
};

/** The operations explained, as one text. */
export function opsGuide(): string {
  return [
    "変更の案は JSON の配列（操作を上から順に当てる）。ページ番号は 1 から、その操作の時点の番号。セリフは要約の [line12] の id、コマはページの中の読む順の番号（コマ1・コマ2…）か id。",
    ...Object.entries(OPS_GUIDE).map(([name, text]) => `- ${name}: ${text}`),
  ].join("\n");
}

/** The fence an AI puts a 変更の案 in, in its reply. */
export const OPS_FENCE = "namestudio-ops";

/** The 変更の案 in an AI's reply: the text of each ```namestudio-ops block. */
export function opsBlocks(reply: string): string[] {
  const found: string[] = [];
  const fence = new RegExp(`\`\`\`${OPS_FENCE}[^\\n]*\\n([\\s\\S]*?)\`\`\``, "g");
  for (const match of reply.matchAll(fence)) found.push(match[1].trim());
  return found;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What each operation needs, to tell a malformed one before anything is changed. */
const REQUIRED: Record<AssistOpName, Record<string, "string" | "number" | "array" | "ref">> = {
  script: { text: "string" },
  setTitle: { title: "string" },
  setPageMemo: { page: "number", memo: "string" },
  addPages: {},
  deletePages: { pages: "array" },
  movePage: { page: "number", to: "number" },
  panels: { page: "number" },
  setPanelNote: { page: "number", panel: "ref", note: "string" },
  addLine: { page: "number", text: "string" },
  setLine: { line: "string" },
  removeLine: { line: "string" },
  addSticky: { page: "number", text: "string" },
  addCharacter: { name: "string" },
  setCharacter: { character: "string" },
  setScene: { title: "string", firstPage: "number", lastPage: "number" },
  setEmotion: { character: "string", page: "number" },
  setPlan: {},
};

/** Operations read from JSON (an array, `{ "ops": [...] }`, or one per line), with what could not be read. */
export function parseOps(text: string): { ops: AssistOp[]; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    try {
      raw = text
        .split("\n")
        .map((row) => row.trim())
        .filter(Boolean)
        .map((row) => JSON.parse(row));
    } catch (error) {
      return { ops: [], problems: [`JSON として読めません: ${error instanceof Error ? error.message : error}`] };
    }
  }
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.ops) ? raw.ops : isRecord(raw) ? [raw] : null;
  if (!list) return { ops: [], problems: ["操作の配列がありません"] };
  const ops: AssistOp[] = [];
  list.forEach((item, i) => {
    const at = `${i + 1} 番目`;
    if (!isRecord(item) || typeof item.op !== "string") return void problems.push(`${at}: "op" がありません`);
    const need = REQUIRED[item.op as AssistOpName];
    if (!need) return void problems.push(`${at}: 知らない操作 ${item.op}`);
    for (const [key, type] of Object.entries(need)) {
      const value = item[key];
      const ok = type === "array" ? Array.isArray(value) : type === "ref" ? typeof value === "number" || typeof value === "string" : typeof value === type;
      if (!ok) return void problems.push(`${at}（${item.op}）: "${key}" がありません`);
    }
    ops.push(item as AssistOp);
  });
  return { ops, problems };
}

export interface OpsResult {
  /** What each operation that went through did, in words. */
  done: string[];
  /** Operations that could not be done (and were left out), and problems the result has. */
  problems: string[];
}

class OpError extends Error {}

function pageAt(project: Project, number: number): Page {
  const page = Number.isInteger(number) ? project.pages[number - 1] : undefined;
  if (!page) throw new OpError(`${number} ページはありません（${project.pages.length} ページまで）`);
  return page;
}

function panelAt(page: Page, ref: PanelRef, number: number): Panel {
  const panels = [...page.panels].sort((a, b) => a.order - b.order);
  const panel = typeof ref === "number" ? panels[ref - 1] : panels.find((p) => p.id === ref);
  if (!panel) throw new OpError(`${number} ページにコマ ${ref} はありません（${panels.length} コマ）`);
  return panel;
}

function lineAt(project: Project, id: string): { page: Page; line: Line; number: number } {
  for (const [index, page] of project.pages.entries()) {
    const line = page.lines.find((l) => l.id === id);
    if (line) return { page, line, number: index + 1 };
  }
  throw new OpError(`セリフ ${id} はありません`);
}

function characterAt(project: Project, ref: string): Character {
  const found = project.characters.find((c) => c.id === ref) ?? project.characters.find((c) => c.name === ref);
  if (!found) throw new OpError(`人物「${ref}」はいません`);
  return found;
}

/** A speaker by name or id; one not in the cast yet is added (said in `done`). */
function speakerFor(project: Project, ref: string, done: string[]): string {
  const found = project.characters.find((c) => c.id === ref) ?? project.characters.find((c) => c.name === ref);
  if (found) return found.id;
  done.push(`人物「${ref}」を足しました`);
  return addCharacter(project, ref).id;
}

function checkKind(kind: unknown): LineKind | undefined {
  if (kind === undefined) return undefined;
  if (!LINE_KINDS.includes(kind as LineKind)) throw new OpError(`セリフの種類 ${kind} はありません（${LINE_KINDS.join("/")}）`);
  return kind as LineKind;
}

function checkShape(shape: unknown): BalloonShape | undefined {
  if (shape === undefined) return undefined;
  if (shape !== "auto" && !SHAPES.includes(shape as BalloonShape)) throw new OpError(`フキダシの形 ${shape} はありません`);
  return shape as BalloonShape;
}

const short = (text: string) => {
  const one = oneLine(text);
  return one.length > 24 ? `${one.slice(0, 24)}…` : one;
};

/** Do one operation; what it did, in words. */
function applyOne(project: Project, op: AssistOp, done: string[]): string {
  switch (op.op) {
    case "script": {
      const doc = parseScript(op.text);
      if (!doc.pages.length) throw new OpError("台本にページがありません");
      const start = (op.startPage ?? 1) - 1;
      if (start < 0 || start > project.pages.length) throw new OpError(`${op.startPage} ページからは流し込めません`);
      if (op.pattern && !PATTERNS.some((p) => p.id === op.pattern)) throw new OpError(`コマ割りの型 ${op.pattern} はありません`);
      const report = applyScript(project, doc, { startPage: start, makePanels: true, pattern: op.pattern, update: op.update ?? false });
      if (report.characters.length) done.push(`人物「${report.characters.join("」「")}」を足しました`);
      const parts = [`${report.pages} ページ`, report.panels ? `コマ ${report.panels}` : "", `セリフ ${report.lines}`, report.scenes ? `シーン ${report.scenes}` : "", report.insertedPages ? `足したページ ${report.insertedPages}` : ""];
      return `台本を ${start + 1} ページから流し込みました（${parts.filter(Boolean).join("・")}）${doc.warnings.length ? `。注意: ${doc.warnings.join(" / ")}` : ""}`;
    }
    case "setTitle":
      project.title = op.title;
      return `題名を「${op.title}」に`;
    case "setPageMemo": {
      const page = pageAt(project, op.page);
      page.memo = op.append && page.memo ? `${page.memo}\n${op.memo}` : op.memo;
      return `${op.page} ページのメモ: ${short(op.memo)}`;
    }
    case "addPages": {
      const after = op.after ?? project.pages.length;
      if (!Number.isInteger(after) || after < 0 || after > project.pages.length) throw new OpError(`${after} ページの後ろには足せません`);
      const count = Math.max(1, Math.min(100, Math.round(op.count ?? op.memos?.length ?? 1)));
      const added = after === 0 ? insertBlankPages(project, 0, false, count) : insertBlankPages(project, after - 1, true, count);
      added.forEach((page, i) => {
        if (op.memos?.[i]) page.memo = op.memos[i];
      });
      const first = pageIndex(project, added[0].id) + 1;
      return `${first}${added.length > 1 ? `〜${first + added.length - 1}` : ""} ページを足しました`;
    }
    case "deletePages": {
      const ids = op.pages.map((n) => pageAt(project, n).id);
      if (!deletePages(project, ids)) throw new OpError("ページは 1 枚は残します");
      return `${op.pages.join("・")} ページを消しました`;
    }
    case "movePage": {
      const page = pageAt(project, op.page);
      pageAt(project, op.to);
      movePage(project, page.id, op.to - op.page);
      return `${op.page} ページを ${op.to} ページ目へ`;
    }
    case "panels": {
      const page = pageAt(project, op.page);
      if (op.pattern) {
        const pattern = PATTERNS.find((p) => p.id === op.pattern);
        if (!pattern) throw new OpError(`コマ割りの型 ${op.pattern} はありません（${PATTERNS.map((p) => p.id).join("/")}）`);
        replacePanels(project, page, patternPanels(project, pattern.id, gutters(project), op.count));
        return `${op.page} ページを「${pattern.label}」で割りました（${page.panels.length} コマ）`;
      }
      const count = Math.round(op.count ?? 0);
      if (count < 1 || count > 20) throw new OpError("コマの数（count）は 1〜20 で");
      const boxes = panelBoxes(basicBox(project.pageFormat), count, gutters(project), project.binding);
      const panels: Panel[] = boxes.map((box, i) => ({ id: newId(project, "panel"), shape: rectShape(box), order: i + 1 }));
      replacePanels(project, page, panels);
      return `${op.page} ページを ${count} コマに割りました`;
    }
    case "setPanelNote": {
      const page = pageAt(project, op.page);
      const panel = panelAt(page, op.panel, op.page);
      panel.note = op.append && panel.note ? `${panel.note}\n${op.note}` : op.note;
      return `${op.page} ページ コマ${typeof op.panel === "number" ? op.panel : ""}の演出メモ: ${short(op.note)}`;
    }
    case "addLine": {
      const page = pageAt(project, op.page);
      const panel = op.panel === undefined ? undefined : panelAt(page, op.panel, op.page);
      const kind = checkKind(op.kind) ?? "speech";
      const shape = checkShape(op.shape);
      const previous = op.after ? lineAt(project, op.after).line : panel ? page.lines.filter((l) => l.panel === panel.id).at(-1) : undefined;
      const speaker = op.speaker ? speakerFor(project, op.speaker, done) : undefined;
      const line = addLine(project, page, [0, 0], op.text || "…", kind);
      if (speaker) line.speaker = speaker;
      if (shape && shape !== "auto") line.balloonShape = shape;
      placeAfter(project, page, panel, line, previous && page.lines.includes(previous) ? previous : undefined);
      assignPanels(page);
      sortLines(page, project.binding);
      return `${op.page} ページ${panel ? ` コマ${typeof op.panel === "number" ? op.panel : ""}` : ""}に${op.speaker ? `${op.speaker}の` : ""}${KIND_LABELS[kind]}「${short(op.text)}」（${line.id}）`;
    }
    case "setLine": {
      const { page, line, number } = lineAt(project, op.line);
      const kind = checkKind(op.kind);
      const shape = checkShape(op.shape);
      const changes: string[] = [];
      if (op.speaker === null) {
        delete line.speaker;
        changes.push("話者なし");
      } else if (op.speaker !== undefined) {
        line.speaker = speakerFor(project, op.speaker, done);
        changes.push(`話者 ${op.speaker}`);
      }
      if (kind && kind !== line.kind) {
        setLineKind(project, line, kind);
        changes.push(KIND_LABELS[kind]);
      }
      if (shape) {
        if (shape === "auto") delete line.balloonShape;
        else line.balloonShape = shape;
        fitLine(line);
        changes.push(`フキダシ ${SHAPE_LABELS[shape] ?? "ふつう"}`);
      }
      if (op.text !== undefined && op.text !== line.text) {
        const panel = page.panels.find((p) => p.id === line.panel);
        retext(project, line, op.text || "…", panel);
        changes.push(`「${short(op.text)}」`);
      }
      return `${number} ページの ${line.id} を${changes.length ? changes.join("・") : "そのまま"}に`;
    }
    case "removeLine": {
      const { page, line, number } = lineAt(project, op.line);
      page.lines = page.lines.filter((l) => l !== line);
      for (const other of page.lines) if (other.linkTo === line.id) delete other.linkTo;
      for (const sticky of page.stickies ?? []) if (sticky.link?.kind === "line" && sticky.link.id === line.id) delete sticky.link;
      return `${number} ページの「${short(line.text)}」を消しました`;
    }
    case "addSticky": {
      const page = pageAt(project, op.page);
      if (op.color !== undefined && !STICKY_COLOR_NAMES.includes(op.color)) throw new OpError(`付箋の色 ${op.color} はありません`);
      const panel = op.panel === undefined ? undefined : panelAt(page, op.panel, op.page);
      const line = op.line ? page.lines.find((l) => l.id === op.line) : undefined;
      if (op.line && !line) throw new OpError(`${op.page} ページにセリフ ${op.line} はありません`);
      const target = line ? line.box : panel ? bounds(panel.shape) : basicBox(project.pageFormat);
      // Beside what it is about: just off its top right, settled onto the page or its 欄外.
      const sticky = addSticky(project, page, [target[2] + 2, target[1]], op.text);
      sticky.color = op.color ?? "pink";
      if (line) linkSticky(page, sticky, "line", line.id, boxCenter(line.box));
      else if (panel) linkSticky(page, sticky, "panel", panel.id, boxCenter(bounds(panel.shape)));
      return `${op.page} ページに付箋「${short(op.text)}」`;
    }
    case "addCharacter": {
      if (project.characters.some((c) => c.name === op.name)) throw new OpError(`人物「${op.name}」はもういます`);
      const character = addCharacter(project, op.name);
      if (op.tone) character.tone = op.tone;
      return `人物「${op.name}」を足しました`;
    }
    case "setCharacter": {
      const character = characterAt(project, op.character);
      const was = character.name;
      if (op.name) character.name = op.name;
      if (op.tone !== undefined) character.tone = op.tone || undefined;
      if (!character.tone) delete character.tone;
      return `人物「${was}」を${op.name && op.name !== was ? `「${op.name}」に` : ""}直しました`;
    }
    case "setScene": {
      const [first, last] = [pageAt(project, op.firstPage), pageAt(project, op.lastPage)];
      const [a, b] = [pageIndex(project, first.id), pageIndex(project, last.id)];
      if (a > b) throw new OpError("シーンの最初のページが最後のページより後ろです");
      const { scene, replaced } = putScene(project, a, b, op.title, op.summary ?? "");
      if (op.storyTime) scene.storyTime = op.storyTime;
      return `シーン「${op.title}」を p${a + 1}〜p${b + 1} に${replaced ? `（${replaced} つと置き換え）` : ""}`;
    }
    case "setEmotion": {
      const character = characterAt(project, op.character);
      const page = pageAt(project, op.page);
      if (op.value !== null && !(typeof op.value === "number" && Number.isFinite(op.value))) throw new OpError("感情の値は -1〜1 の数で");
      setEmotion(project, character.id, page.id, op.value, op.note);
      return op.value === null ? `${character.name}の p${op.page} の感情の値を消しました` : `${character.name}の p${op.page} の感情 ${op.value}`;
    }
    case "setPlan": {
      const plan = { ...(project.plan ?? {}) };
      if (op.targetPages === null) delete plan.targetPages;
      else if (op.targetPages !== undefined) {
        if (!Number.isInteger(op.targetPages) || op.targetPages < 1) throw new OpError("目標ページ数は 1 以上の整数で");
        plan.targetPages = op.targetPages;
      }
      if (op.structure === null) delete plan.structure;
      else if (op.structure !== undefined) {
        if (!(op.structure in STRUCTURES) && !plan.shapes?.some((s) => s.id === op.structure)) throw new OpError(`話の型 ${op.structure} はありません`);
        plan.structure = op.structure;
      }
      project.plan = plan;
      return `構成: ${[plan.targetPages ? `目標 ${plan.targetPages} ページ` : "", plan.structure ? `型 ${STRUCTURES[plan.structure as keyof typeof STRUCTURES]?.label ?? plan.structure}` : ""].filter(Boolean).join("・") || "なし"}`;
    }
  }
}

/**
 * Apply operations to a name, in order. One that cannot be done is left out
 * (said in `problems`), the rest go through. When the name that results would
 * not open (see `validate`), its problems are in `problems` too, and the
 * caller must not keep it.
 */
export function applyOps(project: Project, ops: readonly AssistOp[]): OpsResult & { broken: boolean } {
  const done: string[] = [];
  const problems: string[] = [];
  ops.forEach((op, i) => {
    try {
      done.push(applyOne(project, op, done));
    } catch (error) {
      if (!(error instanceof OpError) && !(error instanceof TypeError)) throw error;
      problems.push(`${i + 1} 番目（${op.op}）: ${error.message}`);
    }
  });
  const broken = validate(project);
  return { done, problems: [...problems, ...broken], broken: broken.length > 0 };
}

/** What operations would do to a name, without changing it. */
export function previewOps(project: Project, ops: readonly AssistOp[]): OpsResult & { broken: boolean } {
  return applyOps(structuredClone(project), ops);
}
