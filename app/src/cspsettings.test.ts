import { describe, expect, it } from "vitest";
import { brushFromSubTool, type CspSubTool } from "./brush";
import {
  INPUT_PRESSURE,
  INPUT_SPEED,
  INPUT_TILT,
  applyCspSettings,
  base64Of,
  bytesOf,
  cspSettingsFor,
  drawnValues,
  effectorBytes,
  effectorOf,
  materialNames,
  newBrush,
  newEffector,
  parseEffector,
  setSetting,
} from "./cspsettings";
import type { CspToolData } from "./model";

/** An effector blob as CSP writes it (header 40, 44 or 48 bytes). */
function effector(header: number, inputs: number, minimum: number[], pressure: [number, number][] | null): Uint8Array {
  const graph = pressure ? 12 + pressure.length * 16 : 0;
  const view = new DataView(new ArrayBuffer(header + graph));
  const words = [header, 0x1f0, inputs, ...minimum, 0, graph, 0];
  if (header >= 44) words.push(100);
  if (header >= 48) words.push(0);
  words.forEach((value, i) => view.setUint32(i * 4, value));
  if (pressure) {
    view.setUint32(header, 12);
    view.setUint32(header + 4, pressure.length);
    view.setUint32(header + 8, 16);
    pressure.forEach(([x, y], i) => {
      view.setFloat64(header + 12 + i * 16, x);
      view.setFloat64(header + 20 + i * 16, y);
    });
  }
  return new Uint8Array(view.buffer);
}

const curve: [number, number][] = [
  [0, 0],
  [0.6636, 0.0818],
  [1, 1],
];

/** 丸ペン's settings as CSP keeps them (the ones that matter here). */
function maruPen(): CspToolData {
  const tool: CspToolData = {
    settings: {
      Opacity: 100,
      AntiAlias: 2,
      FlickerReduction: 6,
      BrushSize: 5,
      BrushSizeUnit: 0,
      BrushHardness: 100,
      BrushInterval: 10,
      BrushThickness: 100,
      BrushRotation: 0,
      BrushUseIn: 1,
      BrushInLength: 20,
      BrushInLengthUnit: 0,
      BrushUseOut: 1,
      BrushOutLength: 20,
      BrushOutLengthUnit: 0,
    },
    node: { NodeInputOp: 11, NodeOutputOp: 11 },
    dpi: 600,
  };
  setSetting(tool, "BrushSizeEffector", effector(40, INPUT_PRESSURE, [0, 100, 100, 100], curve));
  return tool;
}

describe("影響元設定 (effector blobs)", () => {
  it("reads and writes back the bytes of every header size", () => {
    for (const header of [40, 44, 48]) {
      const bytes = effector(header, INPUT_PRESSURE | INPUT_TILT, [10, 20, 30, 40], curve);
      const parsed = parseEffector(bytes);
      expect(parsed?.minimum).toEqual([10, 20, 30, 40]);
      expect(parsed?.pressure).toEqual(curve);
      expect(effectorBytes(parsed!)).toEqual(bytes);
    }
  });

  it("rejects what is not one", () => {
    expect(parseEffector(new Uint8Array(8))).toBeNull();
    const cut = effector(40, INPUT_PRESSURE, [0, 0, 0, 0], curve).slice(0, 60);
    expect(parseEffector(cut)).toBeNull();
  });

  it("grows the header for a speed graph", () => {
    const parsed = parseEffector(effector(40, INPUT_SPEED, [0, 0, 50, 0], null))!;
    parsed.speed = [
      [0, 1],
      [1, 0.2],
    ];
    const again = parseEffector(effectorBytes(parsed))!;
    expect(again.headerSize).toBe(48);
    expect(again.speed).toEqual(parsed.speed);
    expect(again.minimum[2]).toBe(50);
  });

  it("keeps base64 as it was", () => {
    const bytes = new Uint8Array(70000).map((_, i) => i * 7);
    expect(bytesOf(base64Of(bytes))).toEqual(bytes);
  });
});

