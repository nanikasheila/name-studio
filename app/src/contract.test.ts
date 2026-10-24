// The name data is defined twice: here (project.ts) and in Rust
// (crates/name-model/src/model.rs). This test writes a project that fills in
// every field the front end knows, and every value of each choice, to
// crates/name-model/tests/fixtures; the Rust test `contract.rs` reads them back
// and checks that nothing is lost or changed on the way through Rust.
//
// A field added here fails the type check below until the fixture has it; then
// the Rust test fails until model.rs has it too. After changing the fixture,
// run `npx vitest run -u src/contract.test.ts` to write the files again.
import { describe, expect, it } from "vitest";
import type { HeldPanel } from "./hold";
import type {
  BalloonShape,
  Binding,
  BrushKind,
  EraseMode,
  LineKind,
  PanelBorder,
  PanelEffect,
  PanelFill,
  Project,
  TailStyle,
} from "./project";

/** Every field present (optional ones too), every array with at least one element. */
type Full<T> = T extends readonly (infer U)[] ? [Full<U>, ...Full<U>[]] : T extends object ? { [K in keyof T]-?: Full<T[K]> } : T;

/** Every value of a choice, as the keys of a record (so that none can be missed). */
type AllOf<T extends string> = Record<T, true>;

const curve = { min: 0.25, curve: [[0.5, 0.75]] } satisfies Full<NonNullable<Project["brushes"][number]["sizePressure"]>>;

function fullPage(id: string): Full<Project["pages"][number]> {
  return {
    id,
    memo: "ページのメモ",
    panels: [
      {
        id: `${id}-panel1`,
        shape: [
          [10, 10],
          [100, 10],
          [100, 80],
          [10, 80],
        ],
        order: 1,
        border: "thick",
        openEdges: [2],
        fill: "black",
        effect: "speed",
        z: 1,
        note: "引き",
        noteAt: [2.5, 3.5],
        spread: "spread1",
      },
    ],
    lines: [
      {
        id: `${id}-line1`,
        text: "セリフ\n二行目",
        kind: "thought",
        speaker: "char1",
        panel: `${id}-panel1`,
        box: [20, 20, 40, 60],
        fontSizePt: 9.5,
        vertical: true,
        balloon: [
          [18, 18],
          [42, 18],
          [42, 62],
        ],
        balloonShape: "cloud",
        tails: [{ tip: [50, 70], style: "bubbles", bend: -1.5 }],
        linkTo: `${id}-line2`,
        inverted: true,
        emphasis: true,
        mask: true,
      },
    ],
    strokes: [
      {
        id: `${id}-stroke1`,
        points: [
          [1.25, 2.5, 0.5],
          [3.5, 4.75, 0.625, 0.125, 0.875],
        ],
        widthMm: 0.4,
        closed: true,
        over: true,
        brush: "brush1",
        cut: [true, false],
      },
    ],
    roughs: [{ id: `${id}-rough1`, layerId: 12, layerName: "ラフ", sheetCrop: [1, 2, 300, 400], box: [0, 0, 182, 257] }],
    breakouts: [
      {
        id: `${id}-breakout1`,
        shape: [
          [5, 5],
          [15, 5],
          [15, 15],
        ],
        note: "はみ出し",
      },
    ],
    joinNext: true,
    stickies: [{ id: `${id}-sticky1`, text: "付箋", at: [30, 40], color: "pink", link: { kind: "line", id: `${id}-line1`, at: [1, 2] } }],
    fills: [
      {
        id: `${id}-fill1`,
        shape: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        tone: "gray",
      },
    ],
    references: [{ id: `${id}-reference1`, image: "image1", box: [10, 20, 110, 95], opacity: 0.35 }],
  };
}

const page = fullPage("page1");
const held: Full<HeldPanel> = {
  id: "held1",
  panel: page.panels[0],
  lines: page.lines,
  strokes: page.strokes,
  fills: page.fills,
  stickies: page.stickies,
  near: "page1",
  from: "page2",
};

