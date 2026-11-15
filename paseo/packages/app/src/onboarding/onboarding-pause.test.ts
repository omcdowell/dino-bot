import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_EXIT_ROUTE,
  isOnboardingPaused,
  onboardingPauseVersion,
  pauseOnboarding,
  resetOnboardingPause,
  resumeOnboarding,
  subscribeOnboardingPause,
} from "./onboarding-pause";

afterEach(() => resetOnboardingPause());

describe("onboarding pause (Back out of the first step)", () => {
  it("Back goes to Welcome, which is still onboarding", () => {
    expect(ONBOARDING_EXIT_ROUTE).toBe("/welcome");
  });
  it("pause / resume per host, with change notices", () => {
    const seen = vi.fn();
    const off = subscribeOnboardingPause(seen);
    const v0 = onboardingPauseVersion();
    expect(isOnboardingPaused("a")).toBe(false);
    pauseOnboarding("a");
    pauseOnboarding("a"); // once is enough
    expect(isOnboardingPaused("a")).toBe(true);
    expect(isOnboardingPaused("b")).toBe(false);
    expect(isOnboardingPaused(null)).toBe(false);
    resumeOnboarding("a");
    resumeOnboarding("a");
    expect(isOnboardingPaused("a")).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(onboardingPauseVersion()).toBe(v0 + 2);
    pauseOnboarding("");
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});
