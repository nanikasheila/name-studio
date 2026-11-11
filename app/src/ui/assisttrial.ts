// 変更の案を画面で見る: a 変更の案 from 相談 put on the name for a look before
// it is kept. It is made as one undoable step and shown at the first page it
// changed; a bar over the pages goes through the changed pages, shows the
// name as it was (変更前を見る, by undo and redo), and ends it: 採用 keeps it,
// 却下 takes it back. What the user does meanwhile (an undo, a line drawn) is
// followed by comparing the name with how it was before and after.
import { applyOps, nameChanges, previewOps, type AssistOp, type NameChanges } from "../domain/assist";
import type { Project } from "../model/model";
import { element, plainButton } from "../platform/dom";

export interface TrialHost {
  project(): Project | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  undo(): void;
  redo(): void;
  /** Another value after any change, undo or another name opened ("name:revision"). */
  version(): string;
  /** Put `project` in place of the open name, as one step that can be undone. */
  restore(project: Project): void;
  openPage(number: number): void;
  status(message: string): void;
}

/** How a look at a 変更の案 ended. */
export type TrialEnd = "adopted" | "rejected" | "dropped";

/** A cheap fingerprint of a name, to tell whether it changed. */
export function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

const stamp = (project: Project | null): string => (project ? fingerprint(JSON.stringify(project)) : "");

interface Trial {
  /** Whose and which card it is (the conversation, and where in it). */
  owner: string;
  key: string;
  ops: AssistOp[];
  before: Project;
  beforeStamp: string;
  afterStamp: string;
  /** The name's version as last seen. */
  version: string;
  showing: "after" | "before";
  /** The user changed the name while it was shown as it was after (or before) the 案. */
  edited: "after" | "before" | null;
  changes: NameChanges;
  /** The changed page shown last (in `changes.pages`). */
  at: number;
  /** 却下 pressed once with changes made since: the next press takes those back too. */
  armed: boolean;
}

export class AssistTrial {
  private now: Trial | null = null;
  /** Our own undo, redo or change is under way: the name is followed after it, not during. */
  private busy = false;

  constructor(
    private readonly host: TrialHost,
    /** A look ended (the card shows how). */
    private readonly ended: (owner: string, key: string, how: TrialEnd) => void,
    /** The cards follow what is being looked at. */
    private readonly changed: () => void,
  ) {}

  /** The card being looked at (`owner` and `key`), if any. */
  showingCard(owner: string, key: string): "after" | "before" | null {
    const t = this.now;
    return t && t.owner === owner && t.key === key ? t.showing : null;
  }

  get active(): boolean {
    return this.now !== null;
  }

  /** Put a 変更の案 on the name to look at. False when it was not (nothing changes, it would break the name). */
  try(owner: string, key: string, ops: AssistOp[]): boolean {
    const project = this.host.project();
    if (!project) return false;
    if (this.now) {
      this.host.status("先に、画面に出している変更の案を採用か却下してください");
      return false;
    }
    // Checked on a copy first: a change that would leave the name unopenable is not made at all.
    if (previewOps(project, ops).broken) {
      this.host.status("この案を当てるとネームが開けなくなるので、当てませんでした");
      return false;
    }
    const before = structuredClone(project);
    const beforeStamp = stamp(project);
    let problems: string[] = [];
    this.busy = true;
    try {
      this.host.edit((name) => {
        problems = applyOps(name, ops).problems;
      });
    } finally {
      this.busy = false;
    }
    const after = this.host.project();
    const afterStamp = stamp(after);
    if (!after || afterStamp === beforeStamp) {
      this.host.status("この案ではネームは何も変わりません");
      return false;
    }
    const changes = nameChanges(before, after);
    this.now = {
      owner,
      key,
      ops,
      before,
      beforeStamp,
      afterStamp,
      version: this.host.version(),
      showing: "after",
      edited: null,
      changes,
      at: 0,
      armed: false,
    };
    this.go(0);
    this.host.status(
      `変更の案を画面に出しました（変わったページ ${changes.pages.length}${problems.length ? `・できなかった操作 ${problems.length}` : ""}）。上の帯で「採用」か「却下」を`,
    );
    this.render();
    this.changed();
    return true;
  }

  /** Keep it. */
  adopt(): void {
    const t = this.now;
    if (!t) return;
    if (t.edited === "before") {
      // Changed while shown as it was: the 案 goes on again over that.
      this.ownStep(() => this.host.edit((name) => void applyOps(name, t.ops)));
    } else if (t.showing === "before") this.toAfter(t);
    this.finish(t, "adopted");
    this.host.status("変更の案を採用しました（Ctrl+Z で戻せます）");
  }

  /** Take it back. */
  reject(): void {
    const t = this.now;
    if (!t) return;
    if (t.edited === "after") {
      if (!t.armed) {
        t.armed = true;
        this.render();
        this.host.status("案を出したあとに変えたところも元に戻ります。よければもう一度「却下」を（あとから Ctrl+Z で取り戻せます）");
        return;
      }
      this.ownStep(() => this.host.restore(structuredClone(t.before)));
      this.finish(t, "rejected");
      this.host.status("変更の案を却下し、案の前に戻しました（そのあとの変更も。Ctrl+Z で取り戻せます）");
      return;
    }
    if (t.showing === "after" && !t.edited) this.toBefore(t);
    this.finish(t, "rejected");
    this.host.status("変更の案を却下しました（ネームは元のまま）");
  }

