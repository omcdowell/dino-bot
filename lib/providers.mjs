// Provider plugins: model providers added to DinoBot as pi packages (an extension that calls
// pi.registerProvider). One command or one link:
//
//   dinobot provider add <source> [--token T]    npm:<pkg>[@ver] | git:github.com/<o>/<r>@<tag> | ./dir
//   dinobot provider add 'dinobot://provider/add?source=…&token=…'   (an invite link, pasted)
//   dinobot provider list | remove <source> | update
//
// Everything goes into DinoBot's own pi dir (~/.dinobot/pi: settings.json packages, npm/, git/),
// so the daemon's bots and the herdr workers pick it up and the user's ~/.pi is never touched.
//
// Private packages (shared by their owner with chosen people) come from a private
// GitHub repo with a per-person read-only token (a fine-grained PAT: one repo, Contents: read,
// with an expiry). The token is kept in ~/.dinobot/secrets/git-tokens.json (0600) and handed to
// git only for that host, through GIT_CONFIG_* env (no ~/.gitconfig, no ~/.git-credentials, no
// token in a URL or on a command line). Revoking the token stops updates for that one person.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LINK_SCHEME, readJson, run, writeJson } from "./util.mjs";

/** Which sources `provider add` accepts. Tokens only for git sources on https hosts. */
export function parseSource(source) {
  const s = String(source ?? "").trim();
  if (!s) throw new Error("No source given.");
  if (/[\s\0\\]/.test(s)) throw new Error(`Not a package source: ${s}`);
  if (s.startsWith("npm:")) {
    if (!/^npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i.test(s)) throw new Error(`Not an npm package: ${s}`);
    return { kind: "npm", source: s, host: null };
  }
  if (s.startsWith("./") || s.startsWith("/") || s.startsWith("~/")) return { kind: "local", source: s, host: null };
  // git:github.com/o/r@ref, git:https://github.com/o/r@ref, https://github.com/o/r@ref
  const m = /^(?:git:)?(?:https:\/\/)?([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w./-]+))?$/i.exec(s);
  if (m && (s.startsWith("git:") || s.startsWith("https://"))) {
    const [, host, owner, repo, ref] = m;
    if (ref && ref.split("/").includes("..")) throw new Error(`Bad ref in ${s}`);
    return { kind: "git", source: `git:https://${host}/${owner}/${repo}${ref ? `@${ref}` : ""}`, host, repoKey: `${host}/${owner}/${repo}`.toLowerCase(), pinned: Boolean(ref) };
  }
  throw new Error(`Not a package source (use npm:…, git:github.com/<owner>/<repo>@<tag> or a folder): ${s}`);
}

/**
 * An invite link: `<scheme>://provider/add?source=<source>&token=<token>&name=<label>`. The app
 * opens it (a tap in Messages), shows what it installs and asks before sending it to the daemon;
 * the CLI takes the same link pasted. -> {source, token, name}.
 */
export function parseProviderLink(link, scheme = LINK_SCHEME) {
  let url;
  try {
    url = new URL(String(link).trim());
  } catch {
    throw new Error("Not a link.");
  }
  if (url.protocol !== `${scheme}:`) throw new Error(`Not a ${scheme}:// link.`);
  const path = `${url.host}${url.pathname}`.replace(/\/+$/, "");
  if (path !== "provider/add") throw new Error("Not a provider link.");
  const source = url.searchParams.get("source");
  const parsed = parseSource(source);
  const token = url.searchParams.get("token") || null;
  if (token && parsed.kind !== "git") throw new Error("A token only goes with a git source.");
  if (token && !/^[\w-]{20,255}$/.test(token)) throw new Error("That token does not look right.");
  return { source: parsed.source, token, name: url.searchParams.get("name") || null };
}

/** Builds the invite link the owner sends (run on the owner's computer; nothing is stored). */
export function providerLink({ source, token = null, name = null }, scheme = LINK_SCHEME) {
  const parsed = parseSource(source);
  const q = new URLSearchParams({ source: parsed.source });
  if (name) q.set("name", name);
  if (token) q.set("token", token);
  return `${scheme}://provider/add?${q}`;
}

