#!/usr/bin/env bash
# Build the one prebuilt tarball the installer downloads (rel-bench §3.2: Node, daemon, pi, OptChat,
# the bots plugin and herdr inside; no `npm install` on the user's machine).
#
#   build/build-tarball.sh [--out DIR] [--full] [--target OS-ARCH]
#
# Output: DIR/dinobot-OS-ARCH.tar.gz and .tar.zst (same tree; .sha256 beside each), DIR/install.sh.
# node_modules are pruned (build/prune-stage.mjs; PRUNE=0 keeps all); the Node binary is nodejs.org's,
# untouched (STRIP_NODE=1 strips a native Linux one); ZSTD=0 skips the .tar.zst.
#
# --target (e.g. darwin-arm64) cross-assembles on this host: the official Node for the target from
# nodejs.org (NODE_VERSION, default this host's), and every platform package in the daemon and pi
# (`*-<host os>-<host arch>`, e.g. sherpa-onnx, msgpackr-extract, esbuild) swapped for the target's
# build of the same version from the npm registry. HERDR_BIN must then be a target binary (or
# empty: no herdr). node-pty and pi-tui already ship prebuilds for every platform.
#
# Sources (env overrides; defaults are this dev host's builds, never paths baked into the output):
#   NODE_BIN       node binary (>= 22.19)                    default: command -v node
#   DAEMON_DIR     built @getpaseo/cli package (our fork)    default: $(npm root -g)/@getpaseo/cli
#   PI_VERSION     pi from npm, pinned (installed into .cache) default: 1.4.0 (empty: use PI_DIR)
#   PI_DIR         @earendil-works/pi-coding-agent package   default: the PI_VERSION install, else $(npm root -g)/…
#   OPTCHAT_REPO   git repo holding OptChat                  default: this repo (optchat/)
#   OPTCHAT_REFS   one tree-ish, or several merged in memory default: the tree HEAD:optchat
#                  (git merge-tree; no branch is changed)
#   BOTS_REPO      git repo holding the bots plugin          default: this repo (plugins/bots/)
#   BOTS_REF       tree-ish                                  default: the tree HEAD:plugins/bots
#   BOTS_ZOD_DIR   zod package for the bots CLIs             default: plugins/bots/node_modules/zod
#   PASEO_REPO/PASEO_REF  the Paseo fork (LICENSE, NOTICE)    default: this repo, tree HEAD:paseo
#   HERDR_BIN      herdr binary (optional)                   default: command -v herdr
#
# --full keeps the bundled Claude Code binary (@anthropic-ai/claude-agent-sdk-<os>-<arch>, ~240 MB).
# The default drops it: bots run on pi/OptChat; the Claude Code provider then uses a system `claude`.
# Never includes a private part (build/private-guard.sh checks the whole tarball).
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HERE/dist"
FULL=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --full) FULL=1; shift ;;
    --target) TARGET=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

GLOBAL=$(npm root -g 2>/dev/null || echo "")
NODE_BIN=${NODE_BIN:-$(command -v node)}
NODE_BIN=$(readlink -f "$NODE_BIN")
DAEMON_DIR=${DAEMON_DIR:-$GLOBAL/@getpaseo/cli}
PI_VERSION=${PI_VERSION-1.4.0}
OPTCHAT_REPO=${OPTCHAT_REPO:-$HERE}
OPTCHAT_REFS=${OPTCHAT_REFS:-$(git -C "$HERE" rev-parse HEAD:optchat)}
BOTS_REPO=${BOTS_REPO:-$HERE}
BOTS_REF=${BOTS_REF:-$(git -C "$HERE" rev-parse HEAD:plugins/bots)}
BOTS_ZOD_DIR=${BOTS_ZOD_DIR:-$HERE/plugins/bots/node_modules/zod}
HERDR_BIN=${HERDR_BIN:-$(command -v herdr || true)}

