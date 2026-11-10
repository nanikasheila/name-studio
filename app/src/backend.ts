// The Rust side of the app (app/src-tauri). All calls go through `call`, so
// a misspelt command or a wrong argument is a type error. What each command
// takes and gives is not written here: generated/ipc.ts has it, made from the
// Rust source (`cargo run -p ipc-types`), so the two sides cannot drift apart.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiEvent, Commands as RustCommands, NameExportRequest } from "./generated/ipc";
import type { SavedTalk, TalkSummary } from "./assistchat";

export type {
  AiEvent,
  AiKind,
  AiModel,
  AiTools,
  AiTurn,
  BatchExport,
  BuiltTemplate,
  ChatMessage,
  CspPageDialogue,
  CspToolLocations,
  DialogueUpdateReport,
  FileCheck,
  FileFilter,
  FoundTool,
  FoundUpdate,
  KeptRecovery,
  LayerLook,
  NameExportStart,
  OpenOptions,
  RawBody,
  Recovery,
  SaveOptions,
  SessionFile,
  SpreadLayout,
  TemplateCanvas,
  VersionInfo,
  VersionKind,
} from "./generated/ipc";
export type { SavedTalk, TalkSummary };

/** What `begin_name_export` takes, and what the app itself writes into the pages (not the Rust side). */
export interface CspExportRequest extends NameExportRequest {
  /** Each panel as a folder with a レイヤーマスク, holding its rough and an empty layer to ink on (instead of `frameFolders`). */
  panelMasks?: boolean;
  /** The name's memos as a 下描き image layer on top (on unless false). */
  notes?: boolean;
  /** 指示: each 指示のレイヤー as a 下描き image layer in its colour, over everything (on unless false). */
  marks?: boolean;
}

/** Where new versions come from: 正式版 only, or 試験版 (every version CI let through) too. */
export type UpdateChannel = RustCommands["check_update"][0]["channel"];

/**
 * Where the Rust side passes JSON on without looking into it (the kept
 * conversations), what it is: the commands named must be ones the Rust side has.
 */
type Known<K extends keyof RustCommands, T extends Record<K, [unknown, unknown]>> = Omit<RustCommands, K> & T;

/** Each command: its arguments (`void`: none) and its result. */
export type Commands = Known<
  "ai_history_save" | "ai_history_list",
  {
    /** Past conversations (app data ai-history/), to go on with one. */
    ai_history_save: [{ talk: SavedTalk }, void];
    ai_history_list: [void, TalkSummary[]];
  }
>;

/** Hear what AI turns say; returns how to stop hearing. */
export function onAiEvent(heard: (event: AiEvent) => void): Promise<() => void> {
  return listen<AiEvent>("ai-event", (event) => heard(event.payload));
}

export type Command = keyof Commands;
type Args<C extends Command> = Commands[C][0];

/** Run a command on the Rust side. */
export function call<C extends Command>(command: C, ...args: Args<C> extends void ? [] : [Args<C>]): Promise<Commands[C][1]> {
  return invoke<Commands[C][1]>(command, args[0] as Parameters<typeof invoke>[1]);
}
