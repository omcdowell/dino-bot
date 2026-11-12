#!/usr/bin/env node
// dinobot: setup wizard (Design B) and small host commands. Run by install.sh with the bundled
// Node (`--experimental-transform-types`, so the bundled plugin's .ts tables load directly).
//
//   dinobot setup [--name N] [--yes] [--answers JSON] [--service systemd|launchd|none]
//                  [--port P] [--no-herdr] [--tailscale-embed]
//   dinobot pair | status | doctor [--json] | update [--check] [--tarball F|--url U]
//   dinobot start | stop | uninstall [--purge] | import-status
//   dinobot herdr-gc --session S [--apply] [--ttl-hours H]
//   dinobot wsl-autostart [--off]       (Windows/WSL: start Ubuntu at sign-in and keep it running)
//   dinobot push [status] | enable (--key-path P --key-id K --team-id T --topic B | --local) | disable | test
//                                       (optional push add-on, off by default: docs/live-activities.md)
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createStarterBot, STARTER, trashBot } from "./bots.mjs";
import { DEFAULT_PI_PACKAGES, HERDR_SESSION, listenHost, listenPlan, writePiSetup, probeHostFor, readEnvFile, savePiCredential, writeBotsSettings, writeDaemonConfig, writeDaemonEnv, writeWrappers } from "./config.mjs";
import { detectSignIns, detectTailscale, foreignTailscale, freePort, fullName, onBattery, platform, tailscaleUsable } from "./detect.mjs";
import { detectWsl, windowsDriveProblems, wslAutostart, wslSetupNotes } from "./wsl.mjs";
import { TailscaleRequired, tailscaleSteps } from "./tailscale.mjs";
import { herdrGc, waitForSession } from "./herdr.mjs";
import { doctor } from "./doctor.mjs";
import { waitForAnswers, waitForReady } from "./ready.mjs";
import { update } from "./update.mjs";
import { importStatus, linkOptchatPeers, scanHistory, startImport } from "./importer.mjs";
import { buildOffer, daemonIdentity, desktopPairLines, offerEndpoints, offerUrl, renderQr } from "./offer.mjs";
import { serviceMode, startServices, stopServices, uninstallServices, waitForClosed, waitForListen, writeServices } from "./service.mjs";
import { defaultOption, loadModelDefaults, signIn, signInOptions } from "./signin.mjs";
import { providerOverrides } from "./provider-overrides.mjs";
import { SETUP_FLOW } from "./flow.mjs";
import { fmt, layout, PRODUCT, PRODUCT_ID, Prompter, readJson, Timer, writeJson } from "./util.mjs";
import { disablePush, enablePush, pushEndpoint, pushState } from "./push.mjs";
import { addProvider, listProviders, parseProviderLink, providerLink, removeProvider, updateProviders } from "./providers.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a.includes("=")) out[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !BOOL_FLAGS.has(a.slice(2))) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}
const BOOL_FLAGS = new Set(["off", "link", "yes", "no-herdr", "tailscale-embed", "purge", "apply", "json", "check", "signin-here", "local", "no-restart"]);

/** How long setup waits at a terminal for the user to install / turn on Tailscale. 0: stop at once. */
const TAILSCALE_WAIT_MS = 20 * 60_000;
const say = (s = "") => process.stdout.write(`${s}\n`);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

