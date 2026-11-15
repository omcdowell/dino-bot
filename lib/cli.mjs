#!/usr/bin/env node
// dinobot: setup wizard (Design B) and small host commands. Run by install.sh with the bundled
// Node (`--experimental-transform-types`, so the bundled plugin's .ts tables load directly).
//
//   dinobot setup [--name N] [--yes] [--answers JSON] [--service systemd|launchd|none]
//                  [--port P] [--no-herdr] [--verbose]
//   dinobot | dinobot help              (what there is; setup runs only as `dinobot setup`)
//   dinobot signin [<provider>] [--api-key] | signin --list   (sign in to one AI provider; no setup)
//   dinobot devices [--revoke <n|clientId>] [--revoke-all]   (paired devices; unpair)
//   dinobot pair | status | doctor [--json] | update [--check] [--tarball F|--url U]
//   dinobot start | stop | uninstall [--yes] | uninstall --purge [--yes] | import-status
//   dinobot post-update                 (internal: run by `update` with the NEW version's code)
//   dinobot herdr-gc --session S [--apply] [--ttl-hours H]
//   dinobot claude-code install | install-cli   (Agent SDK from npm | the `claude` CLI, Anthropic's installer)
//   dinobot wsl-autostart [--off]       (Windows/WSL: start Ubuntu at sign-in and keep it running)
//   dinobot push [status] | enable (--key-path P --key-id K --team-id T --topic B | --local) | disable | test
//                                       (optional push add-on, off by default: docs/live-activities.md)
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createStarterBot, STARTER, trashBot } from "./bots.mjs";
import { DEFAULT_PI_PACKAGES, HERDR_SESSION, listenHost, listenPlan, writePiSetup, probeHostFor, readEnvFile, savePiCredential, writeBotsSettings, writeDaemonConfig, writeDaemonEnv, writeWrappers } from "./config.mjs";
import { detectSignIns, detectTailscale, foreignTailscale, freePort, fullName, platform, sleepNote, tailscaleUsable } from "./detect.mjs";
import { installEnvPath, loadInstallEnv, saveInstallEnv } from "./install-env.mjs";
import { postUpdate } from "./post-update.mjs";
import { detectWsl, windowsDriveProblems, wslAutostart, wslSetupNotes } from "./wsl.mjs";
import { TailscaleRequired, tailscaleSteps } from "./tailscale.mjs";
import { herdrGc, waitForSession } from "./herdr.mjs";
import { doctor } from "./doctor.mjs";
import { waitForAnswers, waitForReady } from "./ready.mjs";
import { update } from "./update.mjs";
import { importStatus, linkOptchatPeers, scanHistory, startImport } from "./importer.mjs";
import { daemonIdentity, desktopPairLines, offerEndpoints, offerUrl, pairedDevices, pairingCodeNote, pairingOffer, renderQr, revokeDevices } from "./offer.mjs";
import { clearPhoneSteps, waitForPhone as waitForPhoneReady } from "./phone-ready.mjs";
import { removeQrPng, showPairingQr, withQrGuard } from "./qr.mjs";
import { serviceMode, startServices, stopServices, waitForClosed, waitForListen, writeServices } from "./service.mjs";
import { uninstall } from "./uninstall.mjs";
import { commandName, ensurePathLink } from "./path-link.mjs";
import { chooseAndSignIn, defaultOption, findOption, loadModelDefaults, signIn, signInOptions } from "./signin.mjs";
import { providerOverrides } from "./provider-overrides.mjs";
import { SETUP_FLOW } from "./flow.mjs";
import { fmt, layout, PRODUCT, PRODUCT_ID, Prompter, readJson, RELEASE_REPO, run, Timer, VERSION, writeJson } from "./util.mjs";
import { SetupView, formatSteps } from "./setup-view.mjs";
import { makeSay, para, styles, tildify, tuiMode, termSize } from "./tui.mjs";
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
const BOOL_FLAGS = new Set(["revoke-all", "off", "link", "yes", "no-herdr", "verbose", "purge", "apply", "json", "check", "signin-here", "local", "no-restart", "list", "api-key", "help"]);

/** How long setup waits at a terminal for the user to install / turn on Tailscale. 0: stop at once. */
const TAILSCALE_WAIT_MS = 20 * 60_000;
const say = (s = "") => process.stdout.write(`${s}\n`);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

