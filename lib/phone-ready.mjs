// The terminal's "Waiting for the DinoBot app" after the QR (setup, SETUP_FLOW.waitForPhoneMs):
// when to say "Signed in" and "Your bots are ready", and when the QR picture goes.
//
// Signed in = a pi provider pi says is ready (pi auth check), or a working Claude Code login, the
// same check as the Settings › Providers Claude Code card (engines.mjs claudeCodeStatus, with the
// daemon's Claude config dir as `doctor` uses). A Claude Code login can be older than the phone
// (the user's own ~/.claude), so it counts only once the phone has opened the sign-in step after
// this QR: the host notes that (markPhoneStep, from the bots plugin's signin.options and
// setup.models) in phone-onboarding.json; setup clears it when it shows the QR.
//
// Ready = models saved (state.json `models`, setup.apply), or, for a Claude-Code-only user (no pi
// provider ready), the phone reached the models step: there is nothing for them to choose there
// (pi has no models for them; their bots run on Claude Code, which picks its own model), so the
// app's "Skip for now" saves nothing.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeStatus } from "./engines.mjs";
import { readEnvFile } from "./config.mjs";
import { removeQrPng } from "./qr.mjs";
import { PRODUCT, readJson, writeJson } from "./util.mjs";

export const CLAUDE_CODE_LABEL = "Claude Code";

export function phoneStepsPath(L) {
  return join(L.root, "phone-onboarding.json");
}

/** Host side (daemon): the phone opened onboarding step `step` ("signin" | "models"). Never throws. */
export function markPhoneStep(L, step) {
  try {
    const path = phoneStepsPath(L);
    const cur = readJson(path, {}) ?? {};
    if (cur[step]) return;
    writeJson(path, { ...cur, [step]: new Date().toISOString() }, 0o600);
  } catch {}
}

/** A new QR: only what the phone does after it counts. */
export function clearPhoneSteps(L) {
  const path = phoneStepsPath(L);
  if (existsSync(path)) rmSync(path, { force: true });
}

export function readPhoneSteps(L) {
  return readJson(phoneStepsPath(L), {}) ?? {};
}

/** The env the daemon's Claude Code card uses (its Claude config dir and binary), as `doctor` does. */
export function daemonClaudeEnv(L, env = process.env) {
  const d = readEnvFile(L.envFile);
  const out = { ...env };
  for (const k of ["DINOBOT_CLAUDE_CONFIG_DIR", "DINOBOT_CLAUDE_BIN"]) if (d[k]) out[k] = d[k];
  return out;
}

/**
 * One look: {signedIn: labels, ready, models}. `readyProviders(L)` (pi) and `claudeLoggedIn()` are
 * injectable; Claude Code is asked only once the phone is on the sign-in step (it spawns claude).
 */
export async function phoneProgress(L, { readyProviders, claudeLoggedIn }) {
  const steps = readPhoneSteps(L);
  const pi = await readyProviders(L).catch(() => []);
  const phoneSeen = Boolean(steps.signin || steps.models);
  const cc = phoneSeen ? await claudeLoggedIn().catch(() => false) : false;
  const signedIn = [...pi, ...(cc ? [CLAUDE_CODE_LABEL] : [])];
  const models = readJson(L.state)?.models ?? null;
  const ready = Boolean(signedIn.length && (models || (cc && !pi.length && steps.models)));
  return { signedIn, ready, models, claudeCodeOnly: cc && !pi.length };
}

/**
 * Waits up to `ms` for the phone. The QR picture (it holds the pairing password) goes at the
 * first "Signed in" (paired), and also at the timeout: setup is over, and `dinobot pair` makes a
 * new one when it is needed. Ctrl-C ends the wait too: setup's guardQrPng (qr.mjs) removes it then.
 */
export async function waitForPhone(L, ms, deps = {}) {
  const say = deps.say ?? ((s) => process.stdout.write(`${s}\n`));
  const dim = deps.dim ?? ((s) => s);
  const bold = deps.bold ?? ((s) => s);
  const product = deps.product ?? PRODUCT;
  const pollMs = deps.pollMs ?? 2000;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
  const readyProviders = deps.readyProviders ?? (async (l) => (await import("./phone-signin.mjs")).readyProviders(l));
  const claudeLoggedIn = deps.claudeLoggedIn ?? (async () => (await claudeCodeStatus(daemonClaudeEnv(L))).loggedIn === true);
  try {
    say("");
    say(dim(`Waiting for the ${product} app: pair, sign in, choose models. (Ctrl-C is fine: everything keeps running.)`));
    const end = now() + ms;
    let said = false;
    while (now() < end) {
      const p = await phoneProgress(L, { readyProviders, claudeLoggedIn });
      if (!said && p.signedIn.length) {
        said = true;
        removeQrPng(L); // paired and signed in: the picture (with the password) is no longer needed
        const cc = p.signedIn.includes(CLAUDE_CODE_LABEL);
        const how = cc && p.signedIn.length === 1 ? "claude auth status" : cc ? "pi auth check, claude auth status" : "pi auth check";
        say(`✓ Signed in from the app (${p.signedIn.join(", ")}; checked with ${how}).`);
      }
      if (p.ready) {
        if (p.models) {
          for (const [role, m] of Object.entries(p.models)) if (m) say(`✓ ${role.padEnd(10)} ${m.provider}/${m.model}${m.thinking ? ` · ${m.thinking}` : ""}`);
        } else if (p.claudeCodeOnly) {
          say("✓ bots       on Claude Code (your Claude plan; Claude Code picks the model)");
        }
        say(bold("Your bots are ready. Say hello to your first bot in the app."));
        return "ready";
      }
      await sleep(pollMs);
    }
    removeQrPng(L); // timed out: setup is over; `dinobot pair` shows a new code
    say(dim(`Still waiting for the phone; finish there whenever you like. Show the code again: ${deps.pairCommand ?? "dinobot pair"}`));
    return "timeout";
  } finally {
    removeQrPng(L); // however the wait ends (a throw too); Ctrl-C: cli.mjs guardQrPng
  }
}