describe("drawing values from the CSP settings", () => {
  it("works out a pen as taking it over from CSP does", () => {
    const tool = maruPen();
    const values = drawnValues(tool, "pen");
    expect(values.sizeMm).toBeCloseTo((5 * 25.4) / 600);
    expect(values.taperInMm).toBeCloseTo((20 * 25.4) / 600);
    expect(values.sizePressure).toEqual({ min: 0, curve });
    expect(values.opacityPressure).toBeUndefined();
    expect(values.stabilization).toBe(6);
  });

  it("follows a change of the settings", () => {
    const tool = maruPen();
    const brush = brushFromSubTool({ ...subTool(), csp: tool }, 600, "b");
    expect(brush.csp?.dpi).toBe(600);
    // Unit 2 is tens of pixels.
    brush.csp!.settings.BrushSize = 2.4;
    brush.csp!.settings.BrushSizeUnit = 2;
    brush.csp!.settings.BrushUseOut = 0;
    const size = effectorOf(brush.csp!, "BrushSizeEffector")!;
    size.inputs = 0;
    setSetting(brush.csp!, "BrushSizeEffector", effectorBytes(size));
    applyCspSettings(brush);
    expect(brush.sizeMm).toBeCloseTo((24 * 25.4) / 600);
    expect(brush.taperOutMm).toBe(0);
    expect(brush.sizePressure).toBeUndefined();
  });

  it("gives a brush without settings ones that draw it the same", () => {
    const brush = newBrush("pen", "b", "ペン");
    const values = drawnValues(cspSettingsFor({ ...brush, sizeMm: 0.7, taperInMm: 1.5, postCorrection: 30 }), "pen");
    expect(values.sizeMm).toBeCloseTo(0.7, 3);
    expect(values.taperInMm).toBeCloseTo(1.5, 3);
    expect(values.postCorrection).toBe(30);
    expect(values.sizePressure).toEqual({ min: 0.1 });
    const eraser = newBrush("eraser", "e", "消しゴム");
    expect(eraser.erase).toBe("touched");
    expect(eraser.csp?.node?.NodeInputOp).toBe(12);
    expect(newEffector().inputs).toBe(0);
  });

  it("reads material names", () => {
    const name = "丸";
    const path = "c:\\x";
    const pathBytes = (path.length + 1) * 2;
    const nameBytes = (name.length + 1) * 2;
    const size = 8 + pathBytes + 4 + 4 + nameBytes;
    const view = new DataView(new ArrayBuffer(8 + size));
    view.setUint32(0, 8);
    view.setUint32(4, 1);
    view.setUint32(8, size);
    view.setUint32(12, pathBytes);
    [...path].forEach((c, i) => view.setUint16(16 + i * 2, c.charCodeAt(0), true));
    view.setUint32(16 + pathBytes + 4, nameBytes);
    view.setUint16(16 + pathBytes + 8, name.charCodeAt(0), true);
    expect(materialNames(new Uint8Array(view.buffer))).toEqual([name]);
  });

  // CSP_TOOLS_JSON: `name-cli subtools EditImageTool.todb` of a real CSP; every pen
  // and eraser must come out of its settings as taking it over gives it.
  const real = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CSP_TOOLS_JSON;
  it.skipIf(!real)("agrees with taking over every tool of a real CSP", async () => {
    const fs: { readFileSync(path: string, encoding: "utf8"): string } = await import(/* @vite-ignore */ `node:${"fs"}`);
    const tools = JSON.parse(fs.readFileSync(real!, "utf8")) as CspSubTool[];
    for (const tool of tools) {
      const brush = brushFromSubTool(tool, 600, "b");
      const kept = structuredClone(brush);
      applyCspSettings(brush);
      expect({ tool: tool.name, ...brush }).toEqual({ tool: tool.name, ...kept });
    }
  });
});

function subTool(): CspSubTool {
  return {
    name: "丸ペン",
    group: ["ペン"],
    kind: "pen",
    size: { value: 5, unit: "px" },
    sizeDynamics: null,
    opacity: 1,
    opacityDynamics: null,
    flow: 1,
    flowDynamics: null,
    hardness: 1,
    antiAlias: 2,
    stabilization: 6,
    taperIn: null,
    taperOut: null,
    interval: 10,
    thickness: 100,
    rotation: 0,
    tipMaterial: null,
    tip: null,
    vectorErase: null,
  };
}
