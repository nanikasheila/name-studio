// 使われ方 kept on this computer (editing/usage.ts counts): in the app's local
// storage only, written a moment after a use (not at every key) and when the
// window goes. Nothing here is sent anywhere.
import { countUse, emptyUsage, type Usage, type UseKind, usageFrom, usedToday } from "../editing/usage";
import { readJson, writeJson } from "./settings";

const USAGE_KEY = "namestudio.usage";
/** How long after a use it is written (uses come many a second while working). */
const KEEP_AFTER_MS = 2000;

let usage: Usage | null = null;
let timer = 0;

function current(): Usage {
  usage ??= usageFrom(readJson(USAGE_KEY, null), Date.now());
  return usage;
}

function keep(): void {
  if (timer) window.clearTimeout(timer);
  timer = 0;
  writeJson(USAGE_KEY, current());
}

function keepSoon(): void {
  if (timer) return;
  timer = window.setTimeout(keep, KEEP_AFTER_MS);
  // Once: what is still to be written goes when the window does.
  if (!listening) {
    listening = true;
    window.addEventListener("pagehide", () => timer && keep());
  }
}
let listening = false;

/** Count one use (a command run, a tool taken up, an export written). */
export function noteUse(kind: UseKind, id: string): void {
  if (countUse(current(), kind, id, Date.now())) keepSoon();
}

/** The app was started: today is a day it was used on. */
export function noteStarted(): void {
  if (usedToday(current(), Date.now())) keepSoon();
}

/** What has been counted so far. */
export function usageNow(): Usage {
  return current();
}

/** Turn counting on or off (what was counted stays until cleared). */
export function setCounting(on: boolean): void {
  current().on = on;
  keep();
}

/** Forget all that was counted; counting goes on as it was set. */
export function clearUsage(): void {
  usage = emptyUsage(Date.now(), current().on);
  keep();
}
