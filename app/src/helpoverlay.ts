// 画面のヘルプ: over the whole window, each part of the screen named with a
// line to it, what it is for and its keys as set now (OVERLAY_SPOTS). The
// screen stays as it is under it; a click, Esc or the help key again closes
// it. Its header starts the first-time guide and shows or hides the help bar.
import { placeCallouts, type Box, type CalloutRequest } from "./callouts";
import { comboOf } from "./shortcuts";
import { keyLabel, OVERLAY_SPOTS, type OverlaySpot } from "./helptopics";
import { helpBarShown, showHelpBar } from "./helpbar";

export interface HelpOverlayHost {
  keysOf(command: string): string[];
  /** The command a key press runs, if any (to close with the help key as set). */
  actionFor(combo: string): string | null;
  tour(): void;
  openShortcuts(): void;
}

const SVG = "http://www.w3.org/2000/svg";

/** A part on screen: shown, with some size, not under something hidden. */
function onScreen(node: Element | null): DOMRect | null {
  if (!(node instanceof HTMLElement) || node.closest("[hidden]")) return null;
  const box = node.getBoundingClientRect();
  if (box.width < 2 || box.height < 2 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) return null;
  return box;
}

const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

export class HelpOverlay {
  private readonly root: HTMLDivElement;
  private readonly lines: SVGSVGElement;
  private readonly labels: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly barToggle: HTMLButtonElement;

  constructor(private readonly host: HelpOverlayHost) {
    this.root = Object.assign(document.createElement("div"), { id: "help-overlay", className: "help-overlay", hidden: true });
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "画面のヘルプ");
    this.lines = document.createElementNS(SVG, "svg");
    this.lines.classList.add("help-lines");
    this.labels = Object.assign(document.createElement("div"), { className: "help-labels" });
    this.head = Object.assign(document.createElement("div"), { className: "help-head" });
    const button = (id: string, text: string, run: () => void) => {
      const node = Object.assign(document.createElement("button"), { id, type: "button", textContent: text });
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        run();
      });
      return node;
    };
    this.barToggle = button("help-bar-toggle", "", () => {
      showHelpBar(!helpBarShown());
      this.layout();
    });
    const close = button("help-close", "閉じる", () => this.close());
    close.className = "primary";
    this.head.append(
      Object.assign(document.createElement("h2"), { textContent: "画面のヘルプ" }),
      Object.assign(document.createElement("p"), { className: "help-intro" }),
      Object.assign(document.createElement("div"), { className: "help-head-actions" }),
    );
    this.head.lastElementChild!.append(
      button("help-tour", "使い方の案内", () => {
        this.close();
        this.host.tour();
      }),
      this.barToggle,
      button("help-keys", "キー設定…", () => {
        this.close();
        this.host.openShortcuts();
      }),
      close,
    );
    this.head.addEventListener("click", (event) => event.stopPropagation());
    this.root.append(this.lines, this.labels, this.head);
    this.root.addEventListener("click", () => this.close());
    document.body.append(this.root);
    window.addEventListener(
      "keydown",
      (event) => {
        if (this.root.hidden) return;
        // Every key is the overlay's while it is open; Esc and the help key close it.
        event.preventDefault();
        event.stopImmediatePropagation();
        const combo = comboOf(event);
        if (event.key === "Escape" || (combo && this.host.actionFor(combo) === "help.overlay")) this.close();
      },
      { capture: true },
    );
    window.addEventListener("resize", () => {
      if (!this.root.hidden) this.layout();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.root.hidden = false;
    this.layout();
    document.getElementById("help")?.setAttribute("aria-pressed", "true");
  }

  close(): void {
    this.root.hidden = true;
    document.getElementById("help")?.setAttribute("aria-pressed", "false");
  }

  /** The words of the spots on screen now, each beside its part. */
  private layout(): void {
    const keys = (command?: string) => (command ? this.host.keysOf(command).slice(0, 2).map(keyLabel) : []);
    const overlay = keys("help.overlay")[0];
    this.head.querySelector(".help-intro")!.textContent = `画面の各部の名前と使い方です。もっと細かいことは、ポインターを置くと下のヘルプの帯に出ます。クリック${overlay ? `・${overlay}` : ""}・Esc で閉じます。`;
    this.barToggle.textContent = helpBarShown() ? "ヘルプの帯を隠す" : "ヘルプの帯を出す";
    const spots: { spot: OverlaySpot; box: DOMRect; node: HTMLElement }[] = [];
    const seen = new Set<Element>();
    for (const spot of OVERLAY_SPOTS) {
      const node = document.querySelector<HTMLElement>(spot.target);
      const box = onScreen(node);
      if (!node || !box || seen.has(node)) continue;
      seen.add(node);
      spots.push({ spot, box, node });
    }
    // The words first, to know their size.
    const made = spots.map(({ spot }) => {
      const label = Object.assign(document.createElement("div"), { className: `help-label ${spot.side}` });
      const title = Object.assign(document.createElement("div"), { className: "help-label-title" });
      title.append(Object.assign(document.createElement("b"), { textContent: spot.name }));
      for (const key of keys(spot.command)) title.append(Object.assign(document.createElement("kbd"), { textContent: key }));
      label.append(title);
      if (spot.text) label.append(Object.assign(document.createElement("div"), { className: "help-label-text", textContent: spot.text }));
      return label;
    });
    this.labels.replaceChildren(...made);
    const head = this.head.getBoundingClientRect();
    const requests: CalloutRequest[] = spots.map(({ spot, box }, i) => ({ anchor: boxOf(box), side: spot.side, width: made[i].offsetWidth, height: made[i].offsetHeight }));
    // The tools' words first (they line up with their buttons), then the bars', then the large parts' around them.
    const rank = { right: 0, above: 1, below: 2, inside: 3 };
    const order = requests.map((_, i) => i).sort((a, b) => rank[requests[a].side] - rank[requests[b].side]);
    const placed = placeCallouts(
      order.map((i) => requests[i]),
      { width: innerWidth, height: innerHeight },
      [boxOf(head)],
    );
    const marks: SVGElement[] = [];
    order.forEach((i, k) => {
      const { label, line } = placed[k];
      made[i].style.left = `${label.left}px`;
      made[i].style.top = `${label.top}px`;
      const box = spots[i].box;
      const frame = document.createElementNS(SVG, "rect");
      const pad = spots[i].spot.side === "inside" ? -3 : 2;
      for (const [name, value] of Object.entries({ x: box.left - pad, y: box.top - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, rx: 6 })) frame.setAttribute(name, String(value));
      frame.setAttribute("class", spots[i].spot.side === "inside" ? "help-area" : "help-target");
      marks.push(frame);
      if (line) {
        const path = document.createElementNS(SVG, "line");
        for (const [name, value] of Object.entries({ x1: line[0], y1: line[1], x2: line[2], y2: line[3] })) path.setAttribute(name, String(value));
        path.setAttribute("class", "help-line");
        const dot = document.createElementNS(SVG, "circle");
        for (const [name, value] of Object.entries({ cx: line[0], cy: line[1], r: 2.5 })) dot.setAttribute(name, String(value));
        dot.setAttribute("class", "help-dot");
        marks.push(path, dot);
      }
    });
    this.lines.setAttribute("viewBox", `0 0 ${innerWidth} ${innerHeight}`);
    this.lines.replaceChildren(...marks);
  }
}
