// The project as the text that is saved. Most of a drawn name is stroke
// points and balloon outlines, and neither list is changed in place (see
// snapshot.ts), so each is written once and its bytes reused by every later
// save. Points are written to 0.01 mm (pressure, tilt and speed to 0.001),
// outlines to 0.001 mm: finer than any pen or print, and a third of the size
// of every digit a double has.

function number(value: number, scale: number): string {
  return Number.isFinite(value) ? String(Math.round(value * scale) / scale) : "0";
}

function pointsText(points: readonly unknown[]): string {
  const parts: string[] = [];
  for (const point of points) {
    if (!Array.isArray(point)) {
      parts.push(JSON.stringify(point) ?? "null");
      continue;
    }
    parts.push(`[${point.map((value, i) => (typeof value === "number" ? number(value, i < 2 ? 100 : 1000) : JSON.stringify(value))).join(",")}]`);
  }
  return `[${parts.join(",")}]`;
}

/** A balloon's outline as saved. */
function outlineText(outline: readonly unknown[]): string {
  const parts: string[] = [];
  for (const point of outline) {
    parts.push(Array.isArray(point) ? `[${point.map((value) => (typeof value === "number" ? number(value, 1000) : JSON.stringify(value))).join(",")}]` : (JSON.stringify(point) ?? "null"));
  }
  return `[${parts.join(",")}]`;
}

interface Idle {
  timeRemaining(): number;
}

const whenIdle = (run: (idle: Idle) => void): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1000 });
  else setTimeout(() => run({ timeRemaining: () => 8 }), 0);
};

let ahead = 0;

/**
 * Write the text of a name's point lists and outlines ahead, a page or more
 * at a time while the app is idle: a name just opened has none written, and
 * its first autosave would stop the screen to write them all (a heavy name,
 * a sixth of a second). The last name given is the one written.
 */
export function writeAhead(project: { pages: readonly unknown[] }, idle: (run: (idle: Idle) => void) => void = whenIdle): void {
  const run = ++ahead;
  let next = 0;
  const step = (time: Idle) => {
    if (run !== ahead) return;
    // At least a page each time: when the app is never idle, the time left is 0.
    do {
      const { strokes, lines } = project.pages[next++] as { strokes?: unknown; lines?: unknown };
      if (Array.isArray(strokes)) for (const stroke of strokes as { points?: unknown }[]) if (Array.isArray(stroke?.points)) listBytes(stroke.points, pointsText);
      if (Array.isArray(lines)) for (const line of lines as { balloon?: unknown }[]) if (Array.isArray(line?.balloon)) listBytes(line.balloon, outlineText);
    } while (next < project.pages.length && time.timeRemaining() > 2);
    if (next < project.pages.length) idle(step);
  };
  if (project.pages.length) idle(step);
}

/**
 * The saved text in pieces: text, and the point lists and outlines (most of
 * it) apart, so each is put in as its text or its bytes, made once.
 */
type Piece = string | { points: readonly unknown[] } | { outline: readonly unknown[] };

/** The JSON text of `project` as saved (compact). */
export function projectJson(project: unknown): string {
  return pieces(project)
    .map((piece) => (typeof piece === "string" ? piece : "points" in piece ? pointsText(piece.points) : outlineText(piece.outline)))
    .join("");
}

function pieces(project: unknown): Piece[] {
  const { pages } = project as { pages?: unknown };
  if (!Array.isArray(pages)) return [withLists(project)];
  // The pages (most of it) written each by `pagePieces`, the rest as any value; then put together.
  const mark = `\u0001pages${Math.random().toString(36).slice(2)}`;
  const [before, after] = withLists({ ...(project as object), pages: mark }).split(JSON.stringify(mark));
  const out: Piece[] = [before, "["];
  pages.forEach((page, i) => {
    if (i) out.push(",");
    pagePieces(page, out);
  });
  out.push("]", after);
  return out;
}

