// 物語の帯: the scene lane, the story-time lane (時系列) and the inspector
// for a scene, plus the story around a page for the page's inspector.
import { addScene, setEmotion } from "./cast";
import { element as html, svg } from "./dom";
import type { Project } from "./model";
import { pageIndex } from "./project";
import { moveScene } from "./reorder";
import { currentShape, shapeSpans } from "./shapes";
import { emotionSeries, moveSceneEdge, sceneAtPage, sceneSpans, setStoryRank, timeline, uncoveredRunAt, type SceneSpan } from "./story";
import { clip, formatValue, icon, type LaneView, ROW, SCENE, track } from "./boardview";

export function sceneLane(view: LaneView, project: Project, top: number): SVGGElement {
  const group = svg("g", { class: "lane scene-lane" });
  const count = project.pages.length;
  const bg = svg("rect", { x: 0, y: top, width: view.x(count), height: SCENE, class: "lane-bg empty-scene" });
  bg.addEventListener("dblclick", (event) => {
    const { index } = view.at(event);
    const run = uncoveredRunAt(project, index);
    if (!run) return;
    view.edit((p) => {
      const scene = addScene(p, p.pages[run[0]].id, p.pages[run[1]].id, `シーン${p.scenes.length + 1}`);
      view.setSelection({ kind: "scene", sceneId: scene.id });
    });
  });
  bg.addEventListener("mousemove", (event) => {
    const { index } = view.at(event);
    view.tip.show(event, [`${index + 1} ページ`, uncoveredRunAt(project, index) ? "ダブルクリックでここにシーンを足す" : ""].filter(Boolean));
  });
  bg.addEventListener("mouseleave", () => view.tip.hide());
  group.append(bg);
  const spans = sceneSpans(project);
  spans.forEach((span, i) => {
    const x = view.x(span.first);
    const w = view.x(span.last + 1) - x;
    const bar = svg("rect", { x: x + 1, y: top + 4, width: Math.max(2, w - 2), height: SCENE - 8, rx: 6, class: `scene ${i % 2 ? "odd" : ""}`, "data-scene": span.scene.id });
    const text = svg("text", { x: x + 8, y: top + SCENE / 2 + 4, class: "scene-label" }, clip(span.scene.title, Math.floor((w - 12) / 12)));
    group.append(bar, text);
    bar.addEventListener("mousemove", (event) =>
      view.tip.show(event, [
        span.scene.title,
        span.first === span.last ? `${span.first + 1} ページ` : `${span.first + 1}〜${span.last + 1} ページ`,
        ...(span.scene.storyTime ? [span.scene.storyTime] : []),
        ...(span.scene.summary ? [span.scene.summary.split("\n")[0]] : []),
      ]),
    );
    bar.addEventListener("mouseleave", () => view.tip.hide());
    bar.addEventListener("dblclick", () => {
      view.selectScene(span);
      document.querySelector<HTMLInputElement>("#inspector input.scene-title")?.focus();
    });
    // The middle moves the scene's pages; the ends change its range.
    bar.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      view.hold();
      const marker = view.mark("insert");
      track(down, bar, {
        move: (event, moved) => {
          if (!moved) return;
          const { boundary } = view.at(event);
          view.placeMark(marker, view.x(boundary));
          bar.classList.add("dragging");
          view.tip.show(event, [`「${span.scene.title}」を ${boundary + 1 > count ? "最後" : `${boundary + 1} ページの前`}へ`]);
        },
        end: (event, moved) => {
          marker.remove();
          view.tip.hide();
          view.release();
          if (!moved) {
            view.selectScene(span);
            return;
          }
          const { boundary } = view.at(event);
          view.edit((p) => moveScene(p, span.scene.id, boundary));
        },
      });
    });
    for (const edge of ["first", "last"] as const) {
      const ex = edge === "first" ? x : x + w;
      const handle = svg("rect", { x: ex - 5, y: top + 4, width: 10, height: SCENE - 8, class: "scene-handle" });
      handle.addEventListener("pointerdown", (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        down.stopPropagation();
        view.hold();
        track(down, handle, {
          move: (event) => {
            // The edge goes to the page boundary nearest the pointer.
            const index = view.edgeIndex(event, edge);
            const a = edge === "first" ? Math.min(index, span.last) : span.first;
            const b = edge === "last" ? Math.max(index, span.first) : span.last;
            bar.setAttribute("x", String(view.x(a) + 1));
            bar.setAttribute("width", String(Math.max(2, view.x(b + 1) - view.x(a) - 2)));
            view.tip.show(event, [span.scene.title, `${a + 1}〜${b + 1} ページ`]);
          },
          end: (event, moved) => {
            view.tip.hide();
            view.release();
            if (!moved) return;
            const index = view.edgeIndex(event, edge);
            view.edit((p) => moveSceneEdge(p, span.scene.id, edge, index));
          },
        });
      });
      group.append(handle);
    }
  });
  return group;
}

