// 資料画像: photos, backgrounds or earlier panels laid faintly under a page to
// draw the name over. The picture is kept once in the project (made smaller
// when it is taken in) and each page's reference says where it lies.
import { offPage } from "./aside";
import type { BoxMm, Page, Point, Project, ReferenceImage, StoredImage } from "./model";
import { trimBox } from "./pagebox";
import { insertPage, newId } from "./project";

/** Pictures are made no larger than this on their long side when taken in. */
export const MAX_IMAGE_PX = 2400;
export const DEFAULT_OPACITY = 0.5;

/** A picture of the name itself (取り込んだネーム画像), read and written out with the name; else a 資料 picture. */
export function isNamePicture(reference: ReferenceImage): boolean {
  return reference.kind === "name";
}

/** How strongly a picture is written out where the reader sees it (PDF, ミニネーム, 読む): twice the screen's faintness. */
export function writtenOpacity(reference: ReferenceImage): number {
  return Math.min(1, opacityOf(reference) * 2);
}

export function opacityOf(reference: ReferenceImage): number {
  return reference.opacity ?? DEFAULT_OPACITY;
}

export function imageOf(project: Project, reference: ReferenceImage): StoredImage | undefined {
  return project.images?.find((image) => image.id === reference.image);
}

/**
 * Lay `image` on `page` centred at `at` (mm), as wide as about half the
 * trim and never past it; the picture joins the project when it is new.
 */
export function addReference(project: Project, page: Page, image: StoredImage, at?: Point): ReferenceImage {
  if (!project.images?.some((kept) => kept.id === image.id)) project.images = [...(project.images ?? []), image];
  const [tx0, ty0, tx1, ty1] = trimBox(project.pageFormat);
  const aspect = image.heightPx / Math.max(1, image.widthPx);
  let width = (tx1 - tx0) * 0.6;
  let height = width * aspect;
  if (height > (ty1 - ty0) * 0.8) {
    height = (ty1 - ty0) * 0.8;
    width = height / aspect;
  }
  const [cx, cy] = at ?? [(tx0 + tx1) / 2, (ty0 + ty1) / 2];
  const reference: ReferenceImage = { id: newId(project, "reference"), image: image.id, box: [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2] };
  // Beside the page (in the 欄外) it is looked at, not drawn over: at full strength.
  if (offPage(reference.box, project.pageFormat)) reference.opacity = 1;
  page.references = [...(page.references ?? []), reference];
  return reference;
}

/** 取り込んだネーム画像 are kept no larger than this on their long side (a page of a name read small). */
export const MAX_NAME_PICTURE_PX = 2000;

/**
 * Pictures of pages of the name (cut from a ミニネーム) laid on the pages
 * from index `first` on, one each where `box` says, as the pages' pictures
 * of the name: one taken in before on those pages is replaced, 資料 pictures
 * stay. Pages are added at the end when there are too few; how many.
 */
export function placeNamePictures(project: Project, first: number, pictures: readonly { image: StoredImage; box: BoxMm }[]): number {
  let added = 0;
  while (project.pages.length < first + pictures.length) {
    insertPage(project, project.pages.length);
    added++;
  }
  project.images ??= [];
  pictures.forEach(({ image, box }, i) => {
    const page = project.pages[first + i];
    const stored: StoredImage = { ...image, id: newId(project, "image") };
    project.images!.push(stored);
    const kept = (page.references ?? []).filter((reference) => !isNamePicture(reference));
    page.references = [...kept, { id: newId(project, "reference"), image: stored.id, box, kind: "name" }];
  });
  return added;
}

export function removeReference(page: Page, id: string): void {
  page.references = (page.references ?? []).filter((reference) => reference.id !== id);
  if (!page.references.length) delete page.references;
}

/** The topmost reference under a point of the page (mm). */
export function referenceAt(page: Page, [x, y]: Point): ReferenceImage | undefined {
  return [...(page.references ?? [])].reverse().find(({ box }) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
}

/** Corners in the order x0y0, x1y0, x1y1, x0y1. */
export function corners([x0, y0, x1, y1]: BoxMm): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * The box with corner `corner` dragged to `to`, the opposite corner staying
 * put and the picture keeping its shape (never smaller than 5 mm across).
 */
export function resizeBox(box: BoxMm, corner: number, [x, y]: Point): BoxMm {
  const [ox, oy] = corners(box)[(corner + 2) % 4];
  const aspect = (box[3] - box[1]) / Math.max(1e-6, box[2] - box[0]);
  let width = Math.max(5, Math.abs(x - ox));
  let height = width * aspect;
  // Follow whichever way the pointer went further.
  if (Math.abs(y - oy) > height) {
    height = Math.max(5 * aspect, Math.abs(y - oy));
    width = height / aspect;
  }
  const sx = x < ox ? -1 : 1;
  const sy = y < oy ? -1 : 1;
  const [ax, bx] = sx > 0 ? [ox, ox + width] : [ox - width, ox];
  const [ay, by] = sy > 0 ? [oy, oy + height] : [oy - height, oy];
  return [ax, ay, bx, by];
}

/** Pictures some page (or 別案, or 保留) still shows; the rest need not be saved. */
export function usedImages(project: Project): StoredImage[] {
  const used = new Set<string>();
  const visit = (pages: Page[]) => {
    for (const page of pages) for (const reference of page.references ?? []) used.add(reference.image);
  };
  visit(project.pages);
  for (const alternatives of project.alternatives ?? []) for (const option of alternatives.options) visit(option.pages);
  return (project.images ?? []).filter((image) => used.has(image.id));
}

/** The project as it is saved: pictures nothing shows are left out (undo still has them). */
export function savedForm(project: Project): Project {
  if (!project.images?.length) return project;
  const images = usedImages(project);
  if (images.length === project.images.length) return project;
  const copy = { ...project };
  if (images.length) copy.images = images;
  else delete copy.images;
  return copy;
}
