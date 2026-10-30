// 物語の帯: the lane of the story shape (話の型) with its parts and beats,
// and the inspector for the shape and the page plan.
import { element as html, svg } from "./dom";
import type { Project, StoryShape } from "./model";
import { forgetShape, keepShape, libraryShapes } from "./prefs";
import { addBeat, adoptShape, beatPage, currentShape, editableShape, isBuiltinShape, makeShape, moveBoundary, partColor, removeBeat, removePart, removeShape, setBeat, shapeSpans, splitPart, storyShapes } from "./shapes";
import { textAmount } from "./dialogue";
import { planAdvice, sceneSpans } from "./story";
import { clip, diamond, icon, type LaneView, SHAPE, track } from "./boardview";

export function shapeLane(view: LaneView, project: Project, top: number): SVGGElement {
  const group = svg("g", { class: "lane shape-lane" });
  const count = project.pages.length;
  const shape = currentShape(project);
  group.append(svg("rect", { x: 0, y: top, width: view.width(), height: SHAPE, class: "lane-bg" }));
  if (!shape || !count) {
    const hint = svg("text", { x: 8, y: top + 24, class: "lane-hint" }, "クリックで話の型（起承転結・Save the Cat・自分の型）を選ぶと、ページの区切りがここに出ます");
    group.addEventListener("click", () => view.select({ kind: "shape" }));
    group.classList.add("pick");
    group.append(hint);
    return group;
  }
  const spans = shapeSpans(shape, count);
  if (!spans.length) {
    group.append(svg("text", { x: 8, y: top + 24, class: "lane-hint" }, `ページが ${shape.parts.length} より少ないので区切れません`));
    return group;
  }
  for (const span of spans) {
    const { left: x, width: w } = view.span(span.first, span.last);
    const part = svg("rect", { x: x + 1, y: top + 3, width: Math.max(1, w - 2), height: 20, rx: 5, class: "part", fill: span.color });
    part.addEventListener("click", () => view.select({ kind: "shape" }));
    part.addEventListener("mousemove", (event) => view.tip.show(event, [span.name, `${span.first + 1}〜${span.last + 1} ページ（${span.last - span.first + 1} ページ）`, "クリックで型を直す"]));
    part.addEventListener("mouseleave", () => view.tip.hide());
    group.append(part, svg("text", { x: x + 7, y: top + 17, class: "part-label" }, clip(span.name, Math.floor((w - 10) / 12))));
  }
  // Boundaries between parts: drag to change how many pages each gets.
  spans.slice(0, -1).forEach((span) => {
    const bx = view.x(span.last + 1);
    const guide = svg("line", { x1: bx, x2: bx, y1: top + 1, y2: top + 25, class: "part-edge" });
    const handle = svg("rect", { x: bx - 5, y: top + 1, width: 10, height: 24, class: "part-handle" });
    handle.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      view.hold();
      track(down, handle, {
        move: (event) => {
          const { boundary } = view.at(event);
          const gx = view.x(Math.max(1, Math.min(count - 1, boundary)));
          guide.setAttribute("x1", String(gx));
          guide.setAttribute("x2", String(gx));
          guide.classList.add("dragging");
          view.tip.show(event, [`${span.name} を ${Math.max(1, boundary)} ページ目まで`]);
        },
        end: (event, moved) => {
          view.tip.hide();
          view.release();
          if (!moved) return;
          const boundary = Math.max(1, Math.min(count - 1, view.at(event).boundary));
          view.edit((p) => {
            const own = editableShape(p);
            if (!own) return;
            moveBoundary(own, span.index, boundary / count);
            keepShape(own);
          });
        },
      });
    });
    group.append(guide, handle);
  });
  // Beats: markers to drag along the pages.
  (shape.beats ?? []).forEach((beat, index) => {
    const page = beatPage(beat.at, count);
    const cx = view.cell(page) + view.column / 2;
    const marker = svg("path", { d: diamond(cx, top + 32, 6), class: "beat" });
    const label = view.column >= 60 || (shape.beats?.length ?? 0) <= count / 3 ? svg("text", { x: cx + 9, y: top + 36, class: "beat-label" }, clip(beat.name, Math.max(2, Math.floor((view.column * 2.2) / 11)))) : null;
    marker.addEventListener("mousemove", (event) => view.tip.show(event, [beat.name, `${page + 1} ページあたり`, "ドラッグで動かす"]));
    marker.addEventListener("mouseleave", () => view.tip.hide());
    marker.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      view.hold();
      track(down, marker, {
        move: (event) => {
          const { index: at } = view.at(event);
          marker.setAttribute("d", diamond(view.cell(at) + view.column / 2, top + 32, 7));
          view.tip.show(event, [beat.name, `${at + 1} ページへ`]);
        },
        end: (event, moved) => {
          view.tip.hide();
          view.release();
          if (!moved) {
            view.select({ kind: "shape" });
            return;
          }
          const at = view.at(event).index;
          view.edit((p) => {
            const own = editableShape(p);
            if (!own) return;
            setBeat(own, index, (at + 0.5) / count);
            keepShape(own);
          });
        },
      });
    });
    group.append(marker);
    if (label) group.append(label);
  });
  return group;
}

