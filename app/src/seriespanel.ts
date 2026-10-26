// The シリーズ palette: the names (話) of the series the open name is in, to
// open the next one or make it, and the series file kept up to date as the
// name is saved (what is shared, and the list of its names).
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { call } from "./backend";
import { element, plainButton } from "./dom";
import type { Project, Series } from "./model";
import { nameKind, newProject } from "./project";
import {
  applyShared,
  folderOf,
  joinedShared,
  newSeries,
  nextStoryIndex,
  relativePath,
  resolvePath,
  samePath,
  SERIES_EXTENSION,
  sharedSummary,
  stemOf,
  withEpisode,
  withoutEpisode,
} from "./series";

export interface SeriesHost {
  project(): Project | null;
  /** The open name's file (null: not saved yet). */
  path(): string | null;
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  /** Save the open name (asking where when it has no file yet). */
  save(): Promise<boolean>;
  /** Open another name of the series (asking first about unsaved changes). */
  open(path: string): Promise<void>;
  /** Show the palette again (the series was read or written). */
  refresh(): void;
  /** Show a new name with its file chosen and save it (asking first about unsaved changes). */
  adopt(project: Project, path: string, message: string): Promise<void>;
}

interface OpenSeries {
  path: string;
  data: Series;
  /** What was last written, to write only changes. */
  written: string;
}

export const NAME_EXTENSION = "namestudio";

export class SeriesPanel {
  private current: OpenSeries | null = null;
  /** The series file last looked for and not read (not looked for again at each render). */
  private missing: string | null = null;

  constructor(private readonly host: SeriesHost) {}

  get series(): Series | null {
    return this.current?.data ?? null;
  }

  /** The series file of a name at `namePath`, if it is in one. */
  private fileOf(project: Project, namePath: string | null): string | null {
    return project.series && namePath ? resolvePath(folderOf(namePath), project.series) : null;
  }

  /**
   * A name was opened: read its series and bring the shared settings in
   * (the series wins). Says what happened when it could not be read.
   */
  async attach(project: Project, namePath: string): Promise<string> {
    const file = this.fileOf(project, namePath);
    this.current = null;
    if (!file) return "";
    try {
      const data = await call("load_series", { path: file });
      this.current = { path: file, data, written: JSON.stringify(data) };
      applyShared(project, data.shared);
      return `（シリーズ「${data.title}」の人物・設定に合わせました）`;
    } catch (error) {
      return `（シリーズのファイルを読めなかったので、ネームに残っている人物・設定のまま開きました: ${error}）`;
    }
  }

  /**
   * Another name is shown: forget the series unless it is still this one's;
   * one opened otherwise (restored from autosave) has its series read to be
   * kept up to date, without changing the name.
   */
  follow(project: Project, namePath: string | null): void {
    const file = this.fileOf(project, namePath);
    if (file && this.current && samePath(file, this.current.path)) return;
    this.current = null;
    if (!file || (this.missing && samePath(file, this.missing))) return;
    void call("load_series", { path: file }).then(
      (data) => {
        if (this.host.project() !== project || this.current) return;
        this.current = { path: file, data, written: JSON.stringify(data) };
        this.missing = null;
        this.host.refresh();
      },
      () => (this.missing = file),
    );
  }

  /**
   * Before the name is written to `namePath`: its link to the series from
   * there (a name saved elsewhere keeps finding it).
   */
  beforeSave(project: Project, namePath: string): void {
    if (!this.current || !project.series) return;
    const link = relativePath(folderOf(namePath), this.current.path);
    if (link) project.series = link;
  }

  /**
   * The name was written: the series takes what it shares now and lists it.
   * Null when the series has it, else why not (the series file then stays
   * behind, and the next save tries again).
   */
  async saved(project: Project, namePath: string): Promise<string | null> {
    const current = this.current;
    if (!current || !project.series) return null;
    const entry = relativePath(folderOf(current.path), namePath);
    if (!entry) return "このネームはシリーズのファイルと別のドライブにあるので、シリーズの一覧には入れられません";
    const problem = await this.write(current, withEpisode(current.data, project, entry));
    this.host.refresh();
    return problem;
  }

