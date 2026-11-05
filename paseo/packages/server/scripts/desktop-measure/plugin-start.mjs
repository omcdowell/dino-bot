#!/usr/bin/env node
/**
 * Time from page start to plugin UI on the built desktop app (Mac), against the real host.
 *
 *   node plugin-start.mjs --app "<Paseo Ticks.app>" --profile <seed userData dir> \
 *     --label before --runs 5 [--clear-plugin-cache] [--port 8093] [--text "The Fat Controller"]
 *
 * Each run: copy the seed profile to a fresh userData (never the owner's), launch the app with its own
 * CDP port and no built-in daemon, install an in-page probe for the next document, reload, and
 * record (page performance.now(), ms): WebSocket created/open, every frame in/out (size), when the
 * probe texts appear, and the app's own `paseo:plugins:*` performance marks (new builds only).
 * Run 1 starts from the seed profile; later runs reuse the profile the previous run left
 * (so run 2+ is "warm": whatever the app cached in run 1 is there). --clear-plugin-cache removes
 * the plugin cache keys before every reload ("cold").
 * Output: one JSON line per run on stdout.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const appPath = arg("app");
const seed = arg("profile");
const label = arg("label", "run");
const runs = Number(arg("runs", "3"));
const port = Number(arg("port", "8093"));
const texts = (arg("text", "The Fat Controller") ?? "").split("|");
const chatText = arg("chat-text", "");
const clearPluginCache = flag("clear-plugin-cache");
const scratch = arg("scratch", path.join(process.env.HOME, "code/paseo-sim/plugin-cache/runs"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE = `(() => {
  if (window.__pm) return;
  const pm = (window.__pm = { sockets: [], frames: [], seen: {} });
  const Orig = window.WebSocket;
  function Probe(...args) {
    const ws = new Orig(...args);
    const id = pm.sockets.length;
    pm.sockets.push({ url: String(args[0]).replace(/[?#].*$/, ""), created: performance.now() });
    ws.addEventListener("open", () => (pm.sockets[id].open = performance.now()));
    ws.addEventListener("close", () => (pm.sockets[id].closed = performance.now()));
    ws.addEventListener("message", (event) => {
      const d = event.data;
      pm.frames.push([performance.now(), id, typeof d === "string" ? d.length : d.byteLength ?? d.size]);
    });
    const send = ws.send.bind(ws);
    ws.send = (d) => {
      pm.frames.push([performance.now(), id, -(typeof d === "string" ? d.length : d.byteLength ?? d.size ?? 0)]);
      return send(d);
    };
    return ws;
  }
  Probe.prototype = Orig.prototype;
  Object.assign(Probe, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Probe;
  const targets = ${JSON.stringify(Object.fromEntries([...texts.map((t) => [t, t]), ...(chatText ? [["chat", chatText]] : [])]))};
  const check = () => {
    const text = document.body ? document.body.textContent || "" : "";
    for (const [key, want] of Object.entries(targets)) {
      if (pm.seen[key] === undefined && text.includes(want)) pm.seen[key] = performance.now();
    }
    const items = document.querySelectorAll('[data-testid^="plugin-sidebar-"]').length;
    if (items > 0 && pm.seen.pluginItem === undefined) pm.seen.pluginItem = performance.now();
    if (items >= 5 && pm.seen.pluginRows === undefined) pm.seen.pluginRows = performance.now();
  };
  setInterval(check, 10);
})();`;

async function cdpConnect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP connect failed")));
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

async function pageTarget() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("no CDP page target");
}

const userData = mkdtempSync(path.join(scratch, `${label}-`));
cpSync(seed, userData, { recursive: true });
for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  rmSync(path.join(userData, name), { force: true });
}
writeFileSync(
  path.join(userData, "desktop-settings.json"),
  JSON.stringify({
    version: 1,
    settings: {
      releaseChannel: "stable",
      daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false },
    },
    migrations: { legacyRendererSettingsImported: true, daemonStopOnQuitDefaultApplied: true },
  }),
);

for (let run = 1; run <= runs; run += 1) {
  const app = spawn(
    path.join(appPath, "Contents/MacOS/Paseo"),
    [`--remote-debugging-port=${port}`],
    {
      env: { ...process.env, PASEO_ELECTRON_USER_DATA_DIR: userData },
      stdio: "ignore",
    },
  );
  let cdp;
  try {
    cdp = await cdpConnect(await pageTarget());
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    // Let the first load settle (it is not measured), so the measured load is the app's start.
    await sleep(4000);
    if (clearPluginCache) {
      await cdp.evaluate(
        `(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("paseo:plugin-")) localStorage.removeItem(k); })()`,
      );
    }
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    await cdp.send("Page.reload", { ignoreCache: false });
    const start = Date.now();
    let result = null;
    while (Date.now() - start < 30_000) {
      await sleep(250);
      try {
        result = await cdp.evaluate(`(() => {
          const pm = window.__pm;
          if (!pm) return null;
          const marks = performance.getEntriesByType("mark")
            .filter((m) => m.name.startsWith("paseo:"))
            .map((m) => [m.name, Math.round(m.startTime)]);
          const nav = performance.getEntriesByType("navigation")[0];
          return { ...pm, marks, domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null };
        })()`);
      } catch {}
      if (result && result.seen.pluginRows !== undefined && Date.now() - start > 6000) break;
    }
    const keys = await cdp.evaluate(
      `Object.keys(localStorage).filter((k) => k.startsWith("paseo:plugin-")).map((k) => [k, localStorage.getItem(k).length])`,
    );
    const sidebar = await cdp.evaluate(`(document.body.innerText || "").slice(0, 600)`);
    process.stdout.write(
      `${JSON.stringify({ label, run, clearPluginCache, result, pluginCacheKeys: keys, sidebar })}\n`,
    );
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ label, run, error: String(error) })}\n`);
  } finally {
    cdp?.close();
    app.kill("SIGTERM");
    await sleep(2500);
    if (app.exitCode === null) app.kill("SIGKILL");
    await sleep(500);
  }
}
if (!flag("keep")) rmSync(userData, { recursive: true, force: true });