/** 話の型 and the page plan: which shape, how many pages, and what falls where. */
export function shapeInspector(view: LaneView, project: Project): HTMLElement[] {
  const shape = currentShape(project);
  const count = project.pages.length;
  const picker = shapePicker(view, project);
  const target = html("input", { type: "number", min: "1", value: project.plan?.targetPages ? String(project.plan.targetPages) : "", placeholder: String(count), title: "目標ページ数" });
  target.addEventListener("change", () =>
    view.edit((p) => {
      const value = Number.parseInt(target.value, 10);
      const plan = { ...(p.plan ?? {}) };
      if (Number.isInteger(value) && value > 0) plan.targetPages = value;
      else delete plan.targetPages;
      if (Object.keys(plan).length) p.plan = plan;
      else delete p.plan;
    }),
  );
  const panels = project.pages.reduce((sum, page) => sum + page.panels.length, 0);
  const characters = project.pages.reduce((sum, page) => sum + textAmount(page), 0);
  const head = [
    html("h2", { className: "story-title" }, icon("shape"), html("span", { textContent: "話の型とページ配分" })),
    html("p", { className: "insp-summary", textContent: `${count} ページ・シーン ${sceneSpans(project).length}・コマ ${panels}・${characters} 字` }),
    html("label", {}, "話の型", picker),
    html("label", { className: "inline" }, "目標", target, "ページ"),
    ...planAdvice(project)
      .filter((advice) => advice.level === "warn")
      .map((advice) => html("p", { className: "insp-warn", textContent: advice.text })),
  ];
  if (!shape) return [...head, html("p", { className: "hint", textContent: "型を選ぶと、帯の「型」に区切りの色が出て、ページ一覧も色分けされます。" })];

  const builtIn = isBuiltinShape(shape.id);
  const spans = shapeSpans(shape, count);
  /** Change the shape (a built-in one is copied into an own shape first) and keep it on this computer. */
  const change = (apply: (own: StoryShape) => void) =>
    view.edit((p) => {
      const own = editableShape(p);
      if (!own) return;
      apply(own);
      keepShape(own);
    });
  const label = html("input", { type: "text", value: shape.label, disabled: builtIn });
  label.addEventListener("change", () => change((own) => (own.label = label.value.trim() || own.label)));
  const scenes = sceneSpans(project);
  const parts = shape.parts.map((part, i) => {
    const name = html("input", { type: "text", value: part.name });
    name.addEventListener("change", () => change((own) => (own.parts[i].name = name.value.trim() || own.parts[i].name)));
    const color = html("input", { type: "color", value: partColor(shape, i) });
    color.addEventListener("change", () => change((own) => (own.parts[i].color = color.value)));
    const span = spans[i];
    const inside = span ? scenes.filter((s) => (s.first + s.last) / 2 >= span.first && (s.first + s.last) / 2 <= span.last + 0.5).map((s) => s.scene.title) : [];
    const pages = html("span", { className: "pages", textContent: span ? `${span.first + 1}〜${span.last + 1}` : "—", title: inside.length ? `シーン: ${inside.join("・")}` : "ここに当たるシーンはありません" });
    const split = html("button", { className: "small", textContent: "分割", title: "この区切りを二つに分ける" });
    split.addEventListener("click", () => change((own) => splitPart(own, i)));
    const remove = html("button", { className: "danger small", textContent: "×", title: "この区切りを消す（ページは前の区切りへ）", disabled: shape.parts.length <= 1 });
    remove.addEventListener("click", () => change((own) => removePart(own, i)));
    return html("div", { className: "insp-row part" }, color, name, pages, split, remove);
  });
  const beats = (shape.beats ?? []).map((beat, i) => {
    const name = html("input", { type: "text", value: beat.name });
    name.addEventListener("change", () => change((own) => own.beats && (own.beats[i].name = name.value.trim() || own.beats[i].name)));
    const page = html("input", { type: "number", min: "1", max: String(count), value: String(beatPage(beat.at, count) + 1), title: "ページ" });
    page.addEventListener("change", () => {
      const value = Number.parseInt(page.value, 10);
      if (Number.isInteger(value)) change((own) => setBeat(own, i, (Math.max(1, Math.min(count, value)) - 0.5) / count));
    });
    const remove = html("button", { className: "danger small", textContent: "×" });
    remove.addEventListener("click", () => change((own) => removeBeat(own, i)));
    return html("div", { className: "insp-row beat" }, html("span", { className: "diamond", textContent: "◆" }), name, page, remove);
  });
  const addBeatButton = html("button", { textContent: "ビートを足す" });
  addBeatButton.addEventListener("click", () => change((own) => addBeat(own, "ビート", 0.5)));
  const copy = html("button", { textContent: builtIn ? "写して自分の型にする" : "写しを作る" });
  copy.addEventListener("click", () =>
    view.edit((p) => {
      const from = currentShape(p);
      if (from) keepShape(makeShape(p, from, builtIn ? undefined : `${from.label}の写し`));
    }),
  );
  const remove = html("button", { className: "danger", textContent: "この型を消す", title: "このネームとこの PC から消す" });
  remove.addEventListener("click", () =>
    view.edit((p) => {
      removeShape(p, shape.id);
      forgetShape(shape.id);
    }),
  );
  return [
    ...head,
    html("h3", { textContent: `区切り（${count} ページに当てると）` }),
    ...parts,
    html("h3", { textContent: "ビート（話の転換点）" }),
    ...(beats.length ? beats : [html("p", { className: "hint", textContent: "なし" })]),
    html("div", { className: "row" }, addBeatButton, copy, ...(builtIn ? [] : [remove])),
    ...(builtIn ? [] : [html("label", {}, "型の名前", label)]),
    html("p", {
      className: "hint",
      textContent: builtIn
        ? "決まった型です。直すと「（自分用）」の写しができ、このネームとこの PC に保存されます（ほかのネームでも選べます）。"
        : "自分の型です。このネームとこの PC に保存され、ほかのネームでも選べます。",
    }),
  ];
}

