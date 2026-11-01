#!/bin/bash
# Fresh-history source branches for omcdowell/dino-bot: one commit each, no old history, so the
# public repo carries only the reviewed source trees.
#
#   build/prepare-sources.sh OUT PASEO_DIR BOTS_DIR OPTCHAT_DIR [REF]
#
# Makes (or replaces) a local git repo OUT with three branches, ONE commit each, no old history:
#   src/paseo        the Paseo fork (daemon + app), tree of PASEO_DIR at REF (default public/release)
#   src/paseo-bots   the bots plugin
#   src/pi-optchat   OptChat (MIT; Jonas Silva's copyright stays in its LICENSE)
# Author/committer omcdowell <noreply>, 2026-11-01 +0000, neutral messages: the same tree always
# gives the same commit SHA. Prints the SHAs and writes them into build/sources.json (repo
# omcdowell/dino-bot for all three, so the release workflow reads them with its own token).
# build/publish-public.sh pushes these branches with SOURCES_GIT=OUT. Nothing here touches the network.
set -euo pipefail
OUT=${1:?out dir}; PASEO=${2:?paseo dir}; BOTS=${3:?paseo-bots dir}; OPTCHAT=${4:?pi-optchat dir}
REF=${5:-public/release}
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(node -p "require('$HERE/lib/product.json').releaseRepo")
NAME=$(node -p "require('$HERE/lib/product.json').name")
rm -rf "$OUT"; mkdir -p "$OUT"
git -C "$OUT" init -q -b main
export GIT_AUTHOR_NAME=omcdowell GIT_AUTHOR_EMAIL=omcdowell@users.noreply.github.com
export GIT_COMMITTER_NAME=omcdowell GIT_COMMITTER_EMAIL=omcdowell@users.noreply.github.com
export GIT_AUTHOR_DATE="2026-11-01T00:00:00+0000" GIT_COMMITTER_DATE="2026-11-01T00:00:00+0000"
one() { # branch src message
  local tree
  # The source repo's tree object as is (byte-identical files), copied into OUT's object store.
  git -C "$2" rev-parse --verify -q "$REF^{tree}" >/dev/null || { echo "no $REF in $2" >&2; exit 1; }
  [ -z "$(git -C "$2" status --porcelain --untracked-files=no)" ] || echo "note: $2 has uncommitted changes; using $REF only" >&2
  git -C "$OUT" fetch -q --no-tags --depth=1 "$2" "$REF:refs/tmp/$1"
  tree=$(git -C "$OUT" rev-parse "refs/tmp/$1^{tree}")
  c=$(git -C "$OUT" -c core.hooksPath=/dev/null commit-tree "$tree" -m "$3")
  git -C "$OUT" update-ref "refs/heads/$1" "$c"
  git -C "$OUT" update-ref -d "refs/tmp/$1"
  printf '%s %s (tree of %s %s)\n' "$1" "$c" "$2" "$(git -C "$2" rev-parse --short "$REF")" >&2
  echo "$c"
}
P=$(one src/paseo "$PASEO" "$NAME: Paseo fork (daemon and app)")
B=$(one src/paseo-bots "$BOTS" "$NAME: bots plugin")
O=$(one src/pi-optchat "$OPTCHAT" "$NAME: OptChat (MIT, based on jonaslsaa/pi-optchat)")
git -C "$OUT" gc -q --prune=now
rm -f "$OUT/.git/shallow" # the depth-1 fetches are gone; the branches are root commits
node -e '
  const fs = require("fs"); const [f, repo, p, b, o] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  s.paseo = { repo, commit: p }; s.bots = { repo, commit: b }; s.optchat = { repo, commit: o };
  s._note = "What the release workflow (.github/workflows/release.yml -> build/ci-build.sh) builds from: exact commits, exact versions, pinned checksums, so a release tag says exactly what is inside (rel-security H3). paseo/bots/optchat are the fresh-history branches src/paseo, src/paseo-bots and src/pi-optchat of " + repo + " (one commit each, made by build/prepare-sources.sh from the public/release trees; build/publish-public.sh SOURCES_GIT=<dir> pushes them). Because they live in the release repo itself, the workflow reads them with its own token: DINOBOT_SOURCES_TOKEN is not needed. Bump: re-run build/prepare-sources.sh, commit this file, push the branches, tag.";
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");' "$HERE/build/sources.json" "$REPO" "$P" "$B" "$O"
echo "sources.json: paseo $P, bots $B, optchat $O (all $REPO; push with build/publish-public.sh SOURCES_GIT=$OUT)"
