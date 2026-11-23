# Changelog

## v0.1.17

### Chat

- Usage (the Settings card and the sidebar) keeps the last reports from each computer and shows
  them offline or on a cold start, with their Updated time. The provider list is read from the
  copy on disk until a live one loads.
- While the computer is not connected, an open turn is shown as last known: no timer or working
  indicator, and the composer shows a plain Send.
- Bot DMs are pushed to the app by the host instead of polled every 10 to
  30 seconds, so new messages and delivery statuses show at once. An older host is still polled.

### Fixed

- A message you sent no longer stays pinned at the bottom of the chat, under every later reply,
  when you come back after more than a page of new messages. The host now tells the app where
  the message's row is; with an older host the app settles it when every loaded row is newer.
- Claude Code bots: every user message in replayed history, and messages kept through a host
  restart, carry the app's message ID, so the app matches them to what you sent.
- A photo sent over a slow uplink no longer times out at 60 seconds and restarts from the first
  byte: the upload waits as long as the photo needs to drain.
- A pending message whose last attempt failed shows "Retrying: <error>" while the computer is
  connected, so a message stuck in a resend loop no longer looks like one on its way.

## v0.1.16

### Chat

- The attach menu takes videos from your library (uploaded to your computer as files, up to
  200 MB) and Take photo (camera). The bot gets a video's saved path, type and duration, so it
  can pull frames; a Claude Code bot gets an uploaded file's path.
- Files you send show as chips (icon, name, size) and stay on your message, also when the chat is
  read back from the bot's history; tap a chip to download the file again. Long names are
  shortened so the extension shows.
- Images in the chat (yours, tool images and images in replies) show whole in a box sized to the
  image instead of being cropped. Long-press one, or use the full-screen view, to save it to
  Photos or share it.

### Desktop

- The desktop app checks the public release at most every 6 hours and shows "New version
  available" with a download for this computer; dismissed per version.
- On macOS, `dinobot update` says when the installed desktop app is older than the new release,
  with the release page link.

### Fixed

- Many large photos no longer freeze the app or loop on "Reconnecting": photos are scaled down,
  uploaded one by one ahead of the message (with progress) and a retry sends only the rest. An
  older host gets photos inline as before, and a message too big for it fails at once with a note
  to update the host.
- A computer whose bots already work (its own Claude login or a proxy that holds it) is not asked
  to sign in again after pairing again; Settings shows "Your proxy holds the login" for a proxy.
- Claude Code bots: a stopped message that Claude Code put back in its input box is cleared before
  the next one, so the two are no longer sent as one; a step's text stays whole before the tool
  call that follows it.
- Usage shows one Claude card per computer: the Claude Code card stands in for the Claude sign-in
  card.

## v0.1.15

### Pi and Claude Code only

- Bots and workers run on pi or Claude Code. The other coding agents the app could start (Codex,
  OpenCode, OMP, the ACP agents and the Claude Agent SDK agent) are removed, with
  `dinobot claude-code install` (it fetched that SDK). `dinobot claude-code install-cli` stays.
- Old pages the app no longer used are removed.

### Claude Code bots

- A running Bash command's output shows in the chat while it runs.
- `/skill:<name>` and `/compact` work as on a pi bot.
- The app's session list, rewind and the `/optchat` profile tools work on a Claude Code bot's
  OptChat profile.
- A new chat opens with the bot's history.
- A bot's model list is rebuilt when its engine or proxy changes; the model aliases keep their
  effort levels.
- A bot's restart guard stops it from restarting DinoBot from its own session; `bot-restart` is the
  one command for restarts and reloads. Claude Code workers compact at 200k tokens.

### Fixed

- A reload of the bots plugin no longer remounts the bots page or downloads every avatar again; a
  reload checks the new plugin before it stops the running one.
- Images you send to a pi bot are kept, so the chat still shows them after an engine switch.
- New chat follows a bot's engine switch instead of keeping the old chat's engine.
- The pairing code carries one address, the tailnet IP (no MagicDNS name): with both, the app
  switched between them under load and each switch reloaded the bots screen. An app built
  from this release (desktop or iPhone) drops a saved name beside the IP by itself;
  existing pairings keep working and need no new pairing.
- Direct connections stay end-to-end encrypted, as before: DinoBot refuses an unencrypted
  connection from another machine (an outdated app is told to update), and the app refuses to send
  the password over a connection that has no key (it asks you to pair again).

## v0.1.14

### Claude Code bots work like pi bots

