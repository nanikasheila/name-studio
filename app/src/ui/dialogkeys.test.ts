import { describe, expect, it } from "vitest";
import { type EnterPress, isPlainEnter, isTextField } from "./dialogkeys";

const press = (over: Partial<EnterPress> = {}): EnterPress => ({
  key: "Enter",
  isComposing: false,
  keyCode: 13,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  ...over,
});

describe("Enter in a dialog's field", () => {
  it("is answered when it is Enter alone", () => {
    expect(isPlainEnter(press())).toBe(true);
    expect(isPlainEnter(press({ key: "a" }))).toBe(false);
    expect(isPlainEnter(press({ ctrlKey: true }))).toBe(false);
    expect(isPlainEnter(press({ shiftKey: true }))).toBe(false);
  });

  it("leaves the Enter that settles かな漢字変換 to the field", () => {
    expect(isPlainEnter(press({ isComposing: true }))).toBe(false);
    expect(isPlainEnter(press({ keyCode: 229 }))).toBe(false);
  });

  it("leaves an Enter the field took itself", () => {
    expect(isPlainEnter(press({ defaultPrevented: true }))).toBe(false);
  });

  it("is for fields typed in, not boxes ticked or sliders", () => {
    for (const type of ["text", "number", "search"]) expect(isTextField(type), type).toBe(true);
    for (const type of ["checkbox", "radio", "range", "file", "color", "button"]) expect(isTextField(type), type).toBe(false);
  });
});
