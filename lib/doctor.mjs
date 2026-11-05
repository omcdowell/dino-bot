// `dinobot doctor`: checks the install end to end and prints a plain fix for anything wrong.
// Checks: install files, daemon service, listening, ready for the app, password, herdr session,
// worker GC timer, sign-ins, Tailscale / home-network reachability of every offered address,
// versions. Exit code 1 when any check FAILs (WARNs do not fail).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { HERDR_SESSION, probeHostFor, readEnvFile } from "./config.mjs";
import { detectSignIns, detectTailscale } from "./detect.mjs";
import { tailscaleSteps } from "./tailscale.mjs";
import { detectWsl, dictationCheck, editWslConfig, ENABLE_SYSTEMD, hyperVFirewallCommand, startupScriptPath, windowsDriveProblems, windowsHome } from "./wsl.mjs";
import { readFileSync } from "node:fs";
import { socketPathFits } from "./herdr.mjs";
import { offerEndpoints } from "./offer.mjs";
import { probeWs, isReadyStatus } from "./ready.mjs";
import { LABEL } from "./service.mjs";
import { PRODUCT, PRODUCT_ID, readJson, run, withoutHerdrPaneVars } from "./util.mjs";

const OK = "ok";
const WARN = "WARN";
const FAIL = "FAIL";

/** How to restart the daemon in each service mode (used in fixes). */
export function restartHint(mode, uid = process.getuid?.() ?? 501) {
  if (mode === "systemd") return `systemctl --user restart ${PRODUCT_ID}.service`;
  if (mode === "launchd") return `launchctl kickstart -k gui/${uid}/${LABEL}.daemon`;
  return `~/.${PRODUCT_ID}/bin/${PRODUCT_ID} start`;
}

export function logHint(L, mode) {
  return mode === "systemd" ? `journalctl --user -u ${PRODUCT_ID} -n 50` : `tail -n 50 ${join(L.logs, "daemon.log")}`;
}

/** Pure: the listen address against Tailscale (tailnet only), so it is unit-tested. */
export function checkListenScope({ listen, tailscale, wsl = null }) {
  const host = probeHostFor(listen);
  if (host === "127.0.0.1")
    return { status: FAIL, detail: `listens on ${listen} (every network; older install)`, fix: `${PRODUCT_ID} setup (moves it to the tailnet address only; keeps your bots and password)` };
  if (!tailscale.running)
    return { status: FAIL, detail: `bound to ${listen} but Tailscale is not running here`, fix: tailscaleSteps(tailscale, { wsl }).filter((l) => /^\d\./.test(l))[0]?.replace(/^\d\.\s*/, "") ?? "turn Tailscale on" };
  if (tailscale.ip && host !== tailscale.ip)
    return { status: FAIL, detail: `bound to ${host} but this computer's tailnet address is now ${tailscale.ip}`, fix: `${PRODUCT_ID} setup (keeps your bots and password; rewrites the address), then ${PRODUCT_ID} pair` };
  return { status: OK, detail: `tailnet only (${listen})` };
}

async function apiStatus(host, port, password) {
  try {
    const res = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/api/status`, { headers: password ? { authorization: `Bearer ${password}` } : {}, signal: AbortSignal.timeout(3000) });
    return { code: res.status, body: res.ok ? await res.json().catch(() => null) : null };
  } catch (e) {
    return { code: 0, error: e.message };
  }
}

async function serviceState(mode, uid = process.getuid?.() ?? 501) {
  if (mode === "systemd") {
    const r = await run("systemctl", ["--user", "is-active", `${PRODUCT_ID}.service`]);
    return { up: r.stdout.trim() === "active", detail: `systemd ${r.stdout.trim() || "unknown"}` };
  }
  if (mode === "launchd") {
    const r = await run("launchctl", ["print", `gui/${uid}/${LABEL}.daemon`]);
    const state = /state = (\w+)/.exec(r.stdout)?.[1];
    return { up: r.code === 0 && state === "running", detail: r.code === 0 ? `launchd ${state ?? "loaded"}` : "launchd: not loaded" };
  }
  return { up: null, detail: "no service manager (mode none)" };
}

async function gcTimer(mode, session, uid = process.getuid?.() ?? 501) {
  if (mode === "systemd") {
    const unit = `${PRODUCT_ID}-herdr-gc@${session}.timer`;
    const en = await run("systemctl", ["--user", "is-enabled", unit]);
    const ac = await run("systemctl", ["--user", "is-active", unit]);
    const ok = en.stdout.trim() === "enabled" && ac.stdout.trim() === "active";
    return ok ? { status: OK, detail: `${unit} enabled` } : { status: WARN, detail: `${unit} ${en.stdout.trim() || "missing"}/${ac.stdout.trim() || "inactive"}`, fix: `systemctl --user enable --now ${unit}` };
  }
  if (mode === "launchd") {
    const r = await run("launchctl", ["print", `gui/${uid}/${LABEL}.herdr-gc`]);
    return r.code === 0 ? { status: OK, detail: `${LABEL}.herdr-gc loaded (daily)` } : { status: WARN, detail: `${LABEL}.herdr-gc not loaded`, fix: `launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${LABEL}.herdr-gc.plist` };
  }
  return { status: WARN, detail: "no timer without a service manager", fix: `run \`${PRODUCT_ID} herdr-gc --apply\` now and then, or install with systemd/launchd` };
}

