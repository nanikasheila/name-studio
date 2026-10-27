// The select tool: what a press picks up (the transform frame, a 付箋's
// handle, a panel's memo, a しっぽ, a panel's corner, the gutter, a panel to
// swap, things to pick around) and how each of those drags goes and ends.
import { defaultTailStyle, insideBalloon, resolvedShape, tailGeometry, tailRootAt } from "./balloon";
import type { DragHandler, DragOf, EditorCore, MoveSnap, Press, Selection } from "./editorcore";
import { moveSeam, seamAt, seamBase, snapSeam } from "./komaedit";
import { toPage } from "./layout";
import { bounds } from "./geometry";
import type { Page, Point, Project } from "./model";
import { type CarriedContents, carryContents, followPanel, swapPanelContents } from "./panels";
import { assignPanels, orderPanels, sortLines } from "./readingorder";
import { pickInside } from "./strokes";
import { strokeEditable } from "./roughlayers";
import { besideCorners, snapBox } from "./snapping";
import { toggleItem, type ItemRef } from "./transform";
import { pressFrame } from "./tooltransform";
import { startStickyLink } from "./toolsticky";

export function pressSelect(editor: EditorCore, { event, project, slot, point, sx, sy }: Press): void {
  // The transform frame of the selected rough lines and dialogue.
  if (pressFrame(editor, { event, project, slot, point, sx, sy })) return;
  if (startStickyLink(editor, slot, sx, sy)) return;
  // A panel's memo tag: write in it right there, or drag it out of the way.
  const noted = editor.noteAt(slot, sx, sy);
  if (noted) {
    editor.select({ kind: "panel", pageId: slot.page.id, id: noted.id });
    const { x, y } = editor.noteBox(slot, noted);
    const [x0, y0] = bounds(noted.shape);
    editor.startDrag({
      kind: "note",
      slot,
      panelId: noted.id,
      start: [sx, sy],
      origin: [(x - slot.x) / slot.scale - x0, (y - slot.y) / slot.scale - y0],
      moved: false,
    });
    return;
  }
  // Alt + drag from a balloon: pull out a new tail.
  if (event.altKey) {
    const hitLine = editor.hit(slot, point);
    const line = hitLine?.kind === "line" ? slot.page.lines.find((l) => l.id === hitLine.id) : undefined;
    if (line && resolvedShape(line) !== "none") {
      editor.host.begin();
      line.tails = [...(line.tails ?? []), { tip: point, style: defaultTailStyle(line) }];
      editor.select({
        kind: "line",
        pageId: slot.page.id,
        id: line.id,
        tail: line.tails.length - 1,
      });
      editor.startDrag({
        kind: "tail",
        slot,
        lineId: line.id,
        index: line.tails.length - 1,
        moved: false,
        part: "tip",
        start: point,
        tip: point,
        created: true,
      });
      return;
    }
  }
  // コマの入れ替え: drag a panel's number onto another panel (Alt + drag a panel moves it without snapping, as everywhere).
  const swapping = editor.badgeAt(slot, sx, sy, project.pageFormat.canvasMm[0]);
  if (swapping) {
    editor.select({ kind: "panel", pageId: slot.page.id, id: swapping.id });
    editor.startDrag({
      kind: "swap",
      slot,
      panelId: swapping.id,
      at: [sx, sy],
      to: null,
    });
    return;
  }
  const tail = editor.tailAt(slot, sx, sy);
  if (tail) {
    const line = slot.page.lines.find((l) => l.id === tail.lineId)!;
    editor.host.begin();
    editor.select({
      kind: "line",
      pageId: slot.page.id,
      id: line.id,
      tail: tail.index,
    });
    const tip = line.tails![tail.index].tip;
    editor.startDrag({
      kind: "tail",
      slot,
      lineId: line.id,
      index: tail.index,
      moved: false,
      part: tail.part,
      start: point,
      tip: [...tip] as Point,
    });
    return;
  }
  const vertex = editor.vertexAt(slot, sx, sy);
  if (vertex >= 0) {
    editor.host.begin();
    const panel = slot.page.panels.find((p) => p.id === editor.selection!.id);
    const carried = panel && editor.panelCarries ? carryContents(slot.page, panel) : undefined;
    const targets = editor.snapTargetsOn(project, slot.page, [editor.selection!.id]);
    editor.startDrag({
      kind: "vertex",
      slot,
      panelId: editor.selection!.id,
      vertex,
      moved: false,
      carried,
      targets,
    });
    return;
  }
  const target = editor.hit(slot, point);
  // Shift: click to add a thing to the picked ones (or take it out), drag around things to add them.
  if (event.shiftKey) {
    const s = editor.selection;
    const base: ItemRef[] = s?.pageId !== slot.page.id ? [] : s.kind === "group" ? [...(s.items ?? [])] : isItemKind(s.kind) ? [{ kind: s.kind, id: s.id }] : [];
    // Halves of 見開き panels move and change only as a pair.
    const spread = target?.kind === "panel" && slot.page.panels.some((panel) => panel.id === target.id && panel.spread);
    const ref = target && isItemKind(target.kind) && !spread ? { kind: target.kind, id: target.id } : null;
    editor.startDrag({
      kind: "pick",
      slot,
      points: [point],
      add: { base, target: ref },
    });
    return;
  }
  // コマの境目: the gutter or an edge moves, the panels on both sides with it.
  if (!target || target.kind === "panel") {
    const seam = seamAt(slot.page, point, 6 / slot.scale);
    if (seam) {
      editor.host.begin();
      const carried = new Map<string, CarriedContents>();
      if (editor.panelCarries) {
        for (const id of new Set(seam.edges.map((edge) => edge.panelId))) {
          const panel = slot.page.panels.find((p) => p.id === id);
          if (panel) carried.set(id, carryContents(slot.page, panel));
        }
      }
      const targets = editor.snapTargetsOn(
        project,
        slot.page,
        seam.edges.map((edge) => edge.panelId),
      );
      editor.startDrag({
        kind: "seam",
        slot,
        seam,
        base: seamBase(slot.page, seam),
        start: point,
        moved: false,
        carried,
        targets,
      });
      editor.forgetHover();
      return;
    }
  }
  // Inside a 範囲選択: drag the whole group.
  const selection = editor.selection;
  if (selection?.kind === "group" && selection.pageId === slot.page.id && (!target || editor.isSelected(slot.page, target.kind, target.id))) {
    if (editor.groupHit(slot.page, point, 4 / slot.scale)) {
      editor.host.begin();
      // Panels picked take along what is drawn in them.
      const items = editor.selectedItems();
      editor.startDrag({
        kind: "move",
        slot,
        last: point,
        moved: false,
        items,
        snap: moveSnap(editor, project, slot.page, point, items),
      });
      return;
    }
  }
  if (!target) {
    // On nothing: drag around rough lines and dialogue to pick them together.
    editor.select(null);
    editor.startDrag({ kind: "pick", slot, points: [point] });
    return;
  }
  // A click on the selected balloon where others lie under it picks the next one down.
  const again = target.kind === "line" && editor.isSelected(slot.page, "line", target.id);
  const under = again ? editor.linesAt(slot, point) : [];
  const cycle = under.length > 1 ? under[(under.indexOf(target.id) + 1) % under.length] : undefined;
  editor.select(target);
  editor.host.begin();
  // A panel takes its dialogue and rough lines along.
  const panel = target.kind === "panel" ? slot.page.panels.find((p) => p.id === target.id) : undefined;
  const carried = panel && editor.panelCarries ? carryContents(slot.page, panel) : undefined;
  const snap = panel ? moveSnap(editor, project, slot.page, point, [{ kind: "panel", id: panel.id }]) : undefined;
  editor.startDrag({
    kind: "move",
    slot,
    last: point,
    moved: false,
    carried,
    ...(cycle ? { cycle } : {}),
    ...(snap ? { snap } : {}),
  });
}

