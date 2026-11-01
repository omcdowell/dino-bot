#!/usr/bin/env bash
# Local gate before ANY release push (28 Oct: "protections not to continually burn credit").
# build/publish-public.sh refuses to push a release tag unless this passed on the same tree hash.
#
#   SOURCES_GIT=<the build/prepare-sources.sh repo> build/preflight-release.sh
#
# On exactly the tree build/publish-public.sh would push (its dry-run output, a fresh clone of it):
#   1. build/workflow-check.py policy: every workflow is tag-only, cancels in-progress runs, has
#      timeouts, runs macOS (10x minutes) only after the Linux builds
#   2. actionlint on .github/workflows (ACTIONLINT=<path>, or on PATH; a pinned copy in
#      ~/.cache/dinobot-preflight is used if present; skipped with a warning if none)
#   3. the workflow's own unit-test step (read from release.yml, run verbatim)
#   4. the workflow's build step: build/ci-build.sh linux-x64 from the src/* commits, full daemon
#      build (no prebuilt shortcut), under a 7 GB memory cap (GitHub's private-repo runners:
#      Linux 8 GB, macOS 7 GB); then the workflow's secret-scan step, verbatim
#   5. the release job's checks that need no GitHub: checksum, one install.sh, stamped from
#      lib/signing.json (that step, verbatim, on the one tarball), identityRegexp() loads
#   Pass: writes PREFLIGHT_DIR/<tree hash> (tree + src/* commits); publish-public.sh needs it for TAG.
#
# Env: SOURCES_GIT (required), TAG, PREFLIGHT_DIR (default ~/.cache/dinobot-preflight/passed),
#      PREFLIGHT_WORK (default .cache/preflight), PREFLIGHT_MEM (default 7G; `heavy` cap if present),
#      GITLEAKS/ACCEPT_SCAN as for build/publish-public.sh. The tarball's private-name guard must
#      have its patterns here (DINOBOT_REQUIRE_GUARD=1; see build/private-guard.sh).
# Not covered here (no such runner locally): linux-arm64, darwin-arm64, the signing itself.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
: "${SOURCES_GIT:?set SOURCES_GIT to the build/prepare-sources.sh repo (src/* branches)}"
PREFLIGHT_DIR=${PREFLIGHT_DIR:-$HOME/.cache/dinobot-preflight/passed}
W=${PREFLIGHT_WORK:-$HERE/.cache/preflight}
MEM=${PREFLIGHT_MEM:-7G}
WF=.github/workflows/release.yml
say() { printf '== preflight: %s\n' "$*"; }
die() { printf 'preflight: FAIL: %s\n' "$*" >&2; exit 1; }
step() { python3 "$HERE/build/workflow-check.py" step "$R/$WF" "$@"; }
rm -rf "$W"; mkdir -p "$W"

# 0. The exact tree build/publish-public.sh would push.
say "dry run of build/publish-public.sh"
build/publish-public.sh --dry-run "$W/pub" >"$W/dryrun.log" 2>&1 || { cat "$W/dryrun.log" >&2; die "build/publish-public.sh --dry-run"; }
grep '^== ' "$W/dryrun.log" | sed 's/^/   /'
TREE=$(git -C "$W/pub/tree" rev-parse 'HEAD^{tree}')
R=$W/repo
git clone -q --no-local "$W/pub/tree" "$R"
[ "$(git -C "$R" rev-parse 'HEAD^{tree}')" = "$TREE" ] || die "clone tree differs"
say "tree $TREE"

# 1-2. Workflow rules, actionlint.
python3 build/workflow-check.py policy "$R/.github/workflows"
AL=${ACTIONLINT:-$(command -v actionlint || ls -d "$HOME"/.cache/dinobot-preflight/actionlint-*/actionlint 2>/dev/null | tail -1 || true)}
if [ -n "$AL" ] && [ -x "$AL" ]; then
  (cd "$R" && "$AL" -no-color) || die "actionlint"
  say "actionlint ok ($("$AL" --version | head -1))"
else
  say "WARNING: actionlint not found, skipped"
fi

