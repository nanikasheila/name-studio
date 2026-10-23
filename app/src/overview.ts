// Overview views of the name data: 構成 (scenes and how pages fill),
// 感情曲線 (how each character feels page by page) and 時系列 (story time
// against page order). Charts are SVG with a hover tooltip; values are also
// editable in plain tables.
import { dragSort } from "./dragsort";
import { Board } from "./board";
import { addScene, bounds, moveScene, pageBlock, pageIndex, setEmotion, sortScenes, type Project } from "./project";
import { pageParts, storyShapes } from "./shapes";
import { emotionSeries, pageStats, planAdvice, planParts, sceneSpans, timeline, uncoveredRuns, type SceneSpan } from "./story";

export type OverviewKind = "board" | "structure" | "emotion" | "timeline";

export interface OverviewHost {
  project(): Project | null;
  /** Run `change` as one undoable step. */
  edit(change: (project: Project) => void): void;
  /** Open a page (1-based) in the editor. */
  openPage(pageNumber: number): void;
  /** Pages `first`..`last` dragged to before page `target`. */
  movePages(first: number, last: number, target: number): void;
  /** 別案 of pages `first`..`last` (0-based), to edit. */
  makeOption(first: number, last: number): void;
  /** Say what was done in the status bar. */
  status?(message: string): void;
}

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** x positions of page slots across a plot. */
interface PageScale {
  left: number;
  step: number;
  center(index: number): number;
  indexAt(x: number): number;
}

function pageScale(count: number, left: number, width: number): PageScale {
  const step = width / Math.max(count, 1);
  return {
    left,
    step,
    center: (index) => left + step * (index + 0.5),
    indexAt: (x) => Math.min(count - 1, Math.max(0, Math.floor((x - left) / step))),
  };
}

const PLOT = { left: 56, right: 16, top: 26, bottom: 28 };

export class Overview {
  kind: OverviewKind = "board";
  /** Character whose emotion values clicks on the chart change. */
  private editing: string | null = null;
  private readonly tip: HTMLDivElement;
  private readonly board: Board;

  constructor(private readonly root: HTMLElement, private readonly host: OverviewHost) {
    this.tip = html("div", { className: "chart-tip" });
    this.tip.hidden = true;
    this.board = new Board(host, { show: (event, lines) => this.showTip(event, lines), hide: () => this.hideTip() }, () => this.render());
  }

  render(): void {
    const project = this.host.project();
    if (!project) return;
    this.root.classList.toggle("board-mode", this.kind === "board");
    if (this.kind === "board") {
      const board = this.board.render(project, this.root.clientWidth);
      if (!board) return;
      this.root.replaceChildren(board, this.tip);
      this.board.mounted();
      return;
    }
    const scroll = this.root.scrollTop;
    const content =
      this.kind === "structure" ? this.structure(project) : this.kind === "emotion" ? this.emotion(project) : this.timelineView(project);
    this.root.replaceChildren(...content, this.tip);
    this.root.scrollTop = scroll;
  }

  private width(): number {
    return Math.max(480, this.root.clientWidth - 48);
  }

  private showTip(event: MouseEvent, lines: string[]): void {
    this.tip.replaceChildren(...lines.map((line, i) => html(i === 0 ? "strong" : "div", { textContent: line })));
    this.tip.hidden = false;
    const box = this.root.getBoundingClientRect();
    const x = event.clientX - box.left + this.root.scrollLeft + 14;
    const y = event.clientY - box.top + this.root.scrollTop + 14;
    this.tip.style.left = `${Math.min(x, this.root.clientWidth - 220)}px`;
    this.tip.style.top = `${y}px`;
  }

  private hideTip(): void {
    this.tip.hidden = true;
  }

  /** Scene bands behind a plot, with titles along the top. */
  private sceneBands(spans: SceneSpan[], scale: PageScale, top: number, height: number): SVGGElement {
    const group = svg("g", { class: "scene-bands" });
    spans.forEach((span, i) => {
      const x = scale.left + scale.step * span.first;
      const w = scale.step * (span.last - span.first + 1);
      group.append(
        svg("rect", { x, y: top, width: w, height, class: i % 2 ? "band odd" : "band" }),
        svg("text", { x: x + 4, y: top - 8, class: "band-label" }, clip(span.scene.title, Math.floor(w / 13))),
      );
    });
    return group;
  }