- The answer streams into the chat as it is written.
- A turn Claude Code ends on an API error (retries used up, the context limit) or a refusal shows
  as failed, with Claude Code's own words, not as a cancel.
- A prompt waiting in the bot's terminal (a permission question) shows in the chat as a permission
  card and sends an attention push; it clears when the bot moves on.
- Stopped and failed turns are kept in the bot's memory, as on pi; memory warnings show in the
  chat; the bot's profile is checkpointed in git; an imported memory is opened as on pi; the Tool
  digest setting is honoured.
- A model or effort switch applies from the turn's next step, with no restart.
- A reopened chat shows its tool calls and the images you sent; images a tool returns (a
  screenshot, a picture it read) show in the chat.
- A message sent mid-turn is taken (queued and typed when the bot is free); Stop while your message
  is being typed stops that turn; a daemon restart mid-turn no longer types a message twice; a bot
  whose Claude Code restarts mid-turn fails that turn with a clear reason.
- Claude Code bots can search and fetch the web (WebSearch, WebFetch).
- The new-bot sheet offers pi or Claude Code. In a room, a Claude Code bot's seat runs on pi with the
  bot's own Claude model, or says clearly that pi needs an Anthropic sign-in.
- After updating, a Claude Code bot picks up its new mods the next time its Claude Code starts.

### Offline sending

- A message sent while the app is not connected to your computer yet waits in the chat (a clock
  icon) and is sent when the connection is back.

### Fixed

- The chat header reuses the avatar copies the bots list already has, so a bot's picture shows at
  once; designed avatars are centred.
- Pairing by QR code uses a one-use ticket only; the password is no longer in the QR code. Builds
  older than 12 cannot pair by QR (pair with the link, or set `DINOBOT_PAIRING_QR=ticket+password`
  on that computer).

## v0.1.13

### Restarts

- A bot still never restarts or stops DinoBot from its own session (it runs inside DinoBot, so
  that would cut off its reply). When a restart is needed it now starts a worker for it, instead
  of giving you the command: the worker waits until no bot is mid-turn, restarts once and checks
  DinoBot is back.

### Fixed

- The workers skill told bots to forbid "restart services" in every worker's brief, which blocked
  that restart worker. A worker now restarts DinoBot or a service only when that is its task.

## v0.1.12

### Choose models with Claude Code

- On a computer signed in to Claude Code, setup's "Choose models" (and Settings › Bot models) lists
  Claude Code's models: its aliases (Opus, Sonnet, Haiku, Fable: each follows the newest model of
  its family), then the model ids your login can use, each with Claude Code's effort levels. They
  sit next to pi's models when pi is signed in too.
- Suggestions for a Claude login: Opus for bot chats on a Max plan (Sonnet on Pro), Sonnet at
  medium effort for summaries and workers. pi's suggestions still win when pi has some.
- A Claude Code pick runs where Claude Code runs: bot chats on Claude Code, summaries in the bot's
  own Claude Code session, workers with `claude --model`. pi's own defaults are left alone.

### Usage cards for Claude Code bots

- A Claude Code bot's chat shows its rate limits (Session, Weekly, spend limit) as usage cards,
  read from what the bot's Claude Code reports. A bot behind an API key or proxy gets no card.

### Fixed

- Setup looped on a computer signed in only to Claude Code: the sign-in step said "Already signed
  in", "Choose models" found no models and sent you back to sign in. Now the models are listed;
  and if a computer lists none while you are signed in, the screen says so and goes on
  ("Continue", with "Add another sign-in" as the second choice), never back to sign-in first.