// ------------------------------------------------------------------ setup
export async function setup(args, env = process.env, { saved = null } = {}) {
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
  // What the end of setup prints: `notes` need the user (shown always), `info` only with --verbose
  // (and in state.json).
  const notes = [];
  const info = [];
  // A real terminal gets the step-by-step screens (setup-view.mjs); pipes and TERM=dumb the plain lines.
  const tm = tuiMode(process.stdout, env);
  const view = tm.rich ? new SetupView({ home: L.home, product: PRODUCT, steps: env.DINOBOT_FETCH_MS ? 3 : 2, color: tm.color }) : null;
  view?.header(1, "Set up this computer");
  if (saved?.used.length) {
    const line = `Using your saved settings (${saved.used.join(", ")}) from ${saved.path}.`;
    if (view) view.say(line, { dim: true });
    else say(dim(line));
  }
  // Sign-in and import happen on the phone after pairing (SETUP_FLOW), unless asked here.
  const signInHere = SETUP_FLOW.signIn === "terminal" || Boolean(args["signin-here"]);
  const importHere = SETUP_FLOW.import === "terminal";

  // 0. Tailscale is required (tailnet-only daemon). Without it, or on someone else's (shared Mac):
  // stop here with the steps, before anything is started or an existing daemon is stopped. The
  // wrappers are written first, so the "then run" command in the steps exists (and runs setup
  // again from the app already unpacked: nothing is downloaded again).
  const wrappers = writeWrappers(L);
  const early = ensurePathLink(L, { env });
  const rerun = `${early.command} setup${args.name ? ` --name ${JSON.stringify(String(args.name))}` : ""}`;
  let tailscale = await detectTailscale({ env, wsl });
  if (!tailscaleUsable(tailscale)) {
    const steps = tailscaleSteps(tailscale, { os: plat.os, wsl, rerun });
    if (early.note) steps.push("", early.note);
    // At a terminal: show the steps and carry on by itself once Tailscale is up (rel-flow R3.3).
    if (!process.stdout.isTTY || args.yes || !TAILSCALE_WAIT_MS || tailscale.fixed) throw new TailscaleRequired(steps);
    if (view) {
      view.stepsBlock(tailscaleSteps(tailscale, { os: plat.os, wsl, waiting: true }));
      view.write([""]);
    } else {
      say("");
      for (const l of tailscaleSteps(tailscale, { os: plat.os, wsl, waiting: true })) say(l);
      say("");
    }
    const t = Date.now();
    let last = "";
    while (!tailscaleUsable(tailscale)) {
      const line = !tailscale.installed || tailscale.windows ? "waiting for Tailscale to be installed" : `Tailscale is ${tailscale.state ?? "off"}: waiting for it to connect`;
      if (line !== last) {
        if (view) view.busy(`${line[0].toUpperCase()}${line.slice(1)}… (it carries on by itself)`);
        else say(dim(`… ${line} (I'll carry on by myself; Ctrl-C is fine too)`));
      }
      last = line;
      if (Date.now() - t > TAILSCALE_WAIT_MS) throw new TailscaleRequired(steps);
      await new Promise((r) => setTimeout(r, 2000));
      tailscale = await detectTailscale({ env, wsl });
    }
    if (view) view.done(`Tailscale is on: your iPhone can reach this computer at ${tailscale.dnsName ?? tailscale.ip}.`);
    else say(`✓ Tailscale is on: your iPhone can reach this computer at ${tailscale.dnsName ?? tailscale.ip}.`);
    timer.mark("Tailscale set up by the user (waited)");
  } else view?.done(`Tailscale is on (${tailscale.dnsName ?? tailscale.ip}).`);
  // macOS: the system Tailscale signed in by another person (their menu-bar app, not ours) is their
  // tailnet. Refuse instead of putting this daemon and its QR there.
  const foreign = await foreignTailscale({ env, tailscale, os: plat.os });
  if (foreign) throw new Error(foreignTailscaleMessage(foreign, tailscale, { rerun }));
  // These settings worked: keep them for later runs, uninstall and reinstall (install-env.mjs).
  const savedNow = saveInstallEnv(env, installEnvPath(L.home));
  if (savedNow.length) info.push(`Saved ${savedNow.join(", ")} in ${installEnvPath(L.home)} for later runs (kept by uninstall; \`uninstall --purge\` deletes it).`);

  // Re-run: keep the port, stop the old daemon so the new env applies.
  const previous = readJson(L.state);
  if (previous?.port && !args.port) {
    args.port = previous.port;
    await stopServices(L, previous.serviceMode ?? mode).catch(() => {});
    await waitForClosed(previous.port, 20_000, probeHostFor(previous.listen));
  }
  // A preferred port from the environment (DINOBOT_PORT), e.g. a second install on one machine.
  if (!args.port && env.DINOBOT_PORT) args.port = Number(env.DINOBOT_PORT);

  view?.busy("Getting your bots ready…");
  // 1. Detect everything at once (no user time). The name: given, else the one saved by an earlier
  // setup (install.sh asks on the first install only), else asked below.
  if (!args.name && previous) args.name = readJson(join(L.botsRoot, ".settings.json"))?.user?.name || undefined;
  const [signIns, osName, port, sleep] = await Promise.all([
    Promise.resolve(detectSignIns({ piAgentDir: L.piAgentDir, userPiDir: L.userPiDir, home: L.home, env })),
    args.name ? Promise.resolve(String(args.name)) : fullName({ env }),
    args.port ? Promise.resolve(Number(args.port)) : freePort(6767, [listenHost({ tailscale }), "0.0.0.0"]),
    sleepNote(),
  ]);
  timer.mark("detect Tailscale, sign-ins, name, port");
  const plan = listenPlan({ tailscale, port });
  if (plan.userspace) info.push(`Your Tailscale runs in userspace (${tailscale.ip} is not on this computer's network interfaces): ${PRODUCT} listens on ${plan.listen}, and your tailscaled hands it your tailnet's connections. Note: a userspace tailscaled forwards your tailnet to every 127.0.0.1 port on this computer, so ${PRODUCT} treats connections from 127.0.0.1 like ones from the network: the app must use its encrypted connection, and only your own ${PRODUCT} tools (they read the daemon's local credential, private to your account) connect without it.`);
  info.push(`Reachable over Tailscale only (${tailscale.dnsName ?? plan.listen}): your iPhone (or the computer with the ${PRODUCT} desktop app) needs Tailscale on, with the same account.`);
  if (onWindowsDrive.length) notes.push(`Your bots folder ${L.botsRoot} is on a Windows drive: slow, and its files are readable by every Windows program. Better: PASEO_BOTS_ROOT inside Ubuntu (the default ~/bots).`);
  if (sleep) notes.push(sleep);
  if (plat.os === "linux") {
    const missing = await missingLinuxTools(L);
    if (missing.length) notes.push(`Install ${missing.join(" and ")} (${missing.includes("git") ? "chats show \"Local checkpoint failed\" without git" : "voice models need bzip2"}):  ${installHint(missing)}`);
  }

  // 2. Model defaults from what was found (rel-import table; no model question).
  const md = await loadModelDefaults(L.app);
  let subscription = md.pickSubscription(signIns.found.map((f) => f.subscription));
  const using = signIns.found.find((f) => f.subscription === subscription);
  if (using?.key) {
    savePiCredential(L, using.provider, { type: "api_key", key: using.key });
    info.push(`Saved your ${using.provider} API key (from ${using.source.replace(/^env /, "")}) for ${PRODUCT} (${join(L.piAgentDir, "auth.json")}, private to you).`);
  }
  let models = subscription ? md.resolveModels(subscription) : null;

  // 3. Name (Q2; usually asked by install.sh during the download and passed as --name).
  const userName = args.name ? String(args.name) : prompter.ask("name", "What should your bots call you?", osName);

  // 4. Write everything, starter bot included (suggested; un-tick it below to skip). The wrappers
  // and ~/.local/bin/dinobot (on PATH, no shell rc edits) were written at step 0.
  const pathLink = early;
  const cmd = pathLink.command;
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
  view?.busy(`Starting ${PRODUCT}…`);
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
  const { offer, mode: codeMode } = await pairingOffer(L.app, L.paseoHome, { identity, endpoints, password: daemonEnv.PASEO_PASSWORD, env });
  const url = offerUrl(offer);
  // The terminal waits for the phone after the code (sign-in and models happen there).
  const willWait = !subscription && !signInHere && SETUP_FLOW.waitForPhoneMs > 0 && !args.yes && process.stdout.isTTY;
  let pairView = null;
  if (view) {
    view.done(`${PRODUCT} is running on this computer.`);
    pairView = await richQr(L, url, { open: !args.yes && process.stdout.isTTY, wsl, env, view, note: pairingCodeNote(codeMode, { productId: PRODUCT_ID }), waiting: willWait ? "Waiting for your phone to scan the code…" : "Finishing…" });
  } else {
    say("");
    await sayQr(L, url, { open: !args.yes && process.stdout.isTTY, wsl, env });
    say(bold(`Scan this with the ${PRODUCT} app on your phone.`) + dim(` ${pairingCodeNote(codeMode, { productId: PRODUCT_ID })}`));
    for (const line of desktopPairLines(L, { product: PRODUCT, productId: PRODUCT_ID })) say(dim(line));
  }
  info.push(`Addresses in the code, tried in order: ${endpoints.join(", ")}`);
  timer.mark("QR shown", { milestone: true });

  // Herdr: separate session for workers, started by the service; check it in the background.
  // First start on a Mac can take >8 s (the system checks the new binary), so allow 25 s.
  const herdrReady = herdrOn ? waitForSession(join(L.bin, "herdr"), HERDR_SESSION, 25_000) : Promise.resolve(null);

  // 6. Sign-in only if nothing usable was found (Q1).
  let restart = false;
  let usingLine = "";
  if (!subscription && !signInHere) {
    if (!view) {
      say("");
      say(bold(`Next, in the ${PRODUCT} app: sign in for your bots and choose their models.`));
    }
    info.push(`Prefer to sign in from this terminal? Run \`${cmd} setup --signin-here\`.`);
  } else if (!subscription) {
    const options = await signInOptions(L.app, process.env, { overrides: await providerOverrides(L).catch(() => []) });
    const def = defaultOption(options, signIns);
    view?.release(); // the terminal sign-in prints below the code
    say("");
    say(bold("No AI sign-in found on this computer. Pick one for your bots:"));
    try {
      // The same step as `dinobot signin` (menu once, confirm, login, credential saved).
      const done = await chooseAndSignIn(L, prompter, { options, def });
      subscription = done.subscription;
      models = md.resolveModels(subscription);
      const main = `${models.main.provider}/${models.main.model}`;
      writeDaemonConfig(L, { mainModel: main, thinking: models.main.thinking });
      writeBotsSettings(L, { userName, escalation: starter?.botId ?? null, defaultModel: main });
      if (starter?.created) {
        await createStarterBot(L, { models, subscription }).catch(() => null); // no-op if present
        if (models.compaction) writeJson(join(L.optchatHome, "profiles", starter.botId, "config.json"), { subscription, compactor: models.compaction, subagent: models.worker, setup: true }, 0o600);
        const meta = readJson(join(L.botsRoot, starter.botId, ".bot.json"), {});
        writeJson(join(L.botsRoot, starter.botId, ".bot.json"), { ...meta, chat: { provider: `optchat/${main}`, thinkingOptionId: models.main.thinking, setup: true } }, 0o600);
      }
      restart = true;
    } catch (e) {
      notes.push(`Sign-in did not finish (${e.message}). Sign in later from the app, or run \`${cmd} setup\` again.`);
    }
    timer.mark("model sign-in");
  } else {
    usingLine = `Your bots use your ${md.MODEL_DEFAULTS[subscription].label} sign-in.`;
    if (!view) say(dim(`Using your ${md.MODEL_DEFAULTS[subscription].label} sign-in (${using?.source ?? "pi"}). Bots: ${mainModel}.`));
    else info.push(`Using your ${md.MODEL_DEFAULTS[subscription].label} sign-in (${using?.source ?? "pi"}). Bots: ${mainModel}.`);
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
    info.push(`Starter bot skipped (files kept in ${where}). Create bots from the app; escalations go straight to you.`);
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
    info.push(importInfo.ok ? `Chat import of ${scan.messages.toLocaleString("en")} messages (about $${Math.round(scan.usd)} at API prices, ~${Math.max(1, Math.round(scan.hours))} h) running in the background (log ${importInfo.log}). \`${cmd} import-status\` shows progress.` : `Chat import did not start: ${importInfo.error}`);
  }
  const herdrInfo = await herdrReady;
  const herdrErr = lastLine(join(L.logs, "herdr.log"));
  if (herdrOn && herdrInfo) info.push(`Workers: separate herdr session "${HERDR_SESSION}" running.`);
  else if (herdrOn) notes.push(`Workers: herdr session "${HERDR_SESSION}" is still starting${/error/i.test(herdrErr) ? ` (${herdrErr})` : ""}; \`${cmd} doctor\` checks it.`);
  else info.push("Workers: herdr not bundled; workers stay off until it is installed.");
  if (pathLink.note) notes.push(view ? pathLink.shortNote : pathLink.note);
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
    pathLink: pathLink.status === "skipped" ? null : { link: pathLink.link, status: pathLink.status },
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
    notes: [...notes, ...info],
  };
  writeJson(L.state, state, 0o600);
  const setupLog = writeSetupLog(L, { notes, info, timer });
  if (view) {
    // Rich: the notes wait until the user is done with the phone (or sit beside the code).
    if (args.verbose) info.forEach((n) => view.say(`• ${n}`, { dim: true }));
    if (willWait) {
      await waitForPhone(L, SETUP_FLOW.waitForPhoneMs, view);
      view.finish({ notes, pairCommand: `${cmd} pair` });
    } else if (pairView) {
      view.pair({ ...pairView, notes, waiting: null, end: `Done in ${fmt(timer.elapsedMs)}.${usingLine ? ` ${usingLine}` : ""} Show the code again: ${cmd} pair`, log: setupLog, again: `${cmd} pair` });
      view.close();
      process.stdout.write("\n");
    } else {
      view.close();
      for (const n of notes) view.say(`• ${n}`);
      view.say(`Done in ${fmt(timer.elapsedMs)}. Show the code again: ${cmd} pair`);
    }
    return state;
  }
  // The end stays short (the QR must stay on screen): what needs the user, the done line. The rest
  // (addresses, timings, details) with --verbose, and in state.json.
  if (notes.length || args.verbose) say("");
  for (const n of [...notes, ...(args.verbose ? info : [])]) say(`• ${n}`);
  if (args.verbose) say(dim(`Setup steps (since the install command started):\n${timer.table()}`));
  say(bold(`Done in ${fmt(timer.elapsedMs)}. Show the code again: ${cmd} pair`));
  if (!subscription && !signInHere && SETUP_FLOW.waitForPhoneMs > 0 && !args.yes && process.stdout.isTTY) {
    await waitForPhone(L, SETUP_FLOW.waitForPhoneMs);
  }
  return state;
}

