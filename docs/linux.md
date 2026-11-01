# Linux

Targets `linux-x64` and `linux-arm64` (glibc; Node's official binaries; no musl/Alpine). Tested on
clean Ubuntu 24.04, Debian 12 and Fedora 44 containers, with and without systemd, as a plain user,
with no Node installed; linux-arm64 under qemu.

## Needs

`curl` (the install line), `ps` (procps / procps-ng: the daemon stops bot processes with it;
`install.sh` stops and names the package when it is missing), `tar`/`gzip`, `bzip2` for the voice
models, and `git` (without it every bot turn ends with "Local checkpoint failed: spawn git ENOENT";
`dinobot doctor` warns about both).

- Ubuntu/Debian: `sudo apt install curl procps bzip2 git`
- Fedora: `sudo dnf install curl procps-ng bzip2 git`

The installer itself never uses sudo.

## Services

- **With systemd** (`/run/systemd/system` exists): systemd **user** units in
  `~/.config/systemd/user` (`dinobot.service`, `dinobot-herdr.service`,
  `dinobot-herdr-gc@paseo-bots.timer`), enabled, `Restart=always`. Logs: `journalctl --user -u dinobot`.
  Setup tries `loginctl enable-linger $USER` (polkit must allow it; desktops usually do). If refused,
  the summary says to run `sudo loginctl enable-linger <user>` once. Without linger the units stop at
  logout and start at the next login; with linger they start at boot with nobody logged in.
- **No systemd** (WSL without systemd, containers, `--service none`): detached processes, pids in
  `~/.dinobot/pids.json`, log `~/.dinobot/logs/daemon.log`. They survive logout but not a reboot:
  the summary and `doctor` say to run `~/.dinobot/bin/dinobot start` (dinobot is not put on PATH).

## Uninstall

`dinobot uninstall [--purge]`: the systemd units are disabled, stopped and deleted, then
`daemon-reload` + `reset-failed`. Left on purpose: `~/bots`, `~/.optchat`,
`~/.local/state/bot-rooms` (group chats) and herdr's own `~/.config/herdr` and
`~/.local/state/herdr`. Linger is not turned off.

## Tailscale

Required, as on macOS: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.
The daemon listens on the tailnet address only; with `ufw` on: `sudo ufw allow in on tailscale0`.

## Desktop app

`DinoBot-x86_64.AppImage` needs FUSE 2 (`libfuse2t64` / `libfuse2` / `fuse-libs`) or
`--appimage-extract-and-run`. electron-builder's AppImage launcher starts it with `--no-sandbox`, so
Ubuntu 24.04's user-namespace restriction does not stop it. `dinobot://` links open in the app only
once a `.desktop` file with `MimeType=x-scheme-handler/dinobot` is registered; pairing does not need
that ("Paste pairing link").
