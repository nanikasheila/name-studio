// The timer's sounds, made on the spot (Web Audio): no sound files to ship.
// The browser lets sound play only after the person has pressed something, so
// the first press anywhere wakes the sound up for a timer that comes due later.
import type { SoundId } from "../editing/timers";

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    context = Context ? new Context() : null;
  } catch {
    context = null;
  }
  return context;
}

/** Sound is let to play from the first press or key on (call once at the start). */
export function wakeSoundOnFirstPress(): void {
  const wake = () => {
    const a = audio();
    if (a && a.state === "suspended") void a.resume().catch(() => undefined);
    if (a?.state === "running") {
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("keydown", wake, true);
    }
  };
  window.addEventListener("pointerdown", wake, true);
  window.addEventListener("keydown", wake, true);
}

/** One note: a tone with partials, struck and dying away. */
function note(
  a: AudioContext,
  out: AudioNode,
  at: number,
  hz: number,
  length: number,
  kind: OscillatorType,
  partials: [number, number][] = [[1, 1]],
): void {
  for (const [ratio, gain] of partials) {
    const osc = a.createOscillator();
    const env = a.createGain();
    osc.type = kind;
    osc.frequency.value = hz * ratio;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length / Math.sqrt(ratio));
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

/** One ring of each sound, from `at` (seconds on the context's clock); its length. */
function ring(a: AudioContext, out: AudioNode, sound: SoundId, at: number): number {
  switch (sound) {
    case "chime":
      note(a, out, at, 659.25, 1.2, "sine", [
        [1, 0.6],
        [2, 0.15],
      ]);
      note(a, out, at + 0.45, 523.25, 1.6, "sine", [
        [1, 0.6],
        [2, 0.15],
      ]);
      return 1.9;
    case "bell":
      note(a, out, at, 880, 2.2, "sine", [
        [1, 0.5],
        [2.76, 0.18],
        [5.4, 0.08],
      ]);
      return 1.6;
    case "beep":
      for (let i = 0; i < 3; i++) note(a, out, at + i * 0.18, 1046.5, 0.12, "square", [[1, 0.12]]);
      return 1;
    case "soft":
      note(a, out, at, 392, 0.9, "triangle", [[1, 0.5]]);
      note(a, out, at + 0.22, 493.88, 0.9, "triangle", [[1, 0.5]]);
      note(a, out, at + 0.44, 587.33, 1.3, "triangle", [[1, 0.5]]);
      return 1.8;
    default:
      return 0;
  }
}

/**
 * Ring `sound` `rings` times at `volume` (0〜100). Gives how to stop it early
 * (the notice closed); does nothing where there is no sound.
 */
export function playSound(sound: SoundId, volume: number, rings: number): () => void {
  const a = audio();
  if (!a || sound === "none" || volume <= 0) return () => undefined;
  if (a.state === "suspended") void a.resume().catch(() => undefined);
  const out = a.createGain();
  out.gain.value = Math.min(1, Math.max(0, volume / 100));
  out.connect(a.destination);
  let at = a.currentTime + 0.05;
  for (let i = 0; i < Math.max(1, rings); i++) at += ring(a, out, sound, at) + 0.25;
  return () => {
    try {
      out.gain.cancelScheduledValues(a.currentTime);
      out.gain.setValueAtTime(out.gain.value, a.currentTime);
      out.gain.linearRampToValueAtTime(0, a.currentTime + 0.08);
      window.setTimeout(() => out.disconnect(), 200);
    } catch {
      // Already gone.
    }
  };
}