  // --- 構成 ------------------------------------------------------------------

  private structure(project: Project): Element[] {
    const stats = pageStats(project);
    const spans = sceneSpans(project);
    const total = (key: "panels" | "lines" | "characters") => stats.reduce((sum, page) => sum + page[key], 0);
    const summary = html("p", {
      className: "summary",
      textContent: `${project.pages.length} ページ・シーン ${spans.length}・コマ ${total("panels")}・セリフ ${total("lines")}（${total("characters")} 字）`,
    });

    // Characters per page: shows where the name gets text heavy.
    const width = this.width();
    const height = 200;
    const scale = pageScale(stats.length, PLOT.left, width - PLOT.left - PLOT.right);
    const plotHeight = height - PLOT.top - PLOT.bottom;
    const max = Math.max(50, ...stats.map((page) => page.characters));
    const y = (value: number) => PLOT.top + plotHeight * (1 - value / max);
    const chart = svg("svg", { width, height, class: "chart", role: "img", "aria-label": "ページごとの字数" });
    chart.append(this.sceneBands(spans, scale, PLOT.top, plotHeight));
    for (const tick of niceTicks(max)) {
      chart.append(
        svg("line", { x1: PLOT.left, x2: width - PLOT.right, y1: y(tick), y2: y(tick), class: tick ? "grid" : "axis" }),
        svg("text", { x: PLOT.left - 8, y: y(tick) + 4, class: "tick", "text-anchor": "end" }, String(tick)),
      );
    }
    const barWidth = Math.max(2, Math.min(28, scale.step - 4));
    stats.forEach((page) => {
      const cx = scale.center(page.index);
      if (page.characters > 0) chart.append(svg("path", { d: roundedBar(cx - barWidth / 2, y(page.characters), barWidth, y(0) - y(page.characters)), class: "bar" }));
      const hit = svg("rect", { x: scale.left + scale.step * page.index, y: PLOT.top, width: scale.step, height: plotHeight, class: "hit" });
      const scene = spans.find((span) => span.first <= page.index && page.index <= span.last)?.scene.title;
      hit.addEventListener("mousemove", (event) =>
        this.showTip(event, [
          `${page.index + 1} ページ${scene ? `（${scene}）` : ""}`,
          `${page.characters} 字・セリフ ${page.lines}・コマ ${page.panels}`,
          ...(page.memo ? [page.memo.split("\n")[0]] : []),
        ]),
      );
      hit.addEventListener("mouseleave", () => this.hideTip());
      hit.addEventListener("click", () => this.host.openPage(page.index + 1));
      chart.append(hit);
      if (stats.length <= 40 || page.index % 5 === 4 || page.index === 0) {
        chart.append(svg("text", { x: cx, y: height - 10, class: "tick", "text-anchor": "middle" }, String(page.index + 1)));
      }
    });

    return [
      html("h2", { textContent: "構成" }),
      summary,
      html("h3", { textContent: "ページごとの字数（棒をクリックでそのページへ）" }),
      chart,
      ...this.planSection(project, spans),
      ...this.sceneTable(project, spans),
      html("h3", { textContent: "ページ一覧（ドラッグで入れ替え。色は話の型の区切り）" }),
      ...this.partLegend(project),
      this.thumbnails(project, spans),
    ];
  }

