// A made-up name for the pictures in the README (e2e/readme-shots.mjs): eight
// pages of a short scene on a school roof, with panels, rough figures drawn
// by code, dialogue with tails, characters, scenes and emotion values. No
// one's real work goes into the pictures. Imported in the page through Vite.
import { addAutoTails } from "/src/autotail.ts";
import { balloonExtent } from "/src/balloon.ts";
import { addLine, moveLine } from "/src/dialogue.ts";
import { rectShape } from "/src/geometry.ts";
import { basicBox } from "/src/pagebox.ts";
import { addPanel, cutPanels } from "/src/panels.ts";
import { newId, newProject } from "/src/project.ts";
import { addSticky } from "/src/stickies.ts";

let seed = 11;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const wobble = (amount) => (random() - 0.5) * 2 * amount;

/** A hand-drawn line through `points`: a little wobble, pressure rising and falling. */
function stroke(project, page, points, widthMm = 0.45) {
  const out = [];
  const steps = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 1.2));
    for (let k = 0; k < n; k++) steps.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  steps.push(points.at(-1));
  const drift = [wobble(0.25), wobble(0.25)];
  steps.forEach(([x, y], i) => {
    const t = i / Math.max(1, steps.length - 1);
    const pressure = Math.min(1, 0.25 + Math.sin(Math.PI * t) * 0.65 + wobble(0.05));
    out.push([x + drift[0] * t + wobble(0.08), y + drift[1] * t + wobble(0.08), Math.max(0.1, pressure)]);
  });
  page.strokes.push({ id: newId(project, "stroke"), points: out, widthMm, closed: false });
}

function arc(cx, cy, rx, ry, from, to, steps = 18) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return points;
}

/** Head and shoulders, facing `dir` (1 right, -1 left); `hair`: "long" (アオイ) or "short" (ソラ). */
function figure(project, page, cx, top, height, hair, dir = 1, bust = false, width = height) {
  const r = Math.min(height * (bust ? 0.2 : 0.11), width * 0.15);
  const hy = top + r;
  const draw = (points, w) => stroke(project, page, points, w);
  draw(arc(cx, hy, r * 0.92, r, -Math.PI * 0.1, Math.PI * 2.05, 24));
  // Eyes and mouth, turned a little to the side faced.
  const ex = cx + dir * r * 0.18;
  draw([[ex - r * 0.42, hy + r * 0.05], [ex - r * 0.22, hy + r * 0.02]], 0.35);
  draw([[ex + r * 0.18, hy + r * 0.02], [ex + r * 0.38, hy + r * 0.05]], 0.35);
  draw([[ex - r * 0.1, hy + r * 0.5], [ex + r * 0.1, hy + r * 0.52]], 0.3);
  // Hair.
  if (hair === "long") {
    draw(arc(cx, hy - r * 0.1, r * 1.05, r * 1.0, Math.PI * 0.95, Math.PI * 2.05, 16));
    draw([[cx - r * 1.0, hy], [cx - r * 1.1, hy + r * 1.6], [cx - r * 0.8, hy + r * 2.2]]);
    draw([[cx + r * 1.0, hy], [cx + r * 1.1, hy + r * 1.6], [cx + r * 0.85, hy + r * 2.1]]);
    draw([[cx - r * 0.6, hy - r * 0.75], [cx - r * 0.2, hy - r * 0.2], [cx + r * 0.1, hy - r * 0.8]], 0.35);
  } else {
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * (1.05 + i * 0.17);
      const [x0, y0] = [cx + Math.cos(a) * r, hy + Math.sin(a) * r];
      draw([[x0, y0], [x0 + Math.cos(a) * r * 0.35 + r * 0.15, y0 + Math.sin(a) * r * 0.45]], 0.35);
    }
  }
  // Neck and shoulders.
  const ny = hy + r;
  const sw = r * (bust ? 2.3 : 1.9);
  draw([[cx - r * 0.25, ny - r * 0.05], [cx - r * 0.3, ny + r * 0.5]], 0.35);
  draw([[cx + r * 0.25, ny - r * 0.05], [cx + r * 0.3, ny + r * 0.5]], 0.35);
  draw([[cx - r * 0.3, ny + r * 0.5], [cx - sw * 0.8, ny + r * 0.8], [cx - sw, ny + r * 1.6], [cx - sw * 1.05, ny + (bust ? r * 2.2 : height * 0.75)]]);
  draw([[cx + r * 0.3, ny + r * 0.5], [cx + sw * 0.8, ny + r * 0.8], [cx + sw, ny + r * 1.6], [cx + sw * 1.05, ny + (bust ? r * 2.2 : height * 0.75)]]);
  if (!bust) draw([[cx - sw * 0.6, ny + height * 0.7], [cx + sw * 0.6, ny + height * 0.72]], 0.35);
}

