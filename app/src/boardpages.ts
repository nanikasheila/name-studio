// 物語の帯: the pages with their panels. A click shows a page or panel on
// the canvas; a page's number strip drags it elsewhere, a panel dragged onto
// another (on any page) swaps what they hold.
import { element as html, svg } from "./dom";
import type { Panel, Project } from "./model";
import { drawThumb } from "./pagethumb";
import { swapPanelContents } from "./panels";
import { pageIndex } from "./project";
import { pageBlock } from "./reorder";
import { fingerprint } from "./snapshot";
import { currentShape, shapeSpans } from "./shapes";
import { sceneSpans } from "./story";
import { type LaneView, track } from "./boardview";

/** A page's picture, drawn again only when the page (or its size) changed: drawing every line of every page on each change is slow. */
function thumb(view: LaneView, project: Project, page: Project["pages"][number], thumbWidth: number, thumbHeight: number, ratio: number): HTMLCanvasElement {
  const key = `${thumbWidth}|${thumbHeight}|${ratio}|${fingerprint(project.pageFormat)}|${fingerprint(page)}`;
  const kept = view.thumbs.get(page.id);
  if (kept?.key === key) return kept.canvas;
  const canvas = html("canvas", { width: Math.round(thumbWidth * ratio), height: Math.round(thumbHeight * ratio) });
  canvas.style.width = `${thumbWidth}px`;
  canvas.style.height = `${thumbHeight}px`;
  const scale = (thumbWidth / project.pageFormat.canvasMm[0]) * ratio;
  const ctx = canvas.getContext("2d");
  if (ctx) drawThumb(ctx, project, page, { scale, x: 0, y: 0 }, thumbWidth >= 110);
  view.thumbs.set(page.id, { key, canvas });
  return canvas;
}

export function pageLane(view: LaneView, project: Project, thumbWidth: number, thumbHeight: number, showMemo: boolean): HTMLElement {
  // Pages no longer in the name drop their pictures.
  const ids = new Set(project.pages.map((page) => page.id));
  for (const id of view.thumbs.keys()) if (!ids.has(id)) view.thumbs.delete(id);
  const row = html("div", { className: "board-pages" });
  const [pageW, pageH] = project.pageFormat.canvasMm;
  const parts = currentShape(project) ? shapeSpans(currentShape(project)!, project.pages.length) : [];
  const partOf = (index: number) => parts.find((part) => part.first <= index && index <= part.last);
  const spans = sceneSpans(project);
  const ratio = window.devicePixelRatio || 1;
  project.pages.forEach((page, index) => {
    const card = html("div", { className: "board-page" });
    card.dataset.page = page.id;
    card.style.left = `${view.x(index) + 4}px`;
    card.style.width = `${thumbWidth}px`;
    const part = partOf(index);
    const scene = spans.find((span) => span.first === index);
    const head = html("div", { className: "board-page-head", title: "ドラッグでページを移動（見開きは 2 ページ一緒に）" }, html("span", { textContent: String(index + 1) }));
    if (part) {
      head.style.background = part.color;
      head.classList.add("tinted");
      head.title = `${part.name}・${head.title}`;
    }
    if (page.joinNext) head.append(html("span", { className: "spread-tag", textContent: "見開き" }));
    if (scene && thumbWidth >= 60) head.append(html("span", { className: "head-scene", textContent: scene.scene.title }));
    const canvas = thumb(view, project, page, thumbWidth, thumbHeight, ratio);
    const overlay = svg("svg", { class: "board-panels", viewBox: `0 0 ${pageW} ${pageH}`, width: thumbWidth, height: thumbHeight });
    for (const panel of page.panels) overlay.append(panelShape(view, project, index, panel));
    const sheet = html("div", { className: "board-sheet" }, canvas, overlay);
    sheet.addEventListener("click", (event) => {
      if ((event.target as Element).closest("[data-panel]")) return;
      view.host.openPage(index + 1);
    });
    card.append(head, sheet);
    if (showMemo) card.append(html("div", { className: "board-memo", textContent: page.memo.split("\n")[0] || "", title: page.memo }));
    pageDrag(view, project, index, head);
    row.append(card);
  });
  return row;
}

