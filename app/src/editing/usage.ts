// 使われ方: how this app is used on this computer, counted here and never
// sent anywhere: which commands are run (by key, from the palette or a
// button), which tools are taken up, what is written out, and on how many
// days. Settings › この PC › 使われ方 shows it, can copy it as text (for the
// person to pass on if they wish) and clears it. Counting can be turned off.

/** What is counted: a command run, a tool taken up, a kind of export written. */
export type UseKind = "command" | "tool" | "export";

export interface UseCount {
  count: number;
  /** When it was last used (ms since 1970). */
  lastMs: number;
}

export interface Usage {
  /** Counting on (the default) or off. */
  on: boolean;
  /** When counting began (or was last cleared). */
  sinceMs: number;
  /** How many different days the app was used on, and the last of them (YYYY-MM-DD, local). */
  days: number;
  lastDay: string;
  counts: Record<UseKind, Record<string, UseCount>>;
}

export function emptyUsage(nowMs: number, on = true): Usage {
  return { on, sinceMs: nowMs, days: 0, lastDay: "", counts: { command: {}, tool: {}, export: {} } };
}

/** A local calendar day as YYYY-MM-DD. */
export function dayOf(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Usage read back from storage (or anything): what does not read is left out. */
export function usageFrom(value: unknown, nowMs: number): Usage {
  const kept = (value && typeof value === "object" ? value : {}) as Partial<Usage>;
  const usage = emptyUsage(typeof kept.sinceMs === "number" ? kept.sinceMs : nowMs, kept.on !== false);
  usage.days = typeof kept.days === "number" && kept.days >= 0 ? Math.floor(kept.days) : 0;
  usage.lastDay = typeof kept.lastDay === "string" ? kept.lastDay : "";
  for (const kind of Object.keys(usage.counts) as UseKind[]) {
    const counts = kept.counts?.[kind];
    if (!counts || typeof counts !== "object") continue;
    for (const [id, use] of Object.entries(counts)) {
      if (use && typeof use.count === "number" && use.count > 0)
        usage.counts[kind][id] = { count: Math.floor(use.count), lastMs: typeof use.lastMs === "number" ? use.lastMs : 0 };
    }
  }
  return usage;
}

/** The app was used today: a new day is counted once. False when nothing changed. */
export function usedToday(usage: Usage, nowMs: number): boolean {
  if (!usage.on) return false;
  const day = dayOf(nowMs);
  if (usage.lastDay === day) return false;
  usage.lastDay = day;
  usage.days += 1;
  return true;
}

/** Count one use of `id`. False when counting is off. */
export function countUse(usage: Usage, kind: UseKind, id: string, nowMs: number): boolean {
  if (!usage.on || !id) return false;
  usedToday(usage, nowMs);
  const use = (usage.counts[kind][id] ??= { count: 0, lastMs: 0 });
  use.count += 1;
  use.lastMs = nowMs;
  return true;
}

export interface UseRow {
  id: string;
  label: string;
  count: number;
  lastMs: number;
}

/** The most used of a kind, most first (then the latest), named by `label` (the id when it has no name). */
export function topUses(usage: Usage, kind: UseKind, label: (id: string) => string | undefined, limit = 10): UseRow[] {
  return Object.entries(usage.counts[kind])
    .map(([id, use]) => ({ id, label: label(id) ?? id, count: use.count, lastMs: use.lastMs }))
    .sort((a, b) => b.count - a.count || b.lastMs - a.lastMs)
    .slice(0, limit);
}

/** How many uses of a kind in all. */
export function totalUses(usage: Usage, kind: UseKind): number {
  return Object.values(usage.counts[kind]).reduce((sum, use) => sum + use.count, 0);
}

const KIND_TITLES: Record<UseKind, string> = { command: "よく使う命令", tool: "よく使う道具", export: "書き出し" };

/** All of it as plain text, to copy and pass on (nothing is sent by the app). */
export function usageText(usage: Usage, label: (kind: UseKind, id: string) => string | undefined): string {
  const lines = [`Name Studio の使われ方（${dayOf(usage.sinceMs)} から、使った日 ${usage.days} 日）`];
  for (const kind of Object.keys(KIND_TITLES) as UseKind[]) {
    const rows = topUses(usage, kind, (id) => label(kind, id), Number.POSITIVE_INFINITY);
    lines.push("", `${KIND_TITLES[kind]}（合わせて ${totalUses(usage, kind)} 回）`);
    if (!rows.length) lines.push("  まだありません");
    for (const row of rows) lines.push(`  ${row.label}: ${row.count} 回`);
  }
  return lines.join("\n");
}

export { KIND_TITLES as USE_KIND_TITLES };
