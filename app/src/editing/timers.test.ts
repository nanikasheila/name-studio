import { describe, expect, it } from "vitest";
import {
  addAlarm,
  addToCountdown,
  changeAlarm,
  chipView,
  countdownLeft,
  DEFAULT_TIMER_SETTINGS,
  emptyTimers,
  extendPomodoro,
  formatClock,
  formatElapsed,
  formatLength,
  lapLengths,
  lapStopwatch,
  logWork,
  MISSED_MS,
  nextAlarm,
  nextOccurrence,
  parseClock,
  parseLength,
  pauseCountdown,
  pausePomodoro,
  pauseStopwatch,
  readFocusLog,
  readTimers,
  readTimerSettings,
  recentDays,
  resumeCountdown,
  resumePomodoro,
  skipPhase,
  snoozeAlarm,
  startCountdown,
  startPomodoro,
  startStopwatch,
  stopwatchElapsed,
  tick,
  type TimerSettings,
} from "./timers";

const MIN = 60_000;
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const settings: TimerSettings = { ...DEFAULT_TIMER_SETTINGS };

describe("time as written and read", () => {
  it("shows a clock, rounding a part second up", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(1)).toBe("0:01");
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(3723_000)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatElapsed(61_234)).toBe("1:01.2");
  });

  it("says a length in words", () => {
    expect(formatLength(45_000)).toBe("45 秒");
    expect(formatLength(25 * MIN)).toBe("25 分");
    expect(formatLength(90_000)).toBe("1 分 30 秒");
    expect(formatLength(90 * MIN)).toBe("1 時間 30 分");
    expect(formatLength(120 * MIN)).toBe("2 時間");
  });

  it("reads lengths typed in many ways", () => {
    expect(parseLength("25")).toBe(25 * MIN);
    expect(parseLength("２５")).toBe(25 * MIN);
    expect(parseLength("1.5")).toBe(90_000);
    expect(parseLength("25:00")).toBe(25 * MIN);
    expect(parseLength("1:30:00")).toBe(90 * MIN);
    expect(parseLength("90s")).toBe(90_000);
    expect(parseLength("1h30m")).toBe(90 * MIN);
    expect(parseLength("1時間30分")).toBe(90 * MIN);
    expect(parseLength("45秒")).toBe(45_000);
    expect(parseLength("")).toBeNull();
    expect(parseLength("abc")).toBeNull();
    expect(parseLength("0")).toBeNull();
    expect(parseLength("1:75")).toBeNull();
    expect(parseLength("25分くらい")).toBeNull();
  });

  it("reads a time of day", () => {
    expect(parseClock("9:05")).toEqual([9, 5]);
    expect(parseClock("０９：０５")).toEqual([9, 5]);
    expect(parseClock("905")).toEqual([9, 5]);
    expect(parseClock("21時")).toEqual([21, 0]);
    expect(parseClock("21時30分")).toEqual([21, 30]);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("9:60")).toBeNull();
  });
});

describe("countdown", () => {
  it("counts down, pauses, resumes and adds", () => {
    let s = startCountdown(emptyTimers(), 10 * MIN, "p.5", 0);
    expect(countdownLeft(s.countdown, 4 * MIN)).toBe(6 * MIN);
    s = pauseCountdown(s, 4 * MIN);
    expect(countdownLeft(s.countdown, 20 * MIN)).toBe(6 * MIN);
    expect(chipView(s, 20 * MIN)).toMatchObject({ kind: "countdown", text: "6:00", paused: true });
    s = resumeCountdown(s, 20 * MIN);
    expect(s.countdown.endsAt).toBe(26 * MIN);
    s = addToCountdown(s, 5 * MIN, 21 * MIN);
    expect(countdownLeft(s.countdown, 21 * MIN)).toBe(10 * MIN);
  });

  it("rings once when it ends and is ready to start again", () => {
    const s = startCountdown(emptyTimers(), 10 * MIN, "", 0);
    expect(tick(s, settings, 9 * MIN).events).toEqual([]);
    const done = tick(s, settings, 10 * MIN + 300);
    expect(done.events).toEqual([{ kind: "countdown", label: "", lengthMs: 10 * MIN, missed: false }]);
    expect(done.state.countdown.endsAt).toBeNull();
    expect(done.state.countdown.leftMs).toBe(10 * MIN);
    expect(tick(done.state, settings, 11 * MIN).events).toEqual([]);
  });

  it("says one that ended while the app was closed, without ringing", () => {
    const s = startCountdown(emptyTimers(), 10 * MIN, "", 0);
    expect(tick(s, settings, 10 * MIN + MISSED_MS + 1).events[0]).toMatchObject({ kind: "countdown", missed: true });
  });
});

