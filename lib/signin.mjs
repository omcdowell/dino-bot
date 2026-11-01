// Model sign-in (asked only when nothing usable was found) and per-subscription model defaults.
// The option list is the bots plugin's public one (shared/sign-in.ts: public logins only); the
// defaults table is pi-optchat's (src/model-defaults.ts, rel-import). Both are read from the
// bundle so there is one source of truth.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { savePiCredential } from "./config.mjs";
import { subscriptionFor } from "./detect.mjs";

export async function loadModelDefaults(app) {
  return import(pathToFileURL(join(app, "optchat", "src", "model-defaults.ts")).href);
}

/**
 * The public sign-in options, with the subscription each one gives.
 * `overrides` (provider-overrides.mjs: providers that added plugins register) changes the Claude
 * login's wording when a plugin replaces pi's "anthropic" provider: "your plan, via <plugin>"
 * (unofficial) instead of EXTRA USAGE. Ids stay the same, so a choice made on one list still matches.
 * `_env` is unused (kept for the callers' signature).
 */
export async function signInOptions(app, _env = process.env, { overrides = [] } = {}) {
  let list;
  let viaPlugin = fallbackClaudeViaPlugin;
  try {
    const mod = await import(pathToFileURL(join(app, "bots", "shared", "sign-in.ts")).href);
    list = mod.SIGN_IN_OPTIONS;
    if (typeof mod.claudeViaPlugin === "function") viaPlugin = mod.claudeViaPlugin;
  } catch {
    list = FALLBACK_OPTIONS;
  }
  const claudePlugin = overrides.find((o) => o.provider === "anthropic")?.plugin ?? null;
  return list.map((o, i) => ({
    id: `${o.provider}:${o.method}:${i}`,
    ...o,
    ...(claudePlugin && isClaudeLogin(o) ? viaPlugin(claudePlugin) : {}),
    subscription: subscriptionFor(o.provider, o.method === "api-key" ? "api_key" : "oauth"),
  }));
}

/** The Claude subscription login (not the Anthropic API key). */
function isClaudeLogin(o) {
  return o.provider === "anthropic" && o.method !== "api-key";
}

// Used only if the bundled plugin predates shared/sign-in.ts (rel-plugin eeb2e08).
const CLAUDE_CONFIRM = {
  title: "Claude login uses EXTRA USAGE",
  body: "Anthropic bills third-party apps like this one to your Claude account's extra usage, per token, on top of your subscription. Your Pro/Max plan's included usage is not used. Turn on extra usage and set a monthly limit first at claude.ai/settings/usage. The experience may also be sub-par: Claude subscriptions are built for Anthropic's own apps, not for tools like this one. We recommend a Codex, Muse, Grok, OpenCode, GLM or DeepSeek subscription instead: they allow direct API use.",
  ok: "Continue with Claude",
};
// Copy of shared/sign-in.ts claudeViaPlugin, for a bundled plugin that predates it.
function fallbackClaudeViaPlugin(plugin) {
  return {
    label: `Claude login (your plan, via ${plugin})`,
    badge: "UNOFFICIAL",
    note: `Uses your Claude plan through ${plugin} (unofficial; Anthropic's terms risk).`,
    confirm: {
      title: `Claude login through ${plugin}`,
      body:
        `${plugin}, a provider plugin added on this computer, replaces the Claude connection, so your bots use your Claude Pro/Max plan's included usage, not extra usage. ` +
        "It is unofficial and not supported by Anthropic: using a Claude plan outside Anthropic's own apps may break Anthropic's terms, and Anthropic could limit or close your account. " +
        "Only continue if you accept that risk. Supported instead: a Codex, Muse, Grok, OpenCode, GLM or DeepSeek subscription, or an API key.",
      ok: "Continue with Claude",
    },
  };
}
const FALLBACK_OPTIONS = [
  { provider: "openai-codex", label: "ChatGPT (Codex)", method: "device-code", note: "Uses your ChatGPT plan" },
  { provider: "github-copilot", label: "GitHub Copilot", method: "device-code", note: "Uses your Copilot plan" },
  { provider: "openrouter", label: "OpenRouter", method: "api-key", note: "Pay per use, many models" },
  { provider: "anthropic", label: "Anthropic API key", method: "api-key", note: "Pay per use" },
  { provider: "openai", label: "OpenAI API key", method: "api-key", note: "Pay per use" },
  { provider: "anthropic", label: "Claude login (extra usage)", method: "paste-code", note: "Billed to your Claude extra usage, per token. Not your Pro/Max plan's included usage.", badge: "EXTRA USAGE", confirm: CLAUDE_CONFIRM },
];

