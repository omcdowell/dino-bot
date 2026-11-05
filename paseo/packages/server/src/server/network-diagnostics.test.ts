import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import {
  parseProviderStatus,
  PROVIDER_STATUS_URL,
  resolveProviderEndpoint,
  runProviderTest,
  runSpeedTest,
} from "./network-diagnostics.js";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

test("speed test returns the bytes asked for and checks the upload size", () => {
  const down = runSpeedTest({ requestId: "r", direction: "down", bytes: 3000 });
  expect(Buffer.from(down.payload ?? "", "base64").byteLength).toBe(3000);
  const payload = Buffer.alloc(1200, 7).toString("base64");
  expect(runSpeedTest({ requestId: "r", direction: "up", bytes: 1200, payload }).error).toBeNull();
  expect(runSpeedTest({ requestId: "r", direction: "up", bytes: 99, payload }).error).toMatch(
    /expected 99/,
  );
});

test("the provider endpoint follows ANTHROPIC_BASE_URL", () => {
  expect(resolveProviderEndpoint({})).toEqual({
    url: "https://api.anthropic.com/",
    viaBaseUrl: false,
  });
  expect(resolveProviderEndpoint({ ANTHROPIC_BASE_URL: "http://100.64.0.10:5050/team" })).toEqual({
    url: "http://100.64.0.10:5050/team",
    viaBaseUrl: true,
  });
});

test("the status page summary keeps the indicator, the Claude components and open incidents", () => {
  const status = parseProviderStatus({
    status: { indicator: "minor", description: "Partially Degraded Service" },
    components: [
      { name: "claude.ai", status: "operational" },
      { name: "Console (console.anthropic.com)", status: "degraded_performance" },
      { name: "Claude API (api.anthropic.com)", status: "operational" },
      { name: "Claude Code", status: "operational" },
    ],
    incidents: [
      {
        name: "Elevated errors",
        status: "investigating",
        impact: "minor",
        updated_at: "2026-10-08T10:00:00Z",
        incident_updates: [{ body: "We are looking into it." }],
      },
    ],
  });
  expect(status.indicator).toBe("minor");
  expect(status.components.map((component) => component.name)).toEqual([
    "claude.ai",
    "Claude API (api.anthropic.com)",
    "Claude Code",
  ]);
  expect(status.incidents[0]).toMatchObject({
    name: "Elevated errors",
    latestUpdate: "We are looking into it.",
  });
});

test("the provider test times each step to a plain HTTP proxy, makes no model call, and reports status", async () => {
  const methods: string[] = [];
  server = createServer((request, response) => {
    methods.push(`${request.method} ${request.url}`);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const realFetch = fetch;
  const result = await runProviderTest(
    { requestId: "r" },
    {
      env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/team` },
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        String(url) === PROVIDER_STATUS_URL
          ? Promise.resolve(
              new Response(JSON.stringify({ status: { indicator: "none", description: "OK" } })),
            )
          : realFetch(url, init)) as typeof fetch,
      lastProviderError: () => null,
    },
  );
  expect(result.error).toBeNull();
  expect(result.viaBaseUrl).toBe(true);
  expect(result.tcpMs).not.toBeNull();
  expect(result.tlsMs).toBeNull();
  expect(result.httpStatus).toBe(404);
  expect(methods).toEqual(["HEAD /team"]);
  expect(result.status?.indicator).toBe("none");
});

test("an unreachable provider and status page are reported, not thrown", async () => {
  const result = await runProviderTest(
    { requestId: "r" },
    {
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/" },
      fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    },
  );
  expect(result.error).toMatch(/ECONNREFUSED|connect/);
  expect(result.statusError).toBe("offline");
});
