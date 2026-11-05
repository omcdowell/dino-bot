import { describe, expect, it } from "vitest";
import { createSignInMemory, providerLabels } from "./signin-session-store";
import type { SignInStatus } from "./onboarding-model";

const running: SignInStatus = {
  sessionId: "s1",
  provider: "github-copilot",
  label: "GitHub Copilot",
  state: "running",
  url: null,
  code: "ABCD-1234",
  instructions: null,
  prompt: null,
  error: null,
};

describe("sign-in memory (survives the screen being mounted again)", () => {
  it("gives a remounted screen the list and the sign-in in progress for that computer", () => {
    const memory = createSignInMemory<{ n: number }>();
    memory.setOptions("srv_a", { n: 1 });
    memory.setStatus("srv_a", running);
    expect(memory.get("srv_a")).toEqual({ options: { n: 1 }, status: running });
    expect(memory.get("srv_b")).toEqual({ options: null, status: null });
  });

  it("forgets the sign-in when it is cleared, and everything when the step is left", () => {
    const memory = createSignInMemory<{ n: number }>();
    memory.setOptions("srv_a", { n: 1 });
    memory.setStatus("srv_a", running);
    memory.setStatus("srv_a", null);
    expect(memory.get("srv_a")).toEqual({ options: { n: 1 }, status: null });
    memory.setStatus("srv_a", running);
    memory.forget("srv_a");
    expect(memory.get("srv_a")).toEqual({ options: null, status: null });
  });

  it("resumes polling only for a sign-in that is still going", () => {
    const memory = createSignInMemory<{ n: number }>();
    expect(memory.pending("srv_a")).toBeNull();
    memory.setStatus("srv_a", running);
    expect(memory.pending("srv_a")).toBe("s1");
    memory.setStatus("srv_a", { ...running, state: "needs-input" });
    expect(memory.pending("srv_a")).toBe("s1");
    memory.setStatus("srv_a", { ...running, state: "done" });
    expect(memory.pending("srv_a")).toBeNull();
    memory.setStatus("srv_a", { ...running, state: "error" });
    expect(memory.pending("srv_a")).toBeNull();
  });
});

describe("providerLabels (Choose models: the sign-in's own name, not pi's provider id)", () => {
  it("uses the host's 'Already signed in' labels when they line up with the providers", () => {
    expect(providerLabels(["openai-codex"], ["ChatGPT (Codex)"])).toEqual(["ChatGPT (Codex)"]);
    expect(
      providerLabels(["openai-codex", "anthropic"], ["ChatGPT (Codex)", "Anthropic API key"]),
    ).toEqual(["ChatGPT (Codex)", "Anthropic API key"]);
  });

  it("falls back to the provider ids when the lists do not line up or are missing", () => {
    expect(providerLabels(["openai-codex"], null)).toEqual(["openai-codex"]);
    expect(providerLabels(["openai-codex", "anthropic"], ["ChatGPT (Codex)"])).toEqual([
      "openai-codex",
      "anthropic",
    ]);
    expect(providerLabels(["openai-codex"], [""])).toEqual(["openai-codex"]);
  });
});

describe("sign-in memory for useSyncExternalStore", () => {
  it("keeps the same snapshot until something changes, and tells subscribers", () => {
    const memory = createSignInMemory<{ n: number }>();
    const seen: number[] = [];
    const off = memory.subscribe(() => seen.push(1));
    const empty = memory.get("srv_a");
    expect(memory.get("srv_a")).toBe(empty);
    memory.setStatus("srv_a", running);
    const after = memory.get("srv_a");
    expect(after).not.toBe(empty);
    expect(memory.get("srv_a")).toBe(after);
    memory.forget("srv_a");
    off();
    memory.setOptions("srv_a", { n: 2 });
    expect(seen).toHaveLength(2);
  });

  it("a result that lands after the screen was mounted again still reaches the new screen", () => {
    // The old screen's signin.start resolves after the remount: it writes the memory, and the new
    // screen (subscribed) shows the code and polls it.
    const memory = createSignInMemory<{ n: number }>();
    let renders = 0;
    memory.subscribe(() => renders++);
    memory.setStatus("srv_a", running);
    expect(renders).toBe(1);
    expect(memory.get("srv_a").status?.code).toBe("ABCD-1234");
    expect(memory.pending("srv_a")).toBe("s1");
  });
});
