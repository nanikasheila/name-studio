// ヘルプの帯: the bar under the window names what is under the pointer and
// what the mouse and the keys do with it (the keys as set in キー設定), as
// a DAW's info bar does. On the pages it follows the tool in hand and what
// the select tool would grab; elsewhere a part's own words (its tooltip).
// Hidden or shown in 設定 › 表示, kept on this computer.
import { $ } from "./dom";
import type { PageEditor } from "./editor";
import { AREA_TOPICS, HOVER_TOPICS, TOOL_TOPICS, heldFrom, keyLabel, shownSteps, topicFromWords, type HelpTopic } from "./helptopics";
import { HELP_BAR_KEY } from "./prefs";
import { readFlag, writeFlag } from "./settings";

const listeners: ((shown: boolean) => void)[] = [];

/** Whether the help bar is shown (out of the box: yes). */
export function helpBarShown(): boolean {
  return readFlag(HELP_BAR_KEY, true);
}

export function showHelpBar(shown: boolean): void {
  writeFlag(HELP_BAR_KEY, shown);
  for (const listener of listeners) listener(shown);
}

export interface HelpBarHost {
  /** The page editor, while a name is open. */
  editor(): PageEditor | null;
  keysOf(command: string): string[];
}

/** The tool button's topic: the tool, its key, and holding the key to borrow it. */
function toolButtonTopic(tool: string): HelpTopic | null {
  const topic = TOOL_TOPICS[tool];
  if (!topic) return null;
  return {
    name: topic.name.replace(/（.*）$/, ""),
    what: topic.what,
    steps: [
      { input: "クリック", does: "持ち替える" },
      { command: `tool.${tool}`, does: "持ち替える" },
      { command: `tool.${tool}`, hold: true, does: "その間だけ持ち替える" },
    ],
  };
}

/** The words a part shows (a button's label), short enough to be its name. */
function labelOf(node: HTMLElement): string {
  const aria = node.getAttribute("aria-label");
  if (aria) return aria;
  if (!["BUTTON", "LABEL"].includes(node.tagName)) return "";
  const text = (node.textContent ?? "").trim();
  return text.length <= 16 ? text : "";
}

export class HelpBar {
  private readonly bar = $("help-bar");
  private target: Element | null = null;
  private y = 0;
  private held = new Set<string>();
  private space = false;
  private frame = 0;
  /** What is shown now, so an unchanged bar is not built again. */
  private shown = "";

  constructor(private readonly host: HelpBarHost) {
    window.addEventListener(
      "pointermove",
      (event) => {
        this.target = event.target as Element | null;
        this.y = event.clientY;
        this.request();
      },
      { passive: true },
    );
    window.addEventListener("pointerup", () => this.request());
    // What the select tool would grab is worked out in the page editor's own frame: it says when that changed.
    $("editor-canvas").addEventListener("hoverchange", () => this.request());
    document.addEventListener("mouseout", (event) => {
      if (event.relatedTarget) return;
      this.target = null;
      this.request();
    });
    const keys = (event: KeyboardEvent) => {
      if (event.code === "Space") this.space = event.type === "keydown";
      this.held = heldFrom(event, this.space);
      this.request();
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    window.addEventListener("blur", () => {
      this.space = false;
      this.held = new Set();
      this.request();
    });
    $("help-bar-hide").addEventListener("click", () => showHelpBar(false));
    listeners.push(() => this.apply());
    this.apply();
  }

  private apply(): void {
    this.bar.hidden = !helpBarShown();
    this.shown = "";
    this.request();
  }

  /** Look again on the next frame, however often asked. */
  request(): void {
    if (this.frame || this.bar.hidden) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** The topic for what is under the pointer, or null for nothing in particular. */
  topic(): HelpTopic | null {
    for (let node = this.target; node && node !== document.body; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.id === "editor-canvas") return this.canvasTopic();
      if (node.classList.contains("board-scroll")) {
        const lane = this.laneAt(node);
        if (lane) return lane;
      }
      if (node.classList.contains("inline-edit")) return AREA_TOPICS["inline-edit"];
      if (node.classList.contains("action-bar") && !node.title) return AREA_TOPICS["action-bar"];
      if (node.id.startsWith("tool-")) {
        const tool = toolButtonTopic(node.id.slice(5));
        if (tool) return tool;
      }
      const words = node.dataset.words ?? node.getAttribute("title");
      if (words) return topicFromWords(words, labelOf(node), node.dataset.command);
      if (AREA_TOPICS[node.id]) return AREA_TOPICS[node.id];
    }
    return null;
  }

  /** On the pages: the tool in hand, or what the select tool would grab. */
  private canvasTopic(): HelpTopic | null {
    const editor = this.host.editor();
    if (!editor) return null;
    const hovered = editor.tool === "select" ? editor.hovered : null;
    if (hovered && HOVER_TOPICS[hovered]) return HOVER_TOPICS[hovered];
    if (editor.tool === "cut" && editor.panelMode !== "cut") return TOOL_TOPICS[`cut.${editor.panelMode}`];
    return TOOL_TOPICS[editor.tool] ?? null;
  }

  /** 物語の帯: the lane at the pointer's height, by the label beside it. */
  private laneAt(scroller: HTMLElement): HelpTopic | null {
    const labels = scroller.parentElement?.querySelectorAll<HTMLElement>(".board-label") ?? [];
    for (const label of labels) {
      const box = label.getBoundingClientRect();
      if (this.y >= box.top && this.y < box.bottom && label.title) return topicFromWords(label.title, label.textContent ?? "");
    }
    return null;
  }

  private render(): void {
    const topic = this.topic();
    const steps = topic ? shownSteps(topic, (id) => this.host.keysOf(id), this.held) : [];
    const key = JSON.stringify([topic?.name, topic?.what, steps]);
    if (key === this.shown) return;
    this.shown = key;
    const parts: HTMLElement[] = [];
    const span = (className: string, text: string) => Object.assign(document.createElement("span"), { className, textContent: text });
    if (topic) {
      parts.push(span("help-name", topic.name));
      if (topic.what) parts.push(span("help-what", topic.what));
      for (const step of steps) {
        const item = span(step.held ? "help-step held" : "help-step", "");
        item.append(Object.assign(document.createElement("kbd"), { textContent: step.input }), document.createTextNode(step.does));
        parts.push(item);
      }
    } else {
      const overlay = this.host.keysOf("help.overlay")[0];
      const palette = this.host.keysOf("palette.commands")[0];
      parts.push(
        span(
          "help-idle",
          `ポインターの下にあるものの名前と操作がここに出ます${overlay ? `。${keyLabel(overlay)} で画面全体のヘルプ` : ""}${palette ? `、${keyLabel(palette)} で命令を探す` : ""}`,
        ),
      );
    }
    $("help-bar-text").replaceChildren(...parts);
  }
}
