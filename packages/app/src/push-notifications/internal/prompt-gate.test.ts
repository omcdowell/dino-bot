import { describe, expect, it } from "vitest";
import { PUSH_PROMPT_GATE_KEY, createPromptGate } from "./prompt-gate";

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("notification prompt gate (rel-demo bug 6)", () => {
  it("off (own build): the prompt may appear at once, as upstream", async () => {
    const gate = createPromptGate({
      storage: memory(),
      deferUntilFirstReply: false,
    });
    await expect(gate.wait()).resolves.toBeUndefined();
    expect(gate.isOpen()).toBe(true);
  });

  it("public build: waits at Connect, opens on the first reply and remembers it", async () => {
    const storage = memory();
    const gate = createPromptGate({ storage, deferUntilFirstReply: true });
    let asked = false;
    void gate.wait().then(() => {
      asked = true;
      return undefined;
    });
    await flush();
    expect(asked).toBe(false);
    gate.noteReply();
    await flush();
    expect(asked).toBe(true);
    expect(storage.map.get(PUSH_PROMPT_GATE_KEY)).toBe("1");
  });

  it("a later launch after a reply asks straight away", async () => {
    const gate = createPromptGate({
      storage: memory({ [PUSH_PROMPT_GATE_KEY]: "1" }),
      deferUntilFirstReply: true,
    });
    await expect(gate.wait()).resolves.toBeUndefined();
    expect(gate.isOpen()).toBe(true);
  });

  it("a storage error neither opens the gate nor throws", async () => {
    const gate = createPromptGate({
      storage: {
        getItem: async () => {
          throw new Error("disk");
        },
        setItem: async () => {
          throw new Error("disk");
        },
      },
      deferUntilFirstReply: true,
    });
    let asked = false;
    void gate.wait().then(() => {
      asked = true;
      return undefined;
    });
    await flush();
    expect(asked).toBe(false);
    gate.noteReply();
    await flush();
    expect(asked).toBe(true);
  });
});
