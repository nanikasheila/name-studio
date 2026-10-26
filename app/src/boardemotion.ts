// 物語の帯: the emotion curves (traced with the pointer) and the amount of
// dialogue on each page (字数).
import { setEmotion } from "./cast";
import { textAmount } from "./dialogue";
import { svg } from "./dom";
import type { Project } from "./model";
import { emotionRuns, emotionSeries, HEAVY_TEXT, speakingPages } from "./story";
import { formatValue, type LaneView, TEXT, track } from "./boardview";

export function emotionLane(view: LaneView, project: Project, top: number): SVGGElement {
  const group = svg("g", { class: "lane emotion-lane" });
  const EMOTION = view.emotionHeight();
  const count = project.pages.length;
  const width = view.x(count);
  const pad = 12;
  const plot = EMOTION - pad * 2;
  const y = (value: number) => top + pad + plot * (1 - (value + 1) / 2);
  const valueAt = (py: number) => Math.round(Math.max(-1, Math.min(1, 1 - ((py - top - pad) / plot) * 2)) * 10) / 10;
  const bg = svg("rect", { x: 0, y: top, width, height: EMOTION, class: "lane-bg emotion-bg" });
  group.append(bg);
  if (!project.characters.length) {
    // Nothing to trace yet: a line on how to start, not an empty chart.
    group.append(svg("text", { x: 8, y: top + EMOTION / 2 + 4, class: "lane-hint" }, "左の欄の「人物」で登場人物を足すと、ここをなぞって感情の移り変わりを描けます"));
    return group;
  }
  for (const value of [1, 0.5, 0, -0.5, -1]) group.append(svg("line", { x1: 0, x2: width, y1: y(value), y2: y(value), class: value === 0 ? "axis" : "grid" }));
  group.append(svg("text", { x: 4, y: y(1) + 12, class: "lane-hint small" }, "前向き"), svg("text", { x: 4, y: y(-1) - 4, class: "lane-hint small" }, "後ろ向き"));
  const center = (index: number) => view.x(index) + view.column / 2;
  const series = project.characters.map((character) => ({ character, samples: emotionSeries(project, character.id) }));
  series.sort((a, b) => Number(a.character.id === view.character) - Number(b.character.id === view.character));
  for (const { character, samples } of series) {
    const color = character.color ?? "#2a78d6";
    const editing = character.id === view.character;
    // Solid over pages next to each other; dotted across pages with no value.
    const runs = emotionRuns(samples);
    runs.forEach((run, i) => {
      if (run.length > 1) group.append(svg("polyline", { points: run.map((s) => `${center(s.index)},${y(s.value)}`).join(" "), class: `curve${editing ? " editing" : ""}`, stroke: color }));
      const next = runs[i + 1]?.[0];
      const end = run[run.length - 1];
      if (next) group.append(svg("line", { x1: center(end.index), y1: y(end.value), x2: center(next.index), y2: y(next.value), class: `curve gap${editing ? " editing" : ""}`, stroke: color }));
    });
    // Where the character speaks: ticks along the bottom.
    if (editing) {
      for (const index of speakingPages(project, character.id)) {
        group.append(svg("rect", { x: center(index) - 1.5, y: top + EMOTION - 7, width: 3, height: 5, rx: 1, class: "speaks", fill: color }));
      }
    }
    for (const sample of samples) group.append(svg("circle", { cx: center(sample.index), cy: y(sample.value), r: editing ? 4 : 3, class: "curve-point", fill: color }));
    const last = samples[samples.length - 1];
    if (last && project.characters.length <= 5) group.append(svg("text", { x: center(last.index) + 7, y: y(last.value) + 4, class: "curve-label" }, character.name));
  }
  const preview = svg("g", { class: "curve-preview" });
  group.append(preview);
  const crosshair = svg("line", { y1: top, y2: top + EMOTION, class: "crosshair", visibility: "hidden" });
  group.append(crosshair);
  const hit = svg("rect", { x: 0, y: top, width, height: EMOTION, class: "emotion-hit" });
  const box = () => view.canvas()!.getBoundingClientRect();
  hit.addEventListener("mousemove", (event) => {
    if (view.busy) return;
    const { index } = view.at(event);
    crosshair.setAttribute("x1", String(center(index)));
    crosshair.setAttribute("x2", String(center(index)));
    crosshair.setAttribute("visibility", "visible");
    const page = project.pages[index];
    const lines = project.characters.map((character) => {
      const point = project.emotions.find((p) => p.character === character.id && p.page === page.id);
      return `${character.name}: ${point ? formatValue(point.value) : "—"}${point?.note ? `（${point.note}）` : ""}`;
    });
    const who = project.characters.find((c) => c.id === view.character)?.name ?? "";
    view.tip.show(event, [`${index + 1} ページ`, ...lines, `クリックで ${who} を ${formatValue(valueAt(event.clientY - box().top))}`]);
  });
  hit.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    view.tip.hide();
  });
  hit.addEventListener("contextmenu", (event) => event.preventDefault());
  hit.addEventListener("pointerdown", (down) => {
    const characterId = view.character;
    if (!characterId) return;
    const { index } = view.at(down);
    if (down.button === 2 || down.altKey) {
      down.preventDefault();
      view.edit((p) => setEmotion(p, characterId, p.pages[index].id, null));
      return;
    }
    if (down.button !== 0) return;
    down.preventDefault();
    view.hold();
    // Values drawn while dragging, page index → value; written on release as one step.
    const drawn = new Map<number, number>();
    const color = project.characters.find((c) => c.id === characterId)?.color ?? "#2a78d6";
    const put = (event: PointerEvent) => {
      const { index: at } = view.at(event);
      drawn.set(at, valueAt(event.clientY - box().top));
      const points = [...drawn.entries()].sort((a, b) => a[0] - b[0]);
      preview.replaceChildren(
        svg("polyline", { points: points.map(([i, v]) => `${center(i)},${y(v)}`).join(" "), class: "curve editing", stroke: color }),
        ...points.map(([i, v]) => svg("circle", { cx: center(i), cy: y(v), r: 4, class: "curve-point", fill: color })),
      );
      view.tip.show(event, [`${at + 1} ページ: ${formatValue(drawn.get(at)!)}`]);
    };
    put(down);
    track(down, hit, {
      move: (event) => put(event),
      end: () => {
        view.tip.hide();
        view.release();
        view.edit((p) => {
          for (const [at, value] of drawn) {
            const old = p.emotions.find((point) => point.character === characterId && point.page === p.pages[at].id);
            setEmotion(p, characterId, p.pages[at].id, value, old?.note);
          }
        });
      },
    });
  });
  group.append(hit);
  return group;
}

