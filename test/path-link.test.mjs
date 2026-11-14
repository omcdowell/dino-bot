// `dinobot` on PATH: ~/.local/bin/dinobot -> ~/.dinobot/bin/dinobot (setup, update), the
// not-on-PATH line, and uninstall removing only our link.
// node --test test/path-link.test.mjs   (temp HOMEs under ./.test-tmp-path-link, never the real HOME)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { commandName, dirOnPath, ensurePathLink, linkPaths, linkState, pathHint, removePathLink } from "../lib/path-link.mjs";
import { uninstall } from "../lib/uninstall.mjs";
import { layout, PRODUCT_ID } from "../lib/util.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-path-link");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => {
  process.exitCode = 0;
});

let n = 0;
const put = (p, text = "x") => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
/** A throwaway HOME with the wrapper in place; PATH as given (default: without ~/.local/bin). */
function home({ path = "/usr/bin:/bin", shell = "/bin/bash", extra = {} } = {}) {
  const h = join(TMP, `h${++n}`);
  const env = { HOME: h, PATH: path.replaceAll("$HOME", h), SHELL: shell, ...extra };
  const L = layout(env);
  put(join(L.bin, PRODUCT_ID), "#!/bin/sh\necho dinobot\n");
  return { h, env, L, ...linkPaths(L) };
}

describe("ensurePathLink", () => {
  it("creates ~/.local/bin (and the link) when missing", () => {
    const { env, L, dir, link, target } = home();
    assert.equal(existsSync(dir), false);
    const r = ensurePathLink(L, { env, os: "linux" });
    assert.equal(r.status, "created");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), target);
    assert.equal(readFileSync(link, "utf8"), "#!/bin/sh\necho dinobot\n");
  });

  it("links only dinobot, not paseo, herdr, pi or git", () => {
    const { env, L, dir } = home();
    for (const w of ["paseo", "herdr", "pi", "git"]) put(join(L.bin, w), "#!/bin/sh\n");
    ensurePathLink(L, { env });
    for (const w of ["paseo", "herdr", "pi", "git"]) assert.equal(existsSync(join(dir, w)), false, w);
  });

  it("is idempotent: a second run keeps the same link", () => {
    const { env, L, link, target } = home();
    assert.equal(ensurePathLink(L, { env }).status, "created");
    const r = ensurePathLink(L, { env });
    assert.equal(r.status, "kept");
    assert.equal(readlinkSync(link), target);
  });

  it("repairs our stale or broken link (update)", () => {
    const { env, L, dir, link, target } = home();
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(L.root, "bin", "old-name"), link); // into our root, broken
    const r = ensurePathLink(L, { env });
    assert.equal(r.status, "repaired");
    assert.equal(readlinkSync(link), target);
  });

  it("leaves a file of the user's alone and warns", () => {
    const { env, L, link, target } = home({ path: "$HOME/.local/bin:/usr/bin" });
    put(link, "my own dinobot script");
    const r = ensurePathLink(L, { env });
    assert.equal(r.status, "foreign");
    assert.equal(readFileSync(link, "utf8"), "my own dinobot script");
    assert.match(r.note, /already exists \(file\) and is not DinoBot's/);
    assert.equal(r.command, target, "later commands use the full path");
    assert.equal(r.onPath, false);
  });

  it("leaves a symlink to something else alone (e.g. another install's root)", () => {
    const { env, L, dir, link } = home();
    mkdirSync(dir, { recursive: true });
    symlinkSync("/opt/other/dinobot", link);
    const r = ensurePathLink(L, { env });
    assert.equal(r.status, "foreign");
    assert.equal(readlinkSync(link), "/opt/other/dinobot");
    assert.match(r.note, /link to \/opt\/other\/dinobot/);
  });

  it("on PATH: no hint, commands are plain `dinobot`", () => {
    const { env, L } = home({ path: "/usr/bin:$HOME/.local/bin:/bin" });
    const r = ensurePathLink(L, { env });
    assert.equal(r.onPath, true);
    assert.equal(r.note, null);
    assert.equal(r.command, PRODUCT_ID);
    assert.equal(commandName(L, env), PRODUCT_ID);
  });

  it("not on PATH: prints the exact one line for bash (Linux) and the full path", () => {
    const { env, L, target, h } = home();
    const before = existsSync(join(h, ".bashrc"));
    const r = ensurePathLink(L, { env, os: "linux" });
    assert.equal(r.onPath, false);
    assert.equal(r.command, target);
    assert.ok(r.note.includes(`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`), r.note);
    assert.ok(r.note.includes(`Until then: ${target}`));
    assert.equal(existsSync(join(h, ".bashrc")), before, "no rc file written");
    assert.equal(commandName(L, env), target);
  });

  it("not on PATH, zsh (macOS): the line goes to ~/.zshrc; no rc file is touched", () => {
    const { env, L, h } = home({ shell: "/bin/zsh" });
    const r = ensurePathLink(L, { env, os: "darwin" });
    assert.ok(r.note.includes(`>> ~/.zshrc`));
    assert.equal(existsSync(join(h, ".zshrc")), false);
    assert.equal(existsSync(join(h, ".zprofile")), false);
  });

  it("pathHint: SHELL wins, else the platform default", () => {
    assert.match(pathHint({ SHELL: "/usr/bin/zsh" }, "linux"), />> ~\/\.zshrc$/);
    assert.match(pathHint({ SHELL: "/bin/bash" }, "darwin"), />> ~\/\.bashrc$/);
    assert.match(pathHint({}, "darwin"), />> ~\/\.zshrc$/);
    assert.match(pathHint({}, "linux"), />> ~\/\.bashrc$/);
    assert.equal(pathHint({ SHELL: "/usr/bin/fish" }, "linux"), "fish_add_path ~/.local/bin");
  });

  it("dirOnPath: ~/ entries and trailing slashes count", () => {
    const { h, dir } = home();
    assert.equal(dirOnPath(dir, { HOME: h, PATH: "~/.local/bin:/usr/bin" }), true);
    assert.equal(dirOnPath(dir, { HOME: h, PATH: `${dir}/:/usr/bin` }), true);
    assert.equal(dirOnPath(dir, { HOME: h, PATH: "/usr/bin" }), false);
  });

  it("DINOBOT_NO_PATH_LINK=1 skips it", () => {
    const { env, L, link } = home({ extra: { DINOBOT_NO_PATH_LINK: "1" } });
    assert.equal(ensurePathLink(L, { env }).status, "skipped");
    assert.equal(existsSync(link), false);
  });
});

