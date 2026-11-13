// タイマー: a countdown, a stopwatch (計る), ポモドーロ and アラーム for the work
// on a name. Pure: every function takes the time it is now (ms since 1970) and
// gives a new state, so what comes due is decided in one place (`tick`) and the
// state can be kept on this computer and picked up after the app restarts.

export type PomodoroPhase = "work" | "short" | "long";
export type AlarmRepeat = "once" | "daily" | "weekdays";

export interface Countdown {
  label: string;
  /** The length it was set to. */
  totalMs: number;
  /** When it ends while it runs; null while stopped or paused. */
  endsAt: number | null;
  /** What is left while paused (the whole length when not started). */
  leftMs: number;
}

/** 区切り: the time on the stopwatch when it was pressed, and where the work was (「p.5」). */
export interface Lap {
  atMs: number;
  label: string;
}

export interface Stopwatch {
  /** When it was started (less what it had counted before); null while stopped. */
  startedAt: number | null;
  /** What it counted while stopped. */
  elapsedMs: number;
  laps: Lap[];
}

export interface Pomodoro {
  /** Null: not in a cycle. */
  phase: PomodoroPhase | null;
  endsAt: number | null;
  leftMs: number;
  /** How long the phase in hand is, as it was started (with あと N 分): what a work period counts for. */
  lengthMs: number;
  /** Work periods finished since the last long break. */
  done: number;
  /** What this cycle is for (「p.5〜8 のネーム」). */
  goal: string;
}

export interface Alarm {
  id: string;
  /** "HH:MM", on this computer's clock. */
  time: string;
  label: string;
  repeat: AlarmRepeat;
  on: boolean;
  /** When it rings next; kept, so that one passed while the app was closed is noticed. */
  nextAt: number | null;
  /** あとで: rings again then (a snooze), as well as at `nextAt`. */
  snoozedTo: number | null;
}

export interface TimerState {
  countdown: Countdown;
  stopwatch: Stopwatch;
  pomodoro: Pomodoro;
  alarms: Alarm[];
}

export interface TimerSettings {
  workMin: number;
  shortMin: number;
  longMin: number;
  /** A long break after this many work periods. */
  longEvery: number;
  /** The break starts by itself when a work period ends. */
  autoBreak: boolean;
  /** The next work period starts by itself when a break ends. */
  autoWork: boolean;
  sound: SoundId;
  /** 0〜100. */
  volume: number;
  /** How many times the sound rings. */
  rings: number;
  /** Windows' own notification (seen in another app, CSP). */
  toast: boolean;
  /** The taskbar button flashes until the window is looked at. */
  flash: boolean;
  /** The window comes to the front. */
  front: boolean;
  /** A break covers the screen (the hand stops). */
  cover: boolean;
  /** The timer in the bar at the top: always, or only while one runs. */
  chip: "always" | "running";
}

export type SoundId = "chime" | "bell" | "beep" | "soft" | "none";

export const SOUND_LABELS: Record<SoundId, string> = {
  chime: "チャイム",
  bell: "ベル",
  beep: "電子音",
  soft: "やわらかい音",
  none: "鳴らさない",
};

export const PHASE_LABELS: Record<PomodoroPhase, string> = { work: "作業", short: "休憩", long: "長い休憩" };
export const REPEAT_LABELS: Record<AlarmRepeat, string> = { once: "一度だけ", daily: "毎日", weekdays: "平日（月〜金）" };

export const DEFAULT_TIMER_SETTINGS: TimerSettings = {
  workMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoBreak: true,
  autoWork: false,
  sound: "chime",
  volume: 60,
  rings: 3,
  toast: true,
  flash: true,
  front: false,
  cover: false,
  chip: "always",
};

/** The countdown's lengths offered as buttons (minutes). */
export const COUNTDOWN_PRESETS = [5, 10, 15, 25, 30, 45, 60, 90];

/** Past due by more than this when first seen: the app was closed (or asleep) then; it is said, not rung. */
export const MISSED_MS = 10 * 60_000;

const MINUTE = 60_000;

export function emptyTimers(): TimerState {
  return {
    countdown: { label: "", totalMs: 25 * MINUTE, endsAt: null, leftMs: 25 * MINUTE },
    stopwatch: { startedAt: null, elapsedMs: 0, laps: [] },
    pomodoro: { phase: null, endsAt: null, leftMs: 0, lengthMs: 0, done: 0, goal: "" },
    alarms: [],
  };
}

