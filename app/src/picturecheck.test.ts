import { describe, expect, it } from "vitest";
import type { RoughImage, StoredImage } from "./model";
import { trimBox } from "./pagebox";
import { unreadableNote, unreadablePictures, unreadableRoughs, unreadableRoughsNote, withoutRoughs } from "./picturecheck";
import { newProject } from "./project";
import { addReference, isNamePicture } from "./references";

const picture = (id: string, name = `${id}.jpg`): StoredImage => ({ id, name, mime: "image/jpeg", dataBase64: `ok-${id}`, widthPx: 400, heightPx: 300 });

/** Decodes what was stored whole; "broken" data fails as the browser would. Counts the tries and the closes. */
function decoder() {
  const tried: string[] = [];
  let open = 0;
  const decode = async (image: StoredImage) => {
    tried.push(image.id);
    if (image.dataBase64.startsWith("broken")) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    open++;
    return { close: () => void open-- };
  };
  return { decode, tried, open: () => open };
}

describe("unreadablePictures", () => {
  it("names each picture that will not decode with every page it lies on, and the ones the name lost", async () => {
    const project = newProject("a", 4);
    const scan = picture("scan", "scan01.png");
    addReference(project, project.pages[0], picture("good"));
    addReference(project, project.pages[1], scan);
    addReference(project, project.pages[3], scan);
    addReference(project, project.pages[2], picture("gone", "背景.jpg"));
    scan.dataBase64 = "broken";
    // The picture's data is no longer in the name (an older save, a hand-edited file).
    project.images = project.images!.filter((image) => image.id !== "gone");
    const { decode, tried, open } = decoder();

    const found = await unreadablePictures(project, () => true, decode);

    expect(found).toEqual([
      { name: "scan01.png", pages: [2, 4], reason: "broken" },
      { name: "gone", pages: [3], reason: "missing" },
    ]);
    // Each picture is tried once, and what was decoded is let go.
    expect(tried).toEqual(["good", "scan"]);
    expect(open()).toBe(0);
  });

  it("only looks at what is written: the pictures asked for, on the page (not in the 欄外)", async () => {
    const project = newProject("a", 1);
    const page = project.pages[0];
    const named = addReference(project, page, { ...picture("name"), dataBase64: "broken" });
    named.kind = "name";
    const [, , tx1] = trimBox(project.pageFormat);
    // A broken 資料 laid beside the page, in the 欄外: not written anywhere.
    addReference(project, page, { ...picture("aside"), dataBase64: "broken" }, [tx1 + 200, 50]);
    const { decode } = decoder();

    expect(await unreadablePictures(project, (reference) => !isNamePicture(reference), decode)).toEqual([]);
    expect(await unreadablePictures(project, isNamePicture, decode)).toEqual([{ name: "name.jpg", pages: [1], reason: "broken" }]);
  });
});

describe("unreadableNote", () => {
  it("says nothing when all can be read, and otherwise each picture with its pages and why", () => {
    expect(unreadableNote([])).toBeNull();
    const note = unreadableNote([
      { name: "scan01.png", pages: [2, 4], reason: "broken" },
      { name: "gone", pages: [3], reason: "missing" },
    ]);
    expect(note).toBe(
      "読めない画像が 2 枚あります。書き出すと、その画像は入りません。\n" +
        "・2・4 ページ「scan01.png」（画像として読めません）\n" +
        "・3 ページ「gone」（ネームに画像がありません）",
    );
  });
});

describe("unreadableRoughs", () => {
  const rough = (layerId: number): RoughImage => ({ id: `r${layerId}`, layerId, layerName: `ラフ${layerId}`, sheetCrop: [0, 0, 100, 100], box: [0, 0, 100, 100] });

  it("names the pages whose roughs the sheet no longer gives, with the sheet and why", async () => {
    const project = newProject("a", 4);
    project.source = { path: "D:/ネーム/第4話_ネーム.clip", resolution: 600, cells: [] };
    project.pages[0].roughs.push(rough(1));
    project.pages[2].roughs.push(rough(3), rough(4));
    const tried: number[] = [];
    // The sheet was moved: every rough fails the same way.
    const found = await unreadableRoughs(project, async (r) => (tried.push(r.layerId), "D:/ネーム/第4話_ネーム.clip: 指定されたファイルが見つかりません。 (os error 2)"));
    expect(tried).toEqual([1, 3, 4]);
    expect(found).toEqual({ sheet: "D:/ネーム/第4話_ネーム.clip", pages: [1, 3], reason: "D:/ネーム/第4話_ネーム.clip: 指定されたファイルが見つかりません。 (os error 2)" });
    expect(unreadableRoughsNote(found!).split("\n")).toEqual([
      "元のネーム用紙のラフを 2 ページ分読めません。書き出すと、そのラフは入りません。",
      "・ページ: 1・3",
      "・ネーム用紙: D:/ネーム/第4話_ネーム.clip",
      "・理由: D:/ネーム/第4話_ネーム.clip: 指定されたファイルが見つかりません。 (os error 2)",
    ]);
  });

  it("is null when every rough can be read, or there are none", async () => {
    const project = newProject("a", 2);
    expect(await unreadableRoughs(project, async () => "never asked")).toBeNull();
    project.pages[1].roughs.push(rough(1));
    expect(await unreadableRoughs(project, async () => null)).toBeNull();
  });

  it("writes without the roughs, leaving the name as it is", () => {
    const project = newProject("a", 2);
    project.pages[0].roughs.push(rough(1));
    const written = withoutRoughs(project);
    expect(written.pages.map((page) => page.roughs.length)).toEqual([0, 0]);
    expect(project.pages[0].roughs).toHaveLength(1);
    expect(written.pages[0].panels).toBe(project.pages[0].panels);
  });
});
