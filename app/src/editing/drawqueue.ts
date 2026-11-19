// 作画's requests in line: each 頼む (or 修正・頼み直す・伝える) is a job that
// waits its turn. Up to `lanes` jobs are drawn at once, each in a lane of its
// own (a conversation of its own with the AI, gone on with by the next job in
// that lane); a job whose panels another job is drawing waits for it (the
// same panel is drawn in turn, its take numbers following on), and words to
// the AI (伝える) wait for their own conversation. Pure: the palette starts
// what `next` gives and says when each ends.
import type { BackgroundTarget } from "../domain/bgrequest";

export type JobState = "waiting" | "running" | "done" | "failed" | "stopped";

export interface DrawJob {
  id: number;
  /** What the job is, short (P3 コマ2 ほか 2 コマ・修正 など). */
  title: string;
  /** The panels it draws (none for words to the AI). */
  targets: BackgroundTarget[];
  /** 今回の注文. */
  note: string;
  /** 伝える: words said in a lane's conversation. */
  words?: string;
  /** The lane it runs (or ran) in; a job of words is given its lane from the start. */
  lane: number | null;
  state: JobState;
  /** The AI's turn, once started. */
  run: number | null;
  /** When it was asked, started and ended (ms). */
  asked: number;
  started?: number;
  ended?: number;
  /** Its stretch of the lane's conversation: [from, to). */
  from?: number;
  to?: number;
  /** 止める pressed while it ran. */
  stopping?: boolean;
  /** Why it failed (the first line). */
  error?: string;
}

/** At most this many jobs at once. */
export const MAX_LANES = 4;
/** Finished jobs kept in the list (the oldest go). */
const KEEP_DONE = 12;

export const isOpen = (job: DrawJob) => job.state === "waiting" || job.state === "running";

export class DrawQueue {
  jobs: DrawJob[] = [];
  private lastId = 0;
  /** The lane that last drew each panel (its conversation knows the panel). */
  private readonly laneOf = new Map<string, number>();

  add(job: Pick<DrawJob, "title" | "targets" | "note"> & Partial<Pick<DrawJob, "words" | "lane">>, now: number): DrawJob {
    const added: DrawJob = { ...job, id: ++this.lastId, lane: job.lane ?? null, state: "waiting", run: null, asked: now };
    this.jobs.push(added);
    return added;
  }

  get(id: number): DrawJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  byRun(run: number): DrawJob | undefined {
    return this.jobs.find((job) => job.run === run && job.state === "running");
  }

  get running(): DrawJob[] {
    return this.jobs.filter((job) => job.state === "running");
  }

  get waiting(): DrawJob[] {
    return this.jobs.filter((job) => job.state === "waiting");
  }

  /** A lane drawing now. */
  busy(lane: number): boolean {
    return this.jobs.some((job) => job.state === "running" && job.lane === lane);
  }

  /**
   * The waiting jobs to start now (each marked running in its lane), in the order asked:
   * up to `lanes` at once, a panel drawn by one job at a time, words in their own lane.
   */
  next(lanes: number, now: number): DrawJob[] {
    const limit = Math.max(1, Math.min(MAX_LANES, Math.floor(lanes) || 1));
    const drawing = new Set(this.running.flatMap((job) => job.targets.map((target) => target.panel)));
    const started: DrawJob[] = [];
    for (const job of this.jobs) {
      if (job.state !== "waiting") continue;
      const panels = job.targets.map((target) => target.panel);
      const blocked = panels.some((panel) => drawing.has(panel));
      // Later jobs for these panels wait behind this one, in the order asked.
      for (const panel of panels) drawing.add(panel);
      if (blocked) continue;
      let lane: number | null = job.lane;
      if (lane === null) {
        const free = [...Array(limit).keys()].filter((one) => !this.busy(one));
        // The lane that drew these panels before knows them; else the first free one.
        lane = free.find((one) => panels.some((panel) => this.laneOf.get(panel) === one)) ?? free[0] ?? null;
      } else if (this.busy(lane)) lane = null;
      if (lane === null) continue;
      job.lane = lane;
      job.state = "running";
      job.started = now;
      for (const panel of panels) this.laneOf.set(panel, lane);
      started.push(job);
    }
    return started;
  }

  /** A job ended (its turn done, failed, or stopped); the oldest finished ones beyond those kept go. */
  end(job: DrawJob, state: "done" | "failed" | "stopped", now: number, error?: string): void {
    job.state = job.stopping ? "stopped" : state;
    job.ended = now;
    if (error && job.state === "failed") job.error = error.split("\n")[0];
    this.trim();
  }

  /** 止める: a waiting job leaves the line (true); a running one is to be stopped by its turn (false). */
  stop(job: DrawJob, now: number): boolean {
    if (job.state === "waiting") {
      job.state = "stopped";
      job.ended = now;
      this.trim();
      return true;
    }
    if (job.state === "running") job.stopping = true;
    return false;
  }

  /** 済みを消す: the finished jobs go from the list. */
  clearDone(): void {
    this.jobs = this.jobs.filter(isOpen);
  }

  /** A lane's conversation begun anew (another AI): what it knew of the panels goes. */
  forgetLane(lane: number): void {
    for (const [panel, one] of this.laneOf) if (one === lane) this.laneOf.delete(panel);
  }

  /** What each panel waits for or is having drawn now. */
  panelStates(): Map<string, DrawJob> {
    const out = new Map<string, DrawJob>();
    for (const job of this.running) for (const target of job.targets) out.set(target.panel, job);
    for (const job of this.waiting) for (const target of job.targets) if (!out.has(target.panel)) out.set(target.panel, job);
    return out;
  }

  private trim(): void {
    const done = this.jobs.filter((job) => !isOpen(job));
    if (done.length <= KEEP_DONE) return;
    const gone = new Set(done.slice(0, done.length - KEEP_DONE));
    this.jobs = this.jobs.filter((job) => !gone.has(job));
  }
}