/** Moving panels (among `items`) snap by their box; nothing to snap when no panel moves. */
function moveSnap(editor: EditorCore, project: Project, page: Page, origin: Point, items: readonly ItemRef[]): MoveSnap | undefined {
  const ids = items.filter((item) => item.kind === "panel").map((item) => item.id);
  const shapes = page.panels.filter((panel) => ids.includes(panel.id)).map((panel) => panel.shape);
  if (!shapes.length) return undefined;
  return {
    origin,
    box: bounds(shapes.flat()),
    total: [0, 0],
    targets: editor.snapTargetsOn(project, page, ids),
  };
}

/** Panels moved (and what they carry), rough lines, dialogue, a group. */
const move: DragHandler<DragOf<"move">> = {
  move(editor, drag, { event, point }) {
    let dx = point[0] - drag.last[0];
    let dy = point[1] - drag.last[1];
    if (drag.snap) {
      // Panels: where they would be from the start, snapped by their box; moved the rest of the way there.
      const { origin, box, total, targets } = drag.snap;
      let [tx, ty] = [point[0] - origin[0], point[1] - origin[1]];
      if (!event.altKey) {
        const shift = snapBox([box[0] + tx, box[1] + ty, box[2] + tx, box[3] + ty], targets, 8 / drag.slot.scale);
        [tx, ty] = [tx + shift.dx, ty + shift.dy];
        editor.guides = { pageId: drag.slot.page.id, ...shift.guides };
      } else {
        editor.guides = null;
      }
      [dx, dy] = [tx - total[0], ty - total[1]];
      drag.snap.total = [tx, ty];
    }
    if (dx === 0 && dy === 0) {
      drag.last = point;
      return false;
    }
    editor.moveSelection(drag.slot.page, dx, dy, drag.items);
    editor.follow(drag.slot.page, drag.carried);
    drag.last = point;
    drag.moved = true;
  },
  end(editor, drag, project) {
    if (!drag.moved) {
      editor.host.cancel();
      if (drag.cycle) {
        // Not at once: the second click of a double-click writes in the selected one.
        const pageId = drag.slot.page.id;
        const id = drag.cycle;
        editor.pickLater(() => {
          editor.select({ kind: "line", pageId, id });
          editor.host.status("重なったセリフの下のものを選びました（同じ所をもう一度押すと次へ）");
        }, 320);
      }
      return;
    }
    if (editor.selection?.kind === "panel" || editor.selection?.items?.some((item) => item.kind === "panel")) {
      orderPanels(drag.slot.page, project.binding);
    }
    editor.carryToPageUnder(project, drag.slot);
    settleMoved(editor, project, drag.slot.page.id);
  },
};

