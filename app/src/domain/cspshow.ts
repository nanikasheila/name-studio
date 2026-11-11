// ツールプロパティに出す項目 as CLIP STUDIO PAINT keeps them with a sub tool
// (the Variant row's `VariantShowParam`): item ids, in the order the palette
// shows them. A `.sut` without it is skipped by CSP without a word, so the
// brushes written out always carry one.
//
// The blob is `u32 12, u32 count, u32 4` and then one big-endian u32 item id
// a record (csp-format: docs/assets/spec/formats.md, レコード).
//
// Which id is which setting was read off CSP itself: the G pen's palette
// (ブラシサイズ・不透明度・アンチエイリアス・手ブレ補正・ベクター吸着) and a
// user's pen showing 表示メニューに従いスナップ. Ids not known here are kept
// as they are (they show in CSP as before).

/** Item id → the Variant column the item shows (only the ones checked in CSP). */
export const SHOW_ITEM_COLUMNS: Readonly<Record<number, string>> = {
  1000: "BrushSize",
  10: "Opacity",
  20: "AntiAlias",
  40: "FlickerReduction",
  1230: "BrushEnableSnap",
  1241: "BrushUseVectorMagnet",
};

const COLUMN_ITEMS = new Map(Object.entries(SHOW_ITEM_COLUMNS).map(([id, column]) => [column, Number(id)]));

/** The item ids of a `VariantShowParam` blob; null when the bytes are not one. */
export function parseShowItems(data: Uint8Array): number[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 12 || view.getUint32(0) !== 12 || view.getUint32(8) !== 4) return null;
  const count = view.getUint32(4);
  if (data.length !== 12 + count * 4) return null;
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(view.getUint32(12 + i * 4));
  return ids;
}

/** The `VariantShowParam` blob of these item ids. */
export function showItemsBytes(ids: readonly number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(12 + ids.length * 4));
  view.setUint32(0, 12);
  view.setUint32(4, ids.length);
  view.setUint32(8, 4);
  ids.forEach((id, i) => view.setUint32(12 + i * 4, id >>> 0));
  return new Uint8Array(view.buffer);
}

/** The columns of the items known here, in their order (the others are left out). */
export function columnsOfShowItems(ids: readonly number[]): string[] {
  return ids.map((id) => SHOW_ITEM_COLUMNS[id]).filter((column): column is string => !!column);
}

/** The item id that shows a column, when known. */
export function showItemOf(column: string): number | undefined {
  return COLUMN_ITEMS.get(column);
}

/**
 * The item ids to write for the columns chosen: those known, in the order
 * chosen, then the ids of `original` not known here (CSP's own items this
 * tool showed: kept, so that nothing shown in CSP goes missing).
 */
export function showItemsFor(columns: readonly string[], original: readonly number[] | null): number[] {
  const ids: number[] = [];
  for (const column of columns) {
    const id = COLUMN_ITEMS.get(column);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  for (const id of original ?? []) if (!(id in SHOW_ITEM_COLUMNS) && !ids.includes(id)) ids.push(id);
  return ids;
}
