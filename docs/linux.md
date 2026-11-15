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
  the summary and `doctor` say to run `dinobot start` (the full path `~/.dinobot/bin/dinobot start`
  when `~/.local/bin` is not on your PATH).

## The `dinobot` command

Setup (and every `dinobot update`) links `~/.local/bin/dinobot` -> `~/.dinobot/bin/dinobot`,
creating `~/.local/bin` if needed. Only `dinobot` is linked: `paseo`, `herdr`, `pi` and the other
wrappers stay in `~/.dinobot/bin`, so your own tools of those names are never shadowed. If
`~/.local/bin/dinobot` already exists and is not DinoBot's link, it is left alone and setup says
so; use the full path then. A stale DinoBot link is re-pointed. DinoBot never edits `~/.bashrc`,
`~/.profile` or any other shell file. If `~/.local/bin` is not on your PATH, setup prints the one
line to add, for bash:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

then open a new terminal. (Ubuntu's and Debian's default `~/.profile` already adds `~/.local/bin`
when it exists, from your next login.) Until then, and in scripts, `~/.dinobot/bin/dinobot` always
works. `DINOBOT_NO_PATH_LINK=1` skips the link (for test installs that share a home folder with a
real one).

## Uninstall

To update, run `dinobot update` (or the install command again): no need to uninstall.

`dinobot uninstall` first says what goes and asks `[y/N]` (`--yes` skips it; without a terminal and
without `--yes` it refuses). Then the systemd units are disabled, stopped and deleted (then `daemon-reload` +
`reset-failed`), herdr's socket folder goes, and so does all of `~/.dinobot`: the app, your AI
sign-ins (`~/.dinobot/pi/auth.json`), the daemon password and key. Kept: your bots (`~/bots`),
memories (`~/.optchat`), group chats (`~/.local/state/bot-rooms`), herdr's own `~/.config/herdr`
and `~/.local/state/herdr`, and saved install settings (`~/.config/dinobot/install.env`). After a
reinstall you sign in again and your phone scans the new code. `~/.local/bin/dinobot` is removed only if it is DinoBot's symlink
(pointing into `~/.dinobot`); `~/.local/bin` itself always stays. Linger is not changed.

`dinobot uninstall --purge`: full wipe. Everything above, plus `~/bots`, `~/.optchat`,
`~/.local/state/bot-rooms`, `~/.local/state/bot-dm` (bot messages, worker registry),
`~/.config/herdr`, `~/.local/state/herdr` and `~/.config/dinobot/install.env` (`PASEO_BOTS_ROOT` and `OPTCHAT_HOME` are honoured;
`PASEO_BOTS_ROOMS`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME` only when inside your home folder). It first lists the exact paths with their
sizes and asks you to type `DELETE`; `--yes` skips the question (scripts). Without a terminal and
without `--yes` it refuses. It never deletes your home folder, `/` or a folder above home (the whole
uninstall stops if a path resolves to one), and symlinks are removed as links, never followed.
Linger is turned off (`loginctl disable-linger`, no sudo) only if setup turned it on; if it is on
and setup did not record turning it on, the command is printed instead.

On WSL both forms also undo `dinobot wsl-autostart` (the Windows Startup script and the
`.wslconfig` line). On macOS the launchd agents are booted out and their plists in
`~/Library/LaunchAgents` deleted (user agents only; nothing needs sudo).

## Tailscale

Required, as on macOS: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.
The daemon listens on the tailnet address only; with `ufw` on: `sudo ufw allow in on tailscale0`.

## Desktop app

`DinoBot-x86_64.AppImage` needs FUSE 2 (`libfuse2t64` / `libfuse2` / `fuse-libs`) or
`--appimage-extract-and-run`. electron-builder's AppImage launcher starts it with `--no-sandbox`, so
Ubuntu 24.04's user-namespace restriction does not stop it. `dinobot://` links open in the app only
once a `.desktop` file with `MimeType=x-scheme-handler/dinobot` is registered; pairing does not need
that ("Paste pairing link").
