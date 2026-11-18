import { describe, expect, it } from "vitest";
import { resolveProviderIconName } from "./provider-icon-name";

describe("resolveProviderIconName", () => {
  it("returns the built-in identifier for known provider ids", () => {
    expect(resolveProviderIconName("claude")).toEqual({ kind: "builtin", id: "claude" });
    expect(resolveProviderIconName("pi")).toEqual({ kind: "builtin", id: "pi" });
    expect(resolveProviderIconName("minimax")).toEqual({ kind: "builtin", id: "minimax" });
  });

  it("falls back to the bot icon for unknown custom providers", () => {
    expect(resolveProviderIconName("custom-claude-profile")).toEqual({ kind: "bot" });
    expect(resolveProviderIconName("gemini")).toEqual({ kind: "bot" });
    expect(resolveProviderIconName("omp")).toEqual({ kind: "bot" });
  });

  it("resolves a snapshot SVG for a custom provider", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';

    expect(resolveProviderIconName("snapshot-provider", svg)).toEqual({ kind: "svg", svg });
  });
});