  /** 構成補助: the aimed page count and story shape against the scenes, and pages worth a look. */
  private planSection(project: Project, spans: SceneSpan[]): Element[] {
    const plan = project.plan ?? {};
    const target = html("input", { type: "number", min: "1", value: plan.targetPages ? String(plan.targetPages) : "", placeholder: String(project.pages.length) });
    target.addEventListener("change", () =>
      this.host.edit((p) => {
        const value = Number.parseInt(target.value, 10);
        const next = { ...(p.plan ?? {}) };
        if (Number.isInteger(value) && value > 0) next.targetPages = value;
        else delete next.targetPages;
        if (Object.keys(next).length) p.plan = next;
        else delete p.plan;
      }),
    );
    const shape = html("select");
    shape.append(html("option", { value: "", textContent: "なし" }));
    for (const structure of storyShapes(project)) shape.append(html("option", { value: structure.id, textContent: structure.label, selected: plan.structure === structure.id }));
    shape.addEventListener("change", () =>
      this.host.edit((p) => {
        const next = { ...(p.plan ?? {}) };
        if (shape.value) next.structure = shape.value;
        else delete next.structure;
        if (Object.keys(next).length) p.plan = next;
        else delete p.plan;
      }),
    );
    const controls = html(
      "div",
      { className: "plan-controls" },
      html("label", {}, "目標ページ数 ", target),
      html("label", {}, "話の型 ", shape),
    );
    // The story shape over the pages there are, above the scenes.
    const count = project.pages.length;
    const width = this.width();
    const scale = pageScale(count, PLOT.left, width - PLOT.left - PLOT.right);
    const parts = planParts(project, count);
    const band = svg("svg", { width, height: parts.length ? 92 : 56, class: "chart plan", role: "img", "aria-label": "話の型とシーン" });
    let top = 22;
    if (parts.length) {
      parts.forEach((part) => {
        const x = scale.left + scale.step * part.first;
        const w = scale.step * (part.last - part.first + 1);
        band.append(
          svg("rect", { x, y: top, width: w - 2, height: 24, rx: 4, class: "part", fill: part.color }),
          svg("text", { x: x + 6, y: top + 16, class: "part-label" }, `${part.name}（${part.last - part.first + 1}）`),
        );
      });
      band.append(svg("text", { x: PLOT.left - 8, y: top + 16, class: "tick", "text-anchor": "end" }, "型"));
      top += 36;
    }
    band.append(this.sceneBands(spans, scale, top + 10, 20));
    band.append(svg("text", { x: PLOT.left - 8, y: top + 24, class: "tick", "text-anchor": "end" }, "シーン"));
    const advice = planAdvice(project);
    const list = html("ul", { className: "advice" });
    for (const item of advice) {
      const row = html("li", { className: item.level, textContent: item.text });
      if (item.page !== undefined) {
        const page = item.page;
        row.classList.add("link");
        row.addEventListener("click", () => this.host.openPage(page + 1));
      }
      list.append(row);
    }
    return [
      html("h3", { textContent: "ページ配分の目安" }),
      controls,
      band,
      advice.length ? list : html("p", { className: "hint", textContent: "目標ページ数や話の型を入れると、今のページ配分と比べます。" }),
      html("p", { className: "hint", textContent: "自分の型（オリジナルの型）は「全体」の画面で作って直せます。" }),
    ];
  }

