// Child process of provider-overrides.mjs: loads DinoBot's pi extensions the way pi does at startup
// and prints which providers they register, then exits. Run in its own process because loading an
// extension runs its code (and keeps pi's module cache): the daemon and the setup CLI stay clean.
//
//   PI_CODING_AGENT_DIR=<DinoBot's pi dir> node provider-probe.mjs <pi package dir> <cwd>
//
// Prints one JSON line: {"registrations":[{provider, extensionPath, baseDir}], "errors":[...]}.
// Only extensions with a real path count (an added package or a file in the pi dir); pi's own
// built-in extensions ("builtin:…") and inline ones ("<…>") are left out.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [piDir, cwd] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!piDir || !agentDir) {
  process.stdout.write(`${JSON.stringify({ registrations: [], errors: ["usage: PI_CODING_AGENT_DIR=… provider-probe.mjs <pi dir> [cwd]"] })}\n`);
  process.exit(2);
}

const synthetic = (p) => typeof p !== "string" || p.startsWith("builtin:") || p.startsWith("<");

try {
  const pi = await import(pathToFileURL(join(piDir, "dist", "index.js")).href);
  const loader = new pi.DefaultResourceLoader({
    cwd: cwd || agentDir,
    agentDir,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions = [], errors = [], runtime } = loader.getExtensions();
  const baseDirOf = new Map(extensions.map((e) => [e.path, e.sourceInfo?.baseDir ?? null]));
  const registrations = [
    ...(runtime?.pendingNativeProviderRegistrations ?? []).map((r) => ({ provider: r.provider?.id, extensionPath: r.extensionPath })),
    ...(runtime?.pendingProviderRegistrations ?? []).map((r) => ({ provider: r.name, extensionPath: r.extensionPath })),
  ]
    .filter((r) => typeof r.provider === "string" && !synthetic(r.extensionPath))
    .map((r) => ({ ...r, baseDir: baseDirOf.get(r.extensionPath) ?? null }));
  process.stdout.write(`${JSON.stringify({ registrations, errors: errors.map((e) => `${e.path}: ${e.error}`) })}\n`);
  process.exit(0);
} catch (e) {
  process.stdout.write(`${JSON.stringify({ registrations: [], errors: [String(e?.message ?? e)] })}\n`);
  process.exit(1);
}
