// 背景を頼む: what an AI (or anyone) is told to draw the backgrounds of some
// panels: 依頼.md in the background folder, with each panel's place on the
// page, the picture size, its 背景の指示 in words, and where to put what is
// drawn (案/<panel>/<take>/ and 背景.json). Its "おすすめの作り方" is the way
// that worked for the first backgrounds made this way (3D models in Blender,
// a camera for each panel matched to the rough, lines and tones rendered and
// laid together). Pure.
import { bounds } from "../model/geometry";
import { ASSETS_FILE, type BackgroundAsset, assetsSection, panelAssetWords } from "./bgassets";
import { cameraFit, cameraWords } from "./bgcamera";
import { lookWords } from "./bglook";
import { rulerOf, rulerWords } from "./bgruler";
import type { BoxMm, Page, Panel, Point, Project } from "../model/model";
import {
  BACKGROUND_BLEED_MM,
  CAMERA_LABELS,
  FAR_LABELS,
  INSTRUCTION_FILE,
  MANIFEST_FILE,
  REQUEST_DIR,
  TAKES_DIR,
  backgroundBox,
  backgroundOf,
  boxPixels,
  findPanel,
  horizonAcross,
  nextTake,
  panelLabel,
  requestManifest,
  takesFor,
  type BackgroundTake,
} from "./background";

/** One panel to draw: anew, or (`revise`) a take of it changed as said. */
export interface BackgroundTarget {
  panel: string;
  /** 修正: the take to change and how. */
  revise?: { take: string; words: string };
  /** 頼み直す: a new take, not built on the ones before. */
  fresh?: boolean;
}

export interface BackgroundRequest {
  /** Its name: the time it was made (folders and 背景.json keep it). */
  stamp: string;
  targets: BackgroundTarget[];
  /** 今回の注文: what this request asks beyond each panel's instructions. */
  note: string;
  dpi: number;
  /** The background folder (whole path, as this computer writes it). */
  folder: string;
  /** Blender's program, when this computer has it. */
  blender: string | null;
  /** 素材: the folder of places and things kept for reuse and what it lists (none: no such folder). */
  assets?: { folder: string; list: BackgroundAsset[] };
  /** name-blockout on this computer: the Python it runs with, and its source folder (none: installed for that Python). */
  blockout?: { python: string; source: string | null };
}

/** How to run name-blockout on this computer, for the AI (none: not found). */
function blockoutWords(request: BackgroundRequest, dir: string): string[] {
  const found = request.blockout;
  if (!found) return [];
  const run = `\`"${found.python}" -X utf8 -m name_blockout\``;
  return [
    `- name-blockout がこの PC にある: ${run}${found.source ? `（\`PYTHONPATH\` に \`${found.source}/src\` を入れて）` : ""}。` +
      ` まず \`check ${dir}/${INSTRUCTION_FILE}\` で点検し、\`blockout ${dir}/${INSTRUCTION_FILE}\` で箱のあたりを組んで照合する（Blender は自分で探す。\`--blender\` でも渡せる）。` +
      " stage が develop のコマ（作画まで）は、あたりのあとに `develop` で光・影・材質のトーンとベタまで描く。案と背景.json は name-blockout が書く。足りない所は自分で作り込んでよい。",
  ];
}

