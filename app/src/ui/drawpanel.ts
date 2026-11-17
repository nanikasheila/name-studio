// The 作画 palette: backgrounds drawn for the panels by an AI (Claude Code
// or Codex), apart from 相談 — its own conversation, its own choice of AI,
// and the one place an AI may write files and run commands (Blender,
// Python), in the background folder only, once the user allows it here.
//
// 頼む sends the panels picked (or on the pages shown, or with 背景の指示)
// with the name's 世界の設定 and this request's words: 依頼.md and the
// panels' pictures go to the background folder (bgrequest.ts,
// bgpictures.ts), the AI draws into 案/ and lists each take in 背景.json.
// Below, each panel's takes: 採用 lays one in the panel (cut to its shape),
// 修正 asks for a changed take, 頼み直す for a new one; each panel's 背景の指示
// can be written here too.
import { open } from "../platform/dialogs";
import { call, onAiEvent, type AiEvent, type AiTools, type SessionFile } from "../platform/backend";
import { plainButton } from "../platform/dom";
import { readJson, writeText } from "../platform/settings";
import { fail } from "../platform/status";
import { failureText } from "../platform/errortext";
import {
  AI_LABELS,
  chatTurns,
  choiceProblem,
  Conversation,
  modelFor,
  readAssistSettings,
  stepsSummary,
  type AiModel,
} from "../editing/assistchat";
import {
  CAMERA_LABELS,
  MANIFEST_FILE,
  MAX_BACKGROUND_PX,
  VARIANTS,
  adoptBackground,
  backgroundBox,
  backgroundFor,
  backgroundOf,
  findPanel,
  hasInstructions,
  panelLabel,
  readManifest,
  readSource,
  removeBackground,
  setBackground,
  sourceOf,
  takesFor,
  variantOf,
  type BackgroundTake,
  type Variant,
  renameObject,
} from "../domain/background";
import {
  PERSPECTIVES,
  PERSPECTIVE_LABELS,
  PERSPECTIVE_TITLES,
  type Perspective,
  perspectiveOf,
  rulerOf,
  rulerWords,
  setPerspective,
} from "../domain/bgruler";
import {
  REQUEST_FILE,
  drawingInstructions,
  requestBrief,
  requestDir,
  requestPrompt,
  requestStamp,
  requestSummary,
  type BackgroundTarget,
} from "../domain/bgrequest";
import { BACKGROUND_DPI } from "../domain/background";
import { assetNamed, chooseAsset, objectAsset } from "../domain/bgassets";
import { DrawAssets } from "./drawassets";
import type { BackgroundCamera, BackgroundSettings, Page, Panel, Project, RoughImage } from "../model/model";
import { readImage } from "../render/pictures";
import { requestPictures } from "../service/bgpictures";
import { markdownView } from "./mdview";
import type { Selection } from "./editor";

export interface DrawHost {
  project(): Project | null;
  /** The open name's file (null: not saved yet). */
  path(): string | null;
  edit(change: (project: Project) => void): void;
  /** Page numbers (from 1) on screen now. */
  currentPages(): number[];
  selection(): Selection | null;
  rough(rough: RoughImage): Promise<CanvasImageSource | null>;
  status(message: string): void;
  openPage(number: number): void;
}

type DrawKind = "claude" | "codex";
/** Which panels 頼む sends. */
type Scope = "picked" | "shown" | "marked";

const SCOPE_LABELS: Record<Scope, string> = { picked: "選んだコマ", shown: "表示中のページのコマ", marked: "背景の指示があるコマ" };

interface DrawSettings {
  kind: DrawKind;
  claudeModel: string;
  claudeEffort: string;
  codexModel: string;
  codexEffort: string;
  /** The user allowed the AI to write in the background folder and run commands. */
  allowed: boolean;
  scope: Scope;
  /** Which picture of a take is laid in the panel. */
  variant: Variant;
}

const DRAW_KEY = "namestudio.drawing";
const DEFAULTS: DrawSettings = {
  kind: "claude",
  claudeModel: "",
  claudeEffort: "",
  codexModel: "",
  codexEffort: "",
  allowed: false,
  scope: "picked",
  variant: "完成",
};

function readSettings(kept: unknown): DrawSettings {
  const out = { ...DEFAULTS };
  if (typeof kept !== "object" || kept === null) return out;
  const from = kept as Record<string, unknown>;
  if (from.kind === "claude" || from.kind === "codex") out.kind = from.kind;
  for (const key of ["claudeModel", "claudeEffort", "codexModel", "codexEffort"] as const)
    if (typeof from[key] === "string") out[key] = from[key] as string;
  out.allowed = from.allowed === true;
  if (typeof from.scope === "string" && from.scope in SCOPE_LABELS) out.scope = from.scope as Scope;
  if ((VARIANTS as readonly unknown[]).includes(from.variant)) out.variant = from.variant as Variant;
  return out;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const toBlob = (base64: string, type: string) => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type });