/** `json` with each `"key":0` in `put` (once each, in any order) replaced by what its function writes. */
function putIn(json: string, put: [string, () => void][], out: Piece[]): void {
  const at = put.map(([key, write]) => [json.indexOf(`"${key}":0`), key.length + 4, write] as const).sort((a, b) => a[0] - b[0]);
  let from = 0;
  for (const [index, length, write] of at) {
    out.push(json.slice(from, index + length - 1));
    write();
    from = index + length;
  }
  out.push(json.slice(from));
}

/**
 * A page as `withLists` writes it, quicker: its point lists are only in its
 * strokes and its balloons' outlines, so each is put in by its list and the
 * rest of the page is written without a replacer looking at every value. (A
 * key and its value written as `"strokes":0` cannot be inside a text, whose
 * quotes are escaped.)
 */
function pagePieces(page: unknown, out: Piece[]): void {
  const { strokes, lines } = page as { strokes?: unknown; lines?: unknown };
  if (!Array.isArray(strokes)) {
    out.push(withLists(page));
    return;
  }
  const list = (items: unknown[], write: (item: never) => void) => () => {
    out.push("[");
    items.forEach((item, i) => {
      if (i) out.push(",");
      write(item as never);
    });
    out.push("]");
  };
  const put: [string, () => void][] = [["strokes", list(strokes, strokePieces)]];
  // Its lines of dialogue the same way, with each balloon's outline put in.
  if (Array.isArray(lines)) put.push(["lines", list(lines, linePieces)]);
  putIn(JSON.stringify({ ...(page as object), strokes: 0, ...(Array.isArray(lines) ? { lines: 0 } : {}) }), put, out);

  function strokePieces(stroke: { points?: unknown }): void {
    const { points } = stroke;
    if (!Array.isArray(points)) out.push(withLists(stroke));
    else putIn(JSON.stringify({ ...stroke, points: 0 }), [["points", () => out.push({ points })]], out);
  }
  function linePieces(line: { balloon?: unknown }): void {
    const { balloon } = line;
    if (!Array.isArray(balloon)) out.push(JSON.stringify(line));
    else putIn(JSON.stringify({ ...line, balloon: 0 }), [["balloon", () => out.push({ outline: balloon })]], out);
  }
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

const encoder = new TextEncoder();
const bytes = new WeakMap<object, Uint8Array>();

/** A list's text as UTF-8, made once (encoding the whole text each save took most of its time). */
function listBytes(list: readonly unknown[], text: (list: readonly unknown[]) => string): Uint8Array {
  let made = bytes.get(list);
  if (!made) {
    made = encoder.encode(text(list));
    bytes.set(list, made);
  }
  return made;
}

/**
 * A request body for the commands that save the project: `[u32 length][meta
 * JSON][project text]`, so the text travels as bytes and is saved as it is.
 */
export function projectBody(meta: unknown, project: unknown): Uint8Array {
  const head = encoder.encode(JSON.stringify(meta));
  const parts = pieces(project);
  // The text between the lists encoded at once, parted by a character JSON never writes as itself.
  const strings = parts.filter((piece) => typeof piece === "string");
  const texts = encoder.encode(strings.join("\u0000"));
  let length = 4 + head.length + texts.length - Math.max(0, strings.length - 1);
  const lists = parts.map((piece) => (typeof piece === "string" ? null : "points" in piece ? listBytes(piece.points, pointsText) : listBytes(piece.outline, outlineText)));
  for (const list of lists) if (list) length += list.length;
  const body = new Uint8Array(length);
  new DataView(body.buffer).setUint32(0, head.length, true);
  body.set(head, 4);
  let at = 4 + head.length;
  let from = 0;
  for (const list of lists) {
    if (list) {
      body.set(list, at);
      at += list.length;
      continue;
    }
    const end = texts.indexOf(0, from);
    const until = end < 0 ? texts.length : end;
    body.set(texts.subarray(from, until), at);
    at += until - from;
    from = until + 1;
  }
  return body;
}
