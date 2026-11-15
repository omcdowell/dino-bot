# Changelog

## v0.1.10

### The pairing QR picture is gone within 10 minutes, whatever happens

- Setup saves a picture of the pairing QR (`~/.dinobot/pairing-qr.png`, for terminals that draw
  the code with gaps). It holds your computer's pairing password, and it used to stay on disk
  unless the phone finished signing in while setup was still waiting. Now it is removed:
  when the app is signed in; when setup's 10-minute wait ends; when setup fails; on Ctrl-C, when
  setup is stopped, or when the terminal or SSH session closes; and, if setup itself was killed,
  by a small background helper at 10 minutes. After a reboot or a sleeping Mac, the DinoBot server
  removes any picture older than 10 minutes when it starts and once a minute. `dinobot doctor`
  reports and removes a stale one. `dinobot pair` shows a fresh code any time.
- Removing the picture does not change the password: a phone already paired stays paired.

### Claude Code users get "Your bots are ready"

- Setup's terminal now counts a Claude Code login (the same check as Settings › Providers ›
  Claude Code) once the app has paired and opened its sign-in step, so a Claude-Code-only setup
  sees "✓ Signed in from the app (Claude Code)" and "Your bots are ready" instead of waiting
  forever. A Claude Code login that was already on the computer does not count before the phone
  pairs.

### First-run steps in the app

- **Back on "Sign in for your bots" goes to the welcome screen**, which now offers "Continue
  setup", instead of bouncing straight back to sign-in (after an in-app scan) or leaving setup
  for good (after a pasted or tapped link).
- A failed in-app QR scan shows the same Tailscale help as a failed pairing link.
- The "Paste pairing link" field shows DinoBot's own link (`dinobot://pair/#offer=…`), not
  paseo.sh's.
- The app changes ship with the next iOS build.

## v0.1.9

### Claude Code first when you set up

- **Sign in for your bots starts with Claude Code** ("Uses your Claude Pro/Max plan"): Claude
  Code's own login, run by your computer, the same as Settings › Providers › Claude Code. pi's
  sign-ins follow; "Claude login (extra usage)" is last and now says plainly that it is billed per
  token on top of any Claude plan you pay for.
- **One button installs Claude Code, then logs you in.** When your computer has no `claude` yet,
  the card's button is "Install Claude Code": your computer runs Anthropic's own installer
  (`curl -fsSL https://claude.ai/install.sh | bash`, as you, no sudo; it lands in `~/.local/bin`),
  then the Claude Code login starts by itself. The app shows the steps (installing, log in, done)
  and "Try again" if something fails. The same button is on Settings › Providers. DinoBot never
  ships the Claude Code binary. In the terminal: `dinobot claude-code install-cli`.
- `dinobot doctor` says whether Claude Code is installed and logged in (optional, never a failure).

### No more getting stuck in the app's first-run steps

- **Choose models with nothing to choose** (no sign-in yet) shows "No models yet: sign in" with
  Sign in and Skip for now, instead of a disabled Continue. Sign in has a visible "Skip for now",
  and its Back button no longer jumps forward.
- **Settings › your computer › Providers › Bot models**: the models for bots, compaction and
  workers, any time after setup.
- The past-chats import step is skipped when there is nothing to import, and no longer shows a
  developer-only `~/scratch` option. Plainer words ("Workers"), and the install command on the
  welcome screen can be sent to your computer with Share (AirDrop, Messages…).
- iOS build 0.1.3 (12).

### Update, uninstall, reinstall

- **`dinobot update` is instant when you are up to date.** It compares the release's checksum
  first and downloads nothing (it used to fetch the whole 100-140 MB tarball, minutes on slow
  Wi-Fi, just to say "already up to date"). A real update shows a progress line and ends with the
  versions: `Updated DinoBot 0.1.8 -> 0.1.9`.