describe("stopwatch", () => {
  it("counts up across a pause and keeps laps with where the work was", () => {
    let s = startStopwatch(emptyTimers(), 1000);
    s = lapStopwatch(s, 61_000, "p.1");
    s = pauseStopwatch(s, 100_000);
    expect(stopwatchElapsed(s.stopwatch, 500_000)).toBe(99_000);
    s = startStopwatch(s, 500_000);
    s = lapStopwatch(s, 541_000, "p.2");
    expect(s.stopwatch.laps).toEqual([
      { atMs: 60_000, label: "p.1" },
      { atMs: 140_000, label: "p.2" },
    ]);
    expect(lapLengths(s.stopwatch.laps)).toEqual([60_000, 80_000]);
    expect(chipView(s, 541_000).kind).toBe("stopwatch");
  });
});

describe("pomodoro", () => {
  it("goes work → break → work, with a long break after four", () => {
    let s = startPomodoro(emptyTimers(), settings, 0, "p.5〜8");
    const phases: string[] = [];
    let now = 0;
    for (let i = 0; i < 8; i++) {
      now = s.pomodoro.endsAt ?? now;
      const r = tick(s, { ...settings, autoWork: true }, now);
      expect(r.events).toHaveLength(1);
      const e = r.events[0];
      if (e.kind !== "pomodoro") throw new Error("not a pomodoro");
      phases.push(`${e.ended}>${e.next}`);
      expect(e.goal).toBe("p.5〜8");
      s = r.state;
    }
    expect(phases).toEqual(["work>short", "short>work", "work>short", "short>work", "work>short", "short>work", "work>long", "long>work"]);
    expect(s.pomodoro.done).toBe(0);
  });

  it("starts the break by itself and waits before work (as set)", () => {
    const s = startPomodoro(emptyTimers(), settings, 0);
    const work = tick(s, settings, 25 * MIN);
    expect(work.events[0]).toMatchObject({ kind: "pomodoro", ended: "work", next: "short", started: true, workMs: 25 * MIN, done: 1 });
    expect(work.state.pomodoro).toMatchObject({ phase: "short", endsAt: 30 * MIN });
    const rest = tick(work.state, settings, 30 * MIN);
    expect(rest.events[0]).toMatchObject({ ended: "short", next: "work", started: false, workMs: 0 });
    expect(rest.state.pomodoro).toMatchObject({ phase: "work", endsAt: null, leftMs: 25 * MIN });
    // A work period counts for its length as started, though the setting changed meanwhile.
    const longer = tick(extendPomodoro(resumePomodoro(rest.state, 40 * MIN), 5 * MIN, 41 * MIN), { ...settings, workMin: 50 }, 70 * MIN);
    expect(longer.events[0]).toMatchObject({ ended: "work", workMs: 30 * MIN });
    expect(chipView(rest.state, 31 * MIN)).toMatchObject({ kind: "pomodoro", phase: "work", paused: true, text: "25:00" });
    const going = resumePomodoro(rest.state, 40 * MIN);
    expect(going.pomodoro.endsAt).toBe(65 * MIN);
  });

  it("does not start the next phase by itself after one passed while closed", () => {
    const s = startPomodoro(emptyTimers(), settings, 0);
    const r = tick(s, settings, 25 * MIN + MISSED_MS + 1);
    expect(r.events[0]).toMatchObject({ missed: true, started: false });
    expect(r.state.pomodoro.endsAt).toBeNull();
  });

  it("pauses, extends and skips (a skipped work period is not counted)", () => {
    let s = startPomodoro(emptyTimers(), settings, 0);
    s = pausePomodoro(s, 10 * MIN);
    expect(s.pomodoro.leftMs).toBe(15 * MIN);
    s = extendPomodoro(s, 5 * MIN, 12 * MIN);
    expect(s.pomodoro.leftMs).toBe(20 * MIN);
    s = { ...s, pomodoro: { ...s.pomodoro, done: 3 } };
    s = skipPhase(s, settings, 12 * MIN);
    expect(s.pomodoro).toMatchObject({ phase: "short", done: 3, endsAt: 17 * MIN });
    s = skipPhase(s, settings, 13 * MIN, false);
    expect(s.pomodoro).toMatchObject({ phase: "work", endsAt: null });
  });
});

