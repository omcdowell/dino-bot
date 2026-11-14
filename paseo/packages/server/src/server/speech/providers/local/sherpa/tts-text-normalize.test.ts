import { describe, expect, it } from "vitest";

import { integerToWords, normalizeTextForLexiconTts } from "./tts-text-normalize.js";

describe("normalizeTextForLexiconTts", () => {
  it("spells out integers", () => {
    expect(integerToWords(0)).toBe("zero");
    expect(integerToWords(43)).toBe("forty three");
    expect(integerToWords(1969)).toBe("one thousand nine hundred sixty nine");
    expect(integerToWords(2_000_005)).toBe("two million five");
  });

  it("replaces numbers in text, including commas, decimals and percent", () => {
    expect(normalizeTextForLexiconTts("review 3 files")).toBe("review three files");
    expect(normalizeTextForLexiconTts("budget is 1,969 dollars")).toBe(
      "budget is one thousand nine hundred sixty nine dollars",
    );
    expect(normalizeTextForLexiconTts("v2.0 at 15%.")).toBe("v two point zero at fifteen percent.");
  });

  it("reads long or zero-padded digit strings digit by digit", () => {
    expect(normalizeTextForLexiconTts("code 007")).toBe("code zero zero seven");
  });

  it("leaves text without digits unchanged", () => {
    expect(normalizeTextForLexiconTts("Hello, Alice.")).toBe("Hello, Alice.");
  });
});
