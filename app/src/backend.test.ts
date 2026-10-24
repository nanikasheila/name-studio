/// <reference types="vite/client" />
// The commands written down in backend.ts must be the ones the Rust side
// registers (app/src-tauri/src/lib.rs), so that `call` cannot name a command
// that does not exist, and no command is left without its types.
import { describe, expect, it } from "vitest";
import backend from "./backend.ts?raw";
import lib from "../src-tauri/src/lib.rs?raw";

describe("the commands of the Rust side", () => {
  it("are all in backend.ts, and nothing else", () => {
    const handler = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? "";
    const registered = [...handler.matchAll(/(?:\w+::)?(\w+)\s*(?:,|$)/g)].map((m) => m[1]).sort();
    const commands = /interface Commands \{([^}]*(?:\{[^}]*\}[^}]*)*)\n\}/.exec(backend)?.[1] ?? "";
    const typed = [...commands.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort();
    expect(registered.length).toBeGreaterThan(20);
    expect(typed).toEqual(registered);
  });
});
