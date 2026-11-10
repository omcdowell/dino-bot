// Look before asking (rel-bench pattern 1): sign-ins, Tailscale, addresses, the user's name.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { readJson, run } from "./util.mjs";
import { isLocalAddress, windowsTailscalePath } from "./wsl.mjs";

/**
 * pi auth.json entry -> rel-import subscription id (src/model-defaults.ts).
 * A Claude login cannot tell Pro from Max, so it maps to Pro (Sonnet defaults, the cheaper guess)
 * unless DINOBOT_CLAUDE_PLAN=max.
 */
export function subscriptionFor(provider, type, env = process.env) {
  if (provider === "anthropic") return type === "oauth" ? (env.DINOBOT_CLAUDE_PLAN === "max" ? "claude-max" : "claude-pro") : "anthropic-api";
  if (provider === "openai-codex") return "chatgpt";
  if (provider === "openai") return "openai-api";
  if (provider === "github-copilot") return "copilot";
  if (provider === "openrouter") return "openrouter";
  if (provider === "google" || provider === "gemini") return "google";
  return null;
}

const ENV_KEYS = [
  ["ANTHROPIC_API_KEY", "anthropic"],
  ["OPENAI_API_KEY", "openai"],
  ["OPENROUTER_API_KEY", "openrouter"],
  ["GEMINI_API_KEY", "google"],
];

/**
 * Usable sign-ins, best first by the caller's preference. Sources: pi's auth.json (already usable),
 * API keys in the environment (saved to auth.json if picked), and a Codex CLI login (not copied:
 * OpenAI rotates refresh tokens, so sharing one would sign the Codex CLI out; it only pre-selects
 * ChatGPT for the device-code login).
 */
export function detectSignIns({ piAgentDir, userPiDir, home, env = process.env }) {
  const found = [];
  const auth = readJson(join(piAgentDir, "auth.json"), {}) ?? {};
  for (const [provider, cred] of Object.entries(auth)) {
    const type = cred?.type === "api_key" ? "api_key" : "oauth";
    const subscription = subscriptionFor(provider, type, env);
    if (subscription) found.push({ subscription, provider, type, source: "pi" });
  }
  // The user's own pi (read only): API keys can be reused (copied into DinoBot's pi). OAuth
  // logins are not copied (refresh-token rotation would sign one of the two out); they only
  // pre-select that provider for the sign-in question.
  const userOauth = [];
  if (userPiDir && userPiDir !== piAgentDir) {
    const mine = readJson(join(userPiDir, "auth.json"), {}) ?? {};
    for (const [provider, cred] of Object.entries(mine)) {
      if (found.some((f) => f.provider === provider)) continue;
      if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key) {
        const subscription = subscriptionFor(provider, "api_key", env);
        if (subscription) found.push({ subscription, provider, type: "api_key", source: "your pi (~/.pi)", key: cred.key });
      } else if (cred) userOauth.push(provider);
    }
  }
  for (const [name, provider] of ENV_KEYS) {
    const key = env[name]?.trim();
    if (!key || found.some((f) => f.provider === provider)) continue;
    found.push({ subscription: subscriptionFor(provider, "api_key", env), provider, type: "api_key", source: `env ${name}`, key });
  }
  let codexCli = false;
  const codex = readJson(join(home, ".codex", "auth.json"));
  if (codex?.tokens?.refresh_token) codexCli = true;
  else if (codex?.OPENAI_API_KEY && !found.some((f) => f.provider === "openai")) {
    found.push({ subscription: "openai-api", provider: "openai", type: "api_key", source: "codex auth.json", key: codex.OPENAI_API_KEY });
  }
  return { found, codexCli, userOauth };
}

/**
 * `tailscale status --json`, if Tailscale is installed and up. On WSL (`wsl` from detectWsl) the
 * Windows Tailscale is tried too, after the one inside Linux; `windows: true` marks its answer and
 * `local` says whether its address is on this machine (WSL mirrored networking) so the daemon can
 * listen on it. A running Tailscale wins over one that is installed but off.
 * DINOBOT_TAILSCALE_SOCKET: a tailscaled of your own (e.g. a userspace one in your home folder,
 * second person on a Mac whose system Tailscale is someone else's); passed as `--socket` to the CLI.
 */
