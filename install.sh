#!/bin/sh
# One-line installer (Design B). Product names: lib/product.json (stamped below by the build).
#
#   curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
#
# Downloads ONE prebuilt tarball (Node, daemon, pi, OptChat, bots plugin, herdr; no npm install),
# asks your name while it downloads, unpacks into ~/.dinobot, then runs the wizard, which prints
# the pairing QR as soon as the daemon listens. Never uses sudo. macOS and Linux (also Windows,
# inside WSL 2), x64 and arm64.
#
# Env:
#   DINOBOT_RELEASE   release tag (default: the latest release)
#   DINOBOT_BASE_URL  where tarballs live: https://… or file:///dir (tests, stand-ins); skips GitHub
#   DINOBOT_TARBALL   a local .tar.gz or URL to use instead (tests, offline installs)
#   DINOBOT_HOME      install root (default ~/.dinobot)
#   DINOBOT_NAME      your name (skips the question)
#   DINOBOT_COSIGN    a cosign (v3+) to check the signature with (default: on PATH, else downloaded)
#   DINOBOT_ALLOW_UNSIGNED=1  local development builds only: skip the signature (checksum still needed)
# Extra arguments go to the wizard, e.g. `sh install.sh --yes --service none`.
set -eu

PRODUCT_NAME="DinoBot" # stamped from lib/product.json (name)
PRODUCT_ID="dinobot" # stamped from lib/product.json (id)

DEFAULT_BASE_URL="https://github.com/omcdowell/dino-bot/releases/latest/download" # stamped from lib/product.json (downloadBaseUrl)
# Checksums pinned into this script (optional): "<tarball>=<sha256> …". Empty: the release's
# .sha256 file is used (still required).
PINNED_SHA256S=""
# Release signature (lib/signing.json; stamped by build/stamp-signing.mjs): every tarball comes with
# <tarball>.sigstore.json, a keyless Sigstore signature made by our release workflow in GitHub
# Actions. It is checked with cosign (pinned below) BEFORE anything is unpacked; no signature or
# a signature from anything but that workflow at a release tag = nothing installed.
# DINOBOT_ALLOW_UNSIGNED=1 skips it for local development builds (the checksum is still required).
SIGNING_MODE="cosign" # stamped from lib/signing.json (mode): cosign = required, off = checksum only
SIGNER_REPO="omcdowell/dino-bot" # stamped from lib/signing.json (repo)
SIGNER_IDENTITY_RE='^https://github\.com/omcdowell/dino-bot/\.github/workflows/release\.yml@refs/tags/v[0-9]' # stamped (repo, workflow, tagPattern)
SIGNER_ISSUER="https://token.actions.githubusercontent.com" # stamped from lib/signing.json (issuer)
SIG_SUFFIX=".sigstore.json" # stamped from lib/signing.json (bundleSuffix)
COSIGN_VERSION="v3.1.4" # stamped from lib/signing.json (cosign.version)
COSIGN_SHA256S="darwin-arm64=9f9b8cd557cf2e5b3df3373a00baa005a86b02391e3e06dd0ce37b3a1533d3a4 darwin-x64=9d1e4abe2b6be279ed0d2ff706fde1ccd738747c834e3e6d44039c238867334f linux-arm64=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2 linux-x64=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa" # stamped from lib/signing.json (cosign.sha256)

