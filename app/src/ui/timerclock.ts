// タイマー: keeps the timers' state on this computer, wakes up to see what
// came due (a worker's beat, so it is on time behind CSP too) and says so: a
// sound, a notice at the top with the next step, and outside the window
// (Windows' notification, the taskbar button) when another app is in front.
import { call } from "../platform/backend";
import { playSound, wakeSoundOnFirstPress } from "../platform/chime";
import { showAlert, type AlertAction } from "../platform/alerts";
import { readJson, writeJson } from "../platform/settings";
import {
  type FocusLog,
  formatLength,
  PHASE_LABELS,
  readFocusLog,
  readTimers,
  readTimerSettings,
  type TimerEvent,
  type TimerSettings,
  type TimerState,
  addToCountdown,
  dayKey,
  logWork,
  resumePomodoro,
  skipPhase,
  snoozeAlarm,
  startCountdown,
  stopPomodoro,
  tick,
} from "../editing/timers";

export const TIMERS_KEY = "namestudio.timers";
export const TIMER_SETTINGS_KEY = "namestudio.timerSettings";
export const FOCUS_LOG_KEY = "namestudio.focusLog";

/** How long あとで puts an alarm off, and あと N 分 adds. */
export const SNOOZE_MS = 5 * 60_000;

const ALERT_KEY = "timer";

export interface TimerHost {
  /** Where the work is now ("p.5–6"), for 区切る; null when no name is open. */
  where(): string | null;
  status(message: string): void;
}

export class TimerClock {
  state: TimerState;
  settings: TimerSettings;
  log: FocusLog;
  private readonly changed = new Set<() => void>();
  private readonly beats = new Set<() => void>();
  private readonly rung = new Set<() => void>();
  private stopSound: (() => void) | null = null;

