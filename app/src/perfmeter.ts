// How the app feels on this computer, measured as it is used: how long the
// pen's input takes to reach the screen, what each frame of a drag costs,
// when the main thread stopped (long animation frames, with what ran), how
// much memory the page holds, and how long the start took. Cheap enough to
// be always on; shown by the 動作の記録 dialog (perfdialog.ts) and read by
// the e2e tests and the measuring on a real PC (window.nameStudioPerf).

/** A frame (or task) that took longer than this stopped the screen (ms), as the browser counts it. */
export const LONG_FRAME_MS = 50;
const KEEP = 4000;
const KEEP_LONG = 12;
const HEAP_EVERY_MS = 30_000;
const KEEP_HEAP = 480;

/** Values kept in a ring: the last `KEEP` of them. */
class Ring {
  private values: number[] = [];
  private next = 0;
  count = 0;
  max = 0;

  add(value: number): void {
    if (this.values.length < KEEP) this.values.push(value);
    else this.values[this.next] = value;
    this.next = (this.next + 1) % KEEP;
    this.count++;
    this.max = Math.max(this.max, value);
  }

  summary(): Spread | null {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { count: this.count, median: round(at(0.5)), p95: round(at(0.95)), max: round(this.max) };
  }

  clear(): void {
    this.values = [];
    this.next = 0;
    this.count = 0;
    this.max = 0;
  }
}

export interface Spread {
  count: number;
  median: number;
  p95: number;
  max: number;
}

/** A frame that stopped the screen: how long, how much of it blocked input, and what ran longest in it. */
export interface LongFrame {
  /** When, in seconds since the app started. */
  at: number;
  duration: number;
  blocking: number;
  /** What the time went to: the longest scripts (function, file, ms). */
  scripts: string[];
}