export function textLane(view: LaneView, project: Project, top: number): SVGGElement {
  const group = svg("g", { class: "lane text-lane" });
  const count = project.pages.length;
  group.append(svg("rect", { x: 0, y: top, width: view.x(count), height: TEXT, class: "lane-bg" }));
  const amounts = project.pages.map(textAmount);
  const max = Math.max(HEAVY_TEXT, ...amounts);
  const barWidth = Math.max(2, Math.min(24, view.column - 6));
  amounts.forEach((amount, index) => {
    if (!amount) return;
    const h = ((TEXT - 8) * amount) / max;
    const bar = svg("rect", { x: view.x(index) + (view.column - barWidth) / 2, y: top + TEXT - 4 - h, width: barWidth, height: h, rx: 2, class: `amount${amount > HEAVY_TEXT ? " heavy" : ""}` });
    bar.addEventListener("mousemove", (event) => view.tip.show(event, [`${index + 1} ページ`, `${amount} 字${amount > HEAVY_TEXT ? "（多め）" : ""}`]));
    bar.addEventListener("mouseleave", () => view.tip.hide());
    group.append(bar);
  });
  const heavy = top + TEXT - 4 - ((TEXT - 8) * HEAVY_TEXT) / max;
  group.append(svg("line", { x1: 0, x2: view.x(count), y1: heavy, y2: heavy, class: "heavy-line" }));
  return group;
}
