import type { SignInStatus } from "./onboarding-model";

/**
 * What the sign-in step knows per computer, kept outside the screen. The root stack remounts each
 * screen's content when the appearance changes (navigation/themed-stack.tsx: light/dark, e.g.
 * macOS "Auto" at sunset, or a CDP driver attaching), and that wiped a sign-in in progress: the
 * device code went and the list came back, asked for again over the network (desktop app over a
 * slow link, 27 Oct). Like pair.tsx's pairAttempts, this survives the remount.
 */
export interface SignInMemory<O> {
  /** Same object until something changes (for useSyncExternalStore). */
  get(serverId: string): SignInSnapshot<O>;
  subscribe(listener: () => void): () => void;
  setOptions(serverId: string, options: O | null): void;
  setStatus(serverId: string, status: SignInStatus | null): void;
  /** The session id of a sign-in still going (the screen polls it), else null. */
  pending(serverId: string): string | null;
  /** Leaving the step: next time starts afresh. */
  forget(serverId: string): void;
}

export interface SignInSnapshot<O> {
  options: O | null;
  status: SignInStatus | null;
}

const EMPTY: SignInSnapshot<never> = Object.freeze({ options: null, status: null });

export function pendingSessionId(status: SignInStatus | null): string | null {
  if (!status || status.state === "done" || status.state === "error") return null;
  return status.sessionId;
}

export function createSignInMemory<O>(): SignInMemory<O> {
  const byServer = new Map<string, SignInSnapshot<O>>();
  const listeners = new Set<() => void>();
  const put = (serverId: string, patch: Partial<SignInSnapshot<O>>) => {
    byServer.set(serverId, { ...(byServer.get(serverId) ?? EMPTY), ...patch });
    for (const l of listeners) l();
  };
  return {
    get: (serverId) => byServer.get(serverId) ?? EMPTY,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOptions: (serverId, options) => put(serverId, { options }),
    setStatus: (serverId, status) => put(serverId, { status }),
    pending: (serverId) => pendingSessionId(byServer.get(serverId)?.status ?? null),
    forget: (serverId) => {
      if (byServer.delete(serverId)) for (const l of listeners) l();
    },
  };
}

/**
 * Names for the signed-in providers on "Choose models": the host's own "Already signed in" labels
 * (signin.options `signedIn`, e.g. "ChatGPT (Codex)"), which the host builds from the same ready
 * providers in the same order. pi's provider ids when the two lists do not line up.
 */
export function providerLabels(providers: readonly string[], signedIn: readonly string[] | null) {
  if (!signedIn || signedIn.length !== providers.length || signedIn.some((l) => !l.trim())) {
    return [...providers];
  }
  return [...signedIn];
}
