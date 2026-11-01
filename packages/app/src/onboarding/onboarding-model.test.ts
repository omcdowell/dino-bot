import { describe, expect, it } from "vitest";
import {
  badgeIsWarning,
  clampEffort,
  filterModels,
  initialPicks,
  nextStep,
  pickModel,
  previousStep,
  samePick,
  stepRoute,
  type ModelsAnswer,
  type PiModel,
} from "./onboarding-model";
import { RELEASE_POLICIES } from "@/constants/flavour";

const opus: PiModel = {
  provider: "anthropic",
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  levels: ["low", "medium", "high", "xhigh", "max"],
};
const mini: PiModel = {
  provider: "github-copilot",
  id: "gpt-5-mini",
  name: "GPT-5 mini",
  levels: ["minimal", "low", "medium", "high"],
};
const plain: PiModel = { provider: "local", id: "llama-3", name: "Llama 3 (local)", levels: [] };

describe("onboarding order", () => {
  it("public: sign in, models, import; own build: none; one list decides", () => {
    expect(RELEASE_POLICIES.public.onboardingSteps).toEqual(["signin", "models", "import"]);
    expect(RELEASE_POLICIES.own.onboardingSteps).toEqual([]);
    const steps = RELEASE_POLICIES.public.onboardingSteps;
    expect(nextStep(steps, null)).toBe("signin");
    expect(nextStep(steps, "signin")).toBe("models");
    expect(nextStep(steps, "import")).toBeNull();
    expect(nextStep(["models", "signin"], "models")).toBe("signin");
    expect(previousStep(steps, "models")).toBe("signin");
    expect(previousStep(steps, "signin")).toBeNull();
    expect(stepRoute("models", "srv 1")).toBe("/setup-models?serverId=srv%201");
  });
});

describe("model step", () => {
  it("effort only from the model's own levels; none hides the picker", () => {
    expect(clampEffort(opus, "off")).toBe("low");
    expect(clampEffort(mini, "max")).toBe("high");
    expect(clampEffort(plain, "medium")).toBeNull();
    expect(
      pickModel(mini, { provider: "anthropic", model: "claude-opus-5-5", thinking: "xhigh" }),
    ).toEqual({ provider: "github-copilot", model: "gpt-5-mini", thinking: "high" });
  });
  it("prefill: host's current choice, else the suggestion, only if pi lists it", () => {
    const answer: ModelsAnswer = {
      available: true,
      providers: ["anthropic"],
      subscription: "claude-pro",
      models: [opus, mini],
      suggested: {
        bots: { provider: "anthropic", model: "claude-opus-5-5", thinking: "medium" },
        compaction: { provider: "anthropic", model: "gone-model", thinking: "low" },
        workers: { provider: "anthropic", model: "claude-opus-5-5", thinking: "off" },
      },
      current: {
        bots: { provider: "github-copilot", model: "gpt-5-mini", thinking: "low" },
        compaction: null,
        workers: null,
      },
      error: null,
    };
    expect(initialPicks(answer)).toEqual({
      bots: { provider: "github-copilot", model: "gpt-5-mini", thinking: "low" },
      compaction: null,
      workers: { provider: "anthropic", model: "claude-opus-5-5", thinking: "low" },
    });
    expect(filterModels([opus, mini, plain], "COPILOT").map((m) => m.id)).toEqual(["gpt-5-mini"]);
    expect(
      samePick(answer.suggested.bots, {
        provider: "anthropic",
        model: "claude-opus-5-5",
        thinking: "medium",
      }),
    ).toBe(true);
    expect(samePick(null, null)).toBe(true);
    expect(samePick(answer.current.bots, answer.suggested.bots)).toBe(false);
  });
});

describe("sign-in badges", () => {
  const confirm = { title: "t", body: "b", ok: "Continue with Claude" };
  it("a badge on an option that needs a confirm is a warning, whatever the host calls it", () => {
    expect(badgeIsWarning({ badge: "EXTRA USAGE", confirm })).toBe(true);
    expect(badgeIsWarning({ badge: "UNOFFICIAL", confirm })).toBe(true);
    expect(badgeIsWarning({ badge: "NEW" })).toBe(false);
    expect(badgeIsWarning({ confirm })).toBe(false);
  });
});
