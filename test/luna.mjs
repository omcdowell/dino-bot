// Test/demo model (luna-demo, 27 Oct): openai-codex/gpt-5.6-luna on the machine's existing pi Codex login,
// for throwaway DinoBot hosts (e2e, demo kit, room A/B). Not shipped (only lib/ goes in the tarball).
//
//   node luna.mjs auth  <HOME> [<pi auth.json>]   DinoBot's pi in <HOME> reads the Codex token from
//                                                 that file (default: the account's ~/.pi/agent/auth.json)
//   node luna.mjs apply <HOME> [<host:port>]      the phone's "Choose models" answer: luna for bots,
//                                                 compaction and workers (default: the install's first
//                                                 address and PASEO_PASSWORD from its daemon.env)
//   node luna.mjs off   <HOME>                    remove what `auth` wrote
//
// No token is copied, printed or written anywhere: DinoBot's pi gets a shell command ("!...") that
// reads the access token from the real auth.json when pi needs it. pi 1.4.0 takes an API key for its
// built-in openai-codex provider only from models.json (`providers["openai-codex"].apiKey`; an auth.json
// api_key entry alone gives "No API key found"), so the command goes there; the same command also goes
// into DinoBot's auth.json, which is where setup and the phone's sign-in list look for a sign-in. Only the openai-codex entry is used; the host never refreshes the login (a refresh would
// rotate the refresh token and sign the real pi out), so the real pi keeps it fresh. pi's Codex
// provider takes the account id from the token itself, so the access token alone is enough.
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LUNA = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "low" };
const READER = "luna-token.mjs";

const piDir = (home) => process.env.DINOBOT_PI_DIR || join(home, ".dinobot", "pi");
const readJson = (p, d) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};
const writeJson = (p, v) => {
  writeFileSync(`${p}.tmp`, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
};
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** The pi key command for `src` (exported for the unit test). */
export function keyCommand(node, reader) {
  return `!${q(node)} ${q(reader)}`;
}

export function auth(home, src = join(userInfo().homedir, ".pi", "agent", "auth.json"), node = process.execPath) {
  const codex = readJson(src, {})?.["openai-codex"];
  if (!codex?.access) throw new Error(`no openai-codex login in ${src} (sign in once with: pi, /login, ChatGPT)`);
  if (codex.expires && codex.expires < Date.now() + 10 * 60_000) {
    throw new Error(`the openai-codex token in ${src} has expired or expires within 10 min: use pi once with openai-codex/gpt-5.6-luna on this machine to refresh it`);
  }
  const dir = piDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reader = join(dir, READER);
  writeFileSync(
    reader,
    `// luna-demo test helper: prints the Codex access token from the real pi login (read at use, never stored).\n` +
      `import { readFileSync } from "node:fs";\n` +
      `const a = JSON.parse(readFileSync(${JSON.stringify(src)}, "utf8"))["openai-codex"];\n` +
      `if (!a?.access) process.exit(1);\nprocess.stdout.write(a.access);\n`,
    { mode: 0o700 },
  );
  chmodSync(reader, 0o700);
  const authPath = join(dir, "auth.json");
  const a = readJson(authPath, {}) ?? {};
  a[LUNA.provider] = { type: "api_key", key: keyCommand(node, reader) };
  writeJson(authPath, a);
  const modelsPath = join(dir, "models.json");
  const m = readJson(modelsPath, {}) ?? {};
  m.providers = { ...(m.providers ?? {}), [LUNA.provider]: { ...(m.providers?.[LUNA.provider] ?? {}), apiKey: keyCommand(node, reader) } };
  writeJson(modelsPath, m);
  const settingsPath = join(dir, "settings.json");
  const s = readJson(settingsPath, {}) ?? {};
  Object.assign(s, { defaultProvider: LUNA.provider, defaultModel: LUNA.model, defaultThinkingLevel: LUNA.thinking });
  writeJson(settingsPath, s);
  return { authPath, modelsPath, reader };
}

export function off(home) {
  const dir = piDir(home);
  const authPath = join(dir, "auth.json");
  const a = readJson(authPath, null);
  if (a && a[LUNA.provider]?.type === "api_key" && String(a[LUNA.provider].key).includes(READER)) {
    delete a[LUNA.provider];
    writeJson(authPath, a);
  }
  const modelsPath = join(dir, "models.json");
  const m = readJson(modelsPath, null);
  if (m?.providers?.[LUNA.provider]?.apiKey?.includes?.(READER)) {
    delete m.providers[LUNA.provider].apiKey;
    if (!Object.keys(m.providers[LUNA.provider]).length) delete m.providers[LUNA.provider];
    writeJson(modelsPath, m);
  }
  rmSync(join(dir, READER), { force: true });
}

async function apply(home, host) {
  host ||= readJson(join(home, ".dinobot", "state.json"), {})?.endpoints?.[0];
  if (!process.env.PASEO_PASSWORD) {
    const env = readFileSync(join(home, ".dinobot", "daemon.env"), "utf8");
    process.env.PASEO_PASSWORD = /^PASEO_PASSWORD=(.*)$/m.exec(env)?.[1] ?? "";
  }
  const { connectToDaemon } = await import(`${home}/.dinobot/app/daemon/dist/utils/client.js`);
  const client = await connectToDaemon({ target: { kind: "endpoint", host }, timeout: 30_000 });
  try {
    const pick = { ...LUNA };
    const r = await client.invokePluginRpc("bots", "setup.apply", { models: { bots: pick, compaction: pick, workers: pick } });
    console.log(`setup.apply ok=${r.ok} applied=${(r.applied ?? []).join(", ")}`);
    if (!r.ok) process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

// Run as a script (realpath: macOS /tmp is a link to /private/tmp, which import.meta.url resolves).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, home, arg] = process.argv.slice(2);
  try {
    if (!home) throw new Error("usage: luna.mjs auth|apply|off <HOME> [...]");
    if (cmd === "auth") console.log(`luna: ${auth(home, arg ?? undefined).authPath} reads the Codex login (no token copied)`);
    else if (cmd === "apply") await apply(home, arg);
    else if (cmd === "off") off(home);
    else throw new Error(`unknown command ${cmd}`);
  } catch (e) {
    console.error(`luna: ${e.message}`);
    process.exitCode = 1;
  }
  if (cmd === "apply") process.exit();
}
