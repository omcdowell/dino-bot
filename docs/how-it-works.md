# How the installer works

One command on your Mac or Linux computer installs everything, then prints a QR code for the
DinoBot app.

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

Product names live in one place, `lib/product.json`: display name **DinoBot**, command and folder id
`dinobot`, Expo project `@dino-bot/dino-bot`, release repo `omcdowell/dino-bot`. The pairing link
scheme comes from the name (`dinobot://pair`), as in the app.

## What happens

| Step | Who | Notes |
|---|---|---|
| download one prebuilt tarball | `install.sh` | Node, daemon (a modified Paseo), pi, OptChat, bots plugin, herdr. No `npm install`. |
| "What should your bots call you?" | `install.sh`, during the download | Pre-filled from the OS account (`id -F` / GECOS). |
| detect sign-ins, Tailscale, addresses | wizard | pi `auth.json`, `*_API_KEY` env, Codex CLI login (pre-selects ChatGPT; never copied: refresh-token rotation). |
| write config | wizard | Own `PASEO_HOME` (`~/.dinobot/paseo`), relay off, listens on the **tailnet address only** (`<tailnet IP>:<free port from 6767>`), password in `~/.dinobot/daemon.env` (600). `~/bots/.settings.json` with your name, escalation target and default model. |
| starter coordinator bot | wizard | On by default; untick it in the extras checklist (it moves to `~/bots/.trash`). |
| start services | wizard | systemd user units (+ linger, never sudo) or launchd agents; no systemd (or `--service none`): detached processes. See [Linux](linux.md). |
| Tailscale check | wizard | **Required.** Missing, off or logged out: setup stops before starting anything, prints the steps for your OS and the command to finish. No LAN mode. |
| **QR** | wizard | Printed once the daemon **accepts app connections**, so the first connect works. The direct offer `dinobot://pair/#offer=…` carries the MagicDNS name, the tailnet IP, the password and the daemon key; the app sends the password only inside the end-to-end encrypted channel keyed to that key. |
| sign-in | wizard or phone | Only if nothing was found. pi's own device-code / paste-code logins or an API key. The Claude login is labelled "billed as extra usage". |
| extras | wizard | One checklist: starter bot [x], import past chats [ ] with an estimate. Import runs in the background. |
| herdr for workers | services | Its own session `paseo-bots` (`dinobot-herdr.service`) and a daily cleanup timer. |

Model choice is never asked: each subscription has a default (pi-optchat `src/model-defaults.ts`).

The setup order is one constant, `lib/flow.mjs SETUP_FLOW`: sign-in and chat import happen on the
phone by default; `"terminal"` moves them back into the wizard, and `setup --signin-here` does it
for one run. At a terminal, setup shows the Tailscale steps and carries on by itself once Tailscale
is up (20 minute limit).

## Commands

`dinobot pair [--link] | status | doctor [--json] | update [--check] [--tarball F|--url U] | start | stop | uninstall [--purge] | import-status | herdr-gc | claude-code install`

On Windows (WSL 2, [untested](windows.md)) also `wsl-autostart [--off]`.

- `doctor`: install, daemon service/listening/ready/password, herdr session, cleanup timer,
  sign-ins, `auth.json` mode, Tailscale, listen address, reach every QR address, macOS developer
  tools, versions. A plain `fix:` line under each problem; exit 1 on any FAIL.
- `update`: download + sha256 + signature check, unpack beside the app, swap, restart the daemon
  only (workers keep running), roll back if it does not become ready. Config, password, bots and
  sign-ins are untouched. `DINOBOT_RELEASE=<tag>` picks one release instead of the latest.
- `pair --link` prints the pairing link (for "Paste pairing link" in the desktop app).
- `claude-code install` fetches the Claude Agent SDK from npm on your computer (integrity-checked);
  it is proprietary, so it is not in the tarball.

Flags: `--yes` (defaults, no questions), `--answers '{"extras":"coordinator"}'`,
`--service systemd|launchd|none`, `--port`, `--no-herdr`. `DINOBOT_PORT` picks the port.

## pi

DinoBot has its own pi folder, `~/.dinobot/pi` (sign-ins, settings, packages). The daemon, every bot
and the herdr workers use it (`PI_CODING_AGENT_DIR`), so one sign-in covers all of them. An existing
`~/.pi` is never written: API keys found there are copied in; OAuth logins are not (token rotation)
and only pre-select that provider. Default package: `npm:pi-web-access`, bundled in the tarball.

A provider plugin that replaces pi's `anthropic` provider is detected generically
(`lib/provider-overrides.mjs`); the Claude login then reads "your plan, via <the plugin's own name>"
(unofficial) instead of EXTRA USAGE. The tarball also carries npm (so pi can install provider
plugins on a Mac without npm) and pinned rg/fd (pi's tools).

## Odd corners

- herdr: if herdr's socket path under HOME would not fit a unix socket (HOME longer than about 56
  characters), `~/.dinobot/bin/herdr` points its sockets at `$XDG_RUNTIME_DIR` (Linux) or the
  per-user temp folder (macOS).
- macOS: a `~/.dinobot/bin/git` guard (first on the daemon's PATH) avoids the "install developer
  tools" dialog on a fresh Mac.
- Sign-in: Codex uses a device code and Claude a copy code (never a localhost browser callback).
- Services use `Restart=always`.