export function timeLane(view: LaneView, project: Project, top: number, height: number): SVGGElement {
  const group = svg("g", { class: "lane time-lane" });
  const count = project.pages.length;
  group.append(svg("rect", { x: 0, y: top, width: view.x(count), height, class: "lane-bg" }));
  const rows = timeline(project);
  if (!rows.length) {
    group.append(svg("text", { x: 8, y: top + 26, class: "lane-hint" }, "シーンを足すと、ページの順と物語の中の時間の流れがここに並びます"));
    return group;
  }
  const rowY = (rank: number) => top + 7 + rank * ROW + ROW / 2;
  for (let i = 1; i < rows.length; i++) {
    const [a, b] = [rows[i - 1], rows[i]];
    group.append(svg("path", { d: `M${view.x(a.last + 1)},${rowY(a.storyRank)} L${view.x(b.first)},${rowY(b.storyRank)}`, class: "reading-path" }));
  }
  for (const row of rows) {
    const x = view.x(row.first);
    const w = Math.max(4, view.x(row.last + 1) - x - 2);
    const cy = rowY(row.storyRank);
    const bar = svg("rect", { x: x + 1, y: cy - 7, width: w, height: 14, rx: 4, class: `time-bar${row.flashback ? " flashback" : ""}`, "data-scene": row.scene.id });
    const label = `${row.scene.title}${row.scene.storyTime ? `（${row.scene.storyTime}）` : ""}`;
    const text = svg("text", { x: x + 6, y: cy + 4, class: "time-label" }, clip(label, Math.floor((w - 8) / 11)));
    bar.addEventListener("mousemove", (event) =>
      view.tip.show(event, [label, `物語の中で ${row.storyRank + 1} 番目`, ...(row.flashback ? ["それより後の出来事を見せたあとに出てくる（回想など）"] : []), "上下にドラッグで順を変える"]),
    );
    bar.addEventListener("mouseleave", () => view.tip.hide());
    bar.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      view.hold();
      const box = view.canvas()!.getBoundingClientRect();
      const rankAt = (event: PointerEvent) => Math.max(0, Math.min(rows.length - 1, Math.floor((event.clientY - box.top - top - 7) / ROW)));
      track(down, bar, {
        move: (event, moved) => {
          if (!moved) return;
          const rank = rankAt(event);
          bar.setAttribute("y", String(rowY(rank) - 7));
          text.setAttribute("y", String(rowY(rank) + 4));
          bar.classList.add("dragging");
          view.tip.show(event, [row.scene.title, `物語の中で ${rank + 1} 番目へ`]);
        },
        end: (event, moved) => {
          view.tip.hide();
          view.release();
          if (!moved) {
            view.selectScene(row);
            return;
          }
          const rank = rankAt(event);
          view.edit((p) => setStoryRank(p, row.scene.id, rank));
        },
      });
    });
    group.append(bar, text);
    if (row.flashback && view.column * (row.last - row.first + 1) > 60) group.append(svg("text", { x: x + w + 4, y: cy + 4, class: "lane-hint small" }, "回想"));
  }
  return group;
}

export function sceneInspector(view: LaneView, project: Project, sceneId: string): HTMLElement[] {
  const span = sceneSpans(project).find((sp) => sp.scene.id === sceneId);
  if (!span) return [];
  const { scene } = span;
  const title = html("input", { type: "text", value: scene.title, className: "scene-title" });
  title.addEventListener("change", () => view.edit(() => (scene.title = title.value.trim() || scene.title)));
  const time = html("input", { type: "text", value: scene.storyTime ?? "", placeholder: "例: 1日目 朝" });
  time.addEventListener("change", () =>
    view.edit(() => {
      if (time.value.trim()) scene.storyTime = time.value.trim();
      else delete scene.storyTime;
    }),
  );
  const summary = html("textarea", { value: scene.summary, placeholder: "このシーンで起きること", rows: 5 });
  summary.addEventListener("change", () => view.edit(() => (scene.summary = summary.value)));
  const rank = timeline(project).find((row) => row.scene.id === sceneId);
  const option = html("button", { textContent: "別案を作る", title: "このシーンのページを写した案を作り、ページ配分やコマ割りを試す" });
  option.addEventListener("click", () => view.host.makeOption(span.first, span.last));
  const remove = html("button", { className: "danger", textContent: "シーンを消す", title: "ページはそのまま残ります" });
  remove.addEventListener("click", () =>
    view.edit((p) => {
      p.scenes = p.scenes.filter((s) => s.id !== sceneId);
      view.setSelection(null);
    }),
  );
  const pages = html("div", { className: "insp-pages" });
  for (let index = span.first; index <= span.last; index++) {
    const go = html("button", { className: "chip", textContent: String(index + 1), title: `${index + 1} ページを開く` });
    go.addEventListener("click", () => view.host.openPage(index + 1));
    pages.append(go);
  }
  return [
    html("h2", { className: "story-title" }, icon("scene"), html("span", { textContent: "シーン" })),
    html("label", {}, "名前", title),
    html("p", { className: "insp-summary", textContent: `${span.last - span.first + 1} ページ・物語の中で ${(rank?.storyRank ?? 0) + 1} 番目${rank?.flashback ? "（回想）" : ""}` }),
    pages,
    html("label", {}, "物語の中の時", time),
    html("label", {}, "あらすじ", summary),
    ...emotionsIn(project, span),
    html("div", { className: "row" }, option, remove),
    html("p", { className: "hint", textContent: "帯でシーンの両端をドラッグするとページの範囲、真ん中のドラッグで場所、時系列の棒の上下で物語の中の順が変わります。" }),
  ];
}

