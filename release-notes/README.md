# Release notes

One short file per release, `v<version>.md`, used as the GitHub release body (release.yml, via
build/release-notes.sh). A tag without its file fails the release before anything is built.

Keep it short: `### New` and `### Fixed`, one plain line per item, about 3-8 lines, no internal or
test-only items. The full detail goes in CHANGELOG.md; the release links to it.