/**
 * Env that lets git (run by `pi install`/`pi update`) read a token for one https host, and
 * nothing else: an empty helper first resets any inherited helpers for that host, then ours prints
 * the token from DINOBOT_GIT_TOKEN. Git 2.31+ reads GIT_CONFIG_COUNT/KEY/VALUE.
 */
export function gitTokenEnv(host, token) {
  if (!token) return { GIT_TERMINAL_PROMPT: "0" };
  const key = `credential.https://${host}.helper`;
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$DINOBOT_GIT_TOKEN"; }; f',
    DINOBOT_GIT_TOKEN: token,
  };
}

const tokensPath = (L) => join(L.root, "secrets", "git-tokens.json");

export function readTokens(L) {
  return readJson(tokensPath(L), {}) ?? {};
}

export function saveToken(L, repoKey, token) {
  const all = readTokens(L);
  if (token) all[repoKey] = token;
  else delete all[repoKey];
  mkdirSync(join(L.root, "secrets"), { recursive: true, mode: 0o700 });
  writeJson(tokensPath(L), all, 0o600);
}

/** Runs DinoBot's pi (the wrapper pins PI_CODING_AGENT_DIR to ~/.dinobot/pi). */
function pi(L, args, extraEnv = {}, deps = {}) {
  const exec = deps.run ?? run;
  return exec(join(L.bin, "pi"), args, { env: { ...process.env, ...extraEnv }, timeout: 300_000 });
}

/** `provider add`: install into DinoBot's pi. The token (if any) is checked by the clone itself. */
export async function addProvider(L, { source, token = null }, deps = {}) {
  const parsed = parseSource(source);
  if (token && parsed.kind !== "git") throw new Error("A token only goes with a git source.");
  const stored = parsed.kind === "git" ? readTokens(L)[parsed.repoKey] : null;
  const use = token ?? stored ?? null;
  const r = await pi(L, ["install", parsed.source], parsed.kind === "git" ? gitTokenEnv(parsed.host, use) : {}, deps);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
    const hint = parsed.kind === "git" && /auth|403|404|not found|could not read|terminal prompts|code 128/i.test(why)
      ? use ? " The token may have expired or been revoked: ask the person who shared it for a new link." : " This looks like a private repository: you need the invite link (with its token) from its owner."
      : "";
    throw new Error(`Could not add ${parsed.source}: ${why}.${hint}`);
  }
  if (token && parsed.kind === "git") saveToken(L, parsed.repoKey, token);
  return { source: parsed.source, kind: parsed.kind };
}

export async function updateProviders(L, deps = {}) {
  // pi update reconciles every package; git ones may need their token. One host token at a time
  // is enough for v1 (one private source per host); several hosts each get their helper.
  // Scoped per repo path (credential.useHttpPath), so two private repos on one host each get theirs.
  const tokens = Object.entries(readTokens(L));
  const env = { GIT_TERMINAL_PROMPT: "0" };
  let i = 0;
  tokens.forEach(([repoKey, token], n) => {
    const host = repoKey.split("/")[0];
    for (const key of [`credential.https://${repoKey}.helper`, `credential.https://${repoKey}.git.helper`]) {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i++}`] = "";
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i++}`] = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$DINOBOT_GIT_TOKEN_${n}"; }; f`;
    }
    env[`GIT_CONFIG_KEY_${i}`] = `credential.https://${host}.useHttpPath`;
    env[`GIT_CONFIG_VALUE_${i++}`] = "true";
    env[`DINOBOT_GIT_TOKEN_${n}`] = token;
  });
  if (i) env.GIT_CONFIG_COUNT = String(i);
  return pi(L, ["update", "--extensions"], env, deps);
}

export async function removeProvider(L, source, deps = {}) {
  const parsed = parseSource(source);
  const r = await pi(L, ["remove", parsed.source], {}, deps);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `pi remove failed (${r.code})`);
  if (parsed.kind === "git") saveToken(L, parsed.repoKey, null);
  return { removed: parsed.source };
}

/** What the user added (DinoBot's settings.json packages), the bundled defaults marked. */
export function listProviders(L, defaults = []) {
  const settings = readJson(join(L.piAgentDir, "settings.json"), {}) ?? {};
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  return packages.map((p) => {
    const source = typeof p === "string" ? p : p?.source;
    return { source, bundled: defaults.includes(source) };
  });
}
