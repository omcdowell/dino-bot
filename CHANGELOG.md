# Changelog

## v0.1.5

### Faster, much smaller sync

- **Opening a chat sends far less.** Connecting, opening a chat and one reply used to move about
  129 KB between the computer and the phone; now about 3.6 KB. The bot list on a fresh start went
  from about 16 KB to about 3 KB. Long tool output and message bodies come when you open them.
- **The app opens from its cache first.** A chat you saw before (or the one a notification points
  to) shows at once from the phone's cache; the live state replaces it as soon as it arrives.

### Install

- **The installer says what it is doing.** The first line shows before any check, each step gets
  its own line, and the name question says the download is already running.
- **Plainer Tailscale steps** in the installer and the README (a three-step Quick start), and a
  short guide for two people on one Mac, each with their own Tailscale (`docs/shared-mac.md`).

### Bugs fixed

- **Restarts and updates no longer log the phone out.** The daemon kept the phone's sign-in
  (session token) in memory only, so every restart or `dinobot update` dropped it and the phone
  had to fall back to its saved password, or pair again. Session tokens now survive a restart
  (`session-tokens.json` in the daemon's home, mode 600, no token secrets in it). They still
  expire, and a password change still ends them.
- **The password hash stays the same across restarts.** With `PASEO_PASSWORD` in `daemon.env`
  the daemon used to hash it with a new salt at every start, which also ended every sign-in. It
  now keeps the hash (`daemon-password-hash`, mode 600) until the password changes.
- **`dinobot update` checks the pairing identity.** Before the restart it checks that the daemon
  key, server id, address, password and session-token key are unchanged. If one changed, it stops,
  puts the previous version back and does not restart. It checks again after the restart.

## v0.1.4

- **Shared Mac, own tailnet.** Each macOS account can run its own userspace `tailscaled` and point
  setup at it, so two people on one Mac each keep their own tailnet (README, "Second person
  on the same Mac").
- **`PASEO_TRUST_LOOPBACK`.** With a userspace `tailscaled` DinoBot listens on `127.0.0.1`, so the
  installer sets `PASEO_TRUST_LOOPBACK=false` there: other accounts on the same computer must pair
  like any other device. Default (unset or `true`) keeps the old behaviour.
- **Install URL.** `curl -fsSL https://omcdowell.github.io/dino-bot/install | sh` now serves the
  installer script (it fetches the latest release's signed `install.sh`) instead of an HTML page.
- Builds from this repo's in-tree folders (`paseo/`, `plugins/bots/`, `optchat/`,
  `addons/paseo-apns/`).

## v0.1.3

- First public release.
