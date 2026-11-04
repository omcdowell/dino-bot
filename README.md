<!-- LOGO: placeholder until the brand visuals are chosen. -->
<h1 align="center">🦖 DinoBot</h1>

<p align="center"><b>Your own team of AI bots, in your pocket.</b></p>
<!-- DRAFT tagline: not confirmed yet. -->

<p align="center">DinoBot is built on Paseo: it is a fork of <a href="https://github.com/getpaseo/paseo">Paseo</a> by Mohamed Boudra.
Many thanks to the Paseo project.</p>

<p align="center">
  <a href="LICENSE">Apache-2.0</a> ·
  <a href="docs/how-it-works.md">How it works</a> ·
  <a href="SECURITY.md">Security</a>
</p>

- 📱 **Phone-first.** A real iPhone app with push notifications and Live Activities, so you see what
  your bots are doing from the lock screen.
- 🎙️ **Private dictation.** Speech-to-text runs locally on your own GPU.
- 🤝 **Bots that work together.** They manage their own subagents, message each other and work
  in group chats with you.
- 🧠 **Any model.** Built on [pi](https://github.com/earendil-works/pi): Claude, ChatGPT, OpenRouter
  and more.
- 🔒 **Yours.** Runs on your own computer or VPS, reached over Tailscale. No account, no cloud relay.

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="DinoBot on iPhone in dark mode: bots home with The Fat Controller pinned, a group chat, a research table, and the Live Activity on the lock screen showing a bot and its workers">
</p>

## Quick start

On your Mac or Linux computer:

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. Install [Tailscale](https://tailscale.com/download) on the computer and on your phone, signed
   in to the same account. Setup walks you through it if it is missing.
2. Install the DinoBot app on your iPhone. <!-- TODO: TestFlight / App Store link -->
3. Scan the QR code the installer prints. Sign in to your AI provider in the app, and start chatting.

## Desktop app (basic)

There is also a basic desktop app for Mac and Linux. It pairs with your DinoBot computer, lists
your bots and lets you chat with them, as the phone app does. It does not run bots itself: it
needs a DinoBot host (the install above), on the same computer or another one on your tailnet.

- **Mac** (Apple silicon): `DinoBot-<version>-arm64.dmg` from the
  [latest release](https://github.com/omcdowell/dino-bot/releases/latest). It is not signed by
  Apple yet, so the first time, right-click the app and choose **Open**. On macOS 15 or later,
  open it once, then go to System Settings › Privacy & Security and click **Open Anyway**.
- **Linux** (x64): `DinoBot-x86_64.AppImage` from the same release. Make it executable
  (`chmod +x`) and run it; see [Linux](docs/linux.md#desktop-app) if it does not start.

To connect, run `~/.dinobot/bin/dinobot pair --link` on the DinoBot computer and paste the link
into the app (**Paste pairing link**). The app does not update itself: download the new version
from the release page.

## Requirements

- macOS (Apple silicon) or Linux (x64 or arm64, glibc), with `curl`, `tar` and `git`
- Windows 10/11: inside WSL 2, **untested** so far; see [Windows](docs/windows.md)
- [Tailscale](https://tailscale.com) on the computer and the phone
- An AI subscription or API key (Claude, ChatGPT, OpenRouter, …)
- No root: the installer never uses sudo

## Learn more

- [How the installer works](docs/how-it-works.md): steps, commands, flags
- [Linux](docs/linux.md): packages, services, uninstall, desktop app
- [Releases and verification](docs/releases.md): checksums, signatures, how releases are built
- [Build and test](docs/development.md)
- [Security](SECURITY.md): what bots can do, and how to report a problem

## Licence

Apache-2.0, Copyright 2026 omcdowell. DinoBot includes a modified [Paseo](https://github.com/getpaseo/paseo)
and other open-source parts; see [NOTICE](NOTICE). The DinoBot name and artwork are not covered by
the licence.
