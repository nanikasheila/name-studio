// The name data is written twice: the Rust types (crates/name-model) and
// model.ts. generated/name-model.ts is the Rust side as TypeScript (made and
// kept current by `cargo test -p name-model --features ts`); here the type
// check compares the two, type by type:
// - every field Rust has, model.ts has (none is dropped by the app unseen);
// - what Rust sends fits model.ts's type (a field Rust may leave out is
//   optional here, a choice has the same values, numbers stay numbers).
// The way back (what the app writes, Rust reads without losing anything) is
// contract.test.ts with crates/name-model/tests/contract.rs.
import { describe, expect, it } from "vitest";
import type * as Rust from "./generated/name-model";
import type * as App from "./model";
import generated from "./generated/name-model.ts?raw";

/** Fields of `R` that `A` lacks: none, or their names. */
type Missing<R, A> = Exclude<keyof R, keyof A>;
/**
 * `A` with its choices of words taken as any word where Rust keeps a plain
 * string (a 付箋's colour, a fill's tone): Rust passes those through as they
 * are, and the app gives them their meaning.
 */
type Loosen<R, A> = [R] extends [string]
  ? string extends R
    ? A extends string
      ? string
      : A
    : A
  : R extends readonly (infer RU)[]
    ? A extends readonly (infer AU)[]
      ? Loosen<RU, AU>[]
      : A
    : R extends object
      ? A extends object
        ? { [K in keyof A]: K extends keyof R ? Loosen<NonNullable<R[K]>, NonNullable<A[K]>> : A[K] }
        : A
      : A;
/** True when `R` (what Rust sends) fits `A` and `A` knows all of `R`'s fields. */
type Agrees<R, A> = [Missing<R, A>] extends [never] ? ([R] extends [Loosen<R, A>] ? true : { "does not fit": [R, Loosen<R, A>] }) : { "fields model.ts lacks": Missing<R, A> };

/** Each Rust type and the model.ts type it is read as (inline there, for a few). */
interface Pairs {
  Project: [Rust.Project, App.Project];
  HeldPanel: [Rust.HeldPanel, App.HeldPanel];
  Alternatives: [Rust.Alternatives, App.Alternatives];
  AlternativeOption: [Rust.AlternativeOption, App.AlternativeOption];
  Binding: [Rust.Binding, App.Binding];
  PageFormat: [Rust.PageFormat, App.PageFormat];
  Page: [Rust.Page, App.Page];
  ReferenceImage: [Rust.ReferenceImage, App.ReferenceImage];
  StoredImage: [Rust.StoredImage, App.StoredImage];
  Fill: [Rust.Fill, App.Fill];
  Sticky: [Rust.Sticky, App.Sticky];
  StickyLink: [Rust.StickyLink, App.StickyLink];
  Gutters: [Rust.Gutters, App.Gutters];
  LineFonts: [Rust.LineFonts, App.LineFonts];
  NameStyle: [Rust.NameStyle, App.NameStyle];
  KindSizes: [Rust.KindSizes, NonNullable<App.NameStyle["fontPt"]>];
  CspPage: [Rust.CspPage, App.CspPage];
  StoryPosition: [Rust.StoryPosition, App.StoryPosition];
  CspStory: [Rust.CspStory, App.CspStory];
  StoryPageNumber: [Rust.StoryPageNumber, NonNullable<App.CspStory["pageNumber"]>];
  NombrePlace: [Rust.NombrePlace, App.NombrePlace];
  ShownNombre: [Rust.ShownNombre, App.ShownNombre];
  Plan: [Rust.Plan, App.Plan];
  StoryShape: [Rust.StoryShape, App.StoryShape];
  ShapePart: [Rust.ShapePart, App.ShapePart];
  ShapeBeat: [Rust.ShapeBeat, App.ShapeBeat];
  Panel: [Rust.Panel, App.Panel];
  PanelBorder: [Rust.PanelBorder, App.PanelBorder];
  PanelFill: [Rust.PanelFill, App.PanelFill];
  PanelEffect: [Rust.PanelEffect, App.PanelEffect];
  Breakout: [Rust.Breakout, App.Breakout];
  LineKind: [Rust.LineKind, App.LineKind];
  LineShapes: [Rust.LineShapes, NonNullable<App.Project["lineShapes"]>];
  BalloonShape: [Rust.BalloonShape, App.BalloonShape];
  TailStyle: [Rust.TailStyle, App.TailStyle];
  Tail: [Rust.Tail, App.Tail];
  Line: [Rust.Line, App.Line];
  Stroke: [Rust.Stroke, App.Stroke];
  StrokePoint: [Rust.StrokePoint, App.StrokePoint];
  RoughLayer: [Rust.RoughLayer, App.RoughLayer];
  BrushKind: [Rust.BrushKind, App.BrushKind];
  EraseMode: [Rust.EraseMode, App.EraseMode];
  PressureCurve: [Rust.PressureCurve, App.PressureCurve];
  BrushTip: [Rust.BrushTip, App.BrushTip];
  Brush: [Rust.Brush, App.Brush];
  RoughImage: [Rust.RoughImage, App.RoughImage];
  Character: [Rust.Character, App.Character];
  Scene: [Rust.Scene, App.Scene];
  EmotionPoint: [Rust.EmotionPoint, App.EmotionPoint];
  SourceSheet: [Rust.SourceSheet, App.SourceSheet];
  Series: [Rust.Series, App.Series];
  SeriesEpisode: [Rust.SeriesEpisode, App.SeriesEpisode];
  SeriesShared: [Rust.SeriesShared, App.SeriesShared];
}

const agreed: { [K in keyof Pairs]: Agrees<Pairs[K][0], Pairs[K][1]> } = {
  Project: true, HeldPanel: true, Alternatives: true, AlternativeOption: true, Binding: true, PageFormat: true, Page: true, ReferenceImage: true,
  StoredImage: true, Fill: true, Sticky: true, StickyLink: true, Gutters: true, LineFonts: true, NameStyle: true, KindSizes: true, CspPage: true,
  StoryPosition: true, CspStory: true, StoryPageNumber: true, NombrePlace: true, ShownNombre: true, Plan: true, StoryShape: true, ShapePart: true,
  ShapeBeat: true, Panel: true, PanelBorder: true, PanelFill: true, PanelEffect: true, Breakout: true, LineKind: true, LineShapes: true, BalloonShape: true,
  TailStyle: true, Tail: true, Line: true, Stroke: true, StrokePoint: true, RoughLayer: true, BrushKind: true, EraseMode: true, PressureCurve: true,
  BrushTip: true, Brush: true, RoughImage: true, Character: true, Scene: true, EmotionPoint: true, SourceSheet: true, Series: true, SeriesEpisode: true,
  SeriesShared: true,
};

describe("model.ts と Rust の型", () => {
  it("pairs every Rust type (one added in Rust fails here until it is paired above)", () => {
    const names = [...generated.matchAll(/^export type (\w+)/gm)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => !(name in agreed))).toEqual([]);
  });

  it("agree, type by type (the type check does the work)", () => {
    expect(Object.values(agreed).every((value) => value === true)).toBe(true);
  });
});