// --- reading what was kept -----------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const num = (value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown, max = 200): string => (typeof value === "string" ? value.slice(0, max) : "");
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** The settings as kept, every field checked; what does not read is as it comes. */
export function readTimerSettings(raw: unknown): TimerSettings {
  const d = DEFAULT_TIMER_SETTINGS;
  if (!isObject(raw)) return { ...d };
  const flag = (key: keyof TimerSettings) => (typeof raw[key] === "boolean" ? (raw[key] as boolean) : (d[key] as boolean));
  return {
    workMin: num(raw.workMin, d.workMin, 1, 180),
    shortMin: num(raw.shortMin, d.shortMin, 1, 60),
    longMin: num(raw.longMin, d.longMin, 1, 120),
    longEvery: Math.round(num(raw.longEvery, d.longEvery, 1, 12)),
    autoBreak: flag("autoBreak"),
    autoWork: flag("autoWork"),
    sound: oneOf(raw.sound, Object.keys(SOUND_LABELS) as SoundId[], d.sound),
    volume: num(raw.volume, d.volume, 0, 100),
    rings: Math.round(num(raw.rings, d.rings, 1, 10)),
    toast: flag("toast"),
    flash: flag("flash"),
    front: flag("front"),
    cover: flag("cover"),
    chip: oneOf(raw.chip, ["always", "running"] as const, d.chip),
  };
}

/** The state as kept, every field checked; a part that does not read starts empty. */
export function readTimers(raw: unknown): TimerState {
  const empty = emptyTimers();
  if (!isObject(raw)) return empty;
  const c = isObject(raw.countdown) ? raw.countdown : {};
  const totalMs = num(c.totalMs, empty.countdown.totalMs, 1000);
  const countdown: Countdown = {
    label: text(c.label),
    totalMs,
    endsAt: numOrNull(c.endsAt),
    leftMs: num(c.leftMs, totalMs, 0),
  };
  const s = isObject(raw.stopwatch) ? raw.stopwatch : {};
  const stopwatch: Stopwatch = {
    startedAt: numOrNull(s.startedAt),
    elapsedMs: num(s.elapsedMs, 0),
    laps: (Array.isArray(s.laps) ? s.laps : [])
      .filter(isObject)
      .slice(-200)
      .map((lap) => ({ atMs: num(lap.atMs, 0), label: text(lap.label, 80) })),
  };
  const p = isObject(raw.pomodoro) ? raw.pomodoro : {};
  const pomodoro: Pomodoro = {
    phase: p.phase === null || p.phase === undefined ? null : oneOf(p.phase, ["work", "short", "long"] as const, "work"),
    endsAt: numOrNull(p.endsAt),
    leftMs: num(p.leftMs, 0),
    lengthMs: num(p.lengthMs, num(p.leftMs, 0)),
    done: Math.round(num(p.done, 0, 0, 100)),
    goal: text(p.goal),
  };
  if (pomodoro.phase === null) pomodoro.endsAt = null;
  const alarms: Alarm[] = (Array.isArray(raw.alarms) ? raw.alarms : [])
    .filter(isObject)
    .filter((a) => parseClock(text(a.time)) !== null)
    .slice(0, 50)
    .map((a, i) => ({
      id: text(a.id, 40) || `a${i}`,
      time: text(a.time),
      label: text(a.label),
      repeat: oneOf(a.repeat, ["once", "daily", "weekdays"] as const, "once"),
      on: a.on !== false,
      nextAt: numOrNull(a.nextAt),
      snoozedTo: numOrNull(a.snoozedTo),
    }));
  return { countdown, stopwatch, pomodoro, alarms };
}

// --- time as written and read ----------------------------------------------------------------

/** "4:59", "1:02:03": the time on a clock face, never below zero (a part second shows as the next one up). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** "1:02:03.4" for the stopwatch: tenths shown, counting up (not rounded up). */
export function formatElapsed(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  return `${formatClock(Math.floor(tenths / 10) * 1000)}.${tenths % 10}`;
}

