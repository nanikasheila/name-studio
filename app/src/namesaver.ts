// Saving the open name: Ctrl+S and 名前を付けて保存, autosave (the file
// itself or a copy), one write after another, the series file after the
// name, and asking before the name is closed with changes not saved. The
// workbench shows what this keeps (the save state beside the name's title).
import { call } from "./backend";
import { message, save } from "@tauri-apps/plugin-dialog";
import { Autosaver, Written, autosaveToFile } from "./autosave";
import { clearAlert, showAlert } from "./alerts";
import { logError } from "./errorlog";
import type { Project } from "./model";
import { rememberName } from "./prefs";
import { projectBody } from "./projectjson";
import { savedForm } from "./references";
import { repair } from "./repair";
import type { SaveFacts } from "./savestate";
import type { Session } from "./session";

export const PROJECT_EXTENSION = "namestudio";

export interface NameSaverHost {
  readonly session: Session;
  /** The series the name belongs to: told before the name is saved, then brought up to date. */
  readonly series: {
    beforeSave(project: Project, path: string): void;
    saved(project: Project, path: string): Promise<string | null>;
  };
  setStatus(message: string): void;
  /** A change as one undoable step (mending before a save). */
  begin(): void;
  commit(): void;
  /** What is kept, or the name's path, changed: the title and the save state again. */
  changed(): void;
}

export class NameSaver {
  /** The save or autosave being written, which the next one waits for. */
  private writing: Promise<unknown> = Promise.resolve();
  /** Saves and autosaves being written. */
  private writes = 0;
  /** Where the open name's changes are kept, for the save state beside its name. */
  private kept: Omit<SaveFacts, "hasPath" | "dirty" | "writing"> = { savedAt: null, copyAt: null, failed: null, seriesBehind: false };
  private readonly autosaver: Autosaver;
  /** What the file and the recovery copy hold, so autosave writes only what is new. */
  private readonly written = new Written();

  constructor(private readonly host: NameSaverHost) {
    this.autosaver = new Autosaver(() => this.autosave(), () => host.session.inStep).followSettings();
  }

  /** What the save state shows, but for the path and whether it is dirty. */
  facts(): Omit<SaveFacts, "hasPath" | "dirty"> {
    return { ...this.kept, writing: this.writes > 0 };
  }

  /** A change was made: autosave picks it up. */
  notify(): void {
    this.autosaver.notify();
  }

  /** The autosave setting changed: what is unsaved goes where it says now. */
  settingsChanged(): void {
    if (this.host.session.dirty) this.autosaver.notify();
  }

  /** The autosave timing changed. */
  timingChanged(): void {
    this.autosaver.followSettings();
  }

  /** Another name is open: nothing of the last one is kept or waited for. */
  opened(): void {
    this.kept = { savedAt: null, copyAt: null, failed: null, seriesBehind: false };
    this.autosaver.reset();
    this.written.forget();
  }

  /** The open name is just as its file holds it. */
  loaded(path: string): void {
    this.written.toFile(this.host.session.id, path, this.host.session.snapshot());
  }

  /** The open name came back from the autosave copy written at `timeMs`. */
  recovered(path: string | null, timeMs: number): void {
    this.kept.copyAt = timeMs;
    this.written.toCopy(this.host.session.id, path, this.host.session.snapshot());
  }

  /** Before the open name goes: saved, or let go when the person says so. False: keep it open. */
  async confirmDiscard(): Promise<boolean> {
    const session = this.host.session;
    if (!session.project) return true;
    if (session.dirty && session.path && autosaveToFile()) await this.autosaver.flush();
    if (!session.dirty) return true;
    const [keep, discard] = ["保存して続ける", "保存しないで続ける"];
    const choice = await message("保存していない変更があります。", { title: "Name Studio", kind: "warning", buttons: { yes: keep, no: discard, cancel: "戻る" } });
    if (choice === keep || choice === "Yes") return this.save();
    if (choice !== discard && choice !== "No") return false;
    this.autosaver.reset();
    await call("discard_recovery", { path: session.path }).catch(() => undefined);
    return true;
  }

