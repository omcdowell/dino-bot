import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { satisfies } from "semver";
import {
  DAEMON_DISPLAY_VERSION,
  DAEMON_PRODUCT_NAME,
  getDaemonDisplayInfo,
} from "./display-version.js";
import { resolveDaemonVersion } from "./daemon-version.js";

const require = createRequire(import.meta.url);

describe("daemon display version", () => {
  test("matches the app's DinoBot version (packages/app/dinobot-version.js)", () => {
    const { DINOBOT_VERSION } = require("../../../app/dinobot-version.js") as {
      DINOBOT_VERSION: string;
    };
    expect(DAEMON_DISPLAY_VERSION).toBe(DINOBOT_VERSION);
    expect(getDaemonDisplayInfo()).toEqual({
      productName: "DinoBot",
      displayVersion: DINOBOT_VERSION,
    });
    expect(DAEMON_PRODUCT_NAME).toBe("DinoBot");
  });

  test("the engine version used for compatibility stays on the 0.11+ line", () => {
    const engine = resolveDaemonVersion();
    expect(engine).not.toBe(DAEMON_DISPLAY_VERSION);
    expect(satisfies(engine, ">=0.11.0", { includePrerelease: true })).toBe(true);
  });
});
