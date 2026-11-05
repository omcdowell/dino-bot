import { describe, expect, it } from "vitest";
import { displayModelLabel, friendlyModelLabel } from "./model-label";

describe("friendlyModelLabel", () => {
  it("spells out raw ids", () => {
    expect(friendlyModelLabel("anthropic/claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(friendlyModelLabel("optchat/anthropic/claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(friendlyModelLabel("openrouter/z-ai/glm-5.3")).toBe("GLM 5.3");
    expect(friendlyModelLabel("gpt-5-codex")).toBe("GPT 5 Codex");
  });
  it("keeps labels that already read as names", () => {
    expect(friendlyModelLabel("Claude Sonnet 5.5")).toBe("Claude Sonnet 5.5");
    expect(friendlyModelLabel("")).toBe("");
  });
  it("changes nothing in Sam's build", () => {
    expect(displayModelLabel("anthropic/claude-sonnet-5-5", false)).toBe(
      "anthropic/claude-sonnet-5-5",
    );
    expect(displayModelLabel("anthropic/claude-sonnet-5-5", true)).toBe("Claude Sonnet 5.5");
  });
});
