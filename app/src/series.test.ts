import { describe, expect, it } from "vitest";
import { addLine, newProject } from "./project";
import { applyShared, folderOf, newSeries, nextStoryIndex, relativePath, resolvePath, samePath, sharedOf, withEpisode, withoutEpisode } from "./series";

describe("シリーズ", () => {
  it("shares characters, fonts and look; the series wins, what the name still uses stays", () => {
    const third = newProject("第3話", 2);
    third.characters = [{ id: "mina", name: "ミナ", color: "#cc3344" }];
    third.fonts = { speech: "メイリオ" };
    third.style = { lineSpacing: 125 };
    third.author = "作者";
    const series = newSeries(third, "作品", "第3話.namestudio");
    expect(series).toMatchObject({ title: "作品", author: "作者", episodes: [{ path: "第3話.namestudio", title: "第3話", pages: 2 }] });

    const fourth = newProject("第4話", 1);
    fourth.characters = [
      { id: "mina", name: "ミナ（古い）" },
      { id: "kai", name: "カイ" },
      { id: "nobody", name: "使っていない人" },
    ];
    addLine(fourth, fourth.pages[0], [10, 10]).speaker = "kai";
    fourth.cspPage = { canvasMm: [1, 1], trimMm: [1, 1], bleedMm: 0, basicMm: [1, 1], basicOffsetMm: [0, 0], resolution: 600 };
    applyShared(fourth, series.shared);
    expect(fourth.characters.map((c) => c.name)).toEqual(["ミナ", "カイ"]);
    expect(fourth.fonts).toEqual({ speech: "メイリオ" });
    expect(fourth.style).toEqual({ lineSpacing: 125 });
    // The series has no CSP page: neither has the name now.
    expect(fourth.cspPage).toBeUndefined();
    // Copies: changing the name does not change the series.
    fourth.characters[0].name = "ミナ２";
    expect(series.shared.characters[0].name).toBe("ミナ");
    expect(sharedOf(fourth).characters.map((c) => c.id)).toEqual(["mina", "kai"]);
  });

  it("lists its names in story order as they are saved", () => {
    const first = newProject("第1話", 3);
    first.storyIndex = 1;
    let series = newSeries(first, "作品", "第1話/第1話.namestudio");
    const third = newProject("第3話", 5);
    third.storyIndex = 3;
    series = withEpisode(series, third, "第3話/第3話.namestudio");
    const second = newProject("第2話", 4);
    second.storyIndex = 2;
    second.characters = [{ id: "kai", name: "カイ" }];
    series = withEpisode(series, second, "第2話/第2話.namestudio");
    expect(series.episodes.map((one) => [one.title, one.pages])).toEqual([
      ["第1話", 3],
      ["第2話", 4],
      ["第3話", 5],
    ]);
    // The last name saved is what is shared now.
    expect(series.shared.characters.map((c) => c.name)).toEqual(["カイ"]);
    // Saved again under the same path (written otherwise): one entry.
    second.title = "第2話 改";
    series = withEpisode(series, second, "第2話\\第2話.namestudio");
    expect(series.episodes.map((one) => one.title)).toEqual(["第1話", "第2話 改", "第3話"]);
    expect(nextStoryIndex(series)).toBe(4);
    expect(withoutEpisode(series, "第3話/第3話.namestudio").episodes.length).toBe(2);
  });

  it("keeps paths from the series' folder, on Windows too", () => {
    expect(relativePath("C:\\作品", "C:\\作品\\第4話\\第4話.namestudio")).toBe("第4話/第4話.namestudio");
    expect(relativePath("C:\\作品\\第4話", "c:\\作品\\作品.nameseries")).toBe("../作品.nameseries");
    expect(relativePath("C:\\作品", "D:\\別\\x.namestudio")).toBeNull();
    expect(relativePath("/home/a/作品", "/home/a/作品/1/1.namestudio")).toBe("1/1.namestudio");
    expect(resolvePath("C:\\作品\\第4話", "../作品.nameseries")).toBe("C:\\作品\\作品.nameseries");
    expect(resolvePath("/home/a/作品", "1/1.namestudio")).toBe("/home/a/作品/1/1.namestudio");
    expect(folderOf("C:\\作品\\作品.nameseries")).toBe("C:\\作品");
    expect(folderOf("/home/a/作品/1.namestudio")).toBe("/home/a/作品");
    expect(samePath("C:\\作品\\a.namestudio", "c:/作品/A.namestudio")).toBe(true);
  });
});