  /** The series file does not have what the open name shares yet (a write failed). */
  get behind(): boolean {
    const current = this.current;
    return !!current && JSON.stringify(current.data, null, 2) !== current.written;
  }

  /** Null when written (or already so), else why it could not be. */
  private async write(current: OpenSeries, data: Series): Promise<string | null> {
    const text = JSON.stringify(data, null, 2);
    current.data = data;
    if (text === current.written) return null;
    try {
      await call("save_series", { path: current.path, text });
      current.written = text;
      return null;
    } catch (error) {
      return `シリーズのファイルに書けませんでした: ${error}`;
    }
  }

  render(container: HTMLElement): void {
    const project = this.host.project();
    if (!project) {
      container.replaceChildren();
      return;
    }
    // Undo can take the link away or bring it back.
    if (project.series && !this.current) this.follow(project, this.host.path());
    const current = project.series ? this.current : null;
    if (!current) {
      const note = project.series
        ? "このネームはシリーズに入っていますが、シリーズのファイルが見つかりません。もう一度入れ直せます。"
        : "シリーズにすると、何話ものネームで人物・ブラシ・フォント・作品の既定・CSP のページ設定を共有して、話から話へ移れます。";
      const make = plainButton("シリーズを作る…", () => void this.create());
      make.id = "series-create";
      make.title = "このネームを第 1 話として、シリーズのファイル（.nameseries）を作る";
      const join = plainButton("シリーズに入れる…", () => void this.join());
      join.id = "series-join";
      join.title = "すでにあるシリーズのファイルを選んで、このネームを加える（人物・設定はシリーズに合わせ、このネームだけの人物も残します）";
      container.replaceChildren(element("p", { className: "hint", textContent: note }), element("div", { className: "series-tools" }, make, join));
      return;
    }
    const { data } = current;
    const here = this.host.path();
    const folder = folderOf(current.path);
    const head = element("div", { className: "series-head" }, element("strong", { textContent: data.title }));
    if (data.author) head.append(element("span", { className: "layer-detail", textContent: data.author }));
    const list = element("ol", { className: "series-list" });
    for (const episode of data.episodes) {
      const file = resolvePath(folder, episode.path);
      const mine = !!here && samePath(file, here);
      const number = episode.storyIndex !== undefined ? `第${episode.storyIndex}話` : "";
      const row = element(
        "li",
        { className: `series-row${mine ? " selected" : ""}`, title: mine ? "開いているネーム" : `開く: ${episode.path}` },
        element("span", { className: "series-number", textContent: number }),
        element("span", { className: "layer-name", textContent: episode.title }),
        element("span", { className: "layer-detail", textContent: `${episode.pages} ページ` }),
      );
      row.dataset.episode = episode.path;
      if (!mine) row.addEventListener("click", () => void this.host.open(file));
      list.append(row);
    }
    const next = plainButton("次の話を作る…", () => void this.createNext());
    next.id = "series-next";
    next.title = `第${nextStoryIndex(data)}話を、シリーズの人物・設定で白紙から作る`;
    const leave = plainButton("シリーズから外す", () => void this.leave());
    leave.id = "series-leave";
    leave.title = "このネームをシリーズの一覧から外す（人物・設定はネームに残ります）";
    container.replaceChildren(
      head,
      list,
      element("p", { className: "hint", textContent: `共有: ${sharedSummary(data.shared)}。保存するとシリーズにも入り、ほかの話を開くとそれに合わせます。` }),
      element("div", { className: "series-tools" }, next, leave),
    );
  }

