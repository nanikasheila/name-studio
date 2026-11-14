import { describe, expect, it } from "vitest";
import {
  columnsOf,
  defaultLayout,
  dockPalette,
  floatPalette,
  frameKey,
  frames,
  joinTab,
  movePalette,
  PALETTE_IDS,
  placePalette,
  readLayout,
  tidy,
  type DockLayout,
  type PaletteId,
  type Side,
} from "./docklayout";

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function problems(L: DockLayout): string[] {
  const out: string[] = [];
  for (const side of ["left", "right"] as Side[]) {
    const cols = columnsOf(L, side);
    cols.forEach((c, i) => c !== i && out.push(`${side} cols not contiguous ${cols}`));
    if (L.widths[side].length !== Math.max(1, cols.length)) out.push(`${side} widths ${L.widths[side].length} vs ${cols.length}`);
    for (const col of cols) {
      for (const f of frames(L, side, col)) {
        for (const m of f.members)
          if (frameKey(L, m) !== f.lead && frameKey(L, m) !== m) out.push(`frame lead ${f.lead} but ${m} keyed to ${frameKey(L, m)}`);
        for (const m of f.members)
          if (L.palettes[frameKey(L, m)] !== L.palettes[f.lead])
            out.push(`state of ${m}'s frame is ${frameKey(L, m)}, drawn from ${f.lead}`);
      }
    }
  }
  for (const id of PALETTE_IDS) {
    const p = L.palettes[id];
    if (p.tab && L.palettes[p.tab].tab) out.push(`tab chain ${id}`);
    if (p.tab && p.float) out.push(`floating tab ${id}`);
  }
  return out;
}

describe("dock layout under many moves", () => {
  it("keeps its frames whole", () => {
    for (let seed = 1; seed < 800; seed++) {
      const r = rng(seed);
      const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
      let L = defaultLayout();
      const log: string[] = [];
      for (let step = 0; step < 60; step++) {
        const id = pick(PALETTE_IDS) as PaletteId;
        const other = pick(PALETTE_IDS) as PaletteId;
        const side = pick(["left", "right"] as const);
        const op = Math.floor(r() * 8);
        log.push(`${op} ${id} ${other} ${side}`);
        if (op === 0) joinTab(L, id, other);
        else if (op === 1) movePalette(L, id, side, r() < 0.5 ? other : null);
        else if (op === 2) placePalette(L, id, { side, col: Math.floor(r() * 3), newColumn: r() < 0.3, before: r() < 0.5 ? other : null });
        else if (op === 3) floatPalette(L, id, { x: 10, y: 10, w: 200, h: 200 });
        else if (op === 4 && L.palettes[id].float) dockPalette(L, id);
        else if (op === 5) {
          L.palettes[id].shown = !L.palettes[id].shown;
          tidy(L);
        } else if (op === 6) L = readLayout(JSON.stringify(L));
        else if (op === 7) {
          L.palettes[frameKey(L, id)].folded = !L.palettes[frameKey(L, id)].folded;
        }
        const bad = problems(L);
        if (bad.length) throw new Error(`seed ${seed}: ${bad.join("; ")}\n${log.join("\n")}`);
      }
    }
    expect(true).toBe(true);
  }, 30_000);
});
