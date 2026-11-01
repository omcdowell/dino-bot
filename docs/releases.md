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

## What a release contains

Every target has two archives of the same tree: `dinobot-<os>-<arch>.tar.zst` (zstd -19
--long=27) and `dinobot-<os>-<arch>.tar.gz`, each with its own `.sha256` and `.sigstore.json`.
`install.sh` takes the `.tar.zst` when the computer has `zstd` (Ubuntu and Fedora desktops,
Homebrew), else the `.tar.gz` (`DINOBOT_FORMAT=gz` forces it); a release without a `.tar.zst` falls
back to the `.tar.gz`. `dinobot update` fetches the same kind the install got (`state.json`
`tarballFormat`) and unpacks a `.tar.zst` with the bundled Node's zstd, so it needs no `zstd`.

`cosign-<os>-<arch>.zst` / `.gz` are sigstore's cosign binaries (the version pinned in
`lib/signing.json`), compressed by the release job (`build/cosign-assets.sh`): a first install
fetches them by the tarball's route instead of the raw binary (Linux x64: 51/60 MB instead of
146 MB) and checks the same pinned sha256 on the unpacked file. Without them it falls back to
sigstore's release.

What makes the archives small (`build/build-tarball.sh`): `build/prune-stage.mjs` drops source maps,
type declarations, package READMEs/changelogs and unreferenced `src`/`test` folders from every
`node_modules` tree (licences, entry points, pi skills, `typescript`, npm and node-gyp stay;
`PRUNE=0` keeps all). The Node binary is left byte-identical to nodejs.org's; `STRIP_NODE=1` strips
the Linux one of its symbol table (about 18 MB, 4 MB compressed). linux-x64, 31 Oct: 173.5 MB
`.tar.gz` before; 139.4 MB `.tar.gz` and 98.6 MB `.tar.zst` after, with stripping (so about 4 MB
more per archive with the default).

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
   `build/sources.json` (`build/ci-build.sh`); adds the compressed cosign binaries
   (`build/cosign-assets.sh`); signs every file with `cosign sign-blob` (only the release job
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
