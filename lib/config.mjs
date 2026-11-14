// Everything the installer writes besides services: bin wrappers, daemon config and env, the bots
// host settings and pi auth. Paths point into ~/.dinobot only.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { herdrSocketDir, herdrWrapper } from "./herdr.mjs";
import { isLocalAddress } from "./wsl.mjs";
import { LINK_SCHEME, PRODUCT_ID, readJson, writeFileAtomic, writeJson } from "./util.mjs";

export const HERDR_SESSION = "paseo-bots"; // the bots plugin's default (rel-plugin DEFAULT_HERDR_SESSION)

/**
 * Where the daemon listens: the tailnet address only (owner decision, 27 Oct: Tailscale required, no LAN
 * mode, no 0.0.0.0 fallback). Without a running Tailscale there is no plan: setup stops with the
 * steps to turn it on (tailscale.mjs). -> {listen: "100.x.y.z:port", probeHost} or null.
 * Userspace tailscaled (`--tun=userspace-networking`, e.g. a second person's own tailnet on a shared
 * Mac): its address is on no interface here, so binding it fails; it hands inbound tailnet
 * connections to 127.0.0.1:<same port>. Then the daemon listens there (userspace: true). The
 * addresses in the QR stay the tailnet name and IP (offerEndpoints).
 */
export function listenHost({ tailscale, nets } = {}) {
  if (!tailscale?.running || !tailscale.ip) return null;
  if (tailscale.windows || isLocalAddress(tailscale.ip, nets)) return tailscale.ip;
  return "127.0.0.1";
}
export function listenPlan({ tailscale, port, nets }) {
  const host = listenHost({ tailscale, nets });
  if (!host) return null;
  return host === tailscale.ip ? { listen: `${host}:${port}`, probeHost: host } : { listen: `${host}:${port}`, probeHost: host, userspace: true };
}