/** The shared-Mac guide, as a link that works from any terminal. */
export const SHARED_MAC_DOC = `https://github.com/${RELEASE_REPO}/blob/main/docs/shared-mac.md`;

/** Why setup stopped at someone else's system Tailscale, the two ways on, and the exact command after. */
export function foreignTailscaleMessage({ owners }, tailscale, { rerun = `~/.${PRODUCT_ID}/bin/${PRODUCT_ID} setup` } = {}) {
  return [
    `the Tailscale on this Mac is signed in by another macOS user (${owners.join(", ")}), so your bots and pairing code would land on their Tailscale${tailscale?.dnsName ? ` (${tailscale.dnsName})` : ""}. Nothing was started.`,
    "",
    `Two ways on (step by step: ${SHARED_MAC_DOC}):`,
    `  A. They share this Mac with your own Tailscale account and allow you one port. Then:`,
    `       export DINOBOT_TAILNET_ADDRESS=${tailscale?.ip ?? "<this Mac's Tailscale IP>"} DINOBOT_PORT=<the port they allowed>`,
    `  B. You run your own userspace tailscaled. Then:`,
    `       export DINOBOT_TAILSCALE_BIN=<your tailscale CLI> DINOBOT_TAILSCALE_SOCKET=<your tailscaled.sock> DINOBOT_PORT=<a free port>`,
    "If this Tailscale really is yours: export DINOBOT_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "",
    `Then finish setup (nothing is downloaded again; the settings are saved for later runs):`,
    `  ${rerun}`,
  ].join("\n");
}

