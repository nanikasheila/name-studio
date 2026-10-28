// 動作の記録: what perfmeter.ts measured while the app was used, in words,
// to see how the pen and the screen keep up on this computer (and to copy
// and send when something feels slow).
import { element, plainButton } from "./dom";
import type { PerfReport, Spread } from "./perfmeter";

const ms = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
const spread = (s: Spread) => `ふだん ${ms(s.median)}・遅いとき ${ms(s.p95)}・最大 ${ms(s.max)}`;

/** The report as lines of text (what the dialog shows and what is copied). */
export function reportLines(report: PerfReport): string[] {
  const minutes = Math.round(report.uptime / 60);
  const lines = [`動作の記録（起動から ${minutes < 1 ? `${Math.round(report.uptime)} 秒` : `${minutes} 分`}）`];
  lines.push("■ ペン");
  if (report.penLatency) {
    lines.push(`入力から画面まで: ${spread(report.penLatency)}（${report.penLatency.count} フレーム）`);
  } else {
    lines.push("まだペン（ラフのペン・指示）で描いていません");
  }
  if (report.penFrame) lines.push(`1 フレームの処理: ${spread(report.penFrame)}`);
  if (report.penInterval) lines.push(`描いている間のフレームの間隔: ${spread(report.penInterval)}`);
  if (report.penRate) lines.push(`ペンの報告: 1 秒に ${report.penRate} 回`);
  if (report.dragLatency || report.dragFrame) {
    lines.push("■ ほかのドラッグ（移動・消しゴム・コマ割りなど）");
    if (report.dragLatency) lines.push(`入力から画面まで: ${spread(report.dragLatency)}`);
    if (report.dragFrame) lines.push(`1 フレームの処理: ${spread(report.dragFrame)}`);
  }
  lines.push("■ 止まった時間（1 フレームが 50 ms を超えたとき）");
  if (!report.long.supported) lines.push("この画面では数えられません");
  else if (!report.long.count) lines.push("ありません");
  else {
    lines.push(`${report.long.count} 回・合わせて ${ms(report.long.total)}。長かった順:`);
    for (const long of report.long.worst.slice(0, 5)) {
      lines.push(`  ${long.at} 秒目に ${ms(long.duration)}${long.scripts.length ? `（${long.scripts.join("、")}）` : ""}`);
    }
  }
  lines.push("■ メモリ");
  if (report.memory) lines.push(`使っている量: 起動時 ${report.memory.first} MB・今 ${report.memory.now} MB・いちばん多いとき ${report.memory.most} MB`);
  else lines.push("この画面では分かりません");
  const r = report.resources;
  if (r.pages) {
    lines.push(`開いているネーム: ${r.pages} ページ・ラフ線 ${r.strokes} 本・元に戻せる ${r.undo} 回（やり直し ${r.redo} 回）`);
    lines.push(`速く描くための絵: 線の絵 ${r.linePictures} 枚 ${r.linePicturesMb} MB・画面の写し ${r.screenCopyMb} MB`);
  }
  if (report.startup) {
    lines.push("■ 起動");
    lines.push(report.startup.process !== null ? `アプリの起動から使えるまで ${ms(report.startup.process)}（画面の読み込みからは ${ms(report.startup.page)}）` : `画面の読み込みから使えるまで ${ms(report.startup.page)}`);
  }
  return lines;
}

export class PerfDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly body: HTMLPreElement;
  private timer = 0;

  constructor(
    private readonly report: () => PerfReport,
    private readonly reset: () => void,
    private readonly status: (message: string) => void,
  ) {
    this.body = element("pre", { className: "perf-report" });
    const copy = plainButton("コピー", () => void this.copy());
    copy.type = "button";
    const again = plainButton("数え直す", () => {
      this.reset();
      this.render();
    });
    again.type = "button";
    const close = element("button", { textContent: "閉じる", value: "cancel" });
    const form = element(
      "form",
      { method: "dialog" },
      element("h2", { textContent: "動作の記録" }),
      element("p", { className: "hint", textContent: "この PC で使っている間の、ペンが画面に出るまでの時間・止まった時間・メモリです。描き心地が気になるときは、いつものように描いてから開き、「コピー」して送ってください。" }),
      this.body,
      element("div", { className: "actions" }, again, copy, close),
    );
    this.dialog = element("dialog", { className: "export perf-dialog", id: "perf-dialog" }, form);
    document.body.append(this.dialog);
    this.dialog.addEventListener("close", () => clearInterval(this.timer));
  }

  open(): void {
    this.render();
    this.dialog.showModal();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  private render(): void {
    this.body.textContent = reportLines(this.report()).join("\n");
  }

  private async copy(): Promise<void> {
    const report = this.report();
    const text = `${reportLines(report).join("\n")}\n\n${JSON.stringify({ ...report, memory: report.memory && { ...report.memory, samples: report.memory.samples.slice(-60) } })}`;
    try {
      await navigator.clipboard.writeText(text);
      this.status("動作の記録をコピーしました");
    } catch (error) {
      this.status(`コピーできませんでした: ${error}`);
    }
  }
}
