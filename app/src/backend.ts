// The Rust side of the app (app/src-tauri): every command it offers, with
// what it takes and what it gives back. All calls go through `call`, so a
// misspelt command or a wrong argument is a type error, and the shapes the
// Rust side sends are written down once, here.
import { invoke } from "@tauri-apps/api/core";
import type { CspSubTool } from "./brush";
import type { ExportReport, ExportRequest, OverwriteCheck } from "./export";
import type { BuiltTemplate, PageSetup } from "./csppage";
import type { FontFace } from "./fonts";
import type { Project } from "./model";
import type { SheetView } from "./types";

/** The template page as `begin_name_export` reports it (clip-core `TemplateCanvas`). */
export interface TemplateCanvas {
  widthPx: number;
  heightPx: number;
  resolution: number;
  trimPx: [number, number, number, number] | null;
  basicPx: [number, number, number, number] | null;
}

/** Where pages go on a CSP 見開き page (clip-core `SpreadLayout`), in template px. */
export interface SpreadLayout {
  widthPx: number;
  heightPx: number;
  gutterPx: number;
  leftDx: number;
  rightDx: number;
}

/** `begin_name_export`: the canvas, and which parts can be editable layers. */
export interface NameExportStart extends TemplateCanvas {
  vectorLayers: boolean;
  textLayers: boolean;
  /** Whether a コマ枠フォルダー was found to copy (only looked for when asked). */
  frameFolders: boolean;
  /** Whether the book's first page is a left page (from the template); null when unknown. */
  firstPageLeft: boolean | null;
  spread: SpreadLayout | null;
  /** Why 見開き pages cannot be written, when they cannot. */
  spreadProblem: string | null;
}

export interface CspExportRequest {
  template: string;
  outDir: string;
  workTemplate: string | null;
  workName: string | null;
  storyIndex: number | null;
  inputs: string[];
  /** .clip files (the name sheet) to copy CSP's vector / text layers from. */
  donors: string[];
  /** Layers (by name) written as 下描き layers at half opacity: `ROUGH_LAYERS` to ink over the rough. */
  draftLayers?: string[];
  /** Panels as a コマ枠フォルダー (copied from a finished page among the donors), with an empty layer in it to ink on. */
  frameFolders?: boolean;
  /** The name's binding (true: right-bound), written over the template's in the work and its pages. */
  rightBinding?: boolean;
  /** Each panel as a folder with a レイヤーマスク, holding its rough and an empty layer to ink on (instead of `frameFolders`). */
  panelMasks?: boolean;
  /** The name's memos as a 下描き image layer on top (on unless false). */
  notes?: boolean;
}

/** A written file read back (clip-core `verify::FileCheck`). */
export interface FileCheck {
  path: string;
  /** The name pages (1-based) in this file: two for a 見開き page. */
  pages?: number[];
  /** Empty when the file holds what was written. */
  problems: string[];
  layers: number;
  vectorLines: number;
  texts: number;
}

/** One page brought up to date (clip-core `update::DialogueUpdateReport`). */
export interface DialogueUpdateReport {
  path: string;
  backup: string | null;
  kept: number;
  retired: string[];
  added: string[];
  foreign: number;
  leftAsInCsp: number;
  replaced: string[];
  notFound: string[];
  /** Swapped layers that had been changed in CSP too. */
  conflicts: string[];
  /** Whether the memos layer was redrawn. */
  notes: boolean;
  problems: string[];
}

export type VersionKind = "saved" | "auto" | "beforeRestore";

export interface VersionInfo {
  id: string;
  timeMs: number;
  kind: VersionKind;
  title: string;
  pages: number;
  bytes: number;
}

