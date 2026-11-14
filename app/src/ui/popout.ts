// 欄を別のウィンドウへ: a palette taken out of the main window into a window
// of its own, which can go onto another display (マルチディスプレイ).
//
// The window is the main window's popup (`window.open("")`; in the app the
// backend makes it, lib.rs `palette_window`). The palette's body moves into it
// as it is: the main window's script keeps running it (its clicks, its
// redrawing), so nothing is copied or kept in step but the look — the styles
// and the theme are copied in, and again when they change. Keys pressed there
// go on to the main window (PageDown, Ctrl+Z…) unless typed into a field.
// Closing the window puts the palette back. Where each window was is kept, so
// it opens there again (on the display it was moved to).

import { call } from "../platform/backend";
import { PALETTE_WINDOWS_KEY } from "../platform/prefs";
import { outerDocuments } from "../platform/dom";
import { readJson, writeJson } from "../platform/settings";

export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** `x`, `y` in the screen's own pixels (as the app gave them), not the page's. */
  physical?: boolean;
}

/** Where a window is to open: a place, and (dragged out of the main window) the point of it held under the pointer. */
export interface WindowPlace extends WindowRect {
  grab?: { x: number; y: number };
}

interface Kept {
  /** Where each palette's window was last. */
  rects: Record<string, WindowRect>;
  /** The palettes that were out when the app last closed (opened out again on start, where it can). */
  open: string[];
}

function kept(): Kept {
  const value = readJson(PALETTE_WINDOWS_KEY, {}) as Partial<Kept> | null;
  return {
    rects: value && typeof value.rects === "object" && value.rects ? value.rects : {},
    open: Array.isArray(value?.open) ? value.open.filter((id: unknown): id is string => typeof id === "string") : [],
  };
}

function keep(change: (kept: Kept) => void): void {
  const now = kept();
  change(now);
  writeJson(PALETTE_WINDOWS_KEY, now);
}

/** The palettes that were out in windows of their own when the app last closed. */
export function palettesOut(): string[] {
  return kept().open;
}

/** Forget that `id` was out (it came back, or could not go out again). */
export function forgetOut(id: string): void {
  keep((k) => (k.open = k.open.filter((x) => x !== id)));
}

/** Sent to a palette's body when the window it is out in changes size. */
export const PALETTE_RESIZED = "palette-resized";

const FIELD = "input, textarea, select, [contenteditable='true']";

/** The main window's styles, as text (the window has no stylesheet of its own to load). */
function stylesText(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      parts.push(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"));
    } catch {
      // A sheet that cannot be read (none in the app) is left out.
    }
  }
  return parts.join("\n");
}

export class PaletteWindow {
  private readonly win: Window;
  private readonly style: HTMLStyleElement;
  private readonly watcher: MutationObserver;
  private closed = false;
  private readonly poll: number;
  /** Where the window is, as last seen (once it is shut it cannot be asked). */
  private last: WindowRect | null = null;
  /** The window's title (the app finds the window by it). */
  readonly windowTitle: string;

  private constructor(
    win: Window,
    private readonly id: string,
    title: string,
    body: HTMLElement,
    private readonly back: () => void,
  ) {
    this.win = win;
    this.windowTitle = `${title} — Name Studio`;
    const doc = win.document;
    this.style = doc.createElement("style");
    const named = doc.createElement("title");
    named.textContent = this.windowTitle;
    doc.head.replaceChildren(named, this.style);
    outerDocuments.add(doc);
    const main = doc.createElement("main");
    main.className = "palette-window";
    main.setAttribute("aria-label", title);
    main.append(body);
    doc.body.replaceChildren(main);
    this.syncLook();
    // The theme, custom CSS and the like change the main window's <html> and <head>.
    this.watcher = new MutationObserver(() => this.syncLook());
    this.watcher.observe(document.head, { childList: true, subtree: true, characterData: true });
    this.watcher.observe(document.documentElement, { attributes: true });
    doc.addEventListener("keydown", (event) => this.passKey(event));
    // What draws to its size (サブビュー) is told when the window's size changes: the main window's observers do not see it.
    win.addEventListener("resize", () => body.dispatchEvent(new Event(PALETTE_RESIZED)));
    win.addEventListener("pagehide", () => this.ended());
    // pagehide is not always told when the window is shut from outside.
    this.poll = window.setInterval(() => (win.closed ? this.ended() : this.look()), 1000);
  }