- **The new version finishes its own update.** After the swap, `update` runs the new version's
  post-update step (wrappers, services, the `~/.local/bin` link, saved settings) and rolls back if
  it fails. No more "run update a second time" (from the update after v0.1.9 on; the update to
  v0.1.9 itself still runs the old updater).
- **`dinobot uninstall` asks first** and says what goes: your AI sign-ins and the phone's pairing
  (after a reinstall you sign in again and scan a new code). Your bots and memories stay. It also
  says: to update, run `dinobot update`, no need to uninstall. `--yes` skips the question; without
  a terminal it needs `--yes`.
- **Shared-Mac settings survive.** `DINOBOT_TAILNET_ADDRESS`, `DINOBOT_TAILSCALE_BIN`,
  `DINOBOT_TAILSCALE_SOCKET` and `DINOBOT_PORT` are saved in `~/.config/dinobot/install.env`
  (mode 600) once setup works with them; every command and a reinstall read them. Plain uninstall
  keeps the file, `--purge` deletes it.
- **New shared-Mac route without a second Tailscale**: the owner shares the Mac with your Tailscale
  account, and `DINOBOT_TAILNET_ADDRESS=<the Mac's Tailscale IP>` replaces the stand-in script.
  The safety stop names both routes, links the guide, and prints the exact command to finish
  (`~/.dinobot/bin/dinobot setup`, nothing downloaded again).

### Install

- **Flaky networks**: every download has a short connect timeout, drops a stalled transfer, and
  retries up to 6 times, each try resuming where the last stopped. If it still fails, run the same
  install command again: it carries on from there. The signature checker's download shows its size.
- **The name is asked on the first install only**; running the install command again keeps it.
- **A quieter end of setup**: the QR, then only what needs you (the PATH line, `git`/`bzip2`
  missing on Linux, a Mac laptop that sleeps) and the done line. Addresses, timings and details:
  `dinobot setup --verbose` (and `~/.dinobot/state.json`).
- **`dinobot` alone prints the help** (it used to run setup again, with a new QR and a restart).
- Linux: while setup waits for Tailscale, it says to paste the Tailscale command into a **new**
  terminal window.
- Removed: the `--tailscale-embed` flag (it only printed "not built yet").

## v0.1.8

### The `dinobot` command is on your PATH

- **Setup links `~/.local/bin/dinobot`** to `~/.dinobot/bin/dinobot`, so you can type `dinobot pair`,
  `dinobot doctor` and so on instead of the full path. It creates `~/.local/bin` if needed and
  links only `dinobot` (not `paseo`, `herdr`, `pi` or `git`, so your own tools are never shadowed).
  Running setup again, or `dinobot update`, keeps the link and repairs it if it is stale.
- **A `~/.local/bin/dinobot` that is not DinoBot's is left alone.** Setup says so and keeps going;
  use `~/.dinobot/bin/dinobot` then.
- **No shell files are edited.** If `~/.local/bin` is not on your PATH, setup prints the exact one
  line to add for your shell (`~/.zshrc` for zsh, the Mac default; `~/.bashrc` for bash, the Linux
  default), and until then shows later commands with their full path.
- **Uninstall** (plain and `--purge`) removes `~/.local/bin/dinobot` only if it is DinoBot's link
  into `~/.dinobot`. The `~/.local/bin` folder always stays.
- Existing installs: the update to v0.1.8 runs the old updater, which does not know the link.
  Run `~/.dinobot/bin/dinobot update` once more afterwards: it says "already up to date" and adds
  the link (and the PATH line, if needed). `DINOBOT_NO_PATH_LINK=1` skips the link.

The iPhone app is unchanged (build 11).

## v0.1.7

### Uninstall (changed, read this before you run it)

- **`dinobot uninstall` now also removes your sign-ins.** It stops and removes the services and
  deletes all of `~/.dinobot`, including `pi/auth.json` (what `--purge` did before). Your bots and
  their memories (`~/bots`, `~/.optchat`, bot rooms) are kept, and it prints the command to
  delete them by hand.
