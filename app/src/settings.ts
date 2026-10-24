// Settings kept on this computer (the browser's storage) for the next start.
// Storage can be full, blocked or missing: reading gives the fallback, and a
// setting that cannot be written still holds for now.

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The text kept under `key`, or null. */
export function readText(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Keeps `value` under `key`; null forgets it. */
export function writeText(key: string, value: string | null): void {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    // Not kept for the next start; the setting still holds now.
  }
}

export function readFlag(key: string, fallback: boolean): boolean {
  const value = readText(key);
  return value === null ? fallback : value === "1";
}

export function writeFlag(key: string, value: boolean): void {
  writeText(key, value ? "1" : "0");
}

/** A whole number above zero, or the fallback. */
export function readCount(key: string, fallback: number): number {
  const value = Number(readText(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function writeCount(key: string, value: number): void {
  writeText(key, String(value));
}

/** What `JSON.stringify` kept under `key`, or the fallback when there is none or it does not read. */
export function readJson(key: string, fallback: unknown): unknown {
  const text = readText(key);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeText(key, JSON.stringify(value));
}