/** Linux: tools setup cannot ship that chats (git) and voice models (bzip2) need, missing on this computer. */
async function missingLinuxTools(L) {
  const PATH = readEnvFile(L.envFile).PATH || process.env.PATH;
  const out = [];
  for (const t of ["git", "bzip2"]) if ((await run("sh", ["-c", `command -v ${t}`], { env: { PATH } })).code !== 0) out.push(t);
  return out;
}
const installHint = (pkgs) => (existsSync("/usr/bin/dnf") ? `sudo dnf install ${pkgs.join(" ")}` : existsSync("/usr/bin/pacman") ? `sudo pacman -S ${pkgs.join(" ")}` : `sudo apt install ${pkgs.join(" ")}`);

/** After the QR: say when the phone has signed in and chosen models (Ctrl-C is fine). lib/phone-ready.mjs. */
async function waitForPhone(L, ms, view = null) {
  const pairCommand = `${commandName(L)} pair`;
  await waitForPhoneReady(L, ms, { say, dim, bold, product: PRODUCT, pairCommand, view: view?.phone({ pairCommand: tildify(pairCommand, L.home) }) ?? null });
}

/** logs/setup.log: what --verbose shows (notes, details, the timing table); named when setup fails. */
function writeSetupLog(L, { notes, info, timer, error = null }) {
  const path = join(L.logs, "setup.log");
  try {
    mkdirSync(L.logs, { recursive: true });
    const body = [`${PRODUCT} ${VERSION} setup, ${new Date().toISOString()}`, ...[...notes, ...info].map((n) => `• ${n}`), "", "Setup steps (since the install command started):", timer.table(), ...(error ? ["", `Stopped: ${error.stack ?? error}`] : [])].join("\n");
    writeFileSync(path, `${body}\n`, { mode: 0o600 });
  } catch {}
  return path;
}

