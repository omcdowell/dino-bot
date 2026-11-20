import { describe, expect, it } from "vitest";
import { claudeSetupSteps, type ClaudeCodeCard } from "./engines-model";
import type { SignInOption } from "./onboarding-model";
import {
  CLAUDE_CODE_FIRST_RUN_COPY,
  claudeCodeCardPressable,
  extraUsageWarning,
  firstRunClaudeCode,
  orderPiOptions,
  signedInWithClaudeCode,
  signInGate,
} from "./firstrun-claude-code";
import { claudeCodeViaProxy } from "./engines-model";

const card = (over: Partial<ClaudeCodeCard> = {}): ClaudeCodeCard => ({
  installed: true,
  version: "2.1.300",
  modsReady: true,
  loggedIn: false,
  authMethod: null,
  plan: null,
  warning: null,
  bots: [],
  error: null,
  ...over,
});

const EXTRA: SignInOption = {
  id: "anthropic:paste-code:5",
  provider: "anthropic",
  label: "Claude login (extra usage)",
  method: "paste-code",
  badge: "EXTRA USAGE",
  confirm: { title: "t", body: "b", ok: "ok" },
};
const VIA_PLUGIN: SignInOption = {
  ...EXTRA,
  label: "Claude login (your plan, via Acme)",
  badge: "UNOFFICIAL",
};
const opt = (
  id: string,
  provider: string,
  method = "device-code"
): SignInOption => ({
  id,
  provider,
  label: id,
  method,
});

describe("first-run Claude Code card", () => {
  it("a daemon without engines.* (no Claude Code login there): the card asks to update, not pressable, never hidden", () => {
    const s = firstRunClaudeCode({ unsupported: true, card: card() });
    expect(s).toEqual({
      kind: "update-host",
      message: CLAUDE_CODE_FIRST_RUN_COPY.updateHost,
    });
    expect(claudeCodeCardPressable(s)).toBe(false);
  });

  it("usable while engines.status is still on its way", () => {
    const s = firstRunClaudeCode({ unsupported: false, card: null });
    expect(s).toEqual({ kind: "checking" });
    expect(claudeCodeCardPressable(s)).toBe(true);
  });

  it("no claude CLI: the Providers page's install line, not pressable", () => {
    const s = firstRunClaudeCode({
      unsupported: false,
      card: card({ installed: false }),
    });
    expect(s).toEqual({
      kind: "not-installed",
      message: CLAUDE_CODE_FIRST_RUN_COPY.install,
      canInstall: false,
    });
    expect(CLAUDE_CODE_FIRST_RUN_COPY.install).toContain("claude.com/download");
    expect(claudeCodeCardPressable(s)).toBe(false);
  });

  it("no claude CLI, host can install it: the Install Claude Code button", () => {
    const s = firstRunClaudeCode({
      unsupported: false,
      card: card({ installed: false, canInstall: true }),
    });
    expect(s).toEqual({
      kind: "not-installed",
      message: CLAUDE_CODE_FIRST_RUN_COPY.installHere,
      canInstall: true,
    });
    expect(claudeCodeCardPressable(s)).toBe(false);
    expect(CLAUDE_CODE_FIRST_RUN_COPY.installButton).toBe(
      "Install Claude Code"
    );
  });

  it("logged out: pressable (starts claude auth login)", () => {
    const s = firstRunClaudeCode({ unsupported: false, card: card() });
    expect(s).toEqual({ kind: "logged-out" });
    expect(claudeCodeCardPressable(s)).toBe(true);
  });

  it("claude auth status failed: the error, still pressable", () => {
    const s = firstRunClaudeCode({
      unsupported: false,
      card: card({ error: "boom" }),
    });
    expect(s).toEqual({ kind: "error", message: "boom" });
    expect(claudeCodeCardPressable(s)).toBe(true);
  });

  it("logged in: the plan, not pressable, and listed as already signed in", () => {
    const s = firstRunClaudeCode({
      unsupported: false,
      card: card({ loggedIn: true, plan: "Max plan" }),
    });
    expect(s).toEqual({
      kind: "logged-in",
      status: "Logged in · Max plan",
    });
    expect(claudeCodeCardPressable(s)).toBe(false);
    expect(signedInWithClaudeCode(["ChatGPT (Codex)"], s)).toEqual([
      "Claude Code",
      "ChatGPT (Codex)",
    ]);
    expect(signedInWithClaudeCode(["Claude Code"], s)).toEqual(["Claude Code"]);
    expect(signedInWithClaudeCode(["X"], { kind: "logged-out" })).toEqual([
      "X",
    ]);
  });

  it("the card says it uses the Pro/Max plan", () => {
    expect(CLAUDE_CODE_FIRST_RUN_COPY.label).toBe("Claude Code");
    expect(CLAUDE_CODE_FIRST_RUN_COPY.note).toBe(
      "Uses your Claude Pro/Max plan"
    );
  });
});

describe("pi's list on first run", () => {
  it("the confirm-first Claude login goes to the bottom, the rest keep their order", () => {
    const list = [
      opt("codex", "openai-codex"),
      EXTRA,
      opt("copilot", "github-copilot"),
      opt("anthropic-key", "anthropic", "api-key"),
    ];
    expect(orderPiOptions(list).map((o) => o.id)).toEqual([
      "codex",
      "copilot",
      "anthropic-key",
      EXTRA.id,
    ]);
    expect(
      orderPiOptions([VIA_PLUGIN, opt("a", "openrouter")]).map((o) => o.id)
    ).toEqual(["a", VIA_PLUGIN.id]);
  });

  it("only the extra-usage Claude login carries the per-token warning", () => {
    expect(extraUsageWarning(EXTRA)).toBe(
      CLAUDE_CODE_FIRST_RUN_COPY.extraUsageWarning
    );
    expect(CLAUDE_CODE_FIRST_RUN_COPY.extraUsageWarning).toMatch(
      /per token on top of any Claude plan/
    );
    expect(extraUsageWarning(VIA_PLUGIN)).toBeNull();
    expect(
      extraUsageWarning(opt("anthropic-key", "anthropic", "api-key"))
    ).toBeNull();
    expect(extraUsageWarning(opt("codex", "openai-codex"))).toBeNull();
  });
});

