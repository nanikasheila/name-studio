// node --test .github/scripts/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { promoteTag } from "./promote-version.mjs";

const release = (tagName, isPrerelease, extra = {}) => ({ tagName, isPrerelease, isDraft: false, isLatest: false, ...extra });
// As GitHub lists them: the channel's own release, 試験版 newer than the 正式版, older ones.
const RELEASES = [
  release("channel-beta", true),
  release("v0.2.101", true),
  release("v0.2.99", true),
  release("v0.2.100", true),
  release("v0.2.98", false, { isLatest: true }),
  release("v0.2.97", true),
  release("v0.2.96", false),
];

test("with nothing asked, the newest 試験版 (by number, not by list order)", () => {
  assert.deepEqual(promoteTag(RELEASES, ""), { tag: "v0.2.101" });
});

test("a 試験版 asked for by its number", () => {
  assert.deepEqual(promoteTag(RELEASES, "0.2.99"), { tag: "v0.2.99" });
});

test("never one older than the 正式版, one already promoted, or one that is not there", () => {
  assert.match(promoteTag(RELEASES, "0.2.97").error, /今の正式版 v0\.2\.98 より古い/);
  assert.match(promoteTag(RELEASES, "0.2.96").error, /もう正式版/);
  assert.match(promoteTag(RELEASES, "0.2.150").error, /ありません/);
  assert.match(promoteTag(RELEASES, "channel-beta").error, /正しくありません/);
  assert.match(promoteTag([release("v0.2.98", false)], "").error, /試験版がありません/);
});

test("the first 正式版 (none yet) can be any 試験版", () => {
  assert.deepEqual(promoteTag([release("v0.2.89", true), release("v0.2.90", true)], "0.2.89"), { tag: "v0.2.89" });
});
