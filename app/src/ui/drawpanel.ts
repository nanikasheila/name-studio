// The 作画 palette: backgrounds drawn for the panels by an AI (Claude Code
// or Codex), apart from 相談 — its own conversations, its own choice of AI,
// and the one place an AI may write files and run commands (Blender,
// Python), in the background folder only, once the user allows it here.
//
// At the top, always in sight: which panels to ask for, 今回の注文 and 頼む.
// Each 頼む (修正・頼み直す・伝える too) is a request in line (drawqueue.ts):
// as many are drawn at once as 同時に says, each in a conversation of its own
// gone on with by the next request in it, and the same panel in turn. Each
// request writes 依頼.md and the panels' pictures to the background folder
// (bgrequest.ts, bgpictures.ts); the AI draws into 案/ and lists each take in
// that request's 背景.json. The settings (the AI, the folder, 世界の設定,
// 素材) fold away under them. Below, the requests (each one's conversation
// when picked) and each panel, folded to one line until picked here or on the
// page: its 背景の指示 (drawinstructions.ts) and takes, 採用 laying one in the
// panel (cut to its shape), 修正 asking for a changed take, 頼み直す for a new
// one; まとめて採用 lays the takes not yet laid, as one step.
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
  type ChatEntry,
} from "../editing/assistchat";
import { DrawQueue, MAX_LANES, isOpen, type DrawJob, type JobState } from "../editing/drawqueue";
import {
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
  readManifests,
  readSource,
  removeBackground,
  sourceOf,
  takesFor,
  variantOf,
  type BackgroundTake,
  type Variant,
} from "../domain/background";
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
import { INSTRUCTION_FILE, requestInstruction } from "../domain/bginstruction";
import { appVersion } from "./updater";
import { BACKGROUND_DPI } from "../domain/background";
import { DrawAssets } from "./drawassets";
import { instructionSummary, instructionsView, tag as element } from "./drawinstructions";
import type { BackgroundSettings, Page, Panel, Project, RoughImage, StoredImage } from "../model/model";
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
  /** Show a panel's page with the panel picked. */
  goTo(pageId: string, kind: "panel", id: string): void;
}

type DrawKind = "claude" | "codex";
/** Which panels 頼む sends. */
type Scope = "picked" | "checked" | "shown" | "marked";
/** Which panels the list shows. */
type Filter = "all" | "todo" | "takes" | "adopted" | "busy";

const SCOPE_LABELS: Record<Scope, string> = {
  picked: "画面で選んだコマ",
  checked: "チェックしたコマ",
  shown: "表示中のページのコマ",
  marked: "背景の指示があるコマ",
};
const FILTER_LABELS: Record<Filter, string> = {
  all: "すべて",
  todo: "まだ",
  takes: "案あり・未採用",
  adopted: "採用中",
  busy: "描いている・待ち",
};
const STATE_LABELS: Record<JobState, string> = {
  waiting: "待ち",
  running: "描いています",
  done: "済み",
  failed: "失敗",
  stopped: "止めた",
};

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
  /** How many requests are drawn at once (1: one after another). */
  lanes: number;
  filter: Filter;
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
  lanes: 2,
  filter: "all",
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
  if (typeof from.lanes === "number" && from.lanes >= 1 && from.lanes <= MAX_LANES) out.lanes = Math.floor(from.lanes);
  if (typeof from.filter === "string" && from.filter in FILTER_LABELS) out.filter = from.filter as Filter;
  return out;
}

const toBlob = (base64: string, type: string) => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type });

/** 1 分 5 秒. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** A conversation with the AI drawing: one per lane, gone on with by the next request in it. */
interface Lane {
  conversation: Conversation | null;
  /** The conversation's folder (instructions for the AI). */
  dir: string | null;
  /** The folder of 素材 it was told of (it may write there too). */
  assets: string | null;
}

/** A panel shown in the list, and what it has. */
interface PanelEntry {
  page: Page;
  panel: Panel;
  takes: BackgroundTake[];
  adopted: boolean;
  job: DrawJob | undefined;
}