HOST_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in x86_64|amd64) HOST_ARCH=x64 ;; arm64|aarch64) HOST_ARCH=arm64 ;; *) HOST_ARCH=$(uname -m) ;; esac
TARGET=${TARGET:-$HOST_OS-$HOST_ARCH}
OS=${TARGET%-*}
ARCH=${TARGET#*-}
CROSS=0
[ "$TARGET" = "$HOST_OS-$HOST_ARCH" ] || CROSS=1
CACHE=${BUILD_CACHE:-$HERE/.cache}
# pi: a pinned npm version (demo issue 10: 1.1.0 was bundled and workers showed "Update available"),
# installed global-style into the cache so its dependencies sit inside the package, as in a
# global install. Same version for every target (pi is JS; platform packages are swapped below).
if [ -z "${PI_DIR:-}" ] && [ -n "$PI_VERSION" ]; then
  PI_PREFIX="$CACHE/pi-$PI_VERSION"
  if [ ! -f "$PI_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/package.json" ]; then
    mkdir -p "$PI_PREFIX"
    # npm 12 skips unapproved install scripts; pi's two are no-ops but approved so nothing is skipped
    # (same list as build/ci-build.sh).
    npm install -g --prefix "$PI_PREFIX" --no-audit --no-fund --allow-scripts=protobufjs,@google/genai "@earendil-works/pi-coding-agent@$PI_VERSION" >/dev/null
  fi
  PI_DIR="$PI_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent"
fi
PI_DIR=${PI_DIR:-$GLOBAL/@earendil-works/pi-coding-agent}
# Product names: lib/product.json is the one place.
PRODUCT_ID=$(node -p "require('$HERE/lib/product.json').id")
PRODUCT_NAME=$(node -p "require('$HERE/lib/product.json').name")
PRODUCT_VERSION=$(node -p "require('$HERE/lib/product.json').version")
DOWNLOAD_BASE_URL=$(node -p "require('$HERE/lib/product.json').downloadBaseUrl")
NAME="$PRODUCT_ID-$OS-$ARCH"
mkdir -p "$OUT"
STAGE="$OUT/$NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/node/bin"

say() { printf '  %s\n' "$*"; }
# Downloads never hang a build: a stalled transfer (under 10 kB/s for 60 s) is retried, then fails.
# (28 Oct: a nodejs.org download stalled on GitHub's macOS runner until the 30-minute job timeout.)
CURL="curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 --speed-limit 10000 --speed-time 60"
# The official Node distribution for the target (sha256 checked against nodejs.org's SHASUMS256).
NODE_VERSION=${NODE_VERSION:-$("$NODE_BIN" -v)}
NODE_PKG="node-$NODE_VERSION-$OS-$ARCH"
node_dist() {
  mkdir -p "$CACHE"
  if [ ! -f "$CACHE/$NODE_PKG.tar.gz" ]; then
    $CURL "https://nodejs.org/dist/$NODE_VERSION/$NODE_PKG.tar.gz" -o "$CACHE/$NODE_PKG.tar.gz.part"
    $CURL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $NODE_PKG.tar.gz\$" | sed "s|$NODE_PKG.tar.gz|$CACHE/$NODE_PKG.tar.gz.part|" | sha256sum -c - >/dev/null
    mv "$CACHE/$NODE_PKG.tar.gz.part" "$CACHE/$NODE_PKG.tar.gz"
  fi
}
if [ "$CROSS" = 1 ]; then
  node_dist
  tar -xzf "$CACHE/$NODE_PKG.tar.gz" -C "$STAGE/node/bin" --strip-components=2 "$NODE_PKG/bin/node"
  tar -xzf "$CACHE/$NODE_PKG.tar.gz" -C "$STAGE/node" --strip-components=1 "$NODE_PKG/LICENSE"
  say "node     $NODE_PKG (nodejs.org, sha256 checked)"
else
  say "node     $NODE_BIN ($("$NODE_BIN" -v))"
  cp "$NODE_BIN" "$STAGE/node/bin/node"
  NODE_LICENSE=${NODE_LICENSE:-$(dirname "$(dirname "$NODE_BIN")")/LICENSE}
  [ -f "$NODE_LICENSE" ] || { echo "no Node LICENSE next to $NODE_BIN (set NODE_LICENSE)" >&2; exit 1; }
  cp "$NODE_LICENSE" "$STAGE/node/LICENSE"
fi
# npm, from the same Node release (pure JS): pi runs `npm install` when it adds a provider plugin
# from git or npm (when it has a package.json), and a fresh Mac has no npm ("spawn npm ENOENT").
# lib/config.mjs points DinoBot's pi at it (settings.json npmCommand). BUNDLE_NPM=0 leaves it out.
# On a GitHub runner the native node is actions/setup-node's copy of the nodejs.org release, npm
# included, so npm is taken from there (no second download of the same release).
TOOLCACHE_NPM=$(dirname "$(dirname "$NODE_BIN")")/lib/node_modules/npm
if [ "${BUNDLE_NPM:-1}" = 1 ] && [ "$CROSS" != 1 ] && [ -n "${GITHUB_ACTIONS:-}" ] && [ -f "$TOOLCACHE_NPM/package.json" ]; then
  mkdir -p "$STAGE/node/lib/node_modules"
  cp -a "$TOOLCACHE_NPM" "$STAGE/node/lib/node_modules/npm"
  say "npm      $(node -p "require('$STAGE/node/lib/node_modules/npm/package.json').version") (from $NODE_BIN's release)"
elif [ "${BUNDLE_NPM:-1}" = 1 ]; then
  node_dist
  mkdir -p "$STAGE/node/lib/node_modules"
  tar -xzf "$CACHE/$NODE_PKG.tar.gz" -C "$STAGE/node/lib/node_modules" --strip-components=3 "$NODE_PKG/lib/node_modules/npm"
  say "npm      $(node -p "require('$STAGE/node/lib/node_modules/npm/package.json').version") (from $NODE_PKG)"
fi

say "daemon   $DAEMON_DIR"
# Hard links where possible: staging is a copy of an installed tree, never edited in place.
cp -al "$DAEMON_DIR" "$STAGE/daemon" 2>/dev/null || cp -a "$DAEMON_DIR" "$STAGE/daemon"
rm -f "$STAGE"/daemon/*_DEPLOY.txt
if [ "$FULL" = 0 ]; then
  # Owner decision, 27 Oct: the Claude Agent SDK is proprietary, so it is not redistributed (JS or binary).
  # A placeholder answers the daemon's import; `dinobot claude-code install` fetches the real one
  # from npm on the user's computer. (rm on the hard-linked stage only drops the links.)
  SDK_VERSION=$(node -p "require('$STAGE/daemon/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "")
  rm -rf "$STAGE"/daemon/node_modules/@anthropic-ai/claude-agent-sdk "$STAGE"/daemon/node_modules/@anthropic-ai/claude-agent-sdk-*
  mkdir -p "$STAGE/daemon/node_modules/@anthropic-ai/claude-agent-sdk"
  for f in sdk.mjs package.json; do
    sed -e "s/__SDK_VERSION__/$SDK_VERSION/" -e "s/__PRODUCT__/$PRODUCT_NAME/g" -e "s/__PRODUCT_ID__/$PRODUCT_ID/g" \
      "$HERE/build/claude-agent-sdk-stub/$f" >"$STAGE/daemon/node_modules/@anthropic-ai/claude-agent-sdk/$f"
  done
  say "         claude-agent-sdk $SDK_VERSION replaced by a placeholder (not redistributed)"
fi
# Paseo's licence and our NOTICE (the daemon is a modified Paseo, Apache-2.0 section 4).
PASEO_REPO=${PASEO_REPO:-$HERE}
PASEO_REF=${PASEO_REF:-$(git -C "$HERE" rev-parse HEAD:paseo)}
rm -f "$STAGE/daemon/LICENSE" "$STAGE/daemon/NOTICE"
git -C "$PASEO_REPO" show "$PASEO_REF:LICENSE" >"$STAGE/daemon/LICENSE"
git -C "$PASEO_REPO" show "$PASEO_REF:NOTICE" >"$STAGE/daemon/NOTICE" 2>/dev/null || echo "Modified version of Paseo (https://github.com/getpaseo/paseo), Apache-2.0." >"$STAGE/daemon/NOTICE"

say "pi       $PI_DIR"
cp -al "$PI_DIR" "$STAGE/pi" 2>/dev/null || cp -a "$PI_DIR" "$STAGE/pi"
rm -f "$STAGE/pi/LICENSE"
cp "$HERE/build/licences/pi-LICENSE" "$STAGE/pi/LICENSE" # the npm package ships none
# pi's DOOM example carries a compiled doomgeneric (GPL-2.0) and fetches a game WAD: not needed to
# run pi, and not something to redistribute without a GPL source offer. (Stage only; hard links.)
rm -rf "$STAGE/pi/examples/extensions/doom-overlay"

# Cross builds: swap platform packages (<name>-<host os>-<host arch>) for the target's.
swap_platform_packages() { # dir
  [ "$CROSS" = 1 ] || return 0
  find "$1" -type d -path '*/node_modules/*' -name "*$HOST_OS-$HOST_ARCH" -prune | while read -r d; do
    [ -f "$d/package.json" ] || continue
    pkg=$(node -p "require('$d/package.json').name")
    ver=$(node -p "require('$d/package.json').version")
    tpkg=$(printf '%s' "$pkg" | sed "s/$HOST_OS-$HOST_ARCH\$/$OS-$ARCH/")
    tdir=$(dirname "$d")/$(basename "$tpkg")
    rm -rf "$d"
    mkdir -p "$CACHE/npm" "$tdir"
    tgz=$(cd "$CACHE/npm" && ls "$(printf '%s' "$tpkg" | sed 's|^@||; s|/|-|')-$ver.tgz" 2>/dev/null || (cd "$CACHE/npm" && npm pack --silent "$tpkg@$ver" 2>/dev/null | tail -1))
    if [ -z "$tgz" ] || [ ! -f "$CACHE/npm/$tgz" ]; then
      echo "  ! no $tpkg@$ver on npm (skipped; optional at runtime?)" >&2; rmdir "$tdir" 2>/dev/null || true; continue
    fi
    tar -xzf "$CACHE/npm/$tgz" -C "$tdir" --strip-components=1
    say "  swapped $pkg@$ver -> $tpkg"
  done
}
swap_platform_packages "$STAGE/daemon"
swap_platform_packages "$STAGE/pi"
# esbuild's postinstall (approved since npm 12) swaps bin/esbuild for the HOST's native binary; in a
# cross build that would be e.g. a Linux ELF on a Mac. Put the package's own JS launcher back (it
# runs the swapped @esbuild/<target> binary; the JS API never used bin/esbuild). rm first: the
# stage is hard links into DAEMON_DIR.
restore_esbuild_launcher() { # dir
  [ "$CROSS" = 1 ] || return 0
  find "$1" -type d -path '*/node_modules/esbuild' -prune | while read -r d; do
    [ -f "$d/bin/esbuild" ] && [ "$(head -c 2 "$d/bin/esbuild")" != '#!' ] || continue
    ver=$(node -p "require('$d/package.json').version")
    mkdir -p "$CACHE/npm"
    tgz=$(cd "$CACHE/npm" && ls "esbuild-$ver.tgz" 2>/dev/null || (cd "$CACHE/npm" && npm pack --silent "esbuild@$ver" | tail -1))
    rm -f "$d/bin/esbuild"
    tar -xzf "$CACHE/npm/$tgz" -C "$d" --strip-components=1 package/bin/esbuild
    [ "$(head -c 2 "$d/bin/esbuild")" = '#!' ] || { echo "esbuild $ver: could not restore bin/esbuild" >&2; exit 1; }
    say "  esbuild $ver: bin/esbuild is the JS launcher again (was the host binary)"
  done
}
restore_esbuild_launcher "$STAGE/daemon"
restore_esbuild_launcher "$STAGE/pi"