  async save(saveAs = false): Promise<boolean> {
    const session = this.host.session;
    const project = session.project;
    if (!project) return false;
    let path = session.path;
    if (!path || saveAs) {
      const suggested = project.source?.path.replace(/\.clip$/i, `.${PROJECT_EXTENSION}`) ?? `${project.title || "ネーム"}.${PROJECT_EXTENSION}`;
      const picked = await save({
        defaultPath: path ?? suggested,
        filters: [{ name: "ネームデータ", extensions: [PROJECT_EXTENSION] }],
      });
      if (!picked) return false;
      path = picked.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) ? picked : `${picked}.${PROJECT_EXTENSION}`;
    }
    // Loose ends the save check would refuse are mended first, as a step that can be undone.
    this.host.begin();
    const mended = repair(project);
    if (mended.length) this.host.commit();
    else session.cancel();
    this.host.series.beforeSave(project, path);
    const id = session.id;
    const previousPath = session.path;
    try {
      const [revision, snapshot] = await this.queued(async () => {
        const revision = session.revision;
        const snapshot = session.id === id ? session.snapshot() : null;
        await call("save_project", projectBody({ path, previousPath }, savedForm(project)));
        return [revision, snapshot] as const;
      });
      rememberName(path, project);
      if (!session.saved(path, revision, id)) {
        // Another name was opened while this one was written: it keeps its own file and state.
        this.host.setStatus(`前に開いていたネームを保存しました: ${path}`);
        return true;
      }
      this.written.toFile(id, path, snapshot);
      this.kept = { ...this.kept, savedAt: Date.now(), copyAt: null, failed: null };
      const series = await this.saveSeries(project, path);
      if (!session.dirty) this.autosaver.reset();
      this.host.changed();
      clearAlert("save");
      if (mended.length) clearAlert("autosave");
      const note = mended.length ? `（保存の前に ${mended.length} か所直しました: ${mended.slice(0, 2).join("／")}${mended.length > 2 ? " ほか" : ""}。元に戻すは Ctrl+Z）` : "";
      this.host.setStatus(series ? `ネームは保存しました（シリーズには未反映）: ${path}` : `保存しました: ${path}${note}`);
      return true;
    } catch (error) {
      if (session.id !== id) {
        this.host.setStatus(`前に開いていたネームを保存できませんでした: ${error}`);
      } else {
        this.host.setStatus(`保存できませんでした: ${error}`);
      }
      if (session.id === id) this.kept.failed = String(error);
      this.host.changed();
      showAlert("save", `保存できませんでした。\n${path}\n${error}`, "error");
      void logError(`save: ${error}`);
      return false;
    }
  }

  /**
   * Saves and autosaves one after another, so an older version never lands
   * after a newer one.
   */
  private queued<T>(write: () => Promise<T>): Promise<T> {
    this.writes++;
    this.host.changed();
    const run = this.writing.then(write, write).finally(() => {
      this.writes--;
      this.host.changed();
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  /**
   * The series after the open name was saved: an alert stays while the series
   * file lags behind, with a way to try again. Null when it has it.
   */
  private async saveSeries(project: Project, path: string): Promise<string | null> {
    const problem = await this.host.series.saved(project, path);
    this.kept.seriesBehind = !!problem;
    this.host.changed();
    if (problem) {
      showAlert("series", `ネームは保存しました。シリーズのファイルには反映できていません（次の保存でもう一度試します）。\n${problem}`, "warning", undefined, {
        label: "もう一度",
        run: () => void this.retrySeries(),
      });
    } else {
      clearAlert("series");
    }
    return problem;
  }

  private async retrySeries(): Promise<void> {
    const project = this.host.session.project;
    const path = this.host.session.path;
    if (project && path && !(await this.saveSeries(project, path))) this.host.setStatus("シリーズに反映しました");
  }

  /**
   * Autosave: the file itself when it has one (and that is on), else a copy;
   * nothing when that already holds the name as it is now.
   */
  private async autosave(): Promise<void> {
    const session = this.host.session;
    const project = session.project;
    if (!project) return;
    const path = session.path;
    const id = session.id;
    try {
      const [result, revision, snapshot] = await this.queued(async () => {
        const revision = session.revision;
        const toFile = autosaveToFile();
        const snapshot = session.id === id ? session.snapshot() : null;
        const need = this.written.need(id, path, toFile, snapshot);
        if (need === "clean" || need === "none") return [need, revision, snapshot] as const;
        const result = await call("autosave_project", projectBody({ path, toFile }, savedForm(project)));
        return [result, revision, snapshot] as const;
      });
      // A name opened meanwhile is not this one: its state and alerts stay as they are.
      if (session.id !== id) return;
      if (result === "none") return;
      if (result === "clean") {
        // Changed and changed back: the file has it all, and a copy kept on the way is stale.
        session.autosaved(revision, id);
        if (this.kept.copyAt !== null) await call("discard_recovery", { path }).catch(() => undefined);
        this.kept = { ...this.kept, copyAt: null, failed: null };
        this.host.changed();
        return;
      }
      if (result.savedToFile && path) this.written.toFile(id, path, snapshot);
      else this.written.toCopy(id, path, snapshot);
      if (result.savedToFile && session.path === path) {
        session.autosaved(revision, id);
        this.kept = { ...this.kept, savedAt: Date.now(), copyAt: null, failed: null };
      } else this.kept = { ...this.kept, copyAt: Date.now(), failed: null };
      this.host.changed();
      if (result.savedToFile && path) await this.saveSeries(project, path);
      if (result.problems?.length) {
        const list = result.problems.slice(0, 3).join("\n");
        showAlert(
          "autosave",
          `自動保存: ${path && autosaveToFile() ? "ファイルに書けない" : ""}問題があるので、控えだけに残しています。保存（Ctrl+S）すると直してから保存します。\n${list}`,
          "warning",
        );
      } else {
        clearAlert("autosave");
      }
    } catch (error) {
      if (session.id !== id) return;
      this.kept.failed = String(error);
      this.host.changed();
      this.host.setStatus(`自動保存できませんでした: ${error}`);
      showAlert("autosave", `自動保存できませんでした（次の変更でもう一度試します）。\n${error}`, "error");
      void logError(`autosave: ${error}`);
      throw error;
    }
  }
}
