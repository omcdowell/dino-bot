import { BrowserWindow, powerMonitor } from "electron";

/**
 * Lid open / screen unlock: the socket to the daemon died while the Mac slept, and the renderer
 * would only notice at its next heartbeat or reconnect backoff. Tell it at once so it reconnects
 * and the open chat catches up first (preload exposes this through `events.on`).
 */
export const POWER_RESUME_EVENT = "power-resume";

const RESUME_SIGNALS = ["resume", "unlock-screen"] as const;

interface PowerSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

interface ResumeTarget {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

/** Test-only: `kill -USR2 <pid>` stands in for a wake when this env var is 1 (measurements). */
const TEST_SIGNAL_ENV = "PASEO_DESKTOP_TEST_RESUME_SIGNAL";

export function registerPowerResumeEvents(
  deps: {
    powerMonitor: PowerSource;
    getAllWindows: () => ResumeTarget[];
    signals?: PowerSource;
    env?: NodeJS.ProcessEnv;
  } = {
    powerMonitor,
    getAllWindows: () => BrowserWindow.getAllWindows(),
  },
): () => void {
  const notify = (reason: string) => {
    for (const win of deps.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(`paseo:event:${POWER_RESUME_EVENT}`, { reason });
    }
  };
  const listeners = RESUME_SIGNALS.map((reason) => {
    const listener = () => notify(reason);
    deps.powerMonitor.on(reason, listener);
    return { source: deps.powerMonitor, event: reason as string, listener };
  });
  const signals = deps.signals ?? process;
  if ((deps.env ?? process.env)[TEST_SIGNAL_ENV] === "1") {
    const listener = () => notify("resume");
    signals.on("SIGUSR2", listener);
    listeners.push({ source: signals, event: "SIGUSR2", listener });
  }
  return () => {
    for (const { source, event, listener } of listeners) source.off(event, listener);
  };
}