  /** Show the name as it was before the 案, or after it again. */
  toggle(): void {
    const t = this.now;
    if (!t || t.edited) return;
    if (t.showing === "after") this.toBefore(t);
    else this.toAfter(t);
    this.go(t.at);
    this.render();
    this.changed();
  }

  /** The next (1) or previous (-1) changed page. */
  step(delta: number): void {
    const t = this.now;
    if (!t?.changes.pages.length) return;
    this.go((t.at + delta + t.changes.pages.length) % t.changes.pages.length);
    this.render();
  }

  /** After any change to the name (and when another is opened): follow what the user did. */
  sync(): void {
    const t = this.now;
    if (!t || this.busy) return;
    const version = this.host.version();
    if (version === t.version) return;
    if (version.split(":")[0] !== t.version.split(":")[0]) {
      // Another name: nothing to keep or take back here.
      this.now = null;
      this.ended(t.owner, t.key, "dropped");
      this.render();
      this.changed();
      return;
    }
    this.follow(t);
    this.render();
    this.changed();
  }

  /** Where the name is now, by comparing it with before and after the 案. */
  private follow(t: Trial): void {
    t.version = this.host.version();
    const now = stamp(this.host.project());
    if (now === t.afterStamp) {
      t.showing = "after";
      t.edited = null;
    } else if (now === t.beforeStamp) {
      t.showing = "before";
      t.edited = null;
    } else if (!t.edited) t.edited = t.showing;
    t.armed = false;
  }

  private toBefore(t: Trial): void {
    this.ownStep(() => this.host.undo());
    if (stamp(this.host.project()) !== t.beforeStamp) {
      // Not the step it was (should not happen): back the way it was by the snapshot.
      this.ownStep(() => this.host.restore(structuredClone(t.before)));
    }
    this.follow(t);
  }

  private toAfter(t: Trial): void {
    const was = this.host.version();
    this.ownStep(() => this.host.redo());
    if (stamp(this.host.project()) !== t.afterStamp) {
      // Redo brought something else (or nothing): that is undone and the 案 put on again.
      if (this.host.version() !== was) this.ownStep(() => this.host.undo());
      this.ownStep(() => this.host.edit((name) => void applyOps(name, t.ops)));
      t.afterStamp = stamp(this.host.project());
    }
    this.follow(t);
  }

  private ownStep(step: () => void): void {
    this.busy = true;
    try {
      step();
    } finally {
      this.busy = false;
    }
  }

  private finish(t: Trial, how: TrialEnd): void {
    this.now = null;
    this.ended(t.owner, t.key, how);
    this.render();
    this.changed();
  }

  /** Show the changed page `at` (a page the name does not have as it is shown is said so). */
  private go(at: number): void {
    const t = this.now;
    if (!t) return;
    t.at = at;
    const id = t.changes.pages[at];
    if (!id) return;
    const index = this.host.project()?.pages.findIndex((page) => page.id === id) ?? -1;
    if (index >= 0) this.busyOpen(index + 1);
    else this.host.status("このページは変更前にはありません（案で足すページです）");
  }

  private busyOpen(number: number): void {
    this.ownStep(() => this.host.openPage(number));
  }

  /** The bar over the pages. */
  private render(): void {
    const bar = document.getElementById("assist-trial");
    if (!bar) return;
    const t = this.now;
    bar.hidden = !t;
    if (!t) {
      bar.replaceChildren();
      return;
    }
    const project = this.host.project();
    const numbers = t.changes.pages.map((id) => {
      const index = project?.pages.findIndex((page) => page.id === id) ?? -1;
      return index >= 0 ? `p${index + 1}` : "（足すページ）";
    });
    const what = [
      numbers.length ? `変わったページ ${numbers.join("・")}` : "",
      t.changes.removed ? `消すページ ${t.changes.removed}` : "",
      t.changes.other.length ? `ほか ${t.changes.other.join("・")}` : "",
    ].filter(Boolean);
    const title = element(
      "strong",
      {},
      t.edited ? "変更の案を表示中（そのあと手を入れています）" : t.showing === "after" ? "変更の案を表示中" : "変更前を表示中",
    );
    const prev = plainButton("◀", () => this.step(-1));
    prev.title = "前の変わったページへ";
    const next = plainButton("▶", () => this.step(1));
    next.title = "次の変わったページへ";
    prev.disabled = next.disabled = numbers.length < 2;
    const where = element("span", { className: "assist-trial-at" }, numbers.length ? `${t.at + 1}/${numbers.length}` : "");
    const compare = plainButton(t.showing === "after" ? "変更前を見る" : "変更後を見る", () => this.toggle());
    compare.disabled = t.edited !== null;
    compare.title = t.edited ? "案のあとに手を入れたので見比べられません" : "案の前と後を切り替えて見比べる";
    const adopt = plainButton("採用", () => this.adopt());
    adopt.className = "primary";
    adopt.title = "この案をネームに残す（Ctrl+Z で戻せます）";
    const reject = plainButton(t.armed ? "却下（変更も戻す）" : "却下", () => this.reject());
    reject.className = t.armed ? "danger" : "";
    reject.title = "この案を取りやめて、案の前のネームに戻す";
    bar.replaceChildren(
      element("div", { className: "assist-trial-text" }, title, element("span", {}, what.join("／") || "見た目だけの変更")),
      element("div", { className: "assist-trial-nav" }, prev, where, next),
      compare,
      adopt,
      reject,
    );
  }
}
