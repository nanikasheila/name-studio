/// <reference types="vite/client" />
// What each command takes and gives is generated from the Rust source
// (generated/ipc.ts, by `cargo run -p ipc-types`; a Rust test fails while it
// is behind). Here the same is looked at from this side, so that `npm test`
// alone also tells when a command was added or dropped without it.
import { describe, expect, it } from "vitest";
import generated from "../generated/ipc.ts?raw";
import lib from "../../src-tauri/src/lib.rs?raw";

describe("the commands of the Rust side", () => {
  it("are all in generated/ipc.ts, and nothing else", () => {
    const handler = /generate_handler!\[([^\]]*)\]/.exec(lib)?.[1] ?? "";
    const registered = [...handler.matchAll(/(?:\w+::)*(\w+)\s*(?:,|$)/g)].map((m) => m[1]).sort();
    const commands = generated.slice(generated.indexOf("export interface Commands {"));
    const typed = [...commands.matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]).sort();
    expect(registered.length).toBeGreaterThan(20);
    expect(typed).toEqual(registered);
  });

  it("are typed from the name data and nothing above it", () => {
    // generated/ipc.ts sits with model.ts at the bottom: any module may use its types.
    const imports = [...generated.matchAll(/^import\b[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../model"]);
  });
});
