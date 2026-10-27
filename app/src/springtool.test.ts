import { describe, expect, it } from "vitest";
import { SpringTool } from "./springtool";

describe("一時切り替え", () => {
  it("keeps the tool a short press changed to", () => {
    const spring = new SpringTool<string>(500);
    spring.press("KeyE", "pen", 0);
    expect(spring.release("KeyE", 120)).toBeNull();
  });

  it("gives back the tool from before when the key was held", () => {
    const spring = new SpringTool<string>(500);
    spring.press("KeyE", "pen", 0);
    expect(spring.holds("KeyE")).toBe(true);
    expect(spring.release("KeyE", 800)).toBe("pen");
    expect(spring.holds("KeyE")).toBe(false);
  });

  it("gives it back however short the press, when the tool was used meanwhile", () => {
    const spring = new SpringTool<string>(500);
    spring.press("KeyE", "pen", 0);
    spring.pointerDown();
    expect(spring.pointerUp()).toBeNull();
    expect(spring.release("KeyE", 200)).toBe("pen");
  });

  it("waits for the stroke to end when let go in the middle of it", () => {
    const spring = new SpringTool<string>(500);
    spring.press("KeyE", "pen", 0);
    spring.pointerDown();
    expect(spring.release("KeyE", 300)).toBeNull();
    expect(spring.pointerUp()).toBe("pen");
    expect(spring.pointerUp()).toBeNull();
  });

  it("minds only the key that lent the tool", () => {
    const spring = new SpringTool<string>(500);
    spring.press("KeyE", "pen", 0);
    expect(spring.release("KeyP", 900)).toBeNull();
    spring.reset();
    expect(spring.release("KeyE", 900)).toBeNull();
  });
});
