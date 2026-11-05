import { expect, test } from "vitest";
import {
  INITIAL_LINK_QUALITY,
  LINK_EXIT_HOLD_MS,
  nextLinkQuality,
  readBrowserConnection,
  type LinkQualityInput,
} from "./link-quality";

const base = (now: number, rtts: Array<number | null>): LinkQualityInput => ({
  now,
  rttSamples: rtts.map((rttMs, index) => ({ at: now - (rtts.length - index) * 5_000, rttMs })),
  cellularGeneration: null,
  disconnects: [],
});

test("a fast link stays normal", () => {
  expect(nextLinkQuality(INITIAL_LINK_QUALITY, base(1_000_000, [40, 60, 50]))).toBe(
    INITIAL_LINK_QUALITY,
  );
});

test("slow round trips, 3G and repeated drops each enter constrained mode", () => {
  expect(nextLinkQuality(INITIAL_LINK_QUALITY, base(1e6, [900, 1200, 1000])).mode).toBe(
    "constrained",
  );
  expect(
    nextLinkQuality(INITIAL_LINK_QUALITY, { ...base(1e6, [50]), cellularGeneration: "3g" }).mode,
  ).toBe("constrained");
  expect(
    nextLinkQuality(INITIAL_LINK_QUALITY, {
      ...base(1e6, [50]),
      disconnects: [1e6 - 60_000, 1e6 - 5_000],
    }).mode,
  ).toBe("constrained");
  expect(nextLinkQuality(INITIAL_LINK_QUALITY, base(1e6, [50, null, null])).mode).toBe(
    "constrained",
  );
});

test("constrained mode lasts until the link has been good for the hold time", () => {
  let state = nextLinkQuality(INITIAL_LINK_QUALITY, base(1e6, [1000, 1000, 1000]));
  // 600 ms is below the enter threshold but above the exit threshold: still constrained.
  state = nextLinkQuality(state, base(1e6 + 10_000, [600, 600, 600]));
  expect(state).toMatchObject({ mode: "constrained", goodSince: null });
  state = nextLinkQuality(state, base(1e6 + 20_000, [100, 100, 100]));
  expect(state.mode).toBe("constrained");
  state = nextLinkQuality(state, base(1e6 + 20_000 + LINK_EXIT_HOLD_MS - 1, [100, 100, 100]));
  expect(state.mode).toBe("constrained");
  state = nextLinkQuality(state, base(1e6 + 20_000 + LINK_EXIT_HOLD_MS, [100, 100, 100]));
  expect(state).toBe(INITIAL_LINK_QUALITY);
});

test("a relapse during the hold resets it", () => {
  let state = nextLinkQuality(INITIAL_LINK_QUALITY, base(1e6, [1000, 1000, 1000]));
  state = nextLinkQuality(state, base(1e6 + 1_000, [100, 100, 100]));
  expect(state.goodSince).toBe(1e6 + 1_000);
  state = nextLinkQuality(state, base(1e6 + 2_000, [900, 900, 900]));
  expect(state.goodSince).toBeNull();
});

test("Chromium's effective connection type and Save-Data count as a slow link", () => {
  for (const effectiveType of ["slow-2g", "2g", "3g"]) {
    expect(
      nextLinkQuality(INITIAL_LINK_QUALITY, {
        ...base(1e6, [50]),
        browserConnection: { effectiveType, saveData: false },
      }),
    ).toMatchObject({ mode: "constrained", reason: `connection ${effectiveType}` });
  }
  expect(
    nextLinkQuality(INITIAL_LINK_QUALITY, {
      ...base(1e6, [50]),
      browserConnection: { effectiveType: "4g", saveData: true },
    }),
  ).toMatchObject({ mode: "constrained", reason: "save data" });
  expect(
    nextLinkQuality(INITIAL_LINK_QUALITY, {
      ...base(1e6, [50]),
      browserConnection: { effectiveType: "4g", saveData: false },
    }),
  ).toBe(INITIAL_LINK_QUALITY);
});

test("a network marked as metered stays constrained however fast it is", () => {
  let state = nextLinkQuality(INITIAL_LINK_QUALITY, { ...base(1e6, [20]), metered: true });
  expect(state).toMatchObject({ mode: "constrained", reason: "metered network" });
  state = nextLinkQuality(state, {
    ...base(1e6 + LINK_EXIT_HOLD_MS * 2, [20]),
    metered: true,
  });
  expect(state.mode).toBe("constrained");
  // Turning the setting off hands back to the measured link (with the usual exit hold).
  state = nextLinkQuality(state, base(1e6 + LINK_EXIT_HOLD_MS * 3, [20]));
  state = nextLinkQuality(state, base(1e6 + LINK_EXIT_HOLD_MS * 4, [20]));
  expect(state).toBe(INITIAL_LINK_QUALITY);
});

test("reads navigator.connection when the platform has one", () => {
  expect(readBrowserConnection({ connection: { effectiveType: "3g", saveData: true } })).toEqual({
    effectiveType: "3g",
    saveData: true,
  });
  expect(readBrowserConnection({})).toBeNull();
  expect(readBrowserConnection(undefined)).toBeNull();
});
