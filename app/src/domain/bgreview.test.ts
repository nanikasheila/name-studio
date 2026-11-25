import { describe, expect, it } from "vitest";
import type { Panel } from "../model/model";
import { lookOf } from "./bglook";
import { answer, applyAnswers, readReview, setPath } from "./bgreview";

const square: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const CHECK = JSON.stringify({
  findings: [
    {
      code: "camera.height",
      level: "warn",
      shot: "a",
      label: "p1 コマ1",
      path: "camera.heightM",
      message: "カメラの高さが決まっていません",
    },
    { code: "odd", level: "loud", shot: "a", label: "x", path: "", message: "読めない" },
  ],
  questions: [
    {
      shot: "a",
      label: "p1 コマ1",
      path: "camera.heightM",
      code: "camera.height",
      text: "カメラの高さは？",
      options: [
        { label: "目の高さ 1.5m", set: { "camera.heightM": 1.5 } },
        { label: "おまかせ", set: null },
      ],
      recommended: 0,
    },
    { shot: "a", text: "選択肢のない問い", options: [] },
  ],
});

describe("要求の点検", () => {
  it("reads name-blockout's check, leaving out what does not fit", () => {
    const review = readReview(CHECK);
    expect(review.findings.map((f) => f.code)).toEqual(["camera.height"]);
    expect(review.questions).toHaveLength(1);
    expect(review.questions[0].options[1].set).toBeNull();
  });

  it("takes an answer into the name's field when it has one, else by its path; おまかせ is kept as answered", () => {
    const panel: Panel = { id: "a", order: 1, shape: square, background: { objects: [{ id: "o1", label: "看板", shape: square }] } };
    answer(panel, { path: "look.timeOfDay" }, { "look.timeOfDay": "evening" });
    answer(panel, { path: "intent.camera" }, { "intent.camera": "low" });
    answer(panel, { path: "look.materials" }, { "look.materials/o1": "金属" });
    expect(lookOf(panel)).toEqual({ timeOfDay: "evening", materials: [{ target: "o1", material: "金属" }] });
    expect(panel.background?.camera).toBe("low");
    answer(panel, { path: "camera.heightM" }, { "camera.heightM": 1.5 });
    answer(panel, { path: "objects/0" }, { "objects/o1/onGround": false });
    answer(panel, { path: "look.north" }, null);
    expect(panel.background?.answers).toEqual([
      { path: "camera.heightM", value: "1.5" },
      { path: "objects/o1/onGround", value: "false" },
      { path: "look.north" },
    ]);
    // Answered again: the new value stands alone.
    answer(panel, { path: "camera.heightM" }, { "camera.heightM": 4 });
    expect(panel.background?.answers?.filter((one) => one.path === "camera.heightM")).toEqual([{ path: "camera.heightM", value: "4" }]);
  });

  it("writes the answers into the instruction's shot, and what was answered", () => {
    const shot: Record<string, unknown> = { id: "a", objects: [{ id: "o1", label: "看板" }], look: { timeOfDay: "noon" } };
    applyAnswers(shot, [
      { path: "camera.heightM", value: "1.5" },
      { path: "objects/o1/onGround", value: "false" },
      { path: "look.north", value: '"+X"' },
      { path: "look.materials/o1", value: '"金属"' },
      { path: "look.date" },
      { path: "broken", value: "{" },
    ]);
    expect(shot).toEqual({
      id: "a",
      objects: [{ id: "o1", label: "看板", onGround: false }],
      look: { timeOfDay: "noon", north: "+X", materials: [{ target: "o1", material: "金属" }] },
      camera: { heightM: 1.5 },
      requirement: {
        answered: ["camera.heightM", "objects/o1/onGround", "look.north", "look.materials/o1", "look.date", "broken"],
      },
    });
    expect(setPath(shot, "objects/gone/onGround", true)).toBe(false);
    expect(setPath(shot, "far/0/asset", "空")).toBe(false);
  });
});
