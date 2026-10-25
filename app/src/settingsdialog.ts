// 設定: the ネーム's own settings (コマ割り, セリフ・フキダシ, フォント, 読む向き,
// kept in its file) and this computer's (表示, 操作, 吸着, 保存, ペン・キー),
// one kind at a time from the list on the left, or all that match what is
// typed in the search box. Changes apply at once.
import { ask } from "@tauri-apps/plugin-dialog";
import { autosaveToFile, setAutosaveToFile } from "./autosave";
import { call } from "./backend";
import { SHAPE_LABELS } from "./balloon";
import { $, choice, element } from "./dom";
import { fontField } from "./fontpicker";
import { APP_FONT_LABEL, FONT_ROLES, FONT_ROLE_LABELS, roleFont, setRoleFont } from "./fonts";
import { BALLOON_TEXT_KEY, PAGE_GAP_KEY, PANEL_CARRIES_KEY, type PageEditor } from "./editor";
import { GRID_GAP_MM } from "./layout";
import type { BalloonShape, LineKind } from "./model";
import { saveNewNameDefaults } from "./namedefaults";
import { KIND_LABELS, gutters, nameKind, setBinding, setDefaultLineSize, setDefaultShape, setGutters, setLineSpacing, type Project } from "./project";
import { readText, writeFlag, writeNumber, writeText } from "./settings";
import { appVersion, installRelease, releases, setUpdatesPaused, updatesPaused } from "./updater";
import { DEFAULT_SNAP, MAX_GRID_MM, MIN_GRID_MM, saveSnap, type SnapSettings } from "./snapping";
import {
  APP_BALLOON_LINE_MM,
  APP_FONT_PT,
  APP_LINE_SPACING,
  APP_PANEL_LINE_MM,
  APP_THICK_LINE_MM,
  MAX_FONT_PT,
  MIN_FONT_PT,
  defaultFontPt,
  lineSpacing,
  setStyleLine,
  type StyleLine,
} from "./style";

export interface SettingsHost {
  readonly editor: PageEditor;
  project(): Project | null;
  /** One undoable change. */
  edit(change: (project: Project) => void): void;
  status(message: string): void;
  /** The snap settings changed (the grid box beside the panel tool shows them). */
  snapChanged(): void;
  /** 自動保存 was turned on or off. */
  autosaveChanged(): void;
  openPenSettings(): void;
  openShortcuts(): void;
  /** Before the app is closed for another version: false to stay. */
  prepareRestart(): Promise<boolean>;
}

const SNAP_BOXES: [keyof SnapSettings, string][] = [
  ["axis", "st-snap-axis"],
  ["panels", "st-snap-panels"],
  ["frame", "st-snap-frame"],
  ["grid", "st-snap-grid"],
];

const LINE_FIELDS: [StyleLine, string, number, string][] = [
  ["panelLineMm", "st-panel-line", APP_PANEL_LINE_MM, "枠線"],
  ["thickLineMm", "st-thick-line", APP_THICK_LINE_MM, "太枠"],
  ["balloonLineMm", "st-balloon-line", APP_BALLOON_LINE_MM, "フキダシの線"],
];

const KINDS = Object.keys(KIND_LABELS) as LineKind[];
const PANE_KEY = "namestudio.settingsPane";

