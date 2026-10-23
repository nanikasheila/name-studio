// 自動更新: a released build looks for a newer release when it starts. With
// nothing open yet it installs it and starts again at once; with a name open
// it waits for the user to press the update button (after autosave).
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export interface UpdateHost {
  status(message: string): void;
  /** True while a project is open: then the user picks the moment. */
  busy(): boolean;
  /** Write what autosave has not yet; false to hold the update back. */
  prepare(): Promise<boolean>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

/** Check once; returns the update found, if any. Never throws. */
export async function checkForUpdate(host: UpdateHost): Promise<Update | null> {
  try {
    if (!(await invoke<boolean>("is_release_build"))) return null;
  } catch {
    return null;
  }
  let update: Update | null;
  try {
    update = await check({ timeout: 15000 });
  } catch (error) {
    // Offline, or no release with an update key yet: try again next start.
    console.warn("update check failed", error);
    return null;
  }
  if (!update) return null;
  const button = $<HTMLButtonElement>("update");
  button.textContent = `更新 ${update.version}`;
  button.title = `新しい版 ${update.version} を入れて再起動します${update.body ? `\n\n${update.body}` : ""}`;
  button.hidden = false;
  button.onclick = () => void install(update!, host);
  if (!host.busy()) await install(update, host);
  else host.status(`新しい版 ${update.version} があります。右上の「更新」で入れ替えます（作業は自動保存してから）`);
  return update;
}

async function install(update: Update, host: UpdateHost): Promise<void> {
  if (!(await host.prepare())) return;
  const button = $<HTMLButtonElement>("update");
  button.disabled = true;
  let total = 0;
  let received = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        received += event.data.chunkLength;
        const percent = total ? ` ${Math.round((received / total) * 100)}%` : "";
        host.status(`新しい版 ${update.version} を取り込み中…${percent}`);
      }
      if (event.event === "Finished") host.status(`新しい版 ${update.version} を入れています…`);
    });
    // Windows closes the app for the installer, which starts it again; elsewhere restart here.
    await relaunch();
  } catch (error) {
    button.disabled = false;
    host.status(`更新できませんでした（次の起動でもう一度試します）: ${error}`);
  }
}
