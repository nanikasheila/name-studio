import { describe, expect, it } from "vitest";
import { largeOfferReason, largeOfferText } from "./largeoffer";

const base = { large: false, offered: false, pen: false, screenWidth: 1920, pixelRatio: 1 };

describe("offering 大きめ", () => {
  it("offers it when a pen is used", () => {
    expect(largeOfferReason({ ...base, pen: true })).toBe("pen");
  });

  it("offers it on a wide high-resolution screen near 100 %", () => {
    expect(largeOfferReason({ ...base, screenWidth: 2560 })).toBe("dense");
    expect(largeOfferReason({ ...base, screenWidth: 3072, pixelRatio: 1.25 })).toBe("dense");
  });

  it("does not on an ordinary screen, or one already scaled up", () => {
    expect(largeOfferReason(base)).toBeNull();
    expect(largeOfferReason({ ...base, screenWidth: 1280, pixelRatio: 1.5 })).toBeNull();
    expect(largeOfferReason({ ...base, screenWidth: 1920, pixelRatio: 2 })).toBeNull();
  });

  it("asks once, and not when it is on", () => {
    expect(largeOfferReason({ ...base, pen: true, offered: true })).toBeNull();
    expect(largeOfferReason({ ...base, pen: true, large: true })).toBeNull();
  });

  it("says how to go back", () => {
    for (const reason of ["pen", "dense"] as const) expect(largeOfferText(reason)).toContain("いつでも戻せます");
  });
});
