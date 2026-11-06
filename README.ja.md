[English](README.md) | [Español](README.es.md) | [简体中文](README.zh-CN.md) | **日本語** | [Français](README.fr.md) | [Deutsch](README.de.md)

<!-- LOGO: placeholder until the brand visuals are chosen. -->
<h1 align="center">🦖 DinoBot</h1>

<p align="center"><b>あなた専用の AI ボットチームを、ポケットに。</b></p>
<!-- DRAFT tagline: not confirmed yet. -->

<p align="center">DinoBot は Paseo をベースにしています。Mohamed Boudra 氏による <a href="https://github.com/getpaseo/paseo">Paseo</a> のフォークです。
Paseo プロジェクトに心から感謝します。</p>

<p align="center">
  <a href="LICENSE">Apache-2.0</a> ·
  <a href="docs/how-it-works.md">仕組み</a> ·
  <a href="SECURITY.md">セキュリティ</a>
</p>

- 📱 **スマホファースト。** 本物の iPhone アプリ。ボットとチャットし、ボットのワーカーの動きを追えます。さらに
  （自分でビルドしたアプリなら。下記参照）プッシュ通知とロック画面のライブアクティビティにも対応します。
- 🎙️ **プライベートな音声入力。** 音声認識はあなた自身のコンピュータ上で動作します（NVIDIA GPU が
  あれば GPU を、なければ CPU を使います）。
- 🤝 **連携して働くボット。** ボットは自分のサブエージェントを管理し、互いにメッセージを送り合い、
  あなたとグループチャットで一緒に作業します。
- 🧠 **どんなモデルでも。** [pi](https://github.com/earendil-works/pi) をベースにしています：Claude、ChatGPT、OpenRouter
  など。
- 🔒 **あなたのもの。** 自分のコンピュータまたは VPS 上で動作し、Tailscale 経由で接続します。アカウント不要、クラウドリレーなし。

<p align="center">
  <img src="docs/screenshots.png" width="100%" alt="ダークモードの iPhone で動く DinoBot：The Fat Controller がピン留めされたボットのホーム画面、グループチャット、リサーチ結果の表、そしてボットとそのワーカーを表示するロック画面のライブアクティビティ">
</p>

> **プッシュ通知とライブアクティビティには、自分の Apple Developer ビルドが必要です。** Apple は、アプリを
> ビルドしたチームが署名したプッシュしか配信しません。そのため、自分の（有料の）Apple Developer アカウントで
> iPhone アプリをビルドし、DinoBot に自分のプッシュキーを設定した場合に動作します。通常のインストールでは
> 無効になっていますが、それらがなくてもすべての機能が使えます。Bundle ID、ライブアクティビティの ID、
> Team ID は自分で入力するビルド設定です（`PASEO_BUNDLE_ID`、`PASEO_WIDGET_BUNDLE_ID`、
> `PASEO_APPLE_TEAM_ID`）。ソースコードに ID は埋め込まれていません。設定方法：
> [ライブアクティビティとプッシュ](docs/live-activities.md)。

## クイックスタート

Mac または Linux コンピュータで：

```sh
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

1. コンピュータとスマートフォンの両方に [Tailscale](https://tailscale.com/download) をインストールし、
   同じアカウントでサインインします。未インストールの場合は、セットアップが手順を案内します。
2. iPhone に DinoBot アプリをインストールします。 <!-- TODO: TestFlight / App Store link -->
3. インストーラが表示する QR コードをスキャンします。アプリで AI プロバイダにサインインすれば、すぐにチャットを始められます。

## デスクトップアプリ（基本版）

Mac と Linux 向けの基本的なデスクトップアプリもあります。DinoBot コンピュータとペアリングし、ボットの
一覧を表示して、スマホアプリと同じようにボットとチャットできます。アプリ自体はボットを実行しません。
同じコンピュータ、または tailnet 上の別のコンピュータに DinoBot ホスト（上記のインストール）が必要です。

- **Mac**（Apple シリコン）：[最新リリース](https://github.com/omcdowell/dino-bot/releases/latest)から
  `DinoBot-<version>-arm64.dmg` を入手します。まだ Apple の署名がないため、初回はアプリを右クリックして
  **開く** を選んでください。macOS 15 以降では、一度開いてから システム設定 › プライバシーとセキュリティ
  に移動し、**このまま開く** をクリックします。
- **Linux**（x64）：同じリリースから `DinoBot-x86_64.AppImage` を入手します。実行権限を付けて
  （`chmod +x`）起動します。起動しない場合は [Linux](docs/linux.md#desktop-app) を参照してください。

接続するには、DinoBot コンピュータで `~/.dinobot/bin/dinobot pair --link` を実行し、表示されたリンクを
アプリに貼り付けます（**Paste pairing link**）。アプリは自動更新されません。新しいバージョンは
リリースページからダウンロードしてください。

## 動作要件

- macOS（Apple シリコン）または Linux（x64 または arm64、glibc）、`curl`・`tar`・`git` が必要
- Windows 10/11：WSL 2 上で動作、現時点では**未検証**。[Windows](docs/windows.md) を参照
- コンピュータとスマートフォンに [Tailscale](https://tailscale.com)
- AI のサブスクリプションまたは API キー（Claude、ChatGPT、OpenRouter など）
- root 不要：インストーラは sudo を一切使いません

## 詳しく知る

- [インストーラの仕組み](docs/how-it-works.md)：手順、コマンド、フラグ
- [ライブアクティビティとプッシュ](docs/live-activities.md)：自分の Apple Developer ビルドで使う場合
- [Linux](docs/linux.md)：パッケージ、サービス、アンインストール、デスクトップアプリ
- [リリースと検証](docs/releases.md)：チェックサム、署名、リリースのビルド方法
- [ビルドとテスト](docs/development.md)
- [セキュリティ](SECURITY.md)：ボットにできること、問題の報告方法

## ライセンス

Apache-2.0、Copyright 2026 omcdowell。DinoBot には改変した [Paseo](https://github.com/getpaseo/paseo)
とその他のオープンソースのコンポーネントが含まれます。[NOTICE](NOTICE) を参照してください。DinoBot の名称と
アートワークはこのライセンスの対象外です。
