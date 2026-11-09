// node --test .github/scripts/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { newerRelease } from "./newer-release.mjs";

const release = (tagName, isPrerelease, extra = {}) => ({ tagName, isPrerelease, isDraft: false, isLatest: false, ...extra });
const RELEASES = [release("channel-beta", true), release("v0.2.99", true), release("v0.2.101", true), release("v0.2.100", true), release("v0.2.98", false, { isLatest: true })];

test("the newest is published: nothing newer", () => {
  assert.equal(newerRelease(RELEASES, "0.2.102"), null);
});

test("an older merge finishing after a newer one: the newest newer release, by number", () => {
  assert.equal(newerRelease(RELEASES, "0.2.99"), "v0.2.101");
  assert.equal(newerRelease(RELEASES, "0.2.9"), "v0.2.101");
});

test("the same version is not newer; channel-beta and drafts are not versions", () => {
  assert.equal(newerRelease(RELEASES, "0.2.101"), null);
  assert.equal(newerRelease([release("channel-beta", true), release("v0.2.200", true, { isDraft: true })], "0.2.120"), null);
});