// ------------------------------------------------------------------ setup
export async function setup(args, env = process.env) {
  const L = layout(env);
  const t0 = Number(env.DINOBOT_T0_MS) || Date.now();
  const timer = new Timer(t0);
  if (env.DINOBOT_FETCH_MS) timer.steps.push({ step: "download + unpack (install.sh)", ms: Number(env.DINOBOT_FETCH_MS), atMs: Number(env.DINOBOT_FETCH_MS) });
  const answers = args.answers ? JSON.parse(args.answers) : {};
  const prompter = new Prompter({ answers, assumeYes: Boolean(args.yes) });
  const plat = platform();
  const wsl = await detectWsl({ env });
  plat.wsl = wsl;
  if (wsl?.version === 1) throw new Error(`this Ubuntu runs on WSL 1, which cannot run Tailscale. In Windows PowerShell run:  wsl --set-version ${wsl.distro ?? "<distro>"} 2   then run the install command again.`);
  // Windows drives (/mnt/c): no Unix file modes (the password file would be readable by everyone)
  // and slow for the many small files bots write.
  const onWindowsDrive = wsl ? windowsDriveProblems(L) : [];
  if (onWindowsDrive.some((p) => p.what !== "bots")) throw new Error(`${onWindowsDrive.map((p) => p.path).join(", ")} is on a Windows drive (/mnt/…), which cannot keep ${PRODUCT}'s password private and is slow. Install from Ubuntu's own home folder (cd ~), without DINOBOT_HOME on /mnt.`);
  const mode = serviceMode(plat, args.service);
  const herdrOn = !args["no-herdr"] && existsSync(join(L.app, "herdr", "herdr"));
  const notes = [];
  // Sign-in and import happen on the phone after pairing (SETUP_FLOW), unless asked here.
  const signInHere = SETUP_FLOW.signIn === "terminal" || Boolean(args["signin-here"]);
  const importHere = SETUP_FLOW.import === "terminal";

  // 0. Tailscale is required (tailnet-only daemon). Without it: stop here with the steps, before
  // anything is started or an existing daemon is stopped. The wrappers are written first so the
  // "then run" command in the steps exists.
  let tailscale = await detectTailscale({ env, wsl });
  if (args["tailscale-embed"]) notes.push("Embedded Tailscale (tsnet sidecar) is not built yet: using the system Tailscale.");
  if (!tailscaleUsable(tailscale)) {
    writeWrappers(L);
    const name = args.name ? ` --name ${JSON.stringify(String(args.name))}` : "";
    const steps = tailscaleSteps(tailscale, { os: plat.os, wsl, rerun: `${join(L.bin, PRODUCT_ID)} setup${name}` });
    // At a terminal: show the steps and carry on by itself once Tailscale is up (rel-flow R3.3).
    if (!process.stdout.isTTY || args.yes || !TAILSCALE_WAIT_MS) throw new TailscaleRequired(steps);
    say("");
    for (const l of tailscaleSteps(tailscale, { os: plat.os, wsl, waiting: true })) say(l);
    say("");
    const t = Date.now();
    let last = "";
    while (!tailscaleUsable(tailscale)) {
      const line = !tailscale.installed || tailscale.windows ? "waiting for Tailscale to be installed" : `Tailscale is ${tailscale.state ?? "off"}: waiting for it to connect`;
      if (line !== last) say(dim(`… ${line} (I'll carry on by myself; Ctrl-C is fine too)`));
      last = line;
      if (Date.now() - t > TAILSCALE_WAIT_MS) throw new TailscaleRequired(steps);
      await new Promise((r) => setTimeout(r, 2000));
      tailscale = await detectTailscale({ env, wsl });
    }
    say(`✓ Tailscale is on: your iPhone can reach this computer at ${tailscale.dnsName ?? tailscale.ip}.`);
    timer.mark("Tailscale set up by the user (waited)");
  }
  // macOS: the system Tailscale signed in by another person (their menu-bar app, not ours) is their
  // tailnet. Refuse instead of putting this daemon and its QR there.
  const foreign = await foreignTailscale({ env, tailscale, os: plat.os });
  if (foreign) throw new Error(foreignTailscaleMessage(foreign, tailscale));

  // Re-run: keep the port, stop the old daemon so the new env applies.
  const previous = readJson(L.state);
  if (previous?.port && !args.port) {
    args.port = previous.port;
    await stopServices(L, previous.serviceMode ?? mode).catch(() => {});
    await waitForClosed(previous.port, 20_000, probeHostFor(previous.listen));
  }
  // A preferred port from the environment (DINOBOT_PORT), e.g. a second install on one machine.
  if (!args.port && env.DINOBOT_PORT) args.port = Number(env.DINOBOT_PORT);

  // 1. Detect everything at once (no user time).
  const [signIns, osName, port] = await Promise.all([
    Promise.resolve(detectSignIns({ piAgentDir: L.piAgentDir, userPiDir: L.userPiDir, home: L.home, env })),
    args.name ? Promise.resolve(String(args.name)) : fullName({ env }),
    args.port ? Promise.resolve(Number(args.port)) : freePort(6767, [listenHost({ tailscale }), "0.0.0.0"]),
  ]);
  timer.mark("detect Tailscale, sign-ins, name, port");
  const plan = listenPlan({ tailscale, port });
  if (plan.userspace) notes.push(`Your Tailscale runs in userspace (${tailscale.ip} is not on this computer's network interfaces): ${PRODUCT} listens on ${plan.listen}, and your tailscaled hands it your tailnet's connections. Note: a userspace tailscaled forwards your tailnet to every 127.0.0.1 port on this computer, so ${PRODUCT} treats connections from 127.0.0.1 like ones from the network: the app must use its encrypted connection, and only your own ${PRODUCT} tools (they read the daemon's local credential, private to your account) connect without it.`);
  notes.push(`Reachable over Tailscale only (${tailscale.dnsName ?? plan.listen}): your iPhone (or the computer with the ${PRODUCT} desktop app) needs Tailscale on, with the same account.`);
  if (onWindowsDrive.length) notes.push(`Your bots folder ${L.botsRoot} is on a Windows drive: slow, and its files are readable by every Windows program. Better: PASEO_BOTS_ROOT inside Ubuntu (the default ~/bots).`);
  if (onBattery()) notes.push("This laptop is on battery: if it sleeps, your bots go offline. Consider keeping it on power.");

  // 2. Model defaults from what was found (rel-import table; no model question).
  const md = await loadModelDefaults(L.app);
  let subscription = md.pickSubscription(signIns.found.map((f) => f.subscription));
  const using = signIns.found.find((f) => f.subscription === subscription);
  if (using?.key) {
    savePiCredential(L, using.provider, { type: "api_key", key: using.key });
    notes.push(`Saved your ${using.provider} API key (from ${using.source.replace(/^env /, "")}) for ${PRODUCT} (${join(L.piAgentDir, "auth.json")}, private to you).`);
  }
  let models = subscription ? md.resolveModels(subscription) : null;

  // 3. Name (Q2; usually asked by install.sh during the download and passed as --name).
  const userName = args.name ? String(args.name) : prompter.ask("name", "What should your bots call you?", osName);

  // 4. Write everything, starter bot included (suggested; un-tick it below to skip).
  const wrappers = writeWrappers(L);
  writePiSetup(L);
  linkOptchatPeers(L);
  const endpoints = offerEndpoints({ port, tailscale });
  const daemonEnv = writeDaemonEnv(L, { port, listen: plan.listen, directEndpoints: endpoints.filter((e) => !/^\d/.test(e)), userspace: Boolean(plan.userspace) });
  const mainModel = models ? `${models.main.provider}/${models.main.model}` : null;
  writeDaemonConfig(L, { mainModel, thinking: models?.main.thinking ?? null });
  const identity = await daemonIdentity(L.app, L.paseoHome);
  const wantStarter = answers.extras === undefined || String(answers.extras).split(",").includes("coordinator");
  let starter = null;
  if (wantStarter) starter = await createStarterBot(L, { models, subscription });
  writeBotsSettings(L, { userName, escalation: starter?.botId ?? null, defaultModel: mainModel });
  timer.mark("write config, settings, starter bot");

  // 5. Start the daemon (and the separate herdr server) and show the QR as soon as it listens.
  writeServices(L, mode);
  notes.push(...(await startServices(L, mode, { herdr: herdrOn })));
  notes.push(...wslSetupNotes({ wsl, mode, port, tailscale, bin: L.bin }));
  const daemonLog = mode === "systemd" ? `journalctl --user -u ${PRODUCT_ID}` : join(L.logs, "daemon.log");
  const listening = await waitForListen(port, 90_000, plan.probeHost);
  if (!listening) throw new Error(`The daemon did not start on ${plan.listen}. Log: ${daemonLog}`);
  timer.mark("daemon listening");
  // Listening is not enough: WebSocket clients get "503 not ready" until the plugins have loaded,
  // which the app shows as DAEMON_UNREACHABLE. Show the QR only once it accepts them.
  const ready = await waitForReady({ port, host: plan.probeHost, password: daemonEnv.PASEO_PASSWORD, timeoutMs: 90_000 });
  if (!ready.ready) throw new Error(`The daemon listens on ${plan.listen} but never became ready (last answer ${ready.lastStatus || "none"}). Log: ${daemonLog}`);
  timer.mark("daemon ready (accepts the app)", { probes: ready.probes });
  const roundTrip = await waitForAnswers({ paseoBin: join(L.bin, "paseo"), endpoint: plan.listen, password: daemonEnv.PASEO_PASSWORD, paseoHome: L.paseoHome, home: L.home, trustLoopback: daemonEnv.PASEO_TRUST_LOOPBACK });
  if (!roundTrip.ok) notes.push(`The ${PRODUCT} server is slow to answer (${roundTrip.last}); if the app cannot connect at first, wait a minute and scan again.`);
  timer.mark("daemon answers requests", { tries: roundTrip.tries });
  const offer = buildOffer({ ...identity, endpoints, password: daemonEnv.PASEO_PASSWORD });
  const url = offerUrl(offer);
  say("");
  say(await renderQr(L.app, url));
  say(bold(`Scan this with the ${PRODUCT} app on your phone.`));
  for (const line of desktopPairLines(L, { product: PRODUCT, productId: PRODUCT_ID })) say(line);
  say(dim(`Addresses tried in order: ${endpoints.join(", ")}`));
  say(dim("This code contains this computer's password: don't share a photo of it."));
  timer.mark("QR shown", { milestone: true });

  // Herdr: separate session for workers, started by the service; check it in the background.
  // First start on a Mac can take >8 s (the system checks the new binary), so allow 25 s.
  const herdrReady = herdrOn ? waitForSession(join(L.bin, "herdr"), HERDR_SESSION, 25_000) : Promise.resolve(null);

  // 6. Sign-in only if nothing usable was found (Q1).
  let restart = false;
  if (!subscription && !signInHere) {
    say("");
    say(bold(`Next, in the ${PRODUCT} app (phone or desktop): sign in for your bots and choose their models.`));
    say(dim(`${PRODUCT} shows the choices right after pairing. (Prefer this terminal? Run \`${PRODUCT_ID} setup --signin-here\`.)`));
  } else if (!subscription) {
    const options = await signInOptions(L.app, process.env, { overrides: await providerOverrides(L).catch(() => []) });
    const def = defaultOption(options, signIns);
    say("");
    say(bold("No AI sign-in found on this computer. Pick one for your bots:"));
    const list = options.map((o) => ({ id: o.id, label: o.badge ? `${o.label}  [${o.badge}]` : o.label, note: o.note }));
    let option = options.find((o) => o.id === prompter.choose("signin", "Sign in with", list, def.id)) ?? def;
    try {
      let done;
      try {
        done = await signIn(L, option, prompter);
      } catch (e) {
        if (!option.confirm || !/not confirmed/.test(e.message)) throw e;
        // Said no to the extra-usage warning: one more pick, without that option.
        const rest = list.filter((o) => o.id !== option.id);
        option = options.find((o) => o.id === prompter.choose("signin:again", "Sign in with", rest, def.id)) ?? def;
        done = await signIn(L, option, prompter);
      }
      subscription = done.subscription;
      models = md.resolveModels(subscription);
      const main = `${models.main.provider}/${models.main.model}`;
      writeDaemonConfig(L, { mainModel: main, thinking: models.main.thinking });
      writeBotsSettings(L, { userName, escalation: starter?.botId ?? null, defaultModel: main });
      if (starter?.created) {
        await createStarterBot(L, { models, subscription }).catch(() => null); // no-op if present
        writeJson(join(L.optchatHome, "profiles", starter.botId, "config.json"), { subscription, compactor: models.compaction, subagent: models.worker, setup: true }, 0o600);
        const meta = readJson(join(L.botsRoot, starter.botId, ".bot.json"), {});
        writeJson(join(L.botsRoot, starter.botId, ".bot.json"), { ...meta, chat: { provider: `optchat/${main}`, thinkingOptionId: models.main.thinking, setup: true } }, 0o600);
      }
      restart = true;
    } catch (e) {
      notes.push(`Sign-in did not finish (${e.message}). Sign in later from the app, or run \`${PRODUCT_ID} setup\` again.`);
    }
    timer.mark("model sign-in");
  } else {
    say(dim(`Using your ${md.MODEL_DEFAULTS[subscription].label} sign-in (${using?.source ?? "pi"}). Bots: ${mainModel}.`));
  }

  // 7. Extras on one screen (Q3): starter bot (on) and chat import (off, with the warning).
  const scan = subscription && starter ? await scanHistory(L, subscription) : null;
  timer.mark("scan past chats (read-only)");
  const items = [];
  if (starter) items.push({ id: "coordinator", on: true, label: `Starter coordinator bot "${STARTER.name}" (suggested; it gets escalations, you can remove it any time)` });
  if (importHere && scan?.ok && scan.messages > 0) items.push({ id: "import", on: false, label: `Import your past chats into ${STARTER.name} (${scan.messages.toLocaleString("en")} messages, runs in the background)`, detail: scan.warning });
  let extras = { coordinator: Boolean(starter), import: false };
  // Phone flow: no terminal checklist (the starter bot is on; import is a phone step, off by default).
  if (items.length && (signInHere || importHere || answers.extras !== undefined)) extras = { ...extras, ...prompter.checklist("extras", "Extras:", items) };
  if (starter && !extras.coordinator) {
    const where = trashBot(L, starter.botId);
    writeBotsSettings(L, { userName, escalation: null, defaultModel: models ? `${models.main.provider}/${models.main.model}` : null });
    notes.push(`Starter bot skipped (files kept in ${where}). Create bots from the app; escalations go straight to you.`);
    starter = null;
    restart = true;
  }
  timer.mark("extras");
  if (restart) {
    await startServices(L, mode, { herdr: false, restart: true });
    await waitForListen(port, 90_000, plan.probeHost);
    await waitForReady({ port, host: plan.probeHost, password: daemonEnv.PASEO_PASSWORD, timeoutMs: 90_000 });
    timer.mark("daemon restart (settings changed)");
  }
  let importInfo = null;
  if (extras.import && starter) {
    importInfo = await startImport(L, starter.botId);
    notes.push(importInfo.ok ? `Chat import of ${scan.messages.toLocaleString("en")} messages (about $${Math.round(scan.usd)} at API prices, ~${Math.max(1, Math.round(scan.hours))} h) running in the background (log ${importInfo.log}). \`dinobot import-status\` shows progress.` : `Chat import did not start: ${importInfo.error}`);
  }
  const herdrInfo = await herdrReady;
  const herdrErr = lastLine(join(L.logs, "herdr.log"));
  if (herdrOn) notes.push(herdrInfo ? `Workers: separate herdr session "${HERDR_SESSION}" running.` : `Workers: herdr session "${HERDR_SESSION}" is still starting${/error/i.test(herdrErr) ? ` (${herdrErr})` : ""}; \`${PRODUCT_ID} doctor\` checks it.`);
  else notes.push("Workers: herdr not bundled; workers stay off until it is installed.");
  timer.mark("background steps started");

  const state = {
    version: 1,
    product: PRODUCT,
    installedAt: new Date().toISOString(),
    port,
    listen: plan.listen,
    serviceMode: mode,
    ...(wsl ? { wsl: { version: wsl.version, distro: wsl.distro, networking: wsl.networking, tailscale: tailscale.windows ? "windows" : "linux" } } : {}),
    herdrSocketDir: wrappers.herdrSocketDir,
    tarballSha256: env.DINOBOT_TARBALL_SHA || previous?.tarballSha256 || null,
    // Which archive that checksum is of (install.sh: zst when this computer has zstd, else gz);
    // `update` fetches the same kind, so "up to date" compares like with like.
    tarballFormat: (env.DINOBOT_TARBALL_SHA ? env.DINOBOT_TARBALL_FORMAT : previous?.tarballFormat) || "gz",
    downloadBaseUrl: env.DINOBOT_BASE_URL || previous?.downloadBaseUrl || null,
    downloadRoute: env.DINOBOT_SOURCE_MODE || previous?.downloadRoute || null, // install.sh MODE: url | file | tarball
    subscription: subscription ?? null,
    starterBot: starter?.botId ?? null,
    herdrSession: herdrOn ? HERDR_SESSION : null,
    endpoints,
    questionsAsked: prompter.asked,
    // Questions in this run: the name (install.sh, or here) plus the wizard's (sign-in only when
    // nothing was found; key/code prompts belong to the sign-in question).
    questions: ["name", ...prompter.shown.filter((q) => q !== "name" && !q.includes(":"))],
    timings: timer.steps,
    totalMs: timer.elapsedMs,
  };
  writeJson(L.state, state, 0o600);
  say("");
  for (const n of notes) say(`• ${n}`);
  say("");
  say(dim(`Setup steps (since the install command started):\n${timer.table()}`));
  say(bold(`Done in ${fmt(timer.elapsedMs)}. Show the code again: ${join(L.bin, PRODUCT_ID)} pair`));
  if (!subscription && !signInHere && SETUP_FLOW.waitForPhoneMs > 0 && !args.yes && process.stdout.isTTY) {
    await waitForPhone(L, SETUP_FLOW.waitForPhoneMs);
  }
  return state;
}