function panelShape(view: LaneView, project: Project, index: number, panel: Panel): SVGGElement {
  const page = project.pages[index];
  const points = panel.shape.map(([x, y]) => `${x},${y}`).join(" ");
  const shape = svg("polygon", { points, class: "board-panel" });
  const [x0, y0] = panel.shape.reduce(([ax, ay], [x, y]) => [Math.min(ax, x), Math.min(ay, y)], [Infinity, Infinity]);
  const group = svg("g", { "data-panel": panel.id, "data-page": page.id }, shape);
  if (view.column >= 70) group.append(svg("text", { x: x0 + 4, y: y0 + 14, class: "panel-number" }, String(panel.order)));
  if (panel.note) group.append(svg("circle", { cx: x0 + (view.column >= 70 ? 22 : 6), cy: y0 + 9, r: 4, class: "panel-has-note" }));
  group.addEventListener("mousemove", (event) => {
    if (view.busy) return;
    const lines = page.lines.filter((line) => line.panel === panel.id).map((line) => line.text.replace(/\s+/g, " "));
    view.tip.show(event, [`${index + 1} ページ コマ ${panel.order}`, ...(panel.note ? [`メモ: ${panel.note}`] : []), ...lines.slice(0, 3), "クリックで上に開く・ドラッグで別のコマと中身を入れ替え"]);
  });
  group.addEventListener("mouseleave", () => view.tip.hide());
  group.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    view.hold();
    const ghost = html("div", { className: "board-ghost", textContent: `${index + 1}p コマ ${panel.order}` });
    let over: SVGGElement | null = null;
    const targetAt = (event: PointerEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<SVGGElement>("[data-panel]") ?? null;
      return hit && hit !== group ? hit : null;
    };
    track(down, group, {
      move: (event, moved) => {
        if (!moved) return;
        view.tip.hide();
        group.classList.add("dragging");
        if (!ghost.isConnected) document.body.append(ghost);
        ghost.style.left = `${event.clientX + 12}px`;
        ghost.style.top = `${event.clientY + 12}px`;
        const target = targetAt(event);
        if (target !== over) {
          over?.classList.remove("drop-target");
          target?.classList.add("drop-target");
          over = target;
        }
        if (over) {
          const at = pageIndex(project, over.dataset.page!);
          const other = project.pages[at]?.panels.find((p) => p.id === over!.dataset.panel);
          ghost.textContent = `${index + 1}p コマ ${panel.order} ⇄ ${at + 1}p コマ ${other?.order ?? ""}`;
        } else ghost.textContent = `${index + 1}p コマ ${panel.order}`;
      },
      end: (_event, moved) => {
        ghost.remove();
        group.classList.remove("dragging");
        over?.classList.remove("drop-target");
        view.release();
        if (!moved) {
          view.host.selectPanel(page.id, panel.id);
          return;
        }
        if (!over) return;
        const [toPage, toPanel] = [over.dataset.page!, over.dataset.panel!];
        let message = "";
        view.edit((p) => {
          const a = p.pages.find((pg) => pg.id === page.id);
          const b = p.pages.find((pg) => pg.id === toPage);
          const pa = a?.panels.find((pn) => pn.id === panel.id);
          const pb = b?.panels.find((pn) => pn.id === toPanel);
          if (!a || !b || !pa || !pb) return;
          swapPanelContents(a, pa, b, pb, p.binding);
          message = `${pageIndex(p, a.id) + 1} ページのコマ ${pa.order} と ${pageIndex(p, b.id) + 1} ページのコマ ${pb.order} の中身を入れ替えました（元に戻すは Ctrl+Z）`;
        });
        if (message) view.host.status?.(message);
        view.host.selectPanel(toPage, toPanel);
      },
    });
  });
  return group;
}

/** Drag a page by its number strip to another place (a 見開き goes as a pair). */
function pageDrag(view: LaneView, project: Project, index: number, head: HTMLElement): void {
  head.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    view.hold();
    const [first, last] = pageBlock(project, index);
    const marker = view.mark("insert tall");
    track(down, head, {
      move: (event, moved) => {
        if (!moved) return;
        const { boundary } = view.at(event);
        view.placeMark(marker, view.x(boundary));
        head.parentElement?.classList.add("dragging");
        view.tip.show(event, [`${first === last ? `${first + 1} ページ` : `${first + 1}–${last + 1} ページ`}を ${boundary >= project.pages.length ? "最後" : `${boundary + 1} ページの前`}へ`]);
      },
      end: (event, moved) => {
        marker.remove();
        head.parentElement?.classList.remove("dragging");
        view.tip.hide();
        view.release();
        if (!moved) {
          view.host.openPage(index + 1);
          return;
        }
        view.host.movePages(first, last, view.at(event).boundary);
      },
    });
  });
}
