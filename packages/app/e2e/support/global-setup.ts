import { warmMetro } from "./metro-warmup.mjs";
export { warmMetro } from "./metro-warmup.mjs";
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "./helpers/spawn-node";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import dotenv from "dotenv";

export interface WaitForServerOptions {
  host?: string;
  timeoutMs?: number;
  label: string;
  childProcess?: ChildProcess | null;
  getRecentOutput?: () => string;
}

type ServerProbe = (host: string, port: number) => Promise<void>;

const RESERVED_LOCAL_PORTS = new Set([
  6767, // Installed daemon.
  6768, // Developer daemon.
  61680, // OpenCode's default local server.
]);

function createLineBuffer(maxLines = 120): { add: (line: string) => void; dump: () => string } {
  const lines: string[] = [];
  return {
    add(line) {
      lines.push(line);
      if (lines.length > maxLines) lines.shift();
    },
    dump: () => lines.join("\n"),
  };
}

function formatRecentOutput(getRecentOutput?: () => string): string {
  const output = getRecentOutput?.().trim();
  return output ? `\nRecent output:\n${output}` : "";
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function getAvailableE2EPort(): Promise<number> {
  for (;;) {
    const port = await getAvailablePort();
    if (!RESERVED_LOCAL_PORTS.has(port)) return port;
  }
}

async function connectToServer(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      socket.end();
      resolve();
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error(`Connection timed out to ${host}:${port}`));
    });
    socket.on("error", reject);
  });
}

async function waitForServer(
  port: number,
  options: WaitForServerOptions,
  probe: ServerProbe = connectToServer,
): Promise<void> {
  const { host = "127.0.0.1", timeoutMs = 15_000, label, childProcess, getRecentOutput } = options;
  const deadline = Date.now() + timeoutMs;
  let lastConnectionError: unknown = null;

  while (Date.now() < deadline) {
    if (childProcess?.exitCode !== null && childProcess?.exitCode !== undefined) {
      const signal = childProcess.signalCode ? `, signal ${childProcess.signalCode}` : "";
      throw new Error(
        `${label} exited before listening on ${host}:${port} (exit code ${childProcess.exitCode}${signal}).${formatRecentOutput(getRecentOutput)}`,
      );
    }
    try {
      await probe(host, port);
      return;
    } catch (error) {
      lastConnectionError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const reason =
    lastConnectionError instanceof Error
      ? ` Last connection error: ${lastConnectionError.message}`
      : "";
  throw new Error(
    `${label} did not start on ${host}:${port} within ${timeoutMs}ms.${reason}${formatRecentOutput(getRecentOutput)}`,
  );
}

async function probeMetro(host: string, port: number): Promise<void> {
  const response = await fetch(`http://${host}:${port}/status`, {
    signal: AbortSignal.timeout(1_000),
  });
  const body = (await response.text()).trim();
  if (response.status !== 200 || body !== "packager-status:running") {
    throw new Error(
      `Expected Metro status on ${host}:${port}, received HTTP ${response.status}: ${JSON.stringify(body.slice(0, 200))}`,
    );
  }
}

export async function waitForMetro(port: number, options: WaitForServerOptions): Promise<void> {
  await waitForServer(port, options, probeMetro);
}

function startMetro(port: number, buffer: ReturnType<typeof createLineBuffer>): ChildProcess {
  const appDir = path.resolve(__dirname, "../..");
  const expoCli = require.resolve("expo/bin/cli");
  // Spawns Node directly to bypass Windows .cmd shim execution restrictions without shell: true.
  // E2E_METRO_MAX_WORKERS caps Metro's transform workers on hosts short of memory.
  const maxWorkers = process.env.E2E_METRO_MAX_WORKERS;
  const args = [expoCli, "start", "--web", "--port", String(port)];
  if (maxWorkers) args.push("--max-workers", maxWorkers);
  const child = spawn(process.execPath, args, {
    cwd: appDir,
    env: {
      ...process.env,
      BROWSER: "none",
      ...(process.env.E2E_DESKTOP_RUNTIME === "1" ? { PASEO_WEB_PLATFORM: "electron" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const log = (chunk: Buffer, stream: "stdout" | "stderr") => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      buffer.add(`[${stream}] ${line}`);
      console[stream === "stdout" ? "log" : "error"](`[metro] ${line}`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => log(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => log(chunk, "stderr"));
  return child;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// E2E_WEB_DIST serves a prebuilt `expo export --platform web` directory instead of starting
// Metro. Bundling the app takes ~3 GB cold; serving the export takes almost nothing, so
// hosts short of memory build once (in its own capped job) and test against the files.
async function startStaticWebServer(distDir: string, port: number): Promise<http.Server> {
  const root = path.resolve(distDir);
  const indexHtml = path.join(root, "index.html");
  if (!existsSync(indexHtml)) throw new Error(`E2E_WEB_DIST has no index.html: ${root}`);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/status") {
      response.end("packager-status:running");
      return;
    }
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root)) filePath = indexHtml;
    const info = await stat(filePath).catch(() => null);
    // Single-page app: unknown routes get index.html, like Metro's web dev server.
    if (!info?.isFile()) filePath = indexHtml;
    response.writeHead(200, {
      "content-type":
        STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function loadHarnessEnvironment(repoRoot: string): Promise<void> {
  const envTestPath = path.join(repoRoot, ".env.test");
  if (existsSync(envTestPath)) dotenv.config({ path: envTestPath });
}

export default async function globalSetup() {
  if (process.env.PASEO_REPLICA_CACHE_MEASUREMENT === "1") {
    if (!process.env.PASEO_REPLICA_CACHE_MEASUREMENT_URL) {
      throw new Error("PASEO_REPLICA_CACHE_MEASUREMENT_URL must be set for live measurement");
    }
    return;
  }
  const repoRoot = path.resolve(__dirname, "../../../..");
  await loadHarnessEnvironment(repoRoot);

  const metroPort = await getAvailableE2EPort();
  const webDist = process.env.E2E_WEB_DIST?.trim();
  if (webDist) {
    const server = await startStaticWebServer(webDist, metroPort);
    process.env.E2E_METRO_PORT = String(metroPort);
    console.log(`[e2e] Serving prebuilt web export ${webDist} on port ${metroPort} (no Metro)`);
    return async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  }
  const metroOutput = createLineBuffer();
  let metroProcess: ChildProcess | null = null;

  try {
    metroProcess = startMetro(metroPort, metroOutput);
    await waitForMetro(metroPort, {
      label: "Metro web server",
      timeoutMs: 120_000,
      childProcess: metroProcess,
      getRecentOutput: metroOutput.dump,
    });
    await warmMetro(metroPort);
    process.env.E2E_METRO_PORT = String(metroPort);
    console.log(`[e2e] Metro warmed on port ${metroPort}`);

    return async () => {
      await killProcessTree(metroProcess);
      console.log("[e2e] Metro stopped");
    };
  } catch (error) {
    await killProcessTree(metroProcess);
    throw error;
  }
}
