// A field to choose a font in: typed, or picked from this computer's fonts
// (a list under the field), with a line of sample text in the font chosen.
import { element } from "./dom";
import { canvasFont, fontChoices } from "./fonts";

const LIST_ID = "font-list";
const SAMPLE = "あいうアイウ漢字！？";
let filledWith: readonly string[] | null = null;

/** The page's one list of font names, brought up to date with the fonts known now. */
function fontList(): void {
  const choices = fontChoices();
  let list = document.getElementById(LIST_ID) as HTMLDataListElement | null;
  if (list && filledWith === choices) return;
  if (!list) {
    list = element("datalist", { id: LIST_ID });
    document.body.append(list);
  }
  list.replaceChildren(...choices.map((name) => element("option", { value: name })));
  filledWith = choices;
}

/**
 * A font field: `value` the font chosen (empty: none), `fallback` what is
 * used without one (shown greyed in the field). `change` gets the name when
 * the field is left or a name is picked (empty for none).
 */
export function fontField(value: string, fallback: string, change: (name: string) => void, title = ""): HTMLElement {
  fontList();
  const input = element("input", { type: "text", value, placeholder: fallback, title, spellcheck: false });
  input.setAttribute("list", LIST_ID);
  input.autocomplete = "off";
  const sample = element("span", { className: "font-sample", textContent: SAMPLE });
  const show = () => (sample.style.font = canvasFont(input.value.trim() || null, 15));
  show();
  input.addEventListener("input", show);
  input.addEventListener("change", () => {
    if (input.value.trim() !== value) change(input.value.trim());
  });
  const clear = element("button", { type: "button", className: "font-clear", textContent: "×", title: "指定をやめる" });
  clear.disabled = !value;
  clear.addEventListener("click", () => {
    input.value = "";
    show();
    if (value) change("");
  });
  return element("span", { className: "font-field" }, input, clear, sample);
}