export interface PerfReport {
  /** Pen input: from the event to the end of the drawing of the frame that shows it (ms). */
  penLatency: Spread | null;
  /** What one frame of a pen line costs on the main thread (ms). */
  penFrame: Spread | null;
  /** Time between the frames shown while a line is drawn (ms): above 1.5 frames, one was missed. */
  penInterval: Spread | null;
  /** The same as penLatency and penFrame for every other drag (moving, erasing, cutting…). */
  dragLatency: Spread | null;
  dragFrame: Spread | null;
  /** Pen input events per second while drawing (what the tablet reports, coalesced events counted). */
  penRate: number | null;
  /** Frames that stopped the screen for more than LONG_FRAME_MS. */
  long: { count: number; total: number; worst: LongFrame[]; supported: boolean };
  /** Used JS memory (MB): at the start, now, the most seen; null where the browser does not tell. */
  memory: { first: number; now: number; most: number; samples: [number, number][] } | null;
  /** From the app's start to the first screen (ms): the process when the Rust side told, and the page. */
  startup: { process: number | null; page: number } | null;
  /** What the open name holds (undo steps, pictures of lines kept…), as the workbench tells. */
  resources: Record<string, number>;
  /** Seconds since the app started. */
  uptime: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

export class PerfMeter {
  private readonly penLatency = new Ring();
  private readonly penFrame = new Ring();
  private readonly penInterval = new Ring();
  private readonly dragLatency = new Ring();
  private readonly dragFrame = new Ring();
  /** The oldest input not drawn yet (its time stamp) and the kind of drag it moved. */
  private waiting: { since: number; pen: boolean } | null = null;
  private lastPenFrame = 0;
  /** Pen events and the time they spanned, over the lines drawn (and the line being drawn). */
  private penEvents = 0;
  private penTime = 0;
  private line: { start: number; last: number; events: number } | null = null;
  private longCount = 0;
  private longTotal = 0;
  private worst: LongFrame[] = [];
  private longSupported = false;
  private heap: [number, number][] = [];
  private heapMost = 0;
  private started: { process: number | null; page: number } | null = null;
  private resourcesOf: () => Record<string, number> = () => ({});

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Watch for frames that stop the screen, and sample the memory now and then. */
  start(): void {
    if (typeof PerformanceObserver === "undefined") return;
    const types = PerformanceObserver.supportedEntryTypes ?? [];
    const type = types.includes("long-animation-frame") ? "long-animation-frame" : types.includes("longtask") ? "longtask" : null;
    if (type) {
      this.longSupported = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.longFrame(entry);
      }).observe({ type, buffered: true });
    }
    this.sampleHeap();
    setInterval(() => this.sampleHeap(), HEAP_EVERY_MS);
  }

  /** The workbench tells what the open name holds. */
  watchResources(of: () => Record<string, number>): void {
    this.resourcesOf = of;
  }

  /** The first screen was up at `page` (performance.now()); `processStartMs` is when the process began (epoch ms), if known. */
  ready(processStartMs: number | null, page = this.now()): void {
    const process = processStartMs === null ? null : performance.timeOrigin + page - processStartMs;
    this.started = { process: process !== null && process > 0 && process < 600_000 ? round(process) : null, page: round(page) };
  }

  /** A pointer moved during a drag: `timeStamp` of its oldest (coalesced) event; `count` events in it. */
  input(timeStamp: number, pen: boolean, count = 1): void {
    if (!this.waiting) this.waiting = { since: timeStamp, pen };
    if (!pen) return;
    this.line ??= { start: timeStamp, last: timeStamp, events: 0 };
    this.line.events += count;
    this.line.last = timeStamp;
  }

  /** A drag ended (input not drawn by then is drawn with the pages, not as a frame of it); a pen line's pause before the next is not drawing time. */
  dragEnded(): void {
    this.waiting = null;
    this.lastPenFrame = 0;
    if (!this.line) return;
    this.penEvents += this.line.events;
    this.penTime += this.line.last - this.line.start;
    this.line = null;
  }

  /** A frame of a drag was drawn, beginning at `start` (performance.now()). */
  drawn(start: number, pen: boolean): void {
    const end = this.now();
    (pen ? this.penFrame : this.dragFrame).add(end - start);
    if (this.waiting) {
      // Input stamped before the page began (a test's events) has no time to tell.
      if (this.waiting.since > 0) (this.waiting.pen ? this.penLatency : this.dragLatency).add(Math.max(0, end - this.waiting.since));
      this.waiting = null;
    }
    if (pen) {
      if (this.lastPenFrame) this.penInterval.add(start - this.lastPenFrame);
      this.lastPenFrame = start;
    }
  }

  private longFrame(entry: PerformanceEntry): void {
    const loaf = entry as PerformanceEntry & {
      blockingDuration?: number;
      scripts?: { duration: number; sourceFunctionName?: string; sourceURL?: string; invoker?: string }[];
    };
    if (entry.duration < LONG_FRAME_MS) return;
    this.longCount++;
    this.longTotal += entry.duration;
    const scripts = [...(loaf.scripts ?? [])]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 3)
      .map((s) => `${s.sourceFunctionName || s.invoker || "?"} ${(s.sourceURL ?? "").split("/").pop()} ${Math.round(s.duration)}ms`);
    const long: LongFrame = { at: round(entry.startTime / 1000), duration: round(entry.duration), blocking: round(loaf.blockingDuration ?? entry.duration - LONG_FRAME_MS), scripts };
    this.worst.push(long);
    this.worst.sort((a, b) => b.duration - a.duration);
    this.worst.length = Math.min(this.worst.length, KEEP_LONG);
  }

  private sampleHeap(): void {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (!memory) return;
    const mb = round(memory.usedJSHeapSize / 1048576);
    this.heap.push([round(this.now() / 1000), mb]);
    if (this.heap.length > KEEP_HEAP) this.heap.splice(0, this.heap.length - KEEP_HEAP);
    this.heapMost = Math.max(this.heapMost, mb);
  }

  private penRate(): number | null {
    const events = this.penEvents + (this.line?.events ?? 0);
    const time = this.penTime + (this.line ? this.line.last - this.line.start : 0);
    return time > 200 ? Math.round((events * 1000) / time) : null;
  }

  report(): PerfReport {
    this.sampleHeap();
    const heap = this.heap;
    return {
      penLatency: this.penLatency.summary(),
      penFrame: this.penFrame.summary(),
      penInterval: this.penInterval.summary(),
      dragLatency: this.dragLatency.summary(),
      dragFrame: this.dragFrame.summary(),
      penRate: this.penRate(),
      long: { count: this.longCount, total: round(this.longTotal), worst: [...this.worst], supported: this.longSupported },
      memory: heap.length ? { first: heap[0][1], now: heap[heap.length - 1][1], most: this.heapMost, samples: [...heap] } : null,
      startup: this.started,
      resources: this.resourcesOf(),
      uptime: round(this.now() / 1000),
    };
  }

  /** Start counting again (the start and the memory's first value stay). */
  reset(): void {
    for (const ring of [this.penLatency, this.penFrame, this.penInterval, this.dragLatency, this.dragFrame]) ring.clear();
    this.waiting = null;
    this.lastPenFrame = 0;
    this.penEvents = 0;
    this.penTime = 0;
    this.line = null;
    this.longCount = 0;
    this.longTotal = 0;
    this.worst = [];
  }
}

/** The app's one meter. */
export const perfMeter = new PerfMeter();
