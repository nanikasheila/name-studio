// 背景の素材: places and things kept for reuse, as 3D files in a folder of
// their own (shared by the names of a series: 背景素材 beside them unless
// another is chosen), listed in its 素材.json by name. A panel's background
// takes place in a 場所 (PanelBackground.place) and a 物 is made from a
// thing (BackgroundObject.asset, else the one its name begins with). The
// request names them so the AI loads them instead of modelling anew, and
// the AI adds there what it makes that will be seen again. Pure: the folder
// is read and written by the 作画 palette.
import type { BackgroundObject, Panel, Project } from "../model/model";
import { backgroundOf } from "./background";

export const ASSETS_FILE = "素材.json";

export type AssetKind = "place" | "thing" | "panorama";
export const ASSET_KIND_LABELS: Record<AssetKind, string> = { place: "場所", thing: "物", panorama: "全天球の画像" };
const KINDS = Object.keys(ASSET_KIND_LABELS) as AssetKind[];
/** 360° pictures (equirectangular): a 素材 of kind panorama, the far background of a panel. */
const PANORAMA_FILE = /\.(hdr|exr)$/i;

/** One 素材, as 素材.json lists it (paths from the folder, "/" between folders). */
export interface BackgroundAsset {
  name: string;
  kind: AssetKind;
  /** The 3D file. */
  file: string;
  /** In a .blend: the collection (or object) to bring in; none: as named. */
  collection?: string;
  /** How to use it: its size, which way is front, what it is for. */
  note?: string;
  /** A small picture of it. */
  picture?: string;
  /** Who added it ("AI" when the AI drawing made it). */
  by?: string;
  /** Its license, as SPDX names it ("CC0-1.0", "CC-BY-4.0"…), or "own" for one's own work. name-blockout uses only free ones that may be sold. */
  license?: string;
  /** Where it came from (the page it was taken from). */
  source?: string;
  /** Who made it. */
  author?: string;
  /** How its license asks to be credited, when it says. */
  attribution?: string;
}

/** Licenses name-blockout lets in (free, also for work that is sold), offered when one is written. */
export const LICENSE_SUGGESTIONS = ["CC0-1.0", "CC-BY-4.0", "own", "MIT", "Apache-2.0", "CC-BY-3.0", "BSD-3-Clause"] as const;

/** The text fields of a 素材 kept as they are read (none when empty). */
const TEXT_FIELDS = ["collection", "note", "by", "license", "source", "author", "attribution"] as const;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** A path in the folder as written, when it stays in the folder. */
function inFolder(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return undefined;
  return parts.join("/");
}

/** 素材.json read: the 素材 it lists (a name once: the later one stands), what could not be read, and the file's other
 * fields (`rest`, such as name-blockout's allowLicenses: kept when it is written again). */
export function readAssets(source: string): { assets: BackgroundAsset[]; problems: string[]; rest?: Record<string, unknown> } {
  let data: unknown;
  try {
    data = JSON.parse(source.replace(/^﻿/, ""));
  } catch (error) {
    return { assets: [], problems: [`${ASSETS_FILE} を読めません: ${String(error)}`] };
  }
  const list = Array.isArray(data) ? data : (data as { assets?: unknown })?.assets;
  if (!Array.isArray(list)) return { assets: [], problems: [`${ASSETS_FILE} に assets の一覧がありません`] };
  const named = new Map<string, BackgroundAsset>();
  const problems: string[] = [];
  list.forEach((item, i) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = text(entry.name);
    const file = inFolder(entry.file);
    if (!name || !file) {
      problems.push(`${i + 1} 件目: 名前かファイル（素材のフォルダーの中）がありません`);
      return;
    }
    const kind = KINDS.find((one) => one === entry.kind) ?? "thing";
    const asset: BackgroundAsset = { name, kind, file };
    for (const key of TEXT_FIELDS) {
      const value = text(entry[key]);
      if (value) asset[key] = value;
    }
    const picture = inFolder(entry.picture);
    if (picture) asset.picture = picture;
    named.delete(name);
    named.set(name, asset);
  });
  const rest =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([key]) => key !== "assets"))
      : {};
  return { assets: [...named.values()], problems, ...(Object.keys(rest).length ? { rest } : {}) };
}

/** 素材.json written (the same shape it is read in, with the file's other fields kept). */
export function writeAssets(assets: readonly BackgroundAsset[], rest?: Record<string, unknown>): string {
  return `${JSON.stringify({ ...rest, assets }, null, 2)}\n`;
}

/** The 3D files of the folder not listed yet, added as 物 named after their files (a name taken: its folder's too). */
export function addModels(assets: readonly BackgroundAsset[], files: readonly string[]): BackgroundAsset[] {
  const out = [...assets];
  const listed = new Set(assets.map((asset) => asset.file));
  const names = new Set(assets.map((asset) => asset.name));
  for (const file of files) {
    if (listed.has(file)) continue;
    const parts = file.split("/");
    const stem = parts[parts.length - 1].replace(/\.[^.]+$/, "");
    let name = stem;
    if (names.has(name) && parts.length > 1) name = `${parts[parts.length - 2]}・${stem}`;
    for (let n = 2; names.has(name); n++) name = `${stem} ${n}`;
    names.add(name);
    listed.add(file);
    out.push({ name, kind: PANORAMA_FILE.test(file) ? "panorama" : "thing", file });
  }
  return out;
}

/** The 素材 named `name`. */
export function assetNamed(assets: readonly BackgroundAsset[], name: string | undefined): BackgroundAsset | undefined {
  const wanted = name?.trim();
  return wanted ? assets.find((asset) => asset.name === wanted) : undefined;
}