/** Runs every check. Returns {ok, checks:[{name,status,detail,fix?}]}. */
/** WSL checks (pure but for the files it is given): systemd, keep-running, Windows drives, firewall. */
export function wslChecks({ wsl, mode, tailscale, port, L, winHome, read = (p) => readFileSync(p, "utf8"), exists = existsSync }) {
  const out = [];
  if (!wsl) return out;
  out.push(["WSL", { status: wsl.version === 2 ? OK : FAIL, detail: `WSL ${wsl.version}${wsl.distro ? `, ${wsl.distro}` : ""}, networking ${wsl.networking}, Tailscale ${tailscale.windows ? "on Windows (mirrored)" : "inside Ubuntu"}`, ...(wsl.version === 2 ? {} : { fix: `in Windows PowerShell: wsl --set-version ${wsl.distro ?? "<distro>"} 2` }) }]);
  if (mode !== "systemd") out.push(["systemd (WSL)", { status: WARN, detail: `off: ${PRODUCT} runs as plain processes and does not restart by itself`, fix: `${ENABLE_SYSTEMD}   then in PowerShell: wsl --shutdown, open Ubuntu, run ${PRODUCT_ID} setup` }]);
  if (winHome) {
    const script = exists(startupScriptPath(winHome, wsl.distro));
    let cfg = "";
    try {
      cfg = read(`${winHome}/.wslconfig`);
    } catch {}
    const keep = !editWslConfig(cfg, { on: true }).changed;
    const missing = [!script && "no start at Windows sign-in", !keep && "Ubuntu stops ~15 s after its last window closes"].filter(Boolean);
    out.push(["keep running (WSL)", missing.length ? { status: WARN, detail: missing.join("; "), fix: `~/.${PRODUCT_ID}/bin/${PRODUCT_ID} wsl-autostart` } : { status: OK, detail: "starts at Windows sign-in; instanceIdleTimeout=-1" }]);
  } else out.push(["keep running (WSL)", { status: WARN, detail: "cannot see your Windows user folder (interop off?)", fix: "see docs/windows.md, Keep it running" }]);
  for (const p of windowsDriveProblems(L)) out.push([`Windows drive (${p.what})`, { status: p.what === "bots" ? WARN : FAIL, detail: `${p.path} is on a Windows drive: slow, and file permissions do not apply`, fix: "install from Ubuntu's own home folder" }]);
  if (tailscale.windows && tailscale.running) out.push(["Windows firewall (WSL)", { status: OK, detail: `not checkable from Ubuntu. If the phone cannot connect, PowerShell as administrator: ${hyperVFirewallCommand(port)}` }]);
  return out;
}