# Everything runs inside main(), called on the last line: a download cut off half-way defines
# a function and runs nothing.
main() {
  # Owner-only files: bot memories, chats, logs and secrets are not for other users of this computer.
  umask 077
  ROOT=${DINOBOT_HOME:-$HOME/.$PRODUCT_ID}
  RELEASE=${DINOBOT_RELEASE:-latest}

  now_ms() {
    # POSIX date has no milliseconds; macOS date has no %N. Prefer perl/python if there. Debian and
    # Ubuntu's minimal perl (perl-base) has no Time::HiRes, so each one falls through when it fails.
    perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null \
      || python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null \
      || echo "$(date +%s)000"
  }
  T0=$(now_ms)

  fail() { printf '%s install stopped: %s\n' "$PRODUCT_NAME" "$*" >&2; exit 1; }
  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    else fail "no sha256sum or shasum on this computer; cannot verify the download"; fi
  }

  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      fail "on Windows, $PRODUCT_NAME runs inside WSL (Ubuntu). In PowerShell run:  wsl --install -d Ubuntu-24.04   then open Ubuntu and run this install command there. Nothing was installed." ;;
    *) fail "only macOS, Linux and Windows (WSL) are supported for now (found $(uname -s))" ;;
  esac
  # Windows (WSL): WSL 1 cannot run Tailscale; Windows drives (/mnt/c) have no Unix file modes, so
  # the password file would be readable by every program, and they are slow for many small files.
  WSL=0
  if [ "$OS" = linux ]; then
    PROC_VERSION=$(cat "${DINOBOT_PROC_VERSION:-/proc/version}" 2>/dev/null || true) # (override: tests)
    case "$PROC_VERSION" in
      *microsoft-standard*|*WSL2*) WSL=2 ;;
      *[Mm]icrosoft*) WSL=1 ;;
      *) [ -n "${WSL_DISTRO_NAME:-}" ] && WSL=2 ;;
    esac
  fi
  if [ "$WSL" = 1 ]; then
    fail "this Ubuntu runs on WSL 1, which cannot run Tailscale. In Windows PowerShell run:  wsl --set-version ${WSL_DISTRO_NAME:-<distro>} 2   then run the install command again. Nothing was installed."
  fi
  if [ "$WSL" = 2 ]; then
    echo "Windows WSL ${WSL_DISTRO_NAME:-2}: $PRODUCT_NAME goes inside this Linux; your phone reaches it over Tailscale."
    echo "Note: Windows (WSL) support is untested on a real Windows PC so far. If something goes wrong, see docs/windows.md in the $PRODUCT_NAME repository."
    case "$ROOT" in
      /mnt/[a-zA-Z]|/mnt/[a-zA-Z]/*) fail "$ROOT is on a Windows drive, which cannot keep $PRODUCT_NAME's password private and is slow. Install into Ubuntu's own home folder (leave DINOBOT_HOME unset). Nothing was installed." ;;
    esac
  fi
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) fail "unsupported CPU $(uname -m)" ;;
  esac
  NAME="$PRODUCT_ID-$OS-$ARCH"
  ASSET="$NAME.tar.gz"
  command -v tar >/dev/null 2>&1 || fail "tar is missing"
  # Linux: the daemon stops bot processes with ps (procps-ng); minimal Debian/Fedora images lack it
  # and the daemon then crashes the first time a bot finishes (linux-ready). Desktops have it.
  if [ "$OS" = linux ] && ! command -v ps >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then PKG_HINT="sudo apt install procps"
    elif command -v dnf >/dev/null 2>&1; then PKG_HINT="sudo dnf install procps-ng"
    elif command -v pacman >/dev/null 2>&1; then PKG_HINT="sudo pacman -S procps-ng"
    elif command -v zypper >/dev/null 2>&1; then PKG_HINT="sudo zypper install procps"
    else PKG_HINT="install your distribution's procps package"; fi
    fail "this computer has no 'ps' command, which $PRODUCT_NAME needs. Run:  $PKG_HINT   then run the install command again. Nothing was installed."
  fi

  mkdir -p "$ROOT/download" "$ROOT/logs"
  TARBALL="$ROOT/download/$ASSET"

  # Where the download comes from (MODE):
  #   tarball  DINOBOT_TARBALL (a file or URL; its .sha256 beside it)
  #   file     DINOBOT_BASE_URL=file:///dir
  #   url      DINOBOT_BASE_URL=https://…, else the GitHub release (DEFAULT_BASE_URL; DINOBOT_RELEASE=<tag>
  #            picks one release instead of the latest)
  if [ -n "${DINOBOT_TARBALL:-}" ]; then MODE=tarball
  elif [ -n "${DINOBOT_BASE_URL:-}" ]; then
    case "$DINOBOT_BASE_URL" in file://*) MODE=file; BASE=${DINOBOT_BASE_URL#file://} ;; *) MODE=url; BASE=$DINOBOT_BASE_URL ;; esac
  else
    MODE=url; BASE=$DEFAULT_BASE_URL
    [ "$RELEASE" = latest ] || BASE=${DEFAULT_BASE_URL%/latest/download}/download/$RELEASE
  fi

  # HTTPS only (TLS 1.2+, no downgrade on redirects); plain http only to this computer (tests).
  CURL="curl -fsSL --proto =https --tlsv1.2"
  case "$MODE" in tarball) U=$DINOBOT_TARBALL ;; url) U=$BASE ;; *) U=https:// ;; esac
  case "$U" in
    http://127.0.0.1[:/]*|http://localhost[:/]*) CURL="curl -fsSL" ;;
    http://*) fail "refusing a plain-http download ($U); use https" ;;
  esac

  # fetch <asset name> <dest>: one release file, by whichever route MODE says.
  fetch() {
    case "$MODE" in
      tarball)
        case "$DINOBOT_TARBALL" in
          http://*|https://*) [ "$1" = "$ASSET" ] && u=$DINOBOT_TARBALL || u=$DINOBOT_TARBALL${1#"$ASSET"}
            if command -v curl >/dev/null 2>&1; then $CURL "$u" -o "$2"; else wget -qO "$2" "$u"; fi ;;
          *) [ "$1" = "$ASSET" ] && cp "$DINOBOT_TARBALL" "$2" || cp "$DINOBOT_TARBALL${1#"$ASSET"}" "$2" ;;
        esac ;;
      file) cp "$BASE/$1" "$2" ;;
      url) if command -v curl >/dev/null 2>&1; then $CURL "$BASE/$1" -o "$2"; else wget -qO "$2" "$BASE/$1"; fi ;;
    esac
  }

  # 1. Download in the background.
  ( fetch "$ASSET" "$TARBALL.part" && mv "$TARBALL.part" "$TARBALL" ) >"$ROOT/logs/download.log" 2>&1 &
  DL=$!

  # 1b. Also in the background: the signature checker. A cosign v3+ you already have (DINOBOT_COSIGN,
  # or on PATH), else sigstore/cosign's release binary for this computer (~100 MB, once; kept in
  # $ROOT/tools for updates), refused unless it matches the sha256 pinned above.
  SIGN=1
  [ "$SIGNING_MODE" = off ] && SIGN=0
  if [ "${DINOBOT_ALLOW_UNSIGNED:-0}" = 1 ] || [ "${DINOBOT_ALLOW_UNVERIFIED:-0}" = 1 ]; then SIGN=0; fi
  COSIGN=""; CS=""
  if [ "$SIGN" = 1 ]; then
    COSIGN_PIN=""
    for p in $COSIGN_SHA256S; do [ "${p%%=*}" = "$OS-$ARCH" ] && COSIGN_PIN=${p#*=}; done
    [ "$ARCH" = x64 ] && CARCH=amd64 || CARCH=$ARCH
    COSIGN_ASSET="cosign-$OS-$CARCH"
    COSIGN_URL="${DINOBOT_COSIGN_BASE_URL:-https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION}/$COSIGN_ASSET"
    mkdir -p "$ROOT/tools"
    if [ -n "${DINOBOT_COSIGN:-}" ]; then COSIGN=$DINOBOT_COSIGN
    elif [ -n "$COSIGN_PIN" ] && [ -x "$ROOT/tools/cosign" ] && [ "$(sha256_of "$ROOT/tools/cosign")" = "$COSIGN_PIN" ]; then COSIGN=$ROOT/tools/cosign
    elif command -v cosign >/dev/null 2>&1 && [ "$(cosign version 2>&1 | sed -n 's/^GitVersion: *v\{0,1\}\([0-9][0-9]*\)\..*/\1/p')" -ge 3 ] 2>/dev/null; then COSIGN=cosign
    else
      [ -n "$COSIGN_PIN" ] || { kill "$DL" 2>/dev/null; fail "no pinned signature checker (cosign) for $OS/$ARCH. Nothing was installed."; }
      COSIGN=$ROOT/tools/cosign
      (
        case "$COSIGN_URL" in file://*) CCURL="curl -fsSL" ;; *) CCURL="curl -fsSL --proto =https --tlsv1.2" ;; esac
        if command -v curl >/dev/null 2>&1; then $CCURL --retry 2 "$COSIGN_URL" -o "$COSIGN.part"
        else wget -qO "$COSIGN.part" "$COSIGN_URL"; fi || exit 1
        [ "$(sha256_of "$COSIGN.part")" = "$COSIGN_PIN" ] || { rm -f "$COSIGN.part"; echo "cosign download does not match its pinned checksum"; exit 1; }
        chmod 755 "$COSIGN.part" && mv "$COSIGN.part" "$COSIGN"
      ) >"$ROOT/logs/cosign.log" 2>&1 &
      CS=$!
    fi
  fi


  # 2. Meanwhile: the one question that needs no download (pre-filled; Enter keeps it).
  default_name() {
    if [ "$OS" = darwin ]; then id -F 2>/dev/null && return; fi
    n=$(getent passwd "${USER:-$(id -un)}" 2>/dev/null | cut -d: -f5 | cut -d, -f1)
    [ -n "$n" ] && { echo "$n"; return; }
    u=${USER:-$(id -un)}; printf '%s\n' "$u" | awk '{print toupper(substr($0,1,1)) substr($0,2)}'
  }
  NAME_DEFAULT=$(default_name)
  USER_NAME=${DINOBOT_NAME:-}
  echo "Installing $PRODUCT_NAME ($OS/$ARCH) into $ROOT"
  if [ -z "$USER_NAME" ]; then
    case " $* " in *" --yes "*) USER_NAME=$NAME_DEFAULT ;; esac
  fi
  if [ -z "$USER_NAME" ] && [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
    printf 'What should your bots call you? [%s]: ' "$NAME_DEFAULT"
    read -r USER_NAME </dev/tty || USER_NAME=""
  fi
  [ -n "$USER_NAME" ] || USER_NAME=$NAME_DEFAULT

  # 3. Wait for the download, check it, unpack (old app kept until the new one is in place).
  printf 'Downloading'
  while kill -0 "$DL" 2>/dev/null; do printf '.'; sleep 1; done
  if ! wait "$DL"; then
    echo; cat "$ROOT/logs/download.log" >&2
    # curl -f: "error: 404"; wget: "ERROR 404". A release URL that 404s means nothing is published there.
    [ "$MODE" = url ] && grep -Eq '(error|ERROR):? 404' "$ROOT/logs/download.log" 2>/dev/null &&
      fail "no release has been published yet at $BASE (or it has no $ASSET for this computer). Nothing was installed."
    fail "download of $ASSET failed ($MODE). Nothing was installed."
  fi
  echo " done"
  # Verify, fail closed: no checksum, no install. Two sources, both from the release: the checksum
  # pinned into this script when the release was published, and the release's <tarball>.sha256.
  # Either is enough; if both are there they must agree. Checksums catch corruption; authenticity
  # comes from the signature check right after.
  # DINOBOT_ALLOW_UNVERIFIED=1 is for local development builds only.
  TAR_SHA=$(sha256_of "$TARBALL")
  PIN_SHA=""
  for p in $PINNED_SHA256S; do [ "${p%%=*}" = "$ASSET" ] && PIN_SHA=${p#*=}; done
  FILE_SHA=""
  if fetch "$ASSET.sha256" "$TARBALL.sha256" >/dev/null 2>&1 && [ -s "$TARBALL.sha256" ]; then FILE_SHA=$(cut -d' ' -f1 "$TARBALL.sha256"); fi
  rm -f "$TARBALL.sha256"
  WANT_SHA=${PIN_SHA:-$FILE_SHA}
  if [ -n "$PIN_SHA" ] && [ -n "$FILE_SHA" ] && [ "$PIN_SHA" != "$FILE_SHA" ]; then
    rm -f "$TARBALL"; fail "the release's checksum file does not match the checksum in this install script (tampered or mixed releases). Nothing was installed."
  fi
  if [ -z "$WANT_SHA" ]; then
    if [ "${DINOBOT_ALLOW_UNVERIFIED:-0}" = 1 ]; then echo "WARNING: installing an unverified build (DINOBOT_ALLOW_UNVERIFIED=1)" >&2
    else rm -f "$TARBALL"; fail "could not get the checksum ($ASSET.sha256), so the download cannot be verified. Nothing was installed; try again later."; fi
  elif [ "$WANT_SHA" != "$TAR_SHA" ]; then
    rm -f "$TARBALL"; fail "the download does not match its checksum (corrupted or tampered). Nothing was installed."
  fi
  # Signature (see SIGNING_MODE above), fail closed, before anything is unpacked. Fetched by the
  # same route as the tarball (URL or file).
  if [ "$SIGN" = 1 ]; then
    BUNDLE="$TARBALL$SIG_SUFFIX"
    rm -f "$BUNDLE"
    fetch "$ASSET$SIG_SUFFIX" "$BUNDLE" >/dev/null 2>&1 || rm -f "$BUNDLE"
    [ -s "$BUNDLE" ] || { rm -f "$TARBALL" "$BUNDLE"; fail "the release has no signature ($ASSET$SIG_SUFFIX), so it cannot be verified. Nothing was installed."; }
    if [ -n "$CS" ]; then
      printf 'Getting the signature checker'
      while kill -0 "$CS" 2>/dev/null; do printf '.'; sleep 1; done
      echo
      wait "$CS" || { rm -f "$TARBALL" "$BUNDLE"; fail "could not get the signature checker (cosign $COSIGN_VERSION from github.com/sigstore/cosign): $(tail -1 "$ROOT/logs/cosign.log"). Nothing was installed."; }
    fi
    mkdir -p "$ROOT/tools/sigstore"
    if ! TUF_ROOT="$ROOT/tools/sigstore" "$COSIGN" verify-blob "$TARBALL" --bundle "$BUNDLE" \
        --certificate-identity-regexp "$SIGNER_IDENTITY_RE" --certificate-oidc-issuer "$SIGNER_ISSUER" \
        --certificate-github-workflow-repository "$SIGNER_REPO" >"$ROOT/logs/signature.log" 2>&1; then
      rm -f "$TARBALL" "$BUNDLE"
      fail "the download's signature is not from $PRODUCT_NAME's release workflow ($(grep -v '^$' "$ROOT/logs/signature.log" | tail -1)). Nothing was installed."
    fi
    rm -f "$BUNDLE"
    echo "Signature OK (built and signed by $SIGNER_REPO's release workflow)"
  elif [ "$SIGNING_MODE" != off ]; then echo "WARNING: signature not checked (DINOBOT_ALLOW_UNSIGNED / DINOBOT_ALLOW_UNVERIFIED)" >&2
  fi
  rm -rf "$ROOT/app.new"
  mkdir -p "$ROOT/app.new"
  tar -xzf "$TARBALL" -C "$ROOT/app.new" --strip-components=1 || fail "could not unpack $TARBALL"
  [ -x "$ROOT/app.new/node/bin/node" ] || fail "the tarball has no Node"
  if [ -d "$ROOT/app" ]; then rm -rf "$ROOT/app.old"; mv "$ROOT/app" "$ROOT/app.old"; fi
  mv "$ROOT/app.new" "$ROOT/app"
  rm -f "$TARBALL"
  T1=$(now_ms)

  # 4. The wizard (bundled Node). It prints the QR as soon as the daemon listens.
  # The wizard reads answers from /dev/tty itself, so `curl | sh` works.
  DINOBOT_T0_MS=$T0 DINOBOT_FETCH_MS=$((T1 - T0)) DINOBOT_HOME=$ROOT DINOBOT_TARBALL_SHA=$TAR_SHA DINOBOT_SOURCE_MODE=$MODE \
    exec "$ROOT/app/node/bin/node" --experimental-transform-types --no-warnings \
    "$ROOT/app/installer/lib/cli.mjs" setup --name "$USER_NAME" "$@"
}

main "$@"
