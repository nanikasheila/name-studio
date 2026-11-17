import { describe, expect, it } from "vitest";
import type { Panel, Project } from "../model/model";
import { addObject } from "./background";
import {
  addModels,
  assetUses,
  assetsSection,
  chooseAsset,
  objectAsset,
  panelAssetWords,
  readAssets,
  renameAssetUses,
  writeAssets,
  type BackgroundAsset,
} from "./bgassets";
import { requestBrief, requestPrompt, drawingInstructions } from "./bgrequest";
import { newProject } from "./project";

const house: BackgroundAsset = {
  name: "叔母の家",
  kind: "place",
  file: "叔母の家/叔母の家.blend",
  collection: "叔母の家",
  note: "玄関は南",
};
const van: BackgroundAsset = { name: "バン", kind: "thing", file: "車/バン.blend", by: "AI" };

function withPanel(): { project: Project; panel: Panel } {
  const project = newProject("素材", 1);
  const panel: Panel = {
    id: "a",
    order: 1,
    shape: [
      [20, 20],
      [120, 20],
      [120, 100],
      [20, 100],
    ],
  };
  project.pages[0].panels = [panel];
  return { project, panel };
}

describe("背景の素材", () => {
  it("reads 素材.json, leaving out what has no name or leads out of the folder", () => {
    const { assets, problems } = readAssets(
      JSON.stringify({
        assets: [
          { name: " 叔母の家 ", kind: "place", file: "叔母の家\\叔母の家.blend", collection: "叔母の家", note: "玄関は南" },
          { name: "外", file: "../外.blend" },
          { name: "鍵", file: "C:/鍵.blend" },
          { file: "名なし.blend" },
          { name: "バン", kind: "car", file: "./車/古い.blend" },
          { name: "バン", file: "車/バン.blend", by: "AI" },
        ],
      }),
    );
    expect(assets).toEqual([house, van]);
    expect(problems).toHaveLength(3);
    expect(readAssets(writeAssets(assets)).assets).toEqual(assets);
    expect(readAssets("[]").assets).toEqual([]);
    expect(readAssets("{").problems).toHaveLength(1);
  });

  it("adds the 3D files not listed as 物, named after their files", () => {
    const next = addModels([house, van], ["叔母の家/叔母の家.blend", "車/バン.blend", "机.glb", "教室/机.obj", "机/机.fbx"]);
    expect(next.slice(2).map((asset) => [asset.name, asset.kind, asset.file])).toEqual([
      ["机", "thing", "机.glb"],
      ["教室・机", "thing", "教室/机.obj"],
      ["机・机", "thing", "机/机.fbx"],
    ]);
  });

  it("finds a 物's 素材 by choice or by the start of its name, and follows a rename", () => {
    const { project, panel } = withPanel();
    const one = addObject(project, panel, "バン 横向き", [
      [30, 60],
      [60, 60],
      [60, 90],
      [30, 90],
    ]);
    const two = addObject(project, panel, "バンパー", one.shape);
    expect(objectAsset([house, van], one)).toBe(van);
    expect(objectAsset([house, van], two)).toBeUndefined();
    expect(chooseAsset(panel, two.id, "バン")).toBe(true);
    expect(objectAsset([house, van], two)).toBe(van);
    panel.background = { ...panel.background, place: "叔母の家" };
    expect(assetUses(project, [house, van])).toEqual(
      new Map([
        ["叔母の家", 1],
        ["バン", 2],
      ]),
    );
    expect(renameAssetUses(project, "バン", "黒いバン")).toBe(1);
    expect(two.asset).toBe("黒いバン");
    chooseAsset(panel, two.id, "");
    expect(two.asset).toBeUndefined();
  });

  it("tells the AI the 素材 of each panel, and to keep new ones simple and add them", () => {
    const { project, panel } = withPanel();
    panel.background = { place: "叔母の家" };
    addObject(project, panel, "バン 横向き", [
      [30, 60],
      [60, 60],
      [60, 90],
      [30, 90],
    ]);
    expect(panelAssetWords(panel, [house, van])).toEqual([
      "場所の素材: 「叔母の家」（場所）: `叔母の家/叔母の家.blend`（コレクション 叔母の家） — 玄関は南。作り直さずこれを読み込んで、カメラを置く",
      "物「バン 横向き」の素材: 「バン」（物）: `車/バン.blend`",
    ]);
    panel.background.place = "駅前";
    expect(panelAssetWords(panel, [house])[0]).toBe("場所: 「駅前」（素材の一覧にない。作ったら素材に足す）");
    const section = assetsSection("C:/ネーム/背景素材", [house]).join("\n");
    expect(section).toContain("`C:/ネーム/背景素材`");
    expect(section).toContain("簡単な形");
    const request = {
      stamp: "20261117-120000",
      targets: [{ panel: "a" }],
      note: "",
      dpi: 600,
      folder: "C:/ネーム/第4話_背景",
      blender: null,
      assets: { folder: "C:/ネーム/背景素材", list: [house, van] },
    };
    const brief = requestBrief(project, request, []);
    expect(brief).toContain("## 素材（使い回す 3D）");
    expect(brief).toContain("- 場所: 「駅前」（素材の一覧にない。作ったら素材に足す）");
    expect(brief).toContain("あたり（モック）");
    expect(requestPrompt(project, request)).toContain("素材のフォルダー `C:/ネーム/背景素材`");
    expect(drawingInstructions("C:/w", "C:/ネーム/背景素材")).toContain("素材のフォルダー `C:/ネーム/背景素材` に新しい素材を足す");
    expect(drawingInstructions("C:/w")).not.toContain("素材のフォルダー");
  });
});