describe("alarms", () => {
  it("finds the next time round, weekdays only when asked", () => {
    const friday = at(2026, 11, 13, 10, 0);
    expect(nextOccurrence("09:00", "daily", friday)).toBe(at(2026, 11, 14, 9, 0));
    expect(nextOccurrence("11:00", "daily", friday)).toBe(at(2026, 11, 13, 11, 0));
    expect(nextOccurrence("09:00", "weekdays", friday)).toBe(at(2026, 11, 16, 9, 0));
    expect(nextOccurrence("bad", "daily", friday)).toBeNull();
  });

  it("rings once, then sets the next round or turns itself off", () => {
    const now = at(2026, 11, 12, 8, 0);
    let s = addAlarm(emptyTimers(), { time: "9:00", label: "締め切り確認", repeat: "once" }, now, "x");
    s = addAlarm(s, { time: "8:30", label: "", repeat: "daily" }, now, "y");
    expect(s.alarms.map((a) => a.time)).toEqual(["08:30", "09:00"]);
    expect(nextAlarm(s)?.alarm.id).toBe("y");
    let r = tick(s, settings, at(2026, 11, 12, 8, 30));
    expect(r.events).toEqual([expect.objectContaining({ kind: "alarm", missed: false, alarm: expect.objectContaining({ id: "y" }) })]);
    expect(r.state.alarms.find((a) => a.id === "y")?.nextAt).toBe(at(2026, 11, 13, 8, 30));
    r = tick(r.state, settings, at(2026, 11, 12, 9, 0));
    expect(r.state.alarms.find((a) => a.id === "x")).toMatchObject({ on: false, nextAt: null });
    expect(tick(r.state, settings, at(2026, 11, 12, 9, 1)).events).toEqual([]);
  });

  it("snoozes, and turning one back on sets it from now", () => {
    const now = at(2026, 11, 12, 8, 0);
    let s = addAlarm(emptyTimers(), { time: "9:00", label: "", repeat: "once" }, now, "x");
    s = tick(s, settings, at(2026, 11, 12, 9, 0)).state;
    s = snoozeAlarm(s, "x", 5 * MIN, at(2026, 11, 12, 9, 0));
    expect(nextAlarm(s)?.at).toBe(at(2026, 11, 12, 9, 5));
    const r = tick(s, settings, at(2026, 11, 12, 9, 5));
    expect(r.events).toHaveLength(1);
    expect(r.state.alarms[0].snoozedTo).toBeNull();
    s = changeAlarm(r.state, "x", { on: true }, at(2026, 11, 12, 10, 0));
    expect(s.alarms[0].nextAt).toBe(at(2026, 11, 13, 9, 0));
    s = changeAlarm(s, "x", { time: "11:15" }, at(2026, 11, 12, 10, 0));
    expect(s.alarms[0]).toMatchObject({ time: "11:15", nextAt: at(2026, 11, 12, 11, 15) });
  });

  it("says an alarm passed while the app was closed", () => {
    const s = addAlarm(emptyTimers(), { time: "9:00", label: "", repeat: "daily" }, at(2026, 11, 12, 8, 0), "x");
    const r = tick(s, settings, at(2026, 11, 12, 13, 0));
    expect(r.events[0]).toMatchObject({ kind: "alarm", missed: true });
    expect(r.state.alarms[0].nextAt).toBe(at(2026, 11, 13, 9, 0));
  });
});

describe("kept on this computer", () => {
  it("reads back what was kept, and something broken as empty", () => {
    let s = startPomodoro(emptyTimers(), settings, 0, "目標");
    s = addAlarm(s, { time: "9:00", label: "a", repeat: "weekdays" }, 0, "x");
    s = startStopwatch(lapStopwatch(s, 0, ""), 0);
    expect(readTimers(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(readTimers("nonsense")).toEqual(emptyTimers());
    expect(readTimers({ alarms: [{ time: "nope" }], pomodoro: { phase: "dance" } }).alarms).toEqual([]);
  });

  it("checks every setting", () => {
    expect(readTimerSettings(null)).toEqual(DEFAULT_TIMER_SETTINGS);
    expect(readTimerSettings({ workMin: 50, shortMin: -1, sound: "gong", volume: 30, cover: true })).toMatchObject({
      workMin: 50,
      shortMin: 5,
      sound: "chime",
      volume: 30,
      cover: true,
    });
  });

  it("logs work periods by day and keeps a while", () => {
    let log = logWork({}, at(2026, 11, 12, 10), 25);
    log = logWork(log, at(2026, 11, 12, 11), 25);
    log = logWork(log, at(2026, 11, 10, 11), 50);
    expect(log["2026-11-12"]).toEqual({ count: 2, minutes: 50 });
    const week = recentDays(log, at(2026, 11, 12, 20));
    expect(week).toHaveLength(7);
    expect(week[6]).toMatchObject({ label: "今日", count: 2 });
    expect(week[4]).toMatchObject({ key: "2026-11-10", count: 1, minutes: 50 });
    expect(Object.keys(logWork(log, at(2027, 6, 1), 25))).toEqual(["2027-06-01"]);
    expect(readFocusLog({ "2026-11-12": { count: 2, minutes: 50 }, bad: 1 })).toEqual({ "2026-11-12": { count: 2, minutes: 50 } });
  });
});
