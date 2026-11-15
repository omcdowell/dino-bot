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
#   DINOBOT_TARBALL   a local .tar.gz/.tar.zst or URL to use instead (tests, offline installs)
#   DINOBOT_FORMAT=gz the .tar.gz even when zstd is here (default: .tar.zst when zstd is installed)
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
  # The very first thing, before any check or download: say what is happening (`curl | sh` is
  # otherwise silent until the name question). Every slow step below prints a line as it starts.
  #
  # Two looks (lib/tui.mjs has the same rules for the wizard). RICH: a real terminal that is not
  # TERM=dumb: step headers, blank lines around what matters, one progress line redrawn in place,
  # text wrapped to a readable column (at most 76 wide, read from the window each time), details
  # (paths, retries, signature) in ~/.dinobot/logs/install.log, named only when something fails.
  # Colour unless NO_COLOR. Otherwise (pipes, CI, logs, TERM=dumb): the plain lines, as before.
  RICH=0
  if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then RICH=1; fi
  B=""; D=""; G=""; R=""; C=""; N=""
  if [ "$RICH" = 1 ] && [ -z "${NO_COLOR:-}" ]; then
    B=$(printf '\033[1m'); D=$(printf '\033[2m'); G=$(printf '\033[32m'); R=$(printf '\033[31m'); C=$(printf '\033[36m'); N=$(printf '\033[0m')
  fi
  # Window width now (a resize is picked up at the next line): the terminal, else $COLUMNS, else 80.
  cols() {
    _w=$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2)
    case "$_w" in ''|0|*[!0-9]*) _w=$(tput cols 2>/dev/null || true) ;; esac
    case "$_w" in ''|0|*[!0-9]*) _w=${COLUMNS:-80} ;; esac
    case "$_w" in ''|0|*[!0-9]*) _w=80 ;; esac
    echo "$_w"
  }
  # wrap <indent> <text>: words never broken; a word longer than the line gets a line of its own.
  wrap() {
    _w=$(cols); _w=$((_w - 2 - $1)); [ "$_w" -le 76 ] || _w=76; [ "$_w" -ge 20 ] || _w=20
    printf '%s\n' "$2" | awk -v w="$_w" -v ind="$(printf "%$(( $1 + 2 ))s" "")" '{
      n = split($0, a, " "); line = ""
      for (i = 1; i <= n; i++) {
        if (line == "") line = a[i]
        else if (length(line) + 1 + length(a[i]) > w) { print ind line; line = a[i] }
        else line = line " " a[i]
      }
      print ind line }'
  }
  # Rich lines: say_ok "Downloaded" -> "  ✓ Downloaded"; step <n> <title>; status line redrawn with \r.
  say_ok() { printf '\r\033[K  %s✓%s %s\n' "$G" "$N" "$1"; SPACED=0; }
  status() { printf '\r\033[K  %s' "$1"; } # (callers keep it short: it must not wrap)
  step() { printf '\n  %sStep %s of 3%s  %s%s%s\n\n' "$C" "$1" "$N" "$B" "$2" "$N"; SPACED=1; }
  SPACED=0 # a blank line is already above the cursor (no second one before an error)
  # Details for the log (and only the log, in the rich look).
  LOG=""
  log() { [ -n "$LOG" ] && printf '%s\n' "$*" >>"$LOG" 2>/dev/null; return 0; }
  # say <line>: plain look prints it; rich look logs it.
  say() { if [ "$RICH" = 1 ]; then log "$*"; else echo "$*"; fi; }
  if [ "$RICH" = 1 ]; then
    printf '\n  %s%s%s\n' "$B" "Installing $PRODUCT_NAME" "$N"
    wrap 0 "This takes a minute or two. Your bots will run on this computer; your phone connects to it." | sed "s/^/$D/; s/\$/$N/"
    step 1 "Download"
  else
    echo "Installing $PRODUCT_NAME. This takes a minute or two; each step is shown below."
  fi
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

  fail() {
    if [ "$RICH" = 1 ]; then
      log "$PRODUCT_NAME install stopped: $*"
      _m="$*"; _first=$(printf '%s' "$_m" | cut -c1 | tr '[:lower:]' '[:upper:]')
      { printf '\r\033[K'; [ "$SPACED" = 1 ] || echo
        printf '  %s✗%s %s%s install stopped.%s\n' "$R" "$N" "$B" "$PRODUCT_NAME" "$N"
        wrap 2 "$_first${_m#?}"
        [ -n "$LOG" ] && [ -s "$LOG" ] && printf '%s\n' "$(wrap 2 "Details: $(printf '%s' "$LOG" | sed "s#^$HOME/#~/#")")" | sed "s/^/$D/; s/\$/$N/"
        echo; } >&2
    else printf '%s install stopped: %s\n' "$PRODUCT_NAME" "$*" >&2; fi
    exit 1
  }
  say "Checking this computer..."
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
    if [ "$RICH" = 1 ]; then
      wrap 0 "Windows (WSL ${WSL_DISTRO_NAME:-2}): $PRODUCT_NAME goes inside this Linux; your phone reaches it over Tailscale. Untested on a real Windows PC so far: if something goes wrong, see docs/windows.md in the $PRODUCT_NAME repository." | sed "s/^/$D/; s/\$/$N/"
      echo
    else
      echo "Windows WSL ${WSL_DISTRO_NAME:-2}: $PRODUCT_NAME goes inside this Linux; your phone reaches it over Tailscale."
      echo "Note: Windows (WSL) support is untested on a real Windows PC so far. If something goes wrong, see docs/windows.md in the $PRODUCT_NAME repository."
    fi
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
  # Two archives of the same build in every release: $NAME.tar.zst (~40% smaller, faster to unpack)
  # when this computer has zstd (Ubuntu/Fedora desktops, Homebrew), else $NAME.tar.gz. Both are
  # checksummed and signed alike; where there is no .tar.zst (older releases), the .tar.gz is used.
  # DINOBOT_FORMAT=gz forces the .tar.gz.
  ZST=0
  if command -v zstd >/dev/null 2>&1 && [ "${DINOBOT_FORMAT:-}" != gz ]; then ZST=1; fi
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
  if [ "$RICH" = 1 ]; then LOG="$ROOT/logs/install.log"; : >"$LOG"; log "$PRODUCT_NAME install, $(date)"; fi
  TARBALL="$ROOT/download/$ASSET"

  # Where the download comes from (MODE):
  #   tarball  DINOBOT_TARBALL (a file or URL; its .sha256 beside it)
  #   file     DINOBOT_BASE_URL=file:///dir
  #   url      DINOBOT_BASE_URL=https://…, else the GitHub release (DEFAULT_BASE_URL; DINOBOT_RELEASE=<tag>
  #            picks one release instead of the latest)
  if [ -n "${DINOBOT_TARBALL:-}" ]; then MODE=tarball
    case "$DINOBOT_TARBALL" in
      *.zst) ASSET="$NAME.tar.zst"; command -v zstd >/dev/null 2>&1 || fail "$DINOBOT_TARBALL needs zstd to unpack; use the .tar.gz" ;;
    esac
    TARBALL="$ROOT/download/$ASSET"
  elif [ -n "${DINOBOT_BASE_URL:-}" ]; then
    case "$DINOBOT_BASE_URL" in file://*) MODE=file; BASE=${DINOBOT_BASE_URL#file://} ;; *) MODE=url; BASE=$DINOBOT_BASE_URL ;; esac
  else
    MODE=url; BASE=$DEFAULT_BASE_URL
    [ "$RELEASE" = latest ] || BASE=${DEFAULT_BASE_URL%/latest/download}/download/$RELEASE
  fi

  case "$MODE:${DINOBOT_TARBALL:-}" in
    url:*|tarball:http://*|tarball:https://*)
      command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 ||
        fail "this computer has neither curl nor wget to download with. Install curl (Ubuntu: sudo apt install curl), then run the install command again. Nothing was installed." ;;
  esac
  # HTTPS only (TLS 1.2+, no downgrade on redirects); plain http only to this computer (tests).
  CURL="curl -fsSL --proto =https --tlsv1.2"
  case "$MODE" in tarball) U=$DINOBOT_TARBALL ;; url) U=$BASE ;; *) U=https:// ;; esac
  case "$U" in
    http://127.0.0.1[:/]*|http://localhost[:/]*) CURL="curl -fsSL" ;;
    http://*) fail "refusing a plain-http download ($U); use https" ;;
  esac

  # fetch <asset name> <dest> [<headers file>]: one release file, by whichever route MODE says.
  # With curl, the response headers go to <headers file> as they arrive (the progress bar reads the
  # size from them: no extra request).
  fetch() {
    case "$MODE" in
      tarball)
        case "$DINOBOT_TARBALL" in
          http://*|https://*) [ "$1" = "$ASSET" ] && u=$DINOBOT_TARBALL || u=$DINOBOT_TARBALL${1#"$ASSET"}
            get_url "$u" "$2" "${3:-}" ;;
          *) [ "$1" = "$ASSET" ] && cp "$DINOBOT_TARBALL" "$2" || cp "$DINOBOT_TARBALL${1#"$ASSET"}" "$2" ;;
        esac ;;
      file) cp "$BASE/$1" "$2" ;;
      url) get_url "$BASE/$1" "$2" "${3:-}" ;;
    esac
  }
  # get_url <url> <dest> [<headers file>]. Flaky networks (hotel Wi-Fi: about 1 in 5 new connections
  # stalls 1-20 s, and a transfer can stop dead): a short connect timeout, growing on each try; a
  # transfer that stalls (under 1 KB/s for 30 s) is dropped; up to 6 tries, each one resuming a
  # <dest> ending in .part where the last stopped (curl's own --retry starts again from 0). A .part
  # left by a failed run is resumed by the next run. 4xx: no retry, except a refused resume
  # (the server has no byte ranges, or the file changed), which starts again from 0 once.
  get_url() {
    if ! command -v curl >/dev/null 2>&1; then wget -q -T 30 -t 6 -O "$2" "$1"; return; fi
    _try=1; _fresh=0
    while :; do
      _c=""; case "$2" in *.part) [ -s "$2" ] && _c="-C -" ;; esac
      _rc=0
      # shellcheck disable=SC2086
      if [ -n "$3" ]; then $CURL --connect-timeout $((_try * 5)) --speed-limit 1024 --speed-time 30 $_c -D "$3" "$1" -o "$2" || _rc=$?
      else $CURL --connect-timeout $((_try * 5)) --speed-limit 1024 --speed-time 30 $_c "$1" -o "$2" || _rc=$?; fi
      [ "$_rc" = 0 ] && return 0
      if [ "$_rc" = 22 ] || [ "$_rc" = 33 ] || [ "$_rc" = 36 ]; then
        [ -n "$_c" ] && [ "$_fresh" = 0 ] || return "$_rc"
        _fresh=1; rm -f "$2"
      fi
      [ "$_try" -ge 6 ] && return "$_rc"
      echo "network stalled or dropped (curl $_rc); trying again ($((_try + 1))/6, resuming)" >&2
      _try=$((_try + 1)); sleep 1
    done
  }

  # Download progress: bytes in the .part file against the expected size (the source file's size,
  # or the final Content-Length curl saw; wget: unknown, so MB so far only).
  TTY=0; [ -t 1 ] && TTY=1
  dl_expect() { # dl_expect <asset>: expected bytes, or nothing when unknown
    case "$MODE" in
      file) _f=$BASE/$1 ;;
      tarball) case "$DINOBOT_TARBALL" in http://*|https://*) _f= ;; *) _f=$DINOBOT_TARBALL ;; esac ;;
      *) _f= ;;
    esac
    if [ -n "$_f" ]; then [ -f "$_f" ] && wc -c <"$_f" | tr -d ' '; return 0; fi
    # Redirects write one header block each: the last block's Content-Length is the file's.
    hdr_total "$ROOT/download/$1.hdr"
  }
  # Total size from a curl -D file: the last block's Content-Length, or the total of its
  # Content-Range (a resumed download: Content-Length is only the rest).
  hdr_total() {
    [ -s "$1" ] && tr -d '\r' <"$1" |
      awk '/^HTTP\//{n="";t=""} tolower($1)=="content-length:"{n=$2} tolower($1)=="content-range:"{sub(/.*\//,"",$3);t=$3} END{if(t+0>0)print t+0; else if(n+0>0)print n+0}'
    return 0
  }
  dl_measure() { # dl_measure [done]: sets GOT, TOT (empty: unknown), PC
    if [ "${1:-}" = done ]; then
      GOT=$(wc -c <"$ROOT/download/$(cat "$ROOT/download/asset" 2>/dev/null)" 2>/dev/null | tr -d ' '); TOT=${GOT:-}
    else
      _a=""
      for _x in "$NAME.tar.zst" "$ASSET"; do [ -f "$ROOT/download/$_x.part" ] && { _a=$_x; break; }; done
      GOT=""; TOT=""
      [ -n "$_a" ] && { GOT=$(wc -c <"$ROOT/download/$_a.part" 2>/dev/null | tr -d ' '); TOT=$(dl_expect "$_a"); }
    fi
    GOT=${GOT:-0}; PC=""
    if [ -n "$TOT" ] && [ "$TOT" -gt 0 ] 2>/dev/null; then
      PC=$((GOT * 100 / TOT)); [ "$PC" -le 100 ] || PC=100
    else TOT=""; fi
  }
  # Sizes in MB, or KB when the whole file is under 1 MB.
  dl_amount() {
    _u=1048576; _n=MB
    [ "${TOT:-$GOT}" -lt 1048576 ] && { _u=1024; _n=KB; }
    if [ -n "$TOT" ]; then echo "$((GOT / _u))/$((TOT / _u)) $_n"; else echo "$((GOT / _u)) $_n"; fi
  }
  dl_draw() { # dl_draw [done]: terminal: redraw one line; else one plain line
    _s=$(dl_amount)
    if [ "$RICH" = 1 ]; then
      if [ -n "${1:-}" ]; then say_ok "Downloaded (${_s#*/})"; return; fi
      # A bar as wide as the window allows (at most 20), built char by char (multibyte glyphs).
      _bw=$(( $(cols) - 34 )); [ "$_bw" -le 20 ] || _bw=20
      if [ -n "$PC" ] && [ "$_bw" -ge 5 ]; then
        _h=$((PC * _bw / 100)); _bar=""; _j=0
        while [ "$_j" -lt "$_bw" ]; do if [ "$_j" -lt "$_h" ]; then _bar="${_bar}━"; else _bar="${_bar}─"; fi; _j=$((_j + 1)); done
        status "Downloading  $C$_bar$N  $(printf '%3d' "$PC")%  $_s"
      else status "Downloading  ${PC:+$PC%  }$_s"; fi
      return
    fi
    if [ "$TTY" = 1 ]; then
      if [ -n "$PC" ]; then
        _h=$((PC / 5))
        printf '\rDownloading  [%.'"$_h"'s%.'"$((20 - _h))"'s] %3d%%  %s%s' '####################' '--------------------' "$PC" "$_s" "${1:+, done}"
      else printf '\rDownloading  %s%s' "$_s" "${1:+, done}"; fi
      printf '   ' # (clears what a longer line before left)
      [ -z "${1:-}" ] || echo
    elif [ -n "${1:-}" ]; then echo "Downloading done ($_s)"
    else echo "Downloading  $_s${PC:+ ($PC%)}"; fi
  }

  say "Downloading $PRODUCT_NAME ($OS/$ARCH) in the background into $ROOT"
  # 1. Download in the background (.tar.zst first when it can be unpacked here; the asset that
  # arrived is written to download/asset). A .tar.*.part left by a run that lost its network is
  # kept and resumed (RESUMED=1: if it then fails the checksum, it was of an older release, and
  # the archive is downloaded once more from the start; step 3).
  RESUMED=0
  for f in "$ROOT/download/$NAME".tar.* "$ROOT/download/asset"; do
    case "$f" in
      "$ROOT/download/$NAME.tar.zst.part"|"$ROOT/download/$NAME.tar.gz.part") [ -s "$f" ] && RESUMED=1 ;;
      *) rm -f "$f" ;;
    esac
  done
  start_download() {
    (
      # (The .tar.zst try logs to download-zst.log: download.log is about the archive that decided.)
      # No .tar.zst in the release (older ones; HTTP 404 or no such file): the .tar.gz. Any other
      # failure stops here, keeping the .part for the next run to resume.
      if [ "$MODE" != tarball ] && [ "$ZST" = 1 ]; then
        _z=0; fetch "$NAME.tar.zst" "$ROOT/download/$NAME.tar.zst.part" "$ROOT/download/$NAME.tar.zst.hdr" 2>"$ROOT/logs/download-zst.log" || _z=$?
        if [ "$_z" = 0 ]; then
          mv "$ROOT/download/$NAME.tar.zst.part" "$ROOT/download/$NAME.tar.zst" && echo "$NAME.tar.zst" >"$ROOT/download/asset"; exit
        fi
        case "$_z:$MODE" in 22:*|8:*|*:file) rm -f "$ROOT/download/$NAME.tar.zst.part" ;; *) cat "$ROOT/logs/download-zst.log"; exit "$_z" ;; esac
      fi
      fetch "$ASSET" "$TARBALL.part" "$TARBALL.hdr" && mv "$TARBALL.part" "$TARBALL" && echo "$ASSET" >"$ROOT/download/asset"
    ) >"$ROOT/logs/download.log" 2>&1 &
    DL=$!
  }
  start_download
  # 1a. At the same time, the small files beside it: <archive>.sha256 and <archive>.sigstore.json for
  # each archive it may be (each was one more round trip after the download; on GitHub that is a
  # redirect too). Checked exactly as before (step 3); one that did not arrive is fetched again there.
  (
    for a in $([ "$MODE" != tarball ] && [ "$ZST" = 1 ] && echo "$NAME.tar.zst") "$ASSET"; do
      for s in .sha256 "$SIG_SUFFIX"; do
        ( fetch "$a$s" "$ROOT/download/$a$s.part" && mv "$ROOT/download/$a$s.part" "$ROOT/download/$a$s" || rm -f "$ROOT/download/$a$s.part" ) &
      done
    done
    wait
  ) >"$ROOT/logs/sidecar.log" 2>&1 &
  SIDE=$!

  # 1b. Also in the background: the signature checker. A cosign v3+ you already have (DINOBOT_COSIGN,
  # or on PATH), else sigstore/cosign's release binary for this computer (100-146 MB, once; kept in
  # $ROOT/tools for updates), refused unless it matches the sha256 pinned above. Our release carries
  # that same binary compressed (cosign-<os>-<arch>.zst/.gz, 51-60 MB for Linux): fetched by the
  # tarball's route and unpacked first; the pin is checked on the unpacked binary, so where it came
  # from does not matter. Missing there: sigstore's own download.
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
      say "Also downloading the signature checker (cosign, once) in the background"
      (
        rm -f "$COSIGN.part"
        if [ "$MODE" != tarball ]; then
          # (<file>.part resumes like the archive's; one the network cut off is kept for the next run)
          for z in $([ "$ZST" = 1 ] && echo zst) gz; do
            _r=0; fetch "$COSIGN_ASSET.$z" "$COSIGN.$z.part" "$COSIGN.$z.hdr" || _r=$?
            rm -f "$COSIGN.$z.hdr"
            if [ "$_r" = 0 ]; then
              if [ "$z" = zst ]; then zstd -dcq "$COSIGN.$z.part" >"$COSIGN.part"; else gzip -dc "$COSIGN.$z.part" >"$COSIGN.part"; fi || rm -f "$COSIGN.part"
              rm -f "$COSIGN.$z.part"
            else
              case "$_r:$MODE" in 22:*|8:*|*:file) rm -f "$COSIGN.$z.part" ;; *) exit 1 ;; esac
            fi
            [ -s "$COSIGN.part" ] && { echo "cosign from the release ($COSIGN_ASSET.$z)"; break; }
          done
        fi
        if [ ! -s "$COSIGN.part" ]; then
          case "$COSIGN_URL" in file://*) CCURL="curl -fsSL" ;; *) CCURL="curl -fsSL --proto =https --tlsv1.2" ;; esac
          if command -v curl >/dev/null 2>&1; then $CCURL --connect-timeout 10 --retry 4 --speed-limit 1024 --speed-time 30 "$COSIGN_URL" -o "$COSIGN.part"
          else wget -qO "$COSIGN.part" "$COSIGN_URL"; fi || exit 1
        fi
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
  # Asked on the first install only: running the install command again (an update) keeps the name
  # setup saved (no --name: setup reads it).
  USER_NAME=${DINOBOT_NAME:-}
  if [ -z "$USER_NAME" ] && [ ! -f "$ROOT/state.json" ]; then
    NAME_DEFAULT=$(default_name)
    case " $* " in *" --yes "*) USER_NAME=$NAME_DEFAULT ;; esac
    if [ -z "$USER_NAME" ] && [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
      if [ "$RICH" = 1 ]; then printf '  %sWhat should your bots call you?%s [%s]: ' "$B" "$N" "$NAME_DEFAULT"
      else printf 'While that downloads: what should your bots call you? [%s]: ' "$NAME_DEFAULT"; fi
      read -r USER_NAME </dev/tty || USER_NAME=""
      if [ "$RICH" = 1 ]; then echo; SPACED=1; fi
    fi
    [ -n "$USER_NAME" ] || USER_NAME=$NAME_DEFAULT
  fi
  [ -z "$USER_NAME" ] || set -- --name "$USER_NAME" "$@"

  # 3. Wait for the download, check it, unpack (old app kept until the new one is in place).
  # (A progress bar from a ticker; `wait` returns the moment the download ends, not at the next
  # tick. Terminal: one line redrawn twice a second. Otherwise (logs, CI): a line at each quarter,
  # or every 30 s when the size is unknown. Already finished: just the finished bar.)
  wait_download() {
    TICK=""
    if kill -0 "$DL" 2>/dev/null; then
      (
        i=0; q=25
        if [ "$TTY" = 1 ]; then dl_measure; dl_draw; fi
        while sleep 0.5 2>/dev/null || sleep 1; do
          i=$((i + 1)); dl_measure
          if [ "$TTY" = 1 ] || [ "$RICH" = 1 ]; then dl_draw
          elif [ -n "$PC" ]; then [ "$PC" -ge "$q" ] && [ "$PC" -lt 100 ] && { dl_draw; q=$(( (PC / 25 + 1) * 25 )); }
          elif [ $((i % 60)) = 0 ]; then dl_draw; fi
        done
      ) &
      TICK=$!
    fi
    DLRC=0; wait "$DL" || DLRC=$?
    [ -z "$TICK" ] || { kill "$TICK" 2>/dev/null || true; wait "$TICK" 2>/dev/null || true; }
    rm -f "$ROOT/download/$NAME".tar.*.hdr
    if [ "$DLRC" != 0 ]; then
      if [ "$RICH" = 1 ]; then
        # curl's own lines and the retries go to the log; the screen gets one sentence (fail).
        printf '\r\033[K'; { echo "Downloading failed:"; cat "$ROOT/logs/download.log"; } >>"$LOG"
      else
        [ "$TTY" = 1 ] && echo
        echo "Downloading failed"; cat "$ROOT/logs/download.log" >&2
      fi
      # curl -f: "error: 404"; wget: "ERROR 404". A release URL that 404s means nothing is published there.
      [ "$MODE" = url ] && grep -Eq '(error|ERROR):? 404' "$ROOT/logs/download.log" 2>/dev/null &&
        fail "no release has been published yet at $BASE (or it has no $ASSET for this computer). Nothing was installed."
      [ "$MODE" = file ] && fail "could not copy $ASSET from $BASE. Nothing was installed."
      fail "the download of $ASSET stopped: the network dropped or stalled. Run the same install command again: it carries on where it stopped. Nothing was installed yet."
    fi
    dl_measure done; dl_draw done
  }
  ASSET0=$ASSET; TARBALL0=$TARBALL
  while :; do
    wait_download
    wait "$SIDE" 2>/dev/null || true
    ASSET=$(cat "$ROOT/download/asset")
    TARBALL="$ROOT/download/$ASSET"
    rm -f "$ROOT/download/asset"
    # Verify, fail closed: no checksum, no install. Two sources, both from the release: the checksum
    # pinned into this script when the release was published, and the release's <tarball>.sha256.
    # Either is enough; if both are there they must agree. Checksums catch corruption; authenticity
    # comes from the signature check right after.
    # DINOBOT_ALLOW_UNVERIFIED=1 is for local development builds only.
    say "Checking the download (checksum$([ "$SIGN" = 1 ] && echo " and signature"))..."
    if [ "$RICH" = 1 ]; then status "Checking the download..."; fi
    TAR_SHA=$(sha256_of "$TARBALL")
    PIN_SHA=""
    for p in $PINNED_SHA256S; do [ "${p%%=*}" = "$ASSET" ] && PIN_SHA=${p#*=}; done
    FILE_SHA=""
    if { [ -s "$TARBALL.sha256" ] || fetch "$ASSET.sha256" "$TARBALL.sha256" >/dev/null 2>&1; } && [ -s "$TARBALL.sha256" ]; then FILE_SHA=$(cut -d' ' -f1 "$TARBALL.sha256"); fi
    rm -f "$TARBALL.sha256"
    WANT_SHA=${PIN_SHA:-$FILE_SHA}
    if [ -n "$PIN_SHA" ] && [ -n "$FILE_SHA" ] && [ "$PIN_SHA" != "$FILE_SHA" ]; then
      rm -f "$TARBALL"; fail "the release's checksum file does not match the checksum in this install script (tampered or mixed releases). Nothing was installed."
    fi
    if [ -z "$WANT_SHA" ]; then
      if [ "${DINOBOT_ALLOW_UNVERIFIED:-0}" = 1 ]; then echo "WARNING: installing an unverified build (DINOBOT_ALLOW_UNVERIFIED=1)" >&2
      else rm -f "$TARBALL"; fail "could not get the checksum ($ASSET.sha256), so the download cannot be verified. Nothing was installed; try again later."; fi
    elif [ "$WANT_SHA" != "$TAR_SHA" ]; then
      rm -f "$TARBALL"
      # A .part resumed from an earlier run, of a release that has been replaced since: once more from 0.
      if [ "$RESUMED" = 1 ]; then
        say "The part downloaded by an earlier try was of another release; downloading again from the start."
        if [ "$RICH" = 1 ]; then { printf '\r\033[K'; wrap 0 "The part downloaded earlier was of another release: downloading again from the start." | sed "s/^/$D/; s/\$/$N/"; }; fi
        RESUMED=0; ASSET=$ASSET0; TARBALL=$TARBALL0; rm -f "$ROOT/download/$NAME".tar.*
        start_download; continue
      fi
      fail "the download does not match its checksum (corrupted or tampered). Nothing was installed."
    fi
    break
  done
  # Signature (see SIGNING_MODE above), fail closed, before anything is unpacked. Fetched by the
  # same route as the tarball (URL or file).
  if [ "$SIGN" = 1 ]; then
    BUNDLE="$TARBALL$SIG_SUFFIX"
    [ -s "$BUNDLE" ] || { fetch "$ASSET$SIG_SUFFIX" "$BUNDLE" >/dev/null 2>&1 || rm -f "$BUNDLE"; }
    [ -s "$BUNDLE" ] || { rm -f "$TARBALL" "$BUNDLE"; fail "the release has no signature ($ASSET$SIG_SUFFIX), so it cannot be verified. Nothing was installed."; }
    if [ -n "$CS" ]; then
      # Progress of whichever cosign file is arriving (MB so far / total; terminal only, one line).
      [ "$RICH" = 1 ] || printf 'Getting the signature checker'
      if [ "$RICH" = 1 ]; then status "Getting the signature checker (once)..."; fi
      if [ "$TTY" = 1 ]; then
        ( while sleep 0.5 2>/dev/null || sleep 1; do
            GOT=""; TOT=""
            for _x in "$COSIGN.zst" "$COSIGN.gz" "$COSIGN"; do
              [ -f "$_x.part" ] && { GOT=$(wc -c <"$_x.part" | tr -d ' '); TOT=$(hdr_total "$_x.hdr"); break; }
            done
            if [ -n "$GOT" ]; then
              if [ "$RICH" = 1 ]; then status "Getting the signature checker (once)  $(dl_amount)"
              else printf '\rGetting the signature checker  %s   ' "$(dl_amount)"; fi
            fi
          done ) &
      else ( while sleep 10; do printf '.'; done ) & fi
      TICK=$!
      CSRC=0; wait "$CS" || CSRC=$?
      kill "$TICK" 2>/dev/null || true; wait "$TICK" 2>/dev/null || true
      if [ "$RICH" = 1 ]; then printf '\r\033[K'; else echo; fi
      [ "$CSRC" = 0 ] || { rm -f "$TARBALL" "$BUNDLE"; fail "could not get the signature checker (cosign $COSIGN_VERSION): $(tail -1 "$ROOT/logs/cosign.log"). Nothing was installed."; }
    fi
    mkdir -p "$ROOT/tools/sigstore"
    if ! TUF_ROOT="$ROOT/tools/sigstore" "$COSIGN" verify-blob "$TARBALL" --bundle "$BUNDLE" \
        --certificate-identity-regexp "$SIGNER_IDENTITY_RE" --certificate-oidc-issuer "$SIGNER_ISSUER" \
        --certificate-github-workflow-repository "$SIGNER_REPO" >"$ROOT/logs/signature.log" 2>&1; then
      rm -f "$TARBALL" "$BUNDLE"
      fail "the download's signature is not from $PRODUCT_NAME's release workflow ($(grep -v '^$' "$ROOT/logs/signature.log" | tail -1)). Nothing was installed."
    fi
    rm -f "$BUNDLE"
    say "Signature OK (built and signed by $SIGNER_REPO's release workflow)"
    if [ "$RICH" = 1 ]; then say_ok "Checked: checksum and signature"; fi
  elif [ "$SIGNING_MODE" != off ]; then
    if [ "$RICH" = 1 ]; then say_ok "Checked: checksum"; wrap 2 "! signature not checked (development build: DINOBOT_ALLOW_UNSIGNED)" | sed "s/^/$D/; s/\$/$N/" >&2
    else echo "WARNING: signature not checked (DINOBOT_ALLOW_UNSIGNED / DINOBOT_ALLOW_UNVERIFIED)" >&2; fi
  elif [ "$RICH" = 1 ]; then say_ok "Checked: checksum"
  fi
  say "Unpacking into $ROOT/app..."
  if [ "$RICH" = 1 ]; then status "Unpacking..."; fi
  rm -rf "$ROOT/app.new"
  mkdir -p "$ROOT/app.new"
  # -m: the files get today's time (the sources' fixed commit date may lie in the future).
  case "$ASSET" in
    *.zst)
      rm -f "$ROOT/download/unzstd.failed"
      { zstd -dcq "$TARBALL" || : >"$ROOT/download/unzstd.failed"; } | tar -xmf - -C "$ROOT/app.new" --strip-components=1 || fail "could not unpack $TARBALL"
      [ ! -e "$ROOT/download/unzstd.failed" ] || { rm -f "$ROOT/download/unzstd.failed"; fail "could not unpack $TARBALL (zstd)"; } ;;
    *) tar -xmzf "$TARBALL" -C "$ROOT/app.new" --strip-components=1 || fail "could not unpack $TARBALL" ;;
  esac
  [ -x "$ROOT/app.new/node/bin/node" ] || fail "the tarball has no Node"
  if [ -d "$ROOT/app" ]; then rm -rf "$ROOT/app.old"; mv "$ROOT/app" "$ROOT/app.old"; fi
  mv "$ROOT/app.new" "$ROOT/app"
  rm -f "$TARBALL" "$ROOT/download/$NAME".tar.*
  T1=$(now_ms)
  if [ "$RICH" = 1 ]; then say_ok "Unpacked"; fi

  say "Starting the setup wizard..."
  # 4. The wizard (bundled Node). It prints the QR as soon as the daemon listens.
  # The wizard reads answers from /dev/tty itself, so `curl | sh` works.
  DINOBOT_T0_MS=$T0 DINOBOT_FETCH_MS=$((T1 - T0)) DINOBOT_HOME=$ROOT DINOBOT_TARBALL_SHA=$TAR_SHA DINOBOT_TARBALL_FORMAT=${ASSET##*.} DINOBOT_SOURCE_MODE=$MODE \
    exec "$ROOT/app/node/bin/node" --experimental-transform-types --no-warnings \
    "$ROOT/app/installer/lib/cli.mjs" setup "$@"
}

main "$@"