/** Whether `text` holds every word of `query` (any case, full- or half-width). */
export function matchesQuery(text: string, query: string): boolean {
  const fold = (value: string) => value.normalize("NFKC").toLowerCase();
  const haystack = fold(text);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export class SettingsDialog {
  private pane = readText(PANE_KEY) ?? "koma";

  constructor(private readonly host: SettingsHost) {
    const number = (id: string) => $<HTMLInputElement>(id);
    for (const id of ["st-gutter-across", "st-gutter-down"]) {
      number(id).addEventListener("change", () => {
        const across = Number(number("st-gutter-across").value);
        const down = Number(number("st-gutter-down").value);
        this.host.edit((project) => setGutters(project, { across, down }));
        this.render();
        const now = this.host.project();
        if (now) this.host.status(`コマ間を 左右 ${gutters(now).across} mm・上下 ${gutters(now).down} mm にしました（これから割るコマに効きます）`);
      });
    }
    for (const [key, id, , label] of LINE_FIELDS) {
      number(id).addEventListener("change", () => {
        const text = number(id).value.trim();
        const value = text === "" ? null : Number(text);
        this.host.edit((project) => setStyleLine(project, key, value));
        this.render();
        const now = this.host.project()?.style?.[key];
        this.host.status(now === undefined ? `${label}の太さを初期（アプリの既定）に戻しました` : `${label}の太さを ${now} mm にしました`);
      });
    }
    number("st-line-spacing").addEventListener("change", () => {
      const text = number("st-line-spacing").value.trim();
      let changed = 0;
      this.host.edit((project) => (changed = setLineSpacing(project, text === "" ? null : Number(text))));
      this.render();
      const now = this.host.project();
      if (now) this.host.status(`セリフの行間を ${lineSpacing(now.style)}% にしました（セリフ ${changed} 個を並べ直しました）`);
    });
    $<HTMLSelectElement>("st-binding").addEventListener("change", (event) => {
      const binding = (event.target as HTMLSelectElement).value === "left" ? "left" : "right";
      const turnText = $<HTMLInputElement>("st-binding-text").checked;
      this.host.edit((project) => setBinding(project, binding, turnText));
      this.render();
      this.host.status(binding === "left" ? "左綴じにしました（左から右へ読みます）" : "右綴じにしました（右から左へ読みます）");
    });
    number("st-page-gap").addEventListener("input", () => {
      const value = Number(number("st-page-gap").value);
      if (!Number.isFinite(value)) return;
      this.host.editor.setPageGap(value);
      writeNumber(PAGE_GAP_KEY, this.host.editor.pageGapMm);
    });
    number("st-page-gap").addEventListener("change", () => this.render());
    // コマのメモ: the same as the box above the page, which does the rest.
    $<HTMLInputElement>("st-show-notes").addEventListener("change", (event) => {
      const notes = $<HTMLInputElement>("show-notes");
      notes.checked = (event.target as HTMLInputElement).checked;
      notes.dispatchEvent(new Event("change"));
    });
    $<HTMLInputElement>("st-panel-carries").addEventListener("change", (event) => {
      this.host.editor.panelCarries = (event.target as HTMLInputElement).checked;
      writeFlag(PANEL_CARRIES_KEY, this.host.editor.panelCarries);
    });
    $<HTMLInputElement>("st-balloon-text").addEventListener("change", (event) => {
      this.host.editor.balloonTextFollows = (event.target as HTMLInputElement).checked;
      writeFlag(BALLOON_TEXT_KEY, this.host.editor.balloonTextFollows);
    });
    $<HTMLInputElement>("st-autosave").addEventListener("change", (event) => {
      setAutosaveToFile((event.target as HTMLInputElement).checked);
      this.host.autosaveChanged();
    });
    $<HTMLInputElement>("st-auto-update").addEventListener("change", (event) => {
      setUpdatesPaused(!(event.target as HTMLInputElement).checked);
      this.host.status(updatesPaused() ? "自動更新を止めました" : "自動更新を入れました（次の起動から）");
    });
    const release = $<HTMLSelectElement>("st-release");
    release.addEventListener("focus", () => void this.loadReleases());
    release.addEventListener("change", () => {
      $<HTMLButtonElement>("st-install-release").disabled = !release.value || release.value === this.version;
    });
    $("st-install-release").addEventListener("click", async () => {
      const version = release.value;
      if (!version) return;
      const sure = await ask(`版 ${version} に入れ替えて、アプリを起動し直します。\n\n入れ替えたあとは自動更新を止めます（設定の「更新」でまた入れられます）。`, {
        title: "Name Studio",
        kind: "warning",
        okLabel: "入れ替える",
        cancelLabel: "やめる",
      });
      if (sure) await installRelease(version, { status: (message) => this.host.status(message), prepare: () => this.host.prepareRestart() });
    });
    $("st-open-pen").addEventListener("click", () => this.host.openPenSettings());
    $("st-open-keys").addEventListener("click", () => this.host.openShortcuts());
    for (const [key, id] of SNAP_BOXES) {
      $<HTMLInputElement>(id).addEventListener("change", (event) => {
        this.changeSnap({ [key]: (event.target as HTMLInputElement).checked });
      });
    }
    number("st-grid-mm").addEventListener("change", () => {
      const value = Number(number("st-grid-mm").value);
      if (Number.isFinite(value) && value >= MIN_GRID_MM && value <= MAX_GRID_MM) this.changeSnap({ gridMm: value });
      this.render();
    });
    $("st-save-defaults").addEventListener("click", () => {
      const project = this.host.project();
      if (!project) return;
      const kept = saveNewNameDefaults(project);
      this.host.status(
        Object.keys(kept).length
          ? "このネームのコマ間・太さ・文字の大きさ・フキダシの形・フォントを、新しいネームの既定にしました"
          : "このネームは初期の設定のままなので、新しいネームも初期の設定で始まります",
      );
    });
    $("st-reset").addEventListener("click", () => {
      this.host.editor.setPageGap(GRID_GAP_MM);
      writeNumber(PAGE_GAP_KEY, GRID_GAP_MM);
      this.changeSnap({ ...DEFAULT_SNAP });
      this.host.editor.panelCarries = true;
      writeFlag(PANEL_CARRIES_KEY, true);
      this.host.editor.balloonTextFollows = true;
      writeFlag(BALLOON_TEXT_KEY, true);
      this.render();
      this.host.status("この PC の設定（ページの間隔・吸着・コマと中身・フキダシの変形）を初期に戻しました");
    });
    $<HTMLInputElement>("st-search").addEventListener("input", () => this.filter());
    // Esc empties the search box first; the dialog closes on the next one.
    $<HTMLDialogElement>("settings-dialog").addEventListener("cancel", (event) => {
      const search = $<HTMLInputElement>("st-search");
      if (!search.value) return;
      event.preventDefault();
      search.value = "";
      this.filter();
    });
    this.buildNav();
  }

  open(): void {
    $<HTMLInputElement>("st-search").value = "";
    this.render();
    $<HTMLDialogElement>("settings-dialog").showModal();
  }

  /** Part of the snap settings changed, kept for the next start. */
  changeSnap(change: Partial<SnapSettings>): void {
    this.host.editor.snapping = { ...this.host.editor.snapping, ...change };
    saveSnap(this.host.editor.snapping);
    this.host.snapChanged();
    this.render();
    this.host.editor.draw();
  }

  private panes(): HTMLElement[] {
    return [...$("st-panes").querySelectorAll<HTMLElement>(".settings-pane")];
  }

  /** The list on the left: このネーム's kinds, then this computer's. */
  private buildNav(): void {
    const nav = $("st-nav");
    const groups: [string, string][] = [
      ["name", "このネーム"],
      ["pc", "この PC"],
    ];
    nav.replaceChildren(
      ...groups.flatMap(([scope, title]) => [
        element("div", { className: "settings-nav-group", textContent: title }),
        ...this.panes()
          .filter((pane) => pane.dataset.scope === scope)
          .map((pane) => {
            const item = element("button", { type: "button", className: "settings-nav-item", textContent: pane.dataset.title ?? "" });
            item.dataset.pane = pane.dataset.pane;
            item.addEventListener("click", () => {
              $<HTMLInputElement>("st-search").value = "";
              this.pane = pane.dataset.pane ?? "koma";
              writeText(PANE_KEY, this.pane);
              this.filter();
            });
            return item;
          }),
      ]),
    );
  }

  /** One kind of settings, or with a search, every setting that matches it. */
  private filter(): void {
    const query = $<HTMLInputElement>("st-search").value.trim();
    if (!this.panes().some((pane) => pane.dataset.pane === this.pane)) this.pane = "koma";
    let found = 0;
    for (const pane of this.panes()) {
      if (!query) {
        pane.hidden = pane.dataset.pane !== this.pane;
        for (const item of pane.querySelectorAll<HTMLElement>(".setting-item")) item.hidden = false;
        continue;
      }
      const title = pane.dataset.title ?? "";
      let shown = 0;
      for (const item of pane.querySelectorAll<HTMLElement>(".setting-item")) {
        const text = `${title} ${item.dataset.keys ?? ""} ${item.textContent ?? ""} ${[...item.querySelectorAll("input")].map((input) => input.value).join(" ")}`;
        item.hidden = !matchesQuery(text, query);
        if (!item.hidden) shown++;
      }
      pane.hidden = !shown;
      found += shown;
    }
    $("st-nothing").hidden = !query || found > 0;
    for (const item of $("st-nav").querySelectorAll<HTMLElement>(".settings-nav-item")) {
      item.classList.toggle("active", !query && item.dataset.pane === this.pane);
      item.classList.toggle("dimmed", !!query && !!this.panes().find((pane) => pane.dataset.pane === item.dataset.pane)?.hidden);
    }
    $("st-panes").classList.toggle("searching", !!query);
  }

  /** 用途ごとのフォント: a field for each role, empty for 通常's (or the app's for 通常). */
  private renderFonts(project: Project | null): void {
    const box = $("st-fonts");
    if (box.contains(document.activeElement)) return;
    box.replaceChildren(
      ...FONT_ROLES.map((role) => {
        const fallback = role === "speech" ? APP_FONT_LABEL : `通常と同じ（${roleFont(project?.fonts, "speech") ?? APP_FONT_LABEL}）`;
        const field = fontField(project?.fonts?.[role] ?? "", fallback, (name) => {
          this.host.edit((p) => setRoleFont(p, role, name));
          this.render();
          this.host.status(name ? `「${FONT_ROLE_LABELS[role]}」のフォントを ${name} にしました` : `「${FONT_ROLE_LABELS[role]}」のフォントの指定をやめました`);
        });
        field.querySelectorAll("input, button").forEach((control) => ((control as HTMLInputElement).disabled ||= !project));
        return element("label", { className: "font-role" }, element("span", { textContent: FONT_ROLE_LABELS[role] }), field);
      }),
    );
  }

  /** 文字の大きさの既定: one box for each kind of line. */
  private renderSizes(project: Project | null): void {
    const box = $("st-font-sizes");
    if (box.contains(document.activeElement)) return;
    box.replaceChildren(
      ...KINDS.map((kind) => {
        const set = project?.style?.fontPt?.[kind];
        const input = element("input", {
          type: "number",
          min: String(MIN_FONT_PT),
          max: String(MAX_FONT_PT),
          step: "0.5",
          value: set === undefined ? "" : String(set),
          placeholder: String(APP_FONT_PT[kind]),
          disabled: !project,
          title: `「${KIND_LABELS[kind]}」の文字の大きさ（pt）。空欄はアプリの既定 ${APP_FONT_PT[kind]} pt`,
        });
        input.addEventListener("change", () => {
          const text = input.value.trim();
          const pt = text === "" ? null : Number(text);
          let changed = 0;
          this.host.edit((p) => (changed = setDefaultLineSize(p, kind, pt)));
          const now = this.host.project();
          this.render();
          if (now) this.host.status(`「${KIND_LABELS[kind]}」の文字の大きさの既定を ${defaultFontPt(kind, now.style)} pt にしました（既定の大きさだったセリフ ${changed} 個も変えました）`);
        });
        return element("label", { className: "kind-row" }, element("span", { textContent: KIND_LABELS[kind] }), input, element("small", { textContent: "pt" }));
      }),
    );
  }

  /** フキダシの形の既定: one choice for each kind of line. */
  private renderShapes(project: Project | null): void {
    const box = $("st-shapes");
    if (box.contains(document.activeElement)) return;
    box.replaceChildren(
      ...KINDS.map((kind) => {
        const select = choice(
          SHAPE_LABELS,
          project?.lineShapes?.[kind] ?? "auto",
          (shape: BalloonShape) => {
            let changed = 0;
            this.host.edit((p) => (changed = setDefaultShape(p, kind, shape)));
            this.render();
            this.host.status(`「${KIND_LABELS[kind]}」のフキダシの形の既定を「${SHAPE_LABELS[shape]}」にしました（既定の形だったセリフ ${changed} 個も変えました）`);
          },
          ["custom"],
        );
        select.disabled = !project;
        return element("label", { className: "kind-row" }, element("span", { textContent: KIND_LABELS[kind] }), select);
      }),
    );
  }

  private render(): void {
    const project = this.host.project();
    const gaps = project ? gutters(project) : null;
    for (const [id, value] of [
      ["st-gutter-across", gaps?.across],
      ["st-gutter-down", gaps?.down],
    ] as const) {
      const field = $<HTMLInputElement>(id);
      field.disabled = !gaps;
      if (document.activeElement !== field) field.value = value === undefined ? "" : String(value);
    }
    for (const [key, id, app] of LINE_FIELDS) {
      const field = $<HTMLInputElement>(id);
      field.disabled = !project;
      field.placeholder = String(app);
      if (document.activeElement !== field) field.value = project?.style?.[key] === undefined ? "" : String(project.style[key]);
    }
    const spacing = $<HTMLInputElement>("st-line-spacing");
    spacing.disabled = !project;
    spacing.placeholder = String(APP_LINE_SPACING);
    if (document.activeElement !== spacing) spacing.value = project?.style?.lineSpacing === undefined ? "" : String(project.style.lineSpacing);
    const binding = $<HTMLSelectElement>("st-binding");
    // 縦スクロール is chosen when the name is made (its pieces are a size of their own).
    binding.value = project ? nameKind(project) : "right";
    binding.disabled = !project || !!project.scroll;
    this.renderSizes(project);
    this.renderShapes(project);
    this.renderFonts(project);
    const gap = $<HTMLInputElement>("st-page-gap");
    if (document.activeElement !== gap) gap.value = String(this.host.editor.pageGapMm);
    $<HTMLInputElement>("st-show-notes").checked = this.host.editor.showNotes;
    $<HTMLInputElement>("st-panel-carries").checked = this.host.editor.panelCarries;
    $<HTMLInputElement>("st-balloon-text").checked = this.host.editor.balloonTextFollows;
    $<HTMLInputElement>("st-autosave").checked = autosaveToFile();
    $<HTMLInputElement>("st-auto-update").checked = !updatesPaused();
    const snap = this.host.editor.snapping;
    for (const [key, id] of SNAP_BOXES) $<HTMLInputElement>(id).checked = snap[key] as boolean;
    const grid = $<HTMLInputElement>("st-grid-mm");
    if (document.activeElement !== grid) grid.value = String(snap.gridMm);
    grid.disabled = !snap.grid;
    $<HTMLButtonElement>("st-save-defaults").disabled = !project;
    this.filter();
  }

  private version = "";
  private releasesLoaded = false;

  /** 前の版に戻す: the releases that can be put in, once per opening of the list. */
  private async loadReleases(): Promise<void> {
    if (this.releasesLoaded) return;
    this.releasesLoaded = true;
    const select = $<HTMLSelectElement>("st-release");
    const note = $("st-release-note");
    this.version = await appVersion();
    if (!(await call("is_release_build").catch(() => false))) {
      select.replaceChildren(element("option", { value: "", textContent: "（手元でビルドした版では使えません）" }));
      return;
    }
    select.replaceChildren(element("option", { value: "", textContent: "読み込み中…" }));
    try {
      const list = await releases();
      select.replaceChildren(
        element("option", { value: "", textContent: "版を選ぶ" }),
        ...list.map((release) =>
          element("option", {
            value: release.version,
            textContent: `v${release.version}（${release.date}）${release.version === this.version ? " ← 今の版" : ""} ${release.title}`.trim(),
          }),
        ),
      );
      note.textContent = `今の版は v${this.version} です。選んだ版へ入れ替えます（作業は保存してから）。入れ替えると自動更新は止まります。`;
    } catch (error) {
      this.releasesLoaded = false;
      select.replaceChildren(element("option", { value: "", textContent: "（版の一覧を読めませんでした）" }));
      note.textContent = `${error}`;
    }
  }

}
