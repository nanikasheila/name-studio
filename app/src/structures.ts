// The built-in story shapes (起承転結, 三幕, Save the Cat …) a name can follow.

import type { BuiltinShapeId, StoryShape } from "./model";

/** Story shapes to hold the page split against: parts and their share of the pages. */
export const STRUCTURES: Record<BuiltinShapeId, StoryShape> = {
  kishotenketsu: {
    id: "kishotenketsu",
    label: "起承転結",
    parts: [
      { name: "起", share: 0.2 },
      { name: "承", share: 0.3 },
      { name: "転", share: 0.3 },
      { name: "結", share: 0.2 },
    ],
  },
  threeAct: {
    id: "threeAct",
    label: "三幕構成",
    parts: [
      { name: "第1幕（設定）", share: 0.25 },
      { name: "第2幕（対立）", share: 0.5 },
      { name: "第3幕（解決）", share: 0.25 },
    ],
    beats: [
      { name: "第1ターニングポイント", at: 0.25 },
      { name: "ミッドポイント", at: 0.5 },
      { name: "第2ターニングポイント", at: 0.75 },
    ],
  },
  johakyu: {
    id: "johakyu",
    label: "序破急",
    parts: [
      { name: "序", share: 0.25 },
      { name: "破", share: 0.5 },
      { name: "急", share: 0.25 },
    ],
  },
  // Blake Snyder's beat sheet, its 110 pages scaled to the name.
  saveTheCat: {
    id: "saveTheCat",
    label: "Save the Cat",
    parts: [
      { name: "セットアップ", share: 10 / 110 },
      { name: "きっかけ・悩みのとき", share: 15 / 110 },
      { name: "お楽しみ", share: 30 / 110 },
      { name: "迫り来る悪い奴ら", share: 20 / 110 },
      { name: "心の暗闇", share: 10 / 110 },
      { name: "フィナーレ", share: 25 / 110 },
    ],
    beats: [
      { name: "オープニング・イメージ", at: 0 },
      { name: "テーマの提示", at: 5 / 110 },
      { name: "きっかけ", at: 12 / 110 },
      { name: "第1ターニングポイント", at: 25 / 110 },
      { name: "サブプロット", at: 30 / 110 },
      { name: "ミッドポイント", at: 55 / 110 },
      { name: "すべてを失って", at: 75 / 110 },
      { name: "第2ターニングポイント", at: 85 / 110 },
      { name: "ファイナル・イメージ", at: 1 },
    ],
  },
};
