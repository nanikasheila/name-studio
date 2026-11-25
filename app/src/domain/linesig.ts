// Fingerprints of lines and of the name's parts, to tell later what changed
// in CSP and what in the name. `lineSignature` is the Rust side's
// `line_signature` (csp-format `shape_signature` of one line): FNV-1a over
// the point count and the points rounded to the pixel, as little-endian i64.

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** Rust's `f64::round`: halves away from zero. */
function roundAway(value: number): bigint {
  return BigInt(Math.sign(value) * Math.round(Math.abs(value)));
}

/** The fingerprint of a set of lines (csp-format `shape_signature`; points in canvas px). */
export function shapeSignature(lines: readonly (readonly (readonly number[])[])[]): string {
  let hash = OFFSET;
  const feed = (value: bigint) => {
    let word = BigInt.asUintN(64, value);
    for (let i = 0; i < 8; i++) {
      hash ^= word & 0xffn;
      hash = (hash * PRIME) & MASK;
      word >>= 8n;
    }
  };
  for (const points of lines) {
    feed(BigInt(points.length));
    for (const point of points) {
      feed(roundAway(point[0]));
      feed(roundAway(point[1]));
    }
  }
  return `${lines.length}:${hash.toString(16).padStart(16, "0")}`;
}

/** The fingerprint CSP's copy of a line is known by (points in canvas px). */
export function lineSignature(points: readonly (readonly number[])[]): string {
  return shapeSignature([points]);
}

/** A short hash of any JSON-like value (FNV-1a 32 over its JSON). */
export function valueHash(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
