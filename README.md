**English** | [Español](README.es.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Deutsch](README.de.md)

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

- 📱 **Phone-first.** A real iPhone app: chat with your bots, follow their workers, and (with an
  app you build yourself, see below) push notifications and a Live Activity on the lock screen.
- 🎙️ **Private dictation.** Speech-to-text runs on your own computer (it uses an NVIDIA GPU if you
  have one, otherwise the CPU).
- 🤝 **Bots that work together.** They manage their own subagents, message each other and work
  in group chats with you.
- 🧠 **Any model.** Built on [pi](https://github.com/earendil-works/pi): Claude, ChatGPT, OpenRouter
  and more.
- 🔒 **Yours.** Runs on your own computer or VPS, reached over Tailscale. No account, no cloud relay.

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="DinoBot on iPhone in dark mode: bots home with The Fat Controller pinned, a group chat, a research table, and the Live Activity on the lock screen showing a bot and its workers">
</p>

> **Push notifications and the Live Activity need your own Apple developer build.** Apple only
> delivers pushes signed by the team that built the app, so they work when you build the iPhone
> app with your own (paid) Apple developer account and give DinoBot your own push key. They are
> off in a normal install, which works fully without them. Your bundle ID, Live Activity ID and
> Team ID are build settings you fill in (`PASEO_BUNDLE_ID`, `PASEO_WIDGET_BUNDLE_ID`,
> `PASEO_APPLE_TEAM_ID`); no IDs are wired into the source. How to set them up:
> [Live Activities and push](docs/live-activities.md).

## Quick start

On your Mac or Linux computer:

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. Install [Tailscale](https://tailscale.com/download) on the computer and on your phone, signed
   in to the same account. Setup walks you through it if it is missing.
2. Install the DinoBot app on your iPhone. Join the TestFlight beta: https://testflight.apple.com/join/QZm1NqTF
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

## Second person on the same Mac

Each person needs their own macOS account and their own tailnet. The Mac's Tailscale app belongs
to whoever signed it in; setup stops if it belongs to another macOS user rather than put your bots
on their tailnet. Run your own userspace `tailscaled` in your home folder instead
(`--tun=userspace-networking --socket=<path>`), sign it in to your tailnet, and point setup at it:

```sh
export DINOBOT_TAILSCALE_BIN=<your tailscale CLI> DINOBOT_TAILSCALE_SOCKET=<your tailscaled socket> DINOBOT_PORT=6747
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

- `DINOBOT_TAILSCALE_BIN`: the Tailscale CLI to use. `DINOBOT_TAILSCALE_SOCKET`: its daemon's
  socket (passed as `--socket`). Later `dinobot` commands remember both.
- `DINOBOT_PORT`: a port the other person's DinoBot does not use.
- A userspace tailscaled has no network interface, so DinoBot listens on `127.0.0.1:<port>` and
  your tailscaled hands it your phone's connections. Because they arrive from `127.0.0.1`, setup
  turns off DinoBot's "same computer" exemption (`PASEO_TRUST_LOOPBACK=false` in
  `~/.dinobot/daemon.env`): a connection from `127.0.0.1` is treated like one from the network. The
  app must use its end-to-end encrypted connection (an outdated app is refused with "update the
  app"), and the only clients let in without it are your own DinoBot tools (`paseo`, your bots),
  which prove themselves with the daemon's local credential, a file only your account can read.
- Close your home folder to other users first (`chmod 700 ~`; macOS makes it readable to every
  standard user). DinoBot runs only while your account is logged in (fast user switching keeps it
  running).

## Learn more

- [How the installer works](docs/how-it-works.md): steps, commands, flags
- [Live Activities and push](docs/live-activities.md): with your own Apple developer build
- [Linux](docs/linux.md): packages, services, uninstall, desktop app
- [Releases and verification](docs/releases.md): checksums, signatures, how releases are built
- [Build and test](docs/development.md)
- [Security](SECURITY.md): what bots can do, and how to report a problem

## Licence

Apache-2.0, Copyright 2026 omcdowell. DinoBot includes a modified [Paseo](https://github.com/getpaseo/paseo)
and other open-source parts; see [NOTICE](NOTICE). The DinoBot name and artwork are not covered by
the licence.
