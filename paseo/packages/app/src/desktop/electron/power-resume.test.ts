import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POWER_RESUME_RETRY_MS, startDesktopPowerResume } from "./power-resume";

let emit: ((payload: unknown) => void) | null = null;
const unlisten = vi.fn(() => {
  emit = null;
});
const listen = vi.fn(async <T>(_event: string, handler: (payload: T) => void) => {
  emit = handler as (payload: unknown) => void;
  return unlisten;
});

beforeEach(() => {
  vi.useFakeTimers();
  emit = null;
  unlisten.mockClear();
  listen.mockClear();
});
afterEach(() => vi.useRealTimers());

it("reconnects at once on wake, then again while Wi-Fi comes back", async () => {
  const onResume = vi.fn();
  const stop = startDesktopPowerResume({ onResume, listen });
  await vi.waitFor(() => expect(emit).not.toBeNull());
  expect(listen).toHaveBeenCalledWith("power-resume", expect.any(Function));

  emit?.({ reason: "resume" });
  expect(onResume).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(POWER_RESUME_RETRY_MS.at(-1) ?? 0);
  expect(onResume).toHaveBeenCalledTimes(1 + POWER_RESUME_RETRY_MS.length);

  // A second wake restarts the nudges instead of stacking them.
  emit?.({ reason: "unlock-screen" });
  emit?.({ reason: "resume" });
  vi.advanceTimersByTime(POWER_RESUME_RETRY_MS.at(-1) ?? 0);
  expect(onResume).toHaveBeenCalledTimes(
    1 + POWER_RESUME_RETRY_MS.length + 2 + POWER_RESUME_RETRY_MS.length,
  );

  stop();
  expect(unlisten).toHaveBeenCalled();
  emit?.({ reason: "resume" });
  vi.advanceTimersByTime(60_000);
  expect(onResume).toHaveBeenCalledTimes(3 + 2 * POWER_RESUME_RETRY_MS.length);
});

it("does nothing outside the desktop app", () => {
  const failing = vi.fn(async () => {
    throw new Error("Desktop event API is unavailable.");
  });
  const stop = startDesktopPowerResume({ onResume: vi.fn(), listen: failing });
  stop();
});