export class DrawPanel {
  private settings: DrawSettings = readSettings(readJson(DRAW_KEY, null));
  private built: HTMLElement | null = null;
  private tools: AiTools | null = null;
  private models: Partial<Record<DrawKind, AiModel[] | string>> = {};
  private conversation: Conversation | null = null;
  /** The conversation's folder (instructions for the AI). */
  private dir: string | null = null;
  /** The background folder now in use (null until asked for). */
  private folder: string | null = null;
  private takes: BackgroundTake[] = [];
  private problems: string[] = [];
  /** Small pictures of the takes, by their file. */
  private readonly thumbs = new Map<string, string>();
  /** The take chosen in each panel's row (panel id → take). */
  private readonly chosen = new Map<string, string>();
  /** The panel whose 修正 box is open. */
  private revising: string | null = null;
  private allPages = false;
  private preparing = false;
  private startedAt = 0;
  private ticking: ReturnType<typeof setInterval> | null = null;
  private loadedFor = "";
  /** The folder of 素材 the conversation was told of (it may write there too). */
  private assetsFolder: string | null = null;
  private readonly assets: DrawAssets;

  constructor(private readonly host: DrawHost) {
    void onAiEvent((event) => this.hear(event)).catch(() => {});
    this.assets = new DrawAssets({
      project: () => host.project(),
      path: () => host.path(),
      edit: (change) => host.edit(change),
      status: (message) => host.status(message),
      changed: () => this.renderPanels(),
    });
  }

  private save(change: Partial<DrawSettings>): void {
    this.settings = { ...this.settings, ...change };
    writeText(DRAW_KEY, JSON.stringify(this.settings));
  }

  private part<T extends HTMLElement>(name: string): T {
    return this.built!.querySelector<T>(`[data-part="${name}"]`)!;
  }

  render(container: HTMLElement): void {
    if (this.built?.parentElement !== container) {
      container.replaceChildren(this.build());
      void this.detect();
    }
    const project = this.host.project();
    // Another name: its own folder and takes.
    const name = this.host.path() ?? "";
    const key = `${name}|${project?.backgrounds?.folder ?? ""}|${project?.backgrounds?.assets ?? ""}`;
    if (project && this.loadedFor !== key) {
      this.loadedFor = key;
      this.folder = null;
      this.takes = [];
      this.thumbs.clear();
      void this.reload(false);
      this.assets.forget();
      void this.assets.load(false);
    }
    this.assets.render();
    this.renderForm();
    this.renderState();
    this.renderLog();
    this.renderPanels();
  }

