#!/usr/bin/env bash
# Make omcdowell/dino-bot ready to be public: ONE fresh commit on main (no old history, so no
# friend-test file in any commit) holding every source folder (paseo/, plugins/bots/, optchat/,
# addons/paseo-apns/, the installer), and every tag/release from the private friend test removed.
# The old src/* source branches are gone: the sources are folders of main (a real run deletes them).
#
#   build/publish-public.sh [--dry-run] [OUT]   DEFAULT. Builds the public commit, sets the local
#                                               branch public/main to it, checks everything and
#                                               prints what a real run would do. No network.
#   build/publish-public.sh --for-real [OUT]    Does it on GitHub (maintainer only, after review).
#
# The public commit: `git archive HEAD` of this repo minus demo/, author omcdowell <noreply>,
# 2026-11-01 +0000, message: the product name, so the same tree always gives the same commit.
#
# Checks (all fatal; a real run also needs the scanners):
#   - no FRIEND-SETUP.md in any commit that would be pushed
#   - build/public-check.mjs on the tree (friend pages, Tailscale
#     addresses, this computer's own details, the private patterns file outside the repo)
#   - build/private-guard.sh on the same (private names; patterns kept outside the repo)
#   - gitleaks over every commit to be pushed (findings: read them, then ACCEPT_SCAN=1)
#
# A real run, in this order (stops at the first failure):
#   1. gh signed in; REPO exists, or is created private and empty (also when REPO only redirects
#      to a renamed repo, which is left alone) (recommended: delete or rename the old
#      friend-test repo first, because GitHub keeps force-pushed-over commits reachable by SHA).
#      Visibility is NOT changed here (that is the owner's step:
#      gh repo edit REPO --visibility public --accept-visibility-change-consequences)
#   2. every release and tag whose tree has FRIEND-SETUP.md or whose name has "friend" is deleted
#   3. every remote branch other than main is deleted (also the old src/* source branches)
#   4. main is force-replaced by public/main
#   5. checks on GitHub: main has one commit, no FRIEND-SETUP.md, install.sh is ours
#   6. only with TAG=v<semver>: the tag is pushed (starts .github/workflows/release.yml), after
#      build/preflight-release.sh passed on this exact tree and no release run is going
#
# Env: REPO (default lib/product.json releaseRepo),
#      TAG (optional, --for-real only), GITLEAKS (default: gitleaks on PATH or
#      ~/scratch/rel-privacy/bin/gitleaks), ACCEPT_SCAN=1, PREFLIGHT_DIR, PUSH_URL (tests only).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
REAL=0
case "${1:-}" in
  --for-real) REAL=1; shift ;;
  --dry-run) shift ;;
esac
OUT=${1:-$HERE/.cache/publish-public}
REPO=${REPO:-$(node -p "require('./lib/product.json').releaseRepo")}
PREFLIGHT_DIR=${PREFLIGHT_DIR:-$HOME/.cache/dinobot-preflight/passed}
say() { printf '== %s\n' "$*"; }
die() { printf 'publish-public: %s\n' "$*" >&2; exit 1; }
would() { printf '   would: %s\n' "$*"; }

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes; commit first (the public tree is git archive HEAD)"

# 1. The public commit.
rm -rf "$OUT"; mkdir -p "$OUT/tree" "$OUT/scan"
git archive --format=tar HEAD -- . ':!demo' | tar -x -C "$OUT/tree"
(
  cd "$OUT/tree"
  git init -q -b main
  git add -A
  GIT_AUTHOR_NAME=omcdowell GIT_AUTHOR_EMAIL=omcdowell@users.noreply.github.com \
  GIT_COMMITTER_NAME=omcdowell GIT_COMMITTER_EMAIL=omcdowell@users.noreply.github.com \
  GIT_AUTHOR_DATE="2026-11-01T00:00:00+0000" GIT_COMMITTER_DATE="2026-11-01T00:00:00+0000" \
    git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q -m "$(node -p "require('$HERE/lib/product.json').name")"
)
MAIN=$(git -C "$OUT/tree" rev-parse HEAD)
TREE=$(git -C "$OUT/tree" rev-parse 'HEAD^{tree}')
git fetch -q --no-tags "$OUT/tree" "+main:refs/heads/public/main"
say "public/main = $MAIN (one root commit, tree $TREE, $(git -C "$OUT/tree" ls-files | wc -l | tr -d ' ') files)"