# Windows binaries never run from a Mac/Linux tarball (fr-licence: less size and licence surface):
# node-pty's ConPTY (conpty.dll, OpenConsole.exe) and win32 prebuilds, pi-tui's win32 prebuilds.
# Stage only (hard links: rm drops the links). PRUNE_WINDOWS=0 keeps them.
if [ "${PRUNE_WINDOWS:-1}" = 1 ] && [ "$OS" != win32 ]; then
  before=$(du -sk "$STAGE" | cut -f1)
  find "$STAGE/daemon" "$STAGE/pi" -depth -type d \( -path '*/node-pty/third_party/conpty' -o -path '*/prebuilds/win32-*' \) -exec rm -rf {} +
  left=$(find "$STAGE/daemon" "$STAGE/pi" -type f \( -iname '*.exe' -o -iname '*.dll' -o -path '*/prebuilds/win32-*' \) | head -5)
  [ -z "$left" ] || { echo "Windows binaries left in the stage: $left" >&2; exit 1; }
  say "pruned   Windows binaries ($(( (before - $(du -sk "$STAGE" | cut -f1)) / 1024 )) MB)"
fi

archive_tree() { # repo tree-ish dest
  mkdir -p "$3"
  # -m: the build's time, not the commit's (fixed source commits are dated 2026-11-01; future times make
  # every tar that unpacks the release warn once per file).
  git -C "$1" archive --format=tar "$2" | tar -xm -C "$3"
}

