// The workflows themselves: what they run is fixed, and what they may do is
// said job by job.
//
// An Action named by a tag (`@v7`) is whatever its owner points the tag at
// that day, and it runs with this repository's token and, in the release,
// the key that signs updates. So every Action is named by its commit, with
// the version beside it for people (Dependabot raises both together).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflows = readdirSync(join(root, "workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => join("workflows", name));
const actions = readdirSync(join(root, "actions")).map((name) => join("actions", name, "action.yml"));
const read = (file) => readFileSync(join(root, file), "utf8");

test("every Action is named by its commit, with its version beside it", () => {
  const loose = [];
  for (const file of [...workflows, ...actions]) {
    for (const [, used, note] of read(file).matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)) {
      if (used.startsWith("./")) continue;
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(used) || !/^\s+# v\d+(\.\d+)*$/.test(note)) loose.push(`${file}: ${used}${note}`);
    }
  }
  assert.deepEqual(loose, []);
});

test("no workflow gives every job the right to write", () => {
  const wide = [];
  for (const file of workflows) {
    // The workflow's own `permissions:` (not indented): nothing, or reading only.
    const own = /^permissions:(.*)\n((?: {2}.*\n)*)/m.exec(read(file));
    if (!own) wide.push(`${file}: no permissions of its own (the repository's default applies)`);
    else if (/:\s*write\b/.test(own[1] + own[2])) wide.push(`${file}: ${own[2].trim()}`);
  }
  assert.deepEqual(wide, []);
});
