// build/publish-public.sh (node --test test/publish-public.test.mjs). GitHub is a fake `gh` on PATH
// backed by a local bare repo (PUSH_URL), so nothing touches the network.
//   dry run (default): public/main = ONE root commit of HEAD minus demo/, checks, a plan; no push
//   --for-real: friend tags/releases and stray branches deleted, main + src/* replaced, clean tags kept
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".test-tmp-publish-public");
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, ...ID }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const REPO = JSON.parse(readFileSync(join(ROOT, "lib", "product.json"), "utf8")).releaseRepo;

// Just what publish-public.sh calls. State: $FAKE/remote.git (bare), $FAKE/releases (one tag per line).
const FAKE_GH = `#!/bin/bash
R=$FAKE/remote.git
g() { git --git-dir="$R" "$@"; }
echo "$*" >>"$FAKE/calls"
a="$*"
case "$a" in
  "auth status"*) exit 0 ;;
  "repo view "*"--json visibility"*) echo PRIVATE ;;
  "repo view "*"--json nameWithOwner"*) [ -d "$R" ] || exit 1; cat "$FAKE/renamed" 2>/dev/null || echo "$3" ;;
  "repo view "*) [ -d "$R" ] ;;
  "repo create "*) if [ -f "$FAKE/renamed" ]; then mv "$R" "$FAKE/renamed.git"; rm "$FAKE/renamed"; fi; git init -q --bare -b main "$R" ;;
  "release list "*) cat "$FAKE/releases" 2>/dev/null; exit 0 ;;
  "release delete "*) t=$3; grep -vx "$t" "$FAKE/releases" >"$FAKE/r.tmp"; mv "$FAKE/r.tmp" "$FAKE/releases"
    [[ "$a" == *--cleanup-tag* ]] && g tag -d "$t" >/dev/null; exit 0 ;;
  "api -X DELETE repos/"*"/git/refs/tags/"*) t=\${a##*/tags/}; g tag -d "\${t%% *}" >/dev/null ;;
  "api -X DELETE repos/"*"/git/refs/heads/"*) b=\${a##*/heads/}; g branch -D "\${b%% *}" >/dev/null ;;
  "api repos/"*"/tags?"*) g tag ;;
  "api repos/"*"/contents/FRIEND-SETUP.md?ref="*) r=\${a#*ref=}; r=\${r%% *}; g cat-file -e "$r:FRIEND-SETUP.md" 2>/dev/null ;;
  "api repos/"*"/branches?"*) g for-each-ref --format='%(refname:lstrip=2)' refs/heads ;;
  "api repos/"*"/commits?sha=main"*) n=$(g rev-list --count main); [ "$n" -gt 2 ] && n=2; echo "$n" ;;
  "api -H Accept: application/vnd.github.raw repos/"*"/contents/install.sh?ref=main") g show main:install.sh ;;
  *) echo "fake gh: unhandled: $a" >&2; exit 1 ;;
esac
`;