# 3. Checks.
FRIEND=$(git -C "$OUT/tree" log --all --format= --name-only | grep -i 'FRIEND-SETUP\.md' | sort -u || true)
[ -z "$FRIEND" ] || die "a commit to be pushed has $FRIEND"
say "no FRIEND-SETUP.md in any commit to be pushed"
DIRS=("$OUT/tree")
node build/public-check.mjs "${DIRS[@]}" >"$OUT/public-check.txt" 2>&1 || { cat "$OUT/public-check.txt" >&2; die "public-check found problems (above)"; }
say "$(tail -1 "$OUT/public-check.txt")"
for d in "${DIRS[@]}"; do
  DINOBOT_REQUIRE_GUARD=$REAL sh build/private-guard.sh "$d" >"$OUT/guard.txt" 2>&1 || { cat "$OUT/guard.txt" >&2; die "private-guard: $d"; }
done
say "private-guard: $( [ -s "$OUT/guard.txt" ] && tail -1 "$OUT/guard.txt" || echo "clean" )"
GITLEAKS=${GITLEAKS:-$(command -v gitleaks || echo "$HOME/scratch/rel-privacy/bin/gitleaks")}
if [ -x "$GITLEAKS" ]; then
  if "$GITLEAKS" git "$OUT/tree" --log-opts="--all" --no-banner --redact --report-path "$OUT/gitleaks.json" >/dev/null 2>&1; then
    say "gitleaks: clean ($(git -C "$OUT/tree" rev-list --all --count) commits)"
  else
    n=$(node -p "require('$OUT/gitleaks.json').length" 2>/dev/null || echo "?")
    say "gitleaks: $n finding(s) -> $OUT/gitleaks.json (rules + file:line, values redacted)"
    [ "${ACCEPT_SCAN:-0}" = 1 ] || { [ "$REAL" = 1 ] && die "read $OUT/gitleaks.json; re-run with ACCEPT_SCAN=1 if every finding is a fixture"; true; }
  fi
else
  [ "$REAL" = 1 ] && die "gitleaks not found (GITLEAKS=<path>)"
  say "WARNING: gitleaks not found; scan skipped"
fi

if [ "$REAL" = 0 ]; then
  say "dry run: nothing sent. A real run (--for-real) would, on $REPO:"
  would "delete every release and tag whose tree has FRIEND-SETUP.md or whose name has 'friend' (today: all v0.1.0-friend.*)"
  would "delete every branch other than main (incl. the old src/* source branches)"
  would "force-push public/main ($MAIN) to main"
  would "check main on GitHub: one commit, no FRIEND-SETUP.md, install.sh as here"
  if [ -n "${TAG:-}" ]; then would "push tag $TAG (starts the release workflow; needs build/preflight-release.sh on tree $TREE)"
  else would "push no tag (TAG unset)"; fi
  would "NOT change visibility (owner: gh repo edit $REPO --visibility public --accept-visibility-change-consequences)"
  exit 0
fi

