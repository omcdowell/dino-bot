/**
 * POST /live-activity on the paseo-apns add-on's local endpoint (a separate plugin; HTTP only,
 * nothing imported from it). URL and bearer as for bot-dm's pushes (apns-push.ts `endpoint`).
 */
import { endpoint } from "./apns-push";
import type { BusyBot } from "./live-activity";

export interface LiveActivityPort {
  /** True when the add-on took the set. Never throws. */
  post(bots: BusyBot[]): Promise<boolean>;
}

export function postLiveActivity(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): LiveActivityPort {
  let warned = false;
  const warnOnce = (why: string) => {
    if (warned) return;
    warned = true;
    console.warn(`[bots] live activity: ${why}`);
  };
  return {
    async post(bots) {
      const at = endpoint(env);
      if ("error" in at) {
        warnOnce(at.error);
        return false;
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${at.url}/live-activity`, {
          method: "POST",
          headers: { authorization: `Bearer ${at.token}`, "content-type": "application/json" },
          body: JSON.stringify({ sender: "bots", bots }),
          signal: abort.signal,
        });
        if (!res.ok) warnOnce(`paseo-apns answered HTTP ${res.status}`);
        else warned = false;
        return res.ok;
      } catch (error) {
        warnOnce(`paseo-apns not reachable (${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name})`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
