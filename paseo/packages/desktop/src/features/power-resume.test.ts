import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: {}, BrowserWindow: { getAllWindows: () => [] } }));

import { POWER_RESUME_EVENT, registerPowerResumeEvents } from "./power-resume";

function fakeWindow(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
}

describe("power resume", () => {
  it("tells every open window to reconnect when the Mac wakes or unlocks", () => {
    const power = new EventEmitter();
    const open = fakeWindow();
    const closed = fakeWindow(true);
    const dispose = registerPowerResumeEvents({
      powerMonitor: power,
      getAllWindows: () => [open, closed],
    });

    power.emit("resume");
    power.emit("unlock-screen");
    power.emit("suspend");

    expect(open.webContents.send.mock.calls).toEqual([
      [`paseo:event:${POWER_RESUME_EVENT}`, { reason: "resume" }],
      [`paseo:event:${POWER_RESUME_EVENT}`, { reason: "unlock-screen" }],
    ]);
    expect(closed.webContents.send).not.toHaveBeenCalled();

    dispose();
    power.emit("resume");
    expect(open.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("treats SIGUSR2 as a wake only when the test env var is set", () => {
    const power = new EventEmitter();
    const signals = new EventEmitter();
    const open = fakeWindow();
    registerPowerResumeEvents({
      powerMonitor: power,
      getAllWindows: () => [open],
      signals,
      env: {},
    });
    signals.emit("SIGUSR2");
    expect(open.webContents.send).not.toHaveBeenCalled();
    const dispose = registerPowerResumeEvents({
      powerMonitor: power,
      getAllWindows: () => [open],
      signals,
      env: { PASEO_DESKTOP_TEST_RESUME_SIGNAL: "1" },
    });
    signals.emit("SIGUSR2");
    expect(open.webContents.send).toHaveBeenCalledWith(`paseo:event:${POWER_RESUME_EVENT}`, {
      reason: "resume",
    });
    dispose();
    expect(signals.listenerCount("SIGUSR2")).toBe(0);
  });
});