/** A corner of the selected panel. */
const vertex: DragHandler<DragOf<"vertex">> = {
  move(editor, drag, { event, point }) {
    const panel = drag.slot.page.panels.find((p) => p.id === drag.panelId);
    if (!panel) return false;
    // 水平・垂直 with the corners beside it, the other panels' lines, the frames, the grid.
    panel.shape[drag.vertex] = editor.snapped(drag.slot, point, drag.targets, event.altKey, besideCorners(panel.shape, drag.vertex));
    editor.follow(drag.slot.page, drag.carried);
    drag.moved = true;
  },
  end(editor, drag, project) {
    if (!drag.moved) {
      editor.host.cancel();
      return;
    }
    orderPanels(drag.slot.page, project.binding);
    settleMoved(editor, project, drag.slot.page.id);
  },
};

/** After moving: panels over the gutter become 見開き, every page's panels and lines in order again. */
function settleMoved(editor: EditorCore, project: Project, pageId: string): void {
  editor.spanPanels(project, editor.selection?.pageId ?? pageId);
  for (const slot of editor.slots) {
    assignPanels(slot.page);
    sortLines(slot.page, editor.binding());
  }
  editor.host.commit();
}

/** コマの境目: the gutter or a panel's edge, the panels on both sides with it. */
const seam: DragHandler<DragOf<"seam">> = {
  move(editor, drag, { event, point }) {
    const { seam } = drag;
    let distance = (point[0] - drag.start[0]) * seam.normal[0] + (point[1] - drag.start[1]) * seam.normal[1];
    if (event.altKey) editor.guides = null;
    else {
      const snapped = snapSeam(seam, distance, drag.targets, 8 / drag.slot.scale);
      distance = snapped.distance;
      const horizontal = Math.abs(seam.dir[1]) < 1e-6;
      editor.guides = {
        pageId: drag.slot.page.id,
        xs: horizontal || snapped.guide === null ? [] : [snapped.guide],
        ys: horizontal && snapped.guide !== null ? [snapped.guide] : [],
      };
    }
    const moved = moveSeam(drag.slot.page, drag.base, seam, distance);
    for (const [id, carried] of drag.carried) {
      const panel = drag.slot.page.panels.find((p) => p.id === id);
      if (panel) followPanel(drag.slot.page, panel, carried);
    }
    drag.moved = drag.moved || Math.abs(moved) > 0.01;
    const what = seam.between ? "間白" : "コマの辺";
    editor.host.status(`${what}を ${Math.abs(moved).toFixed(1)} mm 動かしています（Alt で吸い付かない）`);
  },
  end(editor, drag, project) {
    if (!drag.moved) {
      editor.host.cancel();
      // A click on an edge picks the panel there.
      const panel = editor.panelAt(drag.slot.page, drag.start) ?? drag.slot.page.panels.find((p) => p.id === drag.seam.edges[0].panelId);
      editor.select(panel ? { kind: "panel", pageId: drag.slot.page.id, id: panel.id } : null);
      return;
    }
    orderPanels(drag.slot.page, project.binding);
    assignPanels(drag.slot.page);
    sortLines(drag.slot.page, editor.binding());
    const spanned = editor.spanPanels(project, drag.slot.page.id);
    editor.host.commit();
    if (!spanned) editor.host.status(drag.seam.between ? "間白を動かしました（両側のコマが一緒に）" : "コマの辺を動かしました");
  },
};