- **`dinobot uninstall --purge` now deletes your bots and their memories too.** It is a full wipe:
  `~/.dinobot`, `~/bots`, `~/.optchat`, bot rooms, worker messages and herdr's state. It lists
  every path with its size and asks you to type `DELETE` (`--yes` skips the question; with no
  terminal and no `--yes` it refuses). It never deletes your home folder or anything above it,
  and never follows symlinks. Your own `~/.pi` and `~/.claude` are not touched.
- Both modes also remove the Windows start-up entry on WSL. `--purge` turns systemd linger off
  only if DinoBot's setup turned it on.

### App

- **Sign-in page.** Settings → Providers shows two engines: the pi card (each sign-in, ready or
  not, API keys shown only as prefix…last 4; sign in, sign in again, sign out) and the Claude
  Code card (login, plan, version, which bots use it; log in and log out).
- **Only OptChat providers.** On a DinoBot computer Paseo's own agent providers are turned off
  and the app shows only Bot sign-ins there. A provider a schedule still uses is left on.
- **Schedules: systemd timers work.** The timers section lists your user timers (with their
  description as the title) and can pause or resume one. System timers hide behind
  "Show all (+N system)".
- **Crash fix.** react-native-reanimated 4.3.4 fixes an iOS crash seen in TestFlight builds.
- **Folder links open as folders.** Tapping a `~/` folder link (`~/bots`) opens it in Files, or
  lists the folder in the tab, instead of "Requested path is not a file".

### Workers

- **Workers use the bots' pi sign-ins.** A pi worker gets the same pi folder as the bots, so a
  sign-in on the Providers page reaches workers too.
- **Claude Code workers.** `launch.sh --engine cc` starts a worker in Claude Code with a slim
  tool set and the workers' skill shortlist. The worker's budget is advisory, as for pi: the
  status line shows what it spent (and the budget, if the brief gives one); nothing blocks it.

### Voice

- **sherpa-onnx 2.0.1.** Kokoro reads with its lexicon (no espeak-ng); Parakeet retries once
  when it returns nothing for clear speech.

## v0.1.6

### Bots

- **Workers for every bot.** A bundled `workers` skill shows each bot how to hand a self-contained
  job to a helper agent in a terminal tab (brief, launch, steer, check, resume, close). Workers
  it starts get a short bundled skill list (`diagnose`, `tdd`, `screenshot-app`, `herdr`) and no
  other skills; `WORKER_SKILLS=<path>[:<path>]` adds some, `WORKER_SKILLS=none` drops the list.
  Third-party skills ship with their licences (see `plugins/bots/NOTICE`).
- **One shared bot prompt.** The how-to-act text (bot-dm, workers, rooms, house rules) is now one
  "DinoBot bot" section rendered per bot at run time. A bot's AGENTS.md holds only its own text:
  the old bot-dm block is removed at start (a backup is kept next to the file).
- **Skills per bot.** Bots see only the skills you allow: one shared list in
  `~/.optchat/skills.json` (default: `herdr` and `workers`), overridable per bot; any skill can be hidden.
- **Smaller prompts.** Web tool declarations are slimmer, imported-history guidance is sent only
  when memory holds imported history, and a compaction on another model sends its own short prompt.

### App

- **Add providers from the phone.** Settings → Providers lists, installs and removes providers on
  your computer; a provider link opens there. Installing a provider runs its code on your
  computer, so only add providers from people you trust.
- **Edit on a pending message keeps its text.**
- **Dictation.** Messages typed with the dictation button are marked as dictated for the bot.
  Voice mode off adds nothing.

### Install and sign-in

- **Sign-in asks once.** Picking a provider no longer shows the menu again;
  `dinobot signin [provider]` and `dinobot signin --list`.
- **Readable setup QR code** (pure black and white, plus a PNG on a Mac, removed after sign-in).
- **Download progress bar** in the installer.

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
