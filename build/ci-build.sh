#!/usr/bin/env bash
# CI build of one release tarball from this repo's own folders (paseo/, plugins/bots/, optchat/,
# addons/paseo-apns/) at the checked-out commit, plus the external pins in build/sources.json (Node,
# pi, herdr), on a clean runner (release workflow; rel-security H3: no more "whatever is installed
# globally on the build machine").
#
#   build/ci-build.sh TARGET [SRC_DIR]
#     TARGET   linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64 (must be this runner's platform:
#              the daemon's native modules are built for the machine that runs npm)
#     SRC_DIR  the monorepo checkout (default: this repo). Its tracked files must be unchanged: the
#              tarball is built from the committed trees (HEAD:paseo, HEAD:plugins/bots, HEAD:optchat).
#
# The daemon step runs the server's prepack, which also exports the daemon web UI with Expo
# (memory-hungry: a 4 GB-capped local run with 2 Metro workers was killed; 1 worker and a 4 GB heap
# passed under a 6 GB cap). GitHub's runners for PRIVATE repos are small (Linux 2 CPU / 8 GB, macOS
# arm64 3 CPU / 7 GB), so the export runs with 1 worker and a 4 GB heap unless the caller sets
# PASEO_WEB_UI_MAX_WORKERS / NODE_OPTIONS. build/preflight-release.sh runs this under a 7 GB cap.
# Output: dist/dinobot-TARGET.tar.gz, .sha256 and dist/install.sh (build/build-tarball.sh).
# Runs locally too (any HOME), but only for this machine's own platform.
set -euo pipefail
TARGET=${1:?target}
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC=$(cd "${2:-$HERE}" && pwd)
WORK=${CI_WORK:-$HERE/.cache/ci}
J=$HERE/build/sources.json
q() { node -p "const s=require('$J'); $1"; }
# npm 12 runs no dependency install scripts unless they are approved (allowScripts); it skipped
# these and left the build incomplete (esbuild's binary check, node-pty's prebuild check/clean,
# msgpackr-extract's native loader check; pi's protobufjs/@google/genai ones are no-ops). Reviewed
# and approved by name: the paseo checkout carries its own allowScripts (root package.json, also
# unrs-resolver/lefthook for the dev tree); the daemon stage gets DAEMON_ALLOW in its package.json
# (npm 12 refuses --allow-scripts for project installs); pi (a global install) gets the flag.
# npm 11 runs every script anyway and ignores both.
DAEMON_ALLOW='{"esbuild":true,"node-pty":true,"msgpackr-extract":true}'
PI_ALLOW=--allow-scripts=protobufjs,@google/genai
# Stop if npm 12 still skipped one (a new native dependency must be reviewed and added above).
no_skipped() { if grep -i 'install scripts blocked\|not yet covered by allowScripts' "$1"; then echo "ci-build: npm skipped install scripts (see above); review them and add them to DAEMON_ALLOW/PI_ALLOW" >&2; exit 1; fi; }
say() { printf '== %s\n' "$*"; }
rm -rf "$WORK"; mkdir -p "$WORK"
# lefthook's npm postinstall runs `lefthook install -f` unless CI is set; inside this monorepo (or on a
# host with a global core.hooksPath) that overwrites someone else's git hooks. paseo/package.json
# blocks it for npm 12 (allowScripts lefthook: false); CI=true covers npm 11. GitHub sets CI anyway.
export CI=${CI:-true}

host_os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) host_arch=x64 ;; arm64|aarch64) host_arch=arm64 ;; *) host_arch=$(uname -m) ;; esac
[ "$TARGET" = "$host_os-$host_arch" ] || { echo "ci-build: $TARGET must be built on a $TARGET runner (this is $host_os-$host_arch)" >&2; exit 2; }
want_node=v$(q s.node)
[ "$(node -v)" = "$want_node" ] || { echo "ci-build: node $(node -v), sources.json wants $want_node" >&2; exit 2; }

# The sources are this commit's folders; nothing tracked may differ from it (the MANIFEST names trees).
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no -- paseo plugins/bots optchat addons/paseo-apns)" ] ||
  { echo "ci-build: $SRC has uncommitted changes in the source folders; commit first" >&2; exit 2; }
COMMIT=$(git -C "$SRC" rev-parse HEAD)
tree() { git -C "$SRC" rev-parse "HEAD:$1"; }
PASEO_TREE=$(tree paseo); BOTS_TREE=$(tree plugins/bots); OPTCHAT_TREE=$(tree optchat)

# 1. The daemon: our Paseo fork, built and packed, then installed into one self-contained folder
#    (the same layout as a global npm install: the package with its dependencies inside).
#    Local dry runs only: CI_PREBUILT_DAEMON=<dir> skips this and uses that built package (the
#    workflow never sets it; the MANIFEST then names the folder, not a commit).
if [ -n "${CI_PREBUILT_DAEMON:-}" ]; then
  [ -z "${GITHUB_ACTIONS:-}" ] || { echo "ci-build: CI_PREBUILT_DAEMON is for local dry runs, not CI" >&2; exit 2; }
  say "daemon: PREBUILT $CI_PREBUILT_DAEMON (local dry run)"
  DAEMON_DIR=$CI_PREBUILT_DAEMON
