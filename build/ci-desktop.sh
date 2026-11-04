#!/usr/bin/env bash
# CI build of the basic DinoBot desktop app from the pinned paseo source (build/sources.json), on a
# clean runner (release workflow, job `desktop`). Same recipe as the hand builds of 27 Oct-4 Nov.
#
#   build/ci-desktop.sh TARGET SRC_DIR
#     TARGET   linux-x64 (AppImage) | darwin-arm64 (dmg); must be this runner's platform
#     SRC_DIR  where the workflow checked out paseo/ at the pinned commit
#
# Output in dist/: DinoBot-<version>-<arch>.AppImage or .dmg, plus .sha256. <version> is
# packages/desktop/package.json's, so nothing here names a version.
# The app is the public flavour (DinoBot name, com.dinobot.desktop, dinobot:// links, no built-in
# daemon, no update feed): it connects to a DinoBot host made by install.sh.
# macOS: NOT signed with a Developer ID and not notarised (none exists yet); electron-builder signs
# it ad hoc, so the user opens it once with right-click > Open.
# Memory: the web UI export runs with 1 Metro worker and a 4 GB heap, as in build/ci-build.sh.
set -euo pipefail
TARGET=${1:?target}
SRC=$(cd "${2:?source dir}" && pwd)
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${DESKTOP_OUT:-$HERE/dist}
J=$HERE/build/sources.json
q() { node -p "const s=require('$J'); $1"; }
NAME=$(node -p "require('$HERE/lib/product.json').name") # the app's file names start with it
say() { printf '== %s\n' "$*"; }

host_os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) host_arch=x64 ;; arm64|aarch64) host_arch=arm64 ;; *) host_arch=$(uname -m) ;; esac
[ "$TARGET" = "$host_os-$host_arch" ] || { echo "ci-desktop: $TARGET must be built on a $TARGET runner (this is $host_os-$host_arch)" >&2; exit 2; }
case "$TARGET" in
  linux-x64) EB_ARGS="--linux AppImage --x64"; EXT=AppImage ;;
  darwin-arm64) EB_ARGS="--mac dmg --arm64"; EXT=dmg ;;
  *) echo "ci-desktop: no desktop app for $TARGET" >&2; exit 2 ;;
esac
want_node=v$(q s.node)
[ "$(node -v)" = "$want_node" ] || { echo "ci-desktop: node $(node -v), sources.json wants $want_node" >&2; exit 2; }
P=$SRC/paseo
got=$(git -C "$P" rev-parse HEAD); want=$(q s.paseo.commit)
[ "$got" = "$want" ] || { echo "ci-desktop: $P is at $got, sources.json pins $want" >&2; exit 2; }

export PASEO_FLAVOUR=public LEFTHOOK=0 EXPO_NO_TELEMETRY=1 CSC_IDENTITY_AUTO_DISCOVERY=false
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=4096}
cd "$P"
say "npm ci"
npm ci --no-audit --no-fund
# Electron's binary (and the licence files electron-builder.dinobot.cjs insists on); npm 12 skips
# install scripts it was not told to allow, so fetch it explicitly. Idempotent.
node node_modules/electron/install.js
say "app deps + server (the desktop bundle packs the server's built-in plugins)"
npm run build:app-deps
npm run build:server
say "web UI for Electron (public flavour; --clear: a cached export can be the own flavour)"
( cd packages/app && rm -rf dist && PASEO_WEB_PLATFORM=electron npx expo export --platform web --clear --max-workers "${PASEO_WEB_UI_MAX_WORKERS:-1}" )
grep -rqo '\\"flavour\\":\\"public\\"' packages/app/dist/_expo || { echo "ci-desktop: the web export is not the public flavour" >&2; exit 1; }
say "main process"
( cd packages/desktop && npm run build:main )
# Same checks as the tarball: no private names, no secret-shaped strings in what gets packed.
for d in packages/app/dist packages/desktop/dist; do
  sh "$HERE/build/private-guard.sh" "$d"
  if grep -rIlE 'sk-ant-(oat|api)[0-9]{2}-[A-Za-z0-9_-]{20}|sk-or-v1-[0-9a-f]{20}|ghp_[A-Za-z0-9]{30}|github_pat_[A-Za-z0-9_]{30}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$d"; then
    echo "ci-desktop: secret-shaped string in $d (above)" >&2; exit 1
  fi
done
say "electron-builder $EB_ARGS"
rm -rf packages/desktop/release
# macOS: sign ad hoc (identity "-") with the hardened runtime off. Without it the bundle carries
# only the linker's signature, fails `codesign --verify`, and a downloaded copy is reported as
# "damaged" instead of offering right-click > Open. paseo 293aefa46 puts the same in
# electron-builder.dinobot.cjs; this wrapper makes it true for older pinned sources too.
cat >packages/desktop/electron-builder.ci.cjs <<'JS'
const c = require("./electron-builder.dinobot.cjs");
module.exports = { ...c, mac: { ...c.mac, identity: "-", hardenedRuntime: false } };
JS
# shellcheck disable=SC2086
( cd packages/desktop && npx electron-builder --config electron-builder.ci.cjs $EB_ARGS --publish never )
if [ "$EXT" = dmg ]; then
  codesign --verify --deep --strict packages/desktop/release/mac-*/"$NAME".app
fi
mkdir -p "$OUT"
set -- packages/desktop/release/"$NAME"-*."$EXT"
[ "$#" = 1 ] && [ -f "$1" ] || { echo "ci-desktop: expected one $NAME-*.$EXT, got: $*" >&2; exit 1; }
f=$(basename "$1")
cp "$1" "$OUT/$f"
( cd "$OUT" && { sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"; } >"$f.sha256" && cat "$f.sha256" )
ls -la "$OUT"
