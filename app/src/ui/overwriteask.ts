// Before an export writes over files: asked with three answers (上書きする,
// a new name or folder that keeps what is there, やめる), and the new name
// or folder found that is free.
import { call } from "../platform/backend";
import { message } from "../platform/dialogs";
import { numbered, type ExportSource, type WrittenCheck } from "../domain/export";
import { inFolder } from "../service/imageexport";

export type OverwriteChoice = "overwrite" | "rename" | "stop";

/** How far the numbers go looking for a free name (第4話_2 … 第4話_99). */
const TRIES = 99;

/** Asks `text`; `renameLabel` is the answer that keeps the files there. */
export async function askOverwrite(text: string, renameLabel: string): Promise<OverwriteChoice> {
  const [overwrite, stop] = ["上書きする", "やめる"];
  const choice = await message(text, {
    title: "Name Studio",
    kind: "warning",
    buttons: { yes: overwrite, no: renameLabel, cancel: stop },
  });
  if (choice === overwrite || choice === "Yes") return "overwrite";
  if (choice === renameLabel || choice === "No") return "rename";
  return "stop";
}

/** Of `paths`, those already there and which are not this app's as written (none known: all asked about). */
export async function writtenCheck(paths: string[]): Promise<WrittenCheck> {
  return call("check_written_files", { paths });
}

/** A folder beside `outDir` with no CSP files in it (`<outDir>_2`, `_3` …), or null when none is found. */
export async function freshCspFolder(outDir: string, source: ExportSource): Promise<string | null> {
  for (let n = 2; n <= TRIES; n++) {
    const folder = numbered(outDir, n);
    // One that cannot be looked into is not taken for an empty one.
    const check = await call("check_export_target", { outDir: folder, source }).then(
      (check) => check,
      () => false as const,
    );
    if (check !== false && !check?.existing.length) return folder;
  }
  return null;
}

/** A stem whose files (`names` of it) are none of them in `folder` yet (`<stem>_2` …), or null. */
export async function freshStem(folder: string, stem: string, names: (stem: string) => string[]): Promise<string | null> {
  for (let n = 2; n <= TRIES; n++) {
    const fresh = numbered(stem, n);
    const check = await writtenCheck(names(fresh).map((name) => inFolder(folder, name)));
    if (!check.existing.length) return fresh;
  }
  return null;
}
