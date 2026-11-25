// CSP から読み戻す, one change at a time: every change found in CSP is listed
// with a box to tick (all ticked to start with, but removing dialogue or a
// panel and layers hidden in CSP). What is left unticked stays as the name has it.
import { element } from "../platform/dom";
import { pickTakeBack, type TakeBack } from "../domain/readback";
import { onAddedPage, pickCspTakeBack, panelLabel, startsUnticked, type CspTakeBack } from "../domain/csptakeback";
import type { Project } from "../model/model";

const flat = (text: string) => text.replace(/\n/g, " ");

/** What was picked: the dialogue's changes and the rest. */
export interface ReadBackPick {
  dialogue: TakeBack;
  csp: CspTakeBack;
}

/** The changes to take back, as chosen (null: none, or やめる). */
export function chooseReadBack(project: Project, dialogue: TakeBack, csp: CspTakeBack, where: string): Promise<ReadBackPick | null> {
  const dialog = element("dialog", { className: "export readback-pick", id: "readback-pick" });
  const boxes = { retyped: [] as HTMLInputElement[], added: [] as HTMLInputElement[], removed: [] as HTMLInputElement[] };
  // Each box and the changes it stands for (the lines of a layer of a page go in one).
  const cspBoxes = new Map<HTMLInputElement, string[]>();
  const unticked = startsUnticked(csp);
  const row = (list: HTMLInputElement[], text: string, checked = true) => {
    const box = element("input", { type: "checkbox", checked });
    list.push(box);
    return element("label", { className: "check readback-item" }, box, text);
  };
  const cspRow = (ref: string | string[], text: string, picture?: string) => {
    const refs = typeof ref === "string" ? [ref] : ref;
    const box = element("input", { type: "checkbox", checked: !refs.some((r) => unticked.has(r)) });
    cspBoxes.set(box, refs);
    const label = element("label", { className: "check readback-item" }, box, text);
    if (picture) label.append(element("img", { className: "readback-thumb", src: picture, alt: "" }));
    return label;
  };
  const section = (title: string, rows: HTMLElement[], count = rows.length) =>
    rows.length ? [element("h4", { textContent: `${title}（${count}）` }), ...rows] : [];
  // What is on a page added in CSP goes with the page: listed in its row, not on its own.
  const named = project.pages.length;
  const own = <T extends { page: number }>(list: T[]) => list.filter((item) => item.page < named);
  const pageOf = (id: string) => {
    const index = project.pages.findIndex((page) => page.id === id);
    return index < 0 ? "?" : `${index + 1}p`;
  };
  const addRows = csp.pages.added.map((add) => {
    const refs = onAddedPage(csp, add);
    const on = (item: { page: number }) => item.page === add.page || (add.spread && item.page === add.page + 1);
    const lines = csp.strokesAdded.filter(on).length;
    const panels = csp.panelSketches.filter(on).length + csp.panelsAdded.filter(on).length;
    const pictures = csp.pictures.filter(on).length;
    const what = [
      ...(lines ? [`線 ${lines}`] : []),
      ...(panels ? [`コマ ${panels}`] : []),
      ...(pictures ? [`絵 ${pictures}`] : []),
      ...(add.texts.length ? [`セリフ ${add.texts.length}`] : []),
    ];
    const at = add.after ? `${pageOf(add.after)} の後に` : "最初に";
    const kind = add.spread ? "見開き 2 ページで" : "";
    return cspRow([add.ref, ...refs], `「${add.file}」を${at}${kind}${what.length ? `（${what.join("・")}）` : "（白紙）"}`);
  });
  /** The lines of each layer of a page, in one row. */
  const lineRows = (list: { ref: string; page: number; cspLayer: string; newLayer?: string }[]) => {
    const groups = new Map<string, typeof list>();
    for (const item of list) {
      const key = `${item.page}\u0000${item.cspLayer}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.values()].map((items) => {
      const [first] = items;
      const many = items.length > 1 ? ` ${items.length} 本` : "";
      const made = first.newLayer ? `（新しいラフ線のレイヤー「${first.newLayer}」）` : "";
      return cspRow(
        items.map((item) => item.ref),
        `${p(first.page)} ${layerOf(first.cspLayer)}の線${many}${made}`,
      );
    });
  };
  const go = element("button", { type: "button", className: "primary", id: "readback-go" });
  const count = () =>
    Object.values(boxes).reduce((sum, list) => sum + list.filter((box) => box.checked).length, 0) +
    [...cspBoxes].reduce((sum, [box, refs]) => sum + (box.checked ? refs.length : 0), 0);
  const update = () => {
    go.textContent = `${count()} 件を読み戻す`;
    go.disabled = count() === 0;
  };
  const all = element("button", { type: "button", textContent: "全部選ぶ" });
  const none = element("button", { type: "button", textContent: "全部外す" });
  const stop = element("button", { type: "button", textContent: "やめる" });
  const said = [
    ...(dialogue.conflicts.length
      ? [
          `ネームでも変えていたので、ネームのままにするセリフ ${dialogue.conflicts.length}: ${dialogue.conflicts.map((c) => `${c.page + 1}p「${flat(c.csp)}」`).join("、")}`,
        ]
      : []),
    ...csp.conflicts,
    ...csp.notes,
    ...csp.pages.notes,
  ];
  const p = (page: number) => `${page + 1}p`;
  const layerOf = (name: string) => `「${name}」`;
  dialog.append(
    element("h3", { textContent: "CSP で変えたものを読み戻す" }),
    element("p", {
      className: "hint",
      textContent: `${where} のページ。外したものはネームのままです（次からは聞きません）。元に戻すは Ctrl+Z。`,
    }),
    element(
      "div",
      { className: "readback-list" },
      ...section(
        "CSP で直したセリフ",
        dialogue.retyped.map((r) => row(boxes.retyped, `${p(r.page)}「${flat(r.from)}」→「${flat(r.to)}」`)),
      ),
      ...section(
        "CSP で足したセリフ",
        dialogue.added.map((a) => row(boxes.added, `${p(a.page)}「${flat(a.text)}」`)),
      ),
      ...section(
        "CSP で消したセリフ（はじめは外してあります）",
        dialogue.removed.map((r) => row(boxes.removed, `${p(r.page)}「${flat(r.text)}」`, false)),
      ),
      ...section("CSP で描いた線（ラフ線に）", lineRows(own(csp.strokesAdded)), own(csp.strokesAdded).length),
      ...section("CSP で直した線", lineRows(own(csp.strokesChanged)), own(csp.strokesChanged).length),
      ...section("CSP で消した線", lineRows(own(csp.strokesRemoved)), own(csp.strokesRemoved).length),
      ...section(
        "CSP で形を変えたコマ",
        own(csp.panelsChanged).map((c) =>
          cspRow(c.ref, `${p(c.page)} ${panelLabel(project, c.page, c.panel)}${c.frame ? "（コマ枠フォルダー）" : ""}`),
        ),
      ),
      ...section("CSP で足したコマ・コマ枠に描いた線（囲む＝コマ、横切る＝割る）", [
        ...own(csp.panelsAdded).map((a) => cspRow(a.ref, `${p(a.page)} コマ枠フォルダーのコマ`)),
        ...own(csp.panelSketches).map((s) => cspRow(s.ref, `${p(s.page)} コマ枠の線`)),
      ]),
      ...section(
        "CSP で消したコマ（はじめは外してあります）",
        own(csp.panelsRemoved).map((r) => cspRow(r.ref, `${p(r.page)} ${panelLabel(project, r.page, r.panel)}`)),
      ),
      ...section("CSP で足したページ（描いたもの・セリフごと）", addRows),
      ...(csp.pages.move
        ? section("ページの並び", [
            cspRow(csp.pages.move.ref, `CSP の並びにする（${csp.pages.move.moved.map(pageOf).join("・")} が動きます）`),
          ])
        : []),
      ...section(
        "CSP で消したページ（保留にします。はじめは外してあります）",
        csp.pages.held.map((h) => cspRow(h.ref, `${h.pages.map(pageOf).join("–")}（「${h.file}」）`)),
      ),
      ...section(
        "CSP で描いた絵（「CSP の絵」として、同じ名前のレイヤーに）",
        own(csp.pictures).map((d) =>
          cspRow(
            d.ref,
            `${p(d.page)} ${layerOf(d.cspLayer)}${d.layer !== d.cspLayer ? ` → ${layerOf(d.layer)}` : ""}${d.hidden ? "（CSP で隠したレイヤー）" : ""}`,
            `data:${d.image.mime};base64,${d.image.dataBase64}`,
          ),
        ),
      ),
    ),
    ...said.map((text) => element("p", { className: "hint", textContent: text })),
    element("div", { className: "actions" }, all, none, stop, go),
  );
  update();
  dialog.addEventListener("change", update);
  const tick = (on: boolean) => {
    for (const list of Object.values(boxes)) for (const box of list) box.checked = on;
    for (const box of cspBoxes.keys()) box.checked = on;
    update();
  };
  all.addEventListener("click", () => tick(true));
  none.addEventListener("click", () => tick(false));
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    const close = (result: ReadBackPick | null) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    stop.addEventListener("click", () => close(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(null);
    });
    go.addEventListener("click", () =>
      close({
        dialogue: pickTakeBack(dialogue, {
          retyped: boxes.retyped.map((b) => b.checked),
          added: boxes.added.map((b) => b.checked),
          removed: boxes.removed.map((b) => b.checked),
        }),
        csp: pickCspTakeBack(csp, new Set([...cspBoxes].flatMap(([box, refs]) => (box.checked ? refs : [])))),
      }),
    );
  });
}
