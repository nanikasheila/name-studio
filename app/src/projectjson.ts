// The project as the text that is saved. Most of a drawn name is stroke
// points, and a point list is never changed in place (see snapshot.ts), so
// each list is written once and its text reused by every later save. Points
// are written to 0.01 mm (pressure, tilt and speed to 0.001): finer than any
// pen or print, and a third of the size of every digit a double has.

const written = new WeakMap<object, string>();

function number(value: number, scale: number): string {
  return Number.isFinite(value) ? String(Math.round(value * scale) / scale) : "0";
}

function pointsText(points: readonly unknown[]): string {
  let text = written.get(points);
  if (text !== undefined) return text;
  const parts: string[] = [];
  for (const point of points) {
    if (!Array.isArray(point)) {
      parts.push(JSON.stringify(point) ?? "null");
      continue;
    }
    parts.push(`[${point.map((value, i) => (typeof value === "number" ? number(value, i < 2 ? 100 : 1000) : JSON.stringify(value))).join(",")}]`);
  }
  text = `[${parts.join(",")}]`;
  written.set(points, text);
  return text;
}

/** The JSON text of `project` as saved (compact). */
export function projectJson(project: unknown): string {
  const { pages } = project as { pages?: unknown };
  if (!Array.isArray(pages)) return withLists(project);
  // The pages (most of it) written each by `pageJson`, the rest as any value; then put together.
  const mark = `\u0001pages${Math.random().toString(36).slice(2)}`;
  const rest = withLists({ ...(project as object), pages: mark });
  return rest.replace(JSON.stringify(mark), () => `[${pages.map(pageJson).join(",")}]`);
}

/**
 * A page as `withLists` writes it, quicker: its point lists are only in its
 * strokes, so each stroke is written with its list's text put in, and the
 * rest of the page without a replacer looking at every value. (A key and its
 * value written as `"strokes":0` cannot be inside a text, whose quotes are escaped.)
 */
function pageJson(page: unknown): string {
  const { strokes } = page as { strokes?: unknown };
  if (!Array.isArray(strokes)) return withLists(page);
  const texts = strokes.map(strokeJson);
  return JSON.stringify({ ...(page as object), strokes: 0 }).replace('"strokes":0', () => `"strokes":[${texts.join(",")}]`);
}

function strokeJson(stroke: { points?: unknown }): string {
  if (!Array.isArray(stroke.points)) return withLists(stroke);
  const points = pointsText(stroke.points);
  return JSON.stringify({ ...stroke, points: 0 }).replace('"points":0', () => `"points":${points}`);
}

/** Any value with its point lists (wherever they are) written by `pointsText`. */
function withLists(value: unknown): string {
  const lists: string[] = [];
  // A mark no text in the project can be: it holds a number drawn for this call.
  const mark = `\u0001pts${Math.random().toString(36).slice(2)}:`;
  const json = JSON.stringify(value, (key, v: unknown) => {
    if (key === "points" && Array.isArray(v)) {
      lists.push(pointsText(v));
      return `${mark}${lists.length - 1}`;
    }
    return v;
  });
  return putLists(json, mark, lists);
}

/** The marks written for point lists replaced by the lists' text. */
function putLists(json: string, mark: string, lists: readonly string[]): string {
  if (!lists.length) return json;
  // JSON writes the mark's first character as \u0001.
  const pattern = new RegExp(`"\\\\u0001${mark.slice(1)}(\\d+)"`, "g");
  return json.replace(pattern, (_, index: string) => lists[Number(index)]);
}

/**
 * A request body for the commands that save the project: `[u32 length][meta
 * JSON][project text]`, so the text travels as bytes and is saved as it is.
 */
export function projectBody(meta: unknown, project: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const head = encoder.encode(JSON.stringify(meta));
  const text = encoder.encode(projectJson(project));
  const body = new Uint8Array(4 + head.length + text.length);
  new DataView(body.buffer).setUint32(0, head.length, true);
  body.set(head, 4);
  body.set(text, 4 + head.length);
  return body;
}