function shapePicker(view: LaneView, project: Project): HTMLSelectElement {
  const shapes = html("select", { title: "ページ配分の目安にする話の型" });
  shapes.append(html("option", { value: "", textContent: "話の型なし" }));
  const current = project.plan?.structure ?? "";
  const own = project.plan?.shapes ?? [];
  const builtIn = html("optgroup", { label: "決まった型" } as Partial<HTMLOptGroupElement>);
  const mine = html("optgroup", { label: "このネームの型" } as Partial<HTMLOptGroupElement>);
  const kept = html("optgroup", { label: "この PC の型" } as Partial<HTMLOptGroupElement>);
  for (const shape of storyShapes(project)) {
    (isBuiltinShape(shape.id) ? builtIn : mine).append(html("option", { value: shape.id, textContent: shape.label, selected: shape.id === current }));
  }
  for (const shape of libraryShapes()) {
    if (own.some((s) => s.id === shape.id)) continue;
    kept.append(html("option", { value: `library:${shape.id}`, textContent: shape.label }));
  }
  shapes.append(builtIn);
  if (mine.childElementCount) shapes.append(mine);
  if (kept.childElementCount) shapes.append(kept);
  shapes.append(html("option", { value: "new", textContent: "＋ 自分の型を作る…" }));
  shapes.addEventListener("change", () => {
    const value = shapes.value;
    view.edit((p) => {
      if (value === "new") {
        keepShape(makeShape(p));
        return;
      }
      if (value.startsWith("library:")) {
        const shape = libraryShapes().find((s) => s.id === value.slice(8));
        if (shape) adoptShape(p, shape);
        return;
      }
      const plan = { ...(p.plan ?? {}) };
      if (value) plan.structure = value;
      else delete plan.structure;
      if (Object.keys(plan).length) p.plan = plan;
      else delete p.plan;
    });
  });
  return shapes;
}

