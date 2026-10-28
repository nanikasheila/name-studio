// The tablet settings dialog: 筆圧カーブ with a pad to try it on and to
// set it by drawing, and the pen's and fingers' other settings.
import { curveAt } from "./brush";
import { CURSOR_LABELS, LINEAR, SIDE_BUTTON_LABELS, TOUCH_LABELS, adjustPressure, fitPressureCurve, type PenSettings } from "./pen";
import type { PenPreferences } from "./prefs";
import { $ } from "./dom";

const PRESETS: Record<string, [number, number][]> = {
  soft: [
    [0, 0],
    [0.25, 0.6],
    [1, 1],
  ],
  linear: LINEAR,
  hard: [
    [0, 0],
    [0.7, 0.3],
    [1, 1],
  ],
};

const POINT = 6;

export class PenDialog {
  private dragging = -1;
  /** Pressures read while 描いて調節 is on. */
  private samples: number[] | null = null;
  private padLast: [number, number] | null = null;

  constructor(private readonly preferences: PenPreferences) {
    const fill = (id: string, labels: Record<string, string>) => {
      $<HTMLSelectElement>(id).replaceChildren(...Object.entries(labels).map(([value, label]) => new Option(label, value)));
    };
    fill("pen-side", SIDE_BUTTON_LABELS);
    fill("pen-touch", TOUCH_LABELS);
    fill("pen-cursor", CURSOR_LABELS);
    const checks: [string, keyof PenSettings][] = [
      ["pen-tilt", "tilt"],
      ["pen-eraser-end", "eraserEnd"],
      ["pen-pinch", "pinch"],
      ["pen-pinch-rotate", "pinchRotate"],
      ["pen-taps", "touchTaps"],
      ["pen-palm", "palmRejection"],
      ["pen-predict", "predict"],
    ];
    for (const [id, key] of checks) {
      $<HTMLInputElement>(id).addEventListener("change", (event) => this.preferences.update({ [key]: (event.target as HTMLInputElement).checked }));
    }
    $("pen-side").addEventListener("change", (event) => this.preferences.update({ sideButton: (event.target as HTMLSelectElement).value as PenSettings["sideButton"] }));
    $("pen-touch").addEventListener("change", (event) => this.preferences.update({ touch: (event.target as HTMLSelectElement).value as PenSettings["touch"] }));
    $("pen-cursor").addEventListener("change", (event) => this.preferences.update({ cursor: (event.target as HTMLSelectElement).value as PenSettings["cursor"] }));
    for (const button of document.querySelectorAll<HTMLButtonElement>("#pen-dialog [data-curve]")) {
      button.addEventListener("click", () => this.setCurve(PRESETS[button.dataset.curve!]));
    }
    $("pen-reset").addEventListener("click", () => {
      this.preferences.reset();
      this.render();
    });
    $("pen-calibrate").addEventListener("click", () => this.calibrate());
    $("pen-pad-clear").addEventListener("click", () => this.clearPad());
    this.wireCurve();
    this.wirePad();
  }

  open(): void {
    this.samples = null;
    this.render();
    this.clearPad();
    $<HTMLDialogElement>("pen-dialog").showModal();
  }

  private render(): void {
    const s = this.preferences.settings;
    $<HTMLInputElement>("pen-tilt").checked = s.tilt;
    $<HTMLInputElement>("pen-eraser-end").checked = s.eraserEnd;
    $<HTMLInputElement>("pen-pinch").checked = s.pinch;
    $<HTMLInputElement>("pen-pinch-rotate").checked = s.pinchRotate;
    $<HTMLInputElement>("pen-pinch-rotate").disabled = !s.pinch;
    $<HTMLInputElement>("pen-taps").checked = s.touchTaps;
    $<HTMLInputElement>("pen-palm").checked = s.palmRejection;
    $<HTMLInputElement>("pen-predict").checked = s.predict;
    $<HTMLSelectElement>("pen-side").value = s.sideButton;
    $<HTMLSelectElement>("pen-touch").value = s.touch;
    $<HTMLSelectElement>("pen-cursor").value = s.cursor;
    const calibrate = $("pen-calibrate");
    calibrate.classList.toggle("recording", this.samples !== null);
    calibrate.textContent = this.samples ? "この線で決める" : "描いて調節";
    this.drawCurve();
  }