  private build(): HTMLElement {
    const kind = element("select", { "data-part": "kind", "aria-label": "描く相手", title: "背景を描く相手" });
    for (const id of ["claude", "codex"] as DrawKind[]) kind.append(element("option", { value: id }, AI_LABELS[id]));
    kind.value = this.settings.kind;
    kind.addEventListener("change", () => {
      this.save({ kind: kind.value as DrawKind });
      this.renderForm();
      this.renderState();
    });
    const model = element("select", { "data-part": "model", "aria-label": "モデル" });
    model.addEventListener("change", () => {
      this.save(this.settings.kind === "claude" ? { claudeModel: model.value } : { codexModel: model.value });
      this.renderForm();
    });
    const effort = element("select", { "data-part": "effort", "aria-label": "effort", title: "考える深さ" });
    effort.addEventListener("change", () =>
      this.save(this.settings.kind === "claude" ? { claudeEffort: effort.value } : { codexEffort: effort.value }),
    );
    const allowed = element("input", { type: "checkbox", "data-part": "allowed" });
    allowed.checked = this.settings.allowed;
    allowed.addEventListener("change", () => {
      this.save({ allowed: allowed.checked });
      this.renderState();
    });
    const scope = element("select", { "data-part": "scope", "aria-label": "頼むコマ" });
    for (const [value, label] of Object.entries(SCOPE_LABELS)) scope.append(element("option", { value }, label));
    scope.value = this.settings.scope;
    scope.addEventListener("change", () => {
      this.save({ scope: scope.value as Scope });
      this.renderState();
    });
    const world = element("textarea", {
      "data-part": "world",
      rows: "2",
      placeholder: "世界の設定（例: 叔母の家はライト建築風で少し未来的な豪邸。逃亡用の車は黒い EV のバン）",
      "aria-label": "世界の設定",
      title: "どの依頼にも付ける、場所・建物・物の設定（ネームに保存されます）",
    });
    world.addEventListener("change", () =>
      this.host.edit((project) => {
        const brief = world.value.trim();
        const next: BackgroundSettings = { ...project.backgrounds, brief };
        if (!brief) delete next.brief;
        if (Object.keys(next).length) project.backgrounds = next;
        else delete project.backgrounds;
      }),
    );
    const note = element("textarea", {
      "data-part": "note",
      rows: "2",
      placeholder: "今回の注文（例: 夕方の光で。線は細めに）",
      "aria-label": "今回の注文",
    });
    for (const box of [world, note]) box.addEventListener("keydown", (event) => event.stopPropagation());
    const send = plainButton("背景を頼む", () => void this.request());
    send.dataset.part = "send";
    send.classList.add("primary");
    const stop = plainButton("止める", () => void this.stop());
    stop.dataset.part = "stop";
    const pick = plainButton("選ぶ…", () => void this.pickFolder());
    pick.title = "背景を作るフォルダーを選ぶ（既定はネームの隣の「〇〇_背景」）";
    const show = plainButton("開く", () => this.folder && void call("show_in_folder", { path: this.folder }).catch(() => {}));
    show.dataset.part = "show";
    show.title = "背景のフォルダーをエクスプローラーで開く";
    const reload = plainButton("読み直す", () => void this.reload(true));
    reload.title = `背景のフォルダーの ${MANIFEST_FILE} を読み直す（AI が描いている途中でも、できた案から出ます）`;
    const say = element("textarea", {
      "data-part": "say",
      rows: "2",
      placeholder: "AI に伝える（Ctrl+Enter）",
      "aria-label": "AI に伝える",
    });
    say.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.tell(say.value);
      }
    });
    const tell = plainButton("伝える", () => void this.tell(say.value));
    tell.dataset.part = "tell";
    tell.title = "描いている AI に話す（答え・追加の注文）。同じ会話の続きで、作業フォルダーに書けるまま";
    this.built = element(
      "div",
      { class: "drawing" },
      element("div", { class: "assist-head" }, kind, model, effort),
      element("p", { class: "hint assist-state", "data-part": "state" }),
      element(
        "label",
        {
          class: "check drawing-allow",
          title:
            "Claude Code: ファイルの書き込みは作画用と背景のフォルダーだけ。コマンド（Blender・Python）はこの PC のあなたの権限で動きます。Codex: コマンドも含めて、書き込みを背景のフォルダーに限ったサンドボックスで動きます。相談の欄は読むだけのままです",
        },
        allowed,
        " AI に背景のフォルダーへの書き込みとコマンド（Blender・Python など）の実行を許す",
      ),
      element("div", { class: "drawing-folder" }, element("span", { "data-part": "folder" }), pick, show, reload),
      world,
      this.assets.view(),
      element("datalist", { id: "drawing-places" }),
      element("div", { class: "assist-row" }, scope, element("span", { class: "hint", "data-part": "count" })),
      note,
      element("div", { class: "assist-actions" }, send, stop),
      element("div", { class: "assist-log drawing-log", "data-part": "log", "aria-live": "polite" }),
      element("div", { class: "assist-row drawing-say", "data-part": "say-row" }, say, tell),
      element(
        "div",
        { class: "assist-row" },
        element("strong", {}, "コマごとの背景"),
        element("label", { class: "check" }, this.allBox(), " 全ページ"),
      ),
      element("p", { class: "hint assist-warn", "data-part": "problems", hidden: "" }),
      element("div", { class: "drawing-panels", "data-part": "panels" }),
    );
    return this.built;
  }

  private allBox(): HTMLInputElement {
    const all = element("input", { type: "checkbox" });
    all.checked = this.allPages;
    all.addEventListener("change", () => {
      this.allPages = all.checked;
      this.renderPanels();
    });
    return all;
  }

  private async detect(): Promise<void> {
    const assist = readAssistSettings(readJson("namestudio.assist", null));
    try {
      this.tools = await call("ai_detect", { claude: assist.claudePath || null, codex: assist.codexPath || null });
    } catch {
      this.tools = null;
    }
    this.renderState();
    void this.loadModels();
  }

  private async loadModels(): Promise<void> {
    const kind = this.settings.kind;
    if (this.models[kind]) return;
    const assist = readAssistSettings(readJson("namestudio.assist", null));
    try {
      this.models[kind] = await call("ai_models", {
        kind,
        program: (kind === "claude" ? assist.claudePath : assist.codexPath) || null,
        endpoint: null,
      });
    } catch (error) {
      this.models[kind] = String(error);
    }
    this.renderForm();
  }

  private get model(): string {
    return this.settings.kind === "claude" ? this.settings.claudeModel : this.settings.codexModel;
  }

  private get effort(): string {
    return this.settings.kind === "claude" ? this.settings.claudeEffort : this.settings.codexEffort;
  }

  /** The fields that follow the settings and the name (left alone while typed in). */
  private renderForm(): void {
    if (!this.built) return;
    const kind = this.settings.kind;
    const list = this.models[kind];
    const model = this.part<HTMLSelectElement>("model");
    const effort = this.part<HTMLSelectElement>("effort");
    if (!list) void this.loadModels();
    const models = Array.isArray(list) ? list : [];
    model.replaceChildren(
      element("option", { value: "" }, "既定のモデル"),
      ...models.map((one) => element("option", { value: one.value }, one.label)),
    );
    if (this.model && !models.some((one) => one.value === this.model)) model.append(element("option", { value: this.model }, this.model));
    model.value = this.model;
    const efforts = modelFor(models, this.model)?.efforts ?? [];
    effort.replaceChildren(element("option", { value: "" }, "既定"), ...efforts.map((level) => element("option", { value: level }, level)));
    if (this.effort && !efforts.includes(this.effort)) effort.append(element("option", { value: this.effort }, this.effort));
    effort.value = this.effort;
    effort.disabled = !efforts.length && !this.effort;
    const world = this.part<HTMLTextAreaElement>("world");
    if (document.activeElement !== world) world.value = this.host.project()?.backgrounds?.brief ?? "";
    this.part("folder").textContent = this.folder ?? "（ネームの隣の「〇〇_背景」に作ります）";
    this.part("folder").title = this.folder ?? "";
    this.part<HTMLButtonElement>("show").disabled = !this.folder;
  }

  /** The panels 頼む would send now. */
  private targets(project: Project): Panel[] {
    const scope = this.settings.scope;
    if (scope === "picked") {
      const s = this.host.selection();
      if (!s) return [];
      const items = s.kind === "group" ? (s.items ?? []).filter((item) => item.kind === "panel") : s.kind === "panel" ? [{ id: s.id }] : [];
      return items.flatMap(({ id }) => findPanel(project, id)?.panel ?? []);
    }
    const pages = scope === "shown" ? this.host.currentPages().flatMap((n) => project.pages[n - 1] ?? []) : project.pages;
    return pages.flatMap((page) => page.panels.filter((panel) => !panel.background?.none && (scope === "shown" || hasInstructions(panel))));
  }

  private get running(): boolean {
    return this.conversation?.running != null || this.preparing;
  }

  private renderState(): void {
    if (!this.built) return;
    const project = this.host.project();
    const state = this.part("state");
    const found = this.tools?.[this.settings.kind];
    const listed = this.models[this.settings.kind];
    const problem = Array.isArray(listed) ? choiceProblem(listed, this.model, this.effort) : null;
    state.textContent = !this.tools
      ? "相手を探しています…"
      : !found
        ? `${AI_LABELS[this.settings.kind]} が見つかりません。相談の欄の「接続…」で場所を指定してください。`
        : (problem ?? `${AI_LABELS[this.settings.kind]} に背景を描いてもらいます。`);
    state.dataset.tone = !found || problem ? "warn" : this.settings.allowed ? "" : "note";
    const count = project ? this.targets(project).length : 0;
    this.part("count").textContent = `${count} コマ`;
    const send = this.part<HTMLButtonElement>("send");
    send.disabled = this.running || !count || !this.settings.allowed || !found;
    send.title = !this.settings.allowed
      ? "上のチェックで、背景のフォルダーへの書き込みとコマンドの実行を許してから頼めます"
      : !count
        ? this.settings.scope === "picked"
          ? "選択ツールでコマを選ぶか、頼むコマを「表示中のページ」などに変えてください"
          : "頼めるコマがありません"
        : "背景のフォルダーに依頼と絵を書いて、AI に描いてもらう";
    this.part<HTMLButtonElement>("stop").hidden = !this.running;
    this.part<HTMLButtonElement>("tell").disabled = this.running || !this.conversation?.session || !this.settings.allowed;
    this.part("say-row").hidden = !this.conversation;
    this.tick(this.conversation?.running != null);
  }

  private tick(running: boolean): void {
    if (running && !this.ticking)
      this.ticking = setInterval(() => {
        const line = this.built?.querySelector<HTMLElement>('[data-part="working-text"]');
        if (line) line.textContent = this.workingText();
      }, 1000);
    if (!running && this.ticking) {
      clearInterval(this.ticking);
      this.ticking = null;
    }
  }

  private workingText(): string {
    const seconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    return `描いています… ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }

  /** The conversation, short: each request, the steps folded, the words. */
  private renderLog(): void {
    if (!this.built) return;
    const log = this.part("log");
    const entries = this.conversation?.entries ?? [];
    log.hidden = !entries.length;
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    const running = this.conversation?.running != null;
    const turns = chatTurns(entries);
    log.replaceChildren(
      ...turns.flatMap((turn, t) => {
        const nodes: HTMLElement[] = [];
        if (turn.question) nodes.push(element("div", { class: "assist-entry user" }, turn.question.text));
        const reply = element(
          "div",
          { class: "assist-entry assistant" },
          element("div", { class: "assist-who" }, AI_LABELS[this.conversation!.kind]),
        );
        for (const piece of turn.reply) {
          if (piece.kind === "text") reply.append(markdownView(piece.text, () => {}));
          else if (piece.kind === "steps")
            reply.append(
              element(
                "details",
                { class: "assist-steps" },
                element(
                  "summary",
                  {},
                  element("span", { class: "assist-steps-what" }, stepsSummary(piece.steps)),
                  element("span", { class: "assist-steps-count" }, `${piece.steps.length} 件`),
                ),
                element(
                  "ol",
                  {},
                  ...piece.steps.map((step) => element("li", {}, step.label, ...(step.detail ? [element("code", {}, step.detail)] : []))),
                ),
              ),
            );
          else if (piece.kind === "notice") reply.append(element("p", { class: "assist-notice" }, piece.text));
          else reply.append(element("div", { class: "assist-entry error" }, piece.text));
        }
        if (t === turns.length - 1 && running)
          reply.append(
            element(
              "div",
              { class: "assist-working", role: "status" },
              element("span", { "data-part": "working-text" }, this.workingText()),
            ),
          );
        if (turn.reply.length || (t === turns.length - 1 && running)) nodes.push(reply);
        return nodes;
      }),
    );
    if (atEnd) log.scrollTop = log.scrollHeight;
  }

  // --- コマごとの背景 -------------------------------------------------------------------------

  private renderPanels(): void {
    if (!this.built) return;
    const box = this.part("panels");
    // Not drawn again while a box in it is written in.
    if (box.contains(document.activeElement) && document.activeElement?.matches("textarea, input[type=text]")) return;
    const problems = this.part("problems");
    problems.hidden = !this.problems.length;
    problems.textContent = this.problems.join(" / ");
    const places = this.built.querySelector<HTMLDataListElement>("#drawing-places");
    places?.replaceChildren(...this.assets.names("place").map((value) => element("option", { value })));
    const project = this.host.project();
    if (!project) return box.replaceChildren();
    const numbers = this.allPages ? project.pages.map((_, i) => i + 1) : this.host.currentPages().sort((a, b) => a - b);
    const rows = numbers.flatMap((number) => {
      const page = project.pages[number - 1];
      return page ? [...page.panels].sort((a, b) => a.order - b.order).map((panel) => this.panelRow(project, page, panel)) : [];
    });
    box.replaceChildren(...(rows.length ? rows : [element("p", { class: "hint" }, "このページにはコマがありません。")]));
  }

  private panelRow(project: Project, page: Page, panel: Panel): HTMLElement {
    const takes = takesFor(this.takes, panel.id);
    const adopted = backgroundFor(page, panel.id);
    const source = readSource(adopted?.source);
    const bg = backgroundOf(panel);
    const status = bg.none
      ? "背景なし"
      : adopted
        ? `採用中${source ? `（案${source.take}・${source.variant}）` : ""}`
        : takes.length
          ? `案 ${takes.length} 件`
          : "まだ";
    const head = element(
      "div",
      { class: "drawing-panel-head" },
      element("button", { type: "button", class: "drawing-panel-name", title: "このコマのページを開く" }, panelLabel(project, page, panel)),
      element("span", { class: "drawing-status" }, status),
    );
    head.querySelector("button")!.addEventListener("click", () => this.host.openPage(project.pages.indexOf(page) + 1));
    const row = element("div", { class: `drawing-panel${adopted ? " adopted" : ""}`, "data-panel": panel.id }, head);
    row.append(this.instructions(panel));
    if (takes.length) {
      const strip = element("div", { class: "drawing-takes" });
      const chosen = this.chosen.get(panel.id) ?? source?.take ?? takes[0].take;
      for (const take of takes) {
        const variant = variantOf(take);
        const file = variant ? take.files[variant] : undefined;
        const thumb = element("button", {
          type: "button",
          class: `drawing-take${take.take === chosen ? " chosen" : ""}${source?.take === take.take ? " adopted" : ""}`,
          title: `案${take.take}${take.note ? `: ${take.note}` : ""}`,
          "aria-pressed": String(take.take === chosen),
        });
        const url = file && this.thumbs.get(file);
        if (url) thumb.append(element("img", { src: url, alt: `案${take.take}` }));
        else if (file) void this.thumb(file);
        thumb.append(element("span", {}, `案${take.take}`));
        thumb.addEventListener("click", () => {
          this.chosen.set(panel.id, take.take);
          this.renderPanels();
        });
        strip.append(thumb);
      }
      row.append(strip);
      const take = takes.find((one) => one.take === chosen) ?? takes[0];
      if (take.note) row.append(element("p", { class: "hint drawing-note" }, `案${take.take}: ${take.note}`));
      const variant = element("select", { "aria-label": "採用する絵" });
      for (const name of VARIANTS) if (take.files[name]) variant.append(element("option", { value: name }, name));
      variant.value = variantOf(take, this.settings.variant) ?? "";
      variant.addEventListener("change", () => this.save({ variant: variant.value as Variant }));
      const adopt = plainButton(
        source?.take === take.take ? "採用し直す" : "採用",
        () => void this.adopt(panel.id, take, variant.value as Variant),
      );
      adopt.classList.add("primary");
      adopt.title = "この案をコマに入れる（コマの形で切り抜き、ラフの下に。Ctrl+Z で戻せます）";
      const revise = plainButton("修正…", () => {
        this.revising = this.revising === panel.id ? null : panel.id;
        this.renderPanels();
      });
      revise.title = "この案をどう直すかを書いて、AI に頼む";
      const again = plainButton("頼み直す", () => void this.request([{ panel: panel.id, fresh: true }]));
      again.title = "前の案とは別に、構図から描き直してもらう";
      const actions = element("div", { class: "assist-row" }, variant, adopt, revise, again);
      if (adopted) actions.append(this.removeButton(panel.id));
      row.append(actions);
      if (this.revising === panel.id) row.append(this.reviseBox(panel.id, take));
    } else if (adopted) {
      row.append(element("div", { class: "assist-row" }, this.removeButton(panel.id)));
    }
    return row;
  }

  private removeButton(panelId: string): HTMLButtonElement {
    const remove = plainButton("外す", () =>
      this.host.edit((project) => {
        const found = findPanel(project, panelId);
        if (found) removeBackground(found.page, panelId);
      }),
    );
    remove.title = "採用した背景をコマから外す（案はフォルダーに残ります）";
    return remove;
  }

  private reviseBox(panelId: string, take: BackgroundTake): HTMLElement {
    const words = element("textarea", {
      rows: "2",
      placeholder: `案${take.take}をどう直すか（例: もっと引きで。車を右へ）`,
      "aria-label": "直してほしいこと",
    });
    words.addEventListener("keydown", (event) => event.stopPropagation());
    const send = plainButton("修正を頼む", () => {
      this.revising = null;
      void this.request([{ panel: panelId, revise: { take: take.take, words: words.value } }]);
    });
    send.classList.add("primary");
    setTimeout(() => words.focus(), 0);
    return element("div", { class: "drawing-revise" }, words, send);
  }

  /** A panel's 背景の指示 in words: what to draw, the camera, none; the lines and things drawn with the 背景 tool are counted. */
  private instructions(panel: Panel): HTMLElement {
    const bg = backgroundOf(panel);
    const brief = element("textarea", {
      rows: "1",
      placeholder: "このコマの背景（例: 車寄せ。バンのスライドドアが開いている）",
      "aria-label": "このコマの背景",
    });
    brief.value = bg.brief ?? "";
    brief.addEventListener("keydown", (event) => event.stopPropagation());
    const change = (next: Parameters<typeof setBackground>[1]) =>
      this.host.edit((project) => {
        const found = findPanel(project, panel.id);
        if (found) setBackground(found.panel, next);
      });
    brief.addEventListener("change", () => change({ brief: brief.value.trim() }));
    // 場所: a 素材 to take place in, or a name for the AI to make (and add to the 素材).
    const place = element("input", {
      type: "text",
      class: "drawing-place",
      list: "drawing-places",
      "aria-label": "場所",
      placeholder: "場所（素材）",
      title: "このコマの場所。素材にある場所を選ぶと AI はそれを使い、ない名前なら作って素材に足します（例: 叔母の家 玄関）",
    });
    place.value = bg.place ?? "";
    place.size = Math.max(10, Math.min(16, place.value.length + 2));
    place.dataset.listed = String(!!assetNamed(this.assets.list, bg.place));
    place.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") place.blur();
    });
    place.addEventListener("change", () => change({ place: place.value.trim() || undefined }));
    const ruler = rulerOf(panel);
    const points = element("select", {
      "aria-label": "透視",
      title: "透視の定規（背景の道具 H で消失点・線・アイレベルをドラッグして合わせる）",
    });
    for (const n of PERSPECTIVES)
      points.append(element("option", { value: String(n), title: PERSPECTIVE_TITLES[n] }, n ? `${PERSPECTIVE_LABELS[n]}透視` : "透視なし"));
    points.value = String(ruler.vanishing.length ? perspectiveOf(bg) : 0);
    points.addEventListener("change", () =>
      this.host.edit((project) => {
        const found = findPanel(project, panel.id);
        if (found) setPerspective(found.panel, Number(points.value) as Perspective);
      }),
    );
    // With a ruler the camera comes from its points; without one, in words.
    const camera = element("select", { "aria-label": "カメラ", title: "カメラの高さ（透視の定規がないとき）" });
    camera.append(element("option", { value: "" }, "カメラ: ラフのまま"));
    for (const [value, label] of Object.entries(CAMERA_LABELS)) camera.append(element("option", { value }, label));
    camera.value = bg.camera ?? "";
    camera.addEventListener("change", () => change({ camera: (camera.value || undefined) as BackgroundCamera | undefined }));
    const view =
      ruler.vanishing.length === 3
        ? rulerWords(ruler)?.includes("見下ろし")
          ? "見下ろし"
          : "見上げ"
        : ruler.vanishing.length
          ? "水平のカメラ"
          : "";
    const none = element("input", { type: "checkbox" });
    none.checked = !!bg.none;
    none.addEventListener("change", () => change({ none: none.checked }));
    const drawn = [ruler.horizon && !ruler.vanishing.length ? "アイレベル" : "", view].filter(Boolean);
    // The things placed with 物, each named here too.
    const things = (bg.objects ?? []).map((object) => {
      const name = element("input", {
        type: "text",
        class: "drawing-object",
        "aria-label": "物の名前",
        title: "物の名前（背景の道具の「物」で動かす・大きさを変える）",
      });
      name.value = object.label;
      name.size = Math.max(4, Math.min(14, object.label.length + 1));
      name.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") name.blur();
      });
      name.addEventListener("change", () =>
        this.host.edit((project) => {
          const found = findPanel(project, panel.id);
          if (found) renameObject(found.panel, object.id, name.value);
        }),
      );
      const things = this.assets.names("thing");
      if (!things.length && !object.asset) return name;
      // Its 素材: chosen, else the one its name begins with.
      const asset = element("select", { "aria-label": "物の素材", title: "この物に使う素材（素材の一覧から）" });
      const guessed = objectAsset(this.assets.list, { ...object, asset: undefined });
      asset.append(element("option", { value: "" }, guessed ? `素材: ${guessed.name}（名前から）` : "素材なし"));
      for (const thing of things) asset.append(element("option", { value: thing }, thing));
      if (object.asset && !things.includes(object.asset))
        asset.append(element("option", { value: object.asset }, `${object.asset}（一覧にない）`));
      asset.value = object.asset ?? "";
      asset.addEventListener("change", () =>
        this.host.edit((project) => {
          const found = findPanel(project, panel.id);
          if (found) chooseAsset(found.panel, object.id, asset.value || undefined);
        }),
      );
      return element("span", { class: "drawing-object-asset" }, name, asset);
    });
    return element(
      "div",
      { class: "drawing-instructions" },
      brief,
      element(
        "div",
        { class: "assist-row" },
        place,
        points,
        ...(ruler.vanishing.length ? [] : [camera]),
        element("label", { class: "check", title: "人物のアップ・効果など、背景を描かないコマ" }, none, " 背景なし"),
        element("span", { class: "hint", title: "背景の道具（H）で描いた指示" }, drawn.length ? drawn.join("・") : ""),
      ),
      ...(things.length
        ? [element("div", { class: "assist-row drawing-objects" }, element("span", { class: "hint" }, "物"), ...things)]
        : []),
    );
  }

  private async thumb(file: string): Promise<void> {
    if (!this.folder || this.thumbs.has(file)) return;
    this.thumbs.set(file, "");
    try {
      const data = await call("bg_read", { folder: this.folder, path: file, text: false });
      if (!data) return;
      const bitmap = await createImageBitmap(toBlob(data, "image/png"));
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      this.thumbs.set(file, canvas.toDataURL("image/jpeg", 0.8));
      this.renderPanels();
    } catch {
      // A picture not readable stays without its small picture.
    }
  }

  // --- the folder and its takes ------------------------------------------------------------------

  /** The background folder (made beside the name when none is chosen). */
  private async ensureFolder(): Promise<string> {
    const project = this.host.project();
    this.folder = await call("bg_folder", { name: this.host.path(), folder: project?.backgrounds?.folder ?? null });
    this.renderForm();
    return this.folder;
  }

  private async pickFolder(): Promise<void> {
    const chosen = await open({ directory: true, title: "背景を作るフォルダー" });
    if (typeof chosen !== "string") return;
    this.host.edit((project) => {
      project.backgrounds = { ...project.backgrounds, folder: chosen };
    });
    this.folder = null;
    this.thumbs.clear();
    await this.reload(true);
  }

  /** Read 背景.json again (`loud`: say what was found, and make the folder if need be). */
  private async reload(loud: boolean): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    try {
      if (!this.folder) {
        // Not made only to look: a name not saved, or a folder not there yet, shows nothing.
        if (!loud && !this.host.path() && !project.backgrounds?.folder) return;
        await this.ensureFolder();
      }
      const text = await call("bg_read", { folder: this.folder!, path: MANIFEST_FILE, text: true });
      const read = text ? readManifest(text) : { takes: [], problems: [] };
      this.takes = read.takes;
      this.problems = read.problems;
      if (loud) this.thumbs.clear();
      if (loud) this.host.status(`背景の案 ${this.takes.length} 件（${MANIFEST_FILE}）`);
    } catch (error) {
      if (loud) fail("背景のフォルダーを読めません", error);
    }
    this.renderForm();
    this.renderPanels();
  }

  private async adopt(panelId: string, take: BackgroundTake, wanted: Variant): Promise<void> {
    const variant = variantOf(take, wanted);
    const file = variant && take.files[variant];
    const project = this.host.project();
    const found = project && findPanel(project, panelId);
    if (!file || !found || !this.folder) return;
    try {
      const data = await call("bg_read", { folder: this.folder, path: file, text: false });
      if (!data) throw new Error(`${file} がありません`);
      const image = await readImage(toBlob(data, "image/png"), file.split("/").pop() ?? file, MAX_BACKGROUND_PX);
      const box = take.box ?? backgroundBox(project.pageFormat, found.panel);
      this.host.edit((now) => {
        const there = findPanel(now, panelId);
        if (there) adoptBackground(now, there.page, there.panel, image, box, sourceOf(take, variant));
      });
      this.chosen.set(panelId, take.take);
      this.host.status(`${panelLabel(project, found.page, found.panel)} に案${take.take}（${variant}）を入れました。Ctrl+Z で戻せます`);
    } catch (error) {
      fail("背景を入れられません", error);
    }
  }

  // --- asking ------------------------------------------------------------------------------------

  private turnBase(prompt: string, folder: string, assets: string | null) {
    const assist = readAssistSettings(readJson("namestudio.assist", null));
    const kind = this.settings.kind;
    return {
      kind,
      dir: this.dir!,
      prompt,
      resume: this.conversation?.session ?? null,
      model: this.model || null,
      effort: this.effort || null,
      sandbox: kind === "codex" ? assist.codexSandbox || null : null,
      program: (kind === "claude" ? assist.claudePath : assist.codexPath) || null,
      images: [],
      endpoint: null,
      messages: [],
      work: folder,
      assets,
    };
  }

  /** The conversation's folder, with what the AI is told once. */
  private async prepare(folder: string, assets: string | null): Promise<void> {
    const text = drawingInstructions(folder, assets ?? undefined);
    const files: SessionFile[] = ["SYSTEM.md", "CLAUDE.md", "AGENTS.md"].map((path) => ({ path, text }));
    this.dir = await call("ai_prepare_session", { dir: this.dir, files }).catch((error) => {
      if (!this.dir) throw error;
      return call("ai_prepare_session", { dir: null, files });
    });
  }

  /** 頼む: the panels as the scope says, or these (修正・頼み直し). */
  private async request(given?: BackgroundTarget[]): Promise<void> {
    const project = this.host.project();
    if (!project || this.running) return;
    if (!this.settings.allowed) {
      this.host.status("作画の欄の上のチェックで、書き込みとコマンドの実行を許してから頼んでください");
      return;
    }
    const targets = given ?? this.targets(project).map((panel) => ({ panel: panel.id }));
    if (!targets.length) return;
    // Another AI than the conversation's: a new conversation.
    if (this.conversation && this.conversation.kind !== this.settings.kind) this.conversation = null;
    this.preparing = true;
    this.renderState();
    const note = given ? "" : this.part<HTMLTextAreaElement>("note").value;
    try {
      const folder = await this.ensureFolder();
      await this.reload(false);
      await this.assets.load(false);
      const assets = this.assets.folder;
      const blender = await call("bg_blender").catch(() => null);
      const stamp = requestStamp(new Date());
      const request = {
        stamp,
        targets,
        note,
        dpi: BACKGROUND_DPI,
        folder,
        blender,
        ...(assets ? { assets: { folder: assets, list: this.assets.list } } : {}),
      };
      this.host.status("依頼と絵を背景のフォルダーに書いています…");
      const files: SessionFile[] = [
        { path: `${requestDir(stamp)}/${REQUEST_FILE}`, text: requestBrief(project, request, this.takes) },
        ...(await requestPictures(project, stamp, targets, (rough) => this.host.rough(rough))),
      ];
      await call("bg_write", { folder, files });
      if (!this.conversation) this.dir = null;
      // Told again each time (SYSTEM.md and the rest), the folder of 素材 too.
      this.assetsFolder = assets;
      await this.prepare(folder, assets);
      const run = await call("ai_turn", { turn: this.turnBase(requestPrompt(project, request), folder, assets) });
      this.conversation ??= new Conversation(this.settings.kind);
      this.conversation.ask(`${requestSummary(project, targets)}を頼みました${note.trim() ? `\n${note.trim()}` : ""}`, run);
      this.startedAt = Date.now();
      if (!given) this.part<HTMLTextAreaElement>("note").value = "";
      this.host.status(`${AI_LABELS[this.settings.kind]} に背景を頼みました（描き終わると下に案が出ます）`);
    } catch (error) {
      fail("背景を頼めません", error);
    } finally {
      this.preparing = false;
    }
    this.renderState();
    this.renderLog();
  }

  /** Say more to the AI drawing (in the same conversation, still allowed to write). */
  private async tell(text: string): Promise<void> {
    const words = text.trim();
    if (!words || this.running || !this.conversation?.session || !this.dir) return;
    try {
      const folder = await this.ensureFolder();
      const run = await call("ai_turn", { turn: this.turnBase(words, folder, this.assetsFolder) });
      this.conversation.ask(words, run);
      this.startedAt = Date.now();
      this.part<HTMLTextAreaElement>("say").value = "";
    } catch (error) {
      fail("AI に伝えられません", failureText("", error));
    }
    this.renderState();
    this.renderLog();
  }

  private async stop(): Promise<void> {
    const run = this.conversation?.running;
    if (run != null) await call("ai_stop", { run }).catch(() => {});
  }

  private hear(event: AiEvent): void {
    if (!this.conversation?.hear(event)) return;
    if (event.kind === "done" || event.kind === "error") {
      void this.reload(false);
      this.host.status(
        event.kind === "done" ? "背景を描き終わりました。コマごとの背景で採用・修正を選べます" : `背景: ${event.text.split("\n")[0]}`,
      );
    } else if (event.kind === "tool" && /背景\.json|案\//.test(event.text)) {
      // A take written: show it as soon as it is listed.
      void this.reload(false);
    }
    this.renderLog();
    this.renderState();
  }
}
