# Build and test

```sh
build/build-tarball.sh                         # -> dist/dinobot-<os>-<arch>.tar.gz and .tar.zst (+ .sha256 each, stamped dist/install.sh)
HERDR_BIN=<mac herdr> build/build-tarball.sh --target darwin-arm64   # cross-assembled on Linux
node --test test/*.test.mjs                    # unit + install.sh tests (temp dirs inside the repo)
test/e2e-temp-home.sh found|nosignin|tty|longhome|notailscale        # throwaway HOME (UPDATE=1: real update too)
test/run-mac-e2e.sh                            # copies to a Mac (ssh host "mac"), installs in /tmp under launchd, removes all
```

`test/public-tree.test.mjs` fails if the repo would not be fit to publish: a friend-test page
(`FRIEND-SETUP.md`), a Tailscale address outside the test blocks, or this computer's own tailnet
addresses, host name or home path (`build/public-check.mjs`; extra private patterns can be kept
outside the repo in `~/.config/dinobot/private-patterns.txt`).

## Layout

| Path | What |
|---|---|
| `install.sh` | the one-line installer (downloads, verifies, unpacks, starts the wizard) |
| `lib/` | the wizard and the `dinobot` command (`cli.mjs`, `flow.mjs`, `service.mjs`, `update.mjs`, …) |
| `lib/product.json`, `lib/signing.json` | product names; release signing |
| `lib/phone-signin.mjs` | phone onboarding, host side (loaded by the bots plugin through `DINOBOT_HOME`) |
| `build/` | tarball build, CI build, notices, preflight, publish |
| `addons/paseo-apns/` | the optional push add-on (plugin id `apns`), files only; shipped off, `dinobot push enable` turns it on (`lib/push.mjs`, [Live Activities and push](live-activities.md)) |
| `test/` | `node --test` suites and end-to-end scripts |
| `demo/` | end-to-end demo kit (not part of the published repo) |

## The Claude Agent SDK

It is proprietary, so it is not in the tarball: a placeholder answers the daemon's import, and
`dinobot claude-code install` fetches the real one from npm on the user's computer
(integrity-checked).

## Tarball guard

`build/private-guard.sh` refuses a tarball that names a private part anywhere (README files, docs and
node_modules included). The names are not in this repo: they come from `DINOBOT_PRIVATE_GUARD` (a CI
secret) or `~/.config/dinobot/private-guard.txt`. Without patterns it warns and passes, except under
`build/preflight-release.sh`, which requires them.