set -- $OPTCHAT_REFS
if [ $# -gt 1 ]; then
  TREE=$(git -C "$OPTCHAT_REPO" merge-tree --write-tree "$@") || {
    echo "pi-optchat refs $* do not merge cleanly; set OPTCHAT_REFS to one ref" >&2
    exit 1
  }
  say "optchat  $OPTCHAT_REPO $* (merged tree $TREE)"
  OPTCHAT_ID="$* -> tree $TREE"
else
  TREE=$1
  say "optchat  $OPTCHAT_REPO $TREE"
  OPTCHAT_ID="$TREE $(git -C "$OPTCHAT_REPO" rev-parse --short "$TREE")"
fi
archive_tree "$OPTCHAT_REPO" "$TREE" "$STAGE/optchat"
rm -rf "$STAGE/optchat/test" "$STAGE/optchat/docs"

say "bots     $BOTS_REPO $BOTS_REF"
archive_tree "$BOTS_REPO" "$BOTS_REF" "$STAGE/bots"
rm -rf "$STAGE/bots/test"
mkdir -p "$STAGE/bots/node_modules"
cp -a "$BOTS_ZOD_DIR" "$STAGE/bots/node_modules/zod"

# The push add-on (paseo-apns, plugin id "apns"): its files only, from addons/paseo-apns in this
# repo (no history, no tests). Shipped OFF: the installer never registers it, so a stock install
# does not load it. `dinobot push enable` turns it on for people who build the iPhone app with
# their own Apple developer account (lib/push.mjs, docs/live-activities.md). zod and the plugin
# SDK come from the daemon at run time. APNS=0 leaves it out.
if [ "${APNS:-1}" = 1 ]; then
  say "apns     $HERE/addons/paseo-apns (off by default)"
  mkdir -p "$STAGE/apns"
  for f in $(node -p "require('$HERE/addons/paseo-apns/package.json').files.join(' ')") package.json; do
    cp -a "$HERE/addons/paseo-apns/${f%/}" "$STAGE/apns/"
  done
fi

if [ "$CROSS" = 1 ] && [ -n "$HERDR_BIN" ] && ! file "$HERDR_BIN" | grep -qi "$( [ "$OS" = darwin ] && echo Mach-O || echo ELF )"; then
  echo "HERDR_BIN $HERDR_BIN is not a $OS binary; set HERDR_BIN to the target's herdr or to empty" >&2; exit 1
fi
if [ -n "$HERDR_BIN" ] && [ -f "$HERDR_BIN" ]; then
  say "herdr    $HERDR_BIN ($([ "$CROSS" = 1 ] && echo "$OS binary" || "$HERDR_BIN" --version 2>/dev/null))"
  mkdir -p "$STAGE/herdr"
  cp "$(readlink -f "$HERDR_BIN")" "$STAGE/herdr/herdr"
  cp "$HERE/build/licences/APACHE-2.0.txt" "$STAGE/herdr/LICENSE"
  cp "$HERE/build/licences/herdr-NOTICE" "$STAGE/herdr/NOTICE"
else
  say "herdr    (none; workers stay off until herdr is installed)"
fi

# rg and fd for pi (its grep/find tools and the TUI need them). Without them every pi downloads
# them from GitHub on first start, and an interactive pi (a herdr worker) ignores input until that
# finishes: on a fresh Mac, busy with the voice-model download, a worker's first prompt was left
# unsent ("Startup is still in progress"). Pinned; lib/config.mjs links them into ~/.dinobot/pi/bin
# (pi's own tools dir). PI_TOOLS=0 leaves them out.
RG_VERSION=${RG_VERSION:-15.2.0}
FD_VERSION=${FD_VERSION:-10.5.0}
if [ "${PI_TOOLS:-1}" = 1 ]; then
  case "$OS-$ARCH" in
    darwin-arm64) TRIPLE=aarch64-apple-darwin ;; darwin-x64) TRIPLE=x86_64-apple-darwin ;;
    linux-x64) TRIPLE=x86_64-unknown-linux-musl ;; linux-arm64) TRIPLE=aarch64-unknown-linux-musl ;;
    *) echo "no rg/fd for $OS-$ARCH" >&2; exit 1 ;;
  esac
  mkdir -p "$CACHE/tools" "$STAGE/tools"
  for spec in "rg BurntSushi/ripgrep $RG_VERSION ripgrep-$RG_VERSION-$TRIPLE" "fd sharkdp/fd v$FD_VERSION fd-v$FD_VERSION-$TRIPLE"; do
    set -- $spec; bin=$1; repo=$2; tag=$3; pkg=$4
    if [ ! -f "$CACHE/tools/$pkg.tar.gz" ]; then
      $CURL "https://github.com/$repo/releases/download/$tag/$pkg.tar.gz" -o "$CACHE/tools/$pkg.tar.gz.part"
      # ripgrep publishes a .sha256 per asset; fd does not (HTTPS from GitHub only).
      if $CURL "https://github.com/$repo/releases/download/$tag/$pkg.tar.gz.sha256" -o "$CACHE/tools/$pkg.sha256" 2>/dev/null; then
        [ "$(cut -d' ' -f1 "$CACHE/tools/$pkg.sha256")" = "$(sha256sum "$CACHE/tools/$pkg.tar.gz.part" | cut -d' ' -f1)" ] || { echo "$pkg: checksum mismatch" >&2; exit 1; }
      fi
      mv "$CACHE/tools/$pkg.tar.gz.part" "$CACHE/tools/$pkg.tar.gz"
    fi
    rm -rf "$CACHE/tools/$pkg"; tar -xzf "$CACHE/tools/$pkg.tar.gz" -C "$CACHE/tools"
    mkdir -p "$STAGE/tools/$bin"
    cp "$CACHE/tools/$pkg/$bin" "$STAGE/tools/$bin/$bin"
    for l in "$CACHE/tools/$pkg"/LICENSE* "$CACHE/tools/$pkg"/UNLICENSE "$CACHE/tools/$pkg"/COPYING; do [ -f "$l" ] && cp "$l" "$STAGE/tools/$bin/"; done
    say "tool     $bin $tag ($pkg$([ -f "$CACHE/tools/$pkg.sha256" ] && echo ", sha256 checked"))"
  done
