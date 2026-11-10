[English](README.md) | [Español](README.es.md) | **简体中文** | [日本語](README.ja.md) | [Français](README.fr.md) | [Deutsch](README.de.md)

<!-- LOGO: placeholder until the brand visuals are chosen. -->
<h1 align="center">🦖 DinoBot</h1>

<p align="center"><b>你专属的 AI 机器人团队，装进口袋。</b></p>
<!-- DRAFT tagline: not confirmed yet. -->

<p align="center">DinoBot 基于 Paseo 构建：它是 Mohamed Boudra 的 <a href="https://github.com/getpaseo/paseo">Paseo</a> 的一个 fork。
非常感谢 Paseo 项目。</p>

<p align="center">
  <a href="LICENSE">Apache-2.0</a> ·
  <a href="docs/how-it-works.md">工作原理</a> ·
  <a href="SECURITY.md">安全</a>
</p>

- 📱 **手机优先。** 真正的 iPhone 应用：与你的机器人聊天，跟进它们的 worker；（使用你自己构建的应用时，
  见下文）还支持推送通知和锁屏上的实时活动。
- 🎙️ **私密听写。** 语音转文字在你自己的电脑上运行（有 NVIDIA GPU 时使用 GPU，
  否则使用 CPU）。
- 🤝 **协同工作的机器人。** 它们管理自己的子代理，互相发送消息，并在群聊中与你
  一起工作。
- 🧠 **任意模型。** 基于 [pi](https://github.com/earendil-works/pi) 构建：支持 Claude、ChatGPT、OpenRouter
  等。
- 🔒 **完全属于你。** 运行在你自己的电脑或 VPS 上，通过 Tailscale 访问。无需账号，没有云端中继。

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="深色模式下 iPhone 上的 DinoBot：置顶了 The Fat Controller 的机器人主页、一个群聊、一张研究表格，以及锁屏上显示一个机器人及其 worker 的实时活动">
</p>

> **推送通知和实时活动需要你自己的 Apple 开发者构建版本。** Apple 只会投递由构建该应用的团队签名的推送，
> 因此只有当你用自己的（付费）Apple 开发者账号构建 iPhone 应用，并把你自己的推送密钥提供给 DinoBot 时，
> 它们才能工作。在常规安装中它们是关闭的，没有它们一切功能照样完整可用。你的 Bundle ID、实时活动 ID 和
> Team ID 是由你自行填写的构建设置（`PASEO_BUNDLE_ID`、`PASEO_WIDGET_BUNDLE_ID`、
> `PASEO_APPLE_TEAM_ID`）；源代码中没有写死任何 ID。设置方法见：
> [实时活动与推送](docs/live-activities.md)。

## 快速开始

在你的 Mac 或 Linux 电脑上：

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. 在电脑和手机上安装 [Tailscale](https://tailscale.com/download)，并登录同一个账号。
   如果尚未安装，设置程序会一步步引导你完成。
2. 在 iPhone 上安装 DinoBot 应用。 加入 TestFlight 测试版：https://testflight.apple.com/join/QZm1NqTF
3. 扫描安装程序显示的二维码。在应用中登录你的 AI 服务商，即可开始聊天。

## 桌面应用（基础版）

我们还提供适用于 Mac 和 Linux 的基础版桌面应用。它会与你的 DinoBot 电脑配对，列出你的机器人，
并像手机应用一样让你与它们聊天。它本身不运行机器人：需要一台 DinoBot 主机（即上面的安装），
可以是同一台电脑，也可以是你 tailnet 中的另一台。

- **Mac**（Apple 芯片）：从[最新 release](https://github.com/omcdowell/dino-bot/releases/latest)
  下载 `DinoBot-<version>-arm64.dmg`。它暂未经过 Apple 签名，所以首次运行时请右键点按应用并选择
  **打开**。在 macOS 15 或更高版本上，先打开一次，然后前往 系统设置 › 隐私与安全性，点按 **仍要打开**。
- **Linux**（x64）：从同一个 release 下载 `DinoBot-x86_64.AppImage`。赋予可执行权限
  （`chmod +x`）后运行；如果无法启动，请参阅 [Linux](docs/linux.md#desktop-app)。

要建立连接，请在 DinoBot 电脑上运行 `~/.dinobot/bin/dinobot pair --link`，然后把链接粘贴到应用中
（**Paste pairing link**）。应用不会自动更新：请从 release 页面下载新版本。

## 系统要求

- macOS（Apple 芯片）或 Linux（x64 或 arm64，glibc），并装有 `curl`、`tar` 和 `git`
- Windows 10/11：在 WSL 2 中运行，目前**尚未测试**；参阅 [Windows](docs/windows.md)
- 电脑和手机上都装有 [Tailscale](https://tailscale.com)
- 一个 AI 订阅或 API 密钥（Claude、ChatGPT、OpenRouter 等）
- 无需 root：安装程序从不使用 sudo

## 了解更多

- [安装程序的工作原理](docs/how-it-works.md)：步骤、命令、参数
- [实时活动与推送](docs/live-activities.md)：使用你自己的 Apple 开发者构建版本
- [Linux](docs/linux.md)：软件包、服务、卸载、桌面应用
- [发布与验证](docs/releases.md)：校验和、签名、release 的构建方式
- [构建与测试](docs/development.md)
- [安全](SECURITY.md)：机器人能做什么，以及如何报告问题

## 许可证

Apache-2.0，Copyright 2026 omcdowell。DinoBot 包含经过修改的 [Paseo](https://github.com/getpaseo/paseo)
以及其他开源组件；参阅 [NOTICE](NOTICE)。DinoBot 名称和美术素材不在本许可证范围内。
