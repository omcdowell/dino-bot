import { listenToDesktopEvent } from "@/desktop/electron/events";

/** Sent by the desktop main process on powerMonitor `resume` / `unlock-screen`. */
const POWER_RESUME_EVENT = "power-resume";
/** Wi-Fi often rejoins a few seconds after the lid opens: nudge again in case the first try failed. */
export const POWER_RESUME_RETRY_MS = [5_000, 15_000] as const;

/**
 * After the Mac sleeps, reconnect now (and re-verify a socket that only looks open) instead of
 * waiting out the heartbeat or the reconnect backoff. No-op outside the desktop app.
 */
export function startDesktopPowerResume(input: {
  onResume: () => void;
  listen?: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
}): () => void {
  const listen = input.listen ?? listenToDesktopEvent;
  let stopped = false;
  let unlisten: (() => void) | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  const onWake = () => {
    clearTimers();
    input.onResume();
    timers = POWER_RESUME_RETRY_MS.map((delay) => setTimeout(input.onResume, delay));
  };
  listen(POWER_RESUME_EVENT, onWake).then(
    (remove) => {
      if (stopped) remove();
      else unlisten = remove;
      return undefined;
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    clearTimers();
    unlisten?.();
  };
}
