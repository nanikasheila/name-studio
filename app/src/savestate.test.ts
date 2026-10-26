import { describe, expect, it } from "vitest";
import { saveState, type SaveFacts } from "./savestate";

const facts = (change: Partial<SaveFacts> = {}): SaveFacts => ({ hasPath: true, dirty: false, writing: false, savedAt: null, copyAt: null, failed: null, seriesBehind: false, ...change });
const at = (ms: number) => `T${ms}`;

describe("the save state", () => {
  it("tells a name without a file apart from one kept only in the recovery copy", () => {
    expect(saveState(facts({ hasPath: false, dirty: true }), at)).toMatchObject({ text: "未保存", tone: "warning" });
    expect(saveState(facts({ hasPath: false, dirty: true, copyAt: 5 }), at)).toMatchObject({ text: "控えだけに保存", tone: "warning" });
  });

  it("tells changes waiting for the file, kept in the copy, and all in the file", () => {
    expect(saveState(facts({ dirty: true }), at)).toMatchObject({ text: "未保存の変更あり", tone: "pending" });
    expect(saveState(facts({ dirty: true, copyAt: 7 }), at).text).toBe("控えに保存 T7");
    expect(saveState(facts({ savedAt: 9 }), at)).toMatchObject({ text: "保存済み T9", tone: "saved" });
    expect(saveState(facts(), at).text).toBe("保存済み");
  });

  it("shows writing, and a failure until it is put right, over everything else", () => {
    expect(saveState(facts({ dirty: true, writing: true }), at).text).toBe("保存中…");
    const failed = saveState(facts({ dirty: true, writing: true, failed: "disk full" }), at);
    expect(failed).toMatchObject({ text: "保存できませんでした", tone: "error" });
    expect(failed.detail).toContain("disk full");
  });

  it("adds a series that lags behind", () => {
    expect(saveState(facts({ savedAt: 1, seriesBehind: true }), at)).toMatchObject({ text: "保存済み T1・シリーズ未反映", tone: "warning" });
    expect(saveState(facts({ dirty: true, seriesBehind: true }), at).text).toBe("未保存の変更あり・シリーズ未反映");
  });
});
