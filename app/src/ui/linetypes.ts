// 設定 › セリフ: the セリフ種類 made for the name — name, base kind, whether the
// speaker's フキダシ設定 is used, and the look. Changing one changes the lines of
// that type that still had its look.
import { KIND_LABELS } from "../domain/dialogue";
import { addLineType, changeLooks, removeLineType } from "../domain/linelook";
import type { LineKind, LineLook, LineType, Project } from "../model/model";
import { choice, element } from "../platform/dom";
import { lookFields } from "./lookfields";

export interface LineTypesHost {
  project(): Project | null;
  edit(change: (project: Project) => void): void;
  status(message: string): void;
}

/** `own`: drawn again after a change made here (otherwise left alone while one of its fields is being typed in). */
export function renderLineTypes(box: HTMLElement, host: LineTypesHost, own = false): void {
  if (!own && box.contains(document.activeElement)) return;
  const project = host.project();
  const types = project?.lineTypes ?? [];
  /** Change type `id` (its lines that had its look follow). */
  const change = (id: string, what: string, apply: (type: LineType, project: Project) => void) => {
    let count = 0;
    host.edit((p) => {
      const type = p.lineTypes?.find((t) => t.id === id);
      if (type) count = changeLooks(p, () => apply(type, p));
    });
    renderLineTypes(box, host, true);
    host.status(`種類の${what}を変えました${count ? `（セリフ ${count} 個も変わりました）` : ""}`);
  };
  const blocks = types.map((type) => {
    const name = element("input", { type: "text", value: type.name, className: "line-type-name", title: "種類の名前" });
    name.addEventListener("change", () => {
      const text = name.value.trim();
      if (text && text !== type.name) change(type.id, "名前", (t) => (t.name = text));
    });
    const base = choice(KIND_LABELS, type.base, (kind: LineKind) =>
      change(type.id, "もと", (t, p) => {
        t.base = kind;
        // Its lines take the new base as their kind too.
        for (const page of p.pages) for (const line of page.lines) if (line.type === t.id) line.kind = kind;
      }),
    );
    base.title = "もとにする種類（しっぽの形・書き出しの扱い・用途ごとのフォントはこれに従います）";
    const own = element("input", { type: "checkbox", checked: !!type.ownLook });
    own.addEventListener("change", () =>
      change(type.id, "人物の扱い", (t) => {
        if (own.checked) t.ownLook = true;
        else delete t.ownLook;
      }),
    );
    const remove = element("button", {
      className: "small danger",
      textContent: "消す",
      title: "この種類を消す（セリフはもとの種類に戻ります）",
    });
    remove.addEventListener("click", () => {
      let count = 0;
      host.edit((p) => (count = removeLineType(p, type.id)));
      renderLineTypes(box, host, true);
      host.status(`種類「${type.name}」を消しました（そのセリフ ${count} 個は「${KIND_LABELS[type.base]}」に）`);
    });
    const { id: _id, name: _name, base: _base, ownLook: _own, ...look } = type;
    const fields = lookFields(look, "作品の既定", (next: LineLook) =>
      change(type.id, "見た目", (t) => {
        for (const key of ["shape", "font", "fontSizePt", "inverted", "edge"] as const) delete t[key];
        Object.assign(t, next);
      }),
    );
    return element(
      "div",
      { className: "line-type" },
      element("div", { className: "line-type-head" }, name, base, remove),
      element(
        "label",
        { className: "inline", title: "誰のセリフでも、人物のフキダシ設定を使わずにこの種類の見た目にする" },
        own,
        "人物に従わない",
      ),
      ...fields,
    );
  });
  const add = element("button", { textContent: "＋ 種類を足す", disabled: !project });
  add.addEventListener("click", () => {
    let made: LineType | undefined;
    host.edit((p) => (made = addLineType(p, "speech", `種類${(p.lineTypes?.length ?? 0) + 1}`)));
    renderLineTypes(box, host, true);
    if (made) host.status(`種類「${made.name}」を足しました。名前と見た目を決めて、右の欄の「種類」で選びます`);
    box.querySelector<HTMLInputElement>(".line-type:last-of-type .line-type-name")?.focus();
  });
  box.replaceChildren(...blocks, add);
}