function setup() {
  const dir = mkdtempSync(join(TMP, "p-"));
  // The source snapshots: three one-commit branches.
  const sources = join(dir, "sources");
  mkdirSync(sources);
  git(sources, "init", "-q", "-b", "x");
  const pins = {};
  for (const [k, b] of [["paseo", "src/paseo"], ["bots", "src/paseo-bots"], ["optchat", "src/pi-optchat"]]) {
    writeFileSync(join(sources, "README.md"), `${b}\n`);
    git(sources, "add", "-A");
    const tree = git(sources, "write-tree");
    pins[k] = git(sources, "commit-tree", tree, "-m", b);
    git(sources, "update-ref", `refs/heads/${b}`, pins[k]);
  }
  // A minimal installer checkout (the script archives HEAD of its own repo).
  const src = join(dir, "installer");
  for (const d of ["lib", "build", "demo"]) mkdirSync(join(src, d), { recursive: true });
  for (const f of ["build/publish-public.sh", "build/public-check.mjs", "build/private-guard.sh", "install.sh", "lib/product.json", "LICENSE"]) copyFileSync(join(ROOT, f), join(src, f));
  writeFileSync(join(src, "demo", "demo.py"), "print('demo')\n");
  const sj = { node: "24", ...Object.fromEntries(Object.entries(pins).map(([k, c]) => [k, { repo: REPO, commit: c }])) };
  writeFileSync(join(src, "build", "sources.json"), `${JSON.stringify(sj, null, 2)}\n`);
  git(src, "init", "-q", "-b", "public/release");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "x");
  // "GitHub": the friend-test publish (FRIEND-SETUP.md on main, a friend release + tag, an old
  // src branch, a stray branch) and one clean tag.
  const fake = join(dir, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  writeFileSync(join(fake, "bin", "gh"), FAKE_GH);
  chmodSync(join(fake, "bin", "gh"), 0o755);
  writeFileSync(join(fake, "bin", "gitleaks"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fake, "bin", "gitleaks"), 0o755);
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# old\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "clean");
  git(seed, "tag", "v0.0.1");
  writeFileSync(join(seed, "FRIEND-SETUP.md"), "invite steps\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "friend");
  git(seed, "tag", "v0.1.0-friend.3");
  git(seed, "tag", "v0.1.0-rc"); // no "friend" in the name, but the tree has the page
  git(seed, "branch", "src/paseo");
  git(seed, "branch", "old-branch");
  git(dir, "clone", "-q", "--bare", seed, join(fake, "remote.git"));
  writeFileSync(join(fake, "releases"), "v0.1.0-friend.3\n");
  return { dir, src, sources, fake, remote: join(fake, "remote.git"), pins };
}

function publish(s, args = [], env = {}) {
  return spawnSync("bash", [join(s.src, "build", "publish-public.sh"), ...args], {
    cwd: s.src,
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${join(s.fake, "bin")}:${process.env.PATH}`, FAKE: s.fake, PUSH_URL: s.remote,
      GITLEAKS: join(s.fake, "bin", "gitleaks"), DINOBOT_PUBLIC_CHECK_LOCAL: "0", DINOBOT_PRIVATE_PATTERNS: join(s.dir, "none"),
      DINOBOT_PUBLIC_CHECK_ALLOW: join(s.dir, "none"), DINOBOT_PRIVATE_GUARD: "zz-private-name", SOURCES_GIT: s.sources, ...env,
    },
  });
}

describe("build/publish-public.sh", () => {
  it("dry run (default): public/main is one root commit without demo/ or friend files; nothing pushed", () => {
    const s = setup();
    const before = git(s.remote, "for-each-ref");
    const r = publish(s, [join(s.dir, "out")]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /dry run: nothing sent/);
    assert.match(r.stdout, /would: delete every release and tag/);
    assert.equal(git(s.src, "rev-list", "--count", "public/main"), "1");
    const files = git(s.src, "ls-tree", "-r", "--name-only", "public/main").split("\n");
    assert.ok(files.includes("install.sh") && !files.some((f) => f.startsWith("demo/")), files.join(" "));
    assert.equal(git(s.src, "log", "-1", "--format=%an <%ae> %ad", "--date=iso", "public/main"), "omcdowell <omcdowell@users.noreply.github.com> 2026-11-01 00:00:00 +0000");
    assert.equal(git(s.remote, "for-each-ref"), before);
    assert.ok(!existsSync(join(s.fake, "calls")), "the dry run called gh");
    // Same tree -> same commit.
    const first = git(s.src, "rev-parse", "public/main");
    assert.equal(publish(s, [join(s.dir, "out2")]).status, 0);
    assert.equal(git(s.src, "rev-parse", "public/main"), first);
  });

  it("refuses a tree with FRIEND-SETUP.md, or a src/* pin that does not match", () => {
    let s = setup();
    writeFileSync(join(s.src, "FRIEND-SETUP.md"), "x\n");
    git(s.src, "add", "-A");
    git(s.src, "commit", "-qm", "friend page");
    let r = publish(s, [join(s.dir, "out")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FRIEND-SETUP\.md/);
    s = setup();
    git(s.sources, "update-ref", "refs/heads/src/paseo", s.pins.bots);
    r = publish(s, [join(s.dir, "out")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sources\.json pins paseo/);
  });

  it("--for-real: friend tags/releases and stray branches gone, main and src/* replaced, clean tag kept", () => {
    const s = setup();
    const r = publish(s, ["--for-real", join(s.dir, "out")]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const tags = git(s.remote, "tag").split("\n").filter(Boolean);
    assert.deepEqual(tags, ["v0.0.1"]);
    assert.equal(readFileSync(join(s.fake, "releases"), "utf8").trim(), "");
    const branches = git(s.remote, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads").split("\n").sort();
    assert.deepEqual(branches, ["main", "src/paseo", "src/paseo-bots", "src/pi-optchat"]);
    assert.equal(git(s.remote, "rev-parse", "main"), git(s.src, "rev-parse", "public/main"));
    assert.equal(git(s.remote, "rev-list", "--count", "main"), "1");
    for (const [k, b] of [["paseo", "src/paseo"], ["bots", "src/paseo-bots"], ["optchat", "src/pi-optchat"]]) assert.equal(git(s.remote, "rev-parse", b), s.pins[k]);
    assert.match(r.stdout, /Visibility unchanged \(PRIVATE\)/);
    assert.doesNotMatch(readFileSync(join(s.fake, "calls"), "utf8"), /repo edit|visibility public/);
  });

  it("--for-real on a deleted repo: creates it private and empty, then pushes", () => {
    const s = setup();
    rmSync(s.remote, { recursive: true, force: true });
    rmSync(join(s.fake, "releases"));
    const r = publish(s, ["--for-real", join(s.dir, "out")]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /created .* \(private, empty\)/);
    assert.equal(git(s.remote, "rev-list", "--count", "main"), "1");
    assert.equal(git(s.remote, "tag"), "");
  });

  it("--for-real when the repo was renamed (old name redirects): creates a new one, the renamed repo is untouched", () => {
    const s = setup();
    const owner = REPO.split("/")[0];
    writeFileSync(join(s.fake, "renamed"), `${owner}/dino-bot-friends\n`);
    const before = git(s.remote, "for-each-ref", "--format=%(refname) %(objectname)");
    const r = publish(s, ["--for-real", join(s.dir, "out")]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /redirects to .*dino-bot-friends \(renamed\)/);
    assert.match(r.stdout, /created .* \(private, empty\)/);
    const old = join(s.fake, "renamed.git");
    assert.equal(git(old, "for-each-ref", "--format=%(refname) %(objectname)"), before, "renamed repo unchanged");
    assert.ok(git(old, "tag").includes("v0.1.0-friend.3"));
    assert.equal(git(s.remote, "rev-list", "--count", "main"), "1");
    assert.equal(git(s.remote, "tag"), "");
  });

  it("--for-real needs SOURCES_GIT and the private-name patterns; TAG needs a preflight pass", () => {
    let s = setup();
    let r = publish(s, ["--for-real", join(s.dir, "out")], { SOURCES_GIT: "" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs SOURCES_GIT/);
    r = publish(s, ["--for-real", join(s.dir, "out")], { DINOBOT_PRIVATE_GUARD: "", DINOBOT_PRIVATE_GUARD_FILE: join(s.dir, "none") });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /private-guard/);
    s = setup();
    r = publish(s, ["--for-real", join(s.dir, "out")], { TAG: "v0.1.0", PREFLIGHT_DIR: join(s.dir, "pf") });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /preflight-release\.sh has not passed/);
    assert.ok(git(s.remote, "tag").includes("v0.1.0-friend.3"), "nothing may change before the preflight check");
  });
});
