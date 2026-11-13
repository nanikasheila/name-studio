// タイマー on screen: the time left in the bar at the top (always in sight),
// and under it, on a press, the timers themselves: ポモドーロ, a countdown
// (タイマー), a stopwatch with 区切る by page (計る) and アラーム. A break can
// cover the screen so the hand stops (設定 › タイマー).
import type { Command } from "../editing/commands";
import {
  type Alarm,
  type AlarmRepeat,
  addAlarm,
  addToCountdown,
  anyRunning,
  changeAlarm,
  chipView,
  COUNTDOWN_PRESETS,
  countdownLeft,
  countdownPaused,
  formatClock,
  formatElapsed,
  formatLength,
  lapLengths,
  lapStopwatch,
  nextAlarm,
  parseClock,
  parseLength,
  pauseCountdown,
  pausePomodoro,
  pauseStopwatch,
  PHASE_LABELS,
  phaseMs,
  pomodoroLeft,
  recentDays,
  removeAlarm,
  REPEAT_LABELS,
  resetCountdown,
  resetStopwatch,
  resumeCountdown,
  resumePomodoro,
  skipPhase,
  startCountdown,
  startPomodoro,
  startStopwatch,
  stopPomodoro,
  stopwatchElapsed,
  extendPomodoro,
} from "../editing/timers";
import { $, element } from "../platform/dom";
import { readText, writeText } from "../platform/settings";
import { SNOOZE_MS, type TimerClock } from "./timerclock";

export type TimerTab = "pomodoro" | "countdown" | "stopwatch" | "alarms";
const TABS: [TimerTab, string][] = [
  ["pomodoro", "ポモドーロ"],
  ["countdown", "タイマー"],
  ["stopwatch", "計る"],
  ["alarms", "アラーム"],
];
const TAB_KEY = "namestudio.timerTab";

const button = (label: string, run: () => void, title = "", className = ""): HTMLButtonElement => {
  const b = element("button", { type: "button", textContent: label, title, className });
  b.addEventListener("click", run);
  return b;
};

export class TimerPanel {
  private readonly chip = $<HTMLButtonElement>("timer-chip");
  private readonly chipText = $("timer-chip-text");
  readonly pop = element("div", { id: "timer-pop", className: "timer-pop" });
  private tab: TimerTab = (TABS.find(([id]) => id === readText(TAB_KEY))?.[0] as TimerTab) ?? "pomodoro";
  private readonly tabs = new Map<TimerTab, { tab: HTMLButtonElement; pane: HTMLElement }>();
  // ポモドーロ
  private readonly pPhase = element("span", { className: "tm-phase" });
  private readonly pTime = element("output", { className: "tm-time" });
  private readonly pDots = element("span", { className: "tm-dots" });
  private readonly pGoal = element("input", {
    type: "text",
    className: "tm-goal",
    placeholder: "このポモドーロでやること（例: p.5〜8 のネーム）",
    maxLength: 200,
  });
  private readonly pButtons = element("div", { className: "tm-buttons" });
  private readonly pNote = element("p", { className: "tm-note" });
  private readonly pWeek = element("div", { className: "tm-week", role: "img" });
  private readonly pToday = element("p", { className: "tm-note" });
  // タイマー
  private readonly cTime = element("output", { className: "tm-time" });
  private readonly cLength = element("input", {
    type: "text",
    className: "tm-length",
    placeholder: "25 / 1:30:00 / 90s",
    inputMode: "numeric",
  });
  private readonly cLabel = element("input", {
    type: "text",
    className: "tm-label",
    placeholder: "何のタイマー（例: p.3 のコマ割り）",
    maxLength: 80,
  });
  private readonly cButtons = element("div", { className: "tm-buttons" });
  // 計る
  private readonly sTime = element("output", { className: "tm-time" });
  private readonly sButtons = element("div", { className: "tm-buttons" });
  private readonly sLaps = element("ol", { className: "tm-laps" });
  // アラーム
  private readonly aNext = element("p", { className: "tm-note" });
  private readonly aList = element("ul", { className: "tm-alarms" });
  private readonly aTime = element("input", { type: "time", className: "tm-alarm-time", value: "12:00" });
  private readonly aLabel = element("input", { type: "text", placeholder: "何のアラーム（例: 締め切りの確認）", maxLength: 80 });
  private readonly aRepeat = element("select", { title: "くり返し" });
  private readonly rows = new Map<
    string,
    {
      li: HTMLLIElement;
      on: HTMLInputElement;
      time: HTMLInputElement;
      label: HTMLInputElement;
      repeat: HTMLSelectElement;
      when: HTMLElement;
      remove: HTMLButtonElement;
    }
  >();
  // 休憩のおおい
  private readonly cover = element("div", { id: "timer-cover", className: "timer-cover", hidden: true });
  private readonly coverTime = element("output", { className: "tm-cover-time" });
  private readonly coverPhase = element("p", { className: "tm-cover-phase" });
  /** The break whose cover was put aside (its end), so it is not shown again. */
  private coverAside: number | null = null;
  private pressing = false;
  private readonly settingsButton: HTMLButtonElement;