export const FULL_PROJECT: Full<Project> = {
  formatVersion: 2,
  title: "全項目",
  storyIndex: 4,
  author: "作者",
  binding: "left",
  pageFormat: { canvasMm: [210, 297], trimMm: [182, 257], basicMm: [150, 220], basicOffsetMm: [30, 38.5] },
  pages: [page],
  characters: [{ id: "char1", name: "主人公", color: "#cc3344", tone: "です・ます" }],
  scenes: [
    {
      id: "scene1",
      title: "出会い",
      summary: "二人が出会う",
      firstPage: "page1",
      lastPage: "page1",
      storyTime: "夏",
      storyOrder: 2,
    },
  ],
  emotions: [{ character: "char1", page: "page1", value: 0.5, note: "期待" }],
  source: { path: "C:/ネーム/第4話.clip", resolution: 350, cells: [[0, 0, 100, 140]] },
  brushes: [
    {
      id: "brush1",
      name: "鉛筆",
      kind: "eraser",
      sizeMm: 0.7,
      sizePressure: curve,
      sizeTilt: curve,
      sizeSpeed: curve,
      sizeRandom: curve,
      opacity: 0.9,
      opacityPressure: curve,
      opacityTilt: curve,
      opacitySpeed: curve,
      opacityRandom: curve,
      hardness: 0.5,
      stabilization: 12,
      stabilizationBySpeed: true,
      postCorrection: 3,
      taperInMm: 1.5,
      taperOutMm: 2.5,
      thickness: 80,
      rotation: 30,
      tip: { pngBase64: "iVBORw0KGgo=", width: 16, height: 8, interval: 25, enabled: true },
      erase: "intersection",
      source: "鉛筆.sut",
    },
  ],
  alternatives: [
    {
      id: "alt1",
      pageIds: ["page1"],
      active: "option1",
      options: [{ id: "option2", name: "別案", pages: [fullPage("page9")] }],
    },
  ],
  plan: {
    targetPages: 24,
    structure: "shape1",
    shapes: [{ id: "shape1", label: "自分の型", parts: [{ name: "導入", share: 0.25, color: "#88aa44" }], beats: [{ name: "転機", at: 0.5 }] }],
  },
  lineShapes: { speech: "rounded", thought: "polygon", narration: "box", sfx: "none", aside: "dashed" },
  held: [held],
  images: [{ id: "image1", name: "駅.jpg", mime: "image/jpeg", dataBase64: "/9j/4AAQ", widthPx: 400, heightPx: 300 }],
  nextId: 42,
};

/** Every value of each choice the Rust model has as an enum. */
export const CHOICES: { [K in string]: string[] } = {
  binding: Object.keys({ right: true, left: true } satisfies AllOf<Binding>),
  lineKind: Object.keys({ speech: true, thought: true, narration: true, sfx: true, aside: true } satisfies AllOf<LineKind>),
  panelBorder: Object.keys({ solid: true, thick: true, none: true, dashed: true, wavy: true } satisfies AllOf<PanelBorder>),
  panelFill: Object.keys({ none: true, white: true, black: true, gray: true } satisfies AllOf<PanelFill>),
  panelEffect: Object.keys({ none: true, speed: true, focus: true, flash: true, sparkle: true } satisfies AllOf<PanelEffect>),
  balloonShape: Object.keys({
    auto: true,
    ellipse: true,
    rounded: true,
    box: true,
    polygon: true,
    cloud: true,
    spike: true,
    burst: true,
    wavy: true,
    flash: true,
    electric: true,
    dashed: true,
    none: true,
    custom: true,
  } satisfies AllOf<BalloonShape>),
  tailStyle: Object.keys({ wedge: true, bubbles: true, line: true, zigzag: true } satisfies AllOf<TailStyle>),
  brushKind: Object.keys({ pen: true, eraser: true } satisfies AllOf<BrushKind>),
  eraseMode: Object.keys({ touched: true, intersection: true, whole: true } satisfies AllOf<EraseMode>),
};

describe("the name data as Rust reads it", () => {
  it("has every field in the fixture for the Rust test", async () => {
    await expect(`${JSON.stringify(FULL_PROJECT, null, 2)}\n`).toMatchFileSnapshot("../../crates/name-model/tests/fixtures/full-project.json");
  });

  it("has every value of each choice in the fixture for the Rust test", async () => {
    await expect(`${JSON.stringify(CHOICES, null, 2)}\n`).toMatchFileSnapshot("../../crates/name-model/tests/fixtures/choices.json");
  });
});
