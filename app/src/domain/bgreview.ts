// 要求の点検: name-blockout's check of a background request (what is missing
// or contradicts, and the next one or two questions with choices), and the
// author's answers taken back into the name. An answer goes into the field it
// names where the name has one (the camera in words, the place, the look, a
// far layer's picture), else it is kept by name-blockout's path in
// PanelBackground.answers and written into the instruction (instructionShot
// applies them); a choice that sets nothing (おまかせ) is kept as answered, so
// the same question is not asked again. Pure.
import type { BackgroundAnswer, BackgroundCamera, LightKey, LookSetting, Panel, TimeOfDay, Weather } from "../model/model";
import { backgroundOf, setBackground } from "./background";
import { setLook, setMaterial } from "./bglook";

export type FindingLevel = "error" | "warn" | "info";

/** One thing name-blockout found in a shot. */
export interface Finding {
  code: string;
  level: FindingLevel;
  /** The shot (the panel's id) and its name. */
  shot: string;
  label: string;
  /** Where in the shot. */
  path: string;
  message: string;
}

/** A question with choices; each choice sets values (by path) or nothing (おまかせ). */
export interface Question {
  shot: string;
  label: string;
  path: string;
  code: string;
  text: string;
  options: { label: string; set: Record<string, unknown> | null }[];
  recommended: number;
  why?: string;
}

export interface Review {
  findings: Finding[];
  questions: Question[];
}