describe("uninstall and the link", () => {
  const quiet = (env) => ({ env, out: { text: "", write(s) { this.text += s; } }, stop: async () => {}, removeServices: async () => {}, wsl: null, mode: "none", exec: async () => ({ code: 0, stdout: "" }) });

  it("plain uninstall removes our link, keeps ~/.local/bin and the user's other files there", async () => {
    const { env, L, dir, link } = home();
    ensurePathLink(L, { env });
    put(join(dir, "mytool"), "mine");
    const r = await uninstall(L, {}, quiet(env));
    assert.ok(r.ok);
    assert.ok(r.removed.includes(link));
    assert.equal(existsSync(link), false);
    assert.throws(() => lstatSync(link));
    assert.ok(existsSync(dir), "~/.local/bin is never removed");
    assert.equal(readFileSync(join(dir, "mytool"), "utf8"), "mine");
  });

  it("--purge --yes removes our link too and lists it", async () => {
    const { env, L, dir, link } = home();
    ensurePathLink(L, { env });
    const d = quiet(env);
    const r = await uninstall(L, { purge: true, yes: true }, d);
    assert.ok(r.removed.includes(link));
    assert.match(d.out.text, /\.local\/bin\/dinobot  \(the `dinobot` command\)/);
    assert.ok(existsSync(dir));
  });

  it("an empty ~/.local/bin stays", async () => {
    const { env, L, dir } = home();
    ensurePathLink(L, { env });
    await uninstall(L, { purge: true, yes: true }, quiet(env));
    assert.ok(existsSync(dir));
  });

  it("a foreign ~/.local/bin/dinobot (file or other link) is never removed", async () => {
    const a = home();
    put(a.link, "mine");
    await uninstall(a.L, {}, quiet(a.env));
    assert.equal(readFileSync(a.link, "utf8"), "mine");
    const b = home();
    mkdirSync(b.dir, { recursive: true });
    symlinkSync("/opt/other/dinobot", b.link);
    await uninstall(b.L, { purge: true, yes: true }, quiet(b.env));
    assert.equal(readlinkSync(b.link), "/opt/other/dinobot");
    assert.equal(removePathLink(b.L), null);
    assert.equal(linkState(b.L).kind, "foreign");
  });
});

describe("update keeps the link", () => {
  // update() prints with process.stdout.write: run it in a child, with the throwaway HOME's env.
  const runUpdate = (L, opts, env) =>
    new Promise((res) => {
      const code = `import { update } from ${JSON.stringify(join(import.meta.dirname, "..", "lib", "update.mjs"))};
        const r = await update(${JSON.stringify(L)}, ${JSON.stringify(opts)}); console.log("RESULT" + JSON.stringify(r));`;
      execFile(process.execPath, ["--input-type=module", "-e", code], { env: { ...env, DINOBOT_BASE_URL: "" }, timeout: 60_000 }, (e, stdout, stderr) => {
        const m = /RESULT(.*)/.exec(stdout);
        res({ r: m ? JSON.parse(m[1]) : { crashed: stderr }, out: stdout + stderr });
      });
    });

  it("`update` (already up to date) creates a missing link and repairs a stale one", async () => {
    const { env, L, dir, link, target, h } = home({ path: `${process.env.PATH}` });
    const tar = join(h, "dl", `${PRODUCT_ID}.tar.gz`);
    put(tar, "same build");
    const sha = createHash("sha256").update(readFileSync(tar)).digest("hex");
    writeFileSync(`${tar}.sha256`, `${sha}  x\n`);
    put(L.state, JSON.stringify({ tarballSha256: sha, serviceMode: "none", port: 1 }));
    let { r, out } = await runUpdate(L, { tarball: tar }, env);
    assert.equal(r.changed, false, out);
    assert.match(out, /already up to date/);
    assert.equal(readlinkSync(link), target, out);
    assert.match(out, /Linked .*\.local\/bin\/dinobot/);
    rmSync(link);
    symlinkSync(join(L.root, "bin", "gone"), link);
    ({ out } = await runUpdate(L, { tarball: tar }, env));
    assert.equal(readlinkSync(link), target, out);
    ({ out } = await runUpdate(L, { tarball: tar }, env));
    assert.doesNotMatch(out, /Linked/, "kept quietly");
    assert.ok(existsSync(dir));
  });
});
