# Changelog

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
