/**
 * When the app may show iOS's "Allow notifications?" prompt.
 *
 * Upstream asks as soon as a host connects. The public flavour waits for the first bot reply
 * (rel-flow, 27 Oct: ask once the user has seen what a notification would be for), so a
 * new user is not asked at Connect, before anything has happened. The gate opens once, is
 * remembered across launches, and only delays the first prompt: a permission already granted or
 * refused is read straight away (subscriptions.ts asks the gate only when iOS could still ask).
 */

export const PUSH_PROMPT_GATE_KEY = "@paseo:push-prompt-after-first-reply";

export interface PromptGateStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PromptGate {
  /** Resolves when the app may ask (at once when the gate is off or already open). */
  wait(): Promise<void>;
  /** A bot (or any agent) finished a reply: open the gate for good. */
  noteReply(): void;
  isOpen(): boolean;
}

export function createPromptGate(deps: {
  storage: PromptGateStorage;
  /** ReleasePolicy.pushPromptAfterFirstReply; false = ask at Connect, as upstream. */
  deferUntilFirstReply: boolean;
}): PromptGate {
  let open = !deps.deferUntilFirstReply;
  let loaded: Promise<void> | null = null;
  const waiters: Array<() => void> = [];

  const release = () => {
    open = true;
    for (const resolve of waiters.splice(0)) resolve();
  };
  const load = (): Promise<void> => {
    loaded ??= deps.storage
      .getItem(PUSH_PROMPT_GATE_KEY)
      .then((value) => {
        if (value === "1") release();
        return undefined;
      })
      .catch(() => undefined);
    return loaded;
  };

  return {
    async wait() {
      if (open) return;
      await load();
      if (open) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    noteReply() {
      if (open) return;
      release();
      deps.storage.setItem(PUSH_PROMPT_GATE_KEY, "1").catch(() => undefined);
    },
    isOpen: () => open,
  };
}