  private sceneTable(project: Project, spans: SceneSpan[]): Element[] {
    const pageOptions = (selected: string) => {
      const select = html("select");
      project.pages.forEach((page, index) => select.append(html("option", { value: page.id, textContent: String(index + 1), selected: page.id === selected })));
      return select;
    };
    const rows = spans.map(({ scene }) => {
      const title = html("input", { type: "text", value: scene.title });
      title.addEventListener("change", () => this.host.edit(() => (scene.title = title.value.trim() || scene.title)));
      const first = pageOptions(scene.firstPage);
      const last = pageOptions(scene.lastPage);
      const setRange = () =>
        this.host.edit((p) => {
          let [a, b] = [first.value, last.value];
          if (pageIndex(p, a) > pageIndex(p, b)) [a, b] = [b, a];
          scene.firstPage = a;
          scene.lastPage = b;
          sortScenes(p);
        });
      first.addEventListener("change", setRange);
      last.addEventListener("change", setRange);
      const time = html("input", { type: "text", value: scene.storyTime ?? "", placeholder: "例: 1日目 朝" });
      time.addEventListener("change", () =>
        this.host.edit(() => {
          if (time.value.trim()) scene.storyTime = time.value.trim();
          else delete scene.storyTime;
        }),
      );
      const order = html("input", { type: "number", step: "1", value: scene.storyOrder === undefined ? "" : String(scene.storyOrder), placeholder: "ページ順" });
      order.addEventListener("change", () =>
        this.host.edit(() => {
          const value = Number.parseFloat(order.value);
          if (Number.isFinite(value)) scene.storyOrder = value;
          else delete scene.storyOrder;
        }),
      );
      const summary = html("textarea", { value: scene.summary, placeholder: "このシーンで起きること" });
      summary.addEventListener("change", () => this.host.edit(() => (scene.summary = summary.value)));
      const option = html("button", { textContent: "別案", title: "このシーンのページを写した案を作り、ページ配分やコマ割りを試す" });
      option.addEventListener("click", () => {
        const span = sceneSpans(project).find((s) => s.scene === scene);
        if (span) this.host.makeOption(span.first, span.last);
      });
      const remove = html("button", { className: "danger", textContent: "削除" });
      remove.addEventListener("click", () => this.host.edit((p) => (p.scenes = p.scenes.filter((s) => s !== scene))));
      return html(
        "tr",
        {},
        html("td", { className: "drag-handle", title: "ドラッグでシーンごとページを入れ替え", textContent: "⋮⋮" }),
        html("td", {}, title),
        html("td", { className: "range" }, first, "〜", last),
        html("td", {}, time),
        html("td", {}, order),
        html("td", {}, summary),
        html("td", { className: "row-buttons" }, option, remove),
      );
    });
    const add = html("button", { textContent: "シーンを足す", disabled: !project.pages.length });
    add.addEventListener("click", () =>
      this.host.edit((p) => {
        // Cover the first pages no scene has yet, or the last page.
        const [run] = uncoveredRuns(p);
        const [a, b] = run ?? [p.pages.length - 1, p.pages.length - 1];
        addScene(p, p.pages[a].id, p.pages[b].id, `シーン${p.scenes.length + 1}`);
      }),
    );
    const head = html(
      "tr",
      {},
      ...["", "シーン", "ページ", "物語の中の時", "時系列の順", "あらすじ", ""].map((label) => html("th", { textContent: label })),
    );
    // Drag a scene by its handle: its pages move before the scene it is dropped on.
    dragSort(rows, {
      axis: "y",
      handle: (row) => row.firstElementChild as HTMLElement,
      drop: (first, _last, target) => {
        const page = target < spans.length ? spans[target].first : project.pages.length;
        this.host.edit((p) => moveScene(p, spans[first].scene.id, page));
      },
    });
    const uncovered = uncoveredRuns(project);
    const note = uncovered.length
      ? html("p", { className: "hint", textContent: `シーンに入っていないページ: ${uncovered.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}〜${b + 1}`)).join("、")}` })
      : html("p", { className: "hint", textContent: "時系列の順は、回想などページの順と物語の時間が違うときだけ数で入れます（小さいほど昔）。" });
    return [
      html("h3", { textContent: "シーン" }),
      html("table", { className: "scenes" }, html("thead", {}, head), html("tbody", {}, ...rows)),
      html("div", { className: "row-actions" }, add),
      note,
    ];
  }

  /** Which colour is which part of the story shape. */
  private partLegend(project: Project): Element[] {
    const parts = planParts(project, project.pages.length);
    if (!parts.length) return [];
    return [
      html(
        "div",
        { className: "legend" },
        ...parts.map((part) => {
          const swatch = html("span", { className: "swatch" });
          swatch.style.background = part.color;
          return html("span", { className: "chip static" }, swatch, `${part.name} ${part.first + 1}〜${part.last + 1}`);
        }),
      ),
    ];
  }

  private thumbnails(project: Project, spans: SceneSpan[]): HTMLElement {
    const [pageW, pageH] = project.pageFormat.canvasMm;
    const width = 96;
    const scale = width / pageW;
    const grid = html("div", { className: "thumbs" });
    const parts = pageParts(project);
    project.pages.forEach((page, index) => {
      const canvas = html("canvas", { width: width * 2, height: Math.round(pageH * scale) * 2 });
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(2 * scale, 2 * scale);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, pageW, pageH);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = "#1b1a18";
        for (const panel of page.panels) {
          ctx.beginPath();
          panel.shape.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.stroke();
        }
        ctx.strokeStyle = "#6d6a63";
        ctx.lineWidth = 0.8;
        for (const stroke of page.strokes) {
          ctx.beginPath();
          stroke.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        }
        for (const line of page.lines) {
          const shape = line.balloon ?? null;
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#1b1a18";
          if (shape) {
            ctx.beginPath();
            shape.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
          const [x0, y0, x1, y1] = line.box;
          ctx.fillStyle = "rgba(27, 26, 24, 0.35)";
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        if (!page.panels.length && !page.lines.length && !page.strokes.length) {
          const [x0, y0, x1, y1] = bounds([[0, 0], [pageW, pageH]]);
          ctx.strokeStyle = "#d9d6cf";
          ctx.strokeRect(x0 + 20, y0 + 20, x1 - x0 - 40, y1 - y0 - 40);
        }
      }
      const scene = spans.find((span) => span.first === index)?.scene.title ?? "";
      const part = parts[index];
      const number = html("span", { className: "number", textContent: `${index + 1}` });
      const card = html(
        "button",
        { className: "thumb", title: [part?.name, page.memo || `${index + 1} ページ`].filter(Boolean).join("・") },
        html("span", { className: "scene", textContent: scene }),
        canvas,
        number,
      );
      // 話の型の色分け: the part the page falls in.
      if (part) {
        card.classList.add("tinted");
        card.style.setProperty("--part", part.color);
      }
      card.addEventListener("click", () => this.host.openPage(index + 1));
      grid.append(card);
    });
    // Drag a page (a 見開き moves as a pair) to put it elsewhere.
    dragSort([...grid.children] as HTMLElement[], {
      axis: "x",
      block: (index) => pageBlock(project, index),
      drop: (first, last, target) => this.host.movePages(first, last, target),
    });
    return grid;
  }

  // --- 感情曲線 ------------------------------------------------------------------

  private emotion(project: Project): Element[] {
    const characters = project.characters;
    if (!characters.length) {
      return [
        html("h2", { textContent: "感情曲線" }),
        html("p", { className: "hint", textContent: "登場人物がいません。編集画面の左の「人物」で足してください。" }),
      ];
    }
    if (!this.editing || !characters.some((c) => c.id === this.editing)) this.editing = characters[0].id;
    const legend = html(
      "div",
      { className: "legend" },
      ...characters.map((character) => {
        const chip = html(
          "button",
          { className: `chip${character.id === this.editing ? " active" : ""}`, title: "この人物の値を図で編集する" },
          html("span", { className: "swatch" }),
          character.name,
        );
        (chip.firstChild as HTMLElement).style.background = character.color ?? "#2a78d6";
        chip.addEventListener("click", () => {
          this.editing = character.id;
          this.render();
        });
        return chip;
      }),
    );

    const width = this.width();
    const height = 340;
    const count = project.pages.length;
    const scale = pageScale(count, PLOT.left, width - PLOT.left - PLOT.right);
    const plotHeight = height - PLOT.top - PLOT.bottom;
    const y = (value: number) => PLOT.top + plotHeight * (1 - (value + 1) / 2);
    const valueAt = (py: number) => Math.round(Math.max(-1, Math.min(1, 1 - ((py - PLOT.top) / plotHeight) * 2)) * 10) / 10;
    const chart = svg("svg", { width, height, class: "chart emotion", role: "img", "aria-label": "感情曲線" });
    chart.append(this.sceneBands(sceneSpans(project), scale, PLOT.top, plotHeight));
    for (const [value, label] of [[1, "+1 前向き"], [0.5, ""], [0, "0"], [-0.5, ""], [-1, "-1 後ろ向き"]] as const) {
      chart.append(svg("line", { x1: PLOT.left, x2: width - PLOT.right, y1: y(value), y2: y(value), class: value === 0 ? "axis" : "grid" }));
      if (label) chart.append(svg("text", { x: PLOT.left - 6, y: y(value) + 4, class: "tick", "text-anchor": "end" }, label.split(" ")[0]));
    }
    chart.append(
      svg("text", { x: PLOT.left + 4, y: y(1) + 14, class: "tick" }, "前向き"),
      svg("text", { x: PLOT.left + 4, y: y(-1) - 6, class: "tick" }, "後ろ向き"),
    );
    for (let i = 0; i < count; i++) {
      if (count <= 40 || i % 5 === 4 || i === 0) chart.append(svg("text", { x: scale.center(i), y: height - 10, class: "tick", "text-anchor": "middle" }, String(i + 1)));
    }
    const crosshair = svg("line", { y1: PLOT.top, y2: PLOT.top + plotHeight, class: "crosshair", visibility: "hidden" });
    chart.append(crosshair);
    const series = characters.map((character) => ({ character, samples: emotionSeries(project, character.id) }));
    // The character being edited is drawn last, on top.
    series.sort((a, b) => Number(a.character.id === this.editing) - Number(b.character.id === this.editing));
    for (const { character, samples } of series) {
      const color = character.color ?? "#2a78d6";
      const editing = character.id === this.editing;
      if (samples.length > 1) {
        chart.append(
          svg("polyline", {
            points: samples.map((s) => `${scale.center(s.index)},${y(s.value)}`).join(" "),
            class: `series${editing ? " editing" : ""}`,
            stroke: color,
          }),
        );
      }
      for (const sample of samples) {
        chart.append(svg("circle", { cx: scale.center(sample.index), cy: y(sample.value), r: 4, class: "marker", fill: color }));
      }
      const lastSample = samples[samples.length - 1];
      if (lastSample && characters.length <= 4) {
        chart.append(svg("text", { x: scale.center(lastSample.index) + 8, y: y(lastSample.value) + 4, class: "direct-label" }, character.name));
      }
    }
    // Clicks set the edited character's value at the page under the pointer;
    // Alt+click (or a right click) removes it.
    const plot = svg("rect", { x: PLOT.left, y: PLOT.top, width: width - PLOT.left - PLOT.right, height: plotHeight, class: "hit editable" });
    const pointAt = (event: MouseEvent) => {
      const box = chart.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    let dragging = false;
    const apply = (event: MouseEvent, remove: boolean) => {
      const [px, py] = pointAt(event);
      const index = scale.indexAt(px);
      const editing = this.editing!;
      this.host.edit((p) => setEmotion(p, editing, p.pages[index].id, remove ? null : valueAt(py)));
    };
    plot.addEventListener("pointerdown", (event) => {
      if (event.button === 2 || event.altKey) {
        apply(event, true);
        return;
      }
      if (event.button !== 0) return;
      dragging = true;
      apply(event, false);
    });
    plot.addEventListener("contextmenu", (event) => event.preventDefault());
    plot.addEventListener("pointerup", () => (dragging = false));
    plot.addEventListener("mousemove", (event) => {
      const [px, py] = pointAt(event);
      const index = scale.indexAt(px);
      crosshair.setAttribute("x1", String(scale.center(index)));
      crosshair.setAttribute("x2", String(scale.center(index)));
      crosshair.setAttribute("visibility", "visible");
      if (dragging && event.buttons === 1) apply(event, false);
      const values = characters.map((character) => {
        const sample = project.emotions.find((point) => point.character === character.id && point.page === project.pages[index].id);
        return `${character.name}: ${sample ? formatValue(sample.value) : "—"}${sample?.note ? `（${sample.note}）` : ""}`;
      });
      this.showTip(event, [`${index + 1} ページ`, ...values, `クリックで ${valueLabel(valueAt(py))}`]);
    });
    plot.addEventListener("mouseleave", () => {
      crosshair.setAttribute("visibility", "hidden");
      dragging = false;
      this.hideTip();
    });
    chart.append(plot);

    const editing = characters.find((c) => c.id === this.editing)!;
    return [
      html("h2", { textContent: "感情曲線" }),
      html("p", { className: "hint", textContent: "人物を選んで、図をクリック（ドラッグ）するとそのページの値が入ります。Alt＋クリックか右クリックで消します。" }),
      legend,
      chart,
      html("h3", { textContent: `${editing.name} の値とメモ` }),
      this.emotionTable(project, editing.id),
    ];
  }

  private emotionTable(project: Project, characterId: string): HTMLElement {
    const rows = project.pages.map((page, index) => {
      const point = project.emotions.find((p) => p.character === characterId && p.page === page.id);
      const value = html("input", { type: "number", min: "-1", max: "1", step: "0.1", value: point ? String(point.value) : "", placeholder: "—" });
      value.addEventListener("change", () =>
        this.host.edit((p) => {
          const parsed = Number.parseFloat(value.value);
          setEmotion(p, characterId, page.id, Number.isFinite(parsed) ? parsed : null);
        }),
      );
      const note = html("input", { type: "text", value: point?.note ?? "", placeholder: point ? "なぜそう感じるか" : "", disabled: !point });
      note.addEventListener("change", () => this.host.edit((p) => setEmotion(p, characterId, page.id, point!.value, note.value)));
      return html("tr", {}, html("td", { textContent: String(index + 1) }), html("td", {}, value), html("td", {}, note));
    });
    const head = html("tr", {}, ...["ページ", "値（-1〜1）", "メモ"].map((label) => html("th", { textContent: label })));
    return html("table", { className: "emotions" }, html("thead", {}, head), html("tbody", {}, ...rows));
  }

  // --- 時系列 -------------------------------------------------------------------------

  private timelineView(project: Project): Element[] {
    const rows = timeline(project);
    if (!rows.length) {
      return [
        html("h2", { textContent: "時系列" }),
        html("p", { className: "hint", textContent: "シーンがありません。「構成」でシーンを足すと、ページの順と物語の時間の流れを見比べられます。" }),
      ];
    }
    const width = this.width();
    const rowHeight = 34;
    const height = PLOT.top + rows.length * rowHeight + PLOT.bottom;
    const count = project.pages.length;
    const labelWidth = 150;
    const scale = pageScale(count, labelWidth, width - labelWidth - PLOT.right);
    const rowY = (rank: number) => PLOT.top + rank * rowHeight + rowHeight / 2;
    const chart = svg("svg", { width, height, class: "chart timeline", role: "img", "aria-label": "時系列" });
    chart.append(
      svg("text", { x: 8, y: PLOT.top - 10, class: "tick" }, "物語の時間 ↓"),
      svg("text", { x: width - PLOT.right, y: PLOT.top - 10, class: "tick", "text-anchor": "end" }, "ページ →"),
    );
    for (let i = 0; i < count; i++) {
      if (count <= 40 || i % 5 === 4 || i === 0) chart.append(svg("text", { x: scale.center(i), y: height - 10, class: "tick", "text-anchor": "middle" }, String(i + 1)));
    }
    // Reading path: from the end of one scene to the start of the next.
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      chart.append(
        svg("path", {
          d: `M${scale.left + scale.step * (a.last + 1)},${rowY(a.storyRank)} L${scale.left + scale.step * b.first},${rowY(b.storyRank)}`,
          class: "path",
        }),
      );
    }
    for (const row of rows) {
      const x = scale.left + scale.step * row.first;
      const w = Math.max(4, scale.step * (row.last - row.first + 1) - 2);
      const cy = rowY(row.storyRank);
      const bar = svg("rect", { x: x + 1, y: cy - 9, width: w, height: 18, rx: 4, class: row.flashback ? "scene-bar flashback" : "scene-bar" });
      const label = `${row.scene.title}${row.scene.storyTime ? `（${row.scene.storyTime}）` : ""}`;
      chart.append(bar, svg("text", { x: labelWidth - 8, y: cy + 4, class: "row-label", "text-anchor": "end" }, clip(label, 11)));
      if (row.flashback) chart.append(svg("text", { x: x + w + 6, y: cy + 4, class: "tick" }, "回想"));
      const pages = row.first === row.last ? `${row.first + 1} ページ` : `${row.first + 1}〜${row.last + 1} ページ`;
      bar.addEventListener("mousemove", (event) =>
        this.showTip(event, [label, pages, ...(row.scene.summary ? [row.scene.summary.split("\n")[0]] : []), ...(row.flashback ? ["物語ではもっと前の出来事（回想など）"] : [])]),
      );
      bar.addEventListener("mouseleave", () => this.hideTip());
      bar.addEventListener("click", () => this.host.openPage(row.first + 1));
    }
    const anyOrder = rows.some((row) => row.scene.storyOrder !== undefined);
    return [
      html("h2", { textContent: "時系列" }),
      html("p", {
        className: "hint",
        textContent: anyOrder
          ? "上ほど物語の中で早い出来事です。線は読む順。オレンジのシーンは、それより後の出来事を見せたあとで出てくる場面（回想など）です。"
          : "どのシーンにも「時系列の順」がないので、ページの順どおりに並んでいます。回想などは「構成」の表で順を入れてください。",
      }),
      chart,
    ];
  }
}

function clip(text: string, length: number): string {
  if (length <= 1) return "";
  return [...text].length > length ? `${[...text].slice(0, length - 1).join("")}…` : text;
}

function formatValue(value: number): string {
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

function valueLabel(value: number): string {
  return formatValue(value);
}

/** Bar with 4px rounded top corners anchored on the baseline. */
function roundedBar(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

function niceTicks(max: number): number[] {
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return ticks;
}
