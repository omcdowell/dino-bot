// Is the daemon ready for the app, not just listening?
//
// The daemon opens its HTTP port first and only starts accepting WebSocket clients after the
// plugins have loaded (bootstrap: wsServer.beginAcceptingConnections()). Until then every
// WebSocket upgrade gets "503 Server not ready", which the app and CLI report as
// DAEMON_UNREACHABLE. That was the first-connect failure within ~1 s of setup (rel-installer).
// So the wizard shows the QR only after an upgrade request gets an answer other than 503.
import net from "node:net";
import { randomBytes } from "node:crypto";

/**
 * One probe: a WebSocket upgrade request to /ws. Resolves the HTTP status (101 = accepted,
 * 401/403 = up but refused us, 503 = still starting) or 0 when nothing answered.
 */
export function probeWs({ host = "127.0.0.1", port, password, hostHeader, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(code);
    };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => finish(0));
    sock.once("error", () => finish(0));
    sock.once("connect", () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: ${hostHeader ?? `${host.includes(":") ? `[${host}]` : host}:${port}`}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...(password ? [`Authorization: Bearer ${password}`] : []),
        "",
        "",
      ];
      sock.write(lines.join("\r\n"));
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (m) finish(Number(m[1]));
    });
    sock.once("end", () => finish(0));
  });
}

/** Ready = something answered and it was not "503 Server not ready". */
export const isReadyStatus = (code) => code > 0 && code !== 503;

/**
 * Waits until the daemon accepts WebSocket clients. Backoff 100 ms -> 1 s.
 * Returns {ready, ms, probes, lastStatus}.
 */
export async function waitForReady({ port, host = "127.0.0.1", password, timeoutMs = 90_000, probe = probeWs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const t0 = Date.now();
  let delay = 100;
  let probes = 0;
  let lastStatus = 0;
  for (;;) {
    probes++;
    lastStatus = await probe({ host, port, password });
    if (isReadyStatus(lastStatus)) return { ready: true, ms: Date.now() - t0, probes, lastStatus };
    if (Date.now() - t0 >= timeoutMs) return { ready: false, ms: Date.now() - t0, probes, lastStatus };
    await sleep(delay);
    delay = Math.min(1000, Math.round(delay * 1.5));
  }
}

/**
 * Stronger check: a real request round trip through the daemon's own client (`paseo daemon status`
 * with the password), retried until it answers. On a cold macOS install the daemon accepted the
 * WebSocket but answered its first request after more than 1.5 s for up to ~30 s (XProtect scanning
 * the new binaries is the likely cause), so the QR waits for this too.
 * PASEO_HOME is ours, so the CLI never writes into a user's ~/.paseo.
 */
export async function waitForAnswers({ paseoBin, endpoint, password, paseoHome, home, timeoutMs = 60_000, runCmd }) {
  const { run } = await import("./util.mjs");
  const exec = runCmd ?? run;
  const t0 = Date.now();
  let tries = 0;
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    tries++;
    const r = await exec(paseoBin, ["daemon", "status", "--host", endpoint, "--json"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", PASEO_HOME: paseoHome, PASEO_PASSWORD: password },
      timeout: 20_000,
    });
    if (r.code === 0) return { ok: true, ms: Date.now() - t0, tries };
    last = (r.stdout || r.stderr).replace(/\s+/g, " ").slice(0, 160);
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false, ms: Date.now() - t0, tries, last };
}
