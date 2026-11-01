// test/luna.mjs (the test/demo model helper): no token is copied into the throwaway host, pi's key
// command reads it from the given auth.json, `off` removes it. No real model is called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { auth, keyCommand, LUNA, off } from "./luna.mjs";

const dir = join(import.meta.dirname, "..", ".test-tmp-luna");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
after(() => rmSync(dir, { recursive: true, force: true }));
const TOKEN = "fake.eyJ0ZXN0Ijp0cnVlfQ.sig";
const src = join(dir, "real-auth.json");
writeFileSync(src, JSON.stringify({ "openai-codex": { type: "oauth", access: TOKEN, refresh: "R-SECRET", expires: Date.now() + 86_400_000 }, anthropic: { type: "oauth", access: "A-SECRET" } }));

it("auth: DinoBot's pi gets a key command, never the token; defaults are luna low", () => {
  const home = join(dir, "home");
  const { authPath, modelsPath, reader } = auth(home, src);
  const models = readFileSync(modelsPath, "utf8");
  assert.ok(!models.includes(TOKEN), "no secret in DinoBot's models.json");
  assert.equal(JSON.parse(models).providers["openai-codex"].apiKey, keyCommand(process.execPath, reader), "pi 1.4.0 reads openai-codex keys from models.json");
  const text = readFileSync(authPath, "utf8");
  assert.ok(!text.includes(TOKEN) && !text.includes("R-SECRET") && !text.includes("A-SECRET"), "no secret in DinoBot's auth.json");
  assert.ok(!readFileSync(reader, "utf8").includes(TOKEN), "no secret in the reader");
  const entry = JSON.parse(text)["openai-codex"];
  assert.equal(entry.type, "api_key");
  assert.equal(entry.key, keyCommand(process.execPath, reader));
  assert.equal(Object.keys(JSON.parse(text)).join(), "openai-codex", "only the Codex login is offered");
  // pi runs the command through a shell: what it prints is the access token.
  assert.equal(execFileSync("/bin/sh", ["-c", entry.key.slice(1)], { encoding: "utf8" }), TOKEN);
  const s = JSON.parse(readFileSync(join(home, ".dinobot", "pi", "settings.json"), "utf8"));
  assert.deepEqual([s.defaultProvider, s.defaultModel, s.defaultThinkingLevel], [LUNA.provider, "gpt-5.6-luna", "low"]);
  off(home);
  assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"], undefined);
  assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers["openai-codex"], undefined);
});

it("runs as a script through a symlinked path too (macOS /tmp -> /private/tmp)", () => {
  const link = join(dir, "link");
  symlinkSync(import.meta.dirname, link);
  const home = join(dir, "h-cli");
  const out = execFileSync(process.execPath, [join(link, "luna.mjs"), "auth", home, src], { encoding: "utf8" });
  assert.match(out, /reads the Codex login/);
  assert.ok(!out.includes(TOKEN));
  assert.equal(JSON.parse(readFileSync(join(home, ".dinobot", "pi", "auth.json"), "utf8"))["openai-codex"].type, "api_key");
});

it("auth: refuses a missing or expired Codex login", () => {
  const none = join(dir, "none.json");
  writeFileSync(none, "{}");
  assert.throws(() => auth(join(dir, "h2"), none), /no openai-codex login/);
  const old = join(dir, "old.json");
  writeFileSync(old, JSON.stringify({ "openai-codex": { access: "x", expires: Date.now() - 1 } }));
  assert.throws(() => auth(join(dir, "h3"), old), /expired/);
});
