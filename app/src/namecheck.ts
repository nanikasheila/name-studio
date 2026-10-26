// 書き出し前のチェック: dialogue that will need fixing by hand in CSP, found
// before the export: balloons on top of each other, lines outside every
// panel or reaching past their own, balloons past the trim, speech with no
// tail, and balloons over a face in the rough.
import { onFace, spills } from "./arrange";
import { balloonExtent, resolvedShape } from "./balloon";
import { boxCenter, insidePolygon } from "./geometry";
import type { BoxMm, Project } from "./model";
import { trimBox } from "./pagebox";

export type IssueKind = "overlap" | "outside" | "spill" | "trim" | "tail" | "face";

export interface NameIssue {
  kind: IssueKind;
  pageId: string;
  /** 1-based page number. */
  page: number;
  lineId: string;
  /** What to show: the start of the line's text. */
  text: string;
}

export const ISSUE_LABELS: Record<IssueKind, string> = {
  overlap: "フキダシの重なり",
  outside: "コマの外のセリフ",
  spill: "コマからはみ出し",
  trim: "仕上がりの外",
  tail: "しっぽなし",
  face: "顔にかかるセリフ",
};

/** How much two balloons may touch before it counts (mm², about a corner). */
const OVERLAP_MM2 = 12;

function overlapArea(a: BoxMm, b: BoxMm): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export function checkName(project: Project): NameIssue[] {
  const issues: NameIssue[] = [];
  const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
  project.pages.forEach((page, index) => {
    const add = (kind: IssueKind, line: { id: string; text: string }) =>
      issues.push({ kind, pageId: page.id, page: index + 1, lineId: line.id, text: line.text.replace(/\s+/g, "").slice(0, 14) });
    const extents = page.lines.map((line) => ({ line, box: balloonExtent(line) }));
    extents.forEach(({ line, box }, i) => {
      if (extents.slice(i + 1).some((other) => other.line.linkTo !== line.id && line.linkTo !== other.line.id && overlapArea(box, other.box) > OVERLAP_MM2)) {
        add("overlap", line);
      }
      const panel = page.panels.find((p) => p.id === line.panel);
      if (page.panels.length && !page.panels.some((panel) => insidePolygon(panel.shape, boxCenter(line.box)))) add("outside", line);
      else if (panel && line.kind !== "sfx" && spills(box, panel.shape)) add("spill", line);
      if (box[0] < tx0 || box[1] < ty0 || box[2] > tx1 || box[3] > ty1) add("trim", line);
      if (onFace(page, line)) add("face", line);
      const balloon = resolvedShape(line) !== "none";
      if (balloon && line.kind === "speech" && !line.tails?.length && !line.linkTo && !page.lines.some((other) => other.linkTo === line.id)) add("tail", line);
    });
  });
  return issues;
}

/** 「重なり 3・コマの外 2」 */
export function issueSummary(issues: readonly NameIssue[]): string {
  const counts = new Map<IssueKind, number>();
  for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${ISSUE_LABELS[kind]} ${count}`).join("・");
}
