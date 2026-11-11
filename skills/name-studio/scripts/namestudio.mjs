#!/usr/bin/env node
// Name Studio の .namestudio を読み書きするコマンド（GPL-3.0-or-later）。
// app/src から `npm run build:skill` で作るので、直接は直さないこと。
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
// src/domain/style.ts
/** The app's text size (pt) for each kind of line. */
var APP_FONT_PT = {
	speech: 13,
	thought: 13,
	narration: 12,
	sfx: 13,
	aside: 13
};
/** The style of the name being drawn (set when the name is shown or changed). */
var current = {};
/** The text size (pt) a new line of `kind` gets. */
function defaultFontPt(kind, style = current) {
	return style?.fontPt?.[kind] ?? APP_FONT_PT[kind];
}
/** セリフの行間 (%), on screen and in CSP alike. */
function lineSpacing(style = current) {
	return style?.lineSpacing ?? 115;
}
/** Line pitch as a multiple of the font size. */
function linePitch(style = current) {
	return lineSpacing(style) / 100;
}
// src/model/geometry.ts
function bounds(points) {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of points) {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	return [
		x0,
		y0,
		x1,
		y1
	];
}
function rectShape([x0, y0, x1, y1]) {
	return [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1]
	];
}
function area(shape) {
	let sum = 0;
	for (let i = 0; i < shape.length; i++) {
		const [x0, y0] = shape[i];
		const [x1, y1] = shape[(i + 1) % shape.length];
		sum += x0 * y1 - x1 * y0;
	}
	return Math.abs(sum) / 2;
}
function centroid(shape) {
	const [x0, y0, x1, y1] = bounds(shape);
	return [(x0 + x1) / 2, (y0 + y1) / 2];
}
function insidePolygon(shape, [x, y]) {
	let inside = false;
	for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
		const [xi, yi] = shape[i];
		const [xj, yj] = shape[j];
		if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
function boxCenter([x0, y0, x1, y1]) {
	return [(x0 + x1) / 2, (y0 + y1) / 2];
}
// src/domain/balloon.ts
/** Room between the text and the outline, in mm. */
var PAD = 3;
function resolvedShape(line) {
	const shape = line.balloonShape ?? "auto";
	if (shape !== "auto") return shape;
	return autoShape(line.kind);
}
function autoShape(kind) {
	switch (kind) {
		case "speech": return "ellipse";
		case "thought": return "cloud";
		case "narration": return "box";
		case "sfx":
		case "aside": return "none";
	}
}
/** The tail style a new tail gets: bubbles for thoughts, zigzag for electric voices. */
function defaultTailStyle(line) {
	const shape = resolvedShape(line);
	if (shape === "cloud") return "bubbles";
	if (shape === "electric") return "zigzag";
	return "wedge";
}
/** Small deterministic noise so a burst keeps its shape between redraws. */
function seeded(text) {
	let h = 2166136261;
	for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
	return () => {
		h = Math.imul(h ^ h >>> 15, 2246822507);
		h = Math.imul(h ^ h >>> 13, 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	};
}
var TAU = Math.PI * 2;
function wrap(angle) {
	let a = angle % TAU;
	if (a <= -Math.PI) a += TAU;
	if (a > Math.PI) a -= TAU;
	return a;
}
/** Distance from the centre to a convex polygon (centred at the origin) along a ray. */
function rayToPolygon(vertices, angle) {
	const dx = Math.cos(angle);
	const dy = Math.sin(angle);
	let best = Infinity;
	for (let i = 0; i < vertices.length; i++) {
		const [ax, ay] = vertices[i];
		const [bx, by] = vertices[(i + 1) % vertices.length];
		const ex = bx - ax;
		const ey = by - ay;
		const det = dx * -ey - dy * -ex;
		if (Math.abs(det) < 1e-12) continue;
		const t = (ax * -ey - ay * -ex) / det;
		const s = (dx * ay - dy * ax) / det;
		if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
	}
	return Number.isFinite(best) ? best : 0;
}
/** The plain outline of a line's balloon (no tails, no links), or null for none. */
function star(line) {
	const shape = resolvedShape(line);
	if (shape === "none") return null;
	if (shape === "custom") return customStar(line.balloon);
	const [x0, y0, x1, y1] = line.box;
	const center = boxCenter(line.box);
	const [sx, sy] = line.balloonScale ?? [1, 1];
	const hw = (x1 - x0) / 2;
	const hh = (y1 - y0) / 2;
	const rx = (hw * Math.SQRT2 + PAD) * sx;
	const ry = (hh * Math.SQRT2 + PAD) * sy;
	const ellipse = (a) => 1 / Math.hypot(Math.cos(a) / rx, Math.sin(a) / ry);
	const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
	const random = seeded(line.id);
	let radius;
	let count = 64;
	const angles = [];
	switch (shape) {
		case "ellipse":
		case "dashed": {
			const steps = Math.min(240, Math.max(48, Math.round(perimeter / 1.5)));
			for (let k = 0; k < steps; k++) {
				const t = -Math.PI + k * TAU / steps;
				angles.push(Math.atan2(ry * Math.sin(t), rx * Math.cos(t)));
			}
			const facings = 72;
			for (let k = 0; k < facings; k++) {
				const facing = -Math.PI + k * TAU / facings;
				angles.push(Math.atan2(ry * ry * Math.sin(facing), rx * rx * Math.cos(facing)));
			}
			count = 0;
			radius = ellipse;
			break;
		}
		case "box": {
			const bx = (hw + PAD) * sx;
			const by = (hh + PAD) * sy;
			const corners = [
				[bx, by],
				[-bx, by],
				[-bx, -by],
				[bx, -by]
			];
			for (const [cx, cy] of corners) angles.push(Math.atan2(cy, cx));
			radius = (a) => rayToPolygon(corners, a);
			break;
		}
		case "rounded": {
			const a = (hw + PAD + 1) * sx;
			const b = (hh + PAD + 1) * sy;
			const n = 5;
			radius = (t) => (Math.abs(Math.cos(t) / a) ** n + Math.abs(Math.sin(t) / b) ** n) ** (-1 / n);
			break;
		}
		case "polygon": {
			const vertices = [];
			for (let k = 0; k < 6; k++) {
				const a = -Math.PI / 2 + k * TAU / 6 + (random() - .5) * .12;
				vertices.push([Math.cos(a) * rx * 1.08, Math.sin(a) * ry * 1.08]);
			}
			for (const [vx, vy] of vertices) angles.push(Math.atan2(vy, vx));
			radius = (a) => rayToPolygon(vertices, a);
			break;
		}
		case "cloud": {
			const bumps = Math.max(7, Math.round(perimeter / 9));
			count = bumps * 8;
			radius = (a) => ellipse(a) * (.93 + .13 * Math.abs(Math.sin(bumps * (a + Math.PI) / 2)));
			break;
		}
		case "spike":
		case "flash":
		case "electric":
		case "burst": {
			const spikes = Math.max(shape === "burst" ? 9 : 12, Math.round(perimeter / (shape === "flash" ? 2.2 : shape === "burst" ? 9 : shape === "electric" ? 5 : 5.5)));
			count = spikes * 2;
			const heights = Array.from({ length: spikes }, () => random());
			radius = (a, i) => {
				const base = ellipse(a);
				if (i % 2 === 0) return base * (shape === "burst" ? .92 : 1);
				const h = heights[(i - 1) / 2];
				if (shape === "spike") return base * (1.12 + .06 * h);
				if (shape === "flash") return base * (1.18 + .4 * h);
				if (shape === "electric") return base * 1.1;
				return base * (1.2 + .35 * h);
			};
			break;
		}
		case "wavy": {
			const waves = Math.max(16, Math.round(perimeter / 3.5));
			count = waves * 6;
			radius = (a) => ellipse(a) * (1 + .022 * Math.sin(waves * (a + Math.PI)));
			break;
		}
	}
	for (let i = 0; i < count; i++) angles.push(-Math.PI + i * TAU / count);
	let samples;
	if (shape === "electric") {
		samples = [];
		const teeth = count / 2;
		for (let k = 0; k < teeth; k++) {
			const a0 = -Math.PI + k * TAU / teeth;
			const a1 = a0 + TAU / teeth / 2;
			const inner = (a) => radius(a, 0);
			const outer = (a) => radius(a, 1);
			samples.push(at(center, a0, inner(a0)), at(center, a0 + 1e-6, outer(a0)), at(center, a1, outer(a1)), at(center, a1 + 1e-6, inner(a1)));
		}
	} else {
		const corners = angles.length - count;
		samples = angles.map((angle, index) => at(center, angle, radius(angle, Math.max(index - corners, 0))));
	}
	return {
		center,
		samples: dedupeSamples(samples)
	};
}
function at(center, angle, r) {
	return {
		angle: wrap(angle),
		point: [center[0] + Math.cos(angle) * r, center[1] + Math.sin(angle) * r]
	};
}
function dedupeSamples(samples) {
	const sorted = [...samples].sort((a, b) => a.angle - b.angle);
	return sorted.filter((s, i) => i === 0 || Math.hypot(s.point[0] - sorted[i - 1].point[0], s.point[1] - sorted[i - 1].point[1]) > 1e-6);
}
/** An imported outline, read as a star around its centroid. */
function customStar(points) {
	if (!points || points.length < 3) return null;
	const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
	const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
	const samples = points.map((point) => ({
		angle: Math.atan2(point[1] - cy, point[0] - cx),
		point
	}));
	return {
		center: [cx, cy],
		samples: dedupeSamples(samples)
	};
}
/** The plain outline stored with the line (what readers without the styles get). */
function storedOutline(line) {
	if (resolvedShape(line) === "custom") return line.balloon;
	const s = star(line);
	return s ? s.samples.map((sample) => sample.point) : void 0;
}
/** The box a line takes on the page with its balloon (without tails). */
function balloonExtent(line) {
	const s = star(line);
	if (!s?.samples.length) return line.box;
	const xs = s.samples.map((sample) => sample.point[0]);
	const ys = s.samples.map((sample) => sample.point[1]);
	return [
		Math.min(...xs, line.box[0]),
		Math.min(...ys, line.box[1]),
		Math.max(...xs, line.box[2]),
		Math.max(...ys, line.box[3])
	];
}
var MM_PER_PT = 25.4 / 72;
/** Gap between panels side by side (左右) and one above the other (上下). */
var DEFAULT_GUTTERS = {
	across: 2,
	down: 6
};
/** 縦スクロール: panels one above the other are far apart, as the strip is read scrolling. */
var SCROLL_GUTTERS = {
	across: 3,
	down: 24
};
/** The コマ間 new panels of the project get. */
function gutters(project) {
	return project.gutters ?? DEFAULT_GUTTERS;
}
/** A3 canvas, B4 trim and a 180 x 270 mm basic frame (same as the Rust default). */
function defaultPageFormat() {
	return {
		canvasMm: [297, 420],
		trimMm: [257, 364],
		basicMm: [180, 270],
		basicOffsetMm: [0, 0]
	};
}
/**
* 縦スクロール (Webtoon): one piece (区切り) of the strip, about two phone
* screens tall. The strip is not cut, so the trim is the whole piece; the
* basic frame keeps panels off its sides and apart across the pieces.
*/
function scrollPageFormat() {
	return {
		canvasMm: [120, 240],
		trimMm: [120, 240],
		basicMm: [108, 228],
		basicOffsetMm: [0, 0]
	};
}
function newProject(title, pageCount, kind = "right") {
	const project = {
		formatVersion: 2,
		title,
		author: "",
		binding: kind === "right" ? "right" : "left",
		pageFormat: kind === "scroll" ? scrollPageFormat() : defaultPageFormat(),
		pages: [],
		characters: [],
		scenes: [],
		emotions: [],
		brushes: [],
		nextId: 1
	};
	if (kind === "scroll") {
		project.scroll = true;
		project.gutters = { ...SCROLL_GUTTERS };
	}
	for (let i = 0; i < pageCount; i++) project.pages.push(emptyPage(newId(project, "page")));
	return project;
}
function emptyPage(id) {
	return {
		id,
		memo: "",
		panels: [],
		lines: [],
		strokes: [],
		roughs: [],
		breakouts: []
	};
}
/** Fill in fields the Rust side leaves out when they are empty. */
function normalize(project) {
	project.characters ??= [];
	project.scenes ??= [];
	project.emotions ??= [];
	project.author ??= "";
	project.brushes ??= [];
	for (const brush of project.brushes) {
		brush.kind ??= "pen";
		brush.opacity ??= 1;
		brush.hardness ??= 1;
		brush.stabilization ??= 0;
		brush.taperInMm ??= 0;
		brush.taperOutMm ??= 0;
		brush.thickness ??= 100;
		brush.rotation ??= 0;
	}
	const beforeShapes = (project.formatVersion ?? 1) < 2;
	const stored = [...(project.alternatives ?? []).flatMap((set) => set.options.flatMap((option) => option.pages ??= [])), ...(project.heldPages ?? []).flatMap((held) => held.pages ??= [])];
	for (const page of [...project.pages, ...stored]) {
		page.memo ??= "";
		page.panels ??= [];
		page.lines ??= [];
		page.strokes ??= [];
		page.roughs ??= [];
		page.breakouts ??= [];
		for (const line of page.lines) {
			line.kind ??= "speech";
			if (beforeShapes && !line.balloonShape && line.balloon && line.balloon.length !== 40 && line.balloon.length !== 4) line.balloonShape = "custom";
		}
	}
	for (const scene of project.scenes) scene.summary ??= "";
	for (const point of project.emotions) point.note ??= "";
	project.pageFormat.basicOffsetMm ??= [0, 0];
	project.formatVersion = Math.max(project.formatVersion ?? 2, 2);
	return project;
}
function newId(project, prefix) {
	return `${prefix}${project.nextId++}`;
}
function pageIndex(project, pageId) {
	return project.pages.findIndex((page) => page.id === pageId);
}
function insertPage(project, index) {
	const page = emptyPage(newId(project, "page"));
	project.pages.splice(Math.max(0, Math.min(index, project.pages.length)), 0, page);
	return page;
}
/** Remove a page with what refers to it: emotion values and scene ends. */
function removePage(project, pageId) {
	const index = pageIndex(project, pageId);
	if (index < 0) return;
	project.pages.splice(index, 1);
	project.emotions = project.emotions.filter((point) => point.page !== pageId);
	if (project.alternatives) {
		for (const set of project.alternatives) set.pageIds = set.pageIds.filter((id) => id !== pageId);
		project.alternatives = project.alternatives.filter((set) => set.pageIds.length);
		if (!project.alternatives.length) delete project.alternatives;
	}
	const neighbour = (forward) => {
		return ((forward ? project.pages[index] : project.pages[index - 1]) ?? project.pages[index - 1] ?? project.pages[index])?.id;
	};
	project.scenes = project.scenes.flatMap((scene) => {
		if (scene.firstPage === pageId) scene.firstPage = neighbour(true) ?? "";
		if (scene.lastPage === pageId) scene.lastPage = neighbour(false) ?? "";
		const first = pageIndex(project, scene.firstPage);
		const last = pageIndex(project, scene.lastPage);
		return first < 0 || last < 0 || first > last ? [] : [scene];
	});
}
function movePage(project, pageId, step) {
	const index = pageIndex(project, pageId);
	const target = index + step;
	if (index < 0 || target < 0 || target >= project.pages.length) return;
	const [page] = project.pages.splice(index, 1);
	project.pages.splice(target, 0, page);
	for (const scene of project.scenes) if (pageIndex(project, scene.firstPage) > pageIndex(project, scene.lastPage)) [scene.firstPage, scene.lastPage] = [scene.lastPage, scene.firstPage];
}
// src/domain/readingorder.ts
/**
* Reading order of panels in a right-bound book (same rule as the Rust
* import): rows top to bottom, a panel starts a new row when its top is below
* the current row's middle; right to left inside a row.
*/
function orderPanels(page, binding = "right") {
	const sorted = [...page.panels].sort((a, b) => bounds(a.shape)[1] - bounds(b.shape)[1]);
	const rows = /* @__PURE__ */ new Map();
	let row = 0;
	let rowMiddle = -Infinity;
	sorted.forEach((panel, index) => {
		const [, y0, , y1] = bounds(panel.shape);
		if (index > 0 && y0 >= rowMiddle) row++;
		if (index === 0 || y0 >= rowMiddle) rowMiddle = (y0 + y1) / 2;
		rows.set(panel, row);
	});
	const side = (panel) => binding === "right" ? -bounds(panel.shape)[2] : bounds(panel.shape)[0];
	sorted.sort((a, b) => rows.get(a) - rows.get(b) || side(a) - side(b));
	sorted.forEach((panel, index) => panel.order = index + 1);
	page.panels = sorted;
}
/** Give each line the panel its centre is in. */
function assignPanels(page) {
	const panels = [...page.panels].sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || a.order - b.order);
	for (const line of page.lines) {
		const center = boxCenter(line.box);
		const panel = panels.find((p) => insidePolygon(p.shape, center));
		if (panel) line.panel = panel.id;
		else delete line.panel;
	}
}
/**
* Reading order: by panel, then from the top right towards the bottom left
* (manga, right binding) or from the top left towards the bottom right (left binding).
*/
function sortLines(page, binding = "right") {
	const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
	const key = (line) => {
		const [cx, cy] = boxCenter(line.box);
		return {
			panel: line.panel ? order.get(line.panel) ?? Infinity : Infinity,
			diagonal: binding === "right" ? cy - cx : cy + cx
		};
	};
	page.lines.sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka.panel - kb.panel || ka.diagonal - kb.diagonal;
	});
}
// src/domain/pagebox.ts
function centred(format, size, offset) {
	const x0 = (format.canvasMm[0] - size[0]) / 2 + offset[0];
	const y0 = (format.canvasMm[1] - size[1]) / 2 + offset[1];
	return [
		x0,
		y0,
		x0 + size[0],
		y0 + size[1]
	];
}
function trimBox(format) {
	return centred(format, format.trimMm, [0, 0]);
}
function basicBox(format) {
	return centred(format, format.basicMm, format.basicOffsetMm);
}
// src/domain/strokes.ts
function fillShape(fill) {
	return {
		id: fill.id,
		shape: fill.shape.map((p) => [...p]),
		...fill.holes?.length ? { holes: fill.holes.map((hole) => hole.map((p) => [...p])) } : {}
	};
}
/** Put a fill where `map` takes each point of `from` (its outline and holes; none: the fill as it is). */
function mapFill(fill, map, from = fill) {
	fill.shape = from.shape.map(map);
	if (from.holes?.length) fill.holes = from.holes.map((hole) => hole.map(map));
}
// src/domain/panels.ts
function addPanel(project, page, shape) {
	const panel = {
		id: newId(project, "panel"),
		shape,
		order: page.panels.length + 1
	};
	page.panels.push(panel);
	orderPanels(page, project.binding);
	assignPanels(page);
	return panel;
}
/** Whether page `index` and the next one should go to CSP as one 見開き page. */
function wantsSpread(project, index) {
	if (project.scroll) return false;
	const page = project.pages[index];
	const next = project.pages[index + 1];
	if (!page || !next) return false;
	if (page.joinNext) return true;
	const shared = new Set(next.panels.map((panel) => panel.spread).filter(Boolean));
	return page.panels.some((panel) => panel.spread && shared.has(panel.spread));
}
/** The panel that owns a point: the topmost one there (insets over their panel). */
function ownerAt(page, point) {
	let owner;
	for (const panel of page.panels) {
		if (!insidePolygon(panel.shape, point)) continue;
		if (!owner || (panel.z ?? 0) > (owner.z ?? 0)) owner = panel;
	}
	return owner;
}
/** What a panel carries along: dialogue whose box centre and rough lines most of whose points are in it. */
function panelContents(page, panel) {
	const owns = (point) => ownerAt(page, point)?.id === panel.id;
	return {
		strokes: page.strokes.filter((stroke) => {
			const inside = stroke.points.filter(([x, y]) => owns([x, y])).length;
			return inside > 0 && inside >= stroke.points.length / 2;
		}).map((stroke) => stroke.id),
		lines: page.lines.filter((line) => owns(boxCenter(line.box))).map((line) => line.id)
	};
}
function carryContents(page, panel) {
	const { strokes, lines } = panelContents(page, panel);
	const owned = (page.fills ?? []).filter((fill) => ownerAt(page, centroid(fill.shape))?.id === panel.id);
	return {
		box: bounds(panel.shape),
		...owned.length ? { fills: owned.map(fillShape) } : {},
		strokes: page.strokes.filter((s) => strokes.includes(s.id)).map((s) => ({
			id: s.id,
			points: s.points.map((p) => [...p])
		})),
		lines: page.lines.filter((l) => lines.includes(l.id)).map((l) => ({
			id: l.id,
			box: [...l.box],
			...l.balloon ? { balloon: l.balloon.map((p) => [...p]) } : {},
			...l.tails ? { tails: l.tails.map((t) => [...t.tip]) } : {}
		}))
	};
}
/**
* Put the carried contents where the panel now is: positions follow the
* panel's box (moved, and stretched when a corner is dragged). Rough lines
* keep their proportions, scaled by the smaller stretch; dialogue keeps its
* size and moves with its centre. With `fit` "keep" the positions are not
* stretched either: everything scales alike and sits in the middle.
*/
function followPanel(page, panel, carried, fit = "stretch") {
	const [ox0, oy0, ox1, oy1] = carried.box;
	const [nx0, ny0, nx1, ny1] = bounds(panel.shape);
	let sx = ox1 > ox0 ? (nx1 - nx0) / (ox1 - ox0) : 1;
	let sy = oy1 > oy0 ? (ny1 - ny0) / (oy1 - oy0) : 1;
	const uniform = Math.min(sx, sy);
	let [ax, ay] = [nx0, ny0];
	if (fit === "keep") {
		[sx, sy] = [uniform, uniform];
		ax = (nx0 + nx1) / 2 - (ox1 - ox0) * uniform / 2;
		ay = (ny0 + ny1) / 2 - (oy1 - oy0) * uniform / 2;
	}
	const map = ([x, y]) => [ax + (x - ox0) * sx, ay + (y - oy0) * sy];
	for (const from of carried.fills ?? []) {
		const fill = page.fills?.find((f) => f.id === from.id);
		if (!fill) continue;
		const [cx0, cy0, cx1, cy1] = bounds(from.shape);
		const centre = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
		const [mx, my] = map(centre);
		mapFill(fill, ([x, y]) => [mx + (x - centre[0]) * uniform, my + (y - centre[1]) * uniform], from);
	}
	for (const { id, points } of carried.strokes) {
		const stroke = page.strokes.find((s) => s.id === id);
		if (!stroke) continue;
		const [cx0, cy0, cx1, cy1] = bounds(points.map(([x, y]) => [x, y]));
		const centre = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
		const [mx, my] = map(centre);
		stroke.points = points.map(([x, y, ...rest]) => [
			mx + (x - centre[0]) * uniform,
			my + (y - centre[1]) * uniform,
			...rest
		]);
	}
	for (const { id, box, balloon, tails } of carried.lines) {
		const line = page.lines.find((l) => l.id === id);
		if (!line) continue;
		const [mx, my] = map(boxCenter(box));
		const [cx, cy] = boxCenter(box);
		const [dx, dy] = [mx - cx, my - cy];
		line.box = [
			box[0] + dx,
			box[1] + dy,
			box[2] + dx,
			box[3] + dy
		];
		if (balloon) line.balloon = balloon.map(([x, y]) => [x + dx, y + dy]);
		if (tails && line.tails) line.tails.forEach((tail, i) => tails[i] && (tail.tip = map(tails[i])));
	}
}
// src/domain/autotail.ts
/** How far past the balloon a tail reaches (mm), at most. */
var REACH = 12;
/** Strokes this close (mm) belong to the same figure. */
var TOUCH = 4;
/** Speech that wants a tail: a balloon, no tail, not joined to another balloon. */
function wantsTail(page, line) {
	return line.kind === "speech" && resolvedShape(line) !== "none" && !line.tails?.length && !line.linkTo && !page.lines.some((other) => other.linkTo === line.id);
}
/** The figures drawn in a panel: boxes of strokes grouped where they touch, right to left. */
function figures(page, panel) {
	const ids = new Set(panelContents(page, panel).strokes);
	const boxes = page.strokes.filter((stroke) => ids.has(stroke.id)).map((stroke) => bounds(stroke.points.map(([x, y]) => [x, y])));
	const balloons = page.lines.filter((line) => line.panel === panel.id).map(balloonExtent);
	const free = boxes.filter((box) => !balloons.some((b) => contains(b, box)));
	const groups = [];
	for (const box of free) {
		let merged = box;
		for (let i = groups.length - 1; i >= 0; i--) if (touches(groups[i], merged)) {
			merged = union(groups[i], merged);
			groups.splice(i, 1);
		}
		groups.push(merged);
	}
	for (let changed = true; changed;) {
		changed = false;
		outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) if (touches(groups[i], groups[j])) {
			groups[i] = union(groups[i], groups[j]);
			groups.splice(j, 1);
			changed = true;
			break outer;
		}
	}
	return groups.filter(([x0, y0, x1, y1]) => Math.max(x1 - x0, y1 - y0) >= 6).sort((a, b) => b[2] + b[0] - (a[2] + a[0]));
}
function touches(a, b) {
	return a[0] - TOUCH <= b[2] && b[0] - TOUCH <= a[2] && a[1] - TOUCH <= b[3] && b[1] - TOUCH <= a[3];
}
function union(a, b) {
	return [
		Math.min(a[0], b[0]),
		Math.min(a[1], b[1]),
		Math.max(a[2], b[2]),
		Math.max(a[3], b[3])
	];
}
function contains(outer, inner) {
	return outer[0] <= inner[0] && outer[1] <= inner[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}
/** Where a figure's head is: the middle of its top part. */
function head([x0, y0, x1, y1]) {
	return [(x0 + x1) / 2, y0 + Math.min(12, (y1 - y0) * .15)];
}
/** The tip of a tail from `line` towards `target`: out of the balloon, at most REACH past it, short of the target. */
function tipTowards(line, target) {
	const box = balloonExtent(line);
	const [cx, cy] = boxCenter(box);
	let [dx, dy] = [target[0] - cx, target[1] - cy];
	const distance = Math.hypot(dx, dy);
	if (distance < 1e-6) [dx, dy] = [0, 1];
	else [dx, dy] = [dx / distance, dy / distance];
	const halfW = (box[2] - box[0]) / 2;
	const halfH = (box[3] - box[1]) / 2;
	const exit = Math.min(Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Infinity);
	const reach = Math.max(4, Math.min(REACH, distance - exit - 3));
	return [cx + dx * (exit + reach), cy + dy * (exit + reach)];
}
/** Down into the panel from the balloon, leaning towards the panel's middle. */
function fallbackTarget(line, panel) {
	const [cx, cy] = boxCenter(balloonExtent(line));
	if (!panel) return [cx - 4, cy + 40];
	const [mx] = centroid(panel.shape);
	const [, , , py1] = bounds(panel.shape);
	const target = [cx + (mx - cx) * .4, Math.max(cy + 20, py1 - 4)];
	return insidePolygon(panel.shape, target) ? target : [cx + (mx - cx) * .4, cy + 20];
}
/**
* Give every speech line on the page that has no tail one (see the top of
* the file). Returns how many tails were added.
*/
function addAutoTails(page, binding = "right") {
	let added = 0;
	const panels = new Map(page.panels.map((panel) => [panel.id, panel]));
	const byPanel = /* @__PURE__ */ new Map();
	for (const line of page.lines) {
		const key = line.panel ?? "";
		byPanel.set(key, [...byPanel.get(key) ?? [], line]);
	}
	for (const [panelId, lines] of byPanel) {
		const panel = panels.get(panelId);
		const found = panel ? figures(page, panel) : [];
		if (binding === "left") found.reverse();
		const order = [];
		for (const line of lines) if (line.kind === "speech" && !order.includes(line.speaker)) order.push(line.speaker);
		for (const line of lines) {
			if (!wantsTail(page, line)) continue;
			const earlier = lines.find((other) => other !== line && other.speaker && other.speaker === line.speaker && other.tails?.length);
			let target;
			if (earlier?.tails?.length) target = earlier.tails[0].tip;
			else if (found.length) target = head(found[order.indexOf(line.speaker) % found.length]);
			else target = fallbackTarget(line, panel);
			line.tails = [{
				tip: tipTowards(line, target),
				style: defaultTailStyle(line)
			}];
			added++;
		}
	}
	return added;
}
// src/domain/wrap.ts
/** Characters a line must not start with. */
var NO_START = /* @__PURE__ */ new Set([..."、。，．,.・：；:;！？!?‼⁉…‥ー〜～）)」』】〕］]｝}〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ゛゜ゝゞヽヾ々"]);
/** Characters a line must not end with. */
var NO_END = /* @__PURE__ */ new Set([..."（(「『【〔［[｛{〈《"]);
var PUNCTUATION = /* @__PURE__ */ new Set([..."、。，．,.！？!?‼⁉…‥"]);
/** Where one sentence ends and the next begins (after 。！？ and the like, and any closing marks). */
var SENTENCE = /(?<=[。！？!?‼⁉][。！？!?‼⁉」』）)…‥ー〜～]*)[\s　]*(?=[^\s　。、！？!?‼⁉」』）)…‥ー〜～])/u;
/** Particles and endings after which a line may break. */
var PARTICLES = /* @__PURE__ */ new Set([..."はがをにでともへやかねよなのわぞぜさ"]);
function scriptOf(char) {
	if (/[一-鿿㐀-䶿々〆]/.test(char)) return "kanji";
	if (/[ぁ-ゟ]/.test(char)) return "hiragana";
	if (/[゠-ヿｦ-ﾟ]/.test(char)) return "katakana";
	if (/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/.test(char)) return "latin";
	return "other";
}
/** How good a break is between `before` and `after` (higher is better; very low is not allowed). */
function breakScore(before, after) {
	if (NO_START.has(after) || NO_END.has(before)) return -100;
	if (before === " ") return 3;
	if (after === " ") return -5;
	if (PUNCTUATION.has(before)) return 6;
	const a = scriptOf(before);
	const b = scriptOf(after);
	if (a === b && (a === "katakana" || a === "latin")) return -20;
	if (a === "kanji" && b === "kanji") return -6;
	if (a === "kanji" && b === "hiragana") return -4;
	if (a === "hiragana" && PARTICLES.has(before) && b !== "hiragana") return 4;
	if (a === "hiragana" && b !== "hiragana") return 2.5;
	if (a === "hiragana" && PARTICLES.has(before)) return .5;
	if (a === "hiragana" && b === "hiragana") return -3;
	return 0;
}
/**
* Break `text` into lines of about `width` characters (each between a few
* fewer and a few more). Text that already has line breaks is left as it is.
*/
function wrapDialogue(text, width = 8) {
	if (text.includes("\n")) return text;
	const asked = text.split(/　+/).map((part) => part.trim()).filter(Boolean);
	if (asked.length > 1) return asked.map((part) => wrapDialogue(part, width)).join("\n");
	const sentences = text.split(SENTENCE).map((part) => part.trim()).filter(Boolean);
	if (sentences.length > 1) return sentences.map((part) => wrapDialogue(part, width)).join("\n");
	const chars = [...text];
	if (chars.length <= width + 1) return text;
	const lines = [];
	let start = 0;
	while (chars.length - start > width + 1) {
		const min = start + Math.max(2, width - 4);
		const max = Math.min(chars.length - 2, start + width + 3);
		let best = -1;
		let bestScore = -Infinity;
		for (let end = min; end <= max; end++) {
			const score = breakScore(chars[end - 1], chars[end]) - .6 * Math.abs(end - start - width);
			if (score > bestScore) {
				bestScore = score;
				best = end;
			}
		}
		if (bestScore < 0 && chars.length - start <= width + 4) break;
		if (chars.length - best <= 3 && chars.length - start <= width + 4) break;
		if (best < 0 || bestScore < -50) {
			best = Math.min(chars.length, start + width);
			while (best < chars.length && NO_START.has(chars[best])) best++;
		}
		lines.push(chars.slice(start, best).join(""));
		start = best;
	}
	if (start < chars.length) lines.push(chars.slice(start).join(""));
	return lines.map((line) => line.replace(/^ +| +$/g, "")).join("\n");
}
// src/domain/dialogue.ts
var KIND_LABELS = {
	speech: "セリフ",
	thought: "モノローグ",
	narration: "ナレーション",
	sfx: "描き文字",
	aside: "小書き"
};
var HALF_WIDTH = /[\u0020-\u007e\uff61-\uff9f]/;
/** How wide a half-width letter is, in full-width ones (for sans-serif Latin, a little over half). */
var HALF_WIDTH_EM = .6;
/** Text written mostly in half-width letters (English and the like). */
function mostlyHalfWidth(text) {
	const chars = [...text];
	return chars.filter((char) => HALF_WIDTH.test(char)).length * 2 > chars.length;
}
/** Size of a text block, in mm: vertical columns right to left, or horizontal rows. */
function textSize(text, fontSizePt, vertical) {
	const size = fontSizePt * MM_PER_PT;
	const rows = text.replace(/\r\n?/g, "\n").split("\n");
	const length = (row) => vertical ? [...row].length : [...row].reduce((sum, char) => sum + (HALF_WIDTH.test(char) ? HALF_WIDTH_EM : 1), 0);
	const longest = Math.max(1, ...rows.map(length));
	const across = size * (1 + (rows.length - 1) * linePitch());
	return vertical ? [across, longest * size] : [longest * size, across];
}
/** Resize a line's box around its centre to fit its text, and redo its balloon. */
function fitLine(line) {
	const [w, h] = textSize(line.text, line.fontSizePt, line.vertical);
	const [cx, cy] = boxCenter(line.box);
	const box = [
		cx - w / 2,
		cy - h / 2,
		cx + w / 2,
		cy + h / 2
	];
	if (line.balloonShape === "custom" && line.balloon) {
		const [ox, oy] = boxCenter(line.box);
		line.balloon = line.balloon.map(([x, y]) => [x + cx - ox, y + cy - oy]);
	}
	line.box = box;
	const balloon = storedOutline(line);
	if (balloon) line.balloon = balloon;
	else delete line.balloon;
}
/** New dialogue is written top to bottom in a manga (right binding), across in a left-bound book. */
function writesVertically(project) {
	return project.binding === "right";
}
function addLine(project, page, center, text = "セリフ", kind = "speech") {
	const line = {
		id: newId(project, "line"),
		text,
		kind,
		box: [
			center[0],
			center[1],
			center[0],
			center[1]
		],
		fontSizePt: defaultFontPt(kind, project.style),
		vertical: writesVertically(project)
	};
	const shape = project.lineShapes?.[kind];
	if (shape && shape !== "auto") line.balloonShape = shape;
	fitLine(line);
	page.lines.push(line);
	assignPanels(page);
	sortLines(page, project.binding);
	return line;
}
/** Change a line's kind; a balloon that had the old kind's usual shape takes the new kind's. */
function setLineKind(project, line, kind) {
	const usual = (k) => project.lineShapes?.[k] ?? "auto";
	if ((line.balloonShape ?? "auto") === usual(line.kind)) {
		const shape = usual(kind);
		if (shape === "auto") delete line.balloonShape;
		else line.balloonShape = shape;
	}
	line.kind = kind;
	fitLine(line);
}
/** Move a line with its balloon; tails keep pointing at their speakers. */
function moveLine(line, dx, dy) {
	const [x0, y0, x1, y1] = line.box;
	line.box = [
		x0 + dx,
		y0 + dy,
		x1 + dx,
		y1 + dy
	];
	if (line.balloon) line.balloon = line.balloon.map(([x, y]) => [x + dx, y + dy]);
}
/** Count of characters spoken per page, a rough measure of how text heavy it is. */
function textAmount(page) {
	return page.lines.reduce((sum, line) => sum + [...line.text.replace(/\s/g, "")].length, 0);
}
// src/domain/arrange.ts
var AS_IT_IS = {
	box: (box) => box,
	shape: (shape) => [...shape]
};
var MIRROR = {
	box: ([x0, y0, x1, y1]) => [
		-x1,
		y0,
		-x0,
		y1
	],
	shape: (shape) => shape.map(([x, y]) => [-x, y])
};
function mirrorLine(line) {
	line.box = MIRROR.box(line.box);
	if (line.balloon) line.balloon = MIRROR.shape(line.balloon);
	if (line.tails) line.tails = line.tails.map((tail) => ({
		...tail,
		tip: [-tail.tip[0], tail.tip[1]],
		...tail.bend !== void 0 ? { bend: -tail.bend } : {}
	}));
}
/**
* Run `lay` (a layout that reads right to left from the top right) for a
* book bound on `binding`: as it is for a manga, and for a left-bound book
* with `lines` mirrored (x → -x) so that it reads from the top left. What
* `lay` takes besides the lines (boxes, outlines, faces worked out before)
* goes through the flip it is given. The lines are mirrored back after and
* their balloons drawn again the right way round.
*/
function inReadingDirection(binding, lines, lay) {
	if (binding === "right") return lay(AS_IT_IS);
	for (const line of lines) mirrorLine(line);
	try {
		return lay(MIRROR);
	} finally {
		for (const line of lines) {
			mirrorLine(line);
			if (resolvedShape(line) === "custom") continue;
			const outline = storedOutline(line);
			if (outline) line.balloon = outline;
			else delete line.balloon;
		}
	}
}
var MARGIN = 3;
var GAP = 2;
/** Characters per line tried, widest first. */
var WIDTHS = [
	8,
	7,
	6,
	5,
	4,
	3
];
/** Across, the lines are longer, and wider ones make a lower balloon (Latin letters are narrow). */
var ACROSS_WIDTHS = [
	12,
	14,
	16,
	10,
	8
];
var LATIN_WIDTHS = [
	20,
	24,
	28,
	16,
	12
];
/** The line lengths (characters) to try for `line`, the usual first. */
function widthsFor(line, text) {
	if (line.vertical) return WIDTHS;
	return mostlyHalfWidth(text) ? LATIN_WIDTHS : ACROSS_WIDTHS;
}
/** A line's text without the breaks the app put in (words written in Latin letters keep their spaces). */
function unbroken$1(text) {
	return text.replace(/\n/g, mostlyHalfWidth(text) ? " " : "");
}
/** Where dialogue may go in a panel: its box, kept inside the basic frame (a 裁ち切り panel reaches past it). */
function placingBox(project, panel) {
	const frame = basicBox(project.pageFormat);
	if (!panel) return frame;
	const [x0, y0, x1, y1] = bounds(panel.shape);
	const inside = [
		Math.max(x0, frame[0]),
		Math.max(y0, frame[1]),
		Math.min(x1, frame[2]),
		Math.min(y1, frame[3])
	];
	return inside[2] - inside[0] > 10 && inside[3] - inside[1] > 10 ? inside : [
		x0,
		y0,
		x1,
		y1
	];
}
/** How much smaller (pt) text may get to fit a short panel. */
var SMALLER_PT = 2;
/**
* Break a long line that has no breaks of its own, narrower until its
* balloon fits `height`; when even the narrowest does not, a little smaller
* text, and failing that the shortest it can be.
*/
function wrapToFit(line, height) {
	if (line.kind === "sfx" || line.text.includes("\n")) return;
	const original = line.text;
	const size = line.fontSizePt;
	let best = null;
	for (let pt = size; pt >= size - SMALLER_PT; pt--) {
		line.fontSizePt = pt;
		for (const width of widthsFor(line, original)) {
			line.text = wrapDialogue(original, width);
			fitLine(line);
			const [, y0, , y1] = balloonExtent(line);
			if (y1 - y0 <= height) return;
			if (!best || y1 - y0 < best.height - .5) best = {
				text: line.text,
				pt,
				height: y1 - y0
			};
		}
	}
	if (!best) return;
	line.text = best.text;
	line.fontSizePt = best.pt;
	fitLine(line);
}
/**
* Lay `lines` out over `box` in reading order: right to left, a new row below
* when one is full; a full panel piles them at its bottom, still inside.
* With `shape`, a line whose centre would fall outside it is pulled in, so
* that it stays in its panel.
*/
function layOut(lines, box, shape, wrap = true, avoid = []) {
	const height = box[3] - box[1] - 6;
	let right = box[2] - MARGIN;
	let top = box[1] + MARGIN;
	let rowHeight = 0;
	for (const line of lines) {
		if (wrap) wrapToFit(line, height);
		const [lx0, ly0, lx1, ly1] = balloonExtent(line);
		const [w, h] = [lx1 - lx0, ly1 - ly0];
		if (right - w < box[0] + MARGIN && rowHeight > 0) {
			right = box[2] - MARGIN;
			top += rowHeight + GAP;
			rowHeight = 0;
		}
		let y = Math.max(box[1], Math.min(top, box[3] - MARGIN - h));
		let [ex0, ey0, width] = [
			lx0,
			ly0,
			w
		];
		if (avoid.length) {
			let place = clearOf(avoid, box, right, y, w, h);
			if (place.covered >= 1 && wrap) {
				let text = line.text;
				for (const other of rewraps(line, height)) {
					line.text = other;
					fitLine(line);
					const [cx0, cy0, cx1, cy1] = balloonExtent(line);
					const top = Math.max(box[1], Math.min(y, box[3] - MARGIN - (cy1 - cy0)));
					const tried = clearOf(avoid, box, right, top, cx1 - cx0, cy1 - cy0);
					if (tried.cost < place.cost - 1) [place, text] = [tried, other];
				}
				line.text = text;
				fitLine(line);
				const extent = balloonExtent(line);
				[ex0, ey0, width] = [
					extent[0],
					extent[1],
					extent[2] - extent[0]
				];
			}
			[right, y] = [place.right, place.top];
		}
		moveLine(line, right - width - ex0, y - ey0);
		if (shape) slideInside(line, shape, box, avoid);
		const placed = balloonExtent(line);
		right = placed[0] - GAP;
		rowHeight = Math.max(rowHeight, placed[3] - top);
		if (shape) pullInside(line, shape);
	}
}
/**
* Where a w×h balloon whose top right is (right, y) best keeps off the faces:
* moved left past a face or down below it, as little as it takes, or where it
* covers the least of them when there is no room to keep clear.
*/
function clearOf(avoid, box, right, y, w, h) {
	const covered = (r, top) => avoid.reduce((sum, [x0, y0, x1, y1]) => sum + Math.max(0, Math.min(r, x1) - Math.max(r - w, x0)) * Math.max(0, Math.min(top + h, y1) - Math.max(top, y0)), 0);
	const [minRight, maxY] = [Math.min(right, box[0] + MARGIN + w), Math.max(y, box[3] - MARGIN - h)];
	const rights = [right, ...avoid.map((b) => Math.max(minRight, Math.min(right, b[0] - GAP)))];
	const tops = [y, ...avoid.map((b) => Math.min(maxY, Math.max(y, b[3] + GAP)))];
	let best = {
		right,
		top: y,
		covered: covered(right, y),
		cost: covered(right, y) * COVER_COST
	};
	if (!best.cost) return best;
	for (const r of rights) for (const top of tops) {
		const area = covered(r, top);
		const cost = area * COVER_COST + (right - r) + (top - y);
		if (cost < best.cost) best = {
			right: r,
			top,
			covered: area,
			cost
		};
	}
	return best;
}
/** What one mm² over a face costs against one mm moved. */
var COVER_COST = 10;
/**
* Other ways to break a line the app broke itself (a line broken by hand is
* kept as it is), that fit `height`.
*/
function rewraps(line, height) {
	if (line.kind === "sfx") return [];
	const joined = unbroken$1(line.text);
	const own = [...widthsFor(line, joined), ...line.vertical ? [
		9,
		10,
		12
	] : []].map((width) => wrapDialogue(joined, width));
	if (line.text.includes("\n") && !own.includes(line.text)) return [];
	const original = line.text;
	const fits = [...new Set(own)].filter((text) => {
		if (text === original) return false;
		line.text = text;
		fitLine(line);
		const [, y0, , y1] = balloonExtent(line);
		return y1 - y0 <= height;
	});
	line.text = original;
	fitLine(line);
	return fits;
}
/**
* When `line`'s balloon reaches past the panel's border (a slanted panel
* narrows towards one end), move it along the row and up or down, as little
* as it takes, to where it is inside, no more over a face than it was.
*/
function slideInside(line, shape, box, avoid) {
	const extent = balloonExtent(line);
	if (!spills(extent, shape)) return;
	const [x0, y0, x1, y1] = extent;
	const covered = (dx, dy) => avoid.reduce((sum, [ax0, ay0, ax1, ay1]) => sum + Math.max(0, Math.min(x1 + dx, ax1) - Math.max(x0 + dx, ax0)) * Math.max(0, Math.min(y1 + dy, ay1) - Math.max(y0 + dy, ay0)), 0);
	const now = covered(0, 0);
	let best = null;
	for (let dx = 0; x0 - dx >= box[0] - SPILL_MM; dx += 1) {
		if (best && dx >= best.cost) break;
		for (let dy = -10; dy <= 10; dy += 1) {
			const cost = dx + Math.abs(dy);
			if (best && cost >= best.cost) continue;
			if (spills([
				x0 - dx,
				y0 + dy,
				x1 - dx,
				y1 + dy
			], shape) || covered(-dx, dy) > now) continue;
			best = {
				dx,
				dy,
				cost
			};
		}
	}
	if (best) moveLine(line, -best.dx, best.dy);
}
/** Move `line` as little as it takes off `avoid` (faces, other balloons), inside `box`. */
function moveClear(line, box, avoid) {
	const [x0, y0, x1, y1] = balloonExtent(line);
	const { right, top } = clearOf(avoid, box, x1, y0, x1 - x0, y1 - y0);
	moveLine(line, right - x1, top - y0);
}
/** The faces in a panel's rough: the top of each figure, where a balloon should not go. */
function faces(page, panel) {
	return figures(page, panel).map(([x0, y0, x1, y1]) => {
		const size = Math.min(12, (y1 - y0) * .15) + 2;
		const cx = (x0 + x1) / 2;
		return [
			Math.max(x0, cx - size),
			y0,
			Math.min(x1, cx + size),
			y0 + 2 * size
		];
	});
}
/** Move `line` towards the middle of `shape` until its centre is inside it. */
function pullInside(line, shape) {
	const target = centroid(shape);
	for (let step = 0; step < 20 && !insidePolygon(shape, boxCenter(line.box)); step++) {
		const [cx, cy] = boxCenter(line.box);
		moveLine(line, (target[0] - cx) * .2, (target[1] - cy) * .2);
	}
}
/** How far (mm) a balloon may reach over its panel's border before it counts. */
var SPILL_MM = 2;
/** Whether a balloon (its box) reaches past a panel's border by more than a touch. */
function spills(box, shape) {
	const [x0, y0, x1, y1] = box;
	const inset = (x, y) => [x + Math.sign((x0 + x1) / 2 - x) * SPILL_MM, y + Math.sign((y0 + y1) / 2 - y) * SPILL_MM];
	return [
		inset(x0, y0),
		inset(x1, y0),
		inset(x1, y1),
		inset(x0, y1)
	].some((corner) => !insidePolygon(shape, corner));
}
/** How much of a face (mm²) a balloon may cover before it counts: about a corner of it. */
var FACE_MM2 = 8;
/** Whether `line`'s balloon covers a face in its panel's rough (sound effects may). */
function onFace(page, line) {
	const panel = page.panels.find((p) => p.id === line.panel);
	if (!panel || line.kind === "sfx") return false;
	const [x0, y0, x1, y1] = balloonExtent(line);
	return faces(page, panel).some((face) => Math.max(0, Math.min(x1, face[2]) - Math.max(x0, face[0])) * Math.max(0, Math.min(y1, face[3]) - Math.max(y0, face[1])) > FACE_MM2);
}
/** このコマのセリフを並べ直す: the panel's dialogue in its reading order. Returns how many lines moved. */
function arrangePanel(project, page, panel) {
	sortLines(page, project.binding);
	const lines = page.lines.filter((line) => line.panel === panel.id);
	if (!lines.length) return 0;
	const [box, avoid] = [placingBox(project, panel), faces(page, panel)];
	inReadingDirection(project.binding, lines, (flip) => layOut(lines, flip.box(box), flip.shape(panel.shape), true, avoid.map(flip.box)));
	assignPanels(page);
	sortLines(page, project.binding);
	return lines.length;
}
/** このページのセリフを並べ直す: every panel's. Returns how many lines moved. */
function arrangePage(project, page) {
	assignPanels(page);
	return [...page.panels].sort((a, b) => a.order - b.order).reduce((sum, panel) => sum + arrangePanel(project, page, panel), 0);
}
// src/domain/koma.ts
var BORDER_LABELS = {
	solid: "実線",
	thick: "太枠",
	none: "枠なし",
	dashed: "破線（回想・空想）",
	wavy: "波線（夢・ゆらぎ）"
};
var FILL_LABELS = {
	none: "なし",
	white: "白（下のコマを隠す）",
	black: "ベタ（回想・暗転）",
	gray: "グレー（トーン）"
};
var EFFECT_LABELS = {
	none: "なし",
	speed: "流線（動き）",
	focus: "集中線（驚き・注目）",
	flash: "ウニフラ（衝撃・動揺）",
	sparkle: "キラキラ（好意・華やぎ）"
};
var ON_EDGE = .05;
/** Whether a page point lies on that side of the canvas edge. */
function onCanvasSide([x, y], side, format) {
	const [w, h] = format.canvasMm;
	switch (side) {
		case "top": return y <= ON_EDGE;
		case "bottom": return y >= h - ON_EDGE;
		case "left": return x <= ON_EDGE;
		case "right": return x >= w - ON_EDGE;
	}
}
/**
* 裁ち切り on or off for one side: the panel's corners on that side move out
* to the canvas edge (past the trim) and the edge there is left open, or back
* to the basic frame.
*/
function bleedPanel(panel, side, format, on) {
	const [w, h] = format.canvasMm;
	const basic = basicBox(format);
	const [x0, y0, x1, y1] = bounds(panel.shape);
	const vertical = side === "top" || side === "bottom";
	const extreme = {
		top: y0,
		bottom: y1,
		left: x0,
		right: x1
	}[side];
	const target = on ? {
		top: 0,
		bottom: h,
		left: 0,
		right: w
	}[side] : {
		top: basic[1],
		bottom: basic[3],
		left: basic[0],
		right: basic[2]
	}[side];
	const tolerance = 1;
	const before = edgesAlong(panel.shape, side, format);
	panel.shape = panel.shape.map((point) => {
		const value = vertical ? point[1] : point[0];
		if (Math.abs(value - extreme) > tolerance) return point;
		return vertical ? [point[0], target] : [target, point[1]];
	});
	const open = new Set(panel.openEdges ?? []);
	if (on) for (const i of edgesAlong(panel.shape, side, format)) open.add(i);
	else for (const i of before) open.delete(i);
	if (open.size) panel.openEdges = [...open].sort((x, y) => x - y);
	else delete panel.openEdges;
}
/** Edges lying on that side of the canvas edge. */
function edgesAlong(shape, side, format) {
	const result = [];
	for (let i = 0; i < shape.length; i++) if (onCanvasSide(shape[i], side, format) && onCanvasSide(shape[(i + 1) % shape.length], side, format)) result.push(i);
	return result;
}
/**
* Page patterns seen in ユメノストラ 1–3 (and common in manga generally).
* Rows run top to bottom; cells right to left (right-bound books; a
* left-bound book gets them mirrored).
*/
var PATTERNS = [
	{
		id: "basic4",
		label: "基本の4段",
		note: "横長と2分割を交互に。会話の続くページの土台。",
		rows: [
			{
				weight: 1,
				cells: [1, 1.3]
			},
			{
				weight: 1,
				cells: [1]
			},
			{
				weight: 1,
				cells: [1.4, 1]
			},
			{
				weight: 1,
				cells: [1]
			}
		]
	},
	{
		id: "three",
		label: "3段（2・1・2）",
		note: "中段を見せ場に。",
		rows: [
			{
				weight: 1,
				cells: [1, 1]
			},
			{
				weight: 1.3,
				cells: [1]
			},
			{
				weight: 1,
				cells: [1, 1.2]
			}
		]
	},
	{
		id: "opening",
		label: "導入（上を裁ち切り）",
		note: "場面の始まりに、上いっぱいの風景で場所を見せる。",
		rows: [
			{
				weight: 1.1,
				cells: [1]
			},
			{
				weight: 1,
				cells: [1, 1.4]
			},
			{
				weight: 1,
				cells: [1]
			},
			{
				weight: 1,
				cells: [1.3, 1]
			}
		],
		bleed: { first: [
			"top",
			"left",
			"right"
		] }
	},
	{
		id: "bigInset",
		label: "大ゴマ＋はめ込み",
		note: "決めの大ゴマに、反応の小ゴマを重ねる。",
		rows: [{
			weight: 1,
			cells: [1, 1]
		}, {
			weight: 2.4,
			cells: [1]
		}],
		bleed: { last: ["bottom", "left"] },
		inset: 1
	},
	{
		id: "action",
		label: "斜めの間白（アクション）",
		note: "傾いた間白で勢いを出す。動きの向きに傾ける。",
		rows: [
			{
				weight: 1,
				cells: [1, 1.2],
				lean: 10,
				tilt: 8
			},
			{
				weight: 1.5,
				cells: [1],
				tilt: -10
			},
			{
				weight: 1,
				cells: [
					1,
					1,
					1
				],
				lean: -8
			}
		]
	},
	{
		id: "sequence",
		label: "縦長の連続（動きのコマ送り）",
		note: "細長いコマを3つ並べて一連の動きを見せる。",
		rows: [
			{
				weight: 1.5,
				cells: [
					1,
					1,
					1
				],
				lean: 6
			},
			{
				weight: 1,
				cells: [1]
			},
			{
				weight: 1,
				cells: [1, 1]
			}
		]
	},
	{
		id: "pause",
		label: "間（細い空コマ）",
		note: "細いコマを挟んで沈黙や時間の経過を置く。",
		rows: [
			{
				weight: 1,
				cells: [1, 1]
			},
			{
				weight: .16,
				cells: [1]
			},
			{
				weight: 1.2,
				cells: [1]
			},
			{
				weight: 1,
				cells: [1, 1.3]
			}
		]
	},
	{
		id: "flashback",
		label: "回想の帯（ベタと交互）",
		note: "傾いた横長の帯を重ね、ベタの帯に言葉だけを置く。",
		rows: [
			{
				weight: 1,
				cells: [1],
				tilt: -4,
				black: [0]
			},
			{
				weight: .6,
				cells: [1],
				tilt: 4
			},
			{
				weight: 1,
				cells: [1],
				tilt: -4,
				black: [0]
			},
			{
				weight: .6,
				cells: [1],
				tilt: 4
			},
			{
				weight: 1,
				cells: [1],
				black: [0]
			}
		]
	},
	{
		id: "splash",
		label: "1ページ大ゴマ（全面裁ち切り）",
		note: "扉や山場の一枚絵。",
		rows: [{
			weight: 1,
			cells: [1]
		}],
		bleed: { all: [
			"top",
			"bottom",
			"left",
			"right"
		] }
	}
];
/** How many panels a pattern makes (with its inset). */
function patternCount(patternId) {
	const pattern = PATTERNS.find((p) => p.id === patternId);
	return pattern ? pattern.rows.reduce((sum, row) => sum + row.cells.length, 0) + (pattern.inset !== void 0 ? 1 : 0) : 0;
}
/** Rows thin enough to be a pause: never split nor joined. */
var PAUSE_WEIGHT = .3;
var MOST_ACROSS = 3;
/**
* The pattern made to have `count` panels, keeping its look: fewer by joining
* the cells of the busiest row (then dropping the inset, then joining rows),
* more by splitting the tallest row with the fewest cells (up to three across,
* then a new row at the bottom).
*/
function fitPattern(pattern, count) {
	const rows = pattern.rows.map((row) => ({
		...row,
		cells: [...row.cells],
		...row.black ? { black: [...row.black] } : {}
	}));
	let inset = pattern.inset;
	const total = () => rows.reduce((sum, row) => sum + row.cells.length, 0) + (inset !== void 0 ? 1 : 0);
	const want = Math.max(1, Math.round(count));
	while (total() > want) {
		const busy = rows.map((row, index) => ({
			row,
			index
		})).filter(({ row }) => row.cells.length > 1).sort((a, b) => b.row.cells.length - a.row.cells.length || b.index - a.index)[0];
		if (busy) {
			const cells = busy.row.cells;
			cells.splice(cells.length - 2, 2, cells[cells.length - 2] + cells[cells.length - 1]);
			busy.row.black = busy.row.black?.filter((c) => c < cells.length);
			continue;
		}
		if (inset !== void 0) {
			inset = void 0;
			continue;
		}
		if (rows.length < 2) break;
		const thin = rows.reduce((best, row, index) => row.weight < rows[best].weight ? index : best, rows.length - 1);
		const into = thin > 0 ? thin - 1 : 1;
		rows[into].weight += rows[thin].weight;
		rows.splice(thin, 1);
	}
	while (total() < want) {
		const open = rows.map((row, index) => ({
			row,
			index
		})).filter(({ row, index }) => row.weight >= PAUSE_WEIGHT && row.cells.length < MOST_ACROSS && index !== inset && !row.black?.length);
		open.sort((a, b) => a.row.cells.length - b.row.cells.length || b.row.weight - a.row.weight || a.index - b.index);
		if (open.length) {
			open[0].row.cells.push(1);
			continue;
		}
		rows.push({
			weight: 1,
			cells: want - total() > 1 ? [1, 1] : [1]
		});
	}
	return {
		...pattern,
		rows,
		inset
	};
}
/**
* Panels of a pattern on the page's basic frame (not yet added to the page).
* With `count`, made to have that many panels ({@link fitPattern}).
*/
function patternPanels(project, patternId, gaps = gutters(project), count) {
	const found = PATTERNS.find((p) => p.id === patternId);
	if (!found) return [];
	const pattern = count && count !== patternCount(patternId) ? fitPattern(found, count) : found;
	const format = project.pageFormat;
	const [bx0, by0, bx1, by1] = basicBox(format);
	const total = pattern.rows.reduce((sum, row) => sum + row.weight, 0);
	const height = by1 - by0 - gaps.down * (pattern.rows.length - 1);
	const cuts = [];
	let y = by0;
	pattern.rows.forEach((row, index) => {
		y += height * row.weight / total;
		if (index < pattern.rows.length - 1) {
			const tilt = row.tilt ?? 0;
			cuts.push({
				left: y + tilt / 2,
				right: y - tilt / 2
			});
			y += gaps.down;
		}
	});
	const lineY = (line, x) => line.left + (line.right - line.left) * (x - bx0) / (bx1 - bx0);
	const panels = [];
	pattern.rows.forEach((row, r) => {
		const top = r === 0 ? {
			left: by0,
			right: by0
		} : {
			left: cuts[r - 1].left + gaps.down,
			right: cuts[r - 1].right + gaps.down
		};
		const bottom = r === pattern.rows.length - 1 ? {
			left: by1,
			right: by1
		} : cuts[r];
		const sum = row.cells.reduce((s, c) => s + c, 0);
		const width = bx1 - bx0 - gaps.across * (row.cells.length - 1);
		let right = bx1;
		row.cells.forEach((weight, c) => {
			const left = c === row.cells.length - 1 ? bx0 : right - width * weight / sum;
			const lean = row.lean ?? 0;
			const leanRight = c === 0 ? 0 : lean / 2;
			const leanLeft = c === row.cells.length - 1 ? 0 : lean / 2;
			const shape = [
				[right + leanRight, lineY(top, right + leanRight)],
				[right - leanRight, lineY(bottom, right - leanRight)],
				[left - leanLeft, lineY(bottom, left - leanLeft)],
				[left + leanLeft, lineY(top, left + leanLeft)]
			];
			const panel = {
				id: newId(project, "panel"),
				shape,
				order: 0
			};
			if (row.black?.includes(c)) panel.fill = "black";
			panels.push(panel);
			right = left - gaps.across;
		});
	});
	const mirrored = project.binding === "left";
	if (mirrored) for (const panel of panels) panel.shape = panel.shape.map(([x, y]) => [bx0 + bx1 - x, y]).reverse();
	const sideOf = (side) => !mirrored ? side : side === "left" ? "right" : side === "right" ? "left" : side;
	const firstRow = panels.slice(0, pattern.rows[0].cells.length);
	const lastRow = panels.slice(panels.length - pattern.rows[pattern.rows.length - 1].cells.length);
	const bleedAll = (list, sides) => {
		for (const panel of list) for (const side of (sides ?? []).map(sideOf)) {
			const [x0, y0, x1, y1] = bounds(panel.shape);
			if ({
				top: Math.abs(y0 - by0) < 1,
				bottom: Math.abs(y1 - by1) < 1,
				left: Math.abs(x0 - bx0) < 1,
				right: Math.abs(x1 - bx1) < 1
			}[side]) bleedPanel(panel, side, format, true);
		}
	};
	bleedAll(firstRow, pattern.bleed?.first);
	bleedAll(lastRow, pattern.bleed?.last);
	bleedAll(panels, pattern.bleed?.all);
	if (pattern.inset !== void 0) {
		const parent = panels[pattern.rows.slice(0, pattern.inset).reduce((s, row) => s + row.cells.length, 0)];
		const [x0, , , y1] = bounds(parent.shape);
		const [, , , fy1] = basicBox(format);
		const [px0, py0, px1, py1] = bounds(parent.shape);
		const w = (px1 - px0) * .36;
		const h = (py1 - py0) * .3;
		const left = mirrored ? Math.min(px1, bx1) - 4 - w : Math.max(x0, bx0) + 4;
		const bottom = Math.min(y1, fy1) - 4;
		panels.push({
			id: newId(project, "panel"),
			shape: rectShape([
				left,
				bottom - h,
				left + w,
				bottom
			]),
			order: 0,
			fill: "white",
			z: 1
		});
	}
	return panels;
}
/** Replace the page's panels with `panels`, what was in the old ones going along as `applyPattern` says. */
function replacePanels(project, page, panels) {
	const before = [...page.panels].sort((a, b) => a.order - b.order).map((panel) => ({
		note: panel.note,
		carried: carryContents(page, panel)
	}));
	page.panels = panels;
	orderPanels(page, project.binding);
	const after = [...page.panels].sort((a, b) => a.order - b.order);
	const shared = /* @__PURE__ */ new Map();
	before.forEach(({ note, carried }, k) => {
		const panel = after[Math.min(k, after.length - 1)];
		if (!panel) return;
		followPanel(page, panel, carried);
		if (note) panel.note = [panel.note, note].filter(Boolean).join("\n");
		shared.set(panel, (shared.get(panel) ?? 0) + 1);
	});
	assignPanels(page);
	for (const [panel, count] of shared) if (count > 1) arrangePanel(project, page, panel);
	sortLines(page, project.binding);
}
// src/domain/cast.ts
/** Categorical colours in a fixed order, checked for colour-blind separation. */
var PALETTE = [
	"#2a78d6",
	"#eb6834",
	"#1baf7a",
	"#eda100",
	"#e87ba4",
	"#008300",
	"#6250d6",
	"#e34948"
];
function addCharacter(project, name) {
	const character = {
		id: newId(project, "character"),
		name,
		color: PALETTE[project.characters.length % PALETTE.length]
	};
	project.characters.push(character);
	return character;
}
/** Set (or with `null`, clear) how a character feels at a page. */
function setEmotion(project, characterId, pageId, value, note) {
	const existing = project.emotions.find((point) => point.character === characterId && point.page === pageId);
	if (value === null) {
		project.emotions = project.emotions.filter((point) => point !== existing);
		return;
	}
	const clamped = Math.max(-1, Math.min(1, value));
	if (existing) {
		existing.value = clamped;
		if (note !== void 0) existing.note = note;
	} else project.emotions.push({
		character: characterId,
		page: pageId,
		value: clamped,
		note: note ?? ""
	});
}
function addScene(project, firstPage, lastPage, title) {
	const scene = {
		id: newId(project, "scene"),
		title,
		summary: "",
		firstPage,
		lastPage
	};
	project.scenes.push(scene);
	sortScenes(project);
	return scene;
}
/**
* A scene over pages `first`..`last` (0-based) that takes the place of the
* scenes it overlaps; a scene it replaces over the very same pages hands on
* its summary when the new one has none. Returns the scene and how many it replaced.
*/
function putScene(project, first, last, title, summary = "") {
	let kept = "";
	let replaced = 0;
	project.scenes = project.scenes.filter((s) => {
		const [a, b] = [pageIndex(project, s.firstPage), pageIndex(project, s.lastPage)];
		if (b < first || a > last) return true;
		if (a === first && b === last) kept = s.summary;
		if (!(a === first && b === last && s.title === title)) replaced++;
		return false;
	});
	const scene = addScene(project, project.pages[first].id, project.pages[last].id, title);
	scene.summary = summary || kept;
	return {
		scene,
		replaced
	};
}
function sortScenes(project) {
	project.scenes.sort((a, b) => pageIndex(project, a.firstPage) - pageIndex(project, b.firstPage));
}
// src/domain/alternatives.ts
/** The 別案 set that holds a page in use, if any. */
function alternativesOf(project, pageId) {
	return project.alternatives?.find((set) => set.pageIds.includes(pageId));
}
/** A page added next to a page of a set's option in use becomes part of that option. */
function joinAlternative(project, pageId, besideId, after) {
	const set = alternativesOf(project, besideId);
	if (!set || set.pageIds.includes(pageId)) return;
	const at = set.pageIds.indexOf(besideId);
	set.pageIds.splice(after ? at + 1 : at, 0, pageId);
}
// src/domain/reorder.ts
/** The pages that move with page `index`: it and its 見開き partner, as first and last index. */
function pageBlock(project, index) {
	let [first, last] = [index, index];
	if (wantsSpread(project, index)) last = index + 1;
	else if (index > 0 && wantsSpread(project, index - 1)) first = index - 1;
	return [first, last];
}
// src/domain/pageops.ts
/** Where pages go in front of (`after` false) or behind page `index`, not between the halves of a 見開き. */
function insertionPoint(project, index, after) {
	if (!project.pages.length) return 0;
	const [first, last] = pageBlock(project, Math.max(0, Math.min(index, project.pages.length - 1)));
	return after ? last + 1 : first;
}
/**
* New pages put beside page `besideId` (in front of it or behind it) belong
* where it does: to its scene when they land at the scene's end, and to its
* 別案 when it is in one.
*/
function belongBeside(project, besideId, added, after) {
	if (!added.length) return;
	for (const scene of project.scenes) {
		if (after && scene.lastPage === besideId) scene.lastPage = added[added.length - 1].id;
		if (!after && scene.firstPage === besideId) scene.firstPage = added[0].id;
	}
	if (alternativesOf(project, besideId)) {
		if (after) {
			let previous = besideId;
			for (const page of added) {
				joinAlternative(project, page.id, previous, true);
				previous = page.id;
			}
		} else for (const page of added) joinAlternative(project, page.id, besideId, false);
	}
}
/**
* `count` blank pages in front of (`after` false) or behind page `index`;
* a 見開き is not split, the pages go before or after the pair. Returns the
* new pages.
*/
function insertBlankPages(project, index, after, count = 1) {
	const n = Math.max(1, Math.min(100, Math.round(count) || 1));
	const at = insertionPoint(project, index, after);
	const beside = project.pages[after ? at - 1 : at];
	const added = [];
	for (let i = 0; i < n; i++) added.push(insertPage(project, at + i));
	if (beside) belongBeside(project, beside.id, added, after);
	return added;
}
/** The page before the first index of `gone`, nearest, not in `gone`; none at the front. */
function pageBefore(project, index, gone) {
	for (let i = index - 1; i >= 0; i--) if (!gone.has(project.pages[i].id)) return project.pages[i].id;
}
function pageAfter(project, index, gone) {
	for (let i = index + 1; i < project.pages.length; i++) if (!gone.has(project.pages[i].id)) return project.pages[i].id;
}
/**
* Before pages `gone` leave the name: what stays stops pointing at them. A
* page that joined one of them as its 見開き joins nothing; a panel across
* the gutter whose other half leaves becomes an ordinary panel (on either
* side, unless both halves leave together); 保留コマ meant for them move to
* the nearest page that stays; 保留のページ that came after one of them
* come after the page before it.
*/
function letGo(project, gone) {
	const pages = project.pages;
	pages.forEach((page, index) => {
		const next = pages[index + 1];
		if (page.joinNext && next && gone.has(next.id) !== gone.has(page.id)) delete page.joinNext;
		if (page.joinNext && !next) delete page.joinNext;
	});
	const sides = /* @__PURE__ */ new Map();
	for (const page of pages) for (const panel of page.panels) {
		if (!panel.spread) continue;
		const side = sides.get(panel.spread) ?? {
			going: false,
			staying: false
		};
		if (gone.has(page.id)) side.going = true;
		else side.staying = true;
		sides.set(panel.spread, side);
	}
	for (const page of pages) for (const panel of page.panels) {
		const side = panel.spread ? sides.get(panel.spread) : void 0;
		if (side?.going && side.staying) delete panel.spread;
	}
	const nearest = (id) => {
		const index = pageIndex(project, id);
		return pageBefore(project, index, gone) ?? pageAfter(project, index, gone);
	};
	for (const held of project.held ?? []) {
		if (held.near && gone.has(held.near)) {
			const near = nearest(held.near);
			if (near) held.near = near;
			else {
				delete held.near;
				delete held.at;
			}
		}
		if (held.from && gone.has(held.from)) delete held.from;
	}
	for (const held of project.heldPages ?? []) if (held.after && gone.has(held.after)) {
		const before = pageBefore(project, pageIndex(project, held.after), gone);
		if (before) held.after = before;
		else delete held.after;
	}
}
/** Why pages cannot be taken out, or null when they can. */
function cannotRemove(project, ids) {
	const gone = new Set(ids.filter((id) => pageIndex(project, id) >= 0));
	if (!gone.size) return "ページが選ばれていません";
	if (gone.size >= project.pages.length) return "ページは 1 枚は残します";
	return null;
}
/** Delete pages (with what refers only to them); false when they cannot go (see `cannotRemove`). */
function deletePages(project, ids) {
	if (cannotRemove(project, ids)) return false;
	letGo(project, new Set(ids));
	for (const id of ids) removePage(project, id);
	return true;
}
// src/domain/scriptimport.ts
var NARRATION = /* @__PURE__ */ new Set([
	"n",
	"na",
	"nar",
	"ナレ",
	"ナレーション",
	"ナレーター",
	"語り",
	"地の文"
]);
var SFX = /* @__PURE__ */ new Set([
	"se",
	"sfx",
	"擬音",
	"効果音",
	"描き文字",
	"音",
	"書き文字"
]);
var NOTES = /* @__PURE__ */ new Set([
	"ト書き",
	"トガキ",
	"演出",
	"メモ",
	"note",
	"絵"
]);
var PAGE_HEADING = /^(?:(\d+)\s*(?:ページ|頁|p|P)|[pP]\.?\s*(\d+)|(\d+))(?:\s|$|[:：）)])/;
/** The page number at the start of a page heading, with what follows it up to the subtitle. */
var PAGE_NUMBER = /^(?:\d+\s*(?:ページ目?|頁|p|P)|[pP]\.?\s*\d+|\d+)\s*[:：）)]?\s*/;
/** Tags after a speaker's name: what kind of line and balloon. */
var TAGS = [
	[/電話|通話|無線|通信|スマホ|携帯|テレビ|TV|ラジオ|スピーカー|放送|モニター|機械|インカム/i, { shape: "electric" }],
	[/叫び|叫ぶ|絶叫|怒鳴|大声|怒号/, { shape: "spike" }],
	[/小声|ささやき|囁|ひそひそ|つぶやき|呟/, { shape: "dashed" }],
	[/独白|心の声|モノローグ|内心|心中/, { kind: "thought" }],
	[/ナレ|語り/, { kind: "narration" }]
];
/** A speaker written with a tag, 叔母〔電話〕 / 叔母（電話）: the name and what the tag asks for. */
function tagged(name) {
	const match = /^(.*?)\s*[〔［[<＜（(]([^〕］\]>＞）)]{1,10})[〕］\]>＞）)]$/.exec(name);
	if (!match) return { name };
	const found = TAGS.find(([pattern]) => pattern.test(match[2]));
	return {
		name: match[1].trim(),
		...found ? found[1] : {}
	};
}
/** A shout written with doubled marks gets a spiky balloon. */
function shouted(text) {
	return /[！!]{2,}|[！!][？?][！!]/.test(text);
}
function plain(text) {
	return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/<br\s*\/?>/gi, "\n").trim();
}
/** A line of dialogue, or null for anything else. */
function readLine(raw) {
	const text = plain(raw);
	if (!text) return null;
	let match = /^((?:[^「『（(：:\s〔［]{0,20})(?:\s*[〔［[<＜（(][^〕］\]>＞）)「『]{1,10}[〕］\]>＞）)])?)\s*[「『]([\s\S]*?)[」』]?$/.exec(text);
	if (match) {
		const { name, kind, shape } = tagged(match[1].trim());
		const said = match[2].trim();
		const balloon = shape ?? (shouted(said) ? "spike" : void 0);
		return {
			...name ? { speaker: name } : {},
			kind: kind ?? "speech",
			text: said,
			...balloon ? { shape: balloon } : {}
		};
	}
	match = /^([^「『（(：:〔［\s]{1,20}\s*[〔［[<＜（(][^〕］\]>＞）)]{1,10}[〕］\]>＞）)])\s*[：:]\s*([\s\S]+)$/.exec(text);
	if (match) {
		const { name, kind, shape } = tagged(match[1].trim());
		const said = match[2].trim().replace(/^[「『](.*)[」』]$/, "$1");
		const balloon = shape ?? (shouted(said) ? "spike" : void 0);
		return {
			speaker: name,
			kind: kind ?? "speech",
			text: said,
			...balloon ? { shape: balloon } : {}
		};
	}
	match = /^([^「『（(：:\s]{1,20})\s*[（(]([\s\S]*?)[）)]?$/.exec(text);
	if (match) return {
		speaker: match[1].trim(),
		kind: "thought",
		text: match[2].trim()
	};
	match = /^([^「『（(：:]{1,20}?)\s*[：:]\s*([\s\S]+)$/.exec(text);
	if (match) {
		const name = match[1].trim();
		const said = match[2].trim().replace(/^[「『](.*)[」』]$/, "$1");
		const key = name.toLowerCase();
		if (NOTES.has(name) || NOTES.has(key)) return null;
		if (NARRATION.has(key) || NARRATION.has(name)) return {
			kind: "narration",
			text: said
		};
		if (SFX.has(key) || SFX.has(name)) return {
			kind: "sfx",
			text: said
		};
		return {
			speaker: name,
			kind: "speech",
			text: said
		};
	}
	return null;
}
/** A pattern by id or name (導入, 大ゴマ＋はめ込み, 3段…): the first whose name starts with it, else contains it. */
function findPattern(name) {
	const key = name.replace(/[（(].*$/, "").trim();
	if (!key) return void 0;
	return PATTERNS.find((p) => p.id === key)?.id ?? PATTERNS.find((p) => p.label.startsWith(key))?.id ?? PATTERNS.find((p) => p.label.includes(key))?.id;
}
/** Read a script. */
function parseScript(source) {
	const doc = {
		pages: [],
		warnings: []
	};
	const rows = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
	const pageHeadings = rows.some((row) => /^###(?!#)/.test(row.trim()) || /^■/.test(row.trim()));
	let scene;
	let page = null;
	let panel = null;
	let sceneStarted = false;
	const newPage = () => {
		page = {
			notes: [],
			panels: [],
			...scene && !sceneStarted ? { scene } : {}
		};
		sceneStarted = true;
		panel = null;
		doc.pages.push(page);
		return page;
	};
	const currentPage = () => page ?? newPage();
	const newPanel = (number) => {
		const target = currentPage();
		while (number && target.panels.length < number - 1 && number <= 40) target.panels.push({
			notes: [],
			lines: []
		});
		panel = {
			notes: [],
			lines: []
		};
		target.panels.push(panel);
		return panel;
	};
	for (const row of rows) {
		const line = row.trim();
		if (!line) continue;
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = plain(heading[2]);
			if (level === 1) doc.title ??= text;
			else if (level === 2) {
				scene = text;
				sceneStarted = false;
				if (!pageHeadings || page) page = null;
			} else if (level === 3) {
				newPage();
				const numbered = PAGE_HEADING.exec(text);
				if (numbered) page.number = Number(numbered[1] ?? numbered[2] ?? numbered[3]);
				const subtitle = numbered ? text.replace(PAGE_NUMBER, "").trim() : text;
				if (subtitle) page.notes.push(subtitle);
			} else {
				newPanel(Number(/^(?:コマ|\[|［)?\s*(\d+)/.exec(text)?.[1] ?? 0));
				const note = text.replace(/^(?:コマ|\[|［)?\s*\d*\s*(?:コマ目?|\]|］)?\s*[:：]?\s*/, "").trim();
				if (note) panel.notes.push(note);
			}
			continue;
		}
		if (line.startsWith("◆")) {
			scene = plain(line.slice(1)).replace(/[（(].*[）)]$/, "").trim();
			sceneStarted = false;
			page = null;
			continue;
		}
		if (line.startsWith("■")) {
			newPage();
			const number = /^\s*(\d+)\s*ページ/.exec(plain(line.slice(1)));
			if (number) page.number = Number(number[1]);
			const rest = plain(line.slice(1)).replace(/^\d+\s*ページ/, "").trim();
			if (rest) page.notes.push(rest);
			continue;
		}
		if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
			if (!pageHeadings) newPage();
			continue;
		}
		const bare = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "");
		const asked = /^(?:型|【型】|コマ割り)\s*[:：]?\s*(.+)$/.exec(plain(bare));
		if (asked && findPattern(asked[1]) && (page || !pageHeadings)) {
			currentPage().pattern = findPattern(asked[1]);
			continue;
		}
		const panelMark = /^(?:[［[]\s*(\d+)\s*[］\]]|【\s*コマ\s*(\d*)\s*】|コマ\s*(\d+)(?:\s|$|[:：]))\s*(.*)$/.exec(bare);
		if (panelMark) {
			newPanel(Number(panelMark[1] ?? panelMark[2] ?? panelMark[3] ?? 0));
			const rest = plain(panelMark[4] ?? "");
			if (rest) {
				const said = readLine(rest);
				if (said) panel.lines.push(said);
				else panel.notes.push(rest);
			}
			continue;
		}
		const said = readLine(bare);
		if (said) {
			(panel ?? newPanel()).lines.push(said);
			continue;
		}
		const note = plain(bare);
		if (!note) continue;
		if (panel) panel.notes.push(note);
		else if (page || !pageHeadings) currentPage().notes.push(note);
		else doc.title ??= note;
	}
	if (!doc.pages.length) doc.warnings.push("セリフが見つかりませんでした");
	else if (!pageHeadings && !rows.some((row) => /^(?:-{3,}|\*{3,}|_{3,})$/.test(row.trim()))) doc.warnings.push("ページの区切り（### 1ページ、■、---）がないので、シーンごとに 1 ページにしました");
	return doc;
}
/** Panels for `count` script panels over the basic frame: tiers, two side by side past four. */
function panelBoxes(box, count, gaps = DEFAULT_GUTTERS, binding = "right") {
	const [x0, y0, x1, y1] = box;
	const rows = count <= 4 ? count : Math.ceil(count / 2);
	const height = (y1 - y0 - gaps.down * (rows - 1)) / rows;
	const boxes = [];
	let left = count;
	for (let row = 0; row < rows; row++) {
		const across = count <= 4 ? 1 : left > rows - row ? 2 : 1;
		left -= across;
		const top = y0 + row * (height + gaps.down);
		const width = (x1 - x0 - gaps.across * (across - 1)) / across;
		for (let k = 0; k < across; k++) {
			const x = x0 + (binding === "right" ? across - 1 - k : k) * (width + gaps.across);
			boxes.push([
				x,
				top,
				x + width,
				top + height
			]);
		}
	}
	return boxes;
}
/** Deal the lines of a panel out over its box in reading order (right to left in a manga), wrapping down, broken into short lines and kept in the panel. */
function placeLines(project, page, panel, lines, speakers) {
	const placed = lines.map((said) => {
		const line = addLine(project, page, [0, 0], said.text || "…", said.kind);
		if (said.speaker) line.speaker = speakers.get(said.speaker);
		if (said.shape) line.balloonShape = said.shape;
		return line;
	});
	const box = placingBox(project, panel);
	inReadingDirection(project.binding, placed, (flip) => layOut(placed, flip.box(box), panel && flip.shape(panel.shape)));
}
/** How much a page's dialogue reads like a script page's: the mean, over the script's lines, of the most alike line on the page. */
function pageLikeness(page, scriptPage) {
	const said = scriptPage.panels.flatMap((panel) => panel.lines);
	if (!said.length || !page.lines.length) return 0;
	return said.reduce((sum, s) => sum + Math.max(...page.lines.map((line) => likeness(line.text, s.text))), 0) / said.length;
}
/** A script page and a page below this are not the same page. */
var SAME_PAGE = .4;
/** An empty page where a new script page falls is taken for it (rather than a page put in beside it). */
var EMPTY_PAGE = .2;
/**
* The page each script page goes to when taken in again, from `start` on,
* in order: the pairing whose dialogue reads most alike; undefined where the
* script has a page the name does not (a page to put in).
*/
function matchPages(project, doc, start) {
	const pages = project.pages.slice(start);
	const said = doc.pages;
	const score = (i, j) => {
		if (!pages[j].lines.length) return EMPTY_PAGE;
		const alike = pageLikeness(pages[j], said[i]);
		return alike >= SAME_PAGE ? alike : 0;
	};
	const scores = said.map((_, i) => pages.map((_, j) => score(i, j)));
	const best = Array.from({ length: said.length + 1 }, () => new Array(pages.length + 1).fill(0));
	for (let i = said.length - 1; i >= 0; i--) for (let j = pages.length - 1; j >= 0; j--) {
		const pair = scores[i][j];
		best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], pair > 0 ? pair + best[i + 1][j + 1] : 0);
	}
	const targets = new Array(said.length).fill(void 0);
	for (let i = 0, j = 0; i < said.length && j < pages.length;) {
		const pair = scores[i][j];
		if (pair > 0 && best[i][j] === pair + best[i + 1][j + 1]) targets[i++] = pages[j++];
		else if (best[i][j] === best[i + 1][j]) i++;
		else j++;
	}
	let last = -1;
	targets.forEach((page, i) => {
		if (page) last = pages.indexOf(page);
		else if (!targets.slice(i + 1).some(Boolean) && last + 1 < pages.length && !pages[last + 1].lines.length) targets[i] = pages[++last];
	});
	return targets;
}
/** Text compared without its line breaks and spaces. */
var bare = (text) => text.replace(/\s+/g, "");
/** How alike two lines of dialogue read, 0–1 (shared pairs of characters). */
function likeness(a, b) {
	const [x, y] = [bare(a), bare(b)];
	if (x === y) return 1;
	const pairs = (text) => {
		const chars = [...text];
		const counts = /* @__PURE__ */ new Map();
		for (let i = 0; i + 1 < chars.length; i++) counts.set(chars[i] + chars[i + 1], (counts.get(chars[i] + chars[i + 1]) ?? 0) + 1);
		return counts;
	};
	const [px, py] = [pairs(x), pairs(y)];
	let shared = 0;
	for (const [pair, n] of px) shared += Math.min(n, py.get(pair) ?? 0);
	const total = [...x].length + [...y].length - 2;
	return total > 0 ? 2 * shared / total : 0;
}
/** Below this, a changed line is taken as a different one (removed, and a new one added). */
var SAME_LINE = .3;
/**
* Pair a panel's lines with the script's: the most alike first (a line and
* the script line it most reads like), whatever order the balloons stand in
* now; between equally alike ones, the nearest in order.
*/
function pairLines(old, said, speakerOf) {
	const candidates = [];
	old.forEach((line, i) => said.forEach((s, j) => {
		const alike = likeness(line.text, s.text);
		if (alike >= SAME_LINE) candidates.push([
			alike + (line.speaker === speakerOf(s) ? .2 : 0) - .001 * Math.abs(i - j),
			i,
			j
		]);
	}));
	candidates.sort((a, b) => b[0] - a[0]);
	const [usedOld, usedNew] = [/* @__PURE__ */ new Set(), /* @__PURE__ */ new Set()];
	const pairs = [];
	for (const [, i, j] of candidates) {
		if (usedOld.has(i) || usedNew.has(j)) continue;
		usedOld.add(i);
		usedNew.add(j);
		pairs.push([i, j]);
	}
	return pairs;
}
/** New text for a line, broken again to fit its panel, where reading starts kept where it was (the top right of vertical text, the top left of horizontal). */
function retext(project, line, text, panel) {
	const [left, top, right] = line.box;
	line.text = text;
	const box = placingBox(project, panel);
	wrapToFit(line, box[3] - box[1] - 6);
	fitLine(line);
	moveLine(line, line.vertical ? right - line.box[2] : left - line.box[0], top - line.box[1]);
}
/**
* Put a line just added to a page where it is read next: just after
* `previous` (to its left in a manga), or where the panel's reading starts,
* then as little off the faces in the rough and the panel's other balloons
* (but those in `gone`) as it takes.
*/
function placeAfter(project, page, panel, line, previous, gone = /* @__PURE__ */ new Set()) {
	const box = placingBox(project, panel);
	wrapToFit(line, box[3] - box[1] - 6);
	fitLine(line);
	inReadingDirection(project.binding, previous ? [line, previous] : [line], (flip) => {
		const area = flip.box(box);
		const [right, top] = previous ? [balloonExtent(previous)[0] - 2, balloonExtent(previous)[1]] : [area[2] - 3, area[1] + 3];
		const [x0, y0, x1] = balloonExtent(line);
		moveLine(line, Math.max(area[0] + 3 - x0, right - x1), top - y0);
	});
	if (panel) {
		const avoid = [...faces(page, panel), ...page.lines.filter((other) => other !== line && other.panel === panel.id && !gone.has(other)).map(balloonExtent)];
		inReadingDirection(project.binding, [line], (flip) => moveClear(line, flip.box(box), avoid.map(flip.box)));
		line.panel = panel.id;
	}
}
/** Bring a page's dialogue in line with the script's panels (see `ScriptImportOptions.update`). */
function updatePage(project, page, used, speakers, report) {
	sortLines(page, project.binding);
	const panels = [...page.panels].sort((a, b) => a.order - b.order);
	const wanted = /* @__PURE__ */ new Map();
	used.forEach((scriptPanel, k) => {
		const panel = panels[Math.min(k, panels.length - 1)];
		if (panel && scriptPanel.notes.length) {
			const note = scriptPanel.notes.join("\n");
			if (panel.note !== note) report.notes = (report.notes ?? 0) + 1;
			panel.note = note;
		}
		wanted.set(panel, [...wanted.get(panel) ?? [], ...scriptPanel.lines]);
	});
	const speakerOf = (said) => said.speaker ? speakers.get(said.speaker) : void 0;
	const gone = /* @__PURE__ */ new Set();
	for (const panel of panels.length ? panels : [void 0]) {
		const said = wanted.get(panel) ?? [];
		const old = page.lines.filter((line) => panel ? line.panel === panel.id : !line.panel);
		const pairs = pairLines(old, said, speakerOf);
		const pairedOld = new Map(pairs.map(([i, j]) => [i, j]));
		const pairedNew = new Map(pairs.map(([i, j]) => [j, i]));
		old.forEach((line, i) => {
			const j = pairedOld.get(i);
			if (j === void 0) {
				gone.add(line);
				return;
			}
			const s = said[j];
			let changed = false;
			if (bare(line.text) !== bare(s.text)) {
				retext(project, line, s.text || "…", panel);
				changed = true;
			}
			const speaker = speakerOf(s);
			if ((line.speaker ?? void 0) !== speaker) {
				if (speaker) line.speaker = speaker;
				else delete line.speaker;
				changed = true;
			}
			if (line.kind !== s.kind) {
				setLineKind(project, line, s.kind);
				changed = true;
			}
			if (s.shape && line.balloonShape !== s.shape) {
				line.balloonShape = s.shape;
				fitLine(line);
				changed = true;
			}
			if (changed) report.changed++;
			else report.kept++;
		});
		let previous;
		said.forEach((s, j) => {
			const i = pairedNew.get(j);
			if (i !== void 0) {
				previous = old[i];
				return;
			}
			const line = addLine(project, page, [0, 0], s.text || "…", s.kind);
			const speaker = speakerOf(s);
			if (speaker) line.speaker = speaker;
			if (s.shape) line.balloonShape = s.shape;
			placeAfter(project, page, panel, line, previous, gone);
			previous = line;
			report.added++;
		});
		report.lines += said.length;
	}
	if (gone.size) {
		page.lines = page.lines.filter((line) => !gone.has(line));
		for (const line of page.lines) if (line.linkTo && !page.lines.some((other) => other.id === line.linkTo)) delete line.linkTo;
		report.removed += gone.size;
	}
	assignPanels(page);
	sortLines(page, project.binding);
}
/** Put a script onto the name. */
function applyScript(project, doc, options) {
	const report = {
		pages: 0,
		panels: 0,
		lines: 0,
		characters: [],
		scenes: 0,
		replacedScenes: 0,
		insertedPages: 0,
		leftPages: [],
		kept: 0,
		changed: 0,
		added: 0,
		removed: 0
	};
	if (doc.title && (!project.title || project.title === "新しいネーム")) project.title = doc.title;
	const speakers = new Map(project.characters.map((character) => [character.name, character.id]));
	for (const page of doc.pages) for (const panel of page.panels) for (const line of panel.lines) if (line.speaker && !speakers.has(line.speaker)) {
		speakers.set(line.speaker, addCharacter(project, line.speaker).id);
		report.characters.push(line.speaker);
	}
	const sceneStarts = [];
	const targets = options.update ? matchPages(project, doc, options.startPage) : null;
	let previous = options.startPage - 1;
	const reached = /* @__PURE__ */ new Set();
	doc.pages.forEach((scriptPage, i) => {
		let page;
		if (targets) {
			const target = targets[i];
			page = target ?? insertPage(project, previous + 1);
			if (!target) report.insertedPages++;
			reached.add(page.id);
			previous = pageIndex(project, page.id);
		} else page = project.pages[options.startPage + i] ?? insertPage(project, project.pages.length);
		report.pages++;
		const fresh = scriptPage.notes.filter((note) => !page.memo.includes(note));
		if (fresh.length) page.memo = [page.memo, ...fresh].filter(Boolean).join("\n");
		const filled = scriptPage.panels.map((panel) => panel.lines.length > 0 || panel.notes.length > 0);
		const used = scriptPage.panels.slice(0, filled.lastIndexOf(true) + 1);
		if (options.update && page.lines.length) {
			updatePage(project, page, used, speakers, report);
			if (scriptPage.scene) sceneStarts.push({
				title: scriptPage.scene,
				first: page.id,
				last: page.id
			});
			else if (sceneStarts.length) sceneStarts[sceneStarts.length - 1].last = page.id;
			return;
		}
		if (!page.panels.length && options.makePanels && used.length) {
			const pattern = scriptPage.pattern ?? options.pattern;
			if (pattern) {
				page.panels = patternPanels(project, pattern, gutters(project), used.length);
				orderPanels(page, project.binding);
			} else for (const box of panelBoxes(basicBox(project.pageFormat), used.length, gutters(project), project.binding)) addPanel(project, page, rectShape(box));
			report.panels += page.panels.length;
		}
		const panels = [...page.panels].sort((a, b) => a.order - b.order);
		used.forEach((scriptPanel, k) => {
			const panel = panels[Math.min(k, panels.length - 1)];
			if (panel && scriptPanel.notes.length) panel.note = [panel.note, ...scriptPanel.notes].filter(Boolean).join("\n");
			placeLines(project, page, panel, scriptPanel.lines, speakers);
			report.lines += scriptPanel.lines.length;
		});
		assignPanels(page);
		sortLines(page, project.binding);
		if (scriptPage.scene) sceneStarts.push({
			title: scriptPage.scene,
			first: page.id,
			last: page.id
		});
		else if (sceneStarts.length) sceneStarts[sceneStarts.length - 1].last = page.id;
	});
	if (targets) {
		const indices = [...reached].map((id) => pageIndex(project, id));
		const [from, to] = [Math.min(...indices), Math.max(...indices)];
		project.pages.forEach((page, i) => {
			if (i > from && i < to && !reached.has(page.id) && page.lines.length) report.leftPages.push(i + 1);
		});
	}
	for (const scene of sceneStarts) report.replacedScenes += putScene(project, pageIndex(project, scene.first), pageIndex(project, scene.last), scene.title).replaced;
	report.scenes = sceneStarts.length;
	return report;
}
/** The rows a sticky's text takes (wrapped to its width): folded to the first few, ending in …, unless `open`. */
function stickyRows(text, open = false) {
	const perRow = Math.floor(10);
	const rows = [];
	for (const paragraph of (text || "メモ").replace(/\r\n?/g, "\n").split("\n")) {
		const chars = [...paragraph];
		if (!chars.length) rows.push("");
		for (let i = 0; i < chars.length; i += perRow) rows.push(chars.slice(i, i + perRow).join(""));
	}
	if (open || rows.length <= 4) return rows;
	const shown = rows.slice(0, 4);
	shown[shown.length - 1] = `${[...shown[shown.length - 1]].slice(0, 9).join("")}…`;
	return shown;
}
/** Where a sticky lies (mm): folded, or as tall as all its text when `open`. */
function stickyBox(sticky, open = false) {
	const [x, y] = sticky.at;
	return [
		x,
		y,
		x + 64,
		y + 4 + stickyRows(sticky.text, open).length * 6 * 1.3
	];
}
function addSticky(project, page, at, text = "") {
	const sticky = {
		id: newId(project, "sticky"),
		text,
		at
	};
	settleSticky(project, sticky);
	(page.stickies ??= []).push(sticky);
	return sticky;
}
/**
* A 付箋 lies on its page or in its 欄外, not across the edge: on the page
* (kept clear of the facing page of a spread) when its middle is, else just
* outside the edge it is nearest.
*/
function settleSticky(project, sticky) {
	const [width, height] = project.pageFormat.canvasMm;
	const [x0, y0, x1, y1] = stickyBox(sticky);
	const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
	if (cx >= 0 && cx <= width && cy >= 0 && cy <= height) {
		sticky.at = [Math.min(Math.max(x0, 0), Math.max(0, width - (x1 - x0))), Math.min(Math.max(y0, 0), Math.max(0, height - (y1 - y0)))];
		return;
	}
	if (x1 <= 0 || x0 >= width || y1 <= 0 || y0 >= height) return;
	const [dx, dy] = [
		[-x1, 0],
		[width - x0, 0],
		[0, -y1],
		[0, height - y0]
	].reduce((best, way) => Math.hypot(way[0], way[1]) < Math.hypot(best[0], best[1]) ? way : best);
	sticky.at = [x0 + dx, y0 + dy];
}
/** The box a link's point is measured from: the panel's bounds or the line's box. */
function linkBase(page, kind, id) {
	if (kind === "panel") {
		const panel = page.panels.find((p) => p.id === id);
		return panel ? bounds(panel.shape) : null;
	}
	return page.lines.find((l) => l.id === id)?.box ?? null;
}
/** Tie a 付箋 to a panel or a line, pointing at `point` on it; false when it is not on the page. */
function linkSticky(page, sticky, kind, id, point) {
	const base = linkBase(page, kind, id);
	if (!base) return false;
	sticky.link = {
		kind,
		id,
		at: [point[0] - base[0], point[1] - base[1]]
	};
	return true;
}
// src/domain/structures.ts
/** Story shapes to hold the page split against: parts and their share of the pages. */
var STRUCTURES = {
	kishotenketsu: {
		id: "kishotenketsu",
		label: "起承転結",
		parts: [
			{
				name: "起",
				share: .2
			},
			{
				name: "承",
				share: .3
			},
			{
				name: "転",
				share: .3
			},
			{
				name: "結",
				share: .2
			}
		]
	},
	threeAct: {
		id: "threeAct",
		label: "三幕構成",
		parts: [
			{
				name: "第1幕（設定）",
				share: .25
			},
			{
				name: "第2幕（対立）",
				share: .5
			},
			{
				name: "第3幕（解決）",
				share: .25
			}
		],
		beats: [
			{
				name: "第1ターニングポイント",
				at: .25
			},
			{
				name: "ミッドポイント",
				at: .5
			},
			{
				name: "第2ターニングポイント",
				at: .75
			}
		]
	},
	johakyu: {
		id: "johakyu",
		label: "序破急",
		parts: [
			{
				name: "序",
				share: .25
			},
			{
				name: "破",
				share: .5
			},
			{
				name: "急",
				share: .25
			}
		]
	},
	saveTheCat: {
		id: "saveTheCat",
		label: "Save the Cat",
		parts: [
			{
				name: "セットアップ",
				share: 10 / 110
			},
			{
				name: "きっかけ・悩みのとき",
				share: 15 / 110
			},
			{
				name: "お楽しみ",
				share: 30 / 110
			},
			{
				name: "迫り来る悪い奴ら",
				share: 20 / 110
			},
			{
				name: "心の暗闇",
				share: 10 / 110
			},
			{
				name: "フィナーレ",
				share: 25 / 110
			}
		],
		beats: [
			{
				name: "オープニング・イメージ",
				at: 0
			},
			{
				name: "テーマの提示",
				at: 5 / 110
			},
			{
				name: "きっかけ",
				at: 12 / 110
			},
			{
				name: "第1ターニングポイント",
				at: 25 / 110
			},
			{
				name: "サブプロット",
				at: 30 / 110
			},
			{
				name: "ミッドポイント",
				at: 55 / 110
			},
			{
				name: "すべてを失って",
				at: 75 / 110
			},
			{
				name: "第2ターニングポイント",
				at: 85 / 110
			},
			{
				name: "ファイナル・イメージ",
				at: 1
			}
		]
	}
};
// src/domain/shapes.ts
/** Colours of the parts, in turn; used wherever pages are shown by part. */
var PART_COLORS = [
	"#4f86d9",
	"#e0884a",
	"#3fae84",
	"#c9a227",
	"#d97aa6",
	"#7d6bd6",
	"#5aa9c9",
	"#c25b5b"
];
/** Every shape the name can use: the built-in ones, then its own. */
function storyShapes(project) {
	return [...Object.values(STRUCTURES), ...project.plan?.shapes ?? []];
}
/** The shape the name is held against, if any. */
function currentShape(project) {
	const id = project.plan?.structure;
	return id ? storyShapes(project).find((shape) => shape.id === id) : void 0;
}
function partColor(shape, index) {
	return shape.parts[index]?.color ?? PART_COLORS[index % PART_COLORS.length];
}
/**
* Where the parts of `shape` fall over `pages` pages: each part gets at
* least one page while there are pages enough, and the last part ends on
* the last page.
*/
function shapeSpans(shape, pages) {
	if (pages < shape.parts.length || !shape.parts.length) return [];
	const total = shape.parts.reduce((sum, part) => sum + Math.max(part.share, 0), 0) || 1;
	const spans = [];
	let done = 0;
	let share = 0;
	shape.parts.forEach((part, index) => {
		share += Math.max(part.share, 0) / total;
		const left = shape.parts.length - index - 1;
		const end = index === shape.parts.length - 1 ? pages : Math.min(pages - left, Math.max(done + 1, Math.round(pages * share)));
		spans.push({
			index,
			name: part.name,
			color: partColor(shape, index),
			first: done,
			last: end - 1
		});
		done = end;
	});
	return spans;
}
/** The page (0-based) a beat at `at` (0..1) falls on. */
function beatPage(at, pages) {
	return Math.max(0, Math.min(pages - 1, Math.floor(at * pages)));
}
// src/domain/story.ts
/** Scenes with their page ranges, in page order; scenes pointing at missing pages are left out. */
function sceneSpans(project) {
	return project.scenes.map((scene) => ({
		scene,
		first: pageIndex(project, scene.firstPage),
		last: pageIndex(project, scene.lastPage)
	})).filter((span) => span.first >= 0 && span.last >= span.first).sort((a, b) => a.first - b.first || a.last - b.last);
}
/** Where the parts of the chosen story shape fall over `pages` pages. */
function planParts(project, pages = project.plan?.targetPages ?? project.pages.length) {
	const shape = currentShape(project);
	return shape ? shapeSpans(shape, pages).map(({ name, color, first, last }) => ({
		name,
		color,
		first,
		last
	})) : [];
}
/** 構成補助: how the page split compares with the aim, and pages worth a look. */
function planAdvice(project) {
	const advice = [];
	const count = project.pages.length;
	const target = project.plan?.targetPages;
	if (target) {
		const diff = count - target;
		advice.push(diff === 0 ? {
			level: "info",
			text: `目標の ${target} ページちょうどです`
		} : {
			level: "warn",
			text: `目標の ${target} ページより ${Math.abs(diff)} ページ${diff > 0 ? "多い" : "少ない"}です`
		});
	}
	const spans = sceneSpans(project);
	const parts = planParts(project, count);
	for (const part of parts) {
		const names = spans.filter((span) => {
			const middle = (span.first + span.last) / 2;
			return middle >= part.first && middle <= part.last + .5;
		}).map((span) => span.scene.title).join("・");
		advice.push({
			level: "info",
			text: `${part.name}: ${part.first + 1}〜${part.last + 1} ページ（${part.last - part.first + 1} ページ）${names ? ` … ${names}` : spans.length ? " … ここに当たるシーンがありません" : ""}`
		});
	}
	const shape = currentShape(project);
	for (const beat of shape?.beats ?? []) {
		if (!count) break;
		const page = beatPage(beat.at, count);
		advice.push({
			level: "info",
			text: `${beat.name}: ${page + 1} ページあたり`,
			page
		});
	}
	for (const span of spans) {
		const share = (span.last - span.first + 1) / Math.max(count, 1);
		if (spans.length > 1 && share > .4) advice.push({
			level: "warn",
			text: `シーン「${span.scene.title}」が全体の ${Math.round(share * 100)}% あります`,
			page: span.first
		});
	}
	project.pages.forEach((page, index) => {
		const text = textAmount(page);
		if (text > 180) advice.push({
			level: "warn",
			text: `${index + 1} ページ: 字が多め（${text} 字）`,
			page: index
		});
		if (page.panels.length > 8) advice.push({
			level: "warn",
			text: `${index + 1} ページ: コマが多め（${page.panels.length} コマ）`,
			page: index
		});
	});
	const empty = project.pages.map((page, index) => page.panels.length + page.lines.length + page.strokes.length ? -1 : index).filter((i) => i >= 0);
	if (empty.length && empty.length < count) advice.push({
		level: "info",
		text: `まだ何もないページ: ${runs(empty).map(([a, b]) => a === b ? `${a + 1}` : `${a + 1}〜${b + 1}`).join("、")}`
	});
	return advice;
}
function runs(indexes) {
	const out = [];
	for (const index of indexes) {
		const last = out[out.length - 1];
		if (last && last[1] === index - 1) last[1] = index;
		else out.push([index, index]);
	}
	return out;
}
// src/domain/validate.ts
/** The trailing number of an id made by `newId` ("line40" → 40). */
function idNumber(id) {
	const digits = id.replace(/^\D*/, "");
	return /^\d+$/.test(digits) ? Number(digits) : null;
}
/** Problems found in a name, in Japanese, as the Rust side words them. Empty when it is sound. */
function validate(project) {
	const problems = [];
	if (project.formatVersion > 2) problems.push(`新しい版のツールで保存されたファイルです（形式 ${project.formatVersion}、このツールは 2 まで）`);
	const ids = /* @__PURE__ */ new Set();
	const checkId = (id) => {
		if (!id) problems.push("id が空の要素があります");
		else if (ids.has(id)) problems.push(`id ${id} が重複しています`);
		else ids.add(id);
	};
	const characters = new Set(project.characters.map((c) => c.id));
	const images = new Set((project.images ?? []).map((i) => i.id));
	const spreads = /* @__PURE__ */ new Map();
	const pageNumber = (id) => {
		const index = project.pages.findIndex((page) => page.id === id);
		return index < 0 ? null : index + 1;
	};
	for (const character of project.characters) checkId(character.id);
	project.pages.forEach((page, index) => {
		const number = index + 1;
		checkId(page.id);
		const panels = new Set(page.panels.map((p) => p.id));
		for (const panel of page.panels) {
			checkId(panel.id);
			if (panel.shape.length < 3) problems.push(`${number} ページのコマ ${panel.id} の頂点が足りません`);
			if (panel.spread) spreads.set(panel.spread, [...spreads.get(panel.spread) ?? [], number]);
			if ((panel.openEdges ?? []).some((edge) => edge >= panel.shape.length)) problems.push(`${number} ページのコマ ${panel.id} の開いた辺の番号が範囲外です`);
		}
		for (const breakout of page.breakouts ?? []) {
			checkId(breakout.id);
			if (breakout.shape.length < 3) problems.push(`${number} ページのはみ出し ${breakout.id} の頂点が足りません`);
		}
		const lines = new Set(page.lines.map((l) => l.id));
		for (const line of page.lines) {
			checkId(line.id);
			if (line.speaker !== void 0 && !characters.has(line.speaker)) problems.push(`${number} ページのセリフ ${line.id} の話者 ${line.speaker} がいません`);
			if (line.panel !== void 0 && !panels.has(line.panel)) problems.push(`${number} ページのセリフ ${line.id} のコマ ${line.panel} がありません`);
			if (line.linkTo !== void 0 && (line.linkTo === line.id || !lines.has(line.linkTo))) problems.push(`${number} ページのセリフ ${line.id} のつなぎ先 ${line.linkTo} が同じページにありません`);
		}
		for (const stroke of page.strokes) checkId(stroke.id);
		for (const rough of page.roughs) checkId(rough.id);
		for (const reference of page.references ?? []) {
			checkId(reference.id);
			if (!images.has(reference.image)) problems.push(`${number} ページの資料画像 ${reference.id} の画像 ${reference.image} がありません`);
		}
	});
	for (const brush of project.brushes ?? []) {
		checkId(brush.id);
		if (!(Number.isFinite(brush.sizeMm) && brush.sizeMm > 0)) problems.push(`ブラシ「${brush.name}」の大きさが正しくありません`);
	}
	for (const image of project.images ?? []) checkId(image.id);
	for (const [spread, pages] of spreads) {
		const facing = pages.length === 2 && Math.abs(pages[0] - pages[1]) === 1;
		if (pages.length > 2 || pages.length === 2 && !facing) problems.push(`見開きのコマ ${spread} が隣り合う 2 ページに分かれていません`);
	}
	for (const scene of project.scenes) {
		checkId(scene.id);
		const [first, last] = [pageNumber(scene.firstPage), pageNumber(scene.lastPage)];
		if (first === null || last === null) problems.push(`シーン「${scene.title}」のページがありません`);
		else if (first > last) problems.push(`シーン「${scene.title}」の最初と最後のページが逆です`);
	}
	for (const point of project.emotions) {
		if (!characters.has(point.character)) problems.push(`感情の値の登場人物 ${point.character} がいません`);
		if (pageNumber(point.page) === null) problems.push(`感情の値のページ ${point.page} がありません`);
		if (!(point.value >= -1 && point.value <= 1)) problems.push(`感情の値 ${point.value} が -1〜1 の範囲外です`);
	}
	const numbers = [...ids].map(idNumber).filter((n) => n !== null);
	const highest = numbers.length ? Math.max(...numbers) : null;
	if (highest !== null && highest >= project.nextId) problems.push(`next_id ${project.nextId} が使用済みの id 番号 ${highest} 以下です`);
	return problems;
}
// src/domain/assist.ts
var SHAPE_LABELS = {
	ellipse: "楕円",
	rounded: "角丸",
	box: "四角",
	polygon: "多角形",
	cloud: "モコモコ",
	spike: "トゲ",
	burst: "爆発",
	wavy: "ふるえ",
	flash: "ウニフラ",
	electric: "電子音",
	dashed: "破線",
	none: "フキダシなし",
	custom: "取り込んだ形"
};
/** Where a box lies on the basic frame, in words (右上, 中央…). */
function placeWords(project, box) {
	const frame = basicBox(project.pageFormat);
	const [cx, cy] = boxCenter(box);
	const fx = (cx - frame[0]) / (frame[2] - frame[0]);
	const fy = (cy - frame[1]) / (frame[3] - frame[1]);
	const v = fy < .34 ? "上" : fy > .66 ? "下" : "中";
	const h = fx < .34 ? "左" : fx > .66 ? "右" : "";
	if (v === "中" && !h) return "中央";
	return `${v === "中" ? "中段" : v}${h}`;
}
/** How big a panel is against the basic frame. */
function sizeWords(project, panel) {
	const frame = basicBox(project.pageFormat);
	const share = area(panel.shape) / ((frame[2] - frame[0]) * (frame[3] - frame[1]));
	const percent = Math.round(share * 100);
	return `${share >= .45 ? "大" : share >= .2 ? "中" : "小"}・${percent}%`;
}
var oneLine = (text) => text.replace(/\r\n?/g, "\n").replace(/\n/g, "／").trim();
/** Dialogue without the breaks the balloon put in (words in Latin letters keep a space): the AI writes it unbroken too. */
var unbroken = (text) => text.replace(/\r\n?/g, "\n").replace(/\n/g, mostlyHalfWidth(text) ? " " : "").trim();
function speakerName(project, line) {
	return project.characters.find((c) => c.id === line.speaker)?.name ?? "";
}
/** A line of dialogue as the brief shows it: `[line12] 名前「…」`, with its kind and balloon when not plain speech. */
function lineWords(project, line) {
	const name = speakerName(project, line);
	const tags = [
		line.kind !== "speech" ? KIND_LABELS[line.kind] : "",
		line.balloonShape && line.balloonShape !== "auto" ? SHAPE_LABELS[line.balloonShape] : "",
		line.emphasis ? "強調" : ""
	].filter(Boolean);
	return `[${line.id}]${tags.length ? `（${tags.join("・")}）` : ""} ${name}「${unbroken(line.text)}」`;
}
function panelWords(project, panel, number) {
	const extras = [
		panel.border && panel.border !== "solid" ? BORDER_LABELS[panel.border] : "",
		panel.fill && panel.fill !== "none" ? FILL_LABELS[panel.fill] : "",
		panel.effect && panel.effect !== "none" ? EFFECT_LABELS[panel.effect] : "",
		panel.spread ? "見開きのコマ" : "",
		panel.draft ? "仮のコマ" : "",
		(panel.z ?? 0) > 0 ? "はめ込み" : ""
	].filter(Boolean);
	const head = `コマ${number}（${placeWords(project, bounds(panel.shape))}・${sizeWords(project, panel)}${extras.length ? `・${extras.join("・")}` : ""}）`;
	return panel.note ? `${head} 演出メモ: ${oneLine(panel.note)}` : head;
}
/** One page in detail: its memo, its panels in reading order with their dialogue, the rest. */
function pageWords(project, page, number, current) {
	const out = [];
	const flags = [current ? "いま開いているページ" : "", page.joinNext ? "次のページと見開き" : ""].filter(Boolean);
	out.push(`### p${number}${flags.length ? `（${flags.join("・")}）` : ""}`);
	if (page.memo.trim()) out.push(`メモ: ${oneLine(page.memo)}`);
	const panels = [...page.panels].sort((a, b) => a.order - b.order);
	panels.forEach((panel, k) => {
		out.push(`- ${panelWords(project, panel, k + 1)}`);
		for (const line of page.lines.filter((l) => l.panel === panel.id)) out.push(`  - ${lineWords(project, line)}`);
	});
	const loose = page.lines.filter((line) => !line.panel || !panels.some((p) => p.id === line.panel));
	if (loose.length) {
		out.push(panels.length ? "- コマの外のセリフ" : "- セリフ（コマ割りはまだ）");
		for (const line of loose) out.push(`  - ${lineWords(project, line)}`);
	}
	if (!panels.length && !page.lines.length) out.push("- （コマもセリフもまだない）");
	for (const sticky of page.stickies ?? []) out.push(`- 付箋: ${oneLine(sticky.text)}`);
	const drawn = [
		page.strokes.length ? `ラフ線 ${page.strokes.length} 本` : "",
		page.roughs.length ? `取り込んだラフ ${page.roughs.length} 枚` : "",
		(page.fills ?? []).length ? `塗り ${(page.fills ?? []).length}` : "",
		(page.references ?? []).length ? `資料画像 ${(page.references ?? []).length} 枚` : ""
	].filter(Boolean);
	if (drawn.length) out.push(`- 絵: ${drawn.join("・")}`);
	return out;
}
/** A page as one line, for the pages outside the range asked for. */
function pageLine(project, page, number) {
	const said = page.lines.slice(0, 2).map((line) => `${speakerName(project, line)}「${unbroken(line.text).slice(0, 20)}」`).join(" ");
	const memo = page.memo.trim() ? ` メモ: ${oneLine(page.memo).slice(0, 40)}` : "";
	return `- p${number}: コマ ${page.panels.length}・セリフ ${page.lines.length}（${textAmount(page)} 字）${memo}${said ? ` ${said}` : ""}`;
}
/** The name in words for an AI to read: the story, then each page with its panels in reading order and its dialogue. */
function nameBrief(project, options = {}) {
	const out = [];
	const count = project.pages.length;
	out.push(`# ネーム「${project.title || "（無題）"}」${project.storyIndex ? ` 第${project.storyIndex}話` : ""}`);
	const facts = [
		project.scroll ? "縦スクロール（上から下へ読む）" : project.binding === "right" ? "右綴じ（ページもコマも右から左へ読む・縦書き）" : "左綴じ（左から右へ読む・横書き）",
		`${count} ページ`,
		project.plan?.targetPages ? `目標 ${project.plan.targetPages} ページ` : "",
		project.plan?.structure ? `話の型: ${STRUCTURES[project.plan.structure]?.label ?? project.plan.shapes?.find((s) => s.id === project.plan?.structure)?.label ?? project.plan.structure}` : "",
		project.author ? `作者: ${project.author}` : ""
	].filter(Boolean);
	out.push(facts.join("・"));
	const frame = project.pageFormat.basicMm;
	out.push(`紙面: 基本枠 ${frame[0]}×${frame[1]} mm（位置は基本枠に対して。コマの % は基本枠に占める広さ）`);
	if (project.characters.length) {
		out.push("", "## 登場人物");
		for (const c of project.characters) out.push(`- ${c.name}（${c.id}）${c.tone ? ` 口調: ${oneLine(c.tone)}` : ""}`);
	}
	if (project.scenes.length) {
		out.push("", "## シーン");
		for (const scene of project.scenes) {
			const [a, b] = [pageIndex(project, scene.firstPage) + 1, pageIndex(project, scene.lastPage) + 1];
			out.push(`- p${a}〜p${b}「${scene.title}」${scene.storyTime ? `（${scene.storyTime}）` : ""}${scene.summary ? ` ${oneLine(scene.summary)}` : ""}`);
		}
	}
	if (project.emotions.length) {
		out.push("", "## 感情の推移（-1 つらい 〜 +1 よい）");
		for (const c of project.characters) {
			const points = project.emotions.filter((p) => p.character === c.id).sort((a, b) => pageIndex(project, a.page) - pageIndex(project, b.page));
			if (points.length) out.push(`- ${c.name}: ${points.map((p) => `p${pageIndex(project, p.page) + 1} ${p.value > 0 ? "+" : ""}${p.value.toFixed(1)}${p.note ? `（${oneLine(p.note)}）` : ""}`).join("、")}`);
		}
	}
	const advice = planAdvice(project);
	if (advice.length) {
		out.push("", "## 構成の気づき（アプリが数えたもの）");
		for (const item of advice) out.push(`- ${item.level === "warn" ? "⚠ " : ""}${item.text}`);
	}
	out.push("", "## ページ");
	const [from, to] = options.pages ?? [1, count];
	const current = new Set(options.current ?? []);
	project.pages.forEach((page, index) => {
		const number = index + 1;
		if (number >= from && number <= to) out.push(...pageWords(project, page, number, current.has(number)));
		else out.push(pageLine(project, page, number));
	});
	if ((project.held ?? []).length || (project.heldPages ?? []).length) {
		out.push("", "## 保留（まだ置き場所を決めていないもの）");
		for (const held of project.held ?? []) {
			const said = held.lines.map((line) => lineWords(project, line)).join(" ");
			out.push(`- 保留コマ${held.panel.note ? ` 演出メモ: ${oneLine(held.panel.note)}` : ""}${said ? ` ${said}` : ""}`);
		}
		for (const held of project.heldPages ?? []) out.push(`- 保留のページ ${held.pages.length} 枚`);
	}
	return out.join("\n");
}
var LINE_KINDS = [
	"speech",
	"thought",
	"narration",
	"sfx",
	"aside"
];
var SHAPES = Object.keys(SHAPE_LABELS).filter((shape) => shape !== "custom");
var STICKY_COLOR_NAMES = [
	"yellow",
	"pink",
	"blue",
	"green"
];
/**
* What each operation is, for the AI (the system prompt, SKILL.md and the
* command line's `ops` show this). Every operation is listed; a test checks it.
*/
var OPS_GUIDE = {
	script: "台本をネームに流し込む（アプリの「台本の取り込み」と同じ）。{\"op\":\"script\",\"text\":\"### 1ページ\\n[1]\\n太郎「おはよう」\\n...\",\"startPage\":1}。コマのないページにはコマを作る。\"update\":true で既にあるセリフを台本に合わせて直す。\"pattern\" はコマ割りの型",
	setTitle: "題名を変える。{\"op\":\"setTitle\",\"title\":\"…\"}",
	setPageMemo: "ページのメモ（何を描くページか）を書く。{\"op\":\"setPageMemo\",\"page\":3,\"memo\":\"…\",\"append\":true}（append で書き足す）",
	addPages: "ページを足す。{\"op\":\"addPages\",\"after\":3,\"count\":2,\"memos\":[\"…\",\"…\"]}（after:0 で先頭に）",
	deletePages: "ページを消す。{\"op\":\"deletePages\",\"pages\":[5,6]}（1 枚は残す）",
	movePage: "ページを動かす。{\"op\":\"movePage\",\"page\":5,\"to\":2}",
	panels: `コマ割りをし直す（中のセリフ・ラフは前のコマの順に新しいコマへ）。{"op":"panels","page":3,"pattern":"basic4"} または {"op":"panels","page":3,"count":5}（均等に）。pattern: ${PATTERNS.map((p) => `${p.id}=${p.label}`).join("、")}`,
	setPanelNote: "コマの演出メモ（カメラ・間・何のコマか）を書く。{\"op\":\"setPanelNote\",\"page\":3,\"panel\":2,\"note\":\"…\"}（panel は読む順の番号か id）",
	addLine: `セリフを足す（コマの中の読む順の位置に置く）。{"op":"addLine","page":3,"panel":2,"speaker":"太郎","text":"…","kind":"speech","after":"line12"}。kind: ${LINE_KINDS.map((k) => `${k}=${KIND_LABELS[k]}`).join("、")}。shape（フキダシの形）: ${SHAPES.map((s) => `${s}=${SHAPE_LABELS[s]}`).join("、")}。いない話者は人物に足す`,
	setLine: "セリフを直す。{\"op\":\"setLine\",\"line\":\"line12\",\"text\":\"…\",\"speaker\":\"花子\",\"kind\":\"thought\",\"shape\":\"spike\"}（line は要約の [line12]。speaker:null で話者なし）",
	removeLine: "セリフを消す。{\"op\":\"removeLine\",\"line\":\"line12\"}",
	moveLine: "セリフを別のコマ（別のページでも）へ動かす。{\"op\":\"moveLine\",\"line\":\"line12\",\"page\":4,\"panel\":1,\"after\":\"line15\"}（page を省くと同じページ。after でそのセリフの次に。しっぽは外れるので要れば addTails）",
	arrangeLines: "コマの中のセリフを読む順にきれいに並べ直す（顔をよけ、はみ出しを直す）。{\"op\":\"arrangeLines\",\"page\":3,\"panel\":2}（panel を省くとページ全体）",
	addTails: "しっぽのないセリフに、話者（コマのラフ）へ向けたしっぽを付ける。{\"op\":\"addTails\",\"page\":3}（page を省くと全ページ）",
	addSticky: `付箋を貼る（提案やコメントを紙面に残す）。{"op":"addSticky","page":3,"panel":2,"text":"…","color":"pink"}（panel か line で紐づけ。color: ${STICKY_COLOR_NAMES.join("/")}）`,
	addCharacter: "人物を足す。{\"op\":\"addCharacter\",\"name\":\"…\",\"tone\":\"口調のメモ\"}",
	setCharacter: "人物を直す。{\"op\":\"setCharacter\",\"character\":\"太郎\",\"name\":\"…\",\"tone\":\"…\"}",
	setScene: "シーンを置く（重なるシーンと置き換え）。{\"op\":\"setScene\",\"title\":\"…\",\"firstPage\":1,\"lastPage\":4,\"summary\":\"…\",\"storyTime\":\"1日目 朝\"}",
	setEmotion: "人物の感情の値を置く（-1〜1、null で消す）。{\"op\":\"setEmotion\",\"character\":\"太郎\",\"page\":5,\"value\":-0.6,\"note\":\"…\"}",
	setPlan: `目標ページ数・話の型。{"op":"setPlan","targetPages":24,"structure":"kishotenketsu"}（structure: ${Object.entries(STRUCTURES).map(([id, s]) => `${id}=${s.label}`).join("、")}）`
};
/** The operations explained, as one text. */
function opsGuide() {
	return ["変更の案は JSON の配列（操作を上から順に当てる）。ページ番号は 1 から、その操作の時点の番号。セリフは要約の [line12] の id、コマはページの中の読む順の番号（コマ1・コマ2…）か id。", ...Object.entries(OPS_GUIDE).map(([name, text]) => `- ${name}: ${text}`)].join("\n");
}
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** What each operation needs, to tell a malformed one before anything is changed. */
var REQUIRED = {
	script: { text: "string" },
	setTitle: { title: "string" },
	setPageMemo: {
		page: "number",
		memo: "string"
	},
	addPages: {},
	deletePages: { pages: "array" },
	movePage: {
		page: "number",
		to: "number"
	},
	panels: { page: "number" },
	setPanelNote: {
		page: "number",
		panel: "ref",
		note: "string"
	},
	addLine: {
		page: "number",
		text: "string"
	},
	setLine: { line: "string" },
	removeLine: { line: "string" },
	moveLine: { line: "string" },
	arrangeLines: { page: "number" },
	addTails: {},
	addSticky: {
		page: "number",
		text: "string"
	},
	addCharacter: { name: "string" },
	setCharacter: { character: "string" },
	setScene: {
		title: "string",
		firstPage: "number",
		lastPage: "number"
	},
	setEmotion: {
		character: "string",
		page: "number"
	},
	setPlan: {}
};
/** Operations read from JSON (an array, `{ "ops": [...] }`, or one per line), with what could not be read. */
function parseOps(text) {
	const problems = [];
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		try {
			raw = text.split("\n").map((row) => row.trim()).filter(Boolean).map((row) => JSON.parse(row));
		} catch (error) {
			return {
				ops: [],
				problems: [`JSON として読めません: ${error instanceof Error ? error.message : error}`]
			};
		}
	}
	const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.ops) ? raw.ops : isRecord(raw) ? [raw] : null;
	if (!list) return {
		ops: [],
		problems: ["操作の配列がありません"]
	};
	const ops = [];
	list.forEach((item, i) => {
		const at = `${i + 1} 番目`;
		if (!isRecord(item) || typeof item.op !== "string") return void problems.push(`${at}: "op" がありません`);
		const need = REQUIRED[item.op];
		if (!need) return void problems.push(`${at}: 知らない操作 ${item.op}`);
		for (const [key, type] of Object.entries(need)) {
			const value = item[key];
			if (!(type === "array" ? Array.isArray(value) : type === "ref" ? typeof value === "number" || typeof value === "string" : typeof value === type)) return void problems.push(`${at}（${item.op}）: "${key}" がありません`);
		}
		ops.push(item);
	});
	return {
		ops,
		problems
	};
}
var OpError = class extends Error {};
function pageAt(project, number) {
	const page = Number.isInteger(number) ? project.pages[number - 1] : void 0;
	if (!page) throw new OpError(`${number} ページはありません（${project.pages.length} ページまで）`);
	return page;
}
function panelAt(page, ref, number) {
	const panels = [...page.panels].sort((a, b) => a.order - b.order);
	const panel = typeof ref === "number" ? panels[ref - 1] : panels.find((p) => p.id === ref);
	if (!panel) throw new OpError(`${number} ページにコマ ${ref} はありません（${panels.length} コマ）`);
	return panel;
}
function lineAt(project, id) {
	for (const [index, page] of project.pages.entries()) {
		const line = page.lines.find((l) => l.id === id);
		if (line) return {
			page,
			line,
			number: index + 1
		};
	}
	throw new OpError(`セリフ ${id} はありません`);
}
function characterAt(project, ref) {
	const found = project.characters.find((c) => c.id === ref) ?? project.characters.find((c) => c.name === ref);
	if (!found) throw new OpError(`人物「${ref}」はいません`);
	return found;
}
/** A speaker by name or id; one not in the cast yet is added (said in `done`). */
function speakerFor(project, ref, done) {
	const found = project.characters.find((c) => c.id === ref) ?? project.characters.find((c) => c.name === ref);
	if (found) return found.id;
	done.push(`人物「${ref}」を足しました`);
	return addCharacter(project, ref).id;
}
function checkKind(kind) {
	if (kind === void 0) return void 0;
	if (!LINE_KINDS.includes(kind)) throw new OpError(`セリフの種類 ${kind} はありません（${LINE_KINDS.join("/")}）`);
	return kind;
}
function checkShape(shape) {
	if (shape === void 0) return void 0;
	if (shape !== "auto" && !SHAPES.includes(shape)) throw new OpError(`フキダシの形 ${shape} はありません`);
	return shape;
}
var short = (text) => {
	const one = oneLine(text);
	return one.length > 24 ? `${one.slice(0, 24)}…` : one;
};
/** Do one operation; what it did, in words. */
function applyOne(project, op, done) {
	switch (op.op) {
		case "script": {
			const doc = parseScript(op.text);
			if (!doc.pages.length) throw new OpError("台本にページがありません");
			const start = (op.startPage ?? 1) - 1;
			if (start < 0 || start > project.pages.length) throw new OpError(`${op.startPage} ページからは流し込めません`);
			if (op.pattern && !PATTERNS.some((p) => p.id === op.pattern)) throw new OpError(`コマ割りの型 ${op.pattern} はありません`);
			const report = applyScript(project, doc, {
				startPage: start,
				makePanels: true,
				pattern: op.pattern,
				update: op.update ?? false
			});
			if (report.characters.length) done.push(`人物「${report.characters.join("」「")}」を足しました`);
			const parts = [
				`${report.pages} ページ`,
				report.panels ? `コマ ${report.panels}` : "",
				`セリフ ${report.lines}`,
				report.scenes ? `シーン ${report.scenes}` : "",
				report.insertedPages ? `足したページ ${report.insertedPages}` : ""
			];
			return `台本を ${start + 1} ページから流し込みました（${parts.filter(Boolean).join("・")}）${doc.warnings.length ? `。注意: ${doc.warnings.join(" / ")}` : ""}`;
		}
		case "setTitle":
			project.title = op.title;
			return `題名を「${op.title}」に`;
		case "setPageMemo": {
			const page = pageAt(project, op.page);
			page.memo = op.append && page.memo ? `${page.memo}\n${op.memo}` : op.memo;
			return `${op.page} ページのメモ: ${short(op.memo)}`;
		}
		case "addPages": {
			const after = op.after ?? project.pages.length;
			if (!Number.isInteger(after) || after < 0 || after > project.pages.length) throw new OpError(`${after} ページの後ろには足せません`);
			const count = Math.max(1, Math.min(100, Math.round(op.count ?? op.memos?.length ?? 1)));
			const added = after === 0 ? insertBlankPages(project, 0, false, count) : insertBlankPages(project, after - 1, true, count);
			added.forEach((page, i) => {
				if (op.memos?.[i]) page.memo = op.memos[i];
			});
			const first = pageIndex(project, added[0].id) + 1;
			return `${first}${added.length > 1 ? `〜${first + added.length - 1}` : ""} ページを足しました`;
		}
		case "deletePages":
			if (!deletePages(project, op.pages.map((n) => pageAt(project, n).id))) throw new OpError("ページは 1 枚は残します");
			return `${op.pages.join("・")} ページを消しました`;
		case "movePage": {
			const page = pageAt(project, op.page);
			pageAt(project, op.to);
			movePage(project, page.id, op.to - op.page);
			return `${op.page} ページを ${op.to} ページ目へ`;
		}
		case "panels": {
			const page = pageAt(project, op.page);
			if (op.pattern) {
				const pattern = PATTERNS.find((p) => p.id === op.pattern);
				if (!pattern) throw new OpError(`コマ割りの型 ${op.pattern} はありません（${PATTERNS.map((p) => p.id).join("/")}）`);
				replacePanels(project, page, patternPanels(project, pattern.id, gutters(project), op.count));
				return `${op.page} ページを「${pattern.label}」で割りました（${page.panels.length} コマ）`;
			}
			const count = Math.round(op.count ?? 0);
			if (count < 1 || count > 20) throw new OpError("コマの数（count）は 1〜20 で");
			replacePanels(project, page, panelBoxes(basicBox(project.pageFormat), count, gutters(project), project.binding).map((box, i) => ({
				id: newId(project, "panel"),
				shape: rectShape(box),
				order: i + 1
			})));
			return `${op.page} ページを ${count} コマに割りました`;
		}
		case "setPanelNote": {
			const panel = panelAt(pageAt(project, op.page), op.panel, op.page);
			panel.note = op.append && panel.note ? `${panel.note}\n${op.note}` : op.note;
			return `${op.page} ページ コマ${typeof op.panel === "number" ? op.panel : ""}の演出メモ: ${short(op.note)}`;
		}
		case "addLine": {
			const page = pageAt(project, op.page);
			const panel = op.panel === void 0 ? void 0 : panelAt(page, op.panel, op.page);
			const kind = checkKind(op.kind) ?? "speech";
			const shape = checkShape(op.shape);
			const previous = op.after ? lineAt(project, op.after).line : panel ? page.lines.filter((l) => l.panel === panel.id).at(-1) : void 0;
			const speaker = op.speaker ? speakerFor(project, op.speaker, done) : void 0;
			const line = addLine(project, page, [0, 0], op.text || "…", kind);
			if (speaker) line.speaker = speaker;
			if (shape && shape !== "auto") line.balloonShape = shape;
			placeAfter(project, page, panel, line, previous && page.lines.includes(previous) ? previous : void 0);
			assignPanels(page);
			sortLines(page, project.binding);
			return `${op.page} ページ${panel ? ` コマ${typeof op.panel === "number" ? op.panel : ""}` : ""}に${op.speaker ? `${op.speaker}の` : ""}${KIND_LABELS[kind]}「${short(op.text)}」（${line.id}）`;
		}
		case "setLine": {
			const { page, line, number } = lineAt(project, op.line);
			const kind = checkKind(op.kind);
			const shape = checkShape(op.shape);
			const changes = [];
			if (op.speaker === null) {
				delete line.speaker;
				changes.push("話者なし");
			} else if (op.speaker !== void 0) {
				line.speaker = speakerFor(project, op.speaker, done);
				changes.push(`話者 ${op.speaker}`);
			}
			if (kind && kind !== line.kind) {
				setLineKind(project, line, kind);
				changes.push(KIND_LABELS[kind]);
			}
			if (shape) {
				if (shape === "auto") delete line.balloonShape;
				else line.balloonShape = shape;
				fitLine(line);
				changes.push(`フキダシ ${SHAPE_LABELS[shape] ?? "ふつう"}`);
			}
			if (op.text !== void 0 && op.text !== line.text) {
				const panel = page.panels.find((p) => p.id === line.panel);
				retext(project, line, op.text || "…", panel);
				changes.push(`「${short(op.text)}」`);
			}
			return `${number} ページの ${line.id} を${changes.length ? changes.join("・") : "そのまま"}に`;
		}
		case "removeLine": {
			const { page, line, number } = lineAt(project, op.line);
			page.lines = page.lines.filter((l) => l !== line);
			for (const other of page.lines) if (other.linkTo === line.id) delete other.linkTo;
			for (const sticky of page.stickies ?? []) if (sticky.link?.kind === "line" && sticky.link.id === line.id) delete sticky.link;
			return `${number} ページの「${short(line.text)}」を消しました`;
		}
		case "moveLine": {
			const { page: from, line, number } = lineAt(project, op.line);
			const page = op.page === void 0 ? from : pageAt(project, op.page);
			const at = op.page ?? number;
			const panel = op.panel === void 0 ? void 0 : panelAt(page, op.panel, at);
			if (!panel && page === from) throw new OpError("動かす先のコマ（panel）か page を");
			const previous = op.after ? lineAt(project, op.after).line : void 0;
			if (previous === line) throw new OpError("セリフをそのセリフ自身の次には置けません");
			if (page !== from) {
				from.lines = from.lines.filter((l) => l !== line);
				for (const other of from.lines) if (other.linkTo === line.id) delete other.linkTo;
				for (const sticky of from.stickies ?? []) if (sticky.link?.kind === "line" && sticky.link.id === line.id) delete sticky.link;
				delete line.linkTo;
				page.lines.push(line);
			}
			delete line.tails;
			delete line.panel;
			const last = panel ? page.lines.filter((l) => l !== line && l.panel === panel.id).at(-1) : void 0;
			placeAfter(project, page, panel, line, previous && page.lines.includes(previous) ? previous : last);
			assignPanels(page);
			sortLines(page, project.binding);
			return `「${short(line.text)}」を ${at} ページ${panel ? ` コマ${typeof op.panel === "number" ? op.panel : ""}` : ""}へ`;
		}
		case "arrangeLines": {
			const page = pageAt(project, op.page);
			const panel = op.panel === void 0 ? void 0 : panelAt(page, op.panel, op.page);
			const moved = panel ? arrangePanel(project, page, panel) : arrangePage(project, page);
			return `${op.page} ページ${panel ? ` コマ${typeof op.panel === "number" ? op.panel : ""}` : ""}のセリフ ${moved} 個を読む順に並べ直しました`;
		}
		case "addTails": {
			const added = (op.page === void 0 ? project.pages : [pageAt(project, op.page)]).reduce((sum, page) => sum + addAutoTails(page, project.binding), 0);
			return `${op.page === void 0 ? "全ページ" : `${op.page} ページ`}のセリフにしっぽ ${added} 本`;
		}
		case "addSticky": {
			const page = pageAt(project, op.page);
			if (op.color !== void 0 && !STICKY_COLOR_NAMES.includes(op.color)) throw new OpError(`付箋の色 ${op.color} はありません`);
			const panel = op.panel === void 0 ? void 0 : panelAt(page, op.panel, op.page);
			const line = op.line ? page.lines.find((l) => l.id === op.line) : void 0;
			if (op.line && !line) throw new OpError(`${op.page} ページにセリフ ${op.line} はありません`);
			const target = line ? line.box : panel ? bounds(panel.shape) : basicBox(project.pageFormat);
			const sticky = addSticky(project, page, [target[2] + 2, target[1]], op.text);
			sticky.color = op.color ?? "pink";
			if (line) linkSticky(page, sticky, "line", line.id, boxCenter(line.box));
			else if (panel) linkSticky(page, sticky, "panel", panel.id, boxCenter(bounds(panel.shape)));
			return `${op.page} ページに付箋「${short(op.text)}」`;
		}
		case "addCharacter": {
			if (project.characters.some((c) => c.name === op.name)) throw new OpError(`人物「${op.name}」はもういます`);
			const character = addCharacter(project, op.name);
			if (op.tone) character.tone = op.tone;
			return `人物「${op.name}」を足しました`;
		}
		case "setCharacter": {
			const character = characterAt(project, op.character);
			const was = character.name;
			if (op.name) character.name = op.name;
			if (op.tone !== void 0) character.tone = op.tone || void 0;
			if (!character.tone) delete character.tone;
			return `人物「${was}」を${op.name && op.name !== was ? `「${op.name}」に` : ""}直しました`;
		}
		case "setScene": {
			const [first, last] = [pageAt(project, op.firstPage), pageAt(project, op.lastPage)];
			const [a, b] = [pageIndex(project, first.id), pageIndex(project, last.id)];
			if (a > b) throw new OpError("シーンの最初のページが最後のページより後ろです");
			const { scene, replaced } = putScene(project, a, b, op.title, op.summary ?? "");
			if (op.storyTime) scene.storyTime = op.storyTime;
			return `シーン「${op.title}」を p${a + 1}〜p${b + 1} に${replaced ? `（${replaced} つと置き換え）` : ""}`;
		}
		case "setEmotion": {
			const character = characterAt(project, op.character);
			const page = pageAt(project, op.page);
			if (op.value !== null && !(typeof op.value === "number" && Number.isFinite(op.value))) throw new OpError("感情の値は -1〜1 の数で");
			setEmotion(project, character.id, page.id, op.value, op.note);
			return op.value === null ? `${character.name}の p${op.page} の感情の値を消しました` : `${character.name}の p${op.page} の感情 ${op.value}`;
		}
		case "setPlan": {
			const plan = { ...project.plan ?? {} };
			if (op.targetPages === null) delete plan.targetPages;
			else if (op.targetPages !== void 0) {
				if (!Number.isInteger(op.targetPages) || op.targetPages < 1) throw new OpError("目標ページ数は 1 以上の整数で");
				plan.targetPages = op.targetPages;
			}
			if (op.structure === null) delete plan.structure;
			else if (op.structure !== void 0) {
				if (!(op.structure in STRUCTURES) && !plan.shapes?.some((s) => s.id === op.structure)) throw new OpError(`話の型 ${op.structure} はありません`);
				plan.structure = op.structure;
			}
			project.plan = plan;
			return `構成: ${[plan.targetPages ? `目標 ${plan.targetPages} ページ` : "", plan.structure ? `型 ${STRUCTURES[plan.structure]?.label ?? plan.structure}` : ""].filter(Boolean).join("・") || "なし"}`;
		}
	}
}
/**
* Apply operations to a name, in order. One that cannot be done is left out
* (said in `problems`), the rest go through. When the name that results would
* not open (see `validate`), its problems are in `problems` too, and the
* caller must not keep it.
*/
function applyOps(project, ops) {
	const done = [];
	const problems = [];
	ops.forEach((op, i) => {
		try {
			done.push(applyOne(project, op, done));
		} catch (error) {
			if (!(error instanceof OpError) && !(error instanceof TypeError)) throw error;
			problems.push(`${i + 1} 番目（${op.op}）: ${error.message}`);
		}
	});
	const broken = validate(project);
	return {
		done,
		problems: [...problems, ...broken],
		broken: broken.length > 0
	};
}
// src/domain/namecheck.ts
var ISSUE_LABELS = {
	overlap: "フキダシの重なり",
	outside: "コマの外のセリフ",
	spill: "コマからはみ出し",
	trim: "仕上がりの外",
	tail: "しっぽなし",
	face: "顔にかかるセリフ"
};
/** How much two balloons may touch before it counts (mm², about a corner). */
var OVERLAP_MM2 = 12;
function overlapArea(a, b) {
	const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
	const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	return w > 0 && h > 0 ? w * h : 0;
}
function checkName(project) {
	const issues = [];
	const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
	project.pages.forEach((page, index) => {
		const add = (kind, line) => issues.push({
			kind,
			pageId: page.id,
			page: index + 1,
			lineId: line.id,
			text: line.text.replace(/\s+/g, "").slice(0, 14)
		});
		const extents = page.lines.map((line) => ({
			line,
			box: balloonExtent(line)
		}));
		extents.forEach(({ line, box }, i) => {
			if (extents.slice(i + 1).some((other) => other.line.linkTo !== line.id && line.linkTo !== other.line.id && overlapArea(box, other.box) > OVERLAP_MM2)) add("overlap", line);
			const panel = page.panels.find((p) => p.id === line.panel);
			if (page.panels.length && !page.panels.some((panel) => insidePolygon(panel.shape, boxCenter(line.box)))) add("outside", line);
			else if (panel && line.kind !== "sfx" && spills(box, panel.shape)) add("spill", line);
			if (box[0] < tx0 || box[1] < ty0 || box[2] > tx1 || box[3] > ty1) add("trim", line);
			if (onFace(page, line)) add("face", line);
			if (resolvedShape(line) !== "none" && line.kind === "speech" && !line.tails?.length && !line.linkTo && !page.lines.some((other) => other.linkTo === line.id)) add("tail", line);
		});
	});
	return issues;
}
// src/domain/scripttext.ts
/** One line of dialogue as the script writes it (名前「…」, ナレーション：…). */
function scriptLine(names, line) {
	const text = line.text.replace(/\s*\n\s*/g, "　").trim();
	const who = names.get(line.speaker ?? "") ?? "";
	if (line.kind === "narration") return `${KIND_LABELS.narration}：${text}`;
	if (line.kind === "sfx") return `${KIND_LABELS.sfx}：${text}`;
	if (line.kind === "thought") return `${who}（${text}）`;
	if (line.kind === "aside") return `${who}・${text}`;
	return `${who}「${text}」`;
}
/** The dialogue as a script: page by page, panel by panel, with speakers. */
function scriptText(project) {
	const names = new Map(project.characters.map((character) => [character.id, character.name]));
	const spans = sceneSpans(project);
	const story = project.storyIndex !== void 0 ? ` 第${project.storyIndex}話` : "";
	const out = [`${project.title}${story}`, ""];
	project.pages.forEach((page, index) => {
		const scene = spans.find((span) => span.first === index);
		if (scene) out.push(`◆ ${scene.scene.title}${scene.scene.storyTime ? `（${scene.scene.storyTime}）` : ""}`, "");
		out.push(`■ ${index + 1} ページ${page.memo ? `　${page.memo.split("\n")[0]}` : ""}`);
		const order = new Map(page.panels.map((panel) => [panel.id, panel.order]));
		let lastPanel;
		for (const line of page.lines) {
			const panel = line.panel ? order.get(line.panel) : void 0;
			if (panel !== void 0 && panel !== lastPanel) out.push(`  ［${panel}］`);
			lastPanel = panel;
			out.push(`    ${scriptLine(names, line)}`);
		}
		out.push("");
	});
	return out.join("\n");
}
// src/skill/cli.ts
var USAGE = `使い方（node namestudio.mjs …）:
  brief  <ネーム.namestudio> [--pages 3-5] [--current 3]   ネームの要約（AI が読む形）
  script <ネーム.namestudio>                              台本（セリフをページ・コマごとに。取り込める形）
  check  <ネーム.namestudio>                              開けるか・書き出し前のチェック
  ops                                                    変更の案（操作）の説明
  apply  <ネーム.namestudio> <案.json | -> [--dry-run] [--out 別名.namestudio]
                                                         変更の案を当てて保存（前の中身は .bak に）
  new    <ネーム.namestudio> [--title 題] [--pages 24] [--kind right|left|scroll]
                                                         新しいネームを作る`;
