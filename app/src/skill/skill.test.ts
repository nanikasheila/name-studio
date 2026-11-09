/// <reference types="vite/client" />
// SKILL.md (skills/name-studio) explains the operations an AI can hand the
// command line; one added to assist.ts must be explained there too.
import { describe, expect, it } from "vitest";
import SKILL from "../../../skills/name-studio/SKILL.md?raw";
import { OPS_GUIDE } from "../assist";

describe("SKILL.md", () => {
  it("names every operation", () => {
    for (const name of Object.keys(OPS_GUIDE)) expect(SKILL).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it("starts with the name and the description the AI tools read", () => {
    expect(SKILL).toMatch(/^---\nname: name-studio\ndescription: .+\n---\n/);
  });
});