  constructor(readonly host: TimerHost) {
    this.state = readTimers(readJson(TIMERS_KEY, null));
    this.settings = readTimerSettings(readJson(TIMER_SETTINGS_KEY, null));
    this.log = readFocusLog(readJson(FOCUS_LOG_KEY, null));
    wakeSoundOnFirstPress();
    // The page's own beat for the screen, and the worker's for when the window is hidden.
    window.setInterval(() => this.check(), 1000);
    try {
      const worker = new Worker(new URL("../platform/tickworker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", () => this.check());
    } catch {
      // No workers here: the page's beat alone (late while minimized).
    }
    // Kept by another start of the app (or changed in another window): read again.
    window.addEventListener("storage", (event) => {
      if (event.key === TIMERS_KEY) this.state = readTimers(readJson(TIMERS_KEY, null));
      if (event.key === TIMER_SETTINGS_KEY) this.settings = readTimerSettings(readJson(TIMER_SETTINGS_KEY, null));
      if (event.key === FOCUS_LOG_KEY) this.log = readFocusLog(readJson(FOCUS_LOG_KEY, null));
      this.emit();
    });
    // What came due while the app was closed.
    queueMicrotask(() => this.check());
  }

  now(): number {
    return Date.now();
  }

  /** The state or settings changed (to draw again). */
  onChange(listener: () => void): void {
    this.changed.add(listener);
  }

  /** Every beat (about twice a second): the time shown moves on. */
  onBeat(listener: () => void): void {
    this.beats.add(listener);
  }

  /** A timer rang (its notice is at the top). */
  onRing(listener: () => void): void {
    this.rung.add(listener);
  }

  /** One change to the timers, kept at once; `said` goes to the status line. */
  update(change: (state: TimerState, now: number) => TimerState, said?: string): void {
    this.state = change(this.state, this.now());
    writeJson(TIMERS_KEY, this.state);
    this.emit();
    if (said) this.host.status(said);
  }

  setSettings(change: Partial<TimerSettings>): void {
    this.settings = readTimerSettings({ ...this.settings, ...change });
    writeJson(TIMER_SETTINGS_KEY, this.settings);
    this.emit();
  }

  /** The sound as it will ring (設定 › タイマー の「試しに鳴らす」). */
  trySound(): void {
    this.stopSound?.();
    this.stopSound = playSound(this.settings.sound, this.settings.volume, 1);
  }

  /** Work periods finished today, and their minutes. */
  today(): { count: number; minutes: number } {
    return this.log[dayKey(this.now())] ?? { count: 0, minutes: 0 };
  }

  clearLog(): void {
    this.log = {};
    writeJson(FOCUS_LOG_KEY, this.log);
    this.emit();
  }

  /** See what came due by now and say it. */
  check(): void {
    const { state, events } = tick(this.state, this.settings, this.now());
    if (events.length) {
      this.state = state;
      writeJson(TIMERS_KEY, this.state);
      for (const event of events) this.say(event);
      this.emit();
    }
    for (const beat of this.beats) beat();
  }

  private emit(): void {
    for (const listener of this.changed) listener();
  }

  private say(event: TimerEvent): void {
    const s = this.settings;
    if (event.kind === "countdown") {
      const what = `タイマー${event.label ? `「${event.label}」` : ""}`;
      if (event.missed) return this.quiet(`${what}（${formatLength(event.lengthMs)}）は、Name Studio を閉じていたあいだに終わっていました`);
      const again: AlertAction = {
        label: `もう一度 ${formatLength(event.lengthMs)}`,
        run: () => this.update((st, now) => startCountdown(st, event.lengthMs, event.label, now)),
      };
      const more: AlertAction = {
        label: "あと 5 分",
        run: () => this.update((st, now) => addToCountdown(startCountdown(st, 0, event.label, now), SNOOZE_MS, now)),
      };
      return this.ring(`${what}の ${formatLength(event.lengthMs)} が経ちました`, "タイマー", [again, more]);
    }
    if (event.kind === "alarm") {
      const a = event.alarm;
      const what = `アラーム ${a.time}${a.label ? `「${a.label}」` : ""}`;
      if (event.missed) return this.quiet(`${what} は、Name Studio を閉じていたあいだに過ぎました`);
      const later: AlertAction = {
        label: "5 分後にもう一度",
        run: () => this.update((st, now) => snoozeAlarm(st, a.id, SNOOZE_MS, now), `${what}: 5 分後にもう一度鳴らします`),
      };
      return this.ring(`${what} の時間です`, "アラーム", [later]);
    }
    // ポモドーロ
    if (event.ended === "work" && !event.missed) {
      this.log = logWork(this.log, this.now(), Math.round(event.workMs / 60_000));
      writeJson(FOCUS_LOG_KEY, this.log);
    }
    const today = this.today().count;
    const next = PHASE_LABELS[event.next];
    const nextMin = formatLength((event.next === "work" ? s.workMin : event.next === "short" ? s.shortMin : s.longMin) * 60_000);
    if (event.missed) {
      return this.quiet(
        `ポモドーロの${PHASE_LABELS[event.ended]}は、Name Studio を閉じていたあいだに終わっていました。「${next}」を始めるときは上のタイマーから`,
      );
    }
    const stop: AlertAction = { label: "ポモドーロを止める", run: () => this.update(stopPomodoro, "ポモドーロを止めました") };
    if (event.ended === "work") {
      const head = `作業 ${formatLength(event.workMs)} おつかれさまでした（今日 ${today} 回目）。`;
      if (event.started)
        return this.ring(`${head}${next} ${nextMin} を始めました`, "ポモドーロ", [
          { label: "休憩を飛ばす", run: () => this.update((st, now) => skipPhase(st, this.settings, now)) },
          stop,
        ]);
      return this.ring(`${head}${next} ${nextMin} にしましょう`, "ポモドーロ", [
        { label: `${next}を始める`, run: () => this.update(resumePomodoro) },
        { label: "休憩せずにもう 1 回作業", run: () => this.update((st, now) => skipPhase(st, this.settings, now)) },
        stop,
      ]);
    }
    if (event.started)
      return this.ring(`休憩おわり。作業 ${nextMin} を始めました${event.goal ? `（${event.goal}）` : ""}`, "ポモドーロ", [stop]);
    return this.ring(`休憩おわり。作業 ${nextMin} に戻りましょう${event.goal ? `（${event.goal}）` : ""}`, "ポモドーロ", [
      { label: "作業を始める", run: () => this.update(resumePomodoro) },
      { label: "休憩をあと 5 分", run: () => this.update((st, now) => resumePomodoro(extendBreak(st), now)) },
      stop,
    ]);
  }

  /** Something passed while the app was closed: said, not rung. */
  private quiet(message: string): void {
    showAlert(`${ALERT_KEY}.missed`, message, "info");
  }

  /** Rung and said: the sound, the notice with its next steps, and outside the window when it is not in front. */
  private ring(message: string, title: string, actions: AlertAction[]): void {
    const s = this.settings;
    this.stopSound?.();
    this.stopSound = playSound(s.sound, s.volume, s.rings);
    const quiet = (action: AlertAction): AlertAction => ({
      label: action.label,
      run: () => {
        this.stopSound?.();
        action.run();
      },
    });
    for (const listener of this.rung) listener();
    showAlert(ALERT_KEY, message, "warning", undefined, actions.map(quiet));
    this.host.status(message);
    const away = !document.hasFocus();
    if ((away && (s.toast || s.flash)) || s.front)
      void call("timer_notice", {
        notice: { title: `Name Studio — ${title}`, body: message, toast: s.toast && away, flash: s.flash, front: s.front },
      }).catch(() => undefined);
  }
}

/** 休憩をあと 5 分: back to a break of 5 minutes (the work period waiting is put back after it). */
function extendBreak(state: TimerState): TimerState {
  return { ...state, pomodoro: { ...state.pomodoro, phase: "short", leftMs: SNOOZE_MS, lengthMs: SNOOZE_MS, endsAt: null } };
}
