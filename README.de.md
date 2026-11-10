[English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | **Deutsch**

<!-- LOGO: placeholder until the brand visuals are chosen. -->
<h1 align="center">🦖 DinoBot</h1>

<p align="center"><b>Dein eigenes Team aus KI-Bots, in deiner Hosentasche.</b></p>
<!-- DRAFT tagline: not confirmed yet. -->

<p align="center">DinoBot basiert auf Paseo: Es ist ein Fork von <a href="https://github.com/getpaseo/paseo">Paseo</a> von Mohamed Boudra.
Vielen Dank an das Paseo-Projekt.</p>

<p align="center">
  <a href="LICENSE">Apache-2.0</a> ·
  <a href="docs/how-it-works.md">So funktioniert es</a> ·
  <a href="SECURITY.md">Sicherheit</a>
</p>

- 📱 **Phone-first.** Eine echte iPhone-App: Chatte mit deinen Bots, verfolge ihre Worker und erhalte
  (mit einer selbst gebauten App, siehe unten) Push-Benachrichtigungen und eine Live-Aktivität auf dem Sperrbildschirm.
- 🎙️ **Private Diktierfunktion.** Die Spracherkennung läuft auf deinem eigenen Computer (mit einer
  NVIDIA-GPU, falls vorhanden, sonst auf der CPU).
- 🤝 **Bots, die zusammenarbeiten.** Sie verwalten ihre eigenen Subagents, schreiben sich gegenseitig
  Nachrichten und arbeiten mit dir in Gruppenchats.
- 🧠 **Jedes Modell.** Basiert auf [pi](https://github.com/earendil-works/pi): Claude, ChatGPT, OpenRouter
  und mehr.
- 🔒 **Gehört dir.** Läuft auf deinem eigenen Computer oder VPS, erreichbar über Tailscale. Kein Konto, kein Cloud-Relay.

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="DinoBot auf dem iPhone im Dark Mode: Bot-Startseite mit angeheftetem The Fat Controller, ein Gruppenchat, eine Recherche-Tabelle und die Live-Aktivität auf dem Sperrbildschirm mit einem Bot und seinen Workern">
</p>

> **Push-Benachrichtigungen und die Live-Aktivität erfordern einen eigenen Apple-Developer-Build.** Apple
> stellt nur Pushes zu, die vom Team signiert sind, das die App gebaut hat. Sie funktionieren also, wenn du die
> iPhone-App mit deinem eigenen (kostenpflichtigen) Apple-Developer-Account baust und DinoBot deinen eigenen
> Push-Key gibst. In einer normalen Installation sind sie deaktiviert, und die funktioniert auch ohne sie
> vollständig. Deine Bundle ID, Live-Activity-ID und Team ID sind Build-Einstellungen, die du selbst einträgst
> (`PASEO_BUNDLE_ID`, `PASEO_WIDGET_BUNDLE_ID`, `PASEO_APPLE_TEAM_ID`); im Quellcode sind keine IDs
> hinterlegt. So richtest du sie ein: [Live-Aktivitäten und Push](docs/live-activities.md).

## Schnellstart

Auf deinem Mac oder Linux-Computer:

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. Installiere [Tailscale](https://tailscale.com/download) auf dem Computer und auf deinem Smartphone,
   angemeldet mit demselben Konto. Falls es fehlt, führt dich das Setup durch die Installation.
2. Installiere die DinoBot-App auf deinem iPhone. Tritt der TestFlight-Beta bei: https://testflight.apple.com/join/QZm1NqTF
3. Scanne den QR-Code, den der Installer ausgibt. Melde dich in der App bei deinem KI-Anbieter an und leg los.

## Desktop-App (Basisversion)

Es gibt auch eine einfache Desktop-App für Mac und Linux. Sie koppelt sich mit deinem DinoBot-Computer,
listet deine Bots auf und lässt dich mit ihnen chatten, genau wie die Smartphone-App. Sie führt selbst
keine Bots aus: Sie braucht einen DinoBot-Host (die Installation oben), auf demselben Computer oder einem
anderen in deinem Tailnet.

- **Mac** (Apple Silicon): `DinoBot-<version>-arm64.dmg` aus dem
  [neuesten Release](https://github.com/omcdowell/dino-bot/releases/latest). Die App ist noch nicht von
  Apple signiert. Klicke deshalb beim ersten Mal mit der rechten Maustaste auf die App und wähle **Öffnen**.
  Unter macOS 15 oder neuer öffne sie einmal, gehe dann zu Systemeinstellungen › Datenschutz & Sicherheit
  und klicke auf **Dennoch öffnen**.
- **Linux** (x64): `DinoBot-x86_64.AppImage` aus demselben Release. Mach die Datei ausführbar
  (`chmod +x`) und starte sie; siehe [Linux](docs/linux.md#desktop-app), falls sie nicht startet.

Zum Verbinden führe `~/.dinobot/bin/dinobot pair --link` auf dem DinoBot-Computer aus und füge den Link
in die App ein (**Paste pairing link**). Die App aktualisiert sich nicht selbst: Lade die neue Version
von der Release-Seite herunter.

## Voraussetzungen

- macOS (Apple Silicon) oder Linux (x64 oder arm64, glibc), mit `curl`, `tar` und `git`
- Windows 10/11: in WSL 2, bisher **ungetestet**; siehe [Windows](docs/windows.md)
- [Tailscale](https://tailscale.com) auf dem Computer und dem Smartphone
- Ein KI-Abo oder ein API-Key (Claude, ChatGPT, OpenRouter, …)
- Kein Root: Der Installer verwendet nie sudo

## Mehr erfahren

- [So funktioniert der Installer](docs/how-it-works.md): Schritte, Befehle, Flags
- [Live-Aktivitäten und Push](docs/live-activities.md): mit deinem eigenen Apple-Developer-Build
- [Linux](docs/linux.md): Pakete, Dienste, Deinstallation, Desktop-App
- [Releases und Verifizierung](docs/releases.md): Prüfsummen, Signaturen, wie Releases gebaut werden
- [Bauen und testen](docs/development.md)
- [Sicherheit](SECURITY.md): was Bots tun können und wie du ein Problem meldest

## Lizenz

Apache-2.0, Copyright 2026 omcdowell. DinoBot enthält eine modifizierte Version von [Paseo](https://github.com/getpaseo/paseo)
sowie weitere Open-Source-Komponenten; siehe [NOTICE](NOTICE). Der Name DinoBot und das Artwork sind nicht
von der Lizenz abgedeckt.