/**
 * pi-ai's login-method choice (Codex: browser | device code; Anthropic: browser | copy code):
 * the headless one, which works from a phone or over SSH. null if none is offered.
 */
export function phoneSafeMethod(options = []) {
  return options.find((o) => /device|copy|headless|paste/i.test(`${o.id} ${o.label}`))?.id ?? null;
}

/**
 * Which option is pre-selected: ChatGPT when a Codex CLI login exists, else a provider the user is
 * already logged in to in their own pi (not copied, see detect.mjs), else the first.
 */
export function defaultOption(options, { codexCli, userOauth = [] }) {
  // Never pre-select an option that needs a confirm (Claude login: extra usage).
  const plain = options.filter((o) => !o.confirm);
  return (codexCli && plain.find((o) => o.provider === "openai-codex")) || plain.find((o) => o.method !== "api-key" && userOauth.includes(o.provider)) || plain[0] || options[0];
}

/**
 * Runs one sign-in with pi-ai's own OAuth flows (device code / paste code) or stores an API key.
 * Credentials go to pi's auth.json in pi's format ({type:"oauth",...} / {type:"api_key",key}).
 */
export async function signIn(L, option, prompter, out = process.stdout, onEvent = null) {
  // Options that cost extra (Claude login: EXTRA USAGE) are confirmed first; --yes does not skip it.
  if (option.confirm) {
    out.write(`\n${option.confirm.title}\n${option.confirm.body}\n`);
    const ok = await prompter.ask(`confirm:${option.provider}:${option.method}`, `${option.confirm.ok}? (y/N)`, "n");
    if (!/^y/i.test(ok)) throw new Error("Claude login not confirmed; pick another sign-in");
  }
  if (option.method === "api-key") {
    const key = await prompter.ask(`key:${option.provider}`, /key/i.test(option.label) ? `Paste your ${option.label}` : `Paste your ${option.label} API key`);
    if (!key) throw new Error("No key given.");
    savePiCredential(L, option.provider, { type: "api_key", key });
    return { provider: option.provider, subscription: option.subscription };
  }
  const allPath = join(L.app, "pi", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "all.js");
  const { builtinProviders } = await import(pathToFileURL(allPath).href);
  const provider = builtinProviders().find((p) => p.id === option.provider && p.auth?.oauth);
  if (!provider) throw new Error(`pi has no login for ${option.provider}`);
  const { randomUUID } = await import("node:crypto");
  const credential = await provider.auth.oauth.login(
    {
      signal: new AbortController().signal,
      prompt: async (p) => {
        if (p.type === "select") {
          // Login method: device code / copy code, never the localhost browser callback, which
          // fails when the browser is on the phone or the computer is reached over SSH. Not asked.
          const id = `oauth:${option.provider}:select`;
          const safe = phoneSafeMethod(p.options);
          if (safe && !(id in (prompter.answers ?? {}))) return safe;
          return prompter.choose(id, p.message, p.options, safe ?? p.options[0]?.id);
        }
        return prompter.ask(`oauth:${option.provider}`, p.message);
      },
      notify: (event) => {
        onEvent?.(event);
        if (event.type === "auth_url") out.write(`\nOpen this link (on your phone is fine):\n  ${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`);
        else if (event.type === "device_code") out.write(`\nOpen ${event.verificationUri} and enter the code  ${event.userCode}\n`);
        else if (event.message) out.write(`${event.message}\n`);
      },
    },
    { getDeviceId: randomUUID },
  );
  savePiCredential(L, option.provider, { type: "oauth", ...credential });
  return { provider: option.provider, subscription: option.subscription };
}