  constructor(
    private readonly clock: TimerClock,
    /** 設定 › タイマー; false when it cannot be opened now (no name open). */
    private readonly openSettings: () => boolean,
  ) {
    document.body.append(this.pop, this.cover);
    if ("showPopover" in this.pop) this.pop.popover = "auto";
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-label", "タイマー");
    this.chip.popoverTargetElement = this.pop;
    this.pop.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState !== "open") return;
      this.render();
      this.place();
    });
    window.addEventListener("resize", () => this.isOpen() && this.place());

    const tabRow = element("div", { className: "tm-tabs", role: "tablist" });
    const panes = element("div", { className: "tm-panes" });
    for (const [id, label] of TABS) {
      const tab = element("button", { type: "button", textContent: label, id: `timer-tab-${id}` });
      tab.setAttribute("role", "tab");
      tab.addEventListener("click", () => this.show(id));
      const pane = element("section", { className: "tm-pane" });
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", tab.id);
      tabRow.append(tab);
      panes.append(pane);
      this.tabs.set(id, { tab, pane });
    }
    tabRow.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const i = TABS.findIndex(([id]) => id === this.tab);
      const next = TABS[(i + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
      this.show(next);
      this.tabs.get(next)?.tab.focus();
      event.preventDefault();
    });
    this.settingsButton = button(
      "設定…",
      () => {
        if (this.openSettings()) this.pop.hidePopover?.();
      },
      "長さ・音・Windows の通知・休憩のおおいなど（設定 › タイマー）",
    );
    this.pop.append(tabRow, panes, element("footer", { className: "tm-foot" }, this.settingsButton));

    // ポモドーロ
    this.pGoal.setAttribute("aria-label", "このポモドーロでやること");
    this.pGoal.addEventListener("change", () =>
      this.clock.update((st) => ({ ...st, pomodoro: { ...st.pomodoro, goal: this.pGoal.value.trim() } })),
    );
    this.pane("pomodoro").append(
      element("div", { className: "tm-face" }, this.pPhase, this.pTime, this.pDots),
      this.pGoal,
      this.pButtons,
      this.pNote,
      element("div", { className: "tm-log" }, this.pToday, this.pWeek),
    );
    // タイマー
    this.cLength.setAttribute("aria-label", "長さ（分。1:30:00・90s・1時間30分 とも）");
    this.cLength.title = "長さ: 数だけなら分。25:00・1:30:00・90s・1時間30分 のようにも書けます。Enter で始める";
    this.cLabel.setAttribute("aria-label", "何のタイマー");
    this.cLength.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.startCountdown();
      }
    });
    const presets = element(
      "div",
      { className: "tm-presets" },
      ...COUNTDOWN_PRESETS.map((min) =>
        button(
          `${min}`,
          () => {
            this.cLength.value = String(min);
            this.startCountdown();
          },
          `${formatLength(min * 60_000)}で始める`,
        ),
      ),
      element("span", { className: "tm-unit", textContent: "分" }),
    );
    this.pane("countdown").append(
      element("div", { className: "tm-face" }, this.cTime),
      element("div", { className: "tm-row" }, this.cLength, this.cLabel),
      presets,
      this.cButtons,
    );
    // 計る
    this.pane("stopwatch").append(
      element("div", { className: "tm-face" }, this.sTime),
      this.sButtons,
      element("p", {
        className: "tm-note",
        textContent: "区切ると、そのとき開いているページと一緒に残します（ページごとにかかった時間がわかります）。",
      }),
      this.sLaps,
    );
    // アラーム
    for (const [value, label] of Object.entries(REPEAT_LABELS)) this.aRepeat.append(element("option", { value, textContent: label }));
    this.aTime.setAttribute("aria-label", "鳴らす時刻");
    this.aLabel.setAttribute("aria-label", "何のアラーム");
    this.aRepeat.setAttribute("aria-label", "くり返し");
    const add = () => {
      const time = this.aTime.value;
      if (!parseClock(time)) return this.clock.host.status("アラームの時刻を入れてください（例: 21:00）");
      const label = this.aLabel.value.trim();
      this.clock.update(
        (st, now) => addAlarm(st, { time, label, repeat: this.aRepeat.value as AlarmRepeat }, now),
        `アラームを ${time}${label ? `「${label}」` : ""} に足しました`,
      );
      this.aLabel.value = "";
    };
    this.aLabel.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        add();
      }
    });
    this.pane("alarms").append(
      this.aNext,
      this.aList,
      element("div", { className: "tm-add" }, this.aTime, this.aLabel, this.aRepeat, button("足す", add, "このアラームを足す", "primary")),
    );

    // 休憩のおおい
    this.cover.setAttribute("role", "dialog");
    this.cover.setAttribute("aria-label", "休憩中");
    this.cover.append(
      element(
        "div",
        { className: "tm-cover-box" },
        this.coverPhase,
        this.coverTime,
        element("p", { className: "tm-cover-hint", textContent: "手を止めて、立って体を伸ばしましょう。目は遠くへ。" }),
        element(
          "div",
          { className: "tm-buttons" },
          button("休憩を飛ばして作業に戻る", () => this.clock.update((st, now) => skipPhase(st, this.clock.settings, now))),
          button(
            "おおいを外す",
            () => {
              this.coverAside = this.clock.state.pomodoro.endsAt;
              this.renderCover();
            },
            "休憩はそのまま、画面だけ使えるようにする",
          ),
        ),
      ),
    );
    // The cover waits for the pen to leave the paper.
    window.addEventListener("pointerdown", () => (this.pressing = true), true);
    window.addEventListener("pointerup", () => (this.pressing = false), true);
    window.addEventListener("pointercancel", () => (this.pressing = false), true);

    // The notice of a timer that rang is at the top, under the timers: they give way.
    clock.onRing(() => this.isOpen() && this.pop.hidePopover());
    // Esc closes the timers before the editor sees it (which would take it for its own).
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this.isOpen()) return;
        event.stopPropagation();
        event.preventDefault();
        this.pop.hidePopover();
        this.chip.focus();
      },
      true,
    );
    clock.onChange(() => this.render());
    clock.onBeat(() => this.beat());
    this.render();
  }

  private pane(id: TimerTab): HTMLElement {
    const entry = this.tabs.get(id);
    if (!entry) throw new Error(id);
    return entry.pane;
  }

  isOpen(): boolean {
    return this.pop.matches(":popover-open");
  }

  /** Opened on `tab` (or the last one); again on the same tab: closed. */
  toggle(tab?: TimerTab): void {
    if (this.isOpen() && (!tab || tab === this.tab)) {
      this.pop.hidePopover();
      return;
    }
    if (tab) this.show(tab);
    if (!this.isOpen()) this.pop.showPopover();
    this.tabs.get(this.tab)?.tab.focus();
  }

  private show(tab: TimerTab): void {
    this.tab = tab;
    writeText(TAB_KEY, tab);
    this.render();
  }

  /** Under the timer in the bar at the top, its right edge at the chip's, inside the window. */
  private place(): void {
    const at = this.chip.getBoundingClientRect();
    const width = this.pop.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, at.right - width));
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${at.bottom + 6}px`;
  }

  // --- drawing ------------------------------------------------------------------------------

  render(): void {
    const { state, settings } = this.clock;
    const now = this.clock.now();
    for (const [id, { tab, pane }] of this.tabs) {
      const on = id === this.tab;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      pane.hidden = !on;
    }
    this.settingsButton.hidden = $("settings").hidden;

    // ポモドーロ
    const p = state.pomodoro;
    const idle = p.phase === null;
    if (document.activeElement !== this.pGoal) this.pGoal.value = p.goal;
    const dots = Math.max(1, settings.longEvery);
    this.pDots.textContent = idle ? "" : "●".repeat(Math.min(p.done, dots)) + "○".repeat(Math.max(0, dots - p.done));
    this.pDots.title = idle ? "" : `長い休憩まで: ${p.done} / ${dots} 回`;
    const waiting = !idle && p.endsAt === null && p.leftMs === phaseMs(settings, p.phase ?? "work");
    this.buttons(this.pButtons, `${p.phase}|${p.endsAt !== null}|${waiting}|${settings.workMin}`, () =>
      idle
        ? [button("始める", () => this.startPomodoro(), `作業 ${settings.workMin} 分から`, "primary")]
        : [
            p.endsAt !== null
              ? button("一時停止", () => this.clock.update(pausePomodoro))
              : button(
                  waiting ? `${PHASE_LABELS[p.phase ?? "work"]}を始める` : "再開",
                  () => this.clock.update(resumePomodoro),
                  "",
                  "primary",
                ),
            button(
              "次へ",
              () => this.clock.update((st, n) => skipPhase(st, this.clock.settings, n)),
              "今の作業・休憩を終えて次へ（途中で終えた作業は数えません）",
            ),
            button("+5 分", () => this.clock.update((st, n) => extendPomodoro(st, SNOOZE_MS, n)), "今の作業・休憩をあと 5 分"),
            button("止める", () => this.clock.update(stopPomodoro, "ポモドーロを止めました")),
          ],
    );
    this.pNote.textContent = `作業 ${settings.workMin} 分・休憩 ${settings.shortMin} 分、${settings.longEvery} 回ごとに長い休憩 ${settings.longMin} 分${
      settings.autoBreak ? "（休憩は自動で始まる）" : ""
    }`;
    const today = this.clock.today();
    this.pToday.textContent = `今日 ${today.count} 回・${formatLength(today.minutes * 60_000)}`;
    const week = recentDays(this.clock.log, now);
    const most = Math.max(1, ...week.map((day) => day.count));
    this.pWeek.setAttribute("aria-label", `この 7 日: ${week.map((day) => `${day.label} ${day.count} 回`).join("、")}`);
    this.pWeek.replaceChildren(
      ...week.map((day) => {
        const bar = element("i");
        bar.style.height = `${Math.round((day.count / most) * 100)}%`;
        return element(
          "div",
          { className: "tm-day", title: `${day.key}: ${day.count} 回・${formatLength(day.minutes * 60_000)}` },
          bar,
          element("span", { textContent: day.label }),
        );
      }),
    );

    // タイマー
    const c = state.countdown;
    if (document.activeElement !== this.cLength && !this.cLength.value) this.cLength.value = String(Math.round(c.totalMs / 60_000) || 1);
    if (document.activeElement !== this.cLabel && c.endsAt !== null) this.cLabel.value = c.label;
    this.buttons(this.cButtons, `${c.endsAt !== null}|${countdownPaused(c)}`, () => [
      c.endsAt !== null
        ? button("一時停止", () => this.clock.update(pauseCountdown))
        : countdownPaused(c)
          ? button("再開", () => this.clock.update(resumeCountdown), "", "primary")
          : button("始める", () => this.startCountdown(), "Enter でも", "primary"),
      button("+1 分", () => this.clock.update((st, n) => addToCountdown(st, 60_000, n))),
      button("+5 分", () => this.clock.update((st, n) => addToCountdown(st, SNOOZE_MS, n))),
      button("リセット", () => this.clock.update(resetCountdown)),
    ]);

    // 計る
    const s = state.stopwatch;
    this.buttons(this.sButtons, `${s.startedAt !== null}|${s.elapsedMs > 0}`, () => [
      s.startedAt !== null
        ? button("止める", () => this.clock.update(pauseStopwatch))
        : button(s.elapsedMs ? "続ける" : "始める", () => this.clock.update(startStopwatch), "", "primary"),
      button("区切る", () => this.lap(), "ここまでの時間を、開いているページと一緒に残す"),
      button("リセット", () => this.clock.update(resetStopwatch)),
    ]);
    const lengths = lapLengths(s.laps);
    this.sLaps.replaceChildren(
      ...s.laps
        .map((lap, i) =>
          element(
            "li",
            {},
            element("span", { className: "tm-lap-n", textContent: `${i + 1}` }),
            element("span", { className: "tm-lap-label", textContent: lap.label || "—" }),
            element("span", { className: "tm-lap-len", textContent: formatClock(lengths[i]) }),
            element("span", { className: "tm-lap-at", textContent: `計 ${formatClock(lap.atMs)}` }),
          ),
        )
        .reverse(),
    );

    // アラーム
    for (const id of [...this.rows.keys()]) if (!state.alarms.some((alarm) => alarm.id === id)) this.rows.delete(id);
    this.aList.replaceChildren(...state.alarms.map((alarm) => this.alarmRow(alarm)));
    if (!state.alarms.length)
      this.aList.append(element("li", { className: "tm-empty", textContent: "アラームはありません。下で時刻を入れて「足す」。" }));

    this.beat();
    this.renderCover();
  }

  /** An alarm's row: made once, its fields set again on each change (so a press after typing is not lost). */
  private alarmRow(alarm: Alarm): HTMLLIElement {
    const id = alarm.id;
    let row = this.rows.get(id);
    if (!row) {
      const on = element("input", { type: "checkbox" });
      on.addEventListener("change", () => this.clock.update((st, n) => changeAlarm(st, id, { on: on.checked }, n)));
      const time = element("input", { type: "time", className: "tm-alarm-time" });
      time.setAttribute("aria-label", "時刻");
      time.addEventListener(
        "change",
        () => time.value && this.clock.update((st, n) => changeAlarm(st, id, { time: time.value, on: true }, n)),
      );
      const label = element("input", { type: "text", placeholder: "（名前なし）", maxLength: 80 });
      label.setAttribute("aria-label", "何のアラーム");
      label.addEventListener("change", () => this.clock.update((st, n) => changeAlarm(st, id, { label: label.value.trim() }, n)));
      const repeat = element("select", { title: "くり返し" });
      repeat.setAttribute("aria-label", "くり返し");
      for (const [value, text] of Object.entries(REPEAT_LABELS)) repeat.append(element("option", { value, textContent: text }));
      repeat.addEventListener("change", () =>
        this.clock.update((st, n) => changeAlarm(st, id, { repeat: repeat.value as AlarmRepeat }, n)),
      );
      const when = element("small");
      const remove = button(
        "×",
        () => this.clock.update((st) => removeAlarm(st, id), `アラーム ${time.value} を消しました`),
        "このアラームを消す",
        "icon-button",
      );
      row = { li: element("li", {}, on, time, label, repeat, when, remove), on, time, label, repeat, when, remove };
      this.rows.set(id, row);
    }
    const now = this.clock.now();
    const { li, on, time, label, repeat, when, remove } = row;
    li.classList.toggle("off", !alarm.on);
    on.checked = alarm.on;
    on.title = alarm.on ? "鳴らす（外すと止める）" : "止めています";
    on.setAttribute("aria-label", `${alarm.time} のアラームを鳴らす`);
    remove.setAttribute("aria-label", `${alarm.time} のアラームを消す`);
    if (document.activeElement !== time) time.value = alarm.time;
    if (document.activeElement !== label) label.value = alarm.label;
    repeat.value = alarm.repeat;
    when.textContent =
      alarm.on && alarm.nextAt !== null
        ? `あと ${formatLength(Math.max(60_000, alarm.nextAt - now))}`
        : alarm.snoozedTo
          ? "あとで鳴らす"
          : "止めています";
    return li;
  }

  /**
   * A row of buttons made again only when what they are changes: a field's change
   * redraws the timers as its button is pressed, and a button made again would lose the press.
   */
  private buttons(box: HTMLElement, key: string, make: () => HTMLButtonElement[]): void {
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren(...make());
  }

  /** The time shown moves on (twice a second); the rest waits for a change. */
  beat(): void {
    const { state } = this.clock;
    const now = this.clock.now();
    const view = chipView(state, now);
    const alarm = nextAlarm(state);
    const running = anyRunning(state);
    this.chip.hidden = this.clock.settings.chip === "running" && !running && !alarm;
    this.chip.dataset.kind = view.kind;
    if (view.phase) this.chip.dataset.phase = view.phase === "work" ? "work" : "rest";
    else delete this.chip.dataset.phase;
    this.chip.classList.toggle("paused", view.paused);
    const alarmText = alarm ? `${alarm.alarm.time}` : "";
    const text = view.kind === "idle" ? alarmText : view.text;
    if (this.chipText.textContent !== text) this.chipText.textContent = text;
    this.chip.classList.toggle("has-alarm", view.kind === "idle" && !!alarm);
    const said = `${view.said}${alarm ? `。次のアラーム ${alarm.alarm.time}${alarm.alarm.label ? `「${alarm.alarm.label}」` : ""}` : ""}`;
    this.chip.title = `${said}\n・クリック: タイマー（ポモドーロ・タイマー・計る・アラーム）`;
    this.chip.setAttribute("aria-label", said);
    document.title = this.titled(
      document.title,
      view.kind === "idle" ? "" : `${view.paused ? "⏸" : view.phase === "work" ? "●" : view.phase ? "☕" : "⏱"} ${view.text}`,
    );
    if (!this.isOpen() && this.cover.hidden) return;

    const p = state.pomodoro;
    this.pPhase.textContent =
      p.phase === null ? "止まっています" : `${PHASE_LABELS[p.phase]}${p.endsAt === null ? "（止めています）" : ""}`;
    this.pPhase.dataset.phase = p.phase === null ? "" : p.phase === "work" ? "work" : "rest";
    this.pTime.textContent = formatClock(p.phase === null ? phaseMs(this.clock.settings, "work") : pomodoroLeft(p, now));
    this.cTime.textContent = formatClock(countdownLeft(state.countdown, now));
    this.sTime.textContent = formatElapsed(stopwatchElapsed(state.stopwatch, now));
    const next = nextAlarm(state);
    this.aNext.textContent = next
      ? `次は ${next.alarm.time}${next.alarm.label ? `「${next.alarm.label}」` : ""}（あと ${formatLength(Math.max(60_000, next.at - now))}）`
      : "鳴らすアラームはありません";
    this.coverTime.textContent = formatClock(pomodoroLeft(p, now));
    this.renderCover();
  }

  /** The window's title with the time in front ("● 12:34 — 第4話 — Name Studio"), so it shows on the taskbar. */
  private titled(title: string, time: string): string {
    const bare = title.replace(/^(?:[●☕⏸⏱] \d+(?::\d\d){1,2} — )/, "");
    return time ? `${time} — ${bare}` : bare;
  }

  /** 休憩のおおい: over the screen while a break runs (設定 › タイマー), once the pen is up. */
  private renderCover(): void {
    const p = this.clock.state.pomodoro;
    const resting = (p.phase === "short" || p.phase === "long") && p.endsAt !== null;
    if (!resting) this.coverAside = null;
    const show = this.clock.settings.cover && resting && this.coverAside !== p.endsAt && (!this.pressing || !this.cover.hidden);
    if (show === !this.cover.hidden) return;
    this.cover.hidden = !show;
    if (show) this.coverPhase.textContent = p.phase === "long" ? "長い休憩" : "休憩";
  }

  // --- what the buttons do -------------------------------------------------------------------

  startPomodoro(): void {
    const goal = this.pGoal.value.trim();
    this.clock.update(
      (st, now) => startPomodoro(st, this.clock.settings, now, goal),
      `ポモドーロ: 作業 ${this.clock.settings.workMin} 分を始めました${goal ? `（${goal}）` : ""}`,
    );
  }

  /** ポモドーロ: start, else pause or go on (the command's one key). */
  togglePomodoro(): void {
    const p = this.clock.state.pomodoro;
    if (p.phase === null) this.startPomodoro();
    else if (p.endsAt !== null) this.clock.update(pausePomodoro, "ポモドーロを一時停止しました");
    else this.clock.update(resumePomodoro, "ポモドーロを再開しました");
  }

  startCountdown(): void {
    const ms = parseLength(this.cLength.value);
    this.cLength.setAttribute("aria-invalid", String(ms === null));
    if (ms === null) {
      this.clock.host.status("タイマーの長さが読めません（例: 25、1:30:00、90s、1時間30分）");
      return;
    }
    const label = this.cLabel.value.trim();
    this.clock.update(
      (st, now) => startCountdown(st, ms, label, now),
      `タイマー ${formatLength(ms)}を始めました${label ? `（${label}）` : ""}`,
    );
  }

  /** タイマー: start (the last length), else pause or go on. */
  toggleCountdown(): void {
    const c = this.clock.state.countdown;
    if (c.endsAt !== null) this.clock.update(pauseCountdown, "タイマーを一時停止しました");
    else if (countdownPaused(c)) this.clock.update(resumeCountdown, "タイマーを再開しました");
    else this.clock.update((st, now) => startCountdown(st, c.totalMs, c.label, now), `タイマー ${formatLength(c.totalMs)}を始めました`);
  }

  toggleStopwatch(): void {
    const running = this.clock.state.stopwatch.startedAt !== null;
    this.clock.update(running ? pauseStopwatch : startStopwatch, running ? "計るのを止めました" : "計り始めました");
  }

  lap(): void {
    const where = this.clock.host.where() ?? "";
    const before = this.clock.state.stopwatch.laps.length;
    this.clock.update((st, now) => lapStopwatch(st, now, where));
    const laps = this.clock.state.stopwatch.laps;
    if (laps.length > before) this.clock.host.status(`区切りました: ${where || "—"} ${formatClock(lapLengths(laps)[laps.length - 1])}`);
  }
}

/** The timers as commands (命令パレット・キー設定), group タイマー. */
export function timerCommands(panel: TimerPanel, clock: TimerClock): Command[] {
  const run = (act: () => void) => () => {
    act();
    return true;
  };
  return [
    {
      id: "timer.open",
      label: "タイマーを開く・閉じる",
      group: "タイマー",
      keys: [],
      words: "時計 ポモドーロ アラーム ストップウォッチ",
      run: run(() => panel.toggle()),
    },
    {
      id: "timer.pomodoro",
      label: "ポモドーロを始める・一時停止",
      group: "タイマー",
      keys: [],
      words: "集中 作業 休憩 タイマー",
      run: run(() => panel.togglePomodoro()),
    },
    {
      id: "timer.pomodoroNext",
      label: "ポモドーロを次へ（作業・休憩を終える）",
      group: "タイマー",
      keys: [],
      words: "飛ばす スキップ",
      available: () => clock.state.pomodoro.phase !== null,
      run: run(() => clock.update((st, now) => skipPhase(st, clock.settings, now))),
    },
    {
      id: "timer.pomodoroStop",
      label: "ポモドーロを止める",
      group: "タイマー",
      keys: [],
      available: () => clock.state.pomodoro.phase !== null,
      run: run(() => clock.update(stopPomodoro, "ポモドーロを止めました")),
    },
    {
      id: "timer.countdown",
      label: "タイマーを始める・一時停止（前と同じ長さ）",
      group: "タイマー",
      keys: [],
      words: "カウントダウン",
      run: run(() => panel.toggleCountdown()),
    },
    {
      id: "timer.stopwatch",
      label: "計るのを始める・止める",
      group: "タイマー",
      keys: [],
      words: "ストップウォッチ 計測 時間",
      run: run(() => panel.toggleStopwatch()),
    },
    {
      id: "timer.lap",
      label: "計る: 区切る（開いているページと残す）",
      group: "タイマー",
      keys: [],
      words: "ラップ ストップウォッチ ページごと",
      available: () => clock.state.stopwatch.startedAt !== null,
      run: run(() => panel.lap()),
    },
    {
      id: "timer.alarms",
      label: "アラームを開く",
      group: "タイマー",
      keys: [],
      words: "目覚まし 時刻 締め切り",
      run: run(() => panel.toggle("alarms")),
    },
  ];
}
