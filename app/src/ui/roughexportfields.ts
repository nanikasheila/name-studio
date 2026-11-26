// The export dialog's ラフ線 settings for the CSP pages: vector or raster
// layers, their opacity and CSP's レイヤーカラー (kept with the name's export,
// domain/exportmemory.ts).
import { roughDefaults, type RoughOptions } from "../domain/exportmemory";
import { $ } from "../platform/dom";

export class RoughFields {
  private rough: RoughOptions = roughDefaults(true);

  constructor(private readonly changed: () => void) {
    $<HTMLSelectElement>("ne-rough-form").addEventListener("change", (event) => {
      this.rough.raster = (event.target as HTMLSelectElement).value === "raster";
      this.changed();
    });
    const opacity = $<HTMLInputElement>("ne-rough-opacity");
    opacity.addEventListener("change", () => {
      const value = Math.round(Number(opacity.value));
      if (Number.isFinite(value) && opacity.value !== "") this.rough.opacity = Math.min(100, Math.max(1, value));
      opacity.value = String(this.rough.opacity);
      this.changed();
    });
    $<HTMLInputElement>("ne-rough-color-on").addEventListener("change", (event) => {
      this.rough.layerColor = (event.target as HTMLInputElement).checked;
      this.show();
      this.changed();
    });
    $<HTMLInputElement>("ne-rough-color").addEventListener("input", (event) => {
      this.rough.color = (event.target as HTMLInputElement).value.toLowerCase();
      // Choosing a colour is asking for it.
      this.rough.layerColor = true;
      $<HTMLInputElement>("ne-rough-color-on").checked = true;
      this.changed();
    });
  }

  get value(): RoughOptions {
    return { ...this.rough };
  }

  set value(rough: RoughOptions) {
    this.rough = { ...rough };
    this.show();
  }

  /**
   * 下描き turned on or off: an opacity left as it went with the other
   * (half on a 下描き layer, full without) follows it.
   */
  draftChanged(draft: boolean): void {
    if (this.rough.opacity === roughDefaults(!draft).opacity) this.rough.opacity = roughDefaults(draft).opacity;
    this.show();
  }

  /** Not editable: every line goes as a picture, so there is no choosing. */
  editableChanged(editable: boolean): void {
    const form = $<HTMLSelectElement>("ne-rough-form");
    form.disabled = !editable;
    form.title = editable ? "" : "「線をベクターレイヤー…にする」を外しているので、ラフ線もラスターレイヤーになります";
  }

  show(): void {
    $<HTMLSelectElement>("ne-rough-form").value = this.rough.raster ? "raster" : "vector";
    $<HTMLInputElement>("ne-rough-opacity").value = String(this.rough.opacity);
    $<HTMLInputElement>("ne-rough-color-on").checked = this.rough.layerColor;
    $<HTMLInputElement>("ne-rough-color").value = this.rough.color;
  }
}
