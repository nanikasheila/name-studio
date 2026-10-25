// Names saved by earlier versions (crates/name-model/tests/fixtures/past,
// never regenerated) open in this one and are saved again without losing
// anything: what the window does with a file it opens (normalize, the save
// check's mending) and then writes (savedForm, projectJson).
import { describe, expect, it } from "vitest";
import type { Project } from "./model";
import { normalize } from "./project";
import { projectJson } from "./projectjson";
import { savedForm } from "./references";
import { repair } from "./repair";

const texts: Record<string, string> = {
  ...import.meta.glob<string>("../../crates/name-model/tests/fixtures/past/*.{json,namestudio}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../../crates/name-model/tests/data/editor-project.namestudio", { query: "?raw", import: "default", eager: true }),
};
const files = Object.entries(texts).map(([path, text]) => ({ name: path.split("/").pop()!, text }));

/** Where `saved` lost or changed what `read` held (points are saved to 0.01 mm, the rest to 0.001). */
function losses(path: string, read: unknown, saved: unknown, found: string[]): void {
  if (typeof read === "number" && typeof saved === "number") {
    if (Math.abs(read - saved) > 0.006) found.push(`${path}: ${read} became ${saved}`);
  } else if (Array.isArray(read) && Array.isArray(saved) && read.length === saved.length) {
    read.forEach((value, index) => losses(`${path}[${index}]`, value, saved[index], found));
  } else if (read && saved && typeof read === "object" && typeof saved === "object" && !Array.isArray(read) && !Array.isArray(saved)) {
    for (const [key, value] of Object.entries(read)) {
      if (key === "formatVersion") continue;
      if (!(key in saved)) found.push(`${path}.${key}: dropped`);
      else losses(`${path}.${key}`, value, (saved as Record<string, unknown>)[key], found);
    }
  } else if (JSON.stringify(read) !== JSON.stringify(saved)) {
    found.push(`${path}: ${JSON.stringify(read)?.slice(0, 80)} became ${JSON.stringify(saved)?.slice(0, 80)}`);
  }
}

describe("names saved by earlier versions", () => {
  it("are all here", () => expect(files.length).toBeGreaterThanOrEqual(10));

  for (const { name, text } of files) {
    it(`opens ${name} and saves it again whole`, () => {
      const project = normalize(JSON.parse(text) as Project);
      // A name saved by the app passes the save check as it is (the full-field samples are not consistent names).
      if (name.endsWith(".namestudio")) expect(repair(project)).toEqual([]);
      const saved: unknown = JSON.parse(projectJson(savedForm(project)));
      const found: string[] = [];
      losses(name, JSON.parse(text), saved, found);
      expect(found).toEqual([]);
    });
  }
});
