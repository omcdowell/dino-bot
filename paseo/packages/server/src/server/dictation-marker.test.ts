import { describe, expect, test } from "vitest";
import { DICTATION_MARKER, markDictated } from "./dictation-marker.js";

describe("markDictated", () => {
  test("a dictated message starts with the marker", () => {
    expect(markDictated("call Bitzer about the demo", true)).toBe(
      "[dictated] call Bitzer about the demo",
    );
    expect(DICTATION_MARKER).toBe("[dictated] ");
  });

  test("typed messages and old clients (no flag) are unchanged", () => {
    expect(markDictated("hello", false)).toBe("hello");
    expect(markDictated("hello", undefined)).toBe("hello");
  });

  test("no marker on empty text, and never twice", () => {
    expect(markDictated("", true)).toBe("");
    expect(markDictated("  ", true)).toBe("  ");
    expect(markDictated("[dictated] hi", true)).toBe("[dictated] hi");
  });
});
