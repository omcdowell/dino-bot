import { describe, expect, it } from "vitest";
import { isUserMessageTrailingRowVisible, resolveAssistantFooterLabels } from "./message-meta";

describe("isUserMessageTrailingRowVisible", () => {
  it("shows the timestamp/tick row for a settled text message without hover", () => {
    expect(isUserMessageTrailingRowVisible({ isPending: false, hasText: true })).toBe(true);
  });

  it("hides it for pending bubbles, which carry their own clock/tick", () => {
    expect(isUserMessageTrailingRowVisible({ isPending: true, hasText: true })).toBe(false);
  });

  it("hides it for messages without text", () => {
    expect(isUserMessageTrailingRowVisible({ isPending: false, hasText: false })).toBe(false);
  });
});

describe("resolveAssistantFooterLabels", () => {
  const both = { durationLabel: "12s", timestampLabel: "14:03" };

  it("on web shows duration and end time together, with no swap", () => {
    const result = resolveAssistantFooterLabels({
      ...both,
      showBoth: true,
      revealTimestamp: false,
    });
    expect(result).toEqual({ label: "12s · 14:03", sizer: "12s · 14:03", canSwap: false });
  });

  it("on web ignores the reveal flag (nothing hidden behind hover)", () => {
    const result = resolveAssistantFooterLabels({ ...both, showBoth: true, revealTimestamp: true });
    expect(result.label).toBe("12s · 14:03");
  });

  it("on native keeps the tap-to-swap behaviour", () => {
    expect(
      resolveAssistantFooterLabels({ ...both, showBoth: false, revealTimestamp: false }),
    ).toEqual({ label: "12s", sizer: "14:03", canSwap: true });
    expect(
      resolveAssistantFooterLabels({ ...both, showBoth: false, revealTimestamp: true }).label,
    ).toBe("14:03");
  });

  it("falls back to whichever label exists", () => {
    expect(
      resolveAssistantFooterLabels({
        durationLabel: "",
        timestampLabel: "14:03",
        showBoth: true,
        revealTimestamp: false,
      }),
    ).toEqual({ label: "14:03", sizer: "14:03", canSwap: false });
    expect(
      resolveAssistantFooterLabels({
        durationLabel: "5s",
        timestampLabel: "",
        showBoth: false,
        revealTimestamp: true,
      }),
    ).toEqual({ label: "5s", sizer: "5s", canSwap: false });
  });
});
