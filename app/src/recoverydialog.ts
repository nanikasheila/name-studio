// At start: the names autosave kept that were never saved, all of them (the
// ones that cannot be read too, with why), each to bring back, keep for
// later (as closing does) or remove for good.
import { ask } from "@tauri-apps/plugin-dialog";
import { formatTime } from "./autosave";
import type { KeptRecovery, Recovery } from "./backend";
import { $, element } from "./dom";
import { unknownFieldsNote } from "./project";

export interface RecoveryDialogHost {
  /** Opens a kept name as unsaved changes; `note` (fields a newer version added) is said with it. */
  restore(recovery: Recovery, note: string | null): void;
  /** Removes a kept name for good (its file in the recovery folder). */
  remove(file: string): Promise<void>;
}

/** What a kept name's row says: what it is, and what is known about it. */
export function recoveryText(kept: KeptRecovery): { title: string; detail: string; notes: string[] } {
  const when = `${formatTime(kept.timeMs)} の自動保存`;
  const recovery = kept.recovery;
  if (!recovery) return { title: `読めない控え（${kept.file}）`, detail: when, notes: [kept.unreadable ?? "読めません"] };
  const where = recovery.path ?? "まだ保存していないネーム";
  const notes = [
    ...(recovery.problems?.length ? [`直せる問題が ${recovery.problems.length} か所あります（復元すると直します）`] : []),
    ...(kept.unknownFields?.length ? [unknownFieldsNote(kept.unknownFields) ?? ""] : []),
  ];
  return { title: recovery.project.title || "（題なし）", detail: `${recovery.project.pages.length} ページ・${when}・${where}`, notes };
}

export class RecoveryDialog {
  private readonly dialog = $<HTMLDialogElement>("recovery-dialog");

  constructor(private readonly host: RecoveryDialogHost) {}

  /** Offers `kept` (newest first) until the dialog closes; closing keeps the rest for the next start. */
  open(kept: readonly KeptRecovery[]): Promise<void> {
    if (!kept.length || this.dialog.open) return Promise.resolve();
    this.render([...kept]);
    this.dialog.showModal();
    return new Promise((done) => this.dialog.addEventListener("close", () => done(), { once: true }));
  }

  private render(kept: KeptRecovery[]): void {
    $("rc-count").textContent = `前回、保存しないまま終わったネームが ${kept.length} 件あります。`;
    $("rc-list").replaceChildren(...kept.map((item) => this.row(item, kept)));
  }

  private row(kept: KeptRecovery, all: KeptRecovery[]): HTMLElement {
    const text = recoveryText(kept);
    const buttons: HTMLElement[] = [];
    const recovery = kept.recovery;
    if (recovery) {
      const restore = element("button", { type: "button", className: "primary", textContent: "復元する" });
      restore.addEventListener("click", () => {
        this.dialog.close();
        this.host.restore(recovery, kept.unknownFields?.length ? unknownFieldsNote(kept.unknownFields) : null);
      });
      buttons.push(restore);
    }
    const remove = element("button", { type: "button", className: "rc-remove", textContent: "削除…" });
    remove.addEventListener("click", () => void this.remove(kept, all));
    buttons.push(remove);
    return element(
      "li",
      { className: recovery ? "rc-item" : "rc-item unreadable" },
      element("div", { className: "rc-title", textContent: text.title }),
      element("div", { className: "rc-detail", textContent: text.detail }),
      ...text.notes.map((note) => element("div", { className: "rc-note", textContent: note })),
      element("div", { className: "rc-actions" }, ...buttons),
    );
  }

  private async remove(kept: KeptRecovery, all: KeptRecovery[]): Promise<void> {
    const sure = await ask(`「${recoveryText(kept).title}」の控えを消します。消すと戻せません。`, {
      title: "Name Studio",
      kind: "warning",
      okLabel: "消す",
      cancelLabel: "やめる",
    });
    if (!sure) return;
    await this.host.remove(kept.file);
    const rest = all.filter((item) => item !== kept);
    if (rest.length) this.render(rest);
    else this.dialog.close();
  }
}