fi

# pi packages every DinoBot pi gets (lib/config.mjs DEFAULT_PI_PACKAGES), pinned, pure JS (any target).
# pi-web-access: every pi (settings.json). rpiv-ask-user-question: bots only (-e, config.mjs BOT_ONLY_PI_PACKAGES).
PI_PACKAGES=${PI_PACKAGES:-"pi-web-access@0.45.0 @juicesharp/rpiv-ask-user-question@2.15.0"}
if [ -n "$PI_PACKAGES" ]; then
  key=$(printf '%s' "$PI_PACKAGES" | sha256sum | cut -c1-12)
  if [ ! -d "$CACHE/pi-packages-$key/node_modules" ]; then
    mkdir -p "$CACHE/pi-packages-$key"
    # shellcheck disable=SC2086
    (cd "$CACHE/pi-packages-$key" && npm install --omit=dev --omit=peer --no-audit --no-fund --ignore-scripts --prefix . $PI_PACKAGES >/dev/null)
  fi
  if find "$CACHE/pi-packages-$key/node_modules" -name '*.node' | grep -q .; then echo "pi packages contain native code; not cross-safe" >&2; exit 1; fi
  mkdir -p "$STAGE/pi-packages"
  cp -a "$CACHE/pi-packages-$key/node_modules" "$STAGE/pi-packages/"
  say "pi pkgs  $PI_PACKAGES ($(du -sh "$STAGE/pi-packages" | cut -f1))"
