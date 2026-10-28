import { describe, expect, it } from "vitest";
import type { StoredImage } from "./model";
import { trimBox } from "./pagebox";
import { unreadableNote, unreadablePictures } from "./picturecheck";
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
