import { defineConfig, devices } from "@playwright/test";

// E2E_METRO_PORT is set dynamically by global-setup.ts after finding a free port
// This allows multiple test runs in parallel across different worktrees
const baseURL =
  process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_METRO_PORT ?? "8081"}`;
const relayDeploymentSpec = "**/relay-deployment-reconnect.real.spec.ts";

function videoMode(): "on" | "on-first-retry" | "retain-on-failure" {
  if (process.env.E2E_RECORD_VIDEO === "1") return "on";
  if (process.env.CI) return "on-first-retry";
  return "retain-on-failure";
}

// E2E_CHROMIUM_PATH points at another Chromium build on hosts where Playwright cannot install its
// pinned browser (Ubuntu 26.04). E2E_CHROMIUM_ARGS adds space-separated flags (low-memory hosts).
const chromiumPath = process.env.E2E_CHROMIUM_PATH?.trim();
const chromiumArgs = (process.env.E2E_CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean);
const launchOptions =
  chromiumPath || chromiumArgs.length > 0
    ? { ...(chromiumPath ? { executablePath: chromiumPath } : {}), args: chromiumArgs }
    : undefined;

export default defineConfig({
  testDir: "./e2e/browser",
  globalSetup: "./e2e/support/global-setup.ts",
  // The generated 13 MB zod-aot validator is plain ESM. Babel-transforming it costs the
  // Playwright worker ~2 GB, so Node loads it as is.
  build: { external: ["**/generated/validation/*.aot.js"] },
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // Files run concurrently, while each worker owns its daemon state. Keeping a
  // spec on one worker avoids repeating its file-level setup across daemons.
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? (process.env.CI ? "2" : "1")),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: videoMode(),
    ...(launchOptions ? { launchOptions } : {}),
  },
  projects: [
    {
      name: "browser",
      testIgnore: ["**/*.real.spec.ts"],
      use: { ...devices["Desktop Chrome"], ...(launchOptions ? { launchOptions } : {}) },
    },
    {
      name: "real-provider",
      testMatch: ["**/*.real.spec.ts"],
      testIgnore: [relayDeploymentSpec],
      use: { ...devices["Desktop Chrome"], ...(launchOptions ? { launchOptions } : {}) },
    },
    {
      name: "relay-deployment",
      testMatch: [relayDeploymentSpec],
      use: { ...devices["Desktop Chrome"], ...(launchOptions ? { launchOptions } : {}) },
    },
  ],
  // Note: Metro is started by global-setup.ts on a dynamic port to allow parallel test runs
});