/** "25 分", "1 時間 30 分", "45 秒": a length in words. */
export function formatLength(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600 && seconds % 60) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} 分`;
  return m ? `${h} 時間 ${m} 分` : `${h} 時間`;
}

/**
 * A length as typed: "25" (minutes), "25:00" / "1:30:00" (a clock), "90s", "1h30m",
 * "1時間30分", "45秒", full-width digits too. Null when it does not read or is zero.
 */
export function parseLength(typed: string): number | null {
  const t = typed.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  let ms: number | null = null;
  if (/^\d+(\.\d+)?$/.test(t)) ms = Number(t) * MINUTE;
  else if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    const parts = t.split(":").map(Number);
    if (parts.slice(1).some((part) => part >= 60)) return null;
    ms = (parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]) * 1000;
  } else {
    const unit = /(\d+(?:\.\d+)?)(時間|h|分|m|min|秒|s|sec)/g;
    let rest = t;
    let sum = 0;
    for (const [whole, n, u] of t.matchAll(unit)) {
      rest = rest.replace(whole, "");
      sum += Number(n) * (u === "時間" || u === "h" ? 3_600_000 : u === "秒" || u === "s" || u === "sec" ? 1000 : MINUTE);
    }
    if (rest === "" || rest === "間") ms = sum;
  }
  return ms !== null && ms >= 1000 && ms <= 24 * 3_600_000 ? Math.round(ms) : null;
}

/** "9:05" / "09:05" / "905" / "21時" → [9, 5]; null when it is not a time of day. */
export function parseClock(typed: string): [number, number] | null {
  const t = typed.normalize("NFKC").trim().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?::|時)?(\d{2})?分?$/.exec(t) ?? /^(\d{1,2})(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  return h < 24 && min < 60 ? [h, min] : null;
}

export function clockText([h, m]: [number, number]): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The next moment after `after` that `time` comes round, on this computer's clock (weekdays: Mon–Fri only). */
export function nextOccurrence(time: string, repeat: AlarmRepeat, after: number): number | null {
  const clock = parseClock(time);
  if (!clock) return null;
  const day = new Date(after);
  day.setHours(clock[0], clock[1], 0, 0);
  for (let i = 0; i < 8; i++) {
    const at = day.getTime();
    const weekday = day.getDay() >= 1 && day.getDay() <= 5;
    if (at > after && (repeat !== "weekdays" || weekday)) return at;
    day.setDate(day.getDate() + 1);
    day.setHours(clock[0], clock[1], 0, 0);
  }
  return null;
}

// --- the countdown ---------------------------------------------------------------------------

export function countdownLeft(c: Countdown, now: number): number {
  return c.endsAt === null ? c.leftMs : Math.max(0, c.endsAt - now);
}

export const countdownRunning = (c: Countdown): boolean => c.endsAt !== null;
/** Paused part way (not at the start). */
export const countdownPaused = (c: Countdown): boolean => c.endsAt === null && c.leftMs > 0 && c.leftMs < c.totalMs;

export function startCountdown(state: TimerState, ms: number, label: string, now: number): TimerState {
  return { ...state, countdown: { label, totalMs: ms, endsAt: now + ms, leftMs: ms } };
}

export function pauseCountdown(state: TimerState, now: number): TimerState {
  const c = state.countdown;
  if (c.endsAt === null) return state;
  return { ...state, countdown: { ...c, endsAt: null, leftMs: countdownLeft(c, now) } };
}

export function resumeCountdown(state: TimerState, now: number): TimerState {
  const c = state.countdown;
  if (c.endsAt !== null || c.leftMs <= 0) return state;
  return { ...state, countdown: { ...c, endsAt: now + c.leftMs } };
}

export function resetCountdown(state: TimerState): TimerState {
  const c = state.countdown;
  return { ...state, countdown: { ...c, endsAt: null, leftMs: c.totalMs } };
}

/** あと N 分: added to what is left (running or not); never below a second. */
export function addToCountdown(state: TimerState, ms: number, now: number): TimerState {
  const c = state.countdown;
  const left = Math.max(1000, countdownLeft(c, now) + ms);
  const totalMs = Math.max(c.totalMs, left);
  return { ...state, countdown: { ...c, totalMs, leftMs: left, endsAt: c.endsAt === null ? null : now + left } };
}

// --- the stopwatch ---------------------------------------------------------------------------

export function stopwatchElapsed(s: Stopwatch, now: number): number {
  return s.startedAt === null ? s.elapsedMs : Math.max(0, now - s.startedAt);
}

export function startStopwatch(state: TimerState, now: number): TimerState {
  const s = state.stopwatch;
  if (s.startedAt !== null) return state;
  return { ...state, stopwatch: { ...s, startedAt: now - s.elapsedMs } };
}

export function pauseStopwatch(state: TimerState, now: number): TimerState {
  const s = state.stopwatch;
  if (s.startedAt === null) return state;
  return { ...state, stopwatch: { ...s, startedAt: null, elapsedMs: stopwatchElapsed(s, now) } };
}

export function resetStopwatch(state: TimerState): TimerState {
  return { ...state, stopwatch: { startedAt: null, elapsedMs: 0, laps: [] } };
}

/** 区切る: the time so far kept with where the work is. */
export function lapStopwatch(state: TimerState, now: number, label: string): TimerState {
  const s = state.stopwatch;
  const atMs = stopwatchElapsed(s, now);
  if (atMs <= 0) return state;
  return { ...state, stopwatch: { ...s, laps: [...s.laps, { atMs, label }].slice(-200) } };
}

/** Each lap's own length (from the one before), newest last. */
export function lapLengths(laps: readonly Lap[]): number[] {
  return laps.map((lap, i) => lap.atMs - (i ? laps[i - 1].atMs : 0));
}

// --- ポモドーロ ----------------------------------------------------------------------------

export function phaseMs(settings: TimerSettings, phase: PomodoroPhase): number {
  return (phase === "work" ? settings.workMin : phase === "short" ? settings.shortMin : settings.longMin) * MINUTE;
}

export function pomodoroLeft(p: Pomodoro, now: number): number {
  return p.endsAt === null ? p.leftMs : Math.max(0, p.endsAt - now);
}

/** The phase after `phase`, with `done` work periods finished counting this one. */
export function phaseAfter(phase: PomodoroPhase, done: number, settings: TimerSettings): PomodoroPhase {
  if (phase !== "work") return "work";
  return done > 0 && done % settings.longEvery === 0 ? "long" : "short";
}

export function startPomodoro(state: TimerState, settings: TimerSettings, now: number, goal = state.pomodoro.goal): TimerState {
  const ms = phaseMs(settings, "work");
  return { ...state, pomodoro: { phase: "work", endsAt: now + ms, leftMs: ms, lengthMs: ms, done: 0, goal } };
}

export function pausePomodoro(state: TimerState, now: number): TimerState {
  const p = state.pomodoro;
  if (p.endsAt === null) return state;
  return { ...state, pomodoro: { ...p, endsAt: null, leftMs: pomodoroLeft(p, now) } };
}

export function resumePomodoro(state: TimerState, now: number): TimerState {
  const p = state.pomodoro;
  if (p.phase === null || p.endsAt !== null || p.leftMs <= 0) return state;
  return { ...state, pomodoro: { ...p, endsAt: now + p.leftMs } };
}

export function stopPomodoro(state: TimerState): TimerState {
  return { ...state, pomodoro: { ...state.pomodoro, phase: null, endsAt: null, leftMs: 0, done: 0 } };
}

/** あと N 分: the phase in hand made longer. */
export function extendPomodoro(state: TimerState, ms: number, now: number): TimerState {
  const p = state.pomodoro;
  if (p.phase === null) return state;
  const left = pomodoroLeft(p, now) + ms;
  return { ...state, pomodoro: { ...p, leftMs: left, lengthMs: p.lengthMs + ms, endsAt: p.endsAt === null ? null : now + left } };
}

/**
 * 次へ: the phase in hand ended now (a work period cut short does not count),
 * the next one started (or waiting, when `start` is false).
 */
export function skipPhase(state: TimerState, settings: TimerSettings, now: number, start = true): TimerState {
  const p = state.pomodoro;
  if (p.phase === null) return state;
  const next = phaseAfter(p.phase, p.done, settings);
  // A work period skipped: the next break is a short one (a long one is earned).
  const phase = p.phase === "work" && next === "long" ? "short" : next;
  return { ...state, pomodoro: begin(p, phase, p.phase === "long" ? 0 : p.done, settings, now, start) };
}

function begin(p: Pomodoro, phase: PomodoroPhase, done: number, settings: TimerSettings, now: number, start: boolean): Pomodoro {
  const ms = phaseMs(settings, phase);
  return { ...p, phase, done, leftMs: ms, lengthMs: ms, endsAt: start ? now + ms : null };
}

// --- アラーム ---------------------------------------------------------------------------------

export function addAlarm(
  state: TimerState,
  alarm: { time: string; label: string; repeat: AlarmRepeat },
  now: number,
  id = `a${now.toString(36)}`,
): TimerState {
  const clock = parseClock(alarm.time);
  if (!clock) return state;
  const time = clockText(clock);
  const added: Alarm = {
    id,
    time,
    label: alarm.label,
    repeat: alarm.repeat,
    on: true,
    nextAt: nextOccurrence(time, alarm.repeat, now),
    snoozedTo: null,
  };
  const alarms = [...state.alarms, added].sort((a, b) => a.time.localeCompare(b.time));
  return { ...state, alarms };
}

export function changeAlarm(
  state: TimerState,
  id: string,
  change: Partial<Pick<Alarm, "time" | "label" | "repeat" | "on">>,
  now: number,
): TimerState {
  const alarms = state.alarms
    .map((alarm) => {
      if (alarm.id !== id) return alarm;
      const clock = change.time === undefined ? null : parseClock(change.time);
      const next = { ...alarm, ...change, time: clock ? clockText(clock) : alarm.time };
      // Turned on or moved: rings at the next time round, from now.
      return { ...next, nextAt: next.on ? nextOccurrence(next.time, next.repeat, now) : null, snoozedTo: next.on ? alarm.snoozedTo : null };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
  return { ...state, alarms };
}

export function removeAlarm(state: TimerState, id: string): TimerState {
  return { ...state, alarms: state.alarms.filter((alarm) => alarm.id !== id) };
}

/** あとで: rings again `ms` from now. */
export function snoozeAlarm(state: TimerState, id: string, ms: number, now: number): TimerState {
  return { ...state, alarms: state.alarms.map((alarm) => (alarm.id === id ? { ...alarm, snoozedTo: now + ms } : alarm)) };
}

/** When an alarm rings next (snoozes too), and which. */
export function nextAlarm(state: TimerState): { alarm: Alarm; at: number } | null {
  let best: { alarm: Alarm; at: number } | null = null;
  for (const alarm of state.alarms) {
    for (const at of [alarm.on ? alarm.nextAt : null, alarm.snoozedTo]) {
      if (at !== null && (!best || at < best.at)) best = { alarm, at };
    }
  }
  return best;
}

// --- what comes due ---------------------------------------------------------------------------

export type TimerEvent =
  | { kind: "countdown"; label: string; lengthMs: number; missed: boolean }
  | {
      kind: "pomodoro";
      ended: PomodoroPhase;
      next: PomodoroPhase;
      /** The next phase started by itself (else it waits for 始める). */
      started: boolean;
      /** Work periods finished since the last long break, this one counted. */
      done: number;
      goal: string;
      /** The work period's length, when a work period ended (for the log). */
      workMs: number;
      missed: boolean;
    }
  | { kind: "alarm"; alarm: Alarm; missed: boolean };

/** What came due by `now`, and the state after it: rung once each, the next round set. */
export function tick(state: TimerState, settings: TimerSettings, now: number): { state: TimerState; events: TimerEvent[] } {
  const events: TimerEvent[] = [];
  let next = state;
  const c = next.countdown;
  if (c.endsAt !== null && now >= c.endsAt) {
    events.push({ kind: "countdown", label: c.label, lengthMs: c.totalMs, missed: now - c.endsAt > MISSED_MS });
    next = { ...next, countdown: { ...c, endsAt: null, leftMs: c.totalMs } };
  }
  const p = next.pomodoro;
  if (p.phase !== null && p.endsAt !== null && now >= p.endsAt) {
    const missed = now - p.endsAt > MISSED_MS;
    const done = p.phase === "work" ? p.done + 1 : p.phase === "long" ? 0 : p.done;
    const phase = phaseAfter(p.phase, done, settings);
    // Only when the app was there to say so: a phase passed while it was closed waits.
    const started = !missed && (phase === "work" ? settings.autoWork : settings.autoBreak);
    const workMs = p.phase === "work" ? p.lengthMs || phaseMs(settings, "work") : 0;
    events.push({ kind: "pomodoro", ended: p.phase, next: phase, started, done, goal: p.goal, workMs, missed });
    next = { ...next, pomodoro: begin(p, phase, done, settings, now, started) };
  }
  if (next.alarms.some((a) => (a.on && a.nextAt !== null && now >= a.nextAt) || (a.snoozedTo !== null && now >= a.snoozedTo))) {
    const alarms = next.alarms.map((alarm) => {
      let a = alarm;
      if (a.snoozedTo !== null && now >= a.snoozedTo) {
        events.push({ kind: "alarm", alarm: a, missed: now - a.snoozedTo > MISSED_MS });
        a = { ...a, snoozedTo: null };
      }
      if (a.on && a.nextAt !== null && now >= a.nextAt) {
        events.push({ kind: "alarm", alarm: a, missed: now - a.nextAt > MISSED_MS });
        a = a.repeat === "once" ? { ...a, on: false, nextAt: null } : { ...a, nextAt: nextOccurrence(a.time, a.repeat, now) };
      }
      return a;
    });
    next = { ...next, alarms };
  }
  return { state: next, events };
}

/** Whether anything counts down or up now (the bar at the top shows it). */
export function anyRunning(state: TimerState): boolean {
  return (
    state.countdown.endsAt !== null ||
    state.stopwatch.startedAt !== null ||
    state.pomodoro.phase !== null ||
    countdownPaused(state.countdown)
  );
}

/** What the bar at the top shows: ポモドーロ first, then the countdown, then the stopwatch. */
export interface ChipView {
  kind: "pomodoro" | "countdown" | "stopwatch" | "idle";
  text: string;
  /** For the colour: 作業 or 休憩. */
  phase: PomodoroPhase | null;
  paused: boolean;
  /** Words for the tooltip and a screen reader. */
  said: string;
}

export function chipView(state: TimerState, now: number): ChipView {
  const p = state.pomodoro;
  if (p.phase !== null) {
    const left = pomodoroLeft(p, now);
    const paused = p.endsAt === null;
    return {
      kind: "pomodoro",
      text: formatClock(left),
      phase: p.phase,
      paused,
      said: `ポモドーロ ${PHASE_LABELS[p.phase]}${paused ? "（止めています）" : ""} 残り ${formatClock(left)}`,
    };
  }
  const c = state.countdown;
  if (c.endsAt !== null || countdownPaused(c)) {
    const left = countdownLeft(c, now);
    const paused = c.endsAt === null;
    return {
      kind: "countdown",
      text: formatClock(left),
      phase: null,
      paused,
      said: `タイマー${c.label ? `「${c.label}」` : ""}${paused ? "（止めています）" : ""} 残り ${formatClock(left)}`,
    };
  }
  const s = state.stopwatch;
  if (s.startedAt !== null) {
    const elapsed = stopwatchElapsed(s, now);
    return {
      kind: "stopwatch",
      text: formatClock(Math.floor(elapsed / 1000) * 1000),
      phase: null,
      paused: false,
      said: `計っています ${formatClock(Math.floor(elapsed / 1000) * 1000)}`,
    };
  }
  return { kind: "idle", text: "", phase: null, paused: false, said: "タイマー" };
}

// --- 集中の記録 -----------------------------------------------------------------------------

/** Work periods finished on each day ("2026-11-12", this computer's clock). */
export type FocusLog = Record<string, { count: number; minutes: number }>;

export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The log with one work period of `minutes` on the day of `at`; days older than `keepDays` dropped. */
export function logWork(log: FocusLog, at: number, minutes: number, keepDays = 120): FocusLog {
  const key = dayKey(at);
  const day = log[key] ?? { count: 0, minutes: 0 };
  const next: FocusLog = { ...log, [key]: { count: day.count + 1, minutes: day.minutes + minutes } };
  const oldest = dayKey(at - keepDays * 86_400_000);
  for (const k of Object.keys(next)) if (k < oldest) delete next[k];
  return next;
}

export function readFocusLog(raw: unknown): FocusLog {
  if (!isObject(raw)) return {};
  const log: FocusLog = {};
  for (const [key, day] of Object.entries(raw)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && isObject(day)) log[key] = { count: Math.round(num(day.count, 0)), minutes: num(day.minutes, 0) };
  }
  return log;
}

/** The last `days` days up to the day of `now`, oldest first, with what was done on each. */
export function recentDays(log: FocusLog, now: number, days = 7): { key: string; label: string; count: number; minutes: number }[] {
  const week = ["日", "月", "火", "水", "木", "金", "土"];
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    out.push({ key, label: i === 0 ? "今日" : week[d.getDay()], count: log[key]?.count ?? 0, minutes: log[key]?.minutes ?? 0 });
  }
  return out;
}
