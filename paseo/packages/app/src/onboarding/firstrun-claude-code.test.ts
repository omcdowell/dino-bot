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
} from "./firstrun-claude-code";

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