/** Rich step 3: the code screen (setup-view.mjs) with the picture beside it; plain text if the QR cannot be drawn. */
async function richQr(L, url, { open, wsl, env, view, waiting, note = null }) {
  removeQrPng(L);
  clearPhoneSteps(L);
  let shown;
  try {
    shown = await showPairingQr(L, url, { open, wsl, env });
  } catch {
    say(await renderQr(L.app, url));
    return null;
  }
  const desktop = desktopPairLines(L, { product: PRODUCT, productId: PRODUCT_ID })[1].trim();
  const screen = { qrs: shown.variants, picture: shown.path, opened: shown.opened, desktop, note };
  view.pair({ ...screen, waiting });
  return screen;
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
    for (const l of tailscaleSteps(tailscale, { wsl, rerun: `${commandName(L)} pair` })) say(l);
    process.exitCode = 2;
    return;
  }
  const endpoints = offerEndpoints({ port: state.port, tailscale });
  const identity = await daemonIdentity(L.app, L.paseoHome);
  // A fresh one-use ticket every time (QR2): one device, 10 minutes.
  const { offer, mode } = await pairingOffer(L.app, L.paseoHome, { identity, endpoints, password: env.PASEO_PASSWORD });
  const url = offerUrl(offer);
  // --link: the pairing link as text, for the app's "Paste pairing link" (no camera). It is a
  // pairing secret, like the QR: send it only to yourself.
  if (link) return say(url);
  await sayQr(L, url, { open: process.stdout.isTTY, wsl });
  say(dim(pairingCodeNote(mode, { productId: PRODUCT_ID })));
  for (const line of desktopPairLines(L, { product: PRODUCT, productId: PRODUCT_ID })) say(line);
  say(dim(`Addresses: ${endpoints.join(", ")}`));
}

