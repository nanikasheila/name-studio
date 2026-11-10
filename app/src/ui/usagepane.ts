// 設定 › この PC › 使われ方: what has been counted on this computer (the most
// used commands, tools and exports, and on how many days), counting on or
// off, copying it as text and clearing it. Nothing is sent anywhere.
import { $, element } from "../platform/dom";
import { clearUsage, setCounting, usageNow } from "../platform/usagestore";
import { ask } from "../platform/dialogs";
import { dayOf, topUses, totalUses, USE_KIND_TITLES, type UseKind, usageText } from "../editing/usage";
import { TOOLS, type ToolId } from "../editing/tooldefs";

export type UseLabel = (kind: UseKind, id: string) => string | undefined;

/** What each kind of export (and セリフだけ反映) is called. */
const EXPORT_LABELS: Record<string, string> = {
  csp: "CLIP STUDIO PAINT",
  pdf: "PDF",
  mini: "ミニネーム",
  text: "台本（テキスト）",
  update: "セリフだけ反映",
};

/** Names for what is counted: the commands by their labels, the tools, the exports. */
export function useLabels(commands: () => readonly { id: string; label: string }[]): UseLabel {
  return (kind, id) =>
    kind === "command"
      ? commands().find((command) => command.id === id)?.label
      : kind === "tool"
        ? TOOLS[id as ToolId]?.label
        : EXPORT_LABELS[id];
}

export class UsagePane {
  constructor(
    private readonly label: UseLabel,
    private readonly status: (message: string) => void,
  ) {
    $<HTMLInputElement>("st-usage-on").addEventListener("change", (event) => {
      const on = (event.target as HTMLInputElement).checked;
      setCounting(on);
      this.status(on ? "使われ方を数えます（この PC の中だけ）" : "使われ方を数えるのをやめました（数えたものは残っています）");
      this.render();
    });
    $("st-usage-copy").addEventListener("click", () => {
      const text = usageText(usageNow(), this.label);
      navigator.clipboard.writeText(text).then(
        () => this.status("使われ方をテキストでコピーしました"),
        () => this.status("コピーできませんでした"),
      );
    });
    $("st-usage-clear").addEventListener("click", async () => {
      const sure = await ask("数えた使われ方を全部消しますか？", {
        title: "Name Studio",
        kind: "warning",
        okLabel: "消す",
        cancelLabel: "やめる",
      });
      if (!sure) return;
      clearUsage();
      this.status("数えた使われ方を消しました");
      this.render();
    });
  }

  render(): void {
    const usage = usageNow();
    $<HTMLInputElement>("st-usage-on").checked = usage.on;
    $("st-usage-since").textContent =
      `${dayOf(usage.sinceMs)} から、使った日 ${usage.days} 日${usage.on ? "" : "（いまは数えていません）"}`;
    $("st-usage-lists").replaceChildren(
      ...(Object.keys(USE_KIND_TITLES) as UseKind[]).map((kind) => {
        const rows = topUses(usage, kind, (id) => this.label(kind, id));
        const list = element("ol", { className: "usage-list" });
        for (const row of rows)
          list.append(
            element(
              "li",
              {},
              element("span", { textContent: row.label }),
              element("span", { className: "usage-count", textContent: `${row.count} 回` }),
            ),
          );
        return element(
          "div",
          { className: "usage-kind" },
          element("h4", { textContent: `${USE_KIND_TITLES[kind]}（合わせて ${totalUses(usage, kind)} 回）` }),
          rows.length ? list : element("p", { className: "hint", textContent: "まだありません" }),
        );
      }),
    );
  }
}