/** しっぽ: its tip, its whole length, its bend or its root. */
const tail: DragHandler<DragOf<"tail">> = {
  move(editor, drag, { point }) {
    const line = drag.slot.page.lines.find((l) => l.id === drag.lineId);
    const tail = line?.tails?.[drag.index];
    if (!line || !tail) return false;
    if (drag.part === "bend") {
      // How far the pointer is to the side of the straight tail.
      const straight = tailGeometry(line, { ...tail, bend: 0 });
      if (!straight) return false;
      const mid: Point = [(straight.root[0] + tail.tip[0]) / 2, (straight.root[1] + tail.tip[1]) / 2];
      const length = Math.hypot(tail.tip[0] - straight.root[0], tail.tip[1] - straight.root[1]);
      let bend = (point[0] - mid[0]) * straight.normal[0] + (point[1] - mid[1]) * straight.normal[1];
      bend = Math.max(-length * 0.6, Math.min(length * 0.6, bend));
      if (Math.abs(bend) < 0.4) delete tail.bend;
      else tail.bend = Math.round(bend * 10) / 10;
      editor.host.status("しっぽを曲げています（まっすぐ近くで戻ります）");
    } else if (drag.part === "root") {
      // Round the balloon: the direction of the pointer from its centre; near the tip's own direction it goes back to following the tip.
      const root = tailRootAt(line, tail, point);
      if (root === null) delete tail.root;
      else tail.root = root;
      editor.host.status("しっぽの根本を動かしています（先の向き近くで元に戻ります）");
    } else {
      tail.tip = drag.part === "body" ? [drag.tip[0] + point[0] - drag.start[0], drag.tip[1] + point[1] - drag.start[1]] : point;
    }
    drag.moved = true;
  },
  end(editor, drag) {
    const line = drag.slot.page.lines.find((l) => l.id === drag.lineId);
    const tail = line?.tails?.[drag.index];
    if (!drag.moved && !drag.created) {
      editor.host.cancel();
      if ((line?.tails?.length ?? 0) > 1) editor.host.status(`${drag.index + 1} 本目のしっぽを選びました（Delete か右の欄の × で、このしっぽだけ消せます）`);
      return;
    }
    // A tip put back inside its balloon takes the tail away.
    if (line && tail && drag.part !== "bend" && drag.part !== "root" && insideBalloon(line, tail.tip)) {
      line.tails = line.tails!.filter((_, i) => i !== drag.index);
      if (!line.tails.length) delete line.tails;
      const s = editor.selection;
      if (s?.kind === "line" && s.id === line.id) editor.setSelection({ kind: "line", pageId: s.pageId, id: line.id });
      editor.host.status(drag.created ? "" : "しっぽを消しました（元に戻すは Ctrl+Z）");
      if (drag.created) {
        editor.host.cancel();
        return;
      }
    } else if (drag.created) {
      editor.host.status("しっぽを足しました。先をドラッグで向きを、ひし形で曲がりを変えられます");
    }
    editor.host.commit();
  },
};

