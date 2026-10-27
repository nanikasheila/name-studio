// CSP のセリフを読み戻す, one change at a time: every change CSP made is
// listed with a box to tick, all ticked to start with. What is left unticked
// stays as the name has it (and the next セリフだけ反映 puts it in CSP too).
import { element } from "./dom";
import { pickTakeBack, type TakeBack } from "./readback";

const flat = (text: string) => text.replace(/\n/g, " ");

/** The changes to take back, as chosen (null: none, or やめる). */
export function chooseTakeBack(plan: TakeBack, where: string): Promise<TakeBack | null> {
  const dialog = element("dialog", { className: "export readback-pick", id: "readback-pick" });
  const boxes = { retyped: [] as HTMLInputElement[], added: [] as HTMLInputElement[], removed: [] as HTMLInputElement[] };
  const row = (list: HTMLInputElement[], text: string) => {
    const box = element("input", { type: "checkbox", checked: true });
    list.push(box);
    return element("label", { className: "check readback-item" }, box, text);
  };
  const section = (title: string, rows: HTMLElement[]) => (rows.length ? [element("h4", { textContent: `${title}（${rows.length}）` }), ...rows] : []);
  const go = element("button", { type: "button", className: "primary", id: "readback-go" });
  const count = () => Object.values(boxes).reduce((sum, list) => sum + list.filter((box) => box.checked).length, 0);
  const update = () => {
    go.textContent = `${count()} 件を読み戻す`;
    go.disabled = count() === 0;
  };
  const all = element("button", { type: "button", textContent: "全部選ぶ" });
  const none = element("button", { type: "button", textContent: "全部外す" });
  const stop = element("button", { type: "button", textContent: "やめる" });
  const conflicts = plan.conflicts.length
    ? [element("p", { className: "hint", textContent: `ネームでも変えていたので、ネームのままにするもの ${plan.conflicts.length}: ${plan.conflicts.map((c) => `${c.page + 1}p「${flat(c.csp)}」`).join("、")}` })]
    : [];
  dialog.append(
    element("h3", { textContent: "CSP で変えたセリフを読み戻す" }),
    element("p", { className: "hint", textContent: `${where} のページ。外したものはネームのまま（次の「セリフだけ反映」で CSP もネームに合わせます）。元に戻すは Ctrl+Z。` }),
    element(
      "div",
      { className: "readback-list" },
      ...section("CSP で直した", plan.retyped.map((r) => row(boxes.retyped, `${r.page + 1}p「${flat(r.from)}」→「${flat(r.to)}」`))),
      ...section("CSP で足した", plan.added.map((a) => row(boxes.added, `${a.page + 1}p「${flat(a.text)}」`))),
      ...section("CSP で消した", plan.removed.map((r) => row(boxes.removed, `${r.page + 1}p「${flat(r.text)}」`))),
    ),
    ...conflicts,
    element("div", { className: "actions" }, all, none, stop, go),
  );
  update();
  dialog.addEventListener("change", update);
  const tick = (on: boolean) => {
    for (const list of Object.values(boxes)) for (const box of list) box.checked = on;
    update();
  };
  all.addEventListener("click", () => tick(true));
  none.addEventListener("click", () => tick(false));
  document.body.append(dialog);
  dialog.showModal();
  return new Promise((resolve) => {
    const close = (result: TakeBack | null) => {
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
      close(pickTakeBack(plan, { retyped: boxes.retyped.map((b) => b.checked), added: boxes.added.map((b) => b.checked), removed: boxes.removed.map((b) => b.checked) })),
    );
  });
}
