// 自動更新: a released build looks for a newer release when it starts. With
// nothing open yet it installs it and starts again at once; with a name open
// it waits for the user to press the update button (after autosave). The
// setting can make it only tell of a new version, or not look at all (then
// 「今すぐ確かめる」 in the settings looks when asked).
// 前の版に戻す: a release that went wrong can be swapped for an earlier one
// (signed like any update); updates then stay paused until turned on again.
import { call } from "./backend";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { $ } from "./dom";
import { readFlag, readText, writeText } from "./settings";

/** Before the three ways, a flag: on meant 「notify」. */
const PAUSED_KEY = "namestudio.updatesPaused";
const MODE_KEY = "namestudio.updateMode";
const RELEASES = "https://api.github.com/repos/nanikasheila/name-studio/releases?per_page=60";

/** On start: put a new version in by itself, only tell of it, or not look. */
export type UpdateMode = "auto" | "notify" | "off";

export const UPDATE_MODES: readonly UpdateMode[] = ["auto", "notify", "off"];

export function updateMode(): UpdateMode {
  const mode = readText(MODE_KEY);
  if (mode && (UPDATE_MODES as readonly string[]).includes(mode)) return mode as UpdateMode;
  return readFlag(PAUSED_KEY, false) ? "notify" : "auto";
}

export function setUpdateMode(mode: UpdateMode): void {
  writeText(MODE_KEY, mode);
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

/** What one look for a new version found. */
export type UpdateCheck =
  | { kind: "found"; update: Update }
  | { kind: "latest" }
  /** A build from the source (npm run tauri dev): never updated. */
  | { kind: "notRelease" }
  | { kind: "failed"; error: string };

/** Look for a newer release once. Never throws. */
export async function lookForUpdate(): Promise<UpdateCheck> {
  try {
    if (!(await call("is_release_build"))) return { kind: "notRelease" };
  } catch {
    return { kind: "notRelease" };
  }
  try {
    const update = await check({ timeout: 15000 });
    return update ? { kind: "found", update } : { kind: "latest" };
  } catch (error) {
    // Offline, or no release with an update key yet: try again next start.
    console.warn("update check failed", error);
    return { kind: "failed", error: String(error) };
  }
}

/**
 * On start, as the setting says: look (unless it is off) and put a new
 * version in or tell of it. Returns the update found, if any. Never throws.
 */
export async function checkForUpdate(host: UpdateHost, mode: UpdateMode = updateMode()): Promise<Update | null> {
  if (mode === "off") return null;
  const found = await lookForUpdate();
  if (found.kind !== "found") return null;
  const update = found.update;
  offer(update, host);
  if (mode === "notify") host.status(`新しい版 ${update.version} があります（自動では入れない設定です。右上の「更新」で入れます）`);
  else if (!host.busy()) await install(update, host);
  else host.status(`新しい版 ${update.version} があります。右上の「更新」で入れ替えます（作業は自動保存してから）`);
  return update;
}

/** 「今すぐ確かめる」: look now whatever the setting, and say what was found; a new version waits for the button. */
export async function checkNow(host: UpdateHost): Promise<UpdateCheck> {
  host.status("新しい版を確かめています…");
  const found = await lookForUpdate();
  if (found.kind === "found") {
    offer(found.update, host);
    host.status(`新しい版 ${found.update.version} があります。右上の「更新」で入れます`);
  } else if (found.kind === "latest") {
    const version = await appVersion();
    host.status(`いまの版${version ? ` ${version}` : ""}が最新です`);
  }
  else if (found.kind === "notRelease") host.status("開発中の版なので、更新は確かめません");
  else host.status(`新しい版を確かめられませんでした（ネットにつながっているか確かめてください）: ${found.error}`);
  return found;
}

/** The 「更新」 button at the top right, which puts `update` in. */
function offer(update: Update, host: UpdateHost): void {
  const button = $<HTMLButtonElement>("update");
  button.textContent = `更新 ${update.version}`;
  button.title = `新しい版 ${update.version} を入れて再起動します${update.body ? `\n\n${update.body}` : ""}`;
  button.hidden = false;
  button.onclick = () => void install(update, host);
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
  if (updateMode() === "auto") setUpdateMode("notify");
  host.status(`版 ${version} を取り込んでいます…（新しい版は知らせるだけにしました）`);
  try {
    await call("install_release", { version });
    await relaunch();
  } catch (error) {
    host.status(`版 ${version} を入れられませんでした: ${error}`);
  }
}
