import assert from "node:assert/strict";
import { test } from "node:test";
import { withSignature } from "./signed-latest.mjs";

const latest = {
  version: "0.2.90",
  notes: "直したこと",
  pub_date: "2026-11-13T00:00:00.000Z",
  platforms: {
    "windows-x86_64": {
      signature: "old",
      url: "https://github.com/nanikasheila/name-studio/releases/download/v0.2.90/NameStudio_0.2.90_x64-setup.exe",
    },
  },
};

test("the signature of the signed installer replaces the old one, nothing else changes", () => {
  const next = withSignature(latest, "0.2.90", "new\n");
  assert.equal(next.platforms["windows-x86_64"].signature, "new");
  assert.equal(next.platforms["windows-x86_64"].url, latest.platforms["windows-x86_64"].url);
  assert.equal(next.notes, latest.notes);
  assert.equal(next.pub_date, latest.pub_date);
  assert.equal(latest.platforms["windows-x86_64"].signature, "old");
});

test("a latest.json for another version (channel-beta moved on) is left alone", () => {
  assert.equal(withSignature({ ...latest, version: "0.2.91" }, "0.2.90", "new"), null);
});

test("an empty signature or a latest.json without Windows is an error, not a broken update", () => {
  assert.throws(() => withSignature(latest, "0.2.90", "  \n"));
  assert.throws(() => withSignature({ ...latest, platforms: {} }, "0.2.90", "new"));
});