/** The 素材 a 物 is made from: the one chosen, else a thing whose name its name is or begins with (「バン 横向き」→「バン」). */
export function objectAsset(assets: readonly BackgroundAsset[], object: BackgroundObject): BackgroundAsset | undefined {
  if (object.asset) return assetNamed(assets, object.asset);
  const label = object.label.trim();
  const matches = assets.filter(
    (asset) =>
      asset.kind === "thing" && (label === asset.name || label.startsWith(`${asset.name} `) || label.startsWith(`${asset.name}　`)),
  );
  return matches.sort((a, b) => b.name.length - a.name.length)[0];
}

/** The 素材 chosen for a 物 (none: as its name says). */
export function chooseAsset(panel: Panel, objectId: string, name: string | undefined): boolean {
  const object = panel.background?.objects?.find((one) => one.id === objectId);
  if (!object) return false;
  const wanted = name?.trim();
  if (wanted) object.asset = wanted;
  else delete object.asset;
  return true;
}

/** A 素材 renamed: the panels and 物 that named it name it anew. How many changed. */
export function renameAssetUses(project: Project, from: string, to: string): number {
  if (!from || !to || from === to) return 0;
  let changed = 0;
  for (const page of project.pages)
    for (const panel of page.panels) {
      const bg = panel.background;
      if (!bg) continue;
      if (bg.place === from) {
        bg.place = to;
        changed++;
      }
      for (const object of bg.objects ?? [])
        if (object.asset === from) {
          object.asset = to;
          changed++;
        }
    }
  return changed;
}

/** How many panels and 物 name each 素材. */
export function assetUses(project: Project, assets: readonly BackgroundAsset[]): Map<string, number> {
  const uses = new Map<string, number>();
  const add = (name: string | undefined) => name && uses.set(name, (uses.get(name) ?? 0) + 1);
  for (const page of project.pages)
    for (const panel of page.panels) {
      const bg = panel.background;
      if (!bg) continue;
      add(assetNamed(assets, bg.place)?.name);
      for (const object of bg.objects ?? []) add(objectAsset(assets, object)?.name);
      for (const layer of bg.far ?? []) if (layer.kind === "panorama") add(assetNamed(assets, layer.asset)?.name);
    }
  return uses;
}

const assetLine = (asset: BackgroundAsset) =>
  `「${asset.name}」（${ASSET_KIND_LABELS[asset.kind]}）: \`${asset.file}\`${asset.collection ? `（コレクション ${asset.collection}）` : ""}${asset.note ? ` — ${asset.note}` : ""}${asset.license ? `（${asset.license}${asset.author ? `、${asset.author}` : ""}）` : ""}`;

/** A panel's 素材 in words for its part of the request (none: nothing). */
export function panelAssetWords(panel: Panel, assets: readonly BackgroundAsset[]): string[] {
  const bg = backgroundOf(panel);
  const out: string[] = [];
  const place = assetNamed(assets, bg.place);
  if (place) out.push(`場所の素材: ${assetLine(place)}。作り直さずこれを読み込んで、カメラを置く`);
  else if (bg.place) out.push(`場所: 「${bg.place}」（素材の一覧にない。作ったら素材に足す）`);
  for (const object of bg.objects ?? []) {
    const asset = objectAsset(assets, object);
    if (asset) out.push(`物「${object.label}」の素材: ${assetLine(asset)}`);
  }
  for (const layer of bg.far ?? []) {
    if (layer.kind !== "panorama") continue;
    const asset = assetNamed(assets, layer.asset);
    if (asset) out.push(`遠景の空の素材: ${assetLine(asset)}。World に正距円筒で貼る（画像の真ん中の行がアイレベル）`);
  }
  return out;
}

/** The 素材 part of the request: where they are, what there is, how to use them and add to them. */
export function assetsSection(folder: string, assets: readonly BackgroundAsset[]): string[] {
  return [
    "## 素材（使い回す 3D）",
    "",
    `素材のフォルダーは \`${folder}\` です（作品で共通。ほかの話のネームも使います）。一覧は \`${ASSETS_FILE}\`。`,
    "",
    ...(assets.length ? assets.map((asset) => `- ${assetLine(asset)}`) : ["- （まだありません）"]),
    "",
    "- 素材にある場所・物は作り直さずに使う。.blend は `bpy.ops.wm.append`（または link）でコレクションごと読み込み、ほかの形式は Blender の import で読む。大きさと向きは素材のメモに合わせる。",
    "- 素材のファイルは書き換えない・消さない（直したいときは作業フォルダーへ写してから）。",
    "- 素材はあたり用の簡単な形でよい（細かい作り込みは要らない）。一覧にない物は、箱・板・円柱の組み合わせでその場で作る。",
    "- 何度も出そうな場所・物（世界の設定やコマの指示に名前のあるもの）を新しく作ったら、素材のフォルダーの `<名前>/<名前>.blend` に同じ名前のコレクションにまとめて保存し、小さな見本の絵 `<名前>/見本.png` と一緒に、" +
      `\`${ASSETS_FILE}\` に 1 件足す（ほかの行は残す）: \`{"assets":[{"name":"<名前>","kind":"place か thing","file":"<名前>/<名前>.blend","collection":"<名前>","note":"大きさ・正面の向き・使い方","picture":"<名前>/見本.png","by":"AI"}]}\``,
    "- ほかから取ってきた素材は、無料で商用にも使えるもの（CC0・CC-BY など）だけにし、`license`（SPDX の名前）・`source`（取ってきたページ）・`author` も書く。ライセンスの分からないもの・非商用のものは使わない。",
  ];
}
