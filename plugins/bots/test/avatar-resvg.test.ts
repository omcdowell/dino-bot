// resvg-js is a native module the plugin bundle cannot hold, so it is loaded at run time. Paseo evaluates the plugin's
// server bundle from bundle-evaluator.js, so a bare `import("@resvg/resvg-js")` resolved from the Paseo install and
// every avatar save failed ("Cannot find package '@resvg/resvg-js' imported from …/bundle-evaluator.js"). It must be
// resolved from the bots plugin's own folder: Paseo's config (plugins.bots.path), else the install (~/.dinobot/app/bots).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { buildSync } from "esbuild";
import { loadResvg, resolveResvg, resvgRenderer } from "../server/avatar-store";
import { botsPluginDirs } from "../server/plugin-dir";

const TMP = mkdtempSync(join(tmpdir(), "avatar-resvg-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const PLUGIN = resolve(__dirname, "..");

/** A plugin folder holding a stand-in resvg-js whose PNG is `marker`. */
function fakePlugin(name: string, marker: string): string {
  const dir = join(TMP, name);
  const pkg = join(dir, "node_modules", "@resvg", "resvg-js");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@resvg/resvg-js", version: "0.0.0", main: "index.js" }));
  writeFileSync(
    join(pkg, "index.js"),
    `module.exports.Resvg = class { constructor(svg, o) { this.w = o.fitTo.value; } render() { return { asPng: () => Buffer.from(${JSON.stringify(marker)} + this.w) }; } };\n`,
  );
  return dir;
}

function paseoHome(name: string, botsPath: string | null): string {
  const home = join(TMP, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(botsPath ? { plugins: { bots: { source: "directory", path: botsPath } } } : {}));
  return home;
}

test("botsPluginDirs: Paseo's plugins.bots.path first, then the install's app/bots", () => {
  const home = paseoHome("cfg-dirs", "/src/plugins/bots");
  assert.deepEqual(botsPluginDirs({ PASEO_HOME: home, HOME: "/h" }), ["/src/plugins/bots", join("/h", ".dinobot", "app", "bots")]);
  assert.deepEqual(botsPluginDirs({ PASEO_HOME: join(TMP, "no-such"), HOME: "/h", DINOBOT_HOME: "/d" }), [join("/d", "app", "bots")]);
});

test("resolveResvg: from the configured plugin folder, else the install, else null", () => {
  const source = fakePlugin("source", "S");
  const dinobot = join(TMP, "dinobot");
  const installed = fakePlugin(join("dinobot", "app", "bots"), "I");
  assert.equal(resolveResvg({ PASEO_HOME: paseoHome("cfg-source", source), DINOBOT_HOME: dinobot }), join(source, "node_modules", "@resvg", "resvg-js", "index.js"));
  assert.equal(resolveResvg({ PASEO_HOME: paseoHome("cfg-none", null), DINOBOT_HOME: dinobot }), join(installed, "node_modules", "@resvg", "resvg-js", "index.js"));
  assert.equal(resolveResvg({ PASEO_HOME: paseoHome("cfg-empty", join(TMP, "empty")), DINOBOT_HOME: join(TMP, "nothing") }), null);
});

test("loadResvg loads the plugin folder's resvg-js, not the caller's", async () => {
  const dir = fakePlugin("render", "R");
  const render = await loadResvg({ PASEO_HOME: paseoHome("cfg-render", dir), DINOBOT_HOME: join(TMP, "nothing") });
  assert.equal(String(await render("<svg/>", 64)), "R64");
});

// The live failure: the plugin compiled as Paseo does (esbuild, cjs, node) and evaluated by a script outside the plugin
// folder, whose own resolution has no resvg-js; the real resvg-js then renders a PNG.
test("bundled and evaluated outside the plugin folder (as Paseo does), a render still finds resvg-js", () => {
  const entry = join(TMP, "entry.ts");
  writeFileSync(
    entry,
    `import { resvgRenderer } from ${JSON.stringify(join(PLUGIN, "server", "avatar-store"))};\n` +
      `export default async (env: NodeJS.ProcessEnv) => { const r = await resvgRenderer(env); const png = await r('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', 64); return png.readUInt32BE(16); };\n`,
  );
  const { outputFiles } = buildSync({ entryPoints: [entry], bundle: true, format: "cjs", platform: "node", target: "node20", write: false, logLevel: "silent" });
  const bundle = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${outputFiles[0]!.text}\nreturn module.exports;\n})`;
  const host = join(TMP, "host");
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, "bundle.js"), bundle);
  // bundle-evaluator.js in miniature: an indirect eval, `require` anchored on the host's own folder.
  writeFileSync(
    join(host, "evaluator.mjs"),
    `import { createRequire } from "node:module"; import { readFileSync } from "node:fs";\n` +
      `const factory = globalThis.eval(readFileSync(new URL("./bundle.js", import.meta.url), "utf8"));\n` +
      `const width = await factory(createRequire(import.meta.url)).default(JSON.parse(process.argv[2]));\n` +
      `console.log(width);\n`,
  );
  const env = { PASEO_HOME: paseoHome("cfg-real", PLUGIN), DINOBOT_HOME: join(TMP, "nothing") };
  const run = spawnSync(process.execPath, [join(host, "evaluator.mjs"), JSON.stringify(env)], { cwd: host, encoding: "utf8" });
  assert.equal(run.stderr.trim(), "");
  assert.equal(run.stdout.trim(), "64");
});