fi

# Security floors for packages the upstream trees pin to a vulnerable version (npm audit high):
# every staged copy of <name> in the same major and older than the floor is swapped for the floor
# version from the npm registry (pure JS). pi-coding-agent pins undici 8.10.2 exactly (up to 1.4.0);
# 8.12.2+ fixes GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c.
# Empty SECURITY_FLOORS turns this off.
SECURITY_FLOORS=${SECURITY_FLOORS-"undici@8.12.3"}
for floor in $SECURITY_FLOORS; do
  fname=${floor%@*}; fver=${floor##*@}
  find "$STAGE" -type f -path "*/node_modules/$fname/package.json" | while read -r pj; do
    d=$(dirname "$pj")
    have=$(node -p "require('$pj').version")
    node -e '
      const [a, b] = process.argv.slice(1).map(v => v.split(".").map(Number));
      process.exit(a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])) ? 0 : 1);
    ' "$have" "$fver" || continue
    mkdir -p "$CACHE/npm"
    tgz=$(cd "$CACHE/npm" && ls "$(printf '%s' "$fname" | sed 's|^@||; s|/|-|')-$fver.tgz" 2>/dev/null || (cd "$CACHE/npm" && npm pack --silent "$fname@$fver" 2>/dev/null | tail -1))
    [ -n "$tgz" ] && [ -f "$CACHE/npm/$tgz" ] || { echo "cannot fetch $fname@$fver for the security floor; refusing" >&2; exit 1; }
    rm -rf "$d" && mkdir -p "$d" # the stage may hard-link the global pi: rm drops only the links
    tar -xzf "$CACHE/npm/$tgz" -C "$d" --strip-components=1
    say "  floor   $fname $have -> $fver (${d#"$STAGE"/})"
  done