function railing(project, page, [x0, , x1], y) {
  stroke(project, page, [[x0 + 1, y], [x1 - 1, y + wobble(0.6)]], 0.5);
  stroke(project, page, [[x0 + 1, y + 4], [x1 - 1, y + 4 + wobble(0.6)]], 0.4);
  for (let x = x0 + 6; x < x1 - 3; x += 9) stroke(project, page, [[x, y], [x + wobble(0.4), y + 14]], 0.35);
}

function cloud(project, page, cx, cy, w) {
  const bumps = 4;
  const points = [];
  for (let i = 0; i < bumps; i++) {
    const x = cx - w / 2 + (w * (i + 0.5)) / bumps;
    points.push(...arc(x, cy, w / bumps / 1.6, w / bumps / 1.9, Math.PI, Math.PI * 2, 8));
  }
  stroke(project, page, points, 0.35);
  stroke(project, page, [[cx - w / 2 - 1, cy + 1], [cx + w / 2 + 1, cy + 1.5]], 0.35);
}

function town(project, page, [x0, y0, x1, y1], base) {
  let x = x0 + 2;
  const points = [[x, base]];
  while (x < x1 - 6) {
    const w = 6 + random() * 10;
    const h = 6 + random() * Math.min(28, (base - y0) * 0.5);
    points.push([x, base - h], [Math.min(x1 - 2, x + w), base - h]);
    x += w;
    points.push([Math.min(x1 - 2, x), base]);
  }
  stroke(project, page, points, 0.35);
  void y1;
}