/**
 * `dinobot devices`: the phones and computers paired with this one (each holds a device token;
 * older apps a 24-hour token plus the password). `--revoke N` (number from the list, or the
 * client id) or `--revoke-all` unpairs: the device is refused at its next connect.
 */
export async function devices(L, args, { out = process.stdout, list = pairedDevices, revoke = revokeDevices, now = Date.now() } = {}) {
  const print = (s = "") => out.write(`${s}\n`);
  if (!readJson(L.state)) throw new Error("Not set up yet: run the installer first.");
  const rows = await list(L.app, L.paseoHome);
  const day = 24 * 60 * 60 * 1000;
  if (args["revoke-all"]) {
    await revoke(L.app, L.paseoHome, "all");
    print(`Unpaired every device (${rows.length}), and every pairing code not yet used no longer works.`);
    print(`Apps that still keep this computer's password (older app versions) can sign in again with it.`);
    print(`To pair a device again: ${PRODUCT_ID} pair`);
    return;
  }
  if (args.revoke !== undefined) {
    const want = String(args.revoke);
    const row = /^\d+$/.test(want) ? rows[Number(want) - 1] : rows.find((r) => r.clientId === want);
    if (!row) throw new Error(`no paired device ${want} (see: ${PRODUCT_ID} devices)`);
    await revoke(L.app, L.paseoHome, [row.clientId]);
    print(`Unpaired ${row.clientId}${row.label ? ` (${row.label})` : ""}. It is refused at its next connect.`);
    return;
  }
  if (!rows.length) {
    print(`No paired devices. Pair one: ${PRODUCT_ID} pair`);
    return;
  }
  print(`Paired with ${PRODUCT} on this computer:`);
  rows.forEach((r, i) => {
    const seen = Math.max(0, Math.floor((now - r.issuedAt) / day));
    const ends = Math.max(0, Math.ceil((r.expiresAt - now) / day));
    const when = seen === 0 ? "active today" : `active ${seen} day${seen === 1 ? "" : "s"} ago`;
    const kind = r.device ? `stays paired while used (unused ${ends} more days ends it)` : "older app: signs in with the password";
    print(`  ${i + 1}. ${r.clientId}${r.label ? `  ${r.label}` : ""}  ${when}; ${kind}`);
  });
  print("");
  print(`Unpair one: ${PRODUCT_ID} devices --revoke <number>    all: ${PRODUCT_ID} devices --revoke-all`);
}

/**
 * The pairing QR in the terminal, plus a picture of it (opened on a Mac) for terminals that draw
 * it with gaps. Falls back to the daemon's own renderer if the qrcode package cannot be loaded.
 */
