# Releases and verification

## What a download is checked against

Downloads fail closed, twice, before anything is unpacked (`install.sh` and `dinobot update` alike):

1. **checksum**: `<tarball>.sha256` from the same release must be there and match;
2. **signature**: `<tarball>.sigstore.json`, a keyless Sigstore bundle made by
   `.github/workflows/release.yml` of `omcdowell/dino-bot` at a `v*` tag (issuer
   `token.actions.githubusercontent.com`), checked with cosign v3 (on PATH, else sigstore/cosign's
   release binary pinned by sha256 in `install.sh`, kept in `~/.dinobot/tools`).

Downloads are HTTPS only (`curl --proto =https --tlsv1.2`). See [SECURITY.md](../SECURITY.md) for
checking a download by hand.

One place for signing: `lib/signing.json` (mode `cosign`|`off`, repo, workflow, cosign pin).
`build/stamp-signing.mjs` stamps it into `install.sh` (the tarball build does this;
`test/signing.test.mjs` fails on drift).

Development flags: `DINOBOT_ALLOW_UNSIGNED=1` (local builds: no signature, checksum still required;
the e2e scripts set it), `DINOBOT_ALLOW_UNVERIFIED=1` (neither), `DINOBOT_COSIGN=<path>` picks the
verifier, `DINOBOT_BASE_URL=file:///dir` or `https://…` installs from another folder or host,
`DINOBOT_TARBALL=<file|url>` installs one tarball.

## How a release is made

1. `build/prepare-sources.sh OUT PASEO BOTS OPTCHAT` makes one fresh commit per source tree
   (`src/paseo`, `src/paseo-bots`, `src/pi-optchat`) and pins them in `build/sources.json`.
2. `SOURCES_GIT=OUT build/preflight-release.sh` runs, locally and on the exact tree to be pushed,
   the workflow's tests, a full `ci-build.sh linux-x64` under a 7 GB cap, the workflow rules and
   actionlint.
3. `build/publish-public.sh` (dry run by default) builds the one-commit public tree, checks it
   (`build/public-check.mjs`, `build/private-guard.sh`, gitleaks) and, with `--for-real`, pushes
   `main` and `src/*`; with `TAG=v<semver>` it also pushes the tag.
4. The tag starts `.github/workflows/release.yml`: tests, builds linux-x64 and linux-arm64, then
   darwin-arm64 (macOS minutes count 10x, so only after Linux passed), each on its own runner from
   `build/sources.json` (`build/ci-build.sh`); signs with `cosign sign-blob` (only the release job
   has `id-token: write`), re-verifies exactly as clients do, and creates the GitHub Release.

Credit guards: no tag while a release run is going; every workflow is tag-only and cancels an
older run of the same tag.

## Licences in the tarball

LICENSE (Apache-2.0) and NOTICE; THIRD_PARTY_NOTICES.txt (every npm package; the build stops on a
missing, UNKNOWN or proprietary licence), node/LICENSE, daemon/LICENSE + NOTICE, pi/LICENSE,
herdr/LICENSE + NOTICE (crate list: `build/herdr-crates.mjs`), licences/libheif-NOTICE (LGPL-3.0),
the ONNX Runtime notice when sherpa-onnx is in, and the licence folders packages carry. The build
also stops when a part (node, daemon, pi, herdr, optchat, bots, apns) has no LICENSE file, and
leaves out pi's DOOM example (GPL-2.0). Regenerated on every build by `build/notices.mjs`; tests:
`node --test test/notices.test.mjs`.
