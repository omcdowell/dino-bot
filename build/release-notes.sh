#!/bin/sh
# GitHub release body for a tag: the short notes in release-notes/<tag>.md, then a link to the
# full CHANGELOG.md at that tag.
#
#   build/release-notes.sh v0.1.10 [REPO]     REPO default: $GITHUB_REPOSITORY, else omcdowell/dino-bot
#
# Exits 1 (and prints nothing) when release-notes/<tag>.md is missing or blank: release.yml runs
# this in its first job, so a tag without notes stops before any build and no release is
# published without them.
set -eu
tag=${1:?usage: build/release-notes.sh <tag> [owner/repo]}
repo=${2:-${GITHUB_REPOSITORY:-omcdowell/dino-bot}}
dir=${RELEASE_NOTES_DIR:-$(dirname "$0")/../release-notes}
case "$tag" in */*) tag_ok=no ;; v[0-9]*) tag_ok=yes ;; *) tag_ok=no ;; esac
[ "$tag_ok" = yes ] || { echo "release-notes: '$tag' is not a v<version> tag" >&2; exit 1; }
f="$dir/$tag.md"
if [ ! -r "$f" ] || ! grep -q '[^[:space:]]' "$f"; then
  echo "release-notes: release-notes/$tag.md is missing or empty: add the short notes before tagging" >&2
  exit 1
fi
# Trim blank lines at both ends.
awk '{ l[++n] = $0 } END {
  s = 1; while (s <= n && l[s] ~ /^[ \t]*$/) s++
  e = n; while (e >= s && l[e] ~ /^[ \t]*$/) e--
  for (i = s; i <= e; i++) print l[i]
}' "$f"
printf '\nFull changelog: https://github.com/%s/blob/%s/CHANGELOG.md\n' "$repo" "$tag"
