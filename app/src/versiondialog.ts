// The dialog of earlier versions (版の履歴) and the autosave setting.
import { call, type VersionInfo, type VersionKind } from "./backend";
export type { VersionInfo, VersionKind } from "./backend";
import { ask } from "@tauri-apps/plugin-dialog";
import { autosaveToFile, formatTime, setAutosaveToFile } from "./autosave";

export const KIND_NAMES: Record<VersionKind, string> = {
  saved: "保存",
  auto: "自動",
  beforeRestore: "戻す前",
};

export interface VersionDialogHost {
  /** The project file, or null while it has none. */
  path(): string | null;
  restore(version: VersionInfo): Promise<void>;
  /** The autosave setting was changed. */
  autosaveChanged(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class VersionDialog {
  constructor(private readonly host: VersionDialogHost) {
    $<HTMLInputElement>("vd-autosave").addEventListener("change", (event) => {
      setAutosaveToFile((event.target as HTMLInputElement).checked);
      this.host.autosaveChanged();
    });
  }

  async open(): Promise<void> {
    $<HTMLInputElement>("vd-autosave").checked = autosaveToFile();
    const path = this.host.path();
    $("vd-where").textContent = path
      ? "保存するたび、また編集中は 5 分ごとに版を残します（種類ごとに古いものから消え、保存は 100 版まで）。"
      : "まだ保存していないネームです。保存先を決めると、ここまでの版もそのファイルの履歴になります。";
    $<HTMLDialogElement>("version-dialog").showModal();
    await this.render(path);
  }

  private async render(path: string | null): Promise<void> {
    const list = $("vd-list");
    list.replaceChildren();
    let versions: VersionInfo[];
    try {
      versions = await call("list_versions", { path });
    } catch (error) {
      this.message(`履歴を読めませんでした: ${error}`, true);
      return;
    }
    this.message(versions.length ? "" : "まだ版がありません。保存するか、しばらく編集すると残ります。");
    for (const version of versions) {
      const row = document.createElement("div");
      row.className = "version";
      const kind = document.createElement("span");
      kind.className = `kind ${version.kind}`;
      kind.textContent = KIND_NAMES[version.kind];
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = formatTime(version.timeMs);
      const what = document.createElement("span");
      what.className = "what";
      what.textContent = `${version.title}・${version.pages} ページ・${Math.max(1, Math.round(version.bytes / 1024))} KB`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "この版に戻す";
      button.addEventListener("click", () => void this.restore(version));
      row.append(kind, time, what, button);
      list.append(row);
    }
  }

  private async restore(version: VersionInfo): Promise<void> {
    const sure = await ask(
      `${formatTime(version.timeMs)} の版（${version.pages} ページ）に戻しますか？\n今の状態も「戻す前」の版として残り、「元に戻す」でも戻せます。`,
      { title: "版の履歴", kind: "info" },
    );
    if (!sure) return;
    try {
      await this.host.restore(version);
      $<HTMLDialogElement>("version-dialog").close();
    } catch (error) {
      this.message(`戻せませんでした: ${error}`, true);
    }
  }

  private message(text: string, error = false): void {
    const node = $("vd-message");
    node.textContent = text;
    node.classList.toggle("error", error);
  }
}