  /**
   * Opens `body` in a window of its own — at `at`, else where it was last, else beside where it was —
   * null when no window could be opened
   * (a browser blocking it, or the app not letting it).
   */
  static open(id: string, title: string, body: HTMLElement, back: () => void, near?: DOMRect, at?: WindowPlace): PaletteWindow | null {
    const beside: WindowRect = {
      x: Math.round(window.screenX + (near?.left ?? 80) + 24),
      y: Math.round(window.screenY + (near?.top ?? 80) + 24),
      w: Math.round(Math.max(near?.width ?? 300, 260)),
      h: Math.round(Math.max(near?.height ?? 420, 240)),
    };
    const rect: WindowPlace = at ?? kept().rects[id] ?? beside;
    // A place in the screen's own pixels means nothing to window.open: it opens beside, and the app moves it.
    const asked = rect.physical ? { ...beside, w: rect.w, h: rect.h } : rect;
    let win: Window | null = null;
    try {
      win = window.open("", `namestudio-${id}`, `popup,left=${asked.x},top=${asked.y},width=${asked.w},height=${asked.h}`);
    } catch {
      win = null;
    }
    if (!win) return null;
    keep((k) => {
      if (!k.open.includes(id)) k.open.push(id);
    });
    const out = new PaletteWindow(win, id, title, body, back);
    // The WebView keeps a window it opens on the main window's display: the app puts it where it was asked for
    // (another display, under the pointer it was let go with). Outside the app (no backend) it stays as opened.
    void call("place_palette_window", {
      place: {
        title: out.windowTitle,
        x: rect.grab?.x ?? rect.x,
        y: rect.grab?.y ?? rect.y,
        width: rect.w,
        height: rect.h,
        physical: !rect.grab && !!rect.physical,
        atCursor: !!rect.grab,
      },
    }).catch(() => undefined);
    return out;
  }

  /** Bring the window to the front (its icon pressed in the main window). */
  focus(): void {
    this.win.focus();
  }

  /** Put the palette back (the window closes). */
  close(): void {
    this.ended(true);
  }

  /** The main window going away: the window goes too, and opens again on the next start. */
  closeForNow(): void {
    this.ended(false, true);
  }

  /** Where the window is now: from the app (the screen's own pixels: any display), else as the page sees it. */
  private look(): void {
    if (!this.last?.physical) this.last = this.rect();
    call("palette_window_rect", { title: this.windowTitle })
      .then((r) => {
        if (r && !this.closed) this.last = { x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height), physical: true };
      })
      .catch(() => undefined);
  }

  private rect(): WindowRect {
    const win = this.win;
    return { x: win.screenX, y: win.screenY, w: win.innerWidth || win.outerWidth, h: win.innerHeight || win.outerHeight };
  }

  private syncLook(): void {
    const html = this.win.document.documentElement;
    for (const attribute of Array.from(html.attributes)) html.removeAttribute(attribute.name);
    for (const attribute of Array.from(document.documentElement.attributes)) html.setAttribute(attribute.name, attribute.value);
    this.style.textContent = `${stylesText()}\n.palette-window { position: fixed; inset: 0; display: flex; flex-direction: column; overflow: auto; padding: 8px; background: var(--panel, Canvas); }\n.palette-window > .panel { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }`;
  }

  /** A key pressed in the window (not typed into a field) goes on to the main window. */
  private passKey(event: KeyboardEvent): void {
    if ((event.target as Element | null)?.closest?.(FIELD)) return;
    const copy = new KeyboardEvent("keydown", event);
    if (!document.dispatchEvent(copy)) event.preventDefault();
  }

  private ended(byUs = false, forNow = false): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.poll);
    this.watcher.disconnect();
    outerDocuments.delete(this.win.document);
    // As the app last saw it (any display), else as the page sees it now.
    const rect = this.last?.physical || this.win.closed ? this.last : this.rect();
    if (rect) keep((k) => (k.rects[this.id] = rect));
    if (!forNow) forgetOut(this.id);
    // The body comes back into the main document (adopted) before the window goes.
    this.back();
    // In the app the window is closed by the app: the page's close() leaves the window itself on screen
    // (a WebView2 popup made by the app), still showing and still found by its title.
    if (byUs || forNow)
      call("close_palette_window", { title: this.windowTitle })
        .catch(() => undefined)
        .finally(() => {
          if (!this.win.closed) this.win.close();
        });
  }
}
