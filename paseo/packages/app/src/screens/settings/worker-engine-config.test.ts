import { describe, expect, it } from "vitest";
import {
  WORKER_ENGINE_HINT,
  WORKER_ENGINE_OPTIONS,
  WORKER_ENGINE_RPC,
  getWorkerEngineCardState,
  parseWorkerEngineAnswer,
} from "./worker-engine-config";

describe("workers default engine setting", () => {
  it("names the bots plugin RPCs (lower case, as the daemon requires)", () => {
    expect(WORKER_ENGINE_RPC).toEqual({
      pluginId: "bots",
      get: "workers.settings",
      set: "workers.settings.set",
    });
  });

  it("offers one global choice and sends per-bot defaults to the bot", () => {
    expect(WORKER_ENGINE_OPTIONS.map((o) => o.value)).toEqual(["auto", "cc", "pi"]);
    expect(WORKER_ENGINE_HINT).toMatch(
      /Claude Code when it is signed in on this computer, else pi/,
    );
    expect(WORKER_ENGINE_HINT).toMatch(/For per-bot defaults, ask your bot\.$/);
  });

  it("parses the plugin's answer; anything else hides the card", () => {
    const answer = { engine: "auto", effective: "cc", claudeCode: true, pi: false };
    expect(parseWorkerEngineAnswer(answer)).toEqual(answer);
    expect(parseWorkerEngineAnswer({ engine: "codex", effective: "cc" })).toBeNull();
    expect(parseWorkerEngineAnswer({ fullTools: true })).toBeNull();
    expect(parseWorkerEngineAnswer(null)).toBeNull();
    expect(
      getWorkerEngineCardState({ isConnected: true, answer: null, isPending: false, error: null })
        .isVisible,
    ).toBe(false);
  });

  it("shows what Automatic means now, and warns when the chosen engine is not signed in", () => {
    const state = (a: Parameters<typeof parseWorkerEngineAnswer>[0]) =>
      getWorkerEngineCardState({
        isConnected: true,
        answer: parseWorkerEngineAnswer(a),
        isPending: false,
        error: null,
      });
    expect(state({ engine: "auto", effective: "cc", claudeCode: true, pi: true }).statusText).toBe(
      "Now: Claude Code.",
    );
    expect(state({ engine: "auto", effective: "pi", claudeCode: false, pi: true }).statusText).toBe(
      "Now: pi.",
    );
    expect(
      state({ engine: "cc", effective: "cc", claudeCode: false, pi: true }).statusText,
    ).toMatch(/Claude Code is not signed in/);
    expect(
      state({ engine: "pi", effective: "pi", claudeCode: true, pi: false }).statusText,
    ).toMatch(/pi has no sign-in/);
    expect(
      state({ engine: "pi", effective: "pi", claudeCode: true, pi: true }).statusText,
    ).toBeNull();
    const busy = getWorkerEngineCardState({
      isConnected: true,
      answer: null,
      isPending: true,
      error: new Error("nope"),
    });
    expect(busy.isDisabled).toBe(true);
    expect(busy.errorText).toBe("nope");
  });
});
