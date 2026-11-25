import { describe, expect, it } from "vitest";
import type { CspWork, CspWorkPage } from "../generated/ipc";
import {
  applyCspTakeBack,
  adoptions,
  allRefs,
  type CspLayerNames,
  emptyTakeBack,
  madePages,
  onAddedPage,
  pickCspTakeBack,
  planCspTakeBack,
  startsUnticked,
} from "./csptakeback";
import { lineSignature } from "./linesig";
import { emptyPage } from "./project";
import { planCspPages, settleAdded } from "./csppages";
import { newProject } from "./project";

/** A name of `count` pages exported as page0001.clip… (one page each). */
function exported(count: number) {
  const project = newProject("t", count);
  const files: CspWorkPage[] = project.pages.map((page, index) => ({
    file: `page${String(index + 1).padStart(4, "0")}.clip`,
    path: `out/page${String(index + 1).padStart(4, "0")}.clip`,
    spread: false,
    pageIds: [page.id],
  }));
  return { project, files };
}

const work = (pages: CspWorkPage[], recorded: CspWorkPage[] | null, taken: CspWork["taken"] = null): CspWork => ({
  cmc: "out/作品.cmc",
  pages,
  recorded,
  taken,
});

const blank = (file: string): CspWorkPage => ({ file, path: `out/${file}`, spread: false, pageIds: [] });

function counter() {
  let n = 0;
  return () => `g${n++}`;
}