/** What each panel shows, drawn into its bounds. */
const SCENES = {
  wide(project, page, box) {
    const [x0, y0, x1, y1] = box;
    const h = y1 - y0;
    town(project, page, box, y0 + h * 0.62);
    railing(project, page, box, y0 + h * 0.62);
    cloud(project, page, x0 + (x1 - x0) * 0.3, y0 + h * 0.18, 30);
    cloud(project, page, x0 + (x1 - x0) * 0.75, y0 + h * 0.28, 22);
    stroke(project, page, arc(x0 + (x1 - x0) * 0.55, y0 + h * 0.62, 9, 9, Math.PI, Math.PI * 2, 14), 0.4);
    figure(project, page, x0 + (x1 - x0) * 0.68, y0 + h * 0.42, h * 0.55, "short", -1);
  },
  door(project, page, [x0, y0, x1, y1]) {
    const w = x1 - x0;
    const h = y1 - y0;
    stroke(project, page, [[x0 + w * 0.15, y1 - 1], [x0 + w * 0.15, y0 + h * 0.1], [x0 + w * 0.55, y0 + h * 0.1], [x0 + w * 0.55, y1 - 1]], 0.5);
    stroke(project, page, [[x0 + w * 0.48, y0 + h * 0.55], [x0 + w * 0.5, y0 + h * 0.58]], 0.6);
    figure(project, page, x0 + w * 0.75, y0 + h * 0.25, h * 0.7, "long", -1, false, w * 0.9);
  },
  bustA(project, page, [x0, y0, x1, y1]) {
    const h = y1 - y0;
    const r = Math.min(h * 0.2, (x1 - x0) * 0.15);
    figure(project, page, (x0 + x1) / 2 - (x1 - x0) * 0.12, y1 - r * 4.4, h, "long", 1, true, x1 - x0);
  },
  bustS(project, page, [x0, y0, x1, y1]) {
    const h = y1 - y0;
    const r = Math.min(h * 0.2, (x1 - x0) * 0.15);
    figure(project, page, (x0 + x1) / 2 + (x1 - x0) * 0.12, y1 - r * 4.4, h, "short", -1, true, x1 - x0);
  },
  sky(project, page, [x0, y0, x1, y1]) {
    const w = x1 - x0;
    const h = y1 - y0;
    cloud(project, page, x0 + w * 0.35, y0 + h * 0.35, Math.min(60, w * 0.5));
    cloud(project, page, x0 + w * 0.72, y0 + h * 0.62, Math.min(40, w * 0.35));
    for (const [bx, by] of [[0.2, 0.7], [0.27, 0.66]]) {
      const [x, y] = [x0 + w * bx, y0 + h * by];
      stroke(project, page, [[x - 3, y - 1.5], [x, y], [x + 3, y - 1.5]], 0.35);
    }
  },
  two(project, page, box) {
    const [x0, y0, x1, y1] = box;
    const h = y1 - y0;
    railing(project, page, box, y0 + h * 0.7);
    cloud(project, page, x0 + (x1 - x0) * 0.5, y0 + h * 0.2, 34);
    figure(project, page, x0 + (x1 - x0) * 0.32, y0 + h * 0.35, h * 0.62, "long", 1);
    figure(project, page, x0 + (x1 - x0) * 0.66, y0 + h * 0.33, h * 0.64, "short", -1);
  },
  hands(project, page, [x0, y0, x1, y1]) {
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const s = Math.min(x1 - x0, y1 - y0) * 0.35;
    stroke(project, page, [[cx - s * 1.4, cy + s * 0.3], [cx - s * 0.3, cy], [cx, cy - s * 0.15]], 0.5);
    stroke(project, page, [[cx + s * 1.4, cy - s * 0.2], [cx + s * 0.3, cy - s * 0.05], [cx, cy - s * 0.1]], 0.5);
    stroke(project, page, arc(cx, cy - s * 0.12, s * 0.35, s * 0.22, 0, Math.PI * 2, 16), 0.4);
  },
};

/** The pages: cuts in shares of the basic frame, then what each panel shows in reading order, and what is said. */
const PAGES = [
  {
    cuts: [[0, 0.62, 1, 0.62], [0.45, 0.62, 0.45, 1]],
    scenes: ["wide", "door", "bustA"],
    lines: [
      [0, 0.85, 0.08, "放課後の屋上。", "narration"],
      [2, 0.25, 0.05, "やっぱり\nここにいた", "speech", "a"],
    ],
  },
  {
    cuts: [[0, 0.36, 1, 0.36], [0, 0.7, 1, 0.7], [0.55, 0.36, 0.55, 0.7]],
    scenes: ["two", "bustS", "bustA", "sky"],
    lines: [
      [0, 0.8, 0.07, "また\n空を\n見てるの？", "speech", "a"],
      [1, 0.85, 0.05, "雲の形を\n覚えてる", "speech", "s"],
      [2, 0.2, 0.05, "なにそれ", "speech", "a"],
    ],
  },
  {
    cuts: [[0, 0.5, 1, 0.5], [0.4, 0, 0.4, 0.5]],
    scenes: ["bustS", "bustA", "two"],
    lines: [
      [0, 0.78, 0.06, "毎日\nちがう形に\nなるから", "speech", "s"],
      [1, 0.2, 0.06, "……", "speech", "a"],
      [2, 0.84, 0.25, "明日も\n来ていい？", "speech", "a"],
    ],
  },
  {
    cuts: [[0, 0.3, 1, 0.3], [0, 0.62, 1, 0.62], [0.5, 0.62, 0.5, 1]],
    scenes: ["sky", "two", "bustA", "bustS"],
    lines: [
      [1, 0.85, 0.05, "約束だよ", "speech", "s"],
      [2, 0.3, 0.1, "うん", "speech", "a"],
      [3, 0.8, 0.05, "雲の名前\n考えてきて", "speech", "s"],
    ],
  },
];

