// 素材 in the 作画 palette: the folder of places and things the backgrounds
// reuse (作品で共通, 背景素材 beside the names unless another is chosen) and
// its 素材.json, listed to name, sort into 場所・物 and note. The 3D files
// put in the folder are added with one button; what the AI makes for the
// backgrounds it adds there itself. Simple shapes are enough: these are for
// the backgrounds' あたり, not finished models.
import { open } from "../platform/dialogs";
import { call } from "../platform/backend";
import { plainButton } from "../platform/dom";
import { fail } from "../platform/status";
import {
  ASSETS_FILE,
  ASSET_KIND_LABELS,
  addModels,
  assetUses,
  readAssets,
  renameAssetUses,
  writeAssets,
  type AssetKind,
  type BackgroundAsset,
} from "../domain/bgassets";
import type { Project } from "../model/model";

export interface AssetsHost {
  project(): Project | null;
  path(): string | null;
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  /** The list changed: the panels' 場所・素材 follow. */
  changed(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const toBlob = (base64: string) => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" });

export class DrawAssets {
  /** The folder of 素材 now in use (null until a saved name or a chosen folder gives one). */
  folder: string | null = null;
  list: BackgroundAsset[] = [];
  private problems: string[] = [];
  private built: HTMLDetailsElement | null = null;
  private readonly thumbs = new Map<string, string>();

  constructor(private readonly host: AssetsHost) {}

  /** The names of the 素材 of a kind (for the panels' choices). */
  names(kind: AssetKind): string[] {
    return this.list.filter((asset) => asset.kind === kind).map((asset) => asset.name);
  }

  view(): HTMLElement {
    if (this.built) return this.built;
    const pick = plainButton("選ぶ…", () => void this.pickFolder());
    pick.title = "素材のフォルダーを選ぶ（既定はネームの隣の「背景素材」。同じフォルダーのネーム＝ほかの話と共通）";
    const show = plainButton("開く", () => this.folder && void call("show_in_folder", { path: this.folder }).catch(() => {}));
    show.dataset.part = "assets-show";
    show.title = "素材のフォルダーをエクスプローラーで開く（3D のファイルを入れておける）";
    const reload = plainButton("読み直す", () => void this.load(true));
    reload.title = `素材のフォルダーの ${ASSETS_FILE} を読み直す`;
    const models = plainButton("3D を一覧に足す", () => void this.addFolderModels());
    models.dataset.part = "assets-models";
    models.title = "素材のフォルダーにある 3D のファイル（.blend・.fbx・.glb・.obj など）のうち、一覧にないものを「物」として足す";
    this.built = element(
      "details",
      { class: "drawing-assets", "data-part": "assets" },
      element("summary", {}, element("strong", {}, "素材"), " ", element("span", { class: "hint", "data-part": "assets-count" })),
      element(
        "p",
        { class: "hint" },
        "作品で使い回す場所・物（3D）。コマの「場所」や物の「素材」に選ぶと、AI は作り直さずにこれを使います。AI が新しく作った場所・物もここに足されます。あたり用の簡単な形で十分です。",
      ),
      element("div", { class: "drawing-folder" }, element("span", { "data-part": "assets-folder" }), pick, show, reload, models),
      element("p", { class: "hint assist-warn", "data-part": "assets-problems", hidden: "" }),
      element("div", { class: "drawing-asset-list", "data-part": "assets-list" }),
    );
    this.render();
    return this.built;
  }

  private part<T extends HTMLElement>(name: string): T {
    return this.built!.querySelector<T>(`[data-part="${name}"]`)!;
  }

  /** The folder (made when missing), or null when there is no saved name or chosen folder to put it by. */
  async ensure(loud: boolean): Promise<string | null> {
    const project = this.host.project();
    if (!project) return null;
    if (!this.host.path() && !project.backgrounds?.assets) {
      if (loud) this.host.status("素材のフォルダーは、ネームを保存すると隣に作れます（「選ぶ…」でほかの場所も）");
      return null;
    }
    this.folder = await call("bg_assets", { name: this.host.path(), folder: project.backgrounds?.assets ?? null });
    return this.folder;
  }

  /** Read 素材.json again (`loud`: say what was found). */
  async load(loud: boolean): Promise<void> {
    try {
      const folder = await this.ensure(loud);
      if (!folder) {
        this.list = [];
        this.problems = [];
      } else {
        const text = await call("bg_read", { folder, path: ASSETS_FILE, text: true });
        const read = text ? readAssets(text) : { assets: [], problems: [] };
        this.list = read.assets;
        this.problems = read.problems;
        if (loud) {
          this.thumbs.clear();
          this.host.status(`素材 ${this.list.length} 件（${ASSETS_FILE}）`);
        }
      }
    } catch (error) {
      if (loud) fail("素材のフォルダーを読めません", error);
    }
    this.render();
    this.host.changed();
  }

  /** A name opened anew: its own folder. */
  forget(): void {
    this.folder = null;
    this.list = [];
    this.problems = [];
    this.thumbs.clear();
    this.render();
  }

  private async pickFolder(): Promise<void> {
    const chosen = await open({ directory: true, title: "素材のフォルダー（作品で共通）" });
    if (typeof chosen !== "string") return;
    this.host.edit((project) => {
      project.backgrounds = { ...project.backgrounds, assets: chosen };
    });
    this.forget();
    await this.load(true);
  }

  private async addFolderModels(): Promise<void> {
    try {
      const folder = await this.ensure(true);
      if (!folder) return;
      const files = await call("bg_models", { folder });
      const next = addModels(this.list, files);
      const added = next.length - this.list.length;
      if (added) await this.write(next);
      this.host.status(
        added ? `素材に 3D を ${added} 件足しました（場所なら種類を変えてください）` : "一覧にない 3D のファイルはありません",
      );
    } catch (error) {
      fail("素材のフォルダーを読めません", error);
    }
  }

  /** 素材.json written with `next` (read again first, so what the AI added meanwhile stays). */
  private async write(next: BackgroundAsset[], removed?: string): Promise<void> {
    const folder = this.folder;
    if (!folder) return;
    const text = await call("bg_read", { folder, path: ASSETS_FILE, text: true }).catch(() => null);
    const read = text ? readAssets(text) : null;
    const there = read?.assets ?? [];
    const known = new Set([...this.list, ...next].map((asset) => asset.name));
    // Added there since it was read (by the AI): kept, unless it is the one taken away.
    const merged = [...next, ...there.filter((asset) => !known.has(asset.name) && asset.name !== removed)];
    await call("bg_write", { folder, files: [{ path: ASSETS_FILE, text: writeAssets(merged, read?.rest) }] });
    this.list = merged;
    this.render();
    this.host.changed();
  }

  private change(index: number, change: Partial<BackgroundAsset>): void {
    const before = this.list[index];
    if (!before) return;
    const next = this.list.map((asset, i) => (i === index ? { ...asset, ...change } : asset));
    for (const key of ["note", "collection", "license", "source", "author", "attribution"] as const)
      if (!next[index][key]?.trim()) delete next[index][key];
    if (change.name !== undefined) {
      const name = change.name.trim();
      if (!name || this.list.some((asset, i) => i !== index && asset.name === name)) {
        this.host.status(name ? `「${name}」はもうあります` : "素材の名前は空にできません");
        this.render();
        return;
      }
      next[index].name = name;
      // The panels and 物 that named it follow.
      this.host.edit((project) => {
        renameAssetUses(project, before.name, name);
      });
    }
    void this.write(next).catch((error) => fail(`${ASSETS_FILE} に書けません`, error));
  }

  render(): void {
    if (!this.built) return;
    this.part("assets-count").textContent = this.list.length ? `${this.list.length} 件` : "";
    const folder = this.part("assets-folder");
    folder.textContent = this.folder ?? "（ネームの隣の「背景素材」に作ります）";
    folder.title = this.folder ?? "";
    this.part<HTMLButtonElement>("assets-show").disabled = !this.folder;
    const problems = this.part("assets-problems");
    problems.hidden = !this.problems.length;
    problems.textContent = this.problems.join(" / ");
    const box = this.part("assets-list");
    // Not drawn again while a box in it is written in.
    if (box.contains(document.activeElement) && document.activeElement?.matches("input[type=text]")) return;
    const project = this.host.project();
    const uses = project ? assetUses(project, this.list) : new Map<string, number>();
    box.replaceChildren(
      ...(this.list.length
        ? this.list.map((asset, i) => this.row(asset, i, uses.get(asset.name) ?? 0))
        : [
            element(
              "p",
              { class: "hint" },
              "まだありません。3D のファイルをフォルダーに入れて「3D を一覧に足す」、または AI に作ってもらうと足されます。",
            ),
          ]),
    );
  }

  private row(asset: BackgroundAsset, index: number, used: number): HTMLElement {
    const name = element("input", { type: "text", "aria-label": "素材の名前", title: "素材の名前（コマの場所・物の名前で選ぶ名前）" });
    name.value = asset.name;
    const kind = element("select", { "aria-label": "素材の種類" });
    for (const [value, label] of Object.entries(ASSET_KIND_LABELS)) kind.append(element("option", { value }, label));
    kind.value = asset.kind;
    const note = element("input", {
      type: "text",
      "aria-label": "素材のメモ",
      placeholder: "大きさ・正面の向き・使い方",
      title: "AI への使い方のメモ（大きさ・正面の向き・どこで使うか）",
    });
    note.value = asset.note ?? "";
    // Where it came from: name-blockout uses only 素材 free to use in work that is sold, and credits those that ask.
    const license = element("input", {
      type: "text",
      class: "drawing-asset-license",
      list: "drawing-licenses",
      "aria-label": "ライセンス",
      placeholder: "ライセンス",
      title: "素材のライセンス（CC0-1.0・CC-BY-4.0 など。自分で作ったものは own）。無料で商用にも使えるものだけ背景に使われます",
    });
    license.value = asset.license ?? "";
    license.size = 10;
    const source = element("input", {
      type: "text",
      class: "drawing-asset-source",
      "aria-label": "出どころ",
      placeholder: "出どころ（URL）",
      title: "素材を取ってきたページ。クレジットに使います",
    });
    source.value = asset.source ?? "";
    for (const box of [name, note, license, source])
      box.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") box.blur();
      });
    name.addEventListener("change", () => this.change(index, { name: name.value }));
    kind.addEventListener("change", () => this.change(index, { kind: kind.value as AssetKind }));
    note.addEventListener("change", () => this.change(index, { note: note.value }));
    license.addEventListener("change", () => this.change(index, { license: license.value.trim() }));
    source.addEventListener("change", () => this.change(index, { source: source.value.trim() }));
    const remove = plainButton("外す", () => {
      void this.write(
        this.list.filter((_, i) => i !== index),
        asset.name,
      )
        .then(() => this.host.status(`「${asset.name}」を一覧から外しました（ファイルはフォルダーに残ります）`))
        .catch((error) => fail(`${ASSETS_FILE} に書けません`, error));
    });
    remove.title = "一覧から外す（3D のファイルは消しません）";
    const picture = element("span", { class: "drawing-asset-picture" });
    const url = asset.picture && this.thumbs.get(asset.picture);
    if (url) picture.append(element("img", { src: url, alt: asset.name }));
    else if (asset.picture) void this.thumb(asset.picture);
    const file = element("span", { class: "hint drawing-asset-file", title: asset.file }, asset.file);
    const meta = [asset.by === "AI" ? "AI が作った" : "", used ? `${used} か所で使用` : ""].filter(Boolean).join("・");
    return element(
      "div",
      { class: "drawing-asset", "data-asset": asset.name },
      picture,
      element(
        "div",
        { class: "drawing-asset-body" },
        element("div", { class: "assist-row" }, name, kind, remove),
        note,
        element("div", { class: "assist-row" }, license, source),
        element("div", { class: "assist-row" }, file, ...(meta ? [element("span", { class: "hint" }, meta)] : [])),
      ),
    );
  }

  private async thumb(file: string): Promise<void> {
    if (!this.folder || this.thumbs.has(file)) return;
    this.thumbs.set(file, "");
    try {
      const data = await call("bg_read", { folder: this.folder, path: file, text: false });
      if (!data) return;
      const bitmap = await createImageBitmap(toBlob(data));
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      this.thumbs.set(file, canvas.toDataURL("image/jpeg", 0.8));
      this.render();
    } catch {
      // A picture not readable stays without its small picture.
    }
  }
}
