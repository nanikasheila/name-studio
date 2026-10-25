// 自動更新: a released build looks for a newer release when it starts. With
// nothing open yet it installs it and starts again at once; with a name open
// it waits for the user to press the update button (after autosave).
// 前の版に戻す: a release that went wrong can be swapped for an earlier one
// (signed like any update); updates then stay paused until turned on again.
import { call } from "./backend";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { $ } from "./dom";
import { readFlag, writeFlag } from "./settings";

const PAUSED_KEY = "namestudio.updatesPaused";
const RELEASES = "https://api.github.com/repos/nanikasheila/name-studio/releases?per_page=60";

/** Whether new versions are put in by themselves when the app starts. */
export function updatesPaused(): boolean {
  return readFlag(PAUSED_KEY, false);
}

export function setUpdatesPaused(paused: boolean): void {
  writeFlag(PAUSED_KEY, paused);
}

export interface UpdateHost {
  status(message: string): void;
  /** True while a project is open: then the user picks the moment. */
  busy(): boolean;
  /** Write what autosave has not yet; false to hold the update back. */
  prepare(): Promise<boolean>;
}

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
    if (!(await call("is_release_build"))) return null;
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
  if (updatesPaused()) host.status(`新しい版 ${update.version} があります（自動更新は止めています。右上の「更新」で入れます）`);
  else if (!host.busy()) await install(update, host);
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

/** A release that can be put in: its version, when it was made and the first line of its notes. */
export interface Release {
  version: string;
  date: string;
  title: string;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string | null;
  body: string | null;
  draft: boolean;
  assets: { name: string }[];
}

/** The releases that can be put in (signed, with their latest.json), newest first. */
export function installableReleases(list: GitHubRelease[]): Release[] {
  return list
    .filter((release) => !release.draft && /^v\d+\.\d+\.\d+$/.test(release.tag_name) && release.assets.some((asset) => asset.name === "latest.json"))
    .map((release) => ({
      version: release.tag_name.slice(1),
      date: (release.published_at ?? "").slice(0, 10),
      title: (release.body ?? "").split("\n")[0].trim(),
    }));
}

/** The releases on GitHub that can be put in. */
export async function releases(): Promise<Release[]> {
  const response = await fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub から版の一覧を読めませんでした（${response.status}）`);
  return installableReleases((await response.json()) as GitHubRelease[]);
}

/** Put in release `version` and start again; automatic updates stay paused so it stays. */
export async function installRelease(version: string, host: Pick<UpdateHost, "status" | "prepare">): Promise<void> {
  if (!(await host.prepare())) return;
  setUpdatesPaused(true);
  host.status(`版 ${version} を取り込んでいます…（自動更新は止めました）`);
  try {
    await call("install_release", { version });
    await relaunch();
  } catch (error) {
    host.status(`版 ${version} を入れられませんでした: ${error}`);
  }
}