/** 20261117-0530 (local time). */
export function requestStamp(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

export const requestDir = (stamp: string) => `${REQUEST_DIR}/${stamp}`;
export const REQUEST_FILE = "依頼.md";
/** The picture of a panel sent with a request (its background's box: rough, border, instructions). */
export const panelPicture = (stamp: string, panel: string) => `${requestDir(stamp)}/${panel}.png`;
/** The picture of a whole page sent with a request. */
export const pagePicture = (stamp: string, number: number) => `${requestDir(stamp)}/p${String(number).padStart(3, "0")}.png`;

const mm = (v: number) => String(Math.round(v * 10) / 10);
const at = ([x, y]: Point) => `(${mm(x)}, ${mm(y)})`;
const boxWords = (box: BoxMm) => `[${box.map(mm).join(", ")}]`;

/** Where a point is from a panel, in words: inside, or how far beyond which side. */
export function placeFrom(panel: Panel, [x, y]: Point): string {
  const [x0, y0, x1, y1] = bounds(panel.shape);
  const sides: string[] = [];
  if (y < y0) sides.push(`上へ ${mm(y0 - y)}mm`);
  if (y > y1) sides.push(`下へ ${mm(y - y1)}mm`);
  if (x < x0) sides.push(`左へ ${mm(x0 - x)}mm`);
  if (x > x1) sides.push(`右へ ${mm(x - x1)}mm`);
  if (!sides.length) return `コマの中（左から ${percent(x - x0, x1 - x0)}・上から ${percent(y - y0, y1 - y0)}）`;
  return `コマの外（${sides.join("・")}）`;
}

const percent = (part: number, whole: number) => `${Math.round((part / Math.max(1e-6, whole)) * 100)}%`;

/** A panel's 背景の指示 in words, a line each (none when it has none). */
export function instructionWords(panel: Panel): string[] {
  const bg = backgroundOf(panel);
  const out: string[] = [];
  if (bg.none) out.push("背景なし（このコマは描かなくてよい）");
  if (bg.brief?.trim()) out.push(`背景の指示: ${bg.brief.trim().replace(/\s*\n\s*/g, " / ")}`);
  const ruler = rulerOf(panel);
  // With a ruler the camera comes from its points (below).
  if (bg.camera && !ruler.vanishing.length) out.push(`カメラ: ${CAMERA_LABELS[bg.camera]}`);
  const kind = rulerWords(ruler);
  if (kind) out.push(kind);
  if (ruler.horizon) {
    const [a, b] = horizonAcross(panel, ruler.horizon);
    const [, y0, , y1] = bounds(panel.shape);
    const tilt = Math.abs(a[1] - b[1]) > 0.5 ? `、傾き 左 ${mm(a[1])} → 右 ${mm(b[1])}mm` : "";
    const mid = (a[1] + b[1]) / 2;
    // Beyond the panel too: the whole panel then lies below (or above) the eye level.
    const where =
      mid < y0
        ? `コマの外・上へ ${mm(y0 - mid)}mm。コマの中はすべてアイレベルより下`
        : mid > y1
          ? `コマの外・下へ ${mm(mid - y1)}mm。コマの中はすべてアイレベルより上`
          : `コマの上から ${percent(mid - y0, y1 - y0)}`;
    out.push(`アイレベル（地平線・カメラの高さ）: y = ${mm(mid)}mm（${where}${tilt}）`);
  }
  ruler.vanishing.forEach((point, i) =>
    out.push(`消失点 ${i + 1}${i === 2 ? "（縦の線）" : ""}: ${at(point)}mm、${placeFrom(panel, point)}`),
  );
  for (const object of bg.objects ?? []) {
    out.push(`物「${object.label}」: ${boxWords(bounds(object.shape))}mm の範囲（${placeFrom(panel, centre(object.shape))}）`);
  }
  if (bg.far?.length) {
    const words = bg.far.map((layer) =>
      layer.kind === "panorama"
        ? `空の画像「${layer.asset ?? ""}」（素材の全天球の画像${layer.turnDeg ? `、${layer.turnDeg}° 回す` : ""}）`
        : `${FAR_LABELS[layer.kind]}（種 ${layer.seed ?? 0}）`,
    );
    out.push(`遠景（奥から）: ${words.join("・")}。線は細く、トーンは明るく。遠景だけの絵（遠景.png）も別に`);
  }
  const look = lookWords(panel);
  if (look)
    out.push(
      `見た目: ${look}${bg.look?.develop ? "。作画まで（光の向きどおりの影、材質ごとのトーン・ベタ。影だけの絵 影.png も別に）" : ""}`,
    );
  return out;
}

const centre = (shape: readonly Point[]): Point => {
  const [x0, y0, x1, y1] = bounds(shape);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
};

function dialogue(project: Project, page: Page, panel: Panel): string[] {
  return page.lines
    .filter((line) => line.panel === panel.id && line.text.trim())
    .map((line) => {
      const who = project.characters.find((c) => c.id === line.speaker)?.name;
      return `${who ?? ""}「${line.text.replace(/\s*\n\s*/g, "")}」`;
    });
}

/** A request's panels in words, for the conversation: "p15 コマ7・p16 コマ1 の背景". */
export function requestSummary(project: Project, targets: readonly BackgroundTarget[]): string {
  const labels = targets.flatMap((target) => {
    const found = findPanel(project, target.panel);
    if (!found) return [];
    const label = panelLabel(project, found.page, found.panel);
    return [target.revise ? `${label}（案${target.revise.take}を修正）` : target.fresh ? `${label}（頼み直し）` : label];
  });
  const shown = labels.length > 6 ? [...labels.slice(0, 6), `ほか ${labels.length - 6} コマ`] : labels;
  return `${shown.join("・")} の背景`;
}

/** 依頼.md: everything the one drawing needs, in the request's own folder. */
export function requestBrief(project: Project, request: BackgroundRequest, takes: readonly BackgroundTake[]): string {
  const dir = requestDir(request.stamp);
  const [w, h] = project.pageFormat.canvasMm;
  const out: string[] = [
    `# 背景の依頼（${project.title || "無題"}・${request.stamp}）`,
    "",
    `${requestSummary(project, request.targets)}を描いてください。作業フォルダーは \`${request.folder}\` です（このファイルは \`${dir}/${REQUEST_FILE}\`）。`,
    "",
    "## 決まり",
    "",
    "- これはネームの背景の**あたり（モック）**です。短い時間で、構図・パース・場の大きさが分かることを優先する。細かいモデルや仕上げは要らない（作画は作者がする）。",
    "- 場所や物は箱・板・円柱など簡単な形の組み合わせで作る（車なら車体の箱＋タイヤ、机なら天板＋脚くらい）。窓・ドアなど構図に効く所だけ形を付ける。",
    "- 描くのは背景だけ。人物は描かない（人物が立つ所はそのまま空けてよい）。",
    "- ネームの写し（.namestudio）や作業フォルダーの外のファイルは書き換えない。前に作った案も消さない・上書きしない。",
    "- 構図はコマの絵（ラフ）に合わせる。ラフの人物の大きさ・向き・床や壁の線、アイレベル・消失点の指示があればそれを優先する。",
    "- 消失点は、建物・床・道など場の主な線の向き。車や家具などの物は、名前やコマの背景の言葉に向き（横向き・斜め・ドアをこちらに など）があればそれに従い、なければ説明にあるところ（開いたドアなど）が見えるように斜めに置いてよい（その物の辺はアイレベルの上の別の点へ向かう）。物の範囲（橙）には、その物がおおよそ収まるように置く。",
    "- 作業フォルダーに前に作ったもの（3D モデル・スクリプト・前の案・使い方.md）があれば、まず読んで使い回す。",
    "",
    "## 渡すもの",
    "",
    `- \`${dir}/<コマの id>.png\`: 描く範囲（下の「紙面の範囲」）そのままの絵。ラフ・セリフ＝黒、コマ枠＝青、背景の指示＝緑の破線（アイレベル）、赤・青・紫（X・Y・Z の線と、それぞれの消失点へ向かう細い線。X と Y はアイレベルの上の消失点 1・2、Z は縦の線が集まる消失点 3）と橙（物の範囲と名前）。`,
    `- \`${dir}/pNNN.png\`: そのコマのあるページ全体（前後の流れを見るため）。`,
    `- \`${dir}/${INSTRUCTION_FILE}\`: この依頼を道具が読む形にしたもの（name-blockout の指示書 v1。座標は紙面の mm、カメラは下の「カメラ（計算済み）」と同じ値）。name-blockout があれば \`name-blockout blockout\` でこのファイルから箱のあたりを組み、数値で確かめられる。`,
    ...blockoutWords(request, dir),
    `- 座標は紙面の mm（用紙 ${mm(w)}×${mm(h)}mm の左上が原点、右が x、下が y）。`,
    "",
    "## おすすめの作り方（前にうまくいった手順）",
    "",
    "1. 場所ごとに簡単な 3D モデル（箱・板の組み合わせ）を Python のスクリプトで作る（Blender があれば bpy で）。スクリプトは `3d/scripts/`、モデルは `3d/*.blend` に残して、ほかのコマや次の依頼でも使う。",
    "2. コマごとのカメラ（位置・注視点・レンズ）を表にして（例 `3d/scripts/shots.py`）、ラフの見え方に合わせる。アイレベル・消失点の指示があるコマは、下の「カメラ（計算済み）」をそのまま使う（レンズ・シフト・見下ろしの角度は指示から計算してある。カメラの高さはアイレベルの高さ、物の向きは「カメラの向きから何°」に合わせる）。",
    "3. 描き出す前に確かめる: 指示のあるコマは、Blender で水平な方向の無限遠の点（カメラの位置＋水平な向き×10⁶。3点透視なら真下・真上の無限遠の点も）と物の辺の向きを `bpy_extras.object_utils.world_to_camera_view` で画像に投影し、アイレベルの行と消失点が「画像の中の…」の px と画像の幅の 1% 以内で合うか確かめる。合わなければカメラを直す。合ったら、測った値（例: アイレベル 812px（指示 815）・消失点1 (2410, 812)（指示 (2400, 815)））を背景.json の note に書く。ラフと重ねた確認の絵も作って見比べる。",
    "4. 漫画の背景のあたりとして描き出す: 線画（黒い線・透明地。Blender なら Freestyle）とトーン（面ごとのグレー）くらいで十分。影は外で構図に効くときだけ。白地に重ねたものを完成にする。",
    "5. Blender がなければ、Python（PIL など）で透視図法で描いてもよい。",
    "6. 作り方と、コマとカメラの対応を作業フォルダーの `使い方.md` に書き足しておく（次に直す人のため）。",
    "",
    `Blender: ${request.blender ? `\`${request.blender}\`（バックグラウンドで動かす: \`"${request.blender}" -b --python スクリプト.py\`）` : "このパソコンでは見つかりませんでした（入っている場所が分かれば使ってよい）"}`,
    "",
    "## 描いたものの置き方",
    "",
    `- 1 案ごとに \`${TAKES_DIR}/<コマの id>/<番号>/\` に \`完成.png\`（白地に全部）・\`線画.png\`（透明地）・\`トーン.png\`・\`遠景.png\`（遠景の指示があるとき、遠景だけ）・\`影.png\`（あるものだけ）を書く。番号は下の各コマに書いた番号から。`,
    `- 画像の大きさは各コマの「画像」の px のとおり（紙面の範囲を ${request.dpi} dpi で描いたもの。コマの外接矩形より ${BACKGROUND_BLEED_MM}mm 大きい）。`,
    `- この依頼の \`${requestManifest(request.stamp)}\` に、1 案 1 件で書く（この依頼だけのファイル。ほかの依頼を同時に描いていることがあるので、作業フォルダー直下の \`${MANIFEST_FILE}\` やほかの依頼のファイルには書かない）。案を 1 つ描き終えるたびに足すと、作者はすぐ見られる:`,
    "",
    "```json",
    `{"takes":[{"panel":"<コマの id>","take":"<番号>","box":[x0,y0,x1,y1],"files":{"完成":"${TAKES_DIR}/<コマの id>/<番号>/完成.png","線画":"…","トーン":"…"},"note":"何を描いたか・カメラ・仮に決めたこと","request":"${request.stamp}"}]}`,
    "```",
    "",
    "- box は紙面の mm（下の「紙面の範囲」をそのまま）。パスは作業フォルダーからの相対で、/ 区切り。",
    "- 終わったら、コマごとに何を描いたか・仮に決めたこと・できなかったことを短く答える。",
  ];
  const world = project.backgrounds?.brief?.trim();
  if (world) out.push("", "## 世界の設定", "", world);
  if (request.assets) out.push("", ...assetsSection(request.assets.folder, request.assets.list));
  if (request.note.trim()) out.push("", "## 今回の注文", "", request.note.trim());
  out.push("", "## コマ");
  for (const target of request.targets) {
    const found = findPanel(project, target.panel);
    if (!found) continue;
    const { page, panel } = found;
    const number = project.pages.indexOf(page) + 1;
    const box = backgroundBox(project.pageFormat, panel);
    const [pw, ph] = boxPixels(box, request.dpi);
    const before = takesFor(takes, panel.id);
    out.push(
      "",
      `### ${panelLabel(project, page, panel)}（id: ${panel.id}）`,
      "",
      `- 紙面の範囲 box: ${boxWords(box)}mm、画像 ${pw}×${ph}px（${request.dpi} dpi）`,
      `- コマの形: [${panel.shape.map(([x, y]) => `[${mm(x)}, ${mm(y)}]`).join(", ")}]${panel.openEdges?.length ? "（裁ち切りの辺あり）" : ""}`,
      `- 絵: \`${panelPicture(request.stamp, panel.id)}\`、ページ全体: \`${pagePicture(request.stamp, number)}\``,
      `- 書く場所: \`${TAKES_DIR}/${panel.id}/${nextTake(takes, panel.id)}/\``,
    );
    if (panel.note?.trim()) out.push(`- 演出メモ: ${panel.note.trim().replace(/\s*\n\s*/g, " / ")}`);
    const said = dialogue(project, page, panel);
    if (said.length) out.push(`- セリフ: ${said.join(" ")}`);
    if (page.memo.trim()) out.push(`- ページのメモ: ${page.memo.trim().replace(/\s*\n\s*/g, " / ")}`);
    for (const line of instructionWords(panel)) out.push(`- ${line}`);
    for (const line of panelAssetWords(panel, request.assets?.list ?? [])) out.push(`- ${line}`);
    const fit = cameraFit(panel, box, request.dpi);
    if (fit) for (const line of cameraWords(fit)) out.push(`- ${line}`);
    if (target.revise) {
      const take = before.find((one) => one.take === target.revise!.take);
      out.push(
        `- **案${target.revise.take}を直す**: ${target.revise.words.trim() || "（言葉なし。指示とラフに合わせ直す）"}`,
        ...(take
          ? [
              `  - 元の案: \`${Object.values(take.files)[0]}\`${take.note ? `（${take.note}）` : ""}。同じモデル・カメラから直し、新しい番号で書く`,
            ]
          : []),
      );
    } else if (target.fresh && before.length) {
      out.push(`- **頼み直し**: 前の案（${before.map((one) => `案${one.take}`).join("・")}）とは別に、構図から考え直す`);
    } else if (before.length) {
      out.push(`- 前の案: ${before.map((one) => `案${one.take}${one.note ? `（${one.note}）` : ""}`).join("、")}`);
    }
  }
  return out.join("\n");
}