else
say "daemon: build paseo/ of $COMMIT (tree $PASEO_TREE)"
# The daemon's web UI (exported by the server's prepack) is the DinoBot app, not upstream's.
export PASEO_FLAVOUR=public
export PASEO_WEB_UI_MAX_WORKERS=${PASEO_WEB_UI_MAX_WORKERS:-1} NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=4096}
( cd "$SRC/paseo" && npm ci --no-audit --no-fund && npm run build:server )
mkdir -p "$WORK/packs" "$WORK/daemon-stage"
for ws in highlight relay protocol client plugin server cli; do
  ( cd "$SRC/paseo" && npm pack --silent --workspace="@getpaseo/$ws" --pack-destination "$WORK/packs" >/dev/null )
done
# All @getpaseo packages as direct file dependencies, so npm uses OUR builds for every one of them
# (their exact-version ranges are satisfied by these; nothing @getpaseo comes from the registry).
( cd "$WORK/daemon-stage" && npm init -y >/dev/null && npm pkg set --json "allowScripts=$DAEMON_ALLOW" \
  && npm install --omit=dev --no-audit --no-fund "$WORK"/packs/*.tgz ) 2>&1 | tee "$WORK/daemon-install.log"
no_skipped "$WORK/daemon-install.log"
node -e '
  const fs=require("fs"),p=require("path"),d=process.argv[1];
  for (const n of fs.readdirSync(p.join(d,"node_modules/@getpaseo"))) {
    const pk=require(p.join(d,"node_modules/@getpaseo",n,"package.json"));
    if (!fs.lstatSync(p.join(d,"node_modules/@getpaseo",n)).isDirectory()) throw new Error(n+" is not a folder");
    console.log("   @getpaseo/"+n+" "+pk.version);
  }' "$WORK/daemon-stage"
DAEMON_DIR=$WORK/daemon/@getpaseo/cli
mkdir -p "$(dirname "$DAEMON_DIR")"
mv "$WORK/daemon-stage/node_modules/@getpaseo/cli" "$DAEMON_DIR"
mv "$WORK/daemon-stage/node_modules" "$DAEMON_DIR/node_modules"
printf 'commit %s paseo/ tree %s (CI)\n' "$COMMIT" "$PASEO_TREE" >"$DAEMON_DIR/COMBINED_DEPLOY.txt"
fi

# 2. pi, pinned, from npm.
PI_VER=$(q s.pi)
say "pi $PI_VER"
npm install -g --prefix "$WORK/pi" --no-audit --no-fund "$PI_ALLOW" "@earendil-works/pi-coding-agent@$PI_VER" >"$WORK/pi-install.log" 2>&1 || { cat "$WORK/pi-install.log" >&2; exit 1; }
no_skipped "$WORK/pi-install.log"
PI_DIR=$WORK/pi/lib/node_modules/@earendil-works/pi-coding-agent

# 3. herdr, the release binary, checked against the pinned sha256.
H_NAME=$(q "s.herdr.assets['$TARGET'].name"); H_SHA=$(q "s.herdr.assets['$TARGET'].sha256")
say "herdr $(q s.herdr.version) $H_NAME"
curl -fsSL --proto '=https' --retry 3 --retry-all-errors --connect-timeout 20 --speed-limit 10000 --speed-time 60 "https://github.com/$(q s.herdr.repo)/releases/download/$(q s.herdr.version)/$H_NAME" -o "$WORK/herdr"
got=$( (sha256sum "$WORK/herdr" 2>/dev/null || shasum -a 256 "$WORK/herdr") | cut -d' ' -f1)
[ "$got" = "$H_SHA" ] || { echo "ci-build: herdr checksum $got != pinned $H_SHA" >&2; exit 1; }
chmod 755 "$WORK/herdr"

# 4. The bots plugin's one runtime dependency (zod), from its own lockfile.
( cd "$SRC/plugins/bots" && npm ci --no-audit --no-fund --ignore-scripts >/dev/null )

# 5. The tarball.
say "tarball $TARGET"
NODE_BIN=$(command -v node) DAEMON_DIR=$DAEMON_DIR PI_DIR=$PI_DIR PI_VERSION="" HERDR_BIN=$WORK/herdr \
  PASEO_REPO=$SRC PASEO_REF=$PASEO_TREE \
  OPTCHAT_REPO=$SRC OPTCHAT_REFS=$OPTCHAT_TREE \
  BOTS_REPO=$SRC BOTS_REF=$BOTS_TREE BOTS_ZOD_DIR=$SRC/plugins/bots/node_modules/zod \
  BUILD_CACHE=$WORK/cache \
  "$HERE/build/build-tarball.sh" --out "$HERE/dist"
ls -la "$HERE/dist"
