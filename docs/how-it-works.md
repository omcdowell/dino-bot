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
| download one prebuilt tarball | `install.sh` | Node, daemon (a modified Paseo), pi, OptChat, bots plugin, herdr. No `npm install`. Flaky networks: short connect timeouts, a stalled transfer is dropped and retried, up to 6 tries each resuming where the last stopped; a download that still fails keeps its part, and running the same command again carries on from there. |
| "What should your bots call you?" | `install.sh`, during the download | First install only; pre-filled from the OS account (`id -F` / GECOS). Running the install command again keeps the saved name. |
| detect sign-ins, Tailscale, addresses | wizard | pi `auth.json`, `*_API_KEY` env, Codex CLI login (pre-selects ChatGPT; never copied: refresh-token rotation). |
| write config | wizard | Own `PASEO_HOME` (`~/.dinobot/paseo`), relay off, listens on the **tailnet address only** (`<tailnet IP>:<free port from 6767>`), password in `~/.dinobot/daemon.env` (600). `~/bots/.settings.json` with your name, escalation target and default model. |
| starter coordinator bot | wizard | On by default; untick it in the extras checklist (it moves to `~/bots/.trash`). |
| start services | wizard | systemd user units (+ linger, never sudo) or launchd agents; no systemd (or `--service none`): detached processes. See [Linux](linux.md). |
| Tailscale check | wizard | **Required.** Missing, off or logged out: setup stops before starting anything, prints the steps for your OS and the command to finish. No LAN mode. |
| **QR** | wizard | Printed once the daemon **accepts app connections**, so the first connect works. After it, only what needs you (the PATH line, missing `git`/`bzip2` on Linux, a sleeping laptop) and the done line; addresses, timings and details with `setup --verbose` (and in `~/.dinobot/state.json`). The direct offer `dinobot://pair/#offer=…` carries the MagicDNS name, the tailnet IP, the password and the daemon key; the app sends the password only inside the end-to-end encrypted channel keyed to that key. |
| sign-in | wizard or phone | Only if nothing was found. pi's own device-code / paste-code logins or an API key. The Claude login is labelled "billed as extra usage". |
| extras | wizard | One checklist: starter bot [x], import past chats [ ] with an estimate. Import runs in the background. |
| herdr for workers | services | Its own session `paseo-bots` (`dinobot-herdr.service`) and a daily cleanup timer. |

Model choice is never asked: each subscription has a default (pi-optchat `src/model-defaults.ts`).

The setup order is one constant, `lib/flow.mjs SETUP_FLOW`: sign-in and chat import happen on the
phone by default; `"terminal"` moves them back into the wizard, and `setup --signin-here` does it
for one run. At a terminal, setup shows the Tailscale steps and carries on by itself once Tailscale
is up (20 minute limit).

## Commands

`dinobot setup [--verbose] | pair [--link] | status | doctor [--json] | update [--check] [--tarball F|--url U] | start | stop | uninstall [--yes] | uninstall --purge [--yes] | import-status | herdr-gc | claude-code install | claude-code install-cli`

`dinobot` alone (or `dinobot help`) lists the commands; setup runs only as `dinobot setup`.

**To update, run `dinobot update`** (or the install command again; both keep sign-ins, pairing and
bots). `dinobot uninstall` is not a step of updating: it removes the sign-ins and the pairing (the
phone scans a new code after a reinstall), so it says so and asks first.

On Windows (WSL 2, [untested](windows.md)) also `wsl-autostart [--off]`.

Push notifications and Live Activities are off unless you turn them on with
`dinobot push enable` (they need an iPhone app you build with your own Apple developer account):
`push [status] | enable | disable | test`, see [Live Activities and push](live-activities.md).

- `doctor`: install, daemon service/listening/ready/password, herdr session, cleanup timer,
  sign-ins, `auth.json` mode, Claude Code (optional: installed, logged in), Tailscale, listen address, reach every QR address, macOS developer
  tools, versions. A plain `fix:` line under each problem; exit 1 on any FAIL.
- `update`: compares the release's `.sha256` with the installed build first (up to date: nothing
  is downloaded), else download (progress line; resumes after a dropped connection, also in the
  next `update`) + sha256 + signature check, unpack beside the app, swap, then the **new**
  version's post-update step (`dinobot post-update`: wrappers, service files, the `~/.local/bin`
  link, saved settings), restart the daemon only (workers keep running). It rolls back if that
  step fails or the daemon does not become ready. Prints old -> new version. Config, password,
  bots and sign-ins are untouched. `DINOBOT_RELEASE=<tag>` picks one release instead of the latest.
- `pair --link` prints the pairing link (for "Paste pairing link" in the desktop app).
- `claude-code install` fetches the Claude Agent SDK from npm on your computer (integrity-checked);
  it is proprietary, so it is not in the tarball.
- `claude-code install-cli` installs the `claude` CLI with Anthropic's own native installer
  (`curl -fsSL https://claude.ai/install.sh | bash`, as you, no sudo; it lands in `~/.local/bin`),
  then prints the login step. The app's "Install Claude Code" button runs the same installer and
  then starts the Claude Code login by itself. DinoBot never ships the Claude Code binary.

Flags: `--yes` (defaults, no questions), `--answers '{"extras":"coordinator"}'`,
`--service systemd|launchd|none`, `--port`, `--no-herdr`, `--verbose`. `DINOBOT_PORT` picks the port.
`DINOBOT_TAILNET_ADDRESS=<ip>[,<name>]` gives the Tailscale address to listen on instead of asking
a Tailscale CLI (a Mac shared with your Tailscale account). `DINOBOT_TAILSCALE_BIN` /
`DINOBOT_TAILSCALE_SOCKET` pick the Tailscale CLI and its daemon's socket (a userspace tailscaled of
your own: the daemon then listens on `127.0.0.1` with `PASEO_TRUST_LOOPBACK=false`, so connections
from `127.0.0.1` must also be end-to-end encrypted unless they carry the daemon's local credential).
Those four are saved in `~/.config/dinobot/install.env` (mode 600) once setup has worked with them,
and every later `dinobot` command and reinstall reads them (the environment wins); plain
`uninstall` keeps the file, `uninstall --purge` deletes it. See [Two people on one Mac](shared-mac.md).

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