/** The name: eight pages (the four above, then again with other words), two characters, three scenes. */
export function demoName() {
  seed = 11;
  const project = newProject("サンプル 屋上の約束", 8);
  project.author = "サンプル";
  project.characters = [
    { id: "a", name: "アオイ", color: "#d9485f", tone: "まっすぐ、短く話す" },
    { id: "s", name: "ソラ", color: "#2f7fd8", tone: "ゆっくり、言葉を選ぶ" },
  ];
  const ids = project.pages.map((page) => page.id);
  project.scenes = [
    { id: "scene1", title: "屋上で", summary: "アオイが屋上でソラを見つける", firstPage: ids[0], lastPage: ids[2] },
    { id: "scene2", title: "雲の話", summary: "ソラが毎日雲を見ている理由", firstPage: ids[3], lastPage: ids[5] },
    { id: "scene3", title: "約束", summary: "明日も来ると約束する", firstPage: ids[6], lastPage: ids[7] },
  ];
  const curve = { a: [0.1, -0.2, 0.0, 0.3, 0.2, 0.5, 0.7, 0.9], s: [-0.4, -0.3, -0.1, 0.1, 0.4, 0.3, 0.6, 0.8] };
  project.emotions = Object.entries(curve).flatMap(([character, values]) =>
    values.map((value, i) => ({ character, page: ids[i], value, note: "" })),
  );
  project.plan = { targetPages: 8, structure: "kishotenketsu" };
  const basic = basicBox(project.pageFormat);
  const [bx, by, bx1, by1] = basic;
  const at = ([fx, fy]) => [bx + (bx1 - bx) * fx, by + (by1 - by) * fy];
  project.pages.forEach((page, index) => {
    const plan = PAGES[index % PAGES.length];
    addPanel(project, page, rectShape(basic));
    // Cuts run a little past the frame, as one is drawn; inner ends sit in the gutter already.
    const past = (v) => (v === 0 ? -0.02 : v === 1 ? 1.02 : v);
    for (const [x0, y0, x1, y1] of plan.cuts) cutPanels(project, page, at([past(x0), past(y0)]), at([past(x1), past(y1)]));
    const panels = [...page.panels].sort((p, q) => p.order - q.order);
    panels.forEach((panel, i) => {
      const xs = panel.shape.map(([x]) => x);
      const ys = panel.shape.map(([, y]) => y);
      SCENES[plan.scenes[i % plan.scenes.length]](project, page, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    });
    for (const [panelIndex, fx, fy, text, kind, speaker] of index < 4 ? plan.lines : plan.lines.slice(0, 2)) {
      const panel = panels[panelIndex];
      const xs = panel.shape.map(([x]) => x);
      const ys = panel.shape.map(([, y]) => y);
      const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const line = addLine(project, page, [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy], text, kind);
      if (speaker) line.speaker = speaker;
      // Keep the balloon inside its panel.
      const [lx0, ly0, lx1, ly1] = balloonExtent(line);
      moveLine(line, Math.min(0, x1 - 4 - lx1) + Math.max(0, x0 + 4 - lx0), Math.min(0, y1 - 4 - ly1) + Math.max(0, y0 + 4 - ly0));
    }
    addAutoTails(page, project.binding);
    page.memo = ["導入。屋上の広さを見せる", "二人の距離", "ソラの理由", "約束", "", "", "", ""][index];
  });
  // Pages 2 and 3 face each other (page 1 is alone, right-bound): a note across them.
  addSticky(project, project.pages[2], [bx + 20, by1 - 40], "ここ 見開きで空を大きく？");
  return project;
}
