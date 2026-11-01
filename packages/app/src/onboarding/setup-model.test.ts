import { describe, expect, it } from "vitest";
import { RELEASE_POLICIES } from "@/constants/flavour";
import {
  buildSetupRequest,
  defaultBotModel,
  importWarning,
  initialSetupState,
  needsSetup,
  type ImportEstimate,
} from "./setup-model";

const estimate: ImportEstimate = {
  messages: 8296,
  calls: 74739,
  tokens: 742_700_000,
  hours: 40,
  usd: { low: 195, mid: 389, high: 584 },
  weeklyShare: 6.5,
  model: "claude-haiku-4-5",
  billing: "plan",
  label: "Claude Pro (Claude login)",
};

describe("setup defaults (public policy = the owner's recommended answers)", () => {
  const pub = initialSetupState(RELEASE_POLICIES.public);
  it("import off, last 90 days, ~/scratch unticked, Claude plan Pro", () => {
    expect(pub).toEqual({
      claudePlan: "pro",
      importEnabled: false,
      importDays: 90,
      includeScratch: false,
    });
  });
  it("Pro login → Sonnet, not Opus; the Max switch gives Opus", () => {
    expect(defaultBotModel("claude", "pro")).toBe("anthropic/claude-sonnet-5-5");
    expect(defaultBotModel("claude", "max")).toBe("anthropic/claude-opus-5-5");
    expect(defaultBotModel("chatgpt", "pro")).toBe("openai-codex/gpt-6-sol");
    expect(defaultBotModel("unknown", "pro")).toBeNull();
    expect(defaultBotModel(null, "max")).toBeNull();
  });
  it("request carries the import only when switched on", () => {
    expect(buildSetupRequest(pub, "claude").import).toBeNull();
    expect(buildSetupRequest({ ...pub, importEnabled: true }, "claude")).toEqual({
      claudePlan: "pro",
      defaultBotModel: "anthropic/claude-sonnet-5-5",
      import: { days: 90, includeScratch: false },
    });
  });
  it("setup runs once per host and never on the own build", () => {
    expect(needsSetup(RELEASE_POLICIES.public, [], "srv")).toBe(true);
    expect(needsSetup(RELEASE_POLICIES.public, ["srv"], "srv")).toBe(false);
    expect(needsSetup(RELEASE_POLICIES.own, [], "srv")).toBe(false);
  });
});

describe("import warning copy", () => {
  it("drops the plan % line when the policy says so", () => {
    const text = importWarning(estimate, { showPlanPercent: false });
    expect(text).toContain("Importing your old chats will use a lot of your subscription.");
    expect(text).toContain("8,296 messages → about 742.7 M tokens with claude-haiku-4-5");
    expect(text).toContain("$389 at API prices");
    expect(text).not.toMatch(/%/);
    expect(text).toContain("runs in the background for about 40 hours");
  });
  it("keeps it when allowed", () => {
    expect(importWarning(estimate, { showPlanPercent: true })).toContain("650% of a weekly");
  });
  it("API billing gives the range", () => {
    expect(importWarning({ ...estimate, billing: "api" }, { showPlanPercent: false })).toContain(
      "$389 on your API bill (could be $195–$584)",
    );
  });
});
