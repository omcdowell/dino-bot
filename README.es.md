[English](README.md) | **Español** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md) | [Deutsch](README.de.md)

<!-- LOGO: placeholder until the brand visuals are chosen. -->
<h1 align="center">🦖 DinoBot</h1>

<p align="center"><b>Tu propio equipo de bots de IA, en el bolsillo.</b></p>
<!-- DRAFT tagline: not confirmed yet. -->

<p align="center">DinoBot está construido sobre Paseo: es un fork de <a href="https://github.com/getpaseo/paseo">Paseo</a>, de Mohamed Boudra.
Muchas gracias al proyecto Paseo.</p>

<p align="center">
  <a href="LICENSE">Apache-2.0</a> ·
  <a href="docs/how-it-works.md">Cómo funciona</a> ·
  <a href="SECURITY.md">Seguridad</a>
</p>

- 📱 **Pensado para el teléfono.** Una app de iPhone de verdad: chatea con tus bots, sigue a sus workers y (con
  una app que compiles tú mismo, ver más abajo) recibe notificaciones push y una Actividad en vivo en la pantalla bloqueada.
- 🎙️ **Dictado privado.** La conversión de voz a texto se ejecuta en tu propia computadora (usa una GPU NVIDIA si
  tienes una; si no, la CPU).
- 🤝 **Bots que trabajan en equipo.** Gestionan sus propios subagentes, se envían mensajes entre sí y trabajan
  contigo en chats grupales.
- 🧠 **Cualquier modelo.** Construido sobre [pi](https://github.com/earendil-works/pi): Claude, ChatGPT, OpenRouter
  y más.
- 🔒 **Tuyo.** Se ejecuta en tu propia computadora o VPS, accesible a través de Tailscale. Sin cuenta, sin relay en la nube.

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="DinoBot en iPhone en modo oscuro: inicio de bots con The Fat Controller fijado, un chat grupal, una tabla de investigación y la Actividad en vivo en la pantalla bloqueada mostrando un bot y sus workers">
</p>

> **Las notificaciones push y la Actividad en vivo requieren tu propia compilación de Apple Developer.** Apple solo
> entrega notificaciones push firmadas por el equipo que compiló la app, así que funcionan cuando compilas la app
> de iPhone con tu propia cuenta de Apple Developer (de pago) y le das a DinoBot tu propia clave push. Están
> desactivadas en una instalación normal, que funciona perfectamente sin ellas. Tu Bundle ID, el ID de la
> Actividad en vivo y tu Team ID son ajustes de compilación que rellenas tú (`PASEO_BUNDLE_ID`,
> `PASEO_WIDGET_BUNDLE_ID`, `PASEO_APPLE_TEAM_ID`); el código fuente no incluye ningún ID. Cómo configurarlos:
> [Actividades en vivo y push](docs/live-activities.md).

## Inicio rápido

En tu Mac o computadora con Linux:

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. Instala [Tailscale](https://tailscale.com/download) en la computadora y en tu teléfono, con la sesión iniciada
   en la misma cuenta. Si falta, la instalación te guía paso a paso.
2. Instala la app DinoBot en tu iPhone. <!-- TODO: TestFlight / App Store link -->
3. Escanea el código QR que muestra el instalador. Inicia sesión con tu proveedor de IA en la app y empieza a chatear.

## App de escritorio (básica)

También hay una app de escritorio básica para Mac y Linux. Se empareja con tu computadora DinoBot, muestra
tus bots y te permite chatear con ellos, igual que la app del teléfono. No ejecuta bots por sí misma: necesita
un host de DinoBot (la instalación de arriba), en la misma computadora o en otra de tu tailnet.

- **Mac** (Apple Silicon): `DinoBot-<version>-arm64.dmg` desde la
  [última release](https://github.com/omcdowell/dino-bot/releases/latest). Todavía no está firmada por
  Apple, así que la primera vez haz clic derecho en la app y elige **Abrir**. En macOS 15 o posterior,
  ábrela una vez y luego ve a Ajustes del Sistema › Privacidad y seguridad y haz clic en **Abrir igualmente**.
- **Linux** (x64): `DinoBot-x86_64.AppImage` desde la misma release. Hazlo ejecutable
  (`chmod +x`) y ejecútalo; consulta [Linux](docs/linux.md#desktop-app) si no arranca.

Para conectarte, ejecuta `~/.dinobot/bin/dinobot pair --link` en la computadora DinoBot y pega el enlace
en la app (**Paste pairing link**). La app no se actualiza sola: descarga la nueva versión
desde la página de releases.

## Requisitos

- macOS (Apple Silicon) o Linux (x64 o arm64, glibc), con `curl`, `tar` y `git`
- Windows 10/11: dentro de WSL 2, **sin probar** por ahora; consulta [Windows](docs/windows.md)
- [Tailscale](https://tailscale.com) en la computadora y en el teléfono
- Una suscripción de IA o una clave de API (Claude, ChatGPT, OpenRouter, …)
- Sin root: el instalador nunca usa sudo

## Más información

- [Cómo funciona el instalador](docs/how-it-works.md): pasos, comandos, flags
- [Actividades en vivo y push](docs/live-activities.md): con tu propia compilación de Apple Developer
- [Linux](docs/linux.md): paquetes, servicios, desinstalación, app de escritorio
- [Releases y verificación](docs/releases.md): checksums, firmas, cómo se generan las releases
- [Compilar y probar](docs/development.md)
- [Seguridad](SECURITY.md): qué pueden hacer los bots y cómo informar de un problema

## Licencia

Apache-2.0, Copyright 2026 omcdowell. DinoBot incluye una versión modificada de [Paseo](https://github.com/getpaseo/paseo)
y otros componentes de código abierto; consulta [NOTICE](NOTICE). El nombre y el arte de DinoBot no están
cubiertos por la licencia.