done

# Smaller download, faster unpack (perf-install, 31 Oct): drop what never runs from every node_modules
# tree (source maps, type declarations, package docs, unreferenced src/test folders; licences stay;
# build/prune-stage.mjs lists the rules). Before the notices, so they describe what ships.
# PRUNE=0 keeps everything.
if [ "${PRUNE:-1}" = 1 ]; then
  say "$(node "$HERE/build/prune-stage.mjs" "$STAGE")"
fi
# Default: the official Node binary ships byte-identical to nodejs.org's (it carries its symbol
# table, ~18 MB, ~4 MB compressed). STRIP_NODE=1 strips it on Linux when this host can (native
# builds; a Mac binary would lose its code signature, so never there).
if [ "${STRIP_NODE:-0}" = 1 ] && [ "$OS" = linux ] && [ "$CROSS" = 0 ] && command -v strip >/dev/null; then
  before=$(wc -c <"$STAGE/node/bin/node")
  strip "$STAGE/node/bin/node"
  "$STAGE/node/bin/node" -e 0 || { echo "stripped node does not run" >&2; exit 1; }
  say "stripped node/bin/node ($(( (before - $(wc -c <"$STAGE/node/bin/node")) / 1048576 )) MB of symbols)"
fi

say "installer $HERE"
mkdir -p "$STAGE/installer"
cp -a "$HERE/lib" "$STAGE/installer/"
cp "$HERE/LICENSE" "$HERE/NOTICE" "$STAGE/"
cp "$HERE/LICENSE" "$HERE/NOTICE" "$STAGE/installer/"
mkdir -p "$STAGE/licences"
cp "$HERE/build/licences/libheif-NOTICE" "$STAGE/licences/"
# install.sh with the names stamped from lib/product.json (also published next to the tarballs).
stamp_install() {
  sed -e "s|^PRODUCT_NAME=\"[^\"]*\"|PRODUCT_NAME=\"$PRODUCT_NAME\"|" \
      -e "s|^PRODUCT_ID=\"[^\"]*\"|PRODUCT_ID=\"$PRODUCT_ID\"|" \
      -e "s|^DEFAULT_BASE_URL=\"[^\"]*\"|DEFAULT_BASE_URL=\"$DOWNLOAD_BASE_URL\"|" "$HERE/install.sh" >"$1"
  node "$HERE/build/stamp-signing.mjs" "$1" # release signature identity + pinned cosign (lib/signing.json)
  chmod 755 "$1"
}
stamp_install "$STAGE/installer/install.sh"
stamp_install "$OUT/install.sh"