export const tailscaleArgs = (env = process.env) => (env.DINOBOT_TAILSCALE_SOCKET ? ["--socket", env.DINOBOT_TAILSCALE_SOCKET] : []);
export const TAILSCALE_BINS = ["tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
export async function detectTailscale({ env = process.env, wsl = null, nets, bins = TAILSCALE_BINS } = {}) {
  // DINOBOT_TAILSCALE_BIN (tests, unusual installs) is the only candidate when set.
  const candidates = env.DINOBOT_TAILSCALE_BIN ? [env.DINOBOT_TAILSCALE_BIN] : [...bins];
  const winBin = windowsTailscalePath(env);
  if (wsl && !env.DINOBOT_TAILSCALE_BIN) candidates.push(winBin);
  let installed = false;
  let first = null;
  for (const bin of candidates) {
    if (bin.startsWith("/") && !existsSync(bin)) continue;
    const windows = Boolean(wsl) && bin === winBin;
    // `tailscale status --json` exits non-zero when stopped but still prints the state. The Windows
    // CLI through WSL interop is slower to start.
    const r = await run(bin, [...(windows ? [] : tailscaleArgs(env)), "status", "--json"], { timeout: windows ? 8000 : 3000 });
    if (r.error?.code === "ENOENT") continue;
    if (!windows) installed = true;
    if (!r.stdout.trim()) continue;
    try {
      const s = JSON.parse(r.stdout);
      const self = s.Self ?? {};
      const ips = (self.TailscaleIPs ?? []).filter((ip) => net.isIPv4(ip));
      const ip = ips[0] ?? null;
      const found = {
        installed: true,
        state: s.BackendState ?? "Unknown",
        running: s.BackendState === "Running",
        dnsName: String(self.DNSName ?? "").replace(/\.$/, "") || null,
        ip,
        magicDns: Boolean(s.CurrentTailnet?.MagicDNSEnabled ?? self.DNSName),
        ...(wsl ? { windows, local: ip ? isLocalAddress(ip, nets) : false } : {}),
      };
      if (found.running) return found;
      first ??= found;
    } catch {
      /* try next */
    }
  }
  if (first && !(first.windows && installed)) return first;
  return { installed, state: installed ? "NoState" : "NotInstalled", running: false, dnsName: null, ip: null, magicDns: false, ...(wsl ? { windows: false, local: false } : {}) };
}

/**
 * Can the daemon use this Tailscale? Running with an address, and on WSL with the Windows
 * Tailscale only when that address is inside Linux too (mirrored networking).
 */
export function tailscaleUsable(t) {
  return Boolean(t?.running && t.ip && (!t.windows || t.local));
}

/**
 * macOS: is the system Tailscale someone else's? The Tailscale app (menu bar) runs in the session of
 * the user who signed it in; the tailnet it is on is theirs. Clear evidence only: we use the system
 * Tailscale (no DINOBOT_TAILSCALE_BIN / _SOCKET), the app runs for at least one other macOS user and
 * not for us. Then setup refuses rather than put the daemon (and the QR) on their tailnet. No app
 * process at all (CLI-only, unattended, or ps unreadable): no evidence, no refusal.
 * `ps`: `uid command` lines, `nameOf`: uid -> login name (tests). -> {owners: ["name (uid 501)", ...]} or null.
 */
export const TAILSCALE_APP_RE = /\/Tailscale\.app\/Contents\/MacOS\/Tailscale(\s+-\S*)*\s*$/;
export async function foreignTailscale({ env = process.env, tailscale, os: os_ = process.platform, uid = process.getuid?.(), ps, nameOf } = {}) {
  if (os_ !== "darwin" || env.DINOBOT_TAILSCALE_BIN || env.DINOBOT_TAILSCALE_SOCKET || !tailscale?.running || tailscale.windows) return null;
  if (ps == null) {
    const r = await run("/bin/ps", ["-axww", "-o", "uid=,command="], { timeout: 3000 });
    if (r.code !== 0) return null;
    ps = r.stdout;
  }
  const uids = new Set();
  for (const line of String(ps).split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m && TAILSCALE_APP_RE.test(m[2])) uids.add(Number(m[1]));
  }
  if (!uids.size || uids.has(Number(uid))) return null;
  nameOf ??= async (u) => (await run("/usr/bin/id", ["-un", String(u)], { timeout: 2000 })).stdout.trim();
  const owners = [];
  for (const u of [...uids].sort((a, b) => a - b)) {
    const n = await nameOf(u).catch(() => "");
    owners.push(n ? `${n} (uid ${u})` : `uid ${u}`);
  }
  return { owners };
}

export function isTailnetIp(address) {
  const [a, b] = String(address).split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** First non-internal IPv4 that is not a tailnet or container bridge address. */
export function lanIp(nets = os.networkInterfaces()) {
  for (const name of Object.keys(nets).sort()) {
    if (/^(docker|br-|veth|virbr|lxc|tailscale|utun|zt)/.test(name)) continue;
    for (const addr of nets[name] ?? []) {
      if (addr.family === "IPv4" && !addr.internal && !isTailnetIp(addr.address)) return addr.address;
    }
  }
  return null;
}

/** The OS account's full name (macOS `id -F`, Linux GECOS), else the login name. */
export async function fullName({ env = process.env } = {}) {
  const user = env.USER || os.userInfo().username;
  if (process.platform === "darwin") {
    const r = await run("id", ["-F"]);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } else {
    const r = await run("getent", ["passwd", user]);
    const gecos = r.stdout.split(":")[4]?.split(",")[0]?.trim();
    if (gecos) return gecos;
  }
  return user ? user.charAt(0).toUpperCase() + user.slice(1) : "";
}

/**
 * First free TCP port from `start`. `hosts`: the addresses to try it on, all must be free: the
 * daemon's own listen address (macOS lets a 0.0.0.0 probe succeed while another user's daemon holds
 * the port on a specific address) and 0.0.0.0 (something on every interface).
 */
export async function freePort(start = 6767, hosts = "0.0.0.0", tries = 20) {
  const list = [...new Set([hosts].flat().filter(Boolean))];
  const bindable = (port, host) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
  for (let port = start; port < start + tries; port++) {
    let ok = true;
    for (const host of list) if (!(ok = await bindable(port, host))) break;
    if (ok) return port;
  }
  throw new Error(`no free port in ${start}-${start + tries - 1}`);
}

/** A laptop on battery may sleep and take the bots offline: worth one line, not a question. */
export function onBattery() {
  try {
    if (process.platform === "linux") {
      const dir = "/sys/class/power_supply";
      return readdirSync(dir).some((d) => d.startsWith("BAT") && readFileSync(join(dir, d, "status"), "utf8").trim() === "Discharging");
    }
  } catch {
    return false;
  }
  return false;
}

export function platform() {
  const os_ = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return { os: os_, arch, hostname: os.hostname().split(".")[0], hasSystemd: os_ === "linux" && existsSync("/run/systemd/system") };
}