/** The host part of PASEO_LISTEN to probe locally (0.0.0.0 -> 127.0.0.1). */
export function probeHostFor(listen) {
  const host = String(listen ?? "").replace(/:\d+$/, "");
  return !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/**
 * Env every DinoBot pi gets (wrapper, daemon, herdr server). PI_SKIP_VERSION_CHECK: the bundled
 * pi cannot update itself (it is replaced by `dinobot update`), so pi's "Update available" banner
 * in worker panes only confuses (demo issue 10). PI_TELEMETRY=0: pi's anonymous install/update
 * reporting and provider attribution headers off, in line with "no automatic network calls we
 * have not disclosed" (privacy policy); set PI_INSTALL_TELEMETRY to true to leave pi's default.
 */
export const PI_INSTALL_TELEMETRY = false;
export const PI_ENV = { PI_SKIP_VERSION_CHECK: "1", ...(PI_INSTALL_TELEMETRY ? {} : { PI_TELEMETRY: "0" }) };
const piEnvExports = () => Object.entries(PI_ENV).map(([k, v]) => `export ${k}=${v}\n`).join("");

/** The bundled daemon is the @getpaseo/cli package; bot-dm and bot-room import its dist (PASEO_CLI_DIST). */
export const paseoCliDist = (L) => join(L.app, "daemon", "dist");

/** Install-time settings the `dinobot` wrapper keeps for later commands (pair, doctor, update), as exports. */
export const STICKY_ENV = ["DINOBOT_LAUNCHD_LABEL", "DINOBOT_TAILSCALE_BIN", "DINOBOT_TAILSCALE_SOCKET"];
export function stickyEnv(env) {
  return STICKY_ENV.filter((k) => env[k]).map((k) => `export ${k}="${env[k]}"\n`).join("");
}

/** `~/.dinobot/bin/*`: small sh wrappers that run the bundled Node, so nothing needs a system Node. */
export function writeWrappers(L, platform = process.platform) {
  mkdirSync(L.bin, { recursive: true });
  const node = `"${L.node}"`;
  const wrappers = {
    node: `exec ${node} "$@"`,
    paseo: `exec ${node} --disable-warning=DEP0040 "${join(L.app, "daemon", "bin", "paseo")}" "$@"`,
    // Always DinoBot's own pi dir (sign-ins, settings, packages), whatever the caller's env says.
    pi: `export PI_CODING_AGENT_DIR="${L.piAgentDir}"\n${piEnvExports()}exec ${node} "${join(L.app, "pi", "dist", "bundle", "cli.js")}" "$@"`,
    // bot-dm/bot-room load the Paseo CLI internals (connectToDaemon); the bundled daemon is that CLI.
    // Without this they looked in ~/.local/lib/node_modules/@getpaseo/cli ("cannot load ... client.js").
    // `bot-dm user` pushes through the optional push add-on (lib/push.mjs); its files are in
    // ~/.dinobot/apns once `dinobot push enable` has run (stock installs: no folder, nothing set).
    "bot-dm": `export PASEO_CLI_DIST="${paseoCliDist(L)}"\nif [ -z "$PASEO_APNS_DIR" ] && [ -d "${join(L.root, "apns")}" ]; then export PASEO_APNS_DIR="${join(L.root, "apns")}"; fi\nexec ${node} "${join(L.app, "bots", "bin", "bot-dm.mjs")}" "$@"`,
    "bot-room": `export PASEO_CLI_DIST="${paseoCliDist(L)}"\nexec ${node} "${join(L.app, "bots", "bin", "bot-room.mjs")}" "$@"`,
    "bot-worker": `exec ${node} "${join(L.app, "bots", "bin", "bot-worker.mjs")}" "$@"`,
    // A test install's own launchd label (DINOBOT_LAUNCHD_LABEL) and Tailscale CLI (DINOBOT_TAILSCALE_BIN) must
    // stick for later commands (`pair --link` re-detected Tailscale without the install's CLI).
    [PRODUCT_ID]: `${stickyEnv(process.env)}exec ${node} --experimental-transform-types --no-warnings "${join(L.app, "installer", "lib", "cli.mjs")}" "$@"`,
  };
  for (const [name, body] of Object.entries(wrappers)) {
    writeFileAtomic(join(L.bin, name), `#!/bin/sh\n${body}\n`, 0o755);
  }
  const herdr = join(L.app, "herdr", "herdr");
  const link = join(L.bin, "herdr");
  let socketDir = null;
  if (existsSync(herdr)) {
    try {
      unlinkSync(link); // older installs had a symlink here
    } catch {}
    chmodSync(herdr, 0o755);
    socketDir = herdrSocketDir({ home: L.home, session: HERDR_SESSION, force: process.env.DINOBOT_HERDR_SHORT_SOCKETS === "1" });
    writeFileAtomic(link, herdrWrapper({ realBin: herdr, node: L.node, listScript: join(L.app, "installer", "lib", "herdr-list.mjs"), session: HERDR_SESSION, socketDir }), 0o755);
  }
  const gitGuard = join(L.bin, "git");
  if (platform === "darwin") writeFileAtomic(gitGuard, gitGuardWrapper(), 0o755);
  return { names: Object.keys(wrappers), herdrSocketDir: socketDir, gitGuard: platform === "darwin" };
}

/**
 * macOS only: ~/.<id>/bin/git, first on the daemon's PATH (so the daemon, bots and OptChat
 * checkpoints all get it). On a fresh Mac /usr/bin/git is a stub that pops the "install the
 * command line developer tools" dialog, with nobody at the Mac to answer it. This guard runs a
 * real git if there is one (Homebrew, or Apple's once the tools are installed) and otherwise
 * fails at once with a hint instead of the dialog.
 */
export function gitGuardWrapper({ xcodeSelect = "/usr/bin/xcode-select", appleGit = "/usr/bin/git", brewGits = ["/opt/homebrew/bin/git", "/usr/local/bin/git"] } = {}) {
  return `#!/bin/sh
for g in ${brewGits.map((g) => `"${g}"`).join(" ")}; do
  [ -x "$g" ] && exec "$g" "$@"
done
if "${xcodeSelect}" -p >/dev/null 2>&1; then exec "${appleGit}" "$@"; fi
echo "git: not available (macOS developer tools not installed). Git features are off; to turn them on, run: xcode-select --install" >&2
exit 127
`;
}

/** PATH for the daemon and every agent it starts: our bin first, then the usual system dirs. */
export function servicePath(L, platform = process.platform) {
  const extra = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin"];
  return [L.bin, ...extra, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

/**
 * Daemon env file (mode 600). The password is plain here, as the daemon expects PASEO_PASSWORD;
 * it also goes into the QR (with the daemon key). The app sends it only inside the end-to-end
 * encrypted channel keyed to that key; PASEO_DIRECT_E2EE=required makes the daemon refuse plaintext
 * WebSocket clients from other machines (an outdated app then fails with "update the app").
 * Userspace Tailscale (listenPlan userspace: true): the phone's connections arrive from 127.0.0.1,
 * so PASEO_TRUST_LOOPBACK=false takes away the daemon's "same machine" exemption for TCP. Then a
 * plaintext client is admitted only with the daemon's local credential (PASEO_HOME, mode 600): our
 * CLI, bot-dm and bot-room use it (they inherit this env or get it from waitForAnswers); the app
 * must use the encrypted channel. Other installs: not written, behaviour unchanged.
 */
export function writeDaemonEnv(L, { port, listen, directEndpoints, password, userspace = false }) {
  const existing = readEnvFile(L.envFile);
  const pw = password || existing.PASEO_PASSWORD || randomBytes(18).toString("base64url");
  const env = {
    // Explicit HOME: launchd gives agents the account's home, which differs from the install's when
    // DINOBOT_HOME/a test HOME is used (Mac e2e: herdr wrote into the real ~/.config). Same value
    // as the account's home in a normal install.
    HOME: L.home,
    PASEO_HOME: L.paseoHome,
    PASEO_LISTEN: listen,
    PASEO_PAIR_LINK_SCHEME: LINK_SCHEME, // the daemon's own "Pair device" QR uses the app's scheme too
    PASEO_RELAY_ENABLED: "false",
    PASEO_DIRECT_E2EE: "required",
    ...(userspace ? { PASEO_TRUST_LOOPBACK: "false" } : {}),
    PASEO_PASSWORD: pw,
    PASEO_DIRECT_ENDPOINTS: directEndpoints.join(","),
    PASEO_BOTS_ROOT: L.botsRoot,
    PASEO_BOTS_HERDR: join(L.bin, "herdr"),
    PI_CODING_AGENT_DIR: L.piAgentDir, // daemon, bots and (through herdr) workers: one sign-in
    ...PI_ENV,
    PASEO_CLI_DIST: paseoCliDist(L), // bot-dm / bot-room run by bots load the daemon's CLI internals from here
    DINOBOT_HOME: L.root, // the bots plugin finds the onboarding module (installer/lib/phone-signin.mjs) here
    PATH: servicePath(L),
    // Set only by `dinobot push enable` (lib/push.mjs); kept when setup runs again.
    ...(existing.PASEO_APNS_DIR ? { PASEO_APNS_DIR: existing.PASEO_APNS_DIR } : {}),
  };
  writeFileAtomic(L.envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", 0o600);
  return env;
}

export function readEnvFile(path) {
  const out = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Daemon config.json in our own PASEO_HOME (never ~/.paseo, so an existing Paseo is untouched).
 * Keeps keys already there; sets what onboarding owns.
 */
export function writeDaemonConfig(L, { mainModel, thinking = null }) {
  const path = join(L.paseoHome, "config.json");
  const cfg = readJson(path, {}) ?? {};
  cfg.version = 1;
  cfg.daemon = cfg.daemon ?? {};
  cfg.daemon.relay = { ...(cfg.daemon.relay ?? {}), enabled: false };
  // MagicDNS names, on top of the defaults (localhost and every IP). No ".local": tailnet only.
  cfg.daemon.hostnames = [...new Set([...(Array.isArray(cfg.daemon.hostnames) ? cfg.daemon.hostnames : []).filter((h) => h !== ".local"), ".ts.net"])];
  const profiles = (cfg.daemon.agentProfiles ?? []).filter((p) => p.id !== "bot");
  profiles.unshift({
    id: "bot",
    name: "Bot (OptChat)",
    provider: "optchat",
    ...(mainModel ? { model: mainModel } : {}),
    ...(thinking ? { thinkingOptionId: thinking } : {}),
    notes: "Long-lived bot chat. Use inside a ~/bots/<bot> folder; the folder picks the OptChat profile.",
  });
  cfg.daemon.agentProfiles = profiles;
  cfg.pluginsEnabled = true;
  cfg.plugins = { ...(cfg.plugins ?? {}), bots: { source: "directory", path: join(L.app, "bots"), enabled: true } };
  cfg.agents = cfg.agents ?? {};
  cfg.agents.providers = cfg.agents.providers ?? {};
  cfg.agents.providers.optchat = {
    ...cfg.agents.providers.optchat,
    extends: "pi",
    label: "OptChat",
    command: optchatCommand(L),
    options: { ...(cfg.agents.providers.optchat?.options ?? {}), rpcTimeoutMs: 300000 },
  };
  applyProviderDefaults(cfg, { keep: scheduledProviders(L.paseoHome) });
  mkdirSync(L.paseoHome, { recursive: true, mode: 0o700 });
  writeJson(path, cfg, 0o600);
  return path;
}

/**
 * Paseo's own agent providers DinoBot does not run (providers redesign, stage 0): off, so the daemon
 * neither probes their CLIs nor lists them in pickers. `pi` too: OptChat (`extends: "pi"`) is the
 * only engine a bot uses, and a derived provider does not need its base enabled. `antigravity` and
 * `muse` come from Paseo's built-in plugins (always started; their provider is what we switch off).
 * Nothing is deleted
 * (stages 1–3); a disabled provider keeps its other settings.
 */
export const DISABLED_PASEO_PROVIDERS = ["claude", "codex", "copilot", "opencode", "omp", "pi", "antigravity", "muse"];
/** Configured providers (`extends`: ACP, cursor, kimi, a Z.AI on claude, …) that stay on. */
const KEPT_CONFIGURED_PROVIDERS = new Set(["optchat"]);

/**
 * Sets `enabled: false` on the built-in providers above and on every configured provider with
 * `extends` except OptChat. Plugin overrides (no `extends`) are left as they are, and so is every
 * provider in `keep` (one a Paseo schedule still runs on: switching it off would fail those runs).
 * Mutates and returns `cfg`; run on every config write, so it reaches existing installs too.
 */
export function applyProviderDefaults(cfg, { keep = new Set() } = {}) {
  cfg.agents = cfg.agents ?? {};
  const providers = (cfg.agents.providers = cfg.agents.providers ?? {});
  for (const id of DISABLED_PASEO_PROVIDERS) {
    if (!keep.has(id)) providers[id] = { ...(providers[id] ?? {}), enabled: false };
  }
  for (const [id, p] of Object.entries(providers)) {
    if (p && typeof p === "object" && p.extends && !KEPT_CONFIGURED_PROVIDERS.has(id) && !keep.has(id)) p.enabled = false;
  }
  return cfg;
}

/**
 * Providers that active or paused Paseo schedules start new agents on (`<paseoHome>/schedules/*.json`,
 * target `new-agent`). Unreadable files are skipped. -> Set of provider ids.
 */
export function scheduledProviders(paseoHome) {
  const dir = join(paseoHome, "schedules");
  const out = new Set();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const name of names) {
    const s = readJson(join(dir, name), null);
    const provider = s?.target?.type === "new-agent" ? s.target.config?.provider : null;
    if (typeof provider === "string" && provider && s.status !== "completed") out.add(provider);
  }
  return out;
}

/**
 * `~/bots/.settings.json`. Two plugin branches read it with different keys (rel-plugin:
 * user/escalation/defaultModel/herdr; rel-app: ownerName/escalationBot); both ignore unknown
 * keys, so both are written until the branches are merged. Existing keys are kept.
 */
export function writeBotsSettings(L, { userName, escalation, defaultModel }) {
  const path = join(L.botsRoot, ".settings.json");
  const s = readJson(path, {}) ?? {};
  s.user = { ...(s.user ?? {}), name: userName, aliases: s.user?.aliases ?? [] };
  s.ownerName = userName;
  s.escalation = escalation ?? null;
  s.escalationBot = escalation ?? null;
  if (defaultModel) s.defaultModel = defaultModel;
  s.herdr = { ...(s.herdr ?? {}), session: s.herdr?.session === null ? null : (s.herdr?.session ?? HERDR_SESSION) };
  mkdirSync(L.botsRoot, { recursive: true, mode: 0o700 }); // bot memories and chats: owner only (rel-security L2)
  writeJson(path, s, 0o600);
  return path;
}

/** pi packages every DinoBot pi gets (owner decision): bundled in the tarball (app/pi-packages). */
export const DEFAULT_PI_PACKAGES = ["npm:pi-web-access"];

/**
 * Bundled pi packages for bots only (the daemon's OptChat command line, `-e`), not for herdr
 * workers. ask_user_question: Paseo shows it in the app as a question card (upstream adapter
 * providers/pi/extensions/rpiv-ask-user-question). A worker in a herdr pane would show it in the
 * pane's TUI instead, where nobody is looking, and wait forever; so workers do not get it.
 */
export const BOT_ONLY_PI_PACKAGES = ["@juicesharp/rpiv-ask-user-question"];

export function botOnlyExtensionArgs(L) {
  return BOT_ONLY_PI_PACKAGES.map((name) => join(L.app, "pi-packages", "node_modules", name))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => ["-e", dir]);
}

/** The daemon's OptChat (bot) command line: DinoBot's pi, OptChat, bot-only extensions and skills. */
export function optchatCommand(L) {
  return [join(L.bin, "pi"), "-e", join(L.app, "optchat", "src", "index.ts"), ...botOnlyExtensionArgs(L), ...botSkillArgs(L)];
}

/**
 * `dinobot update`: the OptChat command line again, for what the new app bundles (extensions,
 * skills), plus the provider switches (applyProviderDefaults). The rest of config.json (models,
 * profiles) stays as it is. No config or no OptChat provider yet: nothing to do (setup writes it).
 */
export function refreshOptchatCommand(L) {
  const path = join(L.paseoHome, "config.json");
  const cfg = readJson(path, null);
  const optchat = cfg?.agents?.providers?.optchat;
  if (!optchat) return null;
  optchat.command = optchatCommand(L);
  applyProviderDefaults(cfg, { keep: scheduledProviders(L.paseoHome) }); // existing installs: on `dinobot update`
  writeJson(path, cfg, 0o600);
  return path;
}

/**
 * Skills bundled with the bots plugin (plugins/bots/skills/<name>/SKILL.md, shipped as
 * app/bots/skills), for bots only: the daemon's OptChat command line gets `--skill <dir>`, so
 * every bot sees them and they update with the plugin. Herdr workers (plain `pi`) do not get
 * them: `workers` is about running workers, not being one. pi finds each SKILL.md below the dir.
 * The worker shortlist (names in skills/workers/worker-skills.txt, which the workers skill's
 * launch.sh passes to workers) is for workers, not bots: when that list exists, each other
 * skill folder gets its own `--skill <dir>/<name>` and the listed ones are left out.
 */
export function botSkillArgs(L) {
  const dir = join(L.app, "bots", "skills");
  if (!existsSync(dir)) return [];
  const list = join(dir, "workers", "worker-skills.txt");
  if (!existsSync(list)) return ["--skill", dir];
  const workerOnly = new Set(workerSkillNames(readFileSync(list, "utf8")));
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !workerOnly.has(e.name) && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort()
    .flatMap((name) => ["--skill", join(dir, name)]);
}

/** Skill names in worker-skills.txt: one per line, `#` comments and blank lines ignored. */
export function workerSkillNames(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/**
 * Whether DinoBot's pi loads the user's personal skills from ~/.agents/skills. pi reads that
 * folder whatever PI_CODING_AGENT_DIR says, so the split pi dir alone does not keep them out.
 * false (default, Q8 "split"): settings.json excludes it. Flip to true to share them.
 */
export const LOAD_USER_AGENTS_SKILLS = false;

/**
 * DinoBot's pi dir: settings.json with the default packages (kept if the user changed it), and
 * each bundled package linked where pi looks for npm packages (<dir>/npm/node_modules/<name>),
 * so nothing is downloaded at install time and no npm is needed.
 */
export function writePiSetup(L) {
  mkdirSync(L.piAgentDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(L.piAgentDir, "settings.json");
  const settings = readJson(settingsPath, {}) ?? {};
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  settings.packages = [...packages, ...DEFAULT_PI_PACKAGES.filter((p) => !packages.includes(p))];
  const noUserSkills = `!${join(L.home, ".agents", "skills")}/**`;
  const skills = (Array.isArray(settings.skills) ? settings.skills : []).filter((p) => p !== noUserSkills);
  settings.skills = LOAD_USER_AGENTS_SKILLS ? skills : [...skills, noUserSkills];
  if (!settings.skills.length) delete settings.skills;
  // pi runs `npm install` for provider plugins from git or npm; a fresh Mac has no npm. Use the
  // npm bundled with DinoBot's Node through ~/.dinobot/libexec/npm (named "npm" so pi passes its
  // npm flags: --omit=dev, no dev-dependency install scripts; not on PATH, so the user's own npm
  // is never shadowed), with its cache inside ~/.dinobot (~/.npm untouched). Kept if the user set
  // their own npmCommand.
  // rg and fd bundled in the tarball (app/tools): linked into pi's tools dir so no pi downloads them.
  for (const tool of ["rg", "fd"]) {
    const src = join(L.app, "tools", tool, tool);
    if (!existsSync(src)) continue;
    const dest = join(L.piAgentDir, "bin", tool);
    mkdirSync(join(L.piAgentDir, "bin"), { recursive: true });
    try {
      unlinkSync(dest);
    } catch {}
    symlinkSync(src, dest);
  }
  const npmWrapper = writeNpmWrapper(L);
  if (npmWrapper && (!Array.isArray(settings.npmCommand) || settings.npmCommand[0] === npmWrapper)) {
    settings.npmCommand = [npmWrapper, "--cache", join(L.root, "npm-cache"), "--no-audit", "--no-fund", "--no-update-notifier"];
  }
  writeJson(settingsPath, settings, 0o600);
  const linked = [];
  // pi loads a package from <dir>/npm/node_modules/<name> without resolving the symlink, so the
  // package's own dependencies (pi-web-access needs p-limit, …) must sit next to it too: link
  // every bundled module (packages pi is not told to load stay inert). rel-demo found
  // "Cannot find module 'p-limit'" without this.
  const bundled = join(L.app, "pi-packages", "node_modules");
  if (existsSync(bundled)) {
    mkdirSync(join(L.piAgentDir, "npm", "node_modules"), { recursive: true });
    for (const entry of readdirSync(bundled)) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@") ? readdirSync(join(bundled, entry)).map((n) => `${entry}/${n}`) : [entry];
      for (const name of names) {
        const dest = join(L.piAgentDir, "npm", "node_modules", name);
        mkdirSync(join(dest, ".."), { recursive: true });
        try {
          unlinkSync(dest);
        } catch {}
        if (!existsSync(dest)) symlinkSync(join(bundled, name), dest);
      }
    }
  }
  for (const spec of DEFAULT_PI_PACKAGES) {
    const name = spec.replace(/^npm:/, "").replace(/@[^@/]+$/, "");
    const src = join(L.app, "pi-packages", "node_modules", name);
    if (!existsSync(src)) continue;
    const dest = join(L.piAgentDir, "npm", "node_modules", name);
    mkdirSync(join(dest, ".."), { recursive: true });
    try {
      unlinkSync(dest);
    } catch {}
    if (!existsSync(dest)) symlinkSync(src, dest);
    linked.push(name);
  }
  return { settingsPath, linked };
}

/** ~/.dinobot/libexec/npm -> the bundled npm (null when the tarball has none). Node first on its PATH. */
export function writeNpmWrapper(L) {
  const npmCli = join(L.app, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) return null;
  const path = join(L.root, "libexec", "npm");
  mkdirSync(join(L.root, "libexec"), { recursive: true });
  writeFileAtomic(path, `#!/bin/sh\nexport PATH="${join(L.app, "node", "bin")}:$PATH"\nexec "${L.node}" "${npmCli}" "$@"\n`, 0o755);
  return path;
}

/** Saves an API key into pi's auth.json (mode 600), keeping other providers. */
export function savePiCredential(L, provider, credential) {
  const path = join(L.piAgentDir, "auth.json");
  const auth = readJson(path, {}) ?? {};
  auth[provider] = credential;
  mkdirSync(L.piAgentDir, { recursive: true, mode: 0o700 });
  writeJson(path, auth, 0o600);
  return path;
}