# ---- Real run. ----
GH() { gh "$@"; }
GH auth status --hostname github.com >/dev/null 2>&1 || die "gh is not signed in (gh auth login)"
# A renamed repo still answers under its old name (GitHub redirects), so compare the name it
# resolves to: a redirect counts as missing, and the renamed repo is never touched.
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
RESOLVED=$(GH repo view "$REPO" --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
if [ -n "$RESOLVED" ] && [ "$(lc "$RESOLVED")" != "$(lc "$REPO")" ]; then
  say "$REPO redirects to $RESOLVED (renamed); that repo is left alone"
  RESOLVED=
fi
if [ -z "$RESOLVED" ]; then
  # The cleanest start: delete (or rename) the friend-test repo on github.com first (old commits
  # stay reachable by SHA after a force-push), then this creates it again, private and empty.
  GH repo create "$REPO" --private --disable-wiki --description "$(node -p "require('./lib/product.json').name")" >/dev/null
  say "created $REPO (private, empty)"
  [ "$(lc "$(GH repo view "$REPO" --json nameWithOwner --jq .nameWithOwner)")" = "$(lc "$REPO")" ] || die "$REPO still resolves elsewhere after creating it"
fi
VIS=$(GH repo view "$REPO" --json visibility --jq .visibility)
say "$REPO is $VIS"
if [ -n "${TAG:-}" ]; then
  f="$PREFLIGHT_DIR/$TREE"
  [ -f "$f" ] && grep -qx "tree $TREE" "$f" || die "build/preflight-release.sh has not passed on tree $TREE; nothing was changed"
  busy=$(GH api "repos/$REPO/actions/runs?per_page=100" --jq '[.workflow_runs[] | select(.path == ".github/workflows/release.yml" and .status != "completed")] | length')
  [ "$busy" = 0 ] || die "a release run is queued or running on $REPO; wait for it first"
fi

# 2. Friend-test releases and tags.
RELEASES=" $(GH release list --repo "$REPO" --limit 100 --json tagName --jq '.[].tagName' | tr '\n' ' ') "
for t in $(GH api "repos/$REPO/tags?per_page=100" --jq '.[].name'); do
  friend=0
  case "$t" in *friend*) friend=1 ;; esac
  [ $friend = 1 ] || ! GH api "repos/$REPO/contents/FRIEND-SETUP.md?ref=$t" --silent >/dev/null 2>&1 || friend=1
  [ $friend = 1 ] || { say "keeping tag $t (no friend files)"; continue; }
  case "$RELEASES" in
    *" $t "*) GH release delete "$t" --repo "$REPO" --cleanup-tag --yes; say "deleted release and tag $t" ;;
    *) GH api -X DELETE "repos/$REPO/git/refs/tags/$t" --silent; say "deleted tag $t" ;;
  esac
done
for t in $RELEASES; do # draft or tagless releases left over
  case "$t" in *friend*) GH release delete "$t" --repo "$REPO" --yes 2>/dev/null && say "deleted release $t" || true ;; esac
done

# 3. Branches other than main.
for b in $(GH api "repos/$REPO/branches?per_page=100" --jq '.[].name'); do
  [ "$b" = main ] && continue
  GH api -X DELETE "repos/$REPO/git/refs/heads/$b" --silent
  say "deleted branch $b"
done

# 4. Push.
git -C "$OUT/tree" remote add origin "${PUSH_URL:-https://github.com/$REPO.git}"
CRED=(-c credential.helper= -c 'credential.helper=!gh auth git-credential')
git -C "$OUT/tree" "${CRED[@]}" push -q --force origin main
say "pushed main ($MAIN)"

# 5. Check what GitHub now has.
[ "$(GH api "repos/$REPO/commits?sha=main&per_page=2" --jq length)" = 1 ] || die "main on $REPO has more than one commit"
! GH api "repos/$REPO/contents/FRIEND-SETUP.md?ref=main" --silent >/dev/null 2>&1 || die "FRIEND-SETUP.md is on main"
CHECK=$(mktemp -d)
GH api -H 'Accept: application/vnd.github.raw' "repos/$REPO/contents/install.sh?ref=main" >"$CHECK/install.sh"
cmp -s "$CHECK/install.sh" "$OUT/tree/install.sh" || die "install.sh on $REPO main differs from the one pushed"
rm -rf "$CHECK"
say "GitHub: main is one commit, no friend files, install.sh matches"

# 6. Optional release tag.
if [ -n "${TAG:-}" ]; then
  git -C "$OUT/tree" tag "$TAG" main
  git -C "$OUT/tree" "${CRED[@]}" push -q origin "refs/tags/$TAG"
  say "pushed tag $TAG: release.yml builds, signs and publishes. Watch it once: gh run watch --repo $REPO"
fi
say "done. Visibility unchanged ($VIS). To go public (owner): gh repo edit $REPO --visibility public --accept-visibility-change-consequences"