describe("Install Claude Code steps", () => {
  const st = (steps: ReturnType<typeof claudeSetupSteps>) =>
    steps!.map((x) => x.state);
  it("1 installing → 2 log in → 3 done", () => {
    expect(claudeSetupSteps({ state: "running", phase: null })).toBeNull();
    expect(claudeSetupSteps({ state: "running" })).toBeNull();
    expect(
      st(claudeSetupSteps({ state: "running", phase: "install" }))
    ).toEqual(["current", "todo", "todo"]);
    expect(st(claudeSetupSteps({ state: "running", phase: "login" }))).toEqual([
      "done",
      "current",
      "todo",
    ]);
    expect(
      st(claudeSetupSteps({ state: "needs-input", phase: "login" }))
    ).toEqual(["done", "current", "todo"]);
    expect(st(claudeSetupSteps({ state: "done", phase: "login" }))).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(
      claudeSetupSteps({ state: "done", phase: "login" })!.map((x) => x.label)
    ).toEqual([
      "Installing Claude Code",
      "Log in with your Claude plan",
      "Done",
    ]);
  });
  it("a failure marks the step it happened in", () => {
    expect(st(claudeSetupSteps({ state: "error", phase: "install" }))).toEqual([
      "failed",
      "todo",
      "todo",
    ]);
    expect(st(claudeSetupSteps({ state: "error", phase: "login" }))).toEqual([
      "done",
      "failed",
      "todo",
    ]);
  });
});

describe("signInGate: the sign-in step after pairing (SR2: asked to log in when already logged in)", () => {
  const pi = (signedIn: string[]) => ({ available: true, signedIn });
  const gate = (over: Partial<Parameters<typeof signInGate>[0]> = {}) =>
    signInGate({
      firstRun: true,
      pick: false,
      shown: false,
      sessionActive: false,
      loadError: false,
      options: pi([]),
      claudeCode: firstRunClaudeCode({ unsupported: false, card: card() }),
      claudeCodeChecked: true,
      ...over,
    });
  const cc = (over: Partial<ClaudeCodeCard>) => firstRunClaudeCode({ unsupported: false, card: card(over) });

  it("Claude Code logged in (its own login): the step is done, skipped", () => {
    expect(gate({ claudeCode: cc({ loggedIn: true, authMethod: "claude.ai", plan: "Max plan" }) })).toBe("skip");
  });

  it("API key only (pi has a ready Anthropic API key; Claude Code logged out): skipped", () => {
    expect(gate({ options: pi(["Anthropic API key"]) })).toBe("skip");
    // Claude Code on an API key of its own counts too.
    expect(gate({ claudeCode: cc({ loggedIn: true, authMethod: "api_key", plan: "API key" }) })).toBe("skip");
  });

  it("proxy base URL (Claude Code through the owner's proxy; pi's placeholder key): skipped, shown as logged in", () => {
    const viaProxy = cc({ loggedIn: true, authMethod: "proxy", plan: "Through your proxy" });
    expect(viaProxy).toEqual({ kind: "logged-in", status: "Logged in · Through your proxy" });
    expect(claudeCodeCardPressable(viaProxy)).toBe(false); // no "Choose" → no fresh login
    expect(claudeCodeViaProxy({ loggedIn: true, authMethod: "proxy" })).toBe(true);
    expect(claudeCodeViaProxy({ loggedIn: true, authMethod: "claude.ai" })).toBe(false);
    expect(gate({ claudeCode: viaProxy })).toBe("skip");
    expect(gate({ options: pi(["Anthropic through your proxy"]) })).toBe("skip");
  });

  it("nothing signed in (a real first-time user): the list, as before", () => {
    expect(gate()).toBe("show");
    expect(gate({ claudeCode: cc({ installed: false, version: null }) })).toBe("show");
  });

  it("waits for both answers before deciding; a failed engines.status does not hold it", () => {
    expect(gate({ options: null })).toBe("wait");
    const checking = firstRunClaudeCode({ unsupported: false, card: null });
    expect(gate({ claudeCode: checking, claudeCodeChecked: false })).toBe("wait");
    expect(gate({ claudeCode: checking, claudeCodeChecked: true })).toBe("show");
    // pi already signed in: no need to wait for Claude Code.
    expect(gate({ options: pi(["ChatGPT (Codex)"]), claudeCode: checking, claudeCodeChecked: false })).toBe("skip");
    expect(gate({ claudeCode: firstRunClaudeCode({ unsupported: true, card: null }) })).toBe("show");
  });

  it("never skips from Settings, a named sign-in, Back from Choose models (pick), a sign-in going, once shown, or a load error", () => {
    const signedIn = { options: pi(["Anthropic API key"]) };
    expect(gate({ ...signedIn, firstRun: false })).toBe("show");
    expect(gate({ ...signedIn, pick: true })).toBe("show");
    expect(gate({ ...signedIn, sessionActive: true })).toBe("show");
    expect(gate({ ...signedIn, shown: true })).toBe("show");
    expect(gate({ ...signedIn, loadError: true })).toBe("show");
    expect(gate({ options: { available: false, signedIn: [] } })).toBe("show");
  });
});