/** コマの入れ替え: a panel's number dragged onto another panel, on this page or the facing one. */
const swap: DragHandler<DragOf<"swap">> = {
  move(editor, drag, { project, ex, ey }) {
    // The panel under the pointer, on this page or the facing one.
    const under = editor.slotAt(ex, ey, project);
    const target = under && editor.panelAt(under.page, toPage(under, ex, ey));
    drag.to = under && target && !(under.page === drag.slot.page && target.id === drag.panelId) ? { slot: under, panelId: target.id } : null;
  },
  end(editor, drag, project) {
    const from = drag.slot.page.panels.find((panel) => panel.id === drag.panelId);
    const to = drag.to;
    const target = to && to.slot.page.panels.find((panel) => panel.id === to.panelId);
    if (!from || !to || !target) return;
    editor.host.begin();
    swapPanelContents(drag.slot.page, from, to.slot.page, target, project.binding);
    editor.host.commit();
    editor.select({ kind: "panel", pageId: to.slot.page.id, id: target.id });
    editor.host.status(`コマ ${from.order} とコマ ${target.order} の中身を入れ替えました（元に戻すは Ctrl+Z）`);
  },
};

/** A panel's memo tag: moved out of the way, or (a click) written in. */
const note: DragHandler<DragOf<"note">> = {
  move(editor, drag, { ex, ey }) {
    const panel = drag.slot.page.panels.find((p) => p.id === drag.panelId);
    if (!panel) return false;
    if (!drag.moved) {
      if (Math.hypot(ex - drag.start[0], ey - drag.start[1]) < 4) return false;
      editor.host.begin();
      drag.moved = true;
    }
    const [ox, oy] = drag.origin;
    panel.noteAt = [ox + (ex - drag.start[0]) / drag.slot.scale, oy + (ey - drag.start[1]) / drag.slot.scale];
  },
  end(editor, drag) {
    if (!drag.moved) {
      editor.editInPlace(drag.slot.page.id, "note", drag.panelId);
      return;
    }
    editor.host.commit();
    editor.host.status("コマのメモを動かしました。線でコマとつながっています（右の欄で元の位置に戻せます）");
  },
};

/** 範囲選択: dragged around things to pick them (Shift: added to the picked ones). */
const pick: DragHandler<DragOf<"pick">> = {
  move(_editor, drag, { point }) {
    drag.points.push(point);
  },
  end(editor, drag) {
    const page = drag.slot.page;
    const [x0, y0, x1, y1] = bounds(drag.points);
    let items: ItemRef[];
    if (drag.add && Math.max(x1 - x0, y1 - y0) * drag.slot.scale < 4) {
      // Shift + click.
      if (!drag.add.target) return;
      items = toggleItem(drag.add.base, drag.add.target);
    } else {
      const picked = pickInside(page, drag.points);
      // Lines on a hidden or locked layer stay where they are.
      const project = editor.host.project();
      if (project) picked.strokes = picked.strokes.filter((id) => strokeEditable(project, page.strokes.find((stroke) => stroke.id === id) ?? {}));
      const found: ItemRef[] = [
        ...picked.panels.map((id) => ({ kind: "panel" as const, id })),
        ...picked.strokes.map((id) => ({ kind: "stroke" as const, id })),
        ...picked.lines.map((id) => ({ kind: "line" as const, id })),
        ...picked.fills.map((id) => ({ kind: "fill" as const, id })),
        ...picked.breakouts.map((id) => ({ kind: "breakout" as const, id })),
      ];
      items = drag.add ? [...drag.add.base] : [];
      for (const item of found) if (!items.some((x) => x.kind === item.kind && x.id === item.id)) items.push(item);
    }
    if (!items.length) editor.select(null);
    else if (items.length === 1) editor.select({ kind: items[0].kind, pageId: page.id, id: items[0].id });
    else editor.select({ kind: "group", pageId: page.id, id: "group", items });
    if (items.length > 1) editor.host.status(`${pickedSummary(items)}を選びました。ドラッグで動かし、枠で変形、Delete で消せます（Shift + クリックで足す・外す）`);
  },
};

export const SELECT_DRAGS = { move, vertex, seam, tail, swap, note, pick };

function isItemKind(kind: Selection["kind"]): kind is ItemRef["kind"] {
  return kind === "stroke" || kind === "line" || kind === "panel" || kind === "fill" || kind === "breakout";
}

/** 「コマ 2 つ・線 5 本・セリフ 3 個」 for the status line. */
export function pickedSummary(items: readonly ItemRef[]): string {
  const count = (kind: ItemRef["kind"]) => items.filter((item) => item.kind === kind).length;
  const parts = [
    [count("panel"), "コマ", "つ"],
    [count("stroke"), "線", "本"],
    [count("line"), "セリフ", "個"],
    [count("fill"), "塗り", "つ"],
    [count("breakout"), "はみ出し", "つ"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, name, unit]) => `${name} ${n} ${unit}`)
    .join("・");
}