var Usage = class extends Error {};
function option(args, name) {
	const at = args.indexOf(name);
	if (at < 0) return void 0;
	const value = args[at + 1];
	if (value === void 0 || value.startsWith("--")) throw new Usage(`${name} の値がありません`);
	args.splice(at, 2);
	return value;
}
function flag(args, name) {
	const at = args.indexOf(name);
	if (at >= 0) args.splice(at, 1);
	return at >= 0;
}
function load(path) {
	const project = normalize(JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")));
	if (!Array.isArray(project.pages) || !project.pageFormat) throw new Error(`${path} はネームのファイルではないようです`);
	return project;
}
/** Write whole or not at all, and not over a file changed since it was read (the app saving it meanwhile). */
function save(path, project, readAt) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(project)}\n`, "utf8");
	if (readAt !== null && existsSync(path) && statSync(path).mtimeMs !== readAt) {
		unlinkSync(temporary);
		throw new Error(`${path} は読んだあとで変わりました（アプリで開いて保存した？）。もう一度やり直してください`);
	}
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	renameSync(temporary, path);
}
var say = (text) => process.stdout.write(`${text}\n`);
function range(text) {
	if (!text) return void 0;
	const match = /^(\d+)(?:-(\d+))?$/.exec(text);
	if (!match) throw new Usage(`ページの範囲は 3 か 3-5 の形で（${text}）`);
	return [Number(match[1]), Number(match[2] ?? match[1])];
}
function run(argv) {
	const args = [...argv];
	const command = args.shift();
	switch (command) {
		case "brief": {
			const pages = range(option(args, "--pages"));
			const current = option(args, "--current");
			const [path] = args;
			if (!path) throw new Usage("ファイルがありません");
			say(nameBrief(load(path), {
				pages,
				current: current ? [Number(current)] : void 0
			}));
			return 0;
		}
		case "script": {
			const [path] = args;
			if (!path) throw new Usage("ファイルがありません");
			say(scriptText(load(path)));
			return 0;
		}
		case "check": {
			const [path] = args;
			if (!path) throw new Usage("ファイルがありません");
			const project = load(path);
			const problems = validate(project);
			for (const problem of problems) say(`開けない: ${problem}`);
			const issues = checkName(project);
			for (const issue of issues) say(`${issue.page} ページ ${ISSUE_LABELS[issue.kind]}: ${issue.lineId}「${issue.text}」`);
			if (!problems.length && !issues.length) say("問題はありません");
			return problems.length ? 1 : 0;
		}
		case "ops":
			say(opsGuide());
			return 0;
		case "apply": {
			const dryRun = flag(args, "--dry-run");
			const out = option(args, "--out");
			const [path, source] = args;
			if (!path || !source) throw new Usage("ファイルと変更の案がありません");
			const readAt = statSync(path).mtimeMs;
			const project = load(path);
			const { ops, problems: unread } = parseOps(readFileSync(source === "-" ? 0 : source, "utf8"));
			for (const problem of unread) say(`読めない: ${problem}`);
			if (unread.length) return 1;
			const result = applyOps(project, ops);
			for (const done of result.done) say(`・${done}`);
			for (const problem of result.problems) say(`できない: ${problem}`);
			if (result.problems.length) {
				say("何も保存していません。直してもう一度どうぞ");
				return 1;
			}
			if (dryRun) {
				say("（--dry-run なので保存していません）");
				return 0;
			}
			save(out ?? path, project, out ? null : readAt);
			say(`保存しました: ${out ?? path}`);
			return 0;
		}
		case "new": {
			const title = option(args, "--title") ?? "新しいネーム";
			const pages = Number(option(args, "--pages") ?? "1");
			const kind = option(args, "--kind") ?? "right";
			const [path] = args;
			if (!path) throw new Usage("ファイルがありません");
			if (![
				"right",
				"left",
				"scroll"
			].includes(kind)) throw new Usage("--kind は right・left・scroll のどれか");
			if (!Number.isInteger(pages) || pages < 1 || pages > 400) throw new Usage("--pages は 1〜400");
			if (existsSync(path)) throw new Error(`${path} はもうあります`);
			save(path, newProject(title, pages, kind), null);
			say(`作りました: ${path}（${pages} ページ）`);
			return 0;
		}
		default: throw new Usage(command ? `知らないコマンド ${command}` : "コマンドがありません");
	}
}
try {
	process.exitCode = run(process.argv.slice(2));
} catch (error) {
	if (error instanceof Usage) {
		process.stderr.write(`${error.message}\n${USAGE}\n`);
		process.exitCode = 2;
	} else {
		process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
		process.exitCode = 1;
	}
}
export {};