export async function runChecks(L, { env = process.env } = {}) {
  const checks = [];
  const add = (name, r) => checks.push({ name, ...r });
  const state = readJson(L.state);
  if (!state) {
    add("install", { status: FAIL, detail: `${L.state} missing`, fix: "run the one-line installer again" });
    return { ok: false, checks };
  }
  const manifest = readJson(join(L.app, "MANIFEST.json"));
  add("install", existsSync(L.node) ? { status: OK, detail: `${L.app}` } : { status: FAIL, detail: `bundled Node missing in ${L.app}`, fix: `${PRODUCT_ID} update (or run the installer again)` });

  const denv = readEnvFile(L.envFile);
  const mode = state.serviceMode;
  const listen = denv.PASEO_LISTEN ?? `127.0.0.1:${state.port}`;
  const host = probeHostFor(listen);
  const port = state.port;

  // Daemon: service, listening, ready, password.
  const svc = await serviceState(mode);
  const code = await probeWs({ host, port });
  const ready = isReadyStatus(code);
  if (svc.up === false) add("daemon service", { status: FAIL, detail: svc.detail, fix: `${restartHint(mode)}   (log: ${logHint(L, mode)})` });
  else add("daemon service", { status: OK, detail: svc.detail });
  if (code === 0) add("daemon listening", { status: FAIL, detail: `nothing answers on ${host}:${port}`, fix: `${restartHint(mode)}   (log: ${logHint(L, mode)})` });
  else add("daemon listening", { status: OK, detail: `${host}:${port}` });
  if (code !== 0) add("daemon ready", ready ? { status: OK, detail: "accepts app connections" } : { status: WARN, detail: `answers ${code} (still starting?)`, fix: `wait 30 s and run \`${PRODUCT_ID} doctor\` again; if it stays, ${restartHint(mode)}` });
  let version = null;
  if (code !== 0) {
    const st = await apiStatus(host, port, denv.PASEO_PASSWORD);
    version = st.body?.version ?? null;
    if (st.code === 401 || st.code === 403) add("password", { status: FAIL, detail: "the daemon refused the password in daemon.env", fix: `${restartHint(mode)} (it re-reads ${L.envFile}), then ${PRODUCT_ID} pair` });
    else if (st.code === 200) add("password", { status: OK, detail: `accepted (server ${st.body?.serverId ?? "?"})` });
    else add("password", { status: WARN, detail: `status request answered ${st.code || st.error}` });
  }

  // Herdr: session and GC timer.
  if (state.herdrSession) {
    const herdr = join(L.bin, "herdr");
    const henv = { ...withoutHerdrPaneVars(env), HERDR_SESSION: state.herdrSession };
    const r = await run(herdr, ["agent", "list"], { env: henv, timeout: 4000 });
    const hfix = mode === "systemd" ? `systemctl --user restart ${PRODUCT_ID}-herdr.service` : mode === "launchd" ? `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${LABEL}.herdr` : restartHint(mode);
    if (r.code === 0) {
      const n = JSON.parse(r.stdout || "{}")?.result?.agents?.length ?? 0;
      add("herdr session", { status: OK, detail: `${state.herdrSession} answers (${n} worker${n === 1 ? "" : "s"})${state.herdrSocketDir ? `, short sockets in ${state.herdrSocketDir}` : ""}` });
    } else {
      const err = (r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 140) ?? "";
      const tooLong = /sun_path/.test(err);
      add("herdr session", { status: FAIL, detail: `${state.herdrSession} not answering: ${err}`, fix: tooLong ? `${PRODUCT_ID} update (rewrites the herdr wrapper with short sockets), then ${hfix}` : `${hfix}   (log: ${join(L.logs, "herdr.log")})` });
    }
    if (state.herdrSocketDir && !socketPathFits(join(state.herdrSocketDir, "herdr-client.sock"))) add("herdr sockets", { status: FAIL, detail: "socket path too long", fix: `${PRODUCT_ID} update` });
    add("worker GC timer", await gcTimer(mode, state.herdrSession));
  } else {
    add("herdr session", { status: WARN, detail: "off (herdr not bundled or --no-herdr)", fix: "workers stay off; reinstall with herdr to enable them" });
  }

  // Sign-ins.
  const si = detectSignIns({ piAgentDir: L.piAgentDir, userPiDir: L.userPiDir, home: L.home, env });
  const authPath = join(L.piAgentDir, "auth.json");
  if (!si.found.length) add("sign-in", { status: FAIL, detail: "no AI sign-in found", fix: `${PRODUCT_ID} setup (asks one sign-in question), or sign in from the app` });
  else add("sign-in", { status: OK, detail: si.found.map((f) => `${f.subscription} (${f.source})`).join(", ") });
  if (existsSync(authPath) && (statSync(authPath).mode & 0o077) !== 0) add("auth.json mode", { status: WARN, detail: `${authPath} is readable by others`, fix: `chmod 600 ${authPath}` });

  // Tailscale (required), listen address and reachability of every address the QR would carry.
  const wsl = await detectWsl({ env });
  const tailscale = await detectTailscale({ env, wsl });
  add("listen address", checkListenScope({ listen, tailscale, wsl }));
  add("Tailscale", tailscale.running ? { status: OK, detail: `${tailscale.dnsName ?? "?"} ${tailscale.ip ?? ""}${tailscale.windows ? " (Windows)" : ""}` } : { status: FAIL, detail: tailscale.installed ? `installed but ${tailscale.state}` : "not installed", fix: tailscaleSteps(tailscale, { wsl }).slice(0, -2).filter(Boolean).join(" / ") });
  for (const [name, r] of wslChecks({ wsl, mode, tailscale, port, L, winHome: wsl ? await windowsHome({ env }) : null })) add(name, r);
  const endpoints = offerEndpoints({ port, tailscale });
  for (const ep of endpoints) {
    const i = ep.lastIndexOf(":");
    const h = ep.slice(0, i);
    const c = await probeWs({ host: h, port: Number(ep.slice(i + 1)), timeoutMs: 2500 });
    if (isReadyStatus(c)) add(`reach ${ep}`, { status: OK, detail: "answers" });
    else add(`reach ${ep}`, { status: FAIL, detail: c ? `answers ${c}` : "no answer", fix: wsl && tailscale.windows ? `Tailscale on Windows needs WSL mirrored networking (docs/windows.md); then ${hyperVFirewallCommand(port)}` : "check Tailscale is up (`tailscale status`) and no firewall drops tailnet traffic (Linux: sudo ufw allow in on tailscale0)" });
  }

  // macOS: developer tools (git). Without them the git guard keeps the dialog away; git features are off.
  if (process.platform === "darwin") {
    const xs = await run("/usr/bin/xcode-select", ["-p"]);
    const brew = existsSync("/opt/homebrew/bin/git") || existsSync("/usr/local/bin/git");
    add("git (developer tools)", xs.code === 0 || brew ? { status: OK, detail: brew ? "Homebrew git" : `Apple git (${xs.stdout.trim()})` } : { status: WARN, detail: "not installed: git features (diffs, checkpoints) are off", fix: "xcode-select --install   (then click Install; about 5 minutes)" });
  }

  // Linux: bzip2 (GNU tar needs it to unpack the voice models; macOS's tar has it built in).
  if (process.platform === "linux") {
    const bz = await run("sh", ["-c", "command -v bzip2"], { env: { PATH: readEnvFile(L.envFile).PATH || process.env.PATH } });
    add("bzip2 (voice models)", bz.code === 0 ? { status: OK, detail: bz.stdout.trim() } : { status: WARN, detail: "not installed: the voice (dictation) models cannot be unpacked", fix: `sudo apt install bzip2   (Fedora: sudo dnf install bzip2), then: ${restartHint(mode)}` });
    // git: without it every bot turn ends with a red "Local checkpoint failed: spawn git ENOENT" in
    // the chat (linux-ready, desktop app on a Debian/Ubuntu host without git).
    const git = await run("sh", ["-c", "command -v git"], { env: { PATH: readEnvFile(L.envFile).PATH || process.env.PATH } });
    add("dictation", dictationCheck(wsl));
    add("git (checkpoints)", git.code === 0 ? { status: OK, detail: git.stdout.trim() } : { status: WARN, detail: "not installed: bot chats show \"Local checkpoint failed\" and git features are off", fix: `sudo apt install git   (Fedora: sudo dnf install git), then: ${restartHint(mode)}` });
  }

  // Versions.
  const nodeV = (await run(L.node, ["-v"])).stdout.trim();
  const herdrV = existsSync(join(L.app, "herdr", "herdr")) ? (await run(join(L.app, "herdr", "herdr"), ["--version"])).stdout.trim() : "none";
  add("versions", {
    status: manifest ? OK : WARN,
    detail: manifest ? `${PRODUCT}${manifest.version ? ` ${manifest.version}` : ""} build ${manifest.built} (installer ${manifest.installer}); daemon ${version ?? manifest.daemon}; pi ${manifest.pi}; node ${nodeV}; ${herdrV}` : `no MANIFEST.json; node ${nodeV}; daemon ${version ?? "?"}`,
    ...(manifest ? {} : { fix: `${PRODUCT_ID} update` }),
  });
  return { ok: !checks.some((c) => c.status === FAIL), checks };
}

export function formatChecks({ ok, checks }) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${c.status.padEnd(4)}  ${c.name.padEnd(28)} ${c.detail}`);
    if (c.fix && c.status !== OK) lines.push(`      ${"".padEnd(28)} fix: ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === FAIL).length;
  const warns = checks.filter((c) => c.status === WARN).length;
  lines.push("", ok ? `All good${warns ? ` (${warns} warning${warns === 1 ? "" : "s"})` : ""}.` : `${fails} problem${fails === 1 ? "" : "s"} found; the fixes are above.`);
  return lines.join("\n");
}

export async function doctor(L, { json = false } = {}) {
  const r = await runChecks(L);
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${PRODUCT} doctor\n\n${formatChecks(r)}\n`);
  return r;
}
