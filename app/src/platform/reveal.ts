// The next step after something did not work, or after a file was written:
// the folder it is in, shown in the computer's file manager (Explorer).
import type { AlertAction } from "./alerts";
import { call } from "./backend";
import { fail } from "./status";

/** Show `path` in its folder (a file chosen there; a folder opened; one not there: the nearest folder above it). */
export async function showInFolder(path: string): Promise<void> {
  try {
    await call("show_in_folder", { path });
  } catch (error) {
    fail("フォルダーを開けませんでした", error);
  }
}

/** A button that shows `path` in its folder. */
export function folderStep(path: string, label = "フォルダーを開く"): AlertAction {
  return { label, run: () => void showInFolder(path) };
}
