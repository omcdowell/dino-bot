#!/bin/sh
# private-guard.sh <dir>: exits 1 (and lists the files) if any text file anywhere under <dir> names a
# private part (a private provider plugin, a private proxy's env name, a private repo). README files,
# docs and third-party node_modules are checked too: nothing in the public tarball needs these names,
# because the code that handles a private provider plugin detects it generically
# (lib/provider-overrides.mjs: "an added plugin that registers pi's anthropic provider").
#
# The names themselves are not in this public repo. They come from (first found):
#   DINOBOT_PRIVATE_GUARD   newline-separated grep -E patterns, case-insensitive (CI: a repo secret)
#   DINOBOT_PRIVATE_GUARD_FILE, default ~/.config/dinobot/private-guard.txt (one pattern per line)
# No patterns: a warning and a pass, unless DINOBOT_REQUIRE_GUARD=1 (build/preflight-release.sh
# sets it, so a release is never pushed without the check having run on this computer).
set -eu
dir=${1:?usage: private-guard.sh <dir>}
pats=$(mktemp "${TMPDIR:-/tmp}/guard.XXXXXX")
trap 'rm -f "$pats"' EXIT
if [ -n "${DINOBOT_PRIVATE_GUARD:-}" ]; then
  printf '%s\n' "$DINOBOT_PRIVATE_GUARD" >"$pats"
else
  f=${DINOBOT_PRIVATE_GUARD_FILE:-$HOME/.config/dinobot/private-guard.txt}
  [ -f "$f" ] && cat "$f" >"$pats"
fi
# Comments and blank lines out.
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$pats" >"$pats.x" 2>/dev/null || true
mv "$pats.x" "$pats"
if [ ! -s "$pats" ]; then
  if [ "${DINOBOT_REQUIRE_GUARD:-0}" = 1 ]; then
    echo "private-guard: no patterns (DINOBOT_PRIVATE_GUARD or ~/.config/dinobot/private-guard.txt); refusing" >&2
    exit 1
  fi
  echo "private-guard: no patterns set; check skipped" >&2
  exit 0
fi
if grep -rIilE -f "$pats" "$dir"; then
  echo "private name found in the tarball (files above); refusing" >&2
  exit 1
fi