/** Why setup stopped at someone else's system Tailscale, and the two ways on. */
export function foreignTailscaleMessage({ owners }, tailscale) {
  return [
    `the Tailscale on this Mac is signed in by another macOS user (${owners.join(", ")}), so your bots and pairing code would land on their Tailscale${tailscale?.dnsName ? ` (${tailscale.dnsName})` : ""}. Nothing was started.`,
    "To run your own Tailscale next to theirs, see docs/shared-mac.md (Two people on one Mac). In short: start your own tailscaled, then run setup again with:",
    "  export DINOBOT_TAILSCALE_BIN=<your tailscale CLI> DINOBOT_TAILSCALE_SOCKET=<your tailscaled.sock> DINOBOT_PORT=<a free port>",
    "If this Tailscale really is yours, set DINOBOT_TAILSCALE_BIN to its CLI (e.g. /usr/local/bin/tailscale) and run setup again.",
  ].join("\n");
}

/** After the QR: say when the phone has signed in and chosen models (Ctrl-C is fine). */
async function waitForPhone(L, ms) {
  const { readyProviders } = await import("./phone-signin.mjs");
  say("");
  say(dim(`Waiting for the ${PRODUCT} app: pair, sign in, choose models. (Ctrl-C is fine: everything keeps running.)`));
  const end = Date.now() + ms;
  let signedIn = false;
  while (Date.now() < end) {
    if (!signedIn) {
      const ready = await readyProviders(L).catch(() => []);
      if (ready.length) {
        signedIn = true;
        say(`✓ Signed in from the app (${ready.join(", ")}; checked with pi auth check).`);
      }
    }
    const models = readJson(L.state)?.models;
    if (signedIn && models) {
      for (const [role, m] of Object.entries(models)) if (m) say(`✓ ${role.padEnd(10)} ${m.provider}/${m.model}${m.thinking ? ` · ${m.thinking}` : ""}`);
      say(bold("Your bots are ready. Say hello to your first bot in the app."));
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  say(dim("Still waiting for the phone; finish there whenever you like."));
}

function lastLine(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").pop().slice(0, 160);
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ other commands
async function pair(L, { link = false } = {}) {
  const state = readJson(L.state);
  if (!state) throw new Error("Not set up yet: run the installer first.");
  const env = readEnvFile(L.envFile);
  const wsl = await detectWsl();
  const tailscale = await detectTailscale({ wsl });
  if (!tailscaleUsable(tailscale)) {
    for (const l of tailscaleSteps(tailscale, { wsl, rerun: `${join(L.bin, PRODUCT_ID)} pair` })) say(l);
    process.exitCode = 2;
    return;
  }
  const endpoints = offerEndpoints({ port: state.port, tailscale });
  const identity = await daemonIdentity(L.app, L.paseoHome);
  const url = offerUrl(buildOffer({ ...identity, endpoints, password: env.PASEO_PASSWORD }));
  // --link: the pairing link as text, for the app's "Paste pairing link" (no camera). It holds
  // the password, like the QR: send it only to yourself.
  if (link) return say(url);
  say(await renderQr(L.app, url));
  for (const line of desktopPairLines(L, { product: PRODUCT, productId: PRODUCT_ID })) say(line);
  say(dim(`Addresses: ${endpoints.join(", ")}`));
}

async function status(L) {
  const state = readJson(L.state);
  if (!state) return say("Not set up.");
  const env = readEnvFile(L.envFile);
  const up = (await waitForReady({ port: state.port, host: probeHostFor(env.PASEO_LISTEN), timeoutMs: 1500 })).ready;
  const herdr = state.herdrSession ? await waitForSession(join(L.bin, "herdr"), state.herdrSession, 1500) : null;
  say(`daemon   ${up ? "ready" : "DOWN"} on ${env.PASEO_LISTEN ?? state.port} (${state.serviceMode})`);
  say(`herdr    ${state.herdrSession ? (herdr ? `session ${state.herdrSession} running` : `session ${state.herdrSession} DOWN`) : "off"}`);
  say(`sign-in  ${state.subscription ?? "none"}`);
  say(`starter  ${state.starterBot ?? "none"}`);
}

// ------------------------------------------------------------------ provider plugins
// dinobot provider add [<source>|<invite link>] [--token T] [--yes] | list | remove <source>
//                  | update | link <source> [--token T] [--name N]   (the owner makes an invite)
async function provider(L, args) {
  const [, sub = "list", arg] = args._;
  const prompter = new Prompter({ assumeYes: Boolean(args.yes) });
  if (sub === "list") {
    const rows = listProviders(L, DEFAULT_PI_PACKAGES);
    if (!rows.length) return say("No provider plugins. Built-in sign-ins (ChatGPT, Copilot, Claude, API keys) need none.");
    for (const r of rows) say(`${r.source}${r.bundled ? dim("  (bundled)") : ""}`);
    return sayClaudeViaPlugin(L);
  }
  if (sub === "link") {
    // Printed only; the token is the owner's per-person read-only one (see providers.mjs).
    return say(providerLink({ source: arg, token: args.token ?? null, name: args.name ?? null }));
  }
  if (sub === "update") {
    const r = await updateProviders(L);
    say((r.stdout || r.stderr).trim());
    if (r.code !== 0) process.exitCode = 1;
    return sayClaudeViaPlugin(L); // also refreshes the saved answer the phone's sign-in list uses
  }
  if (sub === "remove") {
    const r = await removeProvider(L, arg);
    return say(`Removed ${r.removed}. New bot chats and workers no longer load it.`);
  }
  if (sub !== "add") throw new Error(`unknown: ${PRODUCT_ID} provider ${sub} (add | list | remove | update | link)`);
  // A pasted invite link keeps the token out of shell history; a source plus --token also works.
  const input = arg ?? prompter.ask("provider", "Paste the provider link (or a package source)");
  const req = /^[a-z][a-z0-9+.-]*:\/\/provider\//i.test(String(input)) ? parseProviderLink(input) : { source: input, token: args.token ?? null, name: null };
  say(`${req.name ? `${req.name}: ` : ""}${req.source}`);
  say(dim("A provider plugin is code that runs on this computer with your bots' access. Only add ones from people you trust."));
  const ok = prompter.ask("confirm", "Add it? (y/N)", args.yes ? "y" : "n");
  if (!/^y/i.test(ok)) return say("Not added.");
  const done = await addProvider(L, req);
  say(`Added ${done.source}. New bot chats and workers use it now; for chats already open: ${PRODUCT_ID} stop && ${PRODUCT_ID} start.`);
  await sayClaudeViaPlugin(L);
}

/** When an added plugin replaces pi's Claude (anthropic) provider, say so (same words as the sign-in list). */
async function sayClaudeViaPlugin(L) {
  const claude = (await providerOverrides(L, { fresh: true }).catch(() => [])).find((o) => o.provider === "anthropic");
  if (claude) say(`Claude login: uses your Claude plan through ${claude.plugin} (unofficial; Anthropic's terms risk).`);
}

// ------------------------------------------------------------------ push add-on (optional)
// Off unless turned on here: for people who build the iPhone app with their own Apple developer
// account (docs/live-activities.md). lib/push.mjs does the work; this restarts the daemon after.
async function push(L, args) {
  const [, sub = "status"] = args._;
  const doc = `docs/live-activities.md in the ${PRODUCT} repo`;
  if (sub === "status") {
    const st = pushState(L);
    if (!st.enabled) {
      say(`Push and Live Activities: off${st.bundled ? "" : " (this install has no push add-on)"}.`);
      return say(dim(`They need an iPhone app you build with your own Apple developer account; see ${doc}.`));
    }
    say(`Push and Live Activities: on, ${st.mode === "local" ? "local mode (no remote push: the Live Activity updates while the app is open)" : `your own key, app ${st.topic}`}`);
    say(`phones   ${st.phones} registered`);
    say(`files    ${st.dir}`);
    const r = await pushEndpoint(L);
    if (r.body?.ok) say(`add-on   answering on 127.0.0.1:${st.port}${st.mode !== "local" && r.body.configured === false ? ` but not configured (${r.body.configError ?? "see config.json"})` : ""}`);
    else say(`add-on   ${r.message ?? `answered ${r.status}`}`);
    return;
  }
  if (sub === "test") {
    const r = await pushEndpoint(L, { test: true });
    if (r.ok) return say(`Sent a test push to ${r.body?.sent ?? 0} phone(s).`);
    process.exitCode = 1;
    return say(r.message ?? `Not sent: ${r.body?.code ?? r.status}${r.body?.message ? ` (${r.body.message})` : ""}`);
  }
  if (sub !== "enable" && sub !== "disable") throw new Error(`unknown: ${PRODUCT_ID} push ${sub} (status | enable | disable | test)`);
  if (sub === "enable") {
    const done = enablePush(L, { local: Boolean(args.local), keyPath: args["key-path"], keyId: args["key-id"], teamId: args["team-id"], topic: args.topic, port: args.port });
    say(done.config.mode === "local" ? "Push add-on on, local mode: no remote push; the Live Activity updates while the app is open." : `Push add-on on for app ${done.config.topic} (key ${done.config.keyId}, read only when a push is signed).`);
    if (done.keyMode !== null && (done.keyMode & 0o077) !== 0) say(`Your key file can be read by other users of this computer: chmod 600 ${done.config.keyPath}`);
  } else {
    const r = disablePush(L);
    say(r.changed ? `Push add-on off. Its files stay in ~/.${PRODUCT_ID}/apns; \`${PRODUCT_ID} push enable\` turns it on again.` : "Push add-on is already off.");
  }
  const state = readJson(L.state);
  if (!state || args["no-restart"]) return say(`Restart ${PRODUCT} to apply: ${PRODUCT_ID} stop && ${PRODUCT_ID} start`);
  await startServices(L, state.serviceMode, { herdr: false, restart: true });
  say(`${PRODUCT} restarted.${sub === "enable" ? ` Open the app on your phone, then check: ${PRODUCT_ID} push status` : ""}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd = "setup"] = args._;
  const L = layout();
  switch (cmd) {
    case "setup":
      return setup(args);
    case "pair":
      return pair(L, { link: Boolean(args.link) });
    case "status":
      return status(L);
    case "doctor": {
      const r = await doctor(L, { json: Boolean(args.json) });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "update": {
      const r = await update(L, { check: Boolean(args.check), tarball: args.tarball, url: args.url });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "start":
    case "stop": {
      const state = readJson(L.state);
      const mode = state?.serviceMode ?? serviceMode(platform());
      if (cmd === "stop") return stopServices(L, mode);
      return startServices(L, mode, { herdr: Boolean(state?.herdrSession) });
    }
    case "uninstall": {
      const state = readJson(L.state);
      const mode = state?.serviceMode ?? serviceMode(platform());
      await stopServices(L, mode);
      await uninstallServices(L, mode, { session: state?.herdrSession ?? HERDR_SESSION });
      if (state?.herdrSocketDir) rmSync(state.herdrSocketDir, { recursive: true, force: true });
      if (args.purge) rmSync(L.root, { recursive: true, force: true });
      else rmSync(L.app, { recursive: true, force: true });
      return say(`Removed the ${PRODUCT} services${args.purge ? ` and ~/.${PRODUCT_ID}` : " and app"}. Your bots (${L.botsRoot}) and memories (${L.optchatHome}) are kept.`);
    }
    case "claude-code": {
      const { installClaudeCode, sdkStatus } = await import("./claude-code.mjs");
      if (args._[1] === "install") return installClaudeCode(L);
      const st = sdkStatus(L);
      return say(st.installed ? `Claude Agent SDK ${st.version} installed.` : `Claude Code agent: not installed (${PRODUCT} does not ship Anthropic's SDK). Install it with: ${PRODUCT_ID} claude-code install`);
    }
    case "import-status": {
      const state = readJson(L.state);
      return say(state?.starterBot ? await importStatus(L, state.starterBot) : "No import.");
    }
    case "provider":
      return provider(L, args);
    case "push":
      return push(L, args);
    case "wsl-autostart": {
      if (!(await detectWsl())) throw new Error("wsl-autostart is for Windows (WSL) only.");
      return wslAutostart(L, { off: Boolean(args.off) });
    }
    case "herdr-gc": {
      const r = await herdrGc({ herdrBin: join(L.bin, "herdr"), session: args.session ?? HERDR_SESSION, apply: Boolean(args.apply), ttlHours: Number(args["ttl-hours"] ?? 48), logDir: L.logs });
      say(JSON.stringify(r.ok ? { closed: r.report.close.length, kept: r.report.keep.length, apply: r.report.apply } : r));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

// Real paths on both sides: on macOS /tmp is a symlink to /private/tmp and import.meta.url is the
// resolved path, so a plain string compare silently skipped main() for installs under /tmp.
function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMain()) {
  // `dinobot status | head`: the reader may close the pipe before we are done writing. That is
  // not an error; stop quietly instead of an unhandled EPIPE stack trace.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e) => {
      if (e?.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw e;
    });
  }
  main().catch((e) => {
    if (e instanceof TailscaleRequired) {
      process.stdout.write(`\n${e.steps.join("\n")}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`\n${PRODUCT} setup stopped: ${e.message}\n`);
    process.exitCode = 1;
  });
}
