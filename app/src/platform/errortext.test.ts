import { describe, expect, it } from "vitest";
import { explain, failureText, rawText } from "./errortext";

describe("errors in words for the person at the screen", () => {
  it("says what to do about a file another app holds, and keeps the original", () => {
    const raw = "C:\\作品\\page0001.clip: プロセスはファイルにアクセスできません。別のプロセスが使用中です。 (os error 32)";
    const explained = explain(raw, true);
    expect(explained.text).toContain("ほかのアプリ");
    expect(explained.text).toContain("閉じてから");
    expect(explained.detail).toBe(raw);
  });

  it("reads the system's numbers as that system means them", () => {
    // 13 is 'no permission' on Linux and macOS, and nothing to do with files on Windows.
    expect(explain("x (os error 13)", false).text).toContain("権限");
    expect(explain("Permission denied (os error 13)", true).detail).toBe("Permission denied (os error 13)");
    expect(explain("No such file or directory (os error 2)", false).text).toContain("見つかりません");
    expect(explain("There is not enough space on the disk. (os error 112)", true).text).toContain("空き");
    expect(explain("No space left on device (os error 28)", false).text).toContain("空き");
  });

  it("leaves a message written for people as it is", () => {
    const message = "ひな形に仕上がり枠が要ります";
    expect(explain(message)).toEqual({ text: message, detail: null });
    expect(explain(new Error(message))).toEqual({ text: message, detail: null });
    expect(failureText("書き出せませんでした", message)).toBe(`書き出せませんでした: ${message}`);
  });

  it("does not show the machine's own words, but keeps them to look into", () => {
    const explained = explain(new TypeError("Cannot read properties of undefined (reading 'pages')"));
    expect(explained.text).toContain("思わぬエラー");
    expect(explained.text).not.toContain("undefined");
    expect(explained.detail).toContain("reading 'pages'");
    expect(explain("missing field `pages` at line 1 column 2").detail).toContain("missing field");
    // A dialog's own line has nowhere to open it from, so it follows in brackets.
    expect(failureText("読めませんでした", "missing field `pages`")).toBe("読めませんでした: 思わぬエラーが起きました（missing field `pages`）");
  });

  it("says when the network could not be reached", () => {
    expect(explain("error sending request for url (https://example.invalid/latest.json)").text).toContain("ネットワーク");
    expect(explain(new TypeError("Failed to fetch")).text).toContain("ネットワーク");
  });

  it("takes the text of whatever was thrown", () => {
    expect(rawText(new Error("a"))).toBe("a");
    expect(rawText("b")).toBe("b");
    expect(rawText({ message: "c" })).toBe("c");
    expect(rawText(404)).toBe("404");
    expect(explain("").text).toBe("理由は分かりません");
  });
});