# 3. The workflow's unit tests, on the pushed tree, with the pinned Node.
[ "$(node -v)" = "v$(jq -r .node "$R/build/sources.json")" ] || die "node $(node -v), sources.json wants $(jq -r .node "$R/build/sources.json")"
TESTS=$(step test "unit tests (incl. fail-closed checksum + signature)")
say "tests: $TESTS"
(cd "$R" && bash -euo pipefail -c "$TESTS") >"$W/tests.log" 2>&1 || { grep -E '^not ok|✖|# (pass|fail)' "$W/tests.log" | head -30 >&2; die "the workflow's unit tests fail on this tree ($W/tests.log)"; }
say "tests ok ($(grep -E '^ℹ (pass|fail)' "$W/tests.log" | tr '\n' ' '))"

# 4. The build job for linux-x64: sources at the pinned commits, ci-build.sh, secret scan.
for k in paseo:paseo bots:paseo-bots optchat:pi-optchat; do
  want=$(jq -r ".${k%%:*}.commit" "$R/build/sources.json")
  d=$R/src/${k#*:} # where the workflow checks them out
  git clone -q --no-local --no-checkout "$W/pub/tree" "$d"
  git -C "$d" fetch -q origin "refs/heads/src/${k#*:}"
  git -C "$d" -c advice.detachedHead=false checkout -q "$want"
done
BUILD=$(step build-linux "build \${{ matrix.target }}" matrix.target=linux-x64)
say "build: $BUILD (memory cap $MEM)"
T0=$(date +%s)
CAP=(); command -v heavy >/dev/null && CAP=(env HEAVY_MAX="$MEM" heavy)
(cd "$R" && env -u GITHUB_ACTIONS -u CI_PREBUILT_DAEMON DINOBOT_REQUIRE_GUARD=1 "${CAP[@]}" bash -euo pipefail -c "$BUILD") >"$W/ci-build.log" 2>&1 ||
  { tail -40 "$W/ci-build.log" >&2; die "ci-build.sh linux-x64 ($W/ci-build.log)"; }
say "build ok in $(( ($(date +%s) - T0) / 60 )) min ($(ls -la "$R/dist/dinobot-linux-x64.tar.gz" | awk '{print $5}') bytes)"
SCAN=$(step build-linux "secret scan of the staged tarball" matrix.target=linux-x64)
(cd "$R" && bash -euo pipefail -c "${SCAN//\/tmp\/scan/$W/scan}") >"$W/scan.log" 2>&1 || { cat "$W/scan.log" >&2; die "secret scan"; }
rm -rf "$W/scan"
say "secret scan ok"

# 5. The release job's collect step on this one tarball; the verify step's identity regexp.
mkdir -p "$W/rel/out/tarball-linux-x64"
cp "$R"/dist/dinobot-linux-x64.tar.gz "$R"/dist/dinobot-linux-x64.tar.gz.sha256 "$R"/dist/install.sh "$W/rel/out/tarball-linux-x64/"
COLLECT=$(step release "collect, check checksums, one install.sh")
(cd "$R" && rm -rf release out && cp -r "$W/rel/out" out && bash -euo pipefail -c "$COLLECT" && rm -rf release out) >"$W/collect.log" 2>&1 || { cat "$W/collect.log" >&2; die "release collect step"; }
(cd "$R" && node -e 'import("./lib/signature.mjs").then(m => { const r = m.identityRegexp(); if (!r) process.exit(1); console.log(r) })') >"$W/identity.log" 2>&1 || { cat "$W/identity.log" >&2; die "identityRegexp"; }
say "release checks ok (identity $(cat "$W/identity.log"))"

# Pass: the stamp build/publish-public.sh looks for.
mkdir -p "$PREFLIGHT_DIR"
{
  echo "tree $TREE"
  for k in paseo paseo-bots pi-optchat; do echo "src/$k $(git -C "$W/pub/tree" rev-parse "src/$k")"; done
  echo "installer $(git rev-parse HEAD)"
  echo "linux-x64 $(cut -d' ' -f1 "$R/dist/dinobot-linux-x64.tar.gz.sha256")"
  echo "date $(date -u +%FT%TZ)"
} >"$PREFLIGHT_DIR/$TREE"
mkdir -p "$PREFLIGHT_DIR/$TREE.logs" && cp "$W"/*.log "$PREFLIGHT_DIR/$TREE.logs/"
say "PASS: tree $TREE ($PREFLIGHT_DIR/$TREE). build/publish-public.sh may tag this tree."
