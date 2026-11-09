// The dialogs of the system: picking a file or a folder, asking and telling.
//
// A file or a folder is picked on the Rust side (dialogs.rs), which remembers
// every place picked: the commands that write a file take only those places.
// So nothing else in the screen opens a file dialog, and the dialog plugin is
// imported here alone (architecture.test.ts keeps it so).
import { ask, message } from "@tauri-apps/plugin-dialog";
import { call, type OpenOptions, type SaveOptions } from "./backend";

export { ask, message };
export type { FileFilter, OpenOptions, SaveOptions } from "./backend";

/** Ask for a file (several with `multiple`, a folder with `directory`). Null when the dialog was closed. */
export function open(options: OpenOptions & { multiple: true }): Promise<string[] | null>;
export function open(options?: OpenOptions & { multiple?: false }): Promise<string | null>;
export function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  return call("choose_open", { options });
}

/** Ask where to save a file: its path, ending in one of the filters' extensions. Null when the dialog was closed. */
export function save(options: SaveOptions = {}): Promise<string | null> {
  return call("choose_save", { options });
}

/**
 * Whether `path` was picked in a dialog, now or in an earlier run. A place
 * only remembered by the screen is written to without a dialog only when it was.
 */
export function placeChosen(path: string): Promise<boolean> {
  return call("place_chosen", { path }).catch(() => false);
}
