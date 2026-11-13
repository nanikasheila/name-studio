// 設定 › タイマー: the ポモドーロ's lengths, starting by itself, the sound, how
// it is said outside the window, the break's cover, the timer in the bar at
// the top and the log of work periods (this computer).
import { ask } from "../platform/dialogs";
import { $, element } from "../platform/dom";
import { formatLength, SOUND_LABELS, type SoundId, type TimerSettings } from "../editing/timers";
import type { TimerClock } from "./timerclock";

type Numbers = "workMin" | "shortMin" | "longMin" | "longEvery" | "rings" | "volume";
type Flags = "autoBreak" | "autoWork" | "toast" | "flash" | "front" | "cover";

const NUMBERS: [Numbers, string][] = [
  ["workMin", "st-tm-work"],
  ["shortMin", "st-tm-short"],
  ["longMin", "st-tm-long"],
  ["longEvery", "st-tm-every"],
  ["rings", "st-tm-rings"],
  ["volume", "st-tm-volume"],
];
const FLAGS: [Flags, string][] = [
  ["autoBreak", "st-tm-auto-break"],
  ["autoWork", "st-tm-auto-work"],
  ["toast", "st-tm-toast"],
  ["flash", "st-tm-flash"],
  ["front", "st-tm-front"],
  ["cover", "st-tm-cover"],
];

export class TimerPane {
  constructor(private readonly clock: TimerClock) {
    const sound = $<HTMLSelectElement>("st-tm-sound");
    for (const [id, label] of Object.entries(SOUND_LABELS)) sound.append(element("option", { value: id, textContent: label }));
    sound.addEventListener("change", () => {
      this.clock.setSettings({ sound: sound.value as SoundId });
      this.clock.trySound();
    });
    for (const [key, id] of NUMBERS) {
      const input = $<HTMLInputElement>(id);
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) this.clock.setSettings({ [key]: value } as Partial<TimerSettings>);
        this.render();
      });
    }
    $<HTMLInputElement>("st-tm-volume").addEventListener("change", () => this.clock.trySound());
    for (const [key, id] of FLAGS) {
      $<HTMLInputElement>(id).addEventListener("change", (event) =>
        this.clock.setSettings({ [key]: (event.target as HTMLInputElement).checked } as Partial<TimerSettings>),
      );
    }
    $<HTMLSelectElement>("st-tm-chip").addEventListener("change", (event) =>
      this.clock.setSettings({ chip: (event.target as HTMLSelectElement).value === "running" ? "running" : "always" }),
    );
    $("st-tm-try").addEventListener("click", () => this.clock.trySound());
    $("st-tm-clear").addEventListener("click", async () => {
      const sure = await ask("終えたポモドーロの記録（日ごとの回数と時間）を全部消します。", {
        title: "Name Studio",
        kind: "warning",
        okLabel: "消す",
        cancelLabel: "やめる",
      });
      if (!sure) return;
      this.clock.clearLog();
      this.clock.host.status("集中の記録を消しました");
    });
    this.clock.onChange(() => this.render());
    this.render();
  }

  render(): void {
    const s = this.clock.settings;
    for (const [key, id] of NUMBERS) {
      const input = $<HTMLInputElement>(id);
      if (document.activeElement !== input) input.value = String(s[key]);
    }
    for (const [key, id] of FLAGS) $<HTMLInputElement>(id).checked = s[key];
    $<HTMLSelectElement>("st-tm-sound").value = s.sound;
    $<HTMLSelectElement>("st-tm-chip").value = s.chip;
    const days = Object.values(this.clock.log);
    const total = days.reduce((sum, day) => sum + day.count, 0);
    const minutes = days.reduce((sum, day) => sum + day.minutes, 0);
    const today = this.clock.today();
    $("st-tm-log").textContent = `今日 ${today.count} 回・これまで ${total} 回（${formatLength(minutes * 60_000)}）`;
    $<HTMLButtonElement>("st-tm-clear").disabled = total === 0;
  }
}
