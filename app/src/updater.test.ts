import { afterEach, describe, expect, it, vi } from "vitest";
import { installableReleases, setUpdateMode, updateMode } from "./updater";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.80" }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => undefined }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));

afterEach(() => vi.unstubAllGlobals());

describe("自動更新の設定", () => {
  it("is on until set, keeps 「止める」 from before as 「知らせるだけ」, and keeps the three ways", () => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) });
    expect(updateMode()).toBe("auto");
    items.set("namestudio.updatesPaused", "1");
    expect(updateMode()).toBe("notify");
    for (const mode of ["off", "auto", "notify"] as const) {
      setUpdateMode(mode);
      expect(updateMode()).toBe(mode);
    }
    items.set("namestudio.updateMode", "sometimes");
    expect(updateMode()).toBe("notify");
  });
});

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