# Guard: the private parts must never be in the public tarball, anywhere in it (READMEs, docs and
# node_modules included; no exceptions). See build/private-guard.sh.
sh "$HERE/build/private-guard.sh" "$STAGE"

# Every npm package's licence, and a stop on missing/UNKNOWN/proprietary ones.
mkdir -p "$CACHE"
NOTICE_IN=$(mktemp -d "$CACHE/notices.XXXX")
cp "$HERE"/build/licences/* "$NOTICE_IN/"; cp "$STAGE/node/LICENSE" "$NOTICE_IN/node-LICENSE"
node "$HERE/build/notices.mjs" "$STAGE" "$NOTICE_IN" || { rm -rf "$NOTICE_IN"; echo "licence check failed; refusing" >&2; exit 1; }
rm -rf "$NOTICE_IN"

cat >"$STAGE/MANIFEST.json" <<EOF
{
  "name": "$NAME",
  "product": "$PRODUCT_NAME",
  "version": "$PRODUCT_VERSION",
  "target": "$OS-$ARCH",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node": "$("$NODE_BIN" -v)",
  "daemon": "$(cd "$DAEMON_DIR" && node -p 'require("./package.json").version') $(head -3 "$DAEMON_DIR/COMBINED_DEPLOY.txt" 2>/dev/null | sed -n 's/^commit //p' | cut -c1-12)",
  "pi": "$(cd "$PI_DIR" && node -p 'require("./package.json").version')",
  "optchat": "$OPTCHAT_ID",
  "bots": "$BOTS_REF $(git -C "$BOTS_REPO" rev-parse --short "$BOTS_REF")",
  "installer": "$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo dirty)",
  "piPackages": "$PI_PACKAGES",
  "slim": $([ "$FULL" = 0 ] && echo true || echo false)
}
EOF

# Two archives of the same tree: .tar.zst (zstd -19 --long=27, ~40% smaller than gzip and faster to
# unpack; install.sh uses it when the computer has zstd, `dinobot update` always can, through the
# bundled Node's zlib) and .tar.gz (every computer). The 128 MB window (--long=27) is the largest a
# default zstd decoder accepts without extra flags. ZSTD=0 skips the .tar.zst (local builds only:
# the release workflow requires both).
TAR="$OUT/$NAME.tar.gz"
ZTAR="$OUT/$NAME.tar.zst"
rm -f "$TAR" "$TAR.sha256" "$ZTAR" "$ZTAR.sha256"
say "packing $TAR"
if command -v pigz >/dev/null; then
  tar -C "$OUT" -cf - "$NAME" | pigz -9 >"$TAR"
else
  tar -C "$OUT" -cf - "$NAME" | gzip -9 >"$TAR"
fi
( cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256" )
if [ "${ZSTD:-1}" = 1 ]; then
  command -v zstd >/dev/null || { echo "zstd is missing (needed for $NAME.tar.zst; ZSTD=0 skips it)" >&2; exit 1; }
  say "packing $ZTAR"
  tar -C "$OUT" -cf - "$NAME" | zstd -q -19 --long=27 -T0 -o "$ZTAR"
  zstd -q -t "$ZTAR" # decodes with default decoder limits
  ( cd "$OUT" && sha256sum "$NAME.tar.zst" >"$NAME.tar.zst.sha256" )
fi
rm -rf "$STAGE"
say "done: $(du -h "$TAR" | cut -f1) $TAR$([ -f "$ZTAR" ] && echo ", $(du -h "$ZTAR" | cut -f1) $ZTAR")"