  private setCurve(curve: [number, number][]): void {
    this.preferences.update({ pressureCurve: curve.map((p) => [...p] as [number, number]) });
    this.render();
  }

  // --- 筆圧カーブ ------------------------------------------------------------------

  private get curveCanvas(): HTMLCanvasElement {
    return $<HTMLCanvasElement>("pen-curve");
  }

  /** Graph px of a curve point (pressure right, output up), with room for the points at the edges. */
  private toGraph([x, y]: [number, number]): [number, number] {
    const { width, height } = this.curveCanvas;
    return [POINT + x * (width - 2 * POINT), height - POINT - y * (height - 2 * POINT)];
  }

  private fromGraph(gx: number, gy: number): [number, number] {
    const { width, height } = this.curveCanvas;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [clamp((gx - POINT) / (width - 2 * POINT)), clamp((height - POINT - gy) / (height - 2 * POINT))];
  }

  private drawCurve(raw?: number): void {
    const canvas = this.curveCanvas;
    const ctx = canvas.getContext("2d")!;
    const curve = this.preferences.settings.pressureCurve;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#e4e2dc";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const [gx, gy] = this.toGraph([i / 4, i / 4]);
      ctx.beginPath();
      ctx.moveTo(gx, POINT);
      ctx.lineTo(gx, canvas.height - POINT);
      ctx.moveTo(POINT, gy);
      ctx.lineTo(canvas.width - POINT, gy);
      ctx.stroke();
    }
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(...this.toGraph([0, 0]));
    ctx.lineTo(...this.toGraph([1, 1]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#2f6fdb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const [gx, gy] = this.toGraph([x, curveAt(curve, x)]);
      if (i) ctx.lineTo(gx, gy);
      else ctx.moveTo(gx, gy);
    }
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    for (const point of curve) {
      const [gx, gy] = this.toGraph(point);
      ctx.beginPath();
      ctx.arc(gx, gy, POINT - 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const [first, last] = [curve[0], curve[curve.length - 1]];
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    $("pen-curve-ends").textContent = `下限: 筆圧 ${percent(first[0])} → ${percent(first[1])}　上限: 筆圧 ${percent(last[0])} → ${percent(last[1])}`;
    if (raw !== undefined) {
      // Where the pen's press is now.
      const [gx, gy] = this.toGraph([raw, curveAt(curve, raw)]);
      ctx.fillStyle = "rgba(214, 120, 40, 0.9)";
      ctx.beginPath();
      ctx.arc(gx, gy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private wireCurve(): void {
    const canvas = this.curveCanvas;
    const pointAt = (event: PointerEvent): number => {
      const curve = this.preferences.settings.pressureCurve;
      return curve.findIndex((point) => {
        const [gx, gy] = this.toGraph(point);
        return Math.hypot(gx - event.offsetX, gy - event.offsetY) <= POINT + 3;
      });
    };
    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      const index = pointAt(event);
      if (index >= 0) {
        this.dragging = index;
        return;
      }
      // A new point where the press is, on its way to being dragged.
      const curve = this.preferences.settings.pressureCurve.map((p) => [...p] as [number, number]);
      const point = this.fromGraph(event.offsetX, event.offsetY);
      // Between the ends only: past them the curve stays flat.
      if (point[0] <= curve[0][0] + 0.01 || point[0] >= curve[curve.length - 1][0] - 0.01) return;
      curve.push(point);
      curve.sort((a, b) => a[0] - b[0]);
      this.dragging = curve.indexOf(point);
      this.setCurve(curve);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.dragging < 0) return;
      const curve = this.preferences.settings.pressureCurve.map((p) => [...p] as [number, number]);
      const [x, y] = this.fromGraph(event.offsetX, event.offsetY);
      const index = this.dragging;
      // Points keep their order. The ends move too: the lightest press that
      // draws (下限) and the press that gives the most (上限) differ from person to person.
      const lo = index === 0 ? 0 : curve[index - 1][0] + 0.01;
      const hi = index === curve.length - 1 ? 1 : curve[index + 1][0] - 0.01;
      curve[index] = [Math.min(Math.max(x, lo), hi), y];
      this.preferences.update({ pressureCurve: curve });
      this.drawCurve();
    });
    const end = () => (this.dragging = -1);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("dblclick", (event) => {
      const curve = this.preferences.settings.pressureCurve;
      const index = pointAt(event as PointerEvent);
      if (index > 0 && index < curve.length - 1) this.setCurve(curve.filter((_, i) => i !== index));
    });
  }

  // --- 試し描き ------------------------------------------------------------------

  private clearPad(): void {
    const pad = $<HTMLCanvasElement>("pen-pad");
    pad.getContext("2d")!.clearRect(0, 0, pad.width, pad.height);
    this.showPressure(null);
  }

  private showPressure(raw: number | null): void {
    const used = raw === null ? null : adjustPressure(this.preferences.settings.pressureCurve, raw);
    $("pen-meter-raw").style.width = `${(raw ?? 0) * 100}%`;
    $("pen-meter-used").style.width = `${(used ?? 0) * 100}%`;
    $("pen-meter-text").textContent = raw === null ? "-" : `${Math.round(raw * 100)} → ${Math.round(used! * 100)}`;
  }

  private wirePad(): void {
    const pad = $<HTMLCanvasElement>("pen-pad");
    const ctx = pad.getContext("2d")!;
    const pressure = (event: PointerEvent) => (event.pointerType === "pen" ? event.pressure : event.buttons ? 0.5 : 0);
    pad.addEventListener("pointerdown", (event) => {
      pad.setPointerCapture(event.pointerId);
      this.padLast = [event.offsetX, event.offsetY];
    });
    pad.addEventListener("pointermove", (event) => {
      const raw = pressure(event);
      this.showPressure(event.buttons ? raw : null);
      this.drawCurve(event.buttons ? raw : undefined);
      if (!this.padLast || !event.buttons) return;
      for (const e of event.getCoalescedEvents?.() ?? [event]) {
        const p = pressure(e);
        if (this.samples && e.pointerType === "pen") this.samples.push(p);
        const used = adjustPressure(this.preferences.settings.pressureCurve, p);
        ctx.strokeStyle = "#3a3834";
        ctx.lineCap = "round";
        ctx.lineWidth = 0.5 + used * 9;
        ctx.beginPath();
        ctx.moveTo(...this.padLast);
        ctx.lineTo(e.offsetX, e.offsetY);
        ctx.stroke();
        this.padLast = [e.offsetX, e.offsetY];
      }
    });
    const end = () => {
      this.padLast = null;
      this.showPressure(null);
      this.drawCurve();
    };
    pad.addEventListener("pointerup", end);
    pad.addEventListener("pointercancel", end);
  }

  /** 描いて調節: the first press starts recording, the second sets the curve from what was drawn. */
  private calibrate(): void {
    const hint = $("pen-calibrate-hint");
    if (!this.samples) {
      this.samples = [];
      this.clearPad();
      hint.textContent = "ふだんの力で線を何本か引いてから「この線で決める」を押してください。";
      this.render();
      return;
    }
    const curve = fitPressureCurve(this.samples);
    this.samples = null;
    if (!curve) {
      hint.textContent = "ペンの筆圧が読めませんでした。ペンでもう少し長く描いてから試してください。";
      this.render();
      return;
    }
    hint.textContent = "描いた線の力に合わせました。試し描きで確かめてください。";
    this.clearPad();
    this.setCurve(curve);
  }
}