  /** A new series with the open name as its first 話 (the name is saved first). */
  private async create(): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    if (!this.host.path() && !(await this.host.save())) return;
    const namePath = this.host.path();
    if (!namePath) return;
    const picked = await save({
      defaultPath: `${folderOf(namePath)}/${project.title || "シリーズ"}.${SERIES_EXTENSION}`,
      filters: [{ name: "シリーズ", extensions: [SERIES_EXTENSION] }],
    });
    if (!picked) return;
    const path = picked.toLowerCase().endsWith(`.${SERIES_EXTENSION}`) ? picked : `${picked}.${SERIES_EXTENSION}`;
    const link = relativePath(folderOf(namePath), path);
    const entry = relativePath(folderOf(path), namePath);
    if (!link || !entry) {
      this.host.status("シリーズのファイルは、ネームと同じドライブに置いてください");
      return;
    }
    if (project.storyIndex === undefined) this.host.edit((p) => (p.storyIndex = 1));
    const data = newSeries(project, stemOf(path), entry);
    this.current = { path, data, written: "" };
    this.host.edit((p) => (p.series = link));
    await this.write(this.current, data);
    // The save writes the series again when this could not; it tells why.
    if (!(await this.host.save()) || this.behind) return;
    this.host.status(`シリーズ「${data.title}」を作りました。「次の話を作る」で同じ人物・設定の次の話を作れます`);
  }

  /** The open name into a series that is already there. */
  private async join(): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    const picked = await open({ multiple: false, filters: [{ name: "シリーズ", extensions: [SERIES_EXTENSION] }] });
    if (typeof picked !== "string") return;
    if (!this.host.path() && !(await this.host.save())) return;
    const namePath = this.host.path();
    if (!namePath) return;
    const link = relativePath(folderOf(namePath), picked);
    if (!link) {
      this.host.status("シリーズのファイルは、ネームと同じドライブに置いてください");
      return;
    }
    let data: Series;
    try {
      data = await call("load_series", { path: picked });
    } catch (error) {
      this.host.status(`シリーズのファイルを読めませんでした: ${error}`);
      return;
    }
    const shared = joinedShared(project, data.shared);
    this.current = { path: picked, data, written: JSON.stringify(data) };
    this.host.edit((p) => {
      applyShared(p, shared);
      p.series = link;
      if (p.storyIndex === undefined) p.storyIndex = nextStoryIndex(data);
    });
    await this.host.save();
    this.host.status(`シリーズ「${data.title}」に入れました（人物・設定はシリーズに合わせました。元に戻すは Ctrl+Z）`);
  }

  private async leave(): Promise<void> {
    const current = this.current;
    const namePath = this.host.path();
    if (!current || !namePath) return;
    if (!(await ask(`このネームをシリーズ「${current.data.title}」から外しますか？（人物・設定はネームに残ります）`, { title: "Name Studio", kind: "info" }))) return;
    const entry = relativePath(folderOf(current.path), namePath);
    const problem = entry ? await this.write(current, withoutEpisode(current.data, entry)) : null;
    if (problem) {
      this.host.status(`${problem}（シリーズから外していません）`);
      return;
    }
    this.current = null;
    this.host.edit((p) => delete p.series);
    this.host.status(`シリーズ「${current.data.title}」から外しました`);
  }

  /** The next 話: a blank name with the series' characters and settings, saved next to the series. */
  private async createNext(): Promise<void> {
    const current = this.current;
    const project = this.host.project();
    if (!current || !project) return;
    const index = nextStoryIndex(current.data);
    const title = `第${index}話`;
    const picked = await save({
      defaultPath: `${folderOf(current.path)}/${title}.${NAME_EXTENSION}`,
      filters: [{ name: "ネームデータ", extensions: [NAME_EXTENSION] }],
    });
    if (!picked) return;
    const path = picked.toLowerCase().endsWith(`.${NAME_EXTENSION}`) ? picked : `${picked}.${NAME_EXTENSION}`;
    const link = relativePath(folderOf(path), current.path);
    if (!link) {
      this.host.status("ネームは、シリーズのファイルと同じドライブに置いてください");
      return;
    }
    const next = newProject(title, project.pages.length, nameKind(project));
    next.storyIndex = index;
    next.author = current.data.author || project.author;
    next.pageFormat = structuredClone(project.pageFormat);
    applyShared(next, current.data.shared);
    next.series = link;
    await this.host.adopt(next, path, `シリーズ「${current.data.title}」の${title}を作りました（${next.pages.length} ページ、人物 ${next.characters.length}）`);
  }
}
