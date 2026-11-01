// `dinobot claude-code install`: the owner (27 Oct) dropped the proprietary Claude Agent SDK from the
// download. Paseo's built-in Claude Code coding agent still imports it, so the tarball carries a
// placeholder (build/claude-agent-sdk-stub) and this command fetches the real package from the npm
// registry on the user's own computer (the same version the daemon was built against), checks
// npm's sha512 integrity, and swaps it in. Bots never need it (they run on pi).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT, PRODUCT_ID, readJson, run } from "./util.mjs";

const NAME = "@anthropic-ai/claude-agent-sdk";

export function sdkDir(L) {
  return join(L.app, "daemon", "node_modules", "@anthropic-ai", "claude-agent-sdk");
}

export function sdkStatus(L) {
  const pkg = readJson(join(sdkDir(L), "package.json"), null);
  if (!pkg) return { installed: false, stub: false, version: null };
  const stub = Boolean(pkg.dinobot?.replaces);
  return { installed: !stub, stub, version: stub ? pkg.dinobot.version : pkg.version };
}

export async function installClaudeCode(L, { say = (s) => process.stdout.write(`${s}\n`), registry = "https://registry.npmjs.org" } = {}) {
  const st = sdkStatus(L);
  if (st.installed) return say(`Claude Agent SDK ${st.version} is already installed.`), { ok: true };
  if (!st.version || st.version.startsWith("__")) throw new Error(`This ${PRODUCT} build does not record which Claude Agent SDK version it needs.`);
  say(`Fetching ${NAME}@${st.version} from npm (Anthropic's terms apply: https://www.anthropic.com/legal/commercial-terms).`);
  const meta = await run("curl", ["-fsSL", `${registry}/${NAME.replace("/", "%2f")}/${st.version}`], { timeout: 60_000 });
  if (meta.code !== 0) throw new Error(`npm registry: ${meta.stderr.trim()}`);
  const dist = JSON.parse(meta.stdout).dist;
  const tmp = join(L.root, "download", `claude-agent-sdk-${st.version}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgz = `${tmp}.tgz`;
  const dl = await run("curl", ["-fsSL", dist.tarball, "-o", tgz], { timeout: 300_000 });
  if (dl.code !== 0) throw new Error(`download failed: ${dl.stderr.trim()}`);
  const [algo, want] = String(dist.integrity).split("-");
  const got = createHash(algo).update(readFileSync(tgz)).digest("base64");
  if (got !== want) throw new Error("the download does not match npm's integrity hash; nothing was changed");
  const x = await run("tar", ["-xzf", tgz, "-C", tmp, "--strip-components=1"]);
  if (x.code !== 0) throw new Error(`unpack failed: ${x.stderr.trim()}`);
  const dir = sdkDir(L);
  if (existsSync(dir)) renameSync(dir, `${dir}.stub`);
  renameSync(tmp, dir);
  rmSync(tgz, { force: true });
  say(`Installed. Restart ${PRODUCT} (\`${PRODUCT_ID} stop && ${PRODUCT_ID} start\`), and install the \`claude\` CLI and log in to it for the Claude Code agent.`);
  return { ok: true };
}
