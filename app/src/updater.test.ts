import { describe, expect, it } from "vitest";
import { installableReleases } from "./updater";

describe("前の版に戻す", () => {
  it("offers the signed releases (with their latest.json), newest first as GitHub lists them", () => {
    const asset = (name: string) => ({ name });
    const list = installableReleases([
      { tag_name: "v0.2.60", published_at: "2026-10-25T10:00:00Z", body: "マスク付きフォルダー\n\n詳しく", draft: false, assets: [asset("NameStudio_0.2.60_x64-setup.exe"), asset("latest.json")] },
      { tag_name: "v0.2.59", published_at: "2026-10-25T09:00:00Z", body: null, draft: false, assets: [asset("latest.json")] },
      // Not draft-published, unsigned (before the update key) or not a version.
      { tag_name: "v0.2.61", published_at: null, body: "", draft: true, assets: [asset("latest.json")] },
      { tag_name: "v0.2.20", published_at: "2026-10-22T00:00:00Z", body: "", draft: false, assets: [asset("NameStudio_0.2.20_x64-setup.exe")] },
      { tag_name: "nightly", published_at: "2026-10-22T00:00:00Z", body: "", draft: false, assets: [asset("latest.json")] },
    ]);
    expect(list).toEqual([
      { version: "0.2.60", date: "2026-10-25", title: "マスク付きフォルダー" },
      { version: "0.2.59", date: "2026-10-25", title: "" },
    ]);
  });
});