/** How each character moves through a scene, as a small line of dots. */
function emotionsIn(project: Project, span: SceneSpan): HTMLElement[] {
  const rows = project.characters
    .map((character) => {
      const values = emotionSeries(project, character.id).filter((s) => s.index >= span.first && s.index <= span.last);
      if (!values.length) return null;
      const row = html("div", { className: "insp-emotion", title: values.map((v) => `${v.index + 1}p ${formatValue(v.value)}`).join("  ") });
      const swatch = html("span", { className: "swatch" });
      swatch.style.background = character.color ?? "#2a78d6";
      row.append(swatch, html("span", { className: "who", textContent: character.name }), sparkline(values.map((v) => v.value), character.color ?? "#2a78d6"));
      return row;
    })
    .filter((row): row is HTMLDivElement => !!row);
  return rows.length ? [html("h3", { textContent: "感情" }), ...rows] : [];
}

/**
 * The story around a page, for the page's inspector: its part of the shape,
 * its scene (a click selects it) and each character's value there.
 */
export function pageStory(view: LaneView, project: Project, pageId: string): HTMLElement[] {
  const index = pageIndex(project, pageId);
  if (index < 0) return [];
  const scene = sceneAtPage(project, index);
  const shape = currentShape(project);
  const part = shape ? shapeSpans(shape, project.pages.length).find((p) => p.first <= index && index <= p.last) : undefined;
  const tags = html("div", { className: "story-tags" });
  if (part) {
    const tag = html("button", { className: "story-tag part", textContent: part.name, title: "話の型（クリックで直す）" });
    tag.style.setProperty("--part", part.color);
    tag.addEventListener("click", () => view.select({ kind: "shape" }));
    tags.append(tag);
  }
  if (scene) {
    const tag = html("button", { className: "story-tag scene" }, icon("scene"), html("span", { textContent: scene.scene.title }));
    tag.title = "シーン（クリックで名前・あらすじを直す）";
    tag.addEventListener("click", () => view.select({ kind: "scene", sceneId: scene.scene.id }));
    tags.append(tag);
  }
  const emotions = project.characters.map((character) => {
    const point = project.emotions.find((p) => p.character === character.id && p.page === pageId);
    const value = html("input", { type: "number", min: "-1", max: "1", step: "0.1", value: point ? String(point.value) : "", placeholder: "—", title: "-1（後ろ向き）〜 1（前向き）" });
    value.addEventListener("change", () =>
      view.edit((p) => {
        const parsed = Number.parseFloat(value.value);
        setEmotion(p, character.id, pageId, Number.isFinite(parsed) ? parsed : null, point?.note);
      }),
    );
    const note = html("input", { type: "text", value: point?.note ?? "", placeholder: point ? "なぜそう感じるか" : "値を入れるとメモも", disabled: !point });
    note.addEventListener("change", () => view.edit((p) => setEmotion(p, character.id, pageId, point!.value, note.value)));
    const swatch = html("span", { className: "swatch" });
    swatch.style.background = character.color ?? "#2a78d6";
    return html("div", { className: "insp-row emotion" }, swatch, html("span", { className: "who", textContent: character.name }), value, note);
  });
  return [
    ...(tags.childElementCount ? [tags] : []),
    ...(emotions.length ? [html("details", { className: "emotion-fold", open: project.emotions.some((p) => p.page === pageId) }, html("summary", { textContent: "感情（-1〜1）" }), ...emotions)] : []),
  ];
}

/** A small line of values from -1 to 1. */
function sparkline(values: number[], color: string): SVGSVGElement {
  const [w, h] = [120, 22];
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (value: number) => 2 + (h - 4) * (1 - (value + 1) / 2);
  const line = svg("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: "sparkline" });
  line.append(svg("line", { x1: 0, x2: w, y1: y(0), y2: y(0), class: "axis" }));
  if (values.length > 1) line.append(svg("polyline", { points: values.map((v, i) => `${i * step},${y(v)}`).join(" "), fill: "none", stroke: color, "stroke-width": 2 }));
  values.forEach((v, i) => line.append(svg("circle", { cx: values.length > 1 ? i * step : w / 2, cy: y(v), r: 2.5, fill: color })));
  return line;
}
