# Security

DinoBot runs AI bots on **your own computer**, and you talk to them from the DinoBot iPhone app.
This page explains what that means for your security, and how to report a problem.

## Report a vulnerability
Use GitHub's **private vulnerability reporting**: open the repository's "Security" tab and choose
"Report a vulnerability". Please do not open a public issue, and please do not email. This is the
only channel. Only the latest release is supported.

## Bots have your permissions. Please read this
Bots and their workers run shell commands, edit files and browse the web **as your user account**.
There is no sandbox between bots, or between a bot and you. Any bot can do anything you can do in
a terminal. That includes reading your other bots' memories, and sending messages that look as if
another bot sent them. Sender names in bot-to-bot messages are there to prevent mistakes. They are
not a security boundary.

Bots read text that nobody has checked: web pages, imported chats and group messages. That text
can try to trick a bot. This is called "prompt injection". To limit the damage:
- In group-chat rooms, bots can only look things up. They can read files only in the room's own
  folder and in `~/bots`. They cannot read credential files, open private or local network
  addresses (your LAN, Tailscale, localhost), or open a web address that did not appear in the
  conversation.
- Only give bots API keys and logins that you are happy for them to use.
- Run DinoBot on a computer or user account that holds no secrets you can't afford to lose.

## How your phone connects
- The daemon listens only on your computer's **Tailscale** address. Tailscale encrypts and
  authenticates the connection. DinoBot runs no relay server.
- The app opens a direct connection only to a Tailscale address (`*.ts.net` or `100.64.0.0/10`).
  A LAN address, a `.local` name or any other address is refused, so the daemon password never goes
  over your Wi-Fi in plain text.
- The pairing QR code holds your daemon's address and a **password**. Treat it like a password and
  don't share a photo of it. There is no command to change the password yet. If it leaks, run
  `dinobot uninstall --purge` and install again. You will then need to sign in to your AI
  providers again; your bots and memories are kept.
- If you expose the daemon any other way, such as port forwarding or a public server address,
  anyone who can reach it and knows the password controls your account. Please don't.

## Secrets on disk
| What | Where | Protection |
|---|---|---|
| Model logins and API keys | `~/.dinobot/pi/auth.json` | file mode 600 |
| Daemon password | `~/.dinobot/daemon.env` (the daemon stores only a hash of it) | mode 600 |
| Daemon key pair, local CLI credential | `~/.dinobot/paseo/` | folder mode 700 |
| Bots, memories, chats | `~/bots`, `~/.dinobot` | folder mode 700 (new installs) |
| macOS background services | `~/Library/LaunchAgents/*.plist` (they include the daemon password) | mode 600 |

The daemon logs leave out authorization headers and tokens.

## Install and update
- Nothing runs as root, and the installer never uses sudo.
- `install.sh` and `dinobot update` download over HTTPS only. They check two things before
  anything is unpacked, and stop with "Nothing was installed" (or "nothing changed") if either fails:
  1. the **SHA-256 checksum** (`<tarball>.sha256`), which catches a broken download; and
  2. the **signature** (`<tarball>.sigstore.json`), which proves who made the build. Every release
     is built and signed by this repository's release workflow on GitHub Actions
     (`.github/workflows/release.yml`, at a `v…` tag) with Sigstore "keyless" signing: there is no
     signing key that could be stolen. GitHub vouches for the workflow's identity, Sigstore issues
     a short-lived certificate for it, and the signature is recorded in Sigstore's public
     transparency log. A tarball signed by anyone else, built from a branch, or changed after
     signing is refused.
- The signature is checked with `cosign` from the Sigstore project. If you don't have cosign 3 or
  newer, the installer downloads one (about 100 MB, once) from Sigstore's GitHub releases and
  refuses it unless its SHA-256 matches the value written into `install.sh`. It is kept in
  `~/.dinobot/tools` for updates.
- The whole script runs inside one function, so a download that is cut off part-way runs nothing.
- Releases are built on clean GitHub runners from the tagged commit of this repo (its `paseo/`,
  `plugins/bots/`, `optchat/` and `addons/paseo-apns/` folders) and the exact versions listed in
  `build/sources.json`, never from a developer's computer.

### Check a download yourself
```sh
cosign verify-blob dinobot-darwin-arm64.tar.gz \
  --bundle dinobot-darwin-arm64.tar.gz.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/omcdowell/dino-bot/\.github/workflows/release\.yml@refs/tags/v[0-9]' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
`install.sh`, `SHA256SUMS` and each tarball in a release have their own `.sigstore.json`.

What the signature does not cover: `install.sh` itself when you pipe it straight into `sh` (you
trust GitHub's HTTPS for that; download it, check it as above, then run it), and the owner's
GitHub account: whoever can push a `v…` tag to this repository can make a release.

## Known gaps (beta)
- Only one password, shared by all your phones. It is kept in the app's normal storage, not the
  iOS Keychain.
- Push notifications go through Expo and Apple.
- The bundled daemon still uses some dependency versions that have published advisories. Updating
  them is in progress.

## Out of scope
Attacks that need code already running as your user. Anything a bot does because you, or text you
gave it, asked it to. Problems in model providers, Tailscale, Expo or Apple (please report those to
them).
