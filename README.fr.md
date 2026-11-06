[English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **Français** | [Deutsch](README.de.md)

<!-- LOGO: placeholder until the brand visuals are chosen. -->
<h1 align="center">🦖 DinoBot</h1>

<p align="center"><b>Votre propre équipe de bots IA, dans votre poche.</b></p>
<!-- DRAFT tagline: not confirmed yet. -->

<p align="center">DinoBot est basé sur Paseo : c'est un fork de <a href="https://github.com/getpaseo/paseo">Paseo</a> de Mohamed Boudra.
Un grand merci au projet Paseo.</p>

<p align="center">
  <a href="LICENSE">Apache-2.0</a> ·
  <a href="docs/how-it-works.md">Fonctionnement</a> ·
  <a href="SECURITY.md">Sécurité</a>
</p>

- 📱 **Pensé pour le mobile.** Une vraie app iPhone : discutez avec vos bots, suivez leurs workers et, avec
  une app que vous compilez vous-même (voir plus bas), recevez des notifications push et une Activité en direct sur l'écran verrouillé.
- 🎙️ **Dictée privée.** La reconnaissance vocale tourne sur votre propre ordinateur (sur un GPU NVIDIA si
  vous en avez un, sinon sur le CPU).
- 🤝 **Des bots qui travaillent ensemble.** Ils gèrent leurs propres sous-agents, s'envoient des messages
  et travaillent avec vous dans des discussions de groupe.
- 🧠 **N'importe quel modèle.** Basé sur [pi](https://github.com/earendil-works/pi) : Claude, ChatGPT, OpenRouter
  et bien d'autres.
- 🔒 **À vous.** Tourne sur votre propre ordinateur ou VPS, accessible via Tailscale. Pas de compte, pas de relais cloud.

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="DinoBot sur iPhone en mode sombre : l'accueil des bots avec The Fat Controller épinglé, une discussion de groupe, un tableau de recherche et l'Activité en direct sur l'écran verrouillé montrant un bot et ses workers">
</p>

> **Les notifications push et l'Activité en direct nécessitent votre propre build Apple Developer.** Apple ne
> délivre que les notifications push signées par l'équipe qui a compilé l'app : elles fonctionnent donc si vous
> compilez l'app iPhone avec votre propre compte Apple Developer (payant) et fournissez à DinoBot votre propre
> clé push. Elles sont désactivées dans une installation normale, qui fonctionne parfaitement sans elles. Votre
> Bundle ID, l'ID de l'Activité en direct et votre Team ID sont des réglages de build à renseigner
> (`PASEO_BUNDLE_ID`, `PASEO_WIDGET_BUNDLE_ID`, `PASEO_APPLE_TEAM_ID`) ; aucun ID n'est codé en dur dans les
> sources. Pour les configurer : [Activités en direct et push](docs/live-activities.md).

## Démarrage rapide

Sur votre Mac ou votre ordinateur Linux :

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. Installez [Tailscale](https://tailscale.com/download) sur l'ordinateur et sur votre téléphone, connectés
   au même compte. S'il manque, l'installation vous guide.
2. Installez l'app DinoBot sur votre iPhone. <!-- TODO: TestFlight / App Store link -->
3. Scannez le QR code affiché par l'installeur. Connectez-vous à votre fournisseur d'IA dans l'app, et c'est parti.

## App de bureau (version de base)

Il existe aussi une app de bureau simple pour Mac et Linux. Elle s'associe à votre ordinateur DinoBot,
liste vos bots et vous permet de discuter avec eux, comme l'app mobile. Elle n'exécute pas de bots
elle-même : elle a besoin d'un hôte DinoBot (l'installation ci-dessus), sur le même ordinateur ou sur
un autre de votre tailnet.

- **Mac** (Apple Silicon) : `DinoBot-<version>-arm64.dmg` depuis la
  [dernière release](https://github.com/omcdowell/dino-bot/releases/latest). Elle n'est pas encore signée
  par Apple : la première fois, faites un clic droit sur l'app et choisissez **Ouvrir**. Sous macOS 15 ou
  plus récent, ouvrez-la une fois, puis allez dans Réglages Système › Confidentialité et sécurité et cliquez
  sur **Ouvrir quand même**.
- **Linux** (x64) : `DinoBot-x86_64.AppImage` depuis la même release. Rendez-le exécutable
  (`chmod +x`) et lancez-le ; consultez [Linux](docs/linux.md#desktop-app) s'il ne démarre pas.

Pour vous connecter, lancez `~/.dinobot/bin/dinobot pair --link` sur l'ordinateur DinoBot et collez le lien
dans l'app (**Paste pairing link**). L'app ne se met pas à jour toute seule : téléchargez la nouvelle version
depuis la page des releases.

## Prérequis

- macOS (Apple Silicon) ou Linux (x64 ou arm64, glibc), avec `curl`, `tar` et `git`
- Windows 10/11 : dans WSL 2, **non testé** pour l'instant ; voir [Windows](docs/windows.md)
- [Tailscale](https://tailscale.com) sur l'ordinateur et le téléphone
- Un abonnement IA ou une clé API (Claude, ChatGPT, OpenRouter, …)
- Pas de root : l'installeur n'utilise jamais sudo

## En savoir plus

- [Fonctionnement de l'installeur](docs/how-it-works.md) : étapes, commandes, options
- [Activités en direct et push](docs/live-activities.md) : avec votre propre build Apple Developer
- [Linux](docs/linux.md) : paquets, services, désinstallation, app de bureau
- [Releases et vérification](docs/releases.md) : sommes de contrôle, signatures, construction des releases
- [Compiler et tester](docs/development.md)
- [Sécurité](SECURITY.md) : ce que les bots peuvent faire, et comment signaler un problème

## Licence

Apache-2.0, Copyright 2026 omcdowell. DinoBot inclut une version modifiée de [Paseo](https://github.com/getpaseo/paseo)
et d'autres composants open source ; voir [NOTICE](NOTICE). Le nom et les visuels DinoBot ne sont pas couverts
par la licence.