/** What the AI is asked in the conversation: read the request and draw. */
export function requestPrompt(project: Project, request: BackgroundRequest): string {
  return [
    `背景を描いてください: ${requestSummary(project, request.targets)}。`,
    `作業フォルダー \`${request.folder}\` の \`${requestDir(request.stamp)}/${REQUEST_FILE}\` に、コマごとの範囲・画像の大きさ・指示・描いたものの置き方があります。それを読み、同じフォルダーの絵を見て描いてください。`,
    `描いたら \`${requestManifest(request.stamp)}\` に書き、コマごとに何を描いたかを短く答えてください（この相談では作業フォルダー${request.assets ? `と素材のフォルダー \`${request.assets.folder}\`` : ""}の中にだけ書けます）。`,
  ].join("\n");
}

/** What the AI drawing backgrounds is told once (its SYSTEM.md, CLAUDE.md and AGENTS.md). */
export function drawingInstructions(folder: string, assets?: string): string {
  return `あなたは漫画の背景を描くアシスタントです。作者は Name Studio というアプリでネーム（絵コンテ）を作っていて、コマの背景を頼んでいます。日本語で、短く答えてください。

- 作業フォルダーは \`${folder}\` です。書いてよいのはこの中だけです${assets ? `（と、素材のフォルダー \`${assets}\` に新しい素材を足すこと）` : ""}（ネームのファイル・ほかのフォルダーは読むだけ）。${assets ? `\n- 素材のフォルダーの ${ASSETS_FILE} にある場所・物は作り直さずに読み込んで使います。素材のファイルは書き換えません。` : ""}
- 頼まれるたびに \`${REQUEST_DIR}/<日時>/${REQUEST_FILE}\` を読み、その決まりのとおりに描いて \`${TAKES_DIR}/\` と、その依頼のフォルダーの \`${MANIFEST_FILE}\` に置きます。
- ほかの依頼を別の AI が同時に描いていることがあります。共有のもの（\`3d/\` のモデル・スクリプト、使い方.md、素材）は、書き換える直前に読み直し、ほかが使っているファイルを丸ごと作り替えない（新しい物は新しいファイルに）。
- 前に作った 3D モデル・スクリプト・使い方.md があれば使い回し、作り方を変えたら使い方.md に書き足します。
- 描くのはネームの背景のあたり（モック）です。細かく作り込まず、簡単な形で短い時間で、構図・パース・場の大きさが分かるものにします。
- 時間のかかる描き出しは、まず小さく（低い dpi で）試して構図を確かめてから、決まった大きさで描きます。
- 分からないこと・仮に決めたことは、答えにはっきり書きます。作者はコマごとに採用・修正・頼み直しを選びます。`;
}