const LEVELS: readonly FindingLevel[] = ["error", "warn", "info"];
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** name-blockout's `check --json` read (what does not fit is left out). */
export function readReview(source: string): Review {
  const data = JSON.parse(source) as { findings?: unknown; questions?: unknown };
  const findings = (Array.isArray(data.findings) ? data.findings : []).flatMap((item): Finding[] => {
    const f = (item ?? {}) as Record<string, unknown>;
    const level = LEVELS.find((one) => one === f.level);
    if (!level || !text(f.shot)) return [];
    return [{ code: text(f.code), level, shot: text(f.shot), label: text(f.label), path: text(f.path), message: text(f.message) }];
  });
  const questions = (Array.isArray(data.questions) ? data.questions : []).flatMap((item): Question[] => {
    const q = (item ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((option) => {
      const o = (option ?? {}) as Record<string, unknown>;
      const set = o.set && typeof o.set === "object" && !Array.isArray(o.set) ? (o.set as Record<string, unknown>) : null;
      return text(o.label) ? [{ label: text(o.label), set }] : [];
    });
    if (!text(q.shot) || !text(q.text) || !options.length) return [];
    const recommended = typeof q.recommended === "number" && q.recommended >= 0 && q.recommended < options.length ? q.recommended : 0;
    return [
      {
        shot: text(q.shot),
        label: text(q.label),
        path: text(q.path),
        code: text(q.code),
        text: text(q.text),
        options,
        recommended,
        ...(text(q.why) ? { why: text(q.why) } : {}),
      },
    ];
  });
  return { findings, questions };
}

const CAMERAS: readonly BackgroundCamera[] = ["eye", "low", "high"];

/** One value put where the name keeps it; false when the name has no field for it. */
function intoField(panel: Panel, path: string, value: unknown): boolean {
  const bg = backgroundOf(panel);
  if (path === "intent.camera" && CAMERAS.includes(value as BackgroundCamera)) {
    setBackground(panel, { camera: value as BackgroundCamera });
    return true;
  }
  if (path === "place.asset" && typeof value === "string") {
    setBackground(panel, { place: value });
    return true;
  }
  if (path === "look.timeOfDay" && typeof value === "string") {
    setLook(panel, { timeOfDay: value as TimeOfDay });
    return true;
  }
  if (path === "look.weather" && typeof value === "string") {
    setLook(panel, { weather: value as Weather });
    return true;
  }
  if (path === "look.setting" && typeof value === "string") {
    setLook(panel, { setting: value as LookSetting });
    return true;
  }
  if (path === "look.light.key" && typeof value === "string") {
    setLook(panel, { light: value as LightKey });
    return true;
  }
  const material = /^look\.materials\/(.+)$/.exec(path);
  if (material && typeof value === "string") {
    setMaterial(panel, material[1], value);
    return true;
  }
  // far/<n>/asset: the n-th layer as the instruction lists it (the same order as the name keeps them).
  const far = /^far\/(\d+)\/asset$/.exec(path);
  if (far && typeof value === "string" && bg.far?.[Number(far[1])]) {
    setBackground(panel, { far: bg.far.map((layer, i) => (i === Number(far[1]) ? { ...layer, asset: value } : layer)) });
    return true;
  }
  return false;
}

/** The answers kept but for `path` (and those under it). */
const without = (answers: readonly BackgroundAnswer[], path: string) =>
  answers.filter((one) => one.path !== path && !one.path.startsWith(`${path}/`) && !one.path.startsWith(`${path}.`));

/**
 * The author's choice for a question: each value where the name keeps it, else kept by its path; a choice that sets
 * nothing keeps the question as answered (おまかせ).
 */
export function answer(panel: Panel, question: Pick<Question, "path">, set: Record<string, unknown> | null): void {
  let answers = [...(backgroundOf(panel).answers ?? [])];
  if (!set || !Object.keys(set).length) {
    answers = [...without(answers, question.path), { path: question.path }];
  } else {
    for (const [path, value] of Object.entries(set)) {
      answers = without(answers, path);
      if (!intoField(panel, path, value)) answers.push({ path, value: JSON.stringify(value) });
    }
  }
  setBackground(panel, { answers });
}

/** The answers' values written into an instruction's shot, and the paths answered as requirement.answered. */
export function applyAnswers(shot: Record<string, unknown>, answers: readonly BackgroundAnswer[] | undefined): void {
  if (!answers?.length) return;
  for (const one of answers) {
    if (one.value === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(one.value);
    } catch {
      continue;
    }
    setPath(shot, one.path, value);
  }
  const requirement = (shot.requirement ?? {}) as Record<string, unknown>;
  shot.requirement = { ...requirement, answered: [...new Set(answers.map((one) => one.path))] };
}

/** a.b.c, objects/<id or n>/field, far/<n>/field, look.materials/<target> (as name-blockout reads them). */
export function setPath(shot: Record<string, unknown>, path: string, value: unknown): boolean {
  const keys = path.split("/").flatMap((part, i) => (i === 0 ? part.split(".") : [part]));
  let node: unknown = shot;
  for (const [i, key] of keys.slice(0, -1).entries()) {
    if (Array.isArray(node)) {
      const item = itemOf(node, key);
      if (!item) return false;
      node = item;
      continue;
    }
    const at = node as Record<string, unknown>;
    if (at[key] == null) {
      if (["objects", "figures", "far"].includes(key)) return false;
      at[key] = key === "materials" && i === keys.length - 2 ? [] : {};
    }
    node = at[key];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(node)) {
    const item = itemOf(node, last);
    if (item && "target" in item) {
      item.material = value;
      return true;
    }
    if (!item && node.every((one) => one && typeof one === "object" && "target" in one)) {
      node.push({ target: last, material: value });
      return true;
    }
    return false;
  }
  (node as Record<string, unknown>)[last] = value;
  return true;
}

function itemOf(items: unknown[], key: string): Record<string, unknown> | undefined {
  const objects = items.filter((one): one is Record<string, unknown> => !!one && typeof one === "object");
  return (
    objects.find((one) => one.id === key) ??
    objects.find((one) => one.target === key) ??
    (/^\d+$/.test(key) ? objects[Number(key)] : undefined)
  );
}

/** The findings of each shot (by the panel's id), errors first as name-blockout lists them. */
export function findingsByShot(review: Review): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of review.findings) out.set(f.shot, [...(out.get(f.shot) ?? []), f]);
  return out;
}