- The installer stopped with "_bar…: unbound variable" while downloading on macOS (its /bin/sh,
  bash 3.2, read part of the progress bar's character as a variable name). A test now checks
  every shipped shell script for the pattern.
- `dinobot doctor` printed "FAIL sign-in: no AI sign-in found" on Claude-Code-only setups. A
  Claude Code login now counts, and is named on the sign-in line.

## v0.1.11

### Bots can run on Claude Code

- A bot can now run on your own Claude Code login (your Claude Pro/Max plan): its chat is Claude
  Code's terminal app, with the bot's memory, tools and DMs as before. A new chat with no pi model
  and a Claude plan login starts on Claude Code; `bots.create` can make a Claude Code bot directly.
- The app shows what a Claude Code bot is doing: its thinking, each tool call with the command,
  file or search it used, a context meter, the chat's cost (summaries included) and rate limits.
- The model picker lists the Claude models your login can use, newest first; picking a model or
  effort restarts the bot's Claude Code once it is not mid-turn.
- Messages are typed into the bot's Claude Code only when it is idle, checked against its
  transcript, and never typed twice; a message sent just as a turn starts joins that turn. Bot DMs
  and room messages still arrive after you press Stop.
- A Claude Code bot sees the same skills a pi bot does (the bots plugin's, its own and your
  global ones), and finds its own AGENTS.md.
- Optional: a bot (or every bot) can send Claude Code through an Anthropic API proxy you run
  (`.bot.json` `cc.baseUrl`/`cc.authToken`, or `DINOBOT_CC_BASE_URL`/`DINOBOT_CC_AUTH_TOKEN`).
  Unset, nothing changes.

### Sign-in, defaults, workers

- Sign-in reads as two options: Claude Code (recommended) or pi with its providers, and says which
  terminal app your bots run in. The old pi-only first-run screen is gone; an older computer gets
  both options and is asked to update. Settings › Providers matches.
- Summaries (compaction) default to Claude Sonnet 5.5 at medium effort, or GPT-6.1 Sol at low for a
  ChatGPT sign-in; other sign-ins are asked during setup. A Claude Code bot can run its summaries
  on the computer's pi instead ("Summaries run on" in the Edit sheet); if pi fails it falls back.
- Workers default to Claude Code when it is signed in, else pi. Settings › Host › Agents › Workers
  sets the one default for all bots; a bot can keep its own default when you ask it to.
- New bots get a random default avatar (one of the 27 pack characters in its own look), and the
  first time you open a new bot its DMs tab opens once.

### One-use pairing codes, and devices stay paired without the password (QR2)

- Every pairing code (setup, `dinobot pair`, `dinobot pair --link`) carries a fresh one-use
  ticket: it works for one phone or computer, for 10 minutes. A second device needs its own code
  (`dinobot pair` again). A used ticket stays used after a restart.
- The app trades the ticket (or, on a phone paired before, its stored password) for a device
  token that keeps it paired: it lasts 180 days and is renewed whenever the device connects, so it
  ends only after about 180 days unused. A renewal lost with a dropped connection no longer signs
  a device out (the previous token stays valid for 7 days). Restarts and updates keep it.
- Once the app holds a device token, it deletes the password it stored for that computer.
- **For now the code still carries the password too**, so app builds without ticket support keep
  pairing. Once the TestFlight build that understands tickets is approved, one setting
  (`pairingQr` in `lib/product.json`: `"ticket"`) takes the password out of the code.
- New: `dinobot devices` lists the paired phones and computers; `dinobot devices --revoke <n>`
  unpairs one, `--revoke-all` unpairs all and voids every unused code. A revoked device is refused
  at its next connect.
- A refused code says so in the app ("expired or already used, run `dinobot pair`") instead of
  asking for a password.

### The installer's terminal screens give the important parts room

- At a real terminal, the install shows three steps (Download, Set up this computer, Connect your
  phone), one progress line redrawn in place, and a `✓` line per finished part. Paths, retries,
  checksum and signature detail go to `~/.dinobot/logs/install.log` and `~/.dinobot/logs/setup.log`,
  named only when something fails; an error is one sentence, the next step and the log path.
- Step 3 starts on a fresh screen with the pairing code and the one instruction beside or under it.
  When the window is too small for the whole code (macOS Terminal's default 80×24 cannot hold it),
  no partial code is shown: the screen says so, how big the window must be, and where the picture is
  (on a Mac it is already open in Preview); the code appears as soon as the window is resized.
  After the phone opens sign-in, the screen changes to "Now finish on your phone", then "Your bots
  are ready", then notes that need you ("Good to know").
- Text is wrapped to a readable column (at most 76 wide) read from the window each time; words,
  commands and paths are never broken. Sized for 80×24 up to 240×70; 60×20 still works.
- `update`, `uninstall` and `doctor` use the same look at a terminal.
- Piped output, CI and `TERM=dumb` print the plain lines as before; `NO_COLOR` keeps the layout
  without colour.

### Fixed

- Saving an avatar from the phone failed on every installed computer ("Cannot find package
  '@resvg/resvg-js'").
- `bot-dm` refused to run inside a Claude Code bot or worker; its errors now print their message
  instead of `[object Object]`.
- A background task finishing inside Claude Code is shown as a task note, not as your own words.
- The iPhone Live Activity no longer disappears and comes back every few seconds while the app is
  open (needs the next app build for the app half).

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