async function sayQr(L, url, { open, wsl, env = process.env }) {
  removeQrPng(L); // a picture left by an earlier run
  clearPhoneSteps(L); // a new code: only what the phone does from now on counts (phone-ready.mjs)
  let shown;
  try {
    shown = await showPairingQr(L, url, { open, wsl, env });
  } catch {
    return say(await renderQr(L.app, url));
  }
  say(shown.text);
  if (shown.hint) say(dim(shown.hint));
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

// ------------------------------------------------------------------ signin
// dinobot signin [<provider>] [--api-key]   sign in to one AI provider (menu without a provider)
// dinobot signin --list | status            which providers are signed in
// Only the sign-in: no other setup step, no restart. The credential goes to DinoBot's pi
// (~/.dinobot/pi/auth.json), which every bot chat and worker reads when it starts. Adds or
// replaces that one provider; other sign-ins are kept. Never skipped as "already signed in".
export const SIGNIN_USAGE = [
  `${PRODUCT_ID} signin                  pick a sign-in from the list (adds it, or replaces that provider's)`,
  `${PRODUCT_ID} signin <provider>       straight to one: anthropic (Claude login), openai-codex, github-copilot, openrouter, openai`,
  `${PRODUCT_ID} signin <provider> --api-key   that provider's API key instead of its login (e.g. anthropic)`,
  `${PRODUCT_ID} signin --list           which providers are signed in`,
];

export const USAGE = [
  `${PRODUCT} ${VERSION}`,
  ``,
  `${PRODUCT_ID} setup [--signin-here]     set up (or re-run setup) on this computer; shows a new pairing code`,
  ...SIGNIN_USAGE,
  `${PRODUCT_ID} pair [--link]             a new pairing code (one device, 10 minutes)`,
  `${PRODUCT_ID} devices [--revoke N|--revoke-all]   paired phones and computers; unpair one or all`,
  `${PRODUCT_ID} status | doctor           what runs; check everything`,
  `${PRODUCT_ID} update [--check]          get the newest ${PRODUCT} (keeps sign-ins, pairing and bots)`,
  `${PRODUCT_ID} start | stop               the ${PRODUCT} services`,
  `${PRODUCT_ID} provider add | list | remove | update   provider plugins`,
  `${PRODUCT_ID} push status | enable | disable | test    optional push add-on`,
  `${PRODUCT_ID} uninstall                 remove ${PRODUCT}, its sign-ins and the phone's pairing (asks first); keeps your bots and memories`,
  `${PRODUCT_ID} uninstall --purge [--yes]  wipe everything, bots and memories too (asks you to type DELETE)`,
  ``,
  `To update, run \`${PRODUCT_ID} update\` (or the install command again): no need to uninstall.`,
  `The command lives in ~/.${PRODUCT_ID}/bin/${PRODUCT_ID}; setup and update link it as ~/.local/bin/${PRODUCT_ID}.`,
  `If \`${PRODUCT_ID}\` is not found, put ~/.local/bin on your PATH (setup prints the one line for your shell).`,
];

export async function signin(L, args, deps = {}) {
  const out = deps.out ?? process.stdout;
  const print = (s = "") => out.write(`${s}\n`);
  const [, want] = args._;
  if (args.help || want === "help") return SIGNIN_USAGE.forEach((l) => print(l));
  const overrides = await (deps.overrides ?? ((x) => providerOverrides(x)))(L).catch(() => []);
  const options = await signInOptions(L.app, process.env, { overrides });
  if (args.list || want === "list" || want === "status") {
    const { readyProviders, signedInLabels } = await import("./phone-signin.mjs");
    const providers = await (deps.readyProviders ?? readyProviders)(L);
    if (!providers.length) return print(`No AI sign-in yet. Run: ${PRODUCT_ID} signin`);
    const auth = readJson(join(L.piAgentDir, "auth.json"), {}) ?? {};
    const labels = signedInLabels(options, providers, auth);
    print("Signed in:");
    providers.forEach((p, i) => print(`  ${labels[i]}  (${p}, ${auth[p]?.type === "api_key" ? "API key" : "login"})`));
    return;
  }
  const prompter = deps.prompter ?? new Prompter({});
  let done;
  try {
    if (want) {
      const option = findOption(options, want, { apiKey: Boolean(args["api-key"]) });
      if (!option) throw new Error(`no sign-in called "${want}". Choices: ${[...new Set(options.map((o) => o.provider))].join(", ")} (or run \`${PRODUCT_ID} signin\` for the list)`);
      done = { option, ...(await signIn(L, option, prompter, out)) };
    } else {
      const def = defaultOption(options, detectSignIns({ piAgentDir: L.piAgentDir, userPiDir: L.userPiDir, home: L.home, env: process.env }));
      print("Pick a sign-in for your bots (adds it, or replaces that provider's; others are kept):");
      done = await chooseAndSignIn(L, prompter, { options, def, out });
    }
  } catch (e) {
    if (e?.code !== "NOT_CONFIRMED") throw e;
    process.exitCode = 1;
    return print("Not signed in (not confirmed).");
  }
  print(`Signed in: ${done.option.label}. Saved for your bots in ${join(L.piAgentDir, "auth.json")}.`);
  print(dim(`New bot chats use it now (no restart). Pick which models your bots use in the ${PRODUCT} app.`));
  return done;
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
  // A bare `dinobot` shows what there is (it used to run setup again: a new QR and a daemon restart).
  let [cmd = "help"] = args._;
  if (args.help && cmd !== "signin") cmd = "help";
  const L = layout();
  // Saved install settings (shared Mac): every command sees them; the environment wins.
  const saved = loadInstallEnv(process.env, installEnvPath(L.home));
  switch (cmd) {
    case "setup":
      // The QR picture holds the password: an error, Ctrl-C, SIGTERM or a closed terminal removes
      // it (qr.mjs withQrGuard; its reaper and the daemon's sweep cover a kill -9 and a reboot).
      return withQrGuard(L, () => setup(args, process.env, { saved }));
    case "post-update": {
      // Run by `update` with the NEW version's code, right after the swap (lib/post-update.mjs).
      const r = await postUpdate(L, { env: process.env, say: makeSay(), rich: tuiMode().rich });
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "pair":
      return pair(L, { link: Boolean(args.link) });
    case "devices":
      return devices(L, args);
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
    case "uninstall":
      return uninstall(L, args);
    case "claude-code": {
      const { installClaudeCode, sdkStatus } = await import("./claude-code.mjs");
      if (args._[1] === "install") return installClaudeCode(L);
      // The `claude` CLI itself (Anthropic's native installer), not the Agent SDK above.
      if (args._[1] === "install-cli") {
        const { installClaudeCliCommand } = await import("./claude-install.mjs");
        const r = await installClaudeCliCommand(process.env);
        if (!r.ok) process.exitCode = 1;
        return;
      }
      const st = sdkStatus(L);
      return say(st.installed ? `Claude Agent SDK ${st.version} installed.` : `Claude Code agent: not installed (${PRODUCT} does not ship Anthropic's SDK). Install it with: ${PRODUCT_ID} claude-code install`);
    }
    case "import-status": {
      const state = readJson(L.state);
      return say(state?.starterBot ? await importStatus(L, state.starterBot) : "No import.");
    }
    case "signin":
      return signin(L, args);
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
    case "help":
      return USAGE.forEach((l) => say(l));
    default:
      throw new Error(`unknown command ${cmd} (see: ${PRODUCT_ID} help)`);
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
    const cmd = parseArgs(process.argv.slice(2))._[0] ?? "setup";
    const tm = tuiMode(process.stdout);
    if (e instanceof TailscaleRequired) {
      if (tm.rich) process.stdout.write(`\n${formatSteps(e.steps.map((l) => tildify(l, layout().home)), termSize().cols, styles(tm.color)).join("\n")}\n\n`);
      else process.stdout.write(`\n${e.steps.join("\n")}\n`);
      process.exitCode = 2;
      return;
    }
    if (tm.rich && process.stderr.isTTY && cmd !== "signin") {
      // One plain sentence, the next step (in the message), and where the details are.
      const st = styles(tm.color);
      const L = layout();
      let log = null;
      if (cmd === "setup") {
        try {
          mkdirSync(L.logs, { recursive: true });
          writeFileSync(join(L.logs, "setup.log"), `${PRODUCT} ${VERSION} setup stopped, ${new Date().toISOString()}\n${e.stack ?? e}\n`, { flag: "a", mode: 0o600 });
          log = join(L.logs, "setup.log");
        } catch {}
      }
      const { cols } = termSize();
      const lines = ["", ...para(tildify(`${PRODUCT} ${cmd === "setup" ? "setup" : cmd} stopped: ${e.message}`, L.home), cols, { first: `${st.red("✗")} ` })];
      if (log) lines.push(...para(`Details: ${tildify(log, L.home)}`, cols, { indent: 2 }).map((l) => st.dim(l)));
      process.stderr.write(`${lines.join("\n")}\n\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(cmd === "signin" ? `\nNot signed in: ${e.message}\n` : `\n${PRODUCT} setup stopped: ${e.message}\n`);
    process.exitCode = 1;
  });
}