export interface BatchExport {
  project: string;
  /** The page template; null with --builtin. */
  template: string | null;
  /** Pages from the name's CSP page settings, without a template (--builtin). */
  builtin?: boolean;
  outDir: string;
  workTemplate: string | null;
  workName: string | null;
  storyIndex: number | null;
  /** 見本のページ: .clip files to copy text and vector layers from. */
  donors?: string[];
  /** The rough as 下描き layers (on unless --no-draft-rough). */
  draftRough?: boolean;
  /** Panels as a コマ枠フォルダー (--frame-folders). */
  frameFolders?: boolean;
  /** Each panel as a folder with a レイヤーマスク (--panel-masks). */
  panelMasks?: boolean;
  /** The name's memos as a 下描き layer (on unless --no-notes). */
  notes?: boolean;
  /** Bring the dialogue into the pages there instead (--update-dialogue). */
  updateDialogue?: boolean;
  /** Take the dialogue changed in CSP back into the name, and save it (--read-dialogue). */
  readDialogue?: boolean;
  report: string;
}

export interface Recovery {
  path: string | null;
  timeMs: number;
  project: Project;
  /** What the save check found wrong with it (mended when it is brought back). */
  problems?: string[];
}

export interface CspToolLocations {
  tools: string | null;
  materials: string | null;
}

/** A page's dialogue as CSP holds it (`read_name_dialogue`). */
export interface CspPageDialogue {
  path: string;
  dialogue: { texts: { text: string; bbox: number[] | null }[]; written: string[] | null } | null;
}

/**
 * A request body of `[u32 little-endian JSON length][JSON][bytes]` (see
 * `packBody` and `projectBody`): images and the project text travel as bytes.
 */
export type RawBody = Uint8Array;

/** Each command: its arguments (`void`: none) and its result. */
export interface Commands {
  // The open name sheet (viewer.rs)
  open_sheet: [{ path: string }, SheetView];
  layer_overview: [{ layerId: number; factor: number }, ArrayBuffer];
  layer_region: [{ layerId: number; region: number[] }, ArrayBuffer];
  export_defaults: [void, { workTemplate: string | null; workName: string }];
  export_pages: [{ request: ExportRequest }, ExportReport];
  import_project: [{ path: string }, { project: Project; warnings: string[] }];
  rough_image: [{ sheet: string; layerId: number; crop: [number, number, number, number]; maxHeight: number }, ArrayBuffer];
  // The name data (project_io.rs)
  log_error: [{ message: string }, void];
  load_project: [{ path: string }, Project];
  save_project: [RawBody, VersionInfo | null];
  autosave_project: [RawBody, { savedToFile: boolean; version: VersionInfo | null; problems: string[] }];
  list_versions: [{ path: string | null }, VersionInfo[]];
  load_version: [{ path: string | null; id: string }, Project];
  record_version: [RawBody, VersionInfo | null];
  pending_recoveries: [void, Recovery[]];
  discard_recovery: [{ path: string | null }, void];
  // CSP pages and works (name_export.rs)
  begin_name_export: [{ request: CspExportRequest }, NameExportStart];
  export_name_page: [RawBody, FileCheck];
  update_name_dialogue: [RawBody, DialogueUpdateReport];
  read_name_dialogue: [{ spread: boolean }, CspPageDialogue];
  adopt_name_dialogue: [{ paths: string[] }, void];
  finish_name_export: [void, { pages: string[]; work: string | null; workCheck: FileCheck | null }];
  cancel_name_export: [void, void];
  check_export_target: [{ outDir: string }, OverwriteCheck];
  prepare_builtin_template: [{ setup: PageSetup }, BuiltTemplate];
  // Other files (files.rs)
  write_pdf: [RawBody, void];
  write_text_file: [{ path: string; text: string }, void];
  csp_tool_locations: [void, CspToolLocations];
  read_csp_sub_tools: [{ path: string; materials: string | null }, CspSubTool[]];
  // The fonts on the computer (fonts.rs)
  list_fonts: [void, FontFace[]];
  // The app (lib.rs)
  is_release_build: [void, boolean];
  batch_export_task: [void, BatchExport | null];
  end_batch_export: [{ code: number }, void];
}

export type Command = keyof Commands;
type Args<C extends Command> = Commands[C][0];

/** Run a command on the Rust side. */
export function call<C extends Command>(command: C, ...args: Args<C> extends void ? [] : [Args<C>]): Promise<Commands[C][1]> {
  return invoke<Commands[C][1]>(command, args[0] as Parameters<typeof invoke>[1]);
}