export class DrawPanel {
  private settings: DrawSettings = readSettings(readJson(DRAW_KEY, null));
  private built: HTMLElement | null = null;
  private tools: AiTools | null = null;
  private models: Partial<Record<DrawKind, AiModel[] | string>> = {};
  private readonly queue = new DrawQueue();
  private readonly lanes: Lane[] = [];
  /** The request whose conversation is shown. */
  private shown: number | null = null;
  /** The background folder now in use (null until asked for). */
  private folder: string | null = null;
  private takes: BackgroundTake[] = [];
  private problems: string[] = [];
  /** Small pictures of the takes, by their file. */
  private readonly thumbs = new Map<string, string>();
  /** The take chosen in each panel's row (panel id → take). */
  private readonly chosen = new Map<string, string>();
  /** Panels opened (true) or folded (false) by hand; the others open while picked on the page. */
  private readonly opened = new Map<string, boolean>();
  /** チェックしたコマ. */
  private readonly checked = new Set<string>();
  /** The panel whose 修正 box is open. */
  private revising: string | null = null;
  private allPages = false;
  /** The settings opened or folded by hand. */
  private setupTouched = false;
  /** The panels picked on the page at the last drawing (to bring a newly picked one in sight). */
  private lastPicked = "";
  private ticking: ReturnType<typeof setInterval> | null = null;
  private loadedFor = "";
  private readonly stamps = new Set<string>();
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
    this.renderJobs();
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
      this.renderState();
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
      this.pump();
    });
    const scope = element("select", { "data-part": "scope", "aria-label": "頼むコマ" });
    for (const [value, label] of Object.entries(SCOPE_LABELS)) scope.append(element("option", { value }, label));
    scope.value = this.settings.scope;
    scope.addEventListener("change", () => {
      this.save({ scope: scope.value as Scope });
      this.renderState();
    });
    const lanes = element("select", {
      "data-part": "lanes",
      "aria-label": "同時に描く数",
      title: "同時に描く依頼の数。1 なら頼んだ順に 1 件ずつ。同じコマの依頼はいつも順に描きます",
    });
    for (let n = 1; n <= MAX_LANES; n++) lanes.append(element("option", { value: String(n) }, n === 1 ? "1 件ずつ" : `${n} 件同時`));
    lanes.value = String(this.settings.lanes);
    lanes.addEventListener("change", () => {
      this.save({ lanes: Number(lanes.value) });
      this.pump();
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
    world.addEventListener("keydown", (event) => event.stopPropagation());
    const note = element("textarea", {
      "data-part": "note",
      rows: "1",
      placeholder: "今回の注文（例: 夕方の光で。線は細めに）Ctrl+Enter で頼む",
      "aria-label": "今回の注文",
    });
    note.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!this.part<HTMLButtonElement>("send").disabled) this.request();
      }
    });
    const send = plainButton("頼む", () => this.request());
    send.dataset.part = "send";
    send.classList.add("primary");
    const stop = plainButton("止める", () => this.stopAll());
    stop.dataset.part = "stop";
    stop.title = "全部止める: 描いている依頼を止め、待っている依頼を取り消す";
    const pick = plainButton("選ぶ…", () => void this.pickFolder());
    pick.title = "背景を作るフォルダーを選ぶ（既定はネームの隣の「〇〇_背景」）";
    const show = plainButton("開く", () => this.folder && void call("show_in_folder", { path: this.folder }).catch(() => {}));
    show.dataset.part = "show";
    show.title = "背景のフォルダーをエクスプローラーで開く";
    const reload = plainButton("読み直す", () => void this.reload(true));
    reload.title = `背景のフォルダーの ${MANIFEST_FILE}（依頼ごと）を読み直す（AI が描いている途中でも、できた案から出ます）`;
    const say = element("textarea", {
      "data-part": "say",
      rows: "1",
      placeholder: "この依頼の AI に伝える（Ctrl+Enter）",
      "aria-label": "AI に伝える",
    });
    say.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.tell(say.value);
      }
    });
    const tell = plainButton("伝える", () => this.tell(say.value));
    tell.dataset.part = "tell";
    tell.title = "選んだ依頼の AI に話す（答え・追加の注文）。同じ会話の続きで、描いている途中なら終わってから伝えます";
    const clear = plainButton("済みを消す", () => {
      this.queue.clearDone();
      if (this.shown !== null && !this.queue.get(this.shown)) this.shown = null;
      this.renderJobs();
    });
    clear.dataset.part = "clear";
    clear.title = "終わった依頼を一覧から消す（描いた案はフォルダーに残ります）";
    const setup = element(
      "details",
      { class: "drawing-setup", "data-part": "setup" },
      element("summary", {}, "設定 ", element("span", { class: "hint", "data-part": "setup-says" })),
      element("div", { class: "assist-head" }, kind, model, effort),
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
    ) as HTMLDetailsElement;
    setup.open = !this.settings.allowed;
    setup.addEventListener("toggle", () => {
      if (setup.matches(":hover, :focus-within")) this.setupTouched = true;
    });
    const filter = element("select", { "data-part": "filter", "aria-label": "表示するコマ" });
    filter.addEventListener("change", () => {
      this.save({ filter: filter.value as Filter });
      this.renderPanels();
    });
    const adoptAll = plainButton("まとめて採用", () => void this.adoptAll());
    adoptAll.dataset.part = "adopt-all";
    adoptAll.title = "一覧の「案あり・未採用」のコマに、選んでいる案（なければ新しい案）をまとめて入れる（Ctrl+Z 1 回で戻せます）";
    this.built = element(
      "div",
      { class: "drawing" },
      element(
        "div",
        { class: "drawing-ask" },
        element("div", { class: "assist-row" }, scope, element("span", { class: "hint", "data-part": "count" })),
        note,
        element("div", { class: "assist-row drawing-ask-go" }, send, lanes, stop),
      ),
      element("p", { class: "hint assist-state", "data-part": "state" }),
      setup,
      element("datalist", { id: "drawing-places" }),
      element(
        "section",
        { class: "drawing-jobs-box", "data-part": "jobs-box", hidden: "" },
        element(
          "div",
          { class: "assist-row" },
          element("strong", {}, "依頼"),
          element("span", { class: "hint drawing-line", "data-part": "line", "aria-live": "polite" }),
          clear,
        ),
        element("ol", { class: "drawing-jobs", "data-part": "jobs" }),
        element("div", { class: "assist-log drawing-log", "data-part": "log", "aria-live": "polite" }),
        element("div", { class: "assist-row drawing-say", "data-part": "say-row" }, say, tell),
      ),
      element(
        "div",
        { class: "assist-row drawing-panels-head" },
        element("strong", {}, "コマごとの背景"),
        filter,
        element("label", { class: "check" }, this.allBox(), " 全ページ"),
        adoptAll,
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

  /** The panels picked on the page. */
  private picked(): string[] {
    const s = this.host.selection();
    if (!s) return [];
    return s.kind === "group"
      ? (s.items ?? []).filter((item) => item.kind === "panel").map((item) => item.id)
      : s.kind === "panel"
        ? [s.id]
        : [];
  }

  /** The panels 頼む would send now. */
  private targets(project: Project): Panel[] {
    const scope = this.settings.scope;
    if (scope === "picked" || scope === "checked") {
      const ids = scope === "picked" ? this.picked() : [...this.checked];
      return ids.flatMap((id) => findPanel(project, id)?.panel ?? []);
    }
    const pages = scope === "shown" ? this.host.currentPages().flatMap((n) => project.pages[n - 1] ?? []) : project.pages;
    return pages.flatMap((page) => page.panels.filter((panel) => !panel.background?.none && (scope === "shown" || hasInstructions(panel))));
  }

  private renderState(): void {
    if (!this.built) return;
    const project = this.host.project();
    const state = this.part("state");
    const kind = this.settings.kind;
    const found = this.tools?.[kind];
    const listed = this.models[kind];
    const problem = Array.isArray(listed) ? choiceProblem(listed, this.model, this.effort) : null;
    const allowed = this.settings.allowed;
    state.textContent = !this.tools
      ? "相手を探しています…"
      : !found
        ? `${AI_LABELS[kind]} が見つかりません。相談の欄の「接続…」で場所を指定してください。`
        : (problem ?? (allowed ? "" : "下の設定の「AI に…実行を許す」にチェックすると頼めます。"));
    state.hidden = !state.textContent;
    state.dataset.tone = !found || problem ? "warn" : allowed ? "" : "note";
    const setup = this.part<HTMLDetailsElement>("setup");
    if ((!allowed || (this.tools && !found)) && !this.setupTouched) setup.open = true;
    const modelLabel = Array.isArray(listed) ? listed.find((one) => one.value === this.model)?.label : null;
    this.part("setup-says").textContent = `${AI_LABELS[kind]}・${modelLabel || this.model || "既定のモデル"}${allowed ? "" : "・未許可"}`;
    const count = project ? this.targets(project).length : 0;
    this.part("count").textContent = `${count} コマ`;
    const send = this.part<HTMLButtonElement>("send");
    const busy = this.queue.running.length;
    const waiting = this.queue.waiting.length;
    send.disabled = !count || !allowed || !found;
    send.title = !allowed
      ? "設定で、背景のフォルダーへの書き込みとコマンドの実行を許してから頼めます"
      : !count
        ? this.settings.scope === "picked"
          ? "選択ツールでコマを選ぶか、下の一覧でコマにチェックしてください"
          : this.settings.scope === "checked"
            ? "下の一覧でコマにチェックしてください"
            : "頼めるコマがありません"
        : busy >= this.settings.lanes
          ? "描いている依頼のあとに順番待ちで頼む"
          : "背景のフォルダーに依頼と絵を書いて、AI に描いてもらう（描いている間も続けて頼めます）";
    this.part<HTMLButtonElement>("stop").hidden = busy + waiting < 1;
    this.part("line").textContent =
      busy || waiting ? [busy ? `${busy} 件描いています` : "", waiting ? `${waiting} 件待ち` : ""].filter(Boolean).join("・") : "";
    this.tick(busy > 0);
  }

  private tick(running: boolean): void {
    if (running && !this.ticking)
      this.ticking = setInterval(() => {
        for (const node of this.built?.querySelectorAll<HTMLElement>("[data-since]") ?? [])
          node.textContent = duration(Date.now() - Number(node.dataset.since));
      }, 1000);
    if (!running && this.ticking) {
      clearInterval(this.ticking);
      this.ticking = null;
    }
  }

  // --- the requests --------------------------------------------------------------------------------

  /** The request shown: the one picked, else the newest started. */
  private shownJob(): DrawJob | undefined {
    const picked = this.shown !== null ? this.queue.get(this.shown) : undefined;
    return picked ?? [...this.queue.jobs].reverse().find((job) => job.state !== "waiting") ?? this.queue.jobs[this.queue.jobs.length - 1];
  }

  private renderJobs(): void {
    if (!this.built) return;
    const jobs = this.queue.jobs;
    this.part("jobs-box").hidden = !jobs.length;
    const shown = this.shownJob();
    this.part<HTMLButtonElement>("clear").hidden = !jobs.some((job) => !isOpen(job));
    // Open ones first in the order asked, then those ended, newest first.
    const order = [...jobs.filter(isOpen), ...jobs.filter((job) => !isOpen(job)).reverse()];
    this.part("jobs").replaceChildren(
      ...order.map((job) => {
        const time =
          job.state === "running" && job.started
            ? element("span", { class: "drawing-job-time", "data-since": String(job.started) }, duration(Date.now() - job.started))
            : job.started && job.ended
              ? element("span", { class: "drawing-job-time" }, duration(job.ended - job.started))
              : element("span", { class: "drawing-job-time" });
        const pick = element(
          "button",
          { type: "button", class: "drawing-job-pick", title: job.error ?? job.title, "aria-pressed": String(job === shown) },
          element("span", { class: "drawing-job-state" }, STATE_LABELS[job.state]),
          element("span", { class: "drawing-job-title" }, job.title),
          time,
        );
        pick.addEventListener("click", () => {
          this.shown = job.id;
          this.renderJobs();
        });
        const item = element("li", { class: "drawing-job", "data-job": String(job.id), "data-state": job.state }, pick);
        if (isOpen(job)) {
          const stop = plainButton(job.state === "waiting" ? "取り消す" : "止める", () => this.stop(job));
          stop.title = job.state === "waiting" ? "この依頼を待ちの列から外す" : "この依頼の AI を止める";
          item.append(stop);
        }
        return item;
      }),
    );
    this.renderLog(shown);
    const lane = shown?.lane != null ? this.lanes[shown.lane] : undefined;
    this.part("say-row").hidden = !lane?.conversation?.session;
    this.part<HTMLButtonElement>("tell").disabled = !this.settings.allowed;
  }

  /** A request's stretch of its conversation: what was asked, the steps folded, the words. */
  private renderLog(job: DrawJob | undefined): void {
    const log = this.part("log");
    const lane = job?.lane != null ? this.lanes[job.lane] : undefined;
    const conversation = lane?.conversation;
    log.hidden = !job;
    if (!job) return;
    if (job.state === "waiting" || !conversation || job.from === undefined) {
      const ahead = this.queue.jobs.filter((one) => isOpen(one) && one.id < job.id).length;
      log.replaceChildren(
        element(
          "p",
          { class: "hint" },
          job.state === "waiting"
            ? `順番を待っています（前に ${ahead} 件）`
            : job.error
              ? `頼めませんでした: ${job.error}`
              : "準備しています…",
        ),
      );
      return;
    }
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    const entries: ChatEntry[] = conversation.entries.slice(job.from, job.to);
    const running = job.state === "running";
    const turns = chatTurns(entries);
    log.replaceChildren(
      ...turns.flatMap((turn, t) => {
        const nodes: HTMLElement[] = [];
        if (turn.question) nodes.push(element("div", { class: "assist-entry user" }, turn.question.text));
        const reply = element(
          "div",
          { class: "assist-entry assistant" },
          element("div", { class: "assist-who" }, AI_LABELS[conversation.kind]),
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
        const last = t === turns.length - 1;
        if (last && running)
          reply.append(
            element(
              "div",
              { class: "assist-working", role: "status" },
              "描いています… ",
              element("span", { "data-since": String(job.started ?? Date.now()) }, duration(Date.now() - (job.started ?? Date.now()))),
            ),
          );
        if (turn.reply.length || (last && running)) nodes.push(reply);
        return nodes;
      }),
    );
    if (atEnd) log.scrollTop = log.scrollHeight;
  }

  // --- コマごとの背景 -------------------------------------------------------------------------

  /** The panels of the pages shown (or all), with what each has. */
  private entries(project: Project): PanelEntry[] {
    const numbers = this.allPages ? project.pages.map((_, i) => i + 1) : this.host.currentPages().sort((a, b) => a - b);
    const states = this.queue.panelStates();
    return numbers.flatMap((number) => {
      const page = project.pages[number - 1];
      if (!page) return [];
      return [...page.panels]
        .sort((a, b) => a.order - b.order)
        .map((panel) => ({
          page,
          panel,
          takes: takesFor(this.takes, panel.id),
          adopted: !!backgroundFor(page, panel.id),
          job: states.get(panel.id),
        }));
    });
  }

  private matches(entry: PanelEntry, filter: Filter): boolean {
    const none = !!entry.panel.background?.none;
    switch (filter) {
      case "all":
        return true;
      case "todo":
        return !none && !entry.adopted && !entry.takes.length && !entry.job;
      case "takes":
        return !none && !entry.adopted && entry.takes.length > 0;
      case "adopted":
        return entry.adopted;
      case "busy":
        return !!entry.job;
    }
  }

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
    const all = this.entries(project);
    const filter = this.part<HTMLSelectElement>("filter");
    filter.replaceChildren(
      ...(Object.keys(FILTER_LABELS) as Filter[]).map((one) =>
        element("option", { value: one }, `${FILTER_LABELS[one]}（${all.filter((entry) => this.matches(entry, one)).length}）`),
      ),
    );
    filter.value = this.settings.filter;
    const shown = all.filter((entry) => this.matches(entry, this.settings.filter));
    const waitingTakes = all.filter((entry) => this.matches(entry, "takes")).length;
    const adoptAll = this.part<HTMLButtonElement>("adopt-all");
    adoptAll.hidden = !waitingTakes;
    adoptAll.textContent = `まとめて採用（${waitingTakes}）`;
    const picked = this.picked();
    const rows = shown.map((entry) => this.panelRow(project, entry, picked.includes(entry.panel.id)));
    box.replaceChildren(
      ...(rows.length
        ? rows
        : [
            element(
              "p",
              { class: "hint" },
              all.length ? `「${FILTER_LABELS[this.settings.filter]}」のコマはありません。` : "このページにはコマがありません。",
            ),
          ]),
    );
    // A panel newly picked on the page: its row in sight.
    const key = picked.join(",");
    if (key !== this.lastPicked) {
      this.lastPicked = key;
      const row = picked.length === 1 ? box.querySelector<HTMLElement>(`[data-panel="${CSS.escape(picked[0])}"]`) : null;
      if (row) this.bringInSight(row);
    }
  }

  /** Scroll the palette (only) so the row shows below the bar kept at its top. */
  private bringInSight(row: HTMLElement): void {
    const scroller = this.built!;
    const bar = this.built!.querySelector<HTMLElement>(".drawing-ask");
    const view = scroller.getBoundingClientRect();
    const top = view.top + (bar?.offsetHeight ?? 0);
    const r = row.getBoundingClientRect();
    if (r.top < top) scroller.scrollTop -= top - r.top + 4;
    else if (r.bottom > view.bottom) scroller.scrollTop += Math.min(r.bottom - view.bottom + 4, r.top - top - 4);
  }

  private panelRow(project: Project, entry: PanelEntry, picked: boolean): HTMLElement {
    const { page, panel, takes, job } = entry;
    const adopted = backgroundFor(page, panel.id);
    const source = readSource(adopted?.source);
    const bg = backgroundOf(panel);
    const status = job
      ? job.state === "running"
        ? "描いています"
        : "順番待ち"
      : bg.none
        ? "背景なし"
        : adopted
          ? `採用中${source ? `（案${source.take}・${source.variant}）` : ""}`
          : takes.length
            ? `案 ${takes.length} 件`
            : "まだ";
    const open = this.opened.get(panel.id) ?? (picked || this.revising === panel.id);
    const fold = element("button", {
      type: "button",
      class: "drawing-fold",
      "aria-expanded": String(open),
      title: open ? "たたむ" : "開いて指示・案を見る",
    });
    fold.textContent = open ? "▾" : "▸";
    fold.addEventListener("click", () => {
      this.opened.set(panel.id, !open);
      this.renderPanels();
    });
    const check = element("input", { type: "checkbox", class: "drawing-pick", "aria-label": "頼むコマにする", title: "頼むコマにする" });
    check.checked = this.checked.has(panel.id);
    check.addEventListener("change", () => {
      if (check.checked) this.checked.add(panel.id);
      else this.checked.delete(panel.id);
      if (this.settings.scope !== "checked" && this.checked.size) {
        this.save({ scope: "checked" });
        this.part<HTMLSelectElement>("scope").value = "checked";
      }
      this.renderState();
    });
    // The take laid (or the one chosen), small.
    const chosen = this.chosen.get(panel.id) ?? source?.take ?? takes[0]?.take;
    const take = takes.find((one) => one.take === chosen) ?? takes[0];
    const shownTake = (source && takes.find((one) => one.take === source.take)) ?? take;
    const mini = element("span", { class: "drawing-mini" });
    const miniFile = shownTake && this.fileOf(shownTake);
    const miniUrl = miniFile && this.thumbs.get(miniFile);
    if (miniUrl) mini.append(element("img", { src: miniUrl, alt: "" }));
    else if (miniFile) void this.thumb(miniFile);
    const name = element(
      "button",
      { type: "button", class: "drawing-panel-name", title: "このコマを紙面で選ぶ" },
      panelLabel(project, page, panel),
    );
    name.addEventListener("click", () => this.host.goTo(page.id, "panel", panel.id));
    const head = element(
      "div",
      { class: "drawing-panel-head" },
      fold,
      check,
      mini,
      name,
      element("span", { class: "drawing-status", ...(job ? { "data-busy": job.state } : {}) }, status),
    );
    const row = element(
      "div",
      { class: `drawing-panel${adopted ? " adopted" : ""}${picked ? " picked" : ""}${open ? " open" : ""}`, "data-panel": panel.id },
      head,
    );
    if (!open) {
      row.append(element("p", { class: "hint drawing-summary" }, instructionSummary(panel)));
      row.addEventListener("dblclick", (event) => {
        if ((event.target as HTMLElement).closest("button, input")) return;
        this.opened.set(panel.id, true);
        this.renderPanels();
      });
      return row;
    }
    row.append(instructionsView({ edit: (change) => this.host.edit(change), assets: this.assets }, panel));
    if (takes.length && take) {
      const strip = element("div", { class: "drawing-takes" });
      for (const one of takes) {
        const file = this.fileOf(one);
        const thumb = element("button", {
          type: "button",
          class: `drawing-take${one.take === take.take ? " chosen" : ""}${source?.take === one.take ? " adopted" : ""}`,
          title: `案${one.take}${one.note ? `: ${one.note}` : ""}`,
          "aria-pressed": String(one.take === take.take),
        });
        const url = file && this.thumbs.get(file);
        if (url) thumb.append(element("img", { src: url, alt: `案${one.take}` }));
        else if (file) void this.thumb(file);
        thumb.append(element("span", {}, `案${one.take}`));
        thumb.addEventListener("click", () => {
          this.chosen.set(panel.id, one.take);
          this.renderPanels();
        });
        strip.append(thumb);
      }
      if (takes.length > 1) row.append(strip);
      // The take chosen, as large as the palette.
      const file = this.fileOf(take);
      const url = file && this.thumbs.get(file);
      if (url) row.append(element("img", { class: "drawing-preview", src: url, alt: `案${take.take}` }));
      if (take.note) row.append(element("p", { class: "hint drawing-note" }, `案${take.take}: ${take.note}`));
      const variant = element("select", { "aria-label": "採用する絵" });
      for (const one of VARIANTS) if (take.files[one]) variant.append(element("option", { value: one }, one));
      variant.value = variantOf(take, this.settings.variant) ?? "";
      variant.addEventListener("change", () => this.save({ variant: variant.value as Variant }));
      const adopt = plainButton(
        source?.take === take.take ? "採用し直す" : `案${take.take}を採用`,
        () => void this.adopt(panel.id, take, variant.value as Variant),
      );
      adopt.classList.add("primary");
      adopt.title = "この案をコマに入れる（コマの形で切り抜き、ラフの下に。Ctrl+Z で戻せます）";
      const revise = plainButton("修正…", () => {
        this.revising = this.revising === panel.id ? null : panel.id;
        this.renderPanels();
      });
      revise.title = "この案をどう直すかを書いて、AI に頼む";
      const again = plainButton("頼み直す", () => this.request([{ panel: panel.id, fresh: true }]));
      again.title = "前の案とは別に、構図から描き直してもらう（描いている間も続けて頼めます）";
      const actions = element("div", { class: "assist-row" }, variant, adopt, revise, again);
      if (adopted) actions.append(this.removeButton(panel.id));
      row.append(actions);
      if (this.revising === panel.id) row.append(this.reviseBox(panel.id, take));
    } else {
      const ask = plainButton("このコマを頼む", () => this.request([{ panel: panel.id }]));
      ask.title = "このコマだけ AI に頼む（今回の注文は付けません）";
      ask.disabled = !this.settings.allowed || !!bg.none;
      const actions = element("div", { class: "assist-row" }, ask);
      if (adopted) actions.append(this.removeButton(panel.id));
      row.append(actions);
    }
    return row;
  }

  private fileOf(take: BackgroundTake): string | undefined {
    const variant = variantOf(take, this.settings.variant);
    return variant ? take.files[variant] : undefined;
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
      placeholder: `案${take.take}をどう直すか（例: もっと引きで。車を右へ）Ctrl+Enter で頼む`,
      "aria-label": "直してほしいこと",
    });
    const send = () => {
      this.revising = null;
      this.request([{ panel: panelId, revise: { take: take.take, words: words.value } }]);
    };
    words.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send();
      }
    });
    const button = plainButton("修正を頼む", send);
    button.classList.add("primary");
    setTimeout(() => words.focus(), 0);
    return element("div", { class: "drawing-revise" }, words, button);
  }

  private async thumb(file: string): Promise<void> {
    if (!this.folder || this.thumbs.has(file)) return;
    this.thumbs.set(file, "");
    try {
      const data = await call("bg_read", { folder: this.folder, path: file, text: false });
      if (!data) return;
      const bitmap = await createImageBitmap(toBlob(data, "image/png"));
      const canvas = document.createElement("canvas");
      // Large enough for the preview across the palette.
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      this.thumbs.set(file, canvas.toDataURL("image/jpeg", 0.82));
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

  /** Read the lists of takes again: 背景.json and each request's (`loud`: say what was found, and make the folder if need be). */
  private async reload(loud: boolean): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    try {
      if (!this.folder) {
        // Not made only to look: a name not saved, or a folder not there yet, shows nothing.
        if (!loud && !this.host.path() && !project.backgrounds?.folder) return;
        await this.ensureFolder();
      }
      const folder = this.folder!;
      const paths = [MANIFEST_FILE, ...(await call("bg_manifests", { folder }).catch(() => [] as string[]))];
      const files = await Promise.all(
        paths.map(async (path) => ({ path, text: await call("bg_read", { folder, path, text: true }).catch(() => null) })),
      );
      const read = readManifests(files.filter((file): file is { path: string; text: string } => !!file.text));
      this.takes = read.takes;
      this.problems = read.problems;
      if (loud) this.thumbs.clear();
      if (loud) this.host.status(`背景の案 ${this.takes.length} 件（${MANIFEST_FILE} ${files.filter((file) => file.text).length} 個）`);
    } catch (error) {
      if (loud) fail("背景のフォルダーを読めません", error);
    }
    this.renderForm();
    this.renderPanels();
  }

  /** A take's picture, read to lay in its panel. */
  private async takeImage(take: BackgroundTake, wanted: Variant): Promise<{ image: StoredImage; variant: Variant } | null> {
    const variant = variantOf(take, wanted);
    const file = variant && take.files[variant];
    if (!file || !variant || !this.folder) return null;
    const data = await call("bg_read", { folder: this.folder, path: file, text: false });
    if (!data) throw new Error(`${file} がありません`);
    return { image: await readImage(toBlob(data, "image/png"), file.split("/").pop() ?? file, MAX_BACKGROUND_PX), variant };
  }

  private async adopt(panelId: string, take: BackgroundTake, wanted: Variant): Promise<void> {
    const project = this.host.project();
    const found = project && findPanel(project, panelId);
    if (!found) return;
    try {
      const read = await this.takeImage(take, wanted);
      if (!read) return;
      const box = take.box ?? backgroundBox(project.pageFormat, found.panel);
      this.host.edit((now) => {
        const there = findPanel(now, panelId);
        if (there) adoptBackground(now, there.page, there.panel, read.image, box, sourceOf(take, read.variant));
      });
      this.chosen.set(panelId, take.take);
      this.host.status(
        `${panelLabel(project, found.page, found.panel)} に案${take.take}（${read.variant}）を入れました。Ctrl+Z で戻せます`,
      );
    } catch (error) {
      fail("背景を入れられません", error);
    }
  }

  /** まとめて採用: each panel listed with takes and none laid gets its chosen (or newest) take, as one step. */
  private async adoptAll(): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    const waiting = this.entries(project).filter((entry) => this.matches(entry, "takes"));
    const laid: { panelId: string; take: BackgroundTake; image: StoredImage; variant: Variant }[] = [];
    const failed: string[] = [];
    for (const entry of waiting) {
      const take = entry.takes.find((one) => one.take === this.chosen.get(entry.panel.id)) ?? entry.takes[0];
      try {
        const read = await this.takeImage(take, this.settings.variant);
        if (read) laid.push({ panelId: entry.panel.id, take, ...read });
      } catch {
        failed.push(panelLabel(project, entry.page, entry.panel));
      }
    }
    if (!laid.length) {
      if (failed.length) fail("背景を入れられません", failed.join("・"));
      return;
    }
    this.host.edit((now) => {
      for (const one of laid) {
        const there = findPanel(now, one.panelId);
        if (!there) continue;
        const box = one.take.box ?? backgroundBox(now.pageFormat, there.panel);
        adoptBackground(now, there.page, there.panel, one.image, box, sourceOf(one.take, one.variant));
      }
    });
    for (const one of laid) this.chosen.set(one.panelId, one.take.take);
    this.host.status(
      `${laid.length} コマに案を入れました（Ctrl+Z 1 回で戻せます）${failed.length ? `。読めなかったコマ: ${failed.join("・")}` : ""}`,
    );
  }

  // --- asking ------------------------------------------------------------------------------------

  private lane(index: number): Lane {
    while (this.lanes.length <= index) this.lanes.push({ conversation: null, dir: null, assets: null });
    return this.lanes[index];
  }

  private turnBase(lane: Lane, kind: DrawKind, prompt: string, folder: string, assets: string | null) {
    const assist = readAssistSettings(readJson("namestudio.assist", null));
    const same = kind === this.settings.kind;
    return {
      kind,
      dir: lane.dir!,
      prompt,
      resume: lane.conversation?.session ?? null,
      model: same ? this.model || null : null,
      effort: same ? this.effort || null : null,
      sandbox: kind === "codex" ? assist.codexSandbox || null : null,
      program: (kind === "claude" ? assist.claudePath : assist.codexPath) || null,
      images: [],
      endpoint: null,
      messages: [],
      work: folder,
      assets,
    };
  }

  /** A lane's conversation folder, with what the AI is told (again each request, the folder of 素材 too). */
  private async prepare(lane: Lane, folder: string, assets: string | null): Promise<void> {
    const text = drawingInstructions(folder, assets ?? undefined);
    const files: SessionFile[] = ["SYSTEM.md", "CLAUDE.md", "AGENTS.md"].map((path) => ({ path, text }));
    lane.dir = await call("ai_prepare_session", { dir: lane.dir, files }).catch((error) => {
      if (!lane.dir) throw error;
      return call("ai_prepare_session", { dir: null, files });
    });
  }

  /** 頼む: the panels as the scope says, or these (このコマを頼む・修正・頼み直し), in line. */
  private request(given?: BackgroundTarget[]): void {
    const project = this.host.project();
    if (!project) return;
    if (!this.settings.allowed) {
      this.host.status("作画の欄の設定で、書き込みとコマンドの実行を許してから頼んでください");
      return;
    }
    const targets = given ?? this.targets(project).map((panel) => ({ panel: panel.id }));
    if (!targets.length) return;
    const noteBox = this.part<HTMLTextAreaElement>("note");
    const note = given ? "" : noteBox.value;
    const job = this.queue.add({ title: requestSummary(project, targets).replace(/ の背景$/, ""), targets, note }, Date.now());
    this.shown = job.id;
    if (!given) noteBox.value = "";
    this.pump();
    this.host.status(
      job.state === "running"
        ? `${AI_LABELS[this.settings.kind]} に背景を頼みました（描き終わると下に案が出ます）`
        : `背景の依頼を順番待ちに入れました（前に ${this.queue.jobs.filter((one) => isOpen(one) && one.id < job.id).length} 件）`,
    );
    this.renderAll();
  }

  /** Say more to the AI of the request shown (in its conversation, after what it draws now). */
  private tell(text: string): void {
    const words = text.trim();
    const shown = this.shownJob();
    const lane = shown?.lane;
    if (!words || lane == null || !this.lanes[lane]?.conversation?.session || !this.settings.allowed) return;
    const job = this.queue.add(
      { title: `伝える: ${words.length > 24 ? `${words.slice(0, 24)}…` : words}`, targets: [], note: "", words, lane },
      Date.now(),
    );
    this.shown = job.id;
    this.part<HTMLTextAreaElement>("say").value = "";
    this.pump();
    this.renderAll();
  }

  /** Start the requests whose turn it is. */
  private pump(): void {
    if (!this.settings.allowed) return;
    for (const job of this.queue.next(this.settings.lanes, Date.now())) void this.start(job);
  }

  private async start(job: DrawJob): Promise<void> {
    const project = this.host.project();
    const index = job.lane!;
    const lane = this.lane(index);
    const kind: DrawKind = job.words ? (lane.conversation?.kind as DrawKind) : this.settings.kind;
    // Another AI than the lane's: a new conversation.
    if (!job.words && lane.conversation && lane.conversation.kind !== kind && !lane.conversation.running) {
      lane.conversation = null;
      lane.dir = null;
      this.queue.forgetLane(index);
    }
    this.renderAll();
    try {
      if (!project) throw new Error("ネームが開いていません");
      const folder = await this.ensureFolder();
      let prompt: string;
      let asked: string;
      if (job.words) {
        prompt = job.words;
        asked = job.words;
      } else {
        await this.reload(false);
        await this.assets.load(false);
        const assets = this.assets.folder;
        const blender = await call("bg_blender").catch(() => null);
        const stamp = this.newStamp();
        const request = {
          stamp,
          targets: job.targets,
          note: job.note,
          dpi: BACKGROUND_DPI,
          folder,
          blender,
          ...(assets ? { assets: { folder: assets, list: this.assets.list } } : {}),
        };
        this.host.status("依頼と絵を背景のフォルダーに書いています…");
        const files: SessionFile[] = [
          { path: `${requestDir(stamp)}/${REQUEST_FILE}`, text: requestBrief(project, request, this.takes) },
          {
            path: `${requestDir(stamp)}/${INSTRUCTION_FILE}`,
            text: `${JSON.stringify(requestInstruction(project, request, this.takes, { version: await appVersion(), createdAt: new Date().toISOString() }), null, 1)}\n`,
          },
          ...(await requestPictures(project, stamp, job.targets, (rough) => this.host.rough(rough))),
        ];
        await call("bg_write", { folder, files });
        if (!lane.conversation) lane.dir = null;
        lane.assets = assets;
        await this.prepare(lane, folder, assets);
        prompt = requestPrompt(project, request);
        asked = `${job.title} の背景を頼みました${job.note.trim() ? `\n${job.note.trim()}` : ""}`;
      }
      if (job.stopping) throw new Error("止めました");
      const run = await call("ai_turn", { turn: this.turnBase(lane, kind, prompt, folder, lane.assets) });
      lane.conversation ??= new Conversation(kind);
      job.from = lane.conversation.entries.length;
      lane.conversation.ask(asked, run);
      job.run = run;
      if (job.stopping) void call("ai_stop", { run }).catch(() => {});
    } catch (error) {
      const words = failureText("", error);
      this.queue.end(job, "failed", Date.now(), words);
      if (job.state === "failed") fail("背景を頼めません", words);
      this.pump();
    }
    this.renderAll();
  }

  private newStamp(): string {
    const base = requestStamp(new Date());
    let stamp = base;
    for (let n = 2; this.stamps.has(stamp); n++) stamp = `${base}-${n}`;
    this.stamps.add(stamp);
    return stamp;
  }

  private stop(job: DrawJob): void {
    if (!this.queue.stop(job, Date.now()) && job.run != null) void call("ai_stop", { run: job.run }).catch(() => {});
    this.renderAll();
  }

  private stopAll(): void {
    // Those waiting first, so none starts as one running stops.
    for (const job of this.queue.waiting) this.queue.stop(job, Date.now());
    for (const job of this.queue.running) this.stop(job);
    this.renderAll();
  }

  private renderAll(): void {
    this.renderState();
    this.renderJobs();
    this.renderPanels();
  }

  private hear(event: AiEvent): void {
    const lane = this.lanes.find((one) => one.conversation?.running === event.run);
    if (!lane?.conversation?.hear(event)) return;
    if (event.kind === "done" || event.kind === "error") {
      const job = this.queue.byRun(event.run);
      if (job) {
        job.to = lane.conversation.entries.length;
        this.queue.end(job, event.kind === "done" ? "done" : "failed", Date.now(), event.kind === "error" ? event.text : undefined);
      }
      void this.reload(false);
      this.host.status(
        event.kind === "done"
          ? `背景を描き終わりました${job ? `（${job.title}）` : ""}。コマごとの背景で採用・修正を選べます`
          : `背景: ${event.text.split("\n")[0]}`,
      );
      this.pump();
      if (!this.queue.jobs.some(isOpen)) this.allDone();
    } else if (event.kind === "tool" && /背景\.json|案\//.test(event.text)) {
      // A take written: show it as soon as it is listed.
      void this.reload(false);
    }
    this.renderState();
    this.renderJobs();
  }

  /** Every request drawn: said outside the window too (another app in front). */
  private allDone(): void {
    if (document.hasFocus()) return;
    const ended = this.queue.jobs.filter((job) => !job.words);
    const failed = ended.filter((job) => job.state === "failed").length;
    void call("timer_notice", {
      notice: {
        title: "背景を描き終わりました",
        body: `Name Studio の作画: ${ended.length - failed} 件済み${failed ? `・${failed} 件失敗` : ""}`,
        toast: true,
        flash: true,
        front: false,
      },
    }).catch(() => {});
  }
}
