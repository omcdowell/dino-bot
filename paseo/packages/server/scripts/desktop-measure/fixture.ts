/**
 * Throttled fixture for the desktop app (laptop on a phone hotspot), Mac only.
 *
 *   npx tsx scripts/desktop-measure/fixture.ts --app <Paseo.app> < commands.txt
 *
 * An in-process throwaway daemon (mock provider, model e2e-tool-heavy) serves 8 keep-live bot
 * chats and one plain chat. ThrottledProxy listens on 127.0.0.1:6778 in front of it. The built
 * desktop app runs with its own temp profile (never the owner's), no built-in daemon, CDP on 8091,
 * and PASEO_DESKTOP_TEST_RESUME_SIGNAL=1 so `resume` can stand in for a wake.
 * Commands are read line by line from stdin; results are printed as JSON lines.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { MockLoadTestAgentClient } from "../../src/server/agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../../src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../src/server/test-utils/paseo-daemon.js";
import { ThrottledProxy, type LinkProfile } from "../../src/server/test-utils/throttled-proxy.js";
import { connectCdp, waitForPageTarget, type Cdp } from "./cdp.js";

const PROXY_PORT = 6778;
const CDP_PORT = 8091;
const PROFILES: Record<string, LinkProfile> = {
  lan: {},
  "64k": { bitsPerSecond: 64_000, rttMs: 300, jitterMs: 50 },
  "32k": { bitsPerSecond: 32_000, rttMs: 1000, jitterMs: 100 },
};

const args = process.argv.slice(2);
const appPath = args[args.indexOf("--app") + 1];
const agentCount = 8;

function out(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ t: new Date().toISOString().slice(11, 23), event, ...data })}\n`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  } as Parameters<typeof createTestPaseoDaemon>[0]);
  const serverId = readFileSync(path.join(daemon.paseoHome, "server-id"), "utf8").trim();
  const driver = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await driver.connect();
  const chats: Array<{ id: string; title: string }> = [];
  for (let index = 0; index <= agentCount; index += 1) {
    const plain = index === agentCount;
    const title = plain ? "Plain chat" : `Bot ${index}`;
    const cwd = path.join(daemon.staticDir, plain ? "plain" : `bot-${index}`);
    mkdirSync(cwd, { recursive: true });
    const agent = await driver.createAgent({
      provider: "mock",
      model: "e2e-tool-heavy",
      cwd,
      title,
      labels: plain ? {} : { "paseo.keep-live": "1" },
    });
    chats.push({ id: agent.id, title });
  }
  const runTurns = async (tag: string, wait: boolean) => {
    await Promise.all(
      chats.map((chat) => driver.sendAgentMessage(chat.id, `${tag} ${chat.title}`, {})),
    );
    if (wait) await Promise.all(chats.map((chat) => driver.waitForFinish(chat.id, 180_000)));
  };
  for (let turn = 0; turn < 2; turn += 1) await runTurns(`seed${turn}`, true);
  out("daemon", { serverId, port: daemon.port, chats: chats.length });

  const proxy = new ThrottledProxy({ host: "127.0.0.1", port: daemon.port }, PROFILES.lan, {
    seed: 7,
  });
  await proxy.listen(PROXY_PORT);

  let app: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  const userData = mkdtempSync(path.join(tmpdir(), "paseo-desktop-measure-"));
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
  const launch = async () => {
    app = spawn(
      path.join(appPath, "Contents/MacOS/Paseo"),
      [`--remote-debugging-port=${CDP_PORT}`],
      {
        env: {
          ...process.env,
          PASEO_ELECTRON_USER_DATA_DIR: userData,
          PASEO_DESKTOP_TEST_RESUME_SIGNAL: "1",
        },
        stdio: "ignore",
      },
    );
    cdp = await connectCdp(await waitForPageTarget(CDP_PORT));
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    out("app", { pid: app.pid });
  };
  const needCdp = (): Cdp => {
    if (!cdp) throw new Error("app not launched");
    return cdp;
  };
  const bodyText = () => needCdp().evaluate<string>("document.body.innerText");
  const waitText = async (text: string, timeoutMs: number) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ((await bodyText()).includes(text)) return Date.now() - start;
      await sleep(50);
    }
    return null;
  };
  const findText = (text: string) =>
    needCdp().evaluate<{ x: number; y: number } | null>(`(() => {
      const want = ${JSON.stringify(text)};
      const all = Array.from(document.querySelectorAll("body *"));
      const hits = all.filter((el) => el.childElementCount === 0 && el.textContent?.trim() === want);
      // The last visible match: a sidebar workspace row comes after its project header.
      for (const el of hits.reverse()) {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    })()`);
  // The sidebar is virtualised: a row far from the scroll position is not in the DOM.
  const scrollAll = (to: "top" | "bottom") =>
    needCdp().evaluate(`(() => {
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (el.scrollHeight > el.clientHeight + 10) el.scrollTop = ${to === "top" ? 0 : "el.scrollHeight"};
      }
    })()`);
  const locate = async (text: string) => {
    let rect = await findText(text);
    for (const to of ["top", "bottom"] as const) {
      if (rect) break;
      await scrollAll(to);
      await sleep(400);
      rect = await findText(text);
    }
    if (!rect) throw new Error(`no element with text ${text}`);
    await sleep(100);
    return (await findText(text)) ?? rect;
  };
  const clickText = async (text: string) => {
    const rect = await locate(text);
    await needCdp().clickAt(rect.x, rect.y);
  };
  const takeBytes = () => {
    const totals = { ...proxy.totals };
    proxy.resetCounters();
    return totals;
  };

  // oxlint-disable-next-line complexity -- one flat command switch for the measuring script
  const handle = async (line: string) => {
    const [command, ...rest] = line.trim().split(" ");
    const arg = rest.join(" ");
    switch (command) {
      case "":
      case "#":
        return;
      case "launch":
        return launch();
      case "seedHost": {
        const registry = [
          {
            serverId,
            label: "Fixture",
            connections: [{ type: "directTcp", endpoint: `localhost:${PROXY_PORT}` }],
          },
        ];
        await needCdp().evaluate(
          `localStorage.setItem("@paseo:daemon-registry", ${JSON.stringify(JSON.stringify(registry))})`,
        );
        await needCdp().send("Page.reload");
        return out("seedHost");
      }
      case "profile":
        proxy.setProfile(PROFILES[arg]!);
        return out("profile", { profile: arg });
      case "sleep":
        await sleep(Number(arg) * 1000);
        return;
      case "turns":
        await runTurns(arg, true);
        return out("turns", { tag: arg });
      case "turnsAsync":
        void runTurns(arg, true).then(() => out("turnsDone", { tag: arg }));
        return;
      case "blackhole":
        proxy.blackhole();
        return out("blackhole");
      case "restore":
        proxy.restore();
        return out("restore");
      case "dropall":
        proxy.dropAll();
        return out("dropall");
      // Laptop asleep: renderer JS stops (debugger pause), old sockets die silently on wake.
      case "freeze":
        await needCdp().send("Debugger.enable");
        await needCdp().send("Debugger.pause");
        return out("freeze");
      case "thaw":
        await needCdp().send("Debugger.resume");
        await needCdp().send("Debugger.disable");
        return out("thaw");
      case "strand":
        proxy.strandAll();
        return out("strand");
      case "resume":
        app?.kill("SIGUSR2");
        return out("resume");
      case "bytes":
        return out("bytes", takeBytes());
      case "shot": {
        writeFileSync(arg, await needCdp().screenshot());
        return out("shot", { file: arg });
      }
      case "eval":
        return out("eval", { value: await needCdp().evaluate(arg) });
      case "text":
        return out("text", { value: (await bodyText()).slice(0, 4000) });
      case "click":
        await clickText(arg);
        return out("click", { text: arg });
      case "waitText": {
        const [timeout, ...words] = rest;
        const visibility = await needCdp().evaluate<string>("document.visibilityState");
        return out("waitText", {
          text: words.join(" "),
          ms: await waitText(words.join(" "), Number(timeout)),
          visibility,
        });
      }
      // Open a chat from the sidebar and time until its newest prompt is on screen.
      // `open <sidebar label> <text>`: click the chat in the sidebar, time until <text> shows.
      case "open": {
        const [label, ...words] = rest;
        const text = words.join(" ");
        const rect = await locate(label!);
        takeBytes();
        const start = Date.now();
        await needCdp().clickAt(rect.x, rect.y);
        const ms = await waitText(text, 120_000);
        const elapsed = Date.now() - start;
        await sleep(1000);
        const visibility = await needCdp().evaluate<string>("document.visibilityState");
        return out("open", {
          label,
          text,
          ms: ms === null ? null : elapsed,
          ...takeBytes(),
          visibility,
        });
      }
      // `wsLog <seconds> <command...>`: run a command and summarise the WebSocket frames it caused.
      case "wsLog": {
        const [seconds, ...inner] = rest;
        const frames: Array<{ dir: string; bytes: number; head: string }> = [];
        await needCdp().send("Network.enable");
        const stop = needCdp().onEvent((method, params) => {
          if (
            method !== "Network.webSocketFrameReceived" &&
            method !== "Network.webSocketFrameSent"
          )
            return;
          const payload = String((params.response as { payloadData?: string })?.payloadData ?? "");
          frames.push({
            dir: method.endsWith("Sent") ? "up" : "down",
            bytes: payload.length,
            head: payload.slice(0, 160),
          });
        });
        await handle(inner.join(" "));
        await sleep(Number(seconds) * 1000);
        stop();
        await needCdp().send("Network.disable");
        return out("wsLog", { frames });
      }
      case "quit":
        throw new Error("quit");
      default:
        out("unknown", { line });
    }
  };

  const lines = createInterface({ input: process.stdin });
  process.on("SIGTERM", () => lines.close());
  try {
    for await (const line of lines) {
      out("cmd", { line });
      try {
        await handle(line);
      } catch (error) {
        if (error instanceof Error && error.message === "quit") break;
        out("error", { line, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    (cdp as Cdp | null)?.close();
    (app as ChildProcess | null)?.kill("SIGTERM");
    await sleep(1500);
    await proxy.close();
    await driver.close();
    await daemon.close();
    rmSync(userData, { recursive: true, force: true });
    out("closed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
