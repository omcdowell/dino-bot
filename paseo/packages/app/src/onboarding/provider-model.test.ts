import { describe, expect, it } from "vitest";
import {
  afterInstall,
  installInputFromLink,
  installStepCopy,
  isUnsupportedRpcError,
  packageLabel,
  providerLinkRoute,
  signInRoute,
  type InstallStatus,
} from "./provider-model";

const TOKEN = "github_pat_TEST_000000000000";
const base: InstallStatus = {
  jobId: "j",
  source: "git:https://github.com/acme/claude-plugin@v1",
  name: "Acme Claude",
  state: "done",
  step: "done",
  error: null,
  providers: [],
};

describe("provider-model", () => {
  it("old daemons (no provider.*) are told apart from other errors", () => {
    expect(isUnsupportedRpcError(new Error("Unknown RPC method: provider.list"))).toBe(true);
    expect(isUnsupportedRpcError(new Error("Not connected to your computer."))).toBe(false);
    expect(isUnsupportedRpcError(new Error("Unknown RPC method: signin.options"))).toBe(false);
  });

  it("reads source, token and name from an invite link, and nothing from other links", () => {
    const link = `dinobot://provider/add?source=${encodeURIComponent(
      "git:github.com/acme/claude-plugin@v1",
    )}&name=Acme+Claude&token=${TOKEN}`;
    expect(installInputFromLink(link, "dinobot")).toEqual({
      source: "git:github.com/acme/claude-plugin@v1",
      token: TOKEN,
      name: "Acme Claude",
    });
    expect(installInputFromLink("dinobot://provider/add?source=npm:x", "dinobot")).toEqual({
      source: "npm:x",
      token: null,
      name: null,
    });
    expect(installInputFromLink("dinobot://pair?x=1", "dinobot")).toBeNull();
    expect(installInputFromLink("https://provider/add?source=npm:x", "dinobot")).toBeNull();
    expect(installInputFromLink("dinobot://provider/add?name=x", "dinobot")).toBeNull();
  });

  it("after install: straight to the sign-in the new provider needs (Acme Claude → Claude login)", () => {
    const claude = {
      provider: "anthropic",
      plugin: "Acme Claude",
      ready: false,
      optionId: "anthropic:oauth:3",
      label: "Claude login (your plan, via Acme Claude)",
    };
    expect(afterInstall({ ...base, providers: [claude] })).toEqual({
      kind: "signin",
      optionId: "anthropic:oauth:3",
      label: claude.label,
    });
    expect(afterInstall({ ...base, providers: [{ ...claude, ready: true }] })).toEqual({
      kind: "ready",
      labels: [claude.label],
    });
    expect(
      afterInstall({
        ...base,
        providers: [{ ...claude, provider: "x", optionId: null }],
      }),
    ).toEqual({ kind: "no-signin", providers: ["x"] });
    expect(afterInstall(base)).toEqual({ kind: "ready", labels: [] });
  });

  it("routes: sign-in from settings, and a pasted link on one host", () => {
    expect(signInRoute("srv 1", "anthropic:oauth:3")).toBe(
      "/setup-signin?serverId=srv+1&from=settings&option=anthropic%3Aoauth%3A3",
    );
    expect(signInRoute("s")).toBe("/setup-signin?serverId=s&from=settings");
    expect(providerLinkRoute(" dinobot://provider/add?source=npm:x ", "s")).toBe(
      "/provider-link?link=dinobot%3A%2F%2Fprovider%2Fadd%3Fsource%3Dnpm%3Ax&serverId=s",
    );
  });

  it("labels", () => {
    expect(packageLabel("git:https://github.com/acme/claude-plugin@v1")).toBe(
      "github.com/acme/claude-plugin@v1",
    );
    expect(packageLabel("npm:pi-web-access")).toBe("pi-web-access");
    expect(installStepCopy("models")).toMatch(/model list/);
    expect(installStepCopy("weird")).toBe("Working…");
  });
});
