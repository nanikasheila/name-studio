// Pictures a written page would show but that cannot be read: an image the
// name no longer holds, or data that is not the picture its type says. They
// would drop out of the CSP pages, the PDF and the ミニネーム without a word,
// so the export asks first (and the batch export says so in its report). The
// name sheet's roughs are read from the sheet itself: one moved or deleted
// since takes them out of the pages the same way, so they are asked about too.
import { onPageOnly } from "./aside";
import type { Project, ReferenceImage, RoughImage, StoredImage } from "./model";
import { decodePicture } from "./pictures";
import { imageOf } from "./references";

export interface UnreadablePicture {
  /** The file it came from (or its id when the name no longer holds it). */
  name: string;
  /** Page numbers (from 1) it lies on. */
  pages: number[];
  /** "missing": not in the name's images; "broken": there, but it does not decode. */
  reason: "missing" | "broken";
}

/** Decodes a stored picture; the browser's by default (a test passes its own). */
export type Decode = (image: StoredImage) => Promise<{ close(): void }>;

/**
 * The pictures `takes` picks on the pages (their parts on the page, as written
 * out) that cannot be read, in page order. Each picture is tried once.
 */
export async function unreadablePictures(project: Project, takes: (reference: ReferenceImage) => boolean, decode: Decode = decodePicture): Promise<UnreadablePicture[]> {
  const found = new Map<string, UnreadablePicture>();
  const readable = new Set<string>();
  for (const [index, page] of project.pages.entries()) {
    for (const reference of onPageOnly(page, project.pageFormat).references ?? []) {
      if (!takes(reference) || readable.has(reference.image)) continue;
      const known = found.get(reference.image);
      if (known) {
        if (!known.pages.includes(index + 1)) known.pages.push(index + 1);
        continue;
      }
      const image = imageOf(project, reference);
      const reason = !image ? "missing" : await decode(image).then((picture) => (picture.close(), null), () => "broken" as const);
      if (reason) found.set(reference.image, { name: image?.name || reference.image, pages: [index + 1], reason });
      else readable.add(reference.image);
    }
  }
  return [...found.values()];
}

/** What to tell before writing, or null when every picture can be read. */
export function unreadableNote(pictures: readonly UnreadablePicture[]): string | null {
  if (!pictures.length) return null;
  const line = ({ name, pages, reason }: UnreadablePicture) =>
    `・${pages.join("・")} ページ「${name}」（${reason === "missing" ? "ネームに画像がありません" : "画像として読めません"}）`;
  return `読めない画像が ${pictures.length} 枚あります。書き出すと、その画像は入りません。\n${pictures.map(line).join("\n")}`;
}

/** Roughs of the name sheet (ネーム用紙) on the pages that cannot be read from it. */
export interface UnreadableRoughs {
  /** The sheet they are read from, as the name records it. */
  sheet: string | null;
  /** Page numbers (from 1) with a rough that cannot be read. */
  pages: number[];
  /** Why (the first rough's reason; one sheet, so mostly the same for all). */
  reason: string;
}

/**
 * The roughs on the pages that cannot be read (`problem`: why one cannot, or
 * null when it can), or null when all can. They are read again from the sheet
 * each time the name is opened, so a sheet moved or deleted since loses them.
 */
export async function unreadableRoughs(project: Project, problem: (rough: RoughImage) => Promise<string | null>): Promise<UnreadableRoughs | null> {
  const pages: number[] = [];
  let reason: string | null = null;
  for (const [index, page] of project.pages.entries()) {
    for (const rough of page.roughs) {
      const why = await problem(rough);
      if (!why) continue;
      reason ??= why;
      if (!pages.includes(index + 1)) pages.push(index + 1);
    }
  }
  return reason === null ? null : { sheet: project.source?.path ?? null, pages, reason };
}

/** What to tell before writing pages without their roughs. */
export function unreadableRoughsNote({ sheet, pages, reason }: UnreadableRoughs): string {
  return [
    `元のネーム用紙のラフを ${pages.length} ページ分読めません。書き出すと、そのラフは入りません。`,
    `・ページ: ${pages.join("・")}`,
    `・ネーム用紙: ${sheet ?? "（記録がありません）"}`,
    `・理由: ${reason}`,
  ].join("\n");
}

/** The name as written without the sheet's roughs (the name itself is left as it is). */
export function withoutRoughs(project: Project): Project {
  return { ...project, pages: project.pages.map((page) => ({ ...page, roughs: [] })) };
}
