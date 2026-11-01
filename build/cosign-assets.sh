#!/usr/bin/env bash
# The signature checker, compressed, for the release (perf-install, 31 Oct): sigstore publishes cosign
# only as raw binaries (cosign-linux-amd64 is 146 MB), which a first install downloads next to the
# tarball. install.sh fetches cosign-<os>-<arch>.zst/.gz from OUR release instead (same route as the
# tarball), unpacks it and checks the SAME pinned sha256 (lib/signing.json) on the result, so a wrong
# file here can only make installs fail, never run another binary.
#
#   build/cosign-assets.sh OUTDIR TARGET...      TARGET: linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64
#
# Writes OUTDIR/cosign-<os>-<arch>.gz (gzip -9) and .zst (zstd -19 --long=27; default decoder limits).
# COSIGN_SRC=<dir> takes the raw binaries from a folder (local runs) instead of sigstore's release.
set -euo pipefail
OUT=${1:?outdir}; shift
HERE=$(cd "$(dirname "$0")/.." && pwd)
J=$HERE/lib/signing.json
VERSION=$(node -p "require('$J').cosign.version")
sha() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
mkdir -p "$OUT"
for t in "$@"; do
  os=${t%-*}; arch=${t#*-}; [ "$arch" = x64 ] && carch=amd64 || carch=$arch
  name=cosign-$os-$carch
  pin=$(node -p "require('$J').cosign.sha256['$t'] || ''")
  [ -n "$pin" ] || { echo "cosign-assets: no pinned cosign for $t in lib/signing.json" >&2; exit 1; }
  raw=$OUT/$name
  if [ -n "${COSIGN_SRC:-}" ]; then cp "$COSIGN_SRC/$name" "$raw"
  else curl -fsSL --proto '=https' --retry 3 --retry-all-errors --connect-timeout 20 --speed-limit 10000 --speed-time 60 \
    "https://github.com/sigstore/cosign/releases/download/$VERSION/$name" -o "$raw"; fi
  got=$(sha "$raw")
  [ "$got" = "$pin" ] || { echo "cosign-assets: $name is $got, lib/signing.json pins $pin" >&2; exit 1; }
  gzip -9 -c "$raw" >"$raw.gz"
  zstd -q -19 --long=27 -T0 -f "$raw" -o "$raw.zst"
  # Round trip: both unpack to the pinned binary.
  [ "$(gzip -dc "$raw.gz" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)" = "$pin" ] || { echo "cosign-assets: $name.gz round trip" >&2; exit 1; }
  [ "$(zstd -dcq "$raw.zst" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)" = "$pin" ] || { echo "cosign-assets: $name.zst round trip" >&2; exit 1; }
  rm -f "$raw"
  echo "$name $VERSION: $(wc -c <"$raw.gz") B .gz, $(wc -c <"$raw.zst") B .zst (raw pinned $pin)"
done