describe("CSP の作品のページ（足す・消す・並べ替え）", () => {
  it("finds nothing in a work as written", () => {
    const { project, files } = exported(4);
    const plan = planCspPages(project, work(files, files), counter());
    expect([plan.added.length, plan.held.length, plan.move, plan.notes.length]).toEqual([0, 0, null, 0]);
  });

  it("takes a page added, one deleted and the order of CSP's", () => {
    const { project, files } = exported(4);
    const [p1, p2, p3, p4] = project.pages.map((page) => page.id);
    // CSP: page 3 deleted, a page added after page 1, page 4 moved before page 2.
    const now = [files[0], blank("page0005.clip"), files[3], files[1]];
    const pages = planCspPages(project, work(now, files), counter());
    expect(pages.added.map((add) => [add.file, add.page, add.after])).toEqual([["page0005.clip", 4, p1]]);
    expect(pages.held.map((hold) => hold.pages)).toEqual([[p3]]);
    expect(pages.move?.moved).toEqual([p4, p2]);
    expect(pages.order).toEqual([p1, "csp:page0005.clip", p4, p2]);

    const plan = { ...emptyTakeBack(), pages };
    // Deleting starts unticked.
    expect([...startsUnticked(plan)]).toEqual(pages.held.map((hold) => hold.ref));
    const picked = pickCspTakeBack(plan, new Set(allRefs(plan).filter((ref) => !startsUnticked(plan).has(ref))));
    const made = applyCspTakeBack(project, picked);
    const [added] = madePages(picked, made);
    // Page 3, deleted in CSP and left in the name, stays after the page it follows there.
    expect(project.pages.map((page) => page.id)).toEqual([p1, added, p4, p2, p3]);
    // The new page's file is recorded as that page.
    const records = adoptions(
      { ...picked, pending: [{ path: "out/page0005.clip", pages: [4], lines: {}, pixels: {}, pageIds: ["csp:page0005.clip"] }] },
      made,
    );
    expect(records[0].adoption.pageIds).toEqual([added]);
  });

  it("puts a page added in CSP in its place without moving the rest when the order is left", () => {
    const { project, files } = exported(3);
    const [p1, p2, p3] = project.pages.map((page) => page.id);
    const now = [files[2], files[0], blank("page0004.clip"), files[1]];
    const plan = { ...emptyTakeBack(), pages: planCspPages(project, work(now, files), counter()) };
    const keep = new Set(plan.pages.added.map((add) => add.ref));
    const made = applyCspTakeBack(project, pickCspTakeBack(plan, keep));
    expect(project.pages.map((page) => page.id)).toEqual([p1, madePages(plan, made)[0], p2, p3]);
  });

  it("leaves out a page added in CSP when it is not ticked, and records none of the name's pages in it", () => {
    const { project, files } = exported(2);
    const plan = { ...emptyTakeBack(), pages: planCspPages(project, work([...files, blank("page0003.clip")], files), counter()) };
    const made = applyCspTakeBack(project, pickCspTakeBack(plan, new Set()));
    expect(project.pages).toHaveLength(2);
    const records = adoptions(
      { ...plan, pending: [{ path: "out/page0003.clip", pages: [2], lines: {}, pixels: {}, pageIds: ["csp:page0003.clip"] }] },
      made,
    );
    expect(records[0].adoption.pageIds).toEqual([]);
  });

  it("leaves the order as the name has it when the name moved pages too", () => {
    const { project, files } = exported(3);
    project.pages.reverse();
    const conflict = planCspPages(project, work([files[1], files[0], files[2]], files), counter());
    expect(conflict.move).toBeNull();
    expect(conflict.notes).toHaveLength(1);
    // Moved only in the name: nothing to take.
    const own = planCspPages(project, work(files, files), counter());
    expect([own.move, own.notes.length]).toEqual([null, 0]);
  });

  it("does not hold pages next to one CSP made a 見開き of", () => {
    const { project, files } = exported(3);
    // CSP joins pages 1 and 2: the first file goes, the second is twice as wide.
    const now = [{ ...files[1], spread: true }, files[2]];
    const plan = planCspPages(project, work(now, files), counter());
    expect(plan.held).toEqual([]);
    expect(plan.notes).toHaveLength(1);
  });

  it("finds a page taken back again once the name undid it, and says nothing for a work written before pages were recorded", () => {
    const { project, files } = exported(2);
    const taken = { ...files[0], file: "page0003.clip", path: "out/page0003.clip", pageIds: ["page99"] };
    const again = planCspPages(project, work([...files, taken], [...files, taken], { pageIds: ["page99"], pages: files }), counter());
    expect(again.added.map((add) => add.file)).toEqual(["page0003.clip"]);
    const old = planCspPages(
      project,
      work(
        files.map((file) => ({ ...file, pageIds: [] })),
        null,
      ),
      counter(),
    );
    expect([old.added.length, old.notes.length]).toEqual([0, 1]);
  });

  it("takes what was drawn on a page added in CSP with it, onto the new page", () => {
    const { project, files } = exported(2);
    const [p1, p2] = project.pages.map((page) => page.id);
    const pages = planCspPages(project, work([files[0], blank("page0003.clip"), files[1]], files), counter());
    const [add] = pages.added;
    const planned = { ...project, pages: [...project.pages, emptyPage(add.key)] };
    const points = [
      [100, 100, 1],
      [300, 400, 1],
    ];
    const names: CspLayerNames = { rough: new Map(), panels: "コマ枠", frames: "コマ枠フォルダー", own: new Set() };
    const plan = planCspTakeBack(
      planned,
      [
        {
          path: add.path,
          places: [{ page: add.page, m: { scale: 10, x: 0, y: 0 }, right: true }],
          gutterPx: null,
          added: true,
          content: {
            dialogue: { texts: [], written: null, adoptedFrom: null },
            record: {},
            vectors: [
              {
                name: "ペン入れ",
                visible: true,
                lines: [
                  { sig: lineSignature(points), points: points as [number, number, number][], widthPx: 5, color: [0, 0, 0], closed: false },
                ],
              },
            ],
            frames: [],
            rasters: [],
            widthPx: 2000,
            heightPx: 3000,
          },
        },
      ],
      names,
      () => null,
    );
    plan.pages = pages;
    add.texts = [{ text: "足したセリフ", page: add.page, box: [10, 10, 20, 40] }];
    expect(onAddedPage(plan, add)).toHaveLength(1);
    // Not ticked: nothing of it comes.
    const none = pickCspTakeBack(plan, new Set());
    expect([none.strokesAdded.length, none.pages.added.length]).toEqual([0, 0]);
    const made = applyCspTakeBack(project, pickCspTakeBack(plan, new Set([add.ref, ...onAddedPage(plan, add)])));
    const [id] = madePages(plan, made);
    expect(project.pages.map((page) => page.id)).toEqual([p1, id, p2]);
    expect(project.pages[1].strokes).toHaveLength(1);
    expect(project.pages[1].lines.map((line) => line.text)).toEqual(["足したセリフ"]);
    expect(adoptions(plan, made)[0].adoption.pageIds).toEqual([id]);
  });

  it("takes a 見開き added in CSP as two pages joined, and leaves out a page of another size", () => {
    const { project, files } = exported(2);
    const [p1, p2] = project.pages.map((page) => page.id);
    const pages = planCspPages(project, work([files[0], blank("page0003.clip"), blank("page0004.clip"), files[1]], files), counter());
    settleAdded(
      pages,
      2,
      new Map([
        ["page0003.clip", "spread" as const],
        ["page0004.clip", null],
      ]),
    );
    expect(pages.added.map((add) => [add.file, add.page, add.spread])).toEqual([["page0003.clip", 2, true]]);
    expect(pages.notes).toHaveLength(1);
    const plan = { ...emptyTakeBack(), pages };
    const made = applyCspTakeBack(project, plan);
    const ids = madePages(plan, made);
    expect(ids).toHaveLength(2);
    expect(project.pages.map((page) => page.id)).toEqual([p1, ...ids, p2]);
    expect(project.pages[1].joinNext).toBe(true);
    const records = adoptions(
      {
        ...plan,
        pending: [
          { path: "out/page0003.clip", pages: [2, 3], lines: {}, pixels: {}, pageIds: ["csp:page0003.clip", "csp:page0003.clip#2"] },
        ],
      },
      made,
    );
    expect(records[0].adoption.pageIds).toEqual(ids);
  });

  it("makes each closed frame on a page added in CSP a panel", () => {
    const { project, files } = exported(1);
    const pages = planCspPages(project, work([...files, blank("page0002.clip")], files), counter());
    const [add] = pages.added;
    const planned = { ...project, pages: [...project.pages, emptyPage(add.key)] };
    const frame = (x0: number, y0: number, x1: number, y1: number) => {
      const points = [
        [x0, y0, 1],
        [x1, y0, 1],
        [x1, y1, 1],
        [x0, y1, 1],
      ];
      return {
        sig: lineSignature(points),
        points: points as [number, number, number][],
        widthPx: 5,
        color: [0, 0, 0] as [number, number, number],
        closed: true,
      };
    };
    const names: CspLayerNames = { rough: new Map(), panels: "コマ枠", frames: "コマ枠フォルダー", own: new Set() };
    const plan = planCspTakeBack(
      planned,
      [
        {
          path: add.path,
          places: [{ page: add.page, m: { scale: 10, x: 0, y: 0 }, right: true }],
          gutterPx: null,
          added: true,
          content: {
            dialogue: { texts: [], written: null, adoptedFrom: null },
            record: {},
            vectors: [
              {
                name: "コマ枠",
                visible: true,
                lines: [frame(200, 200, 1600, 1000), frame(200, 1050, 900, 2000), frame(950, 1050, 1600, 2000)],
              },
            ],
            frames: [],
            rasters: [],
            widthPx: 2000,
            heightPx: 3000,
          },
        },
      ],
      names,
      () => null,
    );
    plan.pages = pages;
    expect([plan.panelsAdded.length, plan.panelSketches.length]).toEqual([3, 0]);
    applyCspTakeBack(project, plan);
    expect(project.pages[1].panels).toHaveLength(3);
  });
});
