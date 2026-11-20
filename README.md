# CraftMate — Minecraftで自律的に動くAIボットを、あなたのPCで。

[![Latest Release](https://img.shields.io/github/v/release/kurageno8156-lgtm/craftmate-payload?label=latest&color=10b981)](https://github.com/kurageno8156-lgtm/craftmate-payload/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**CraftMate** は、Google Gemini / OpenAI / Groq / Ollama などのAIと連携し、**Minecraft Java Edition の世界で建築・採掘・探索・戦闘・会話を自律的に実行する Windows アプリ**です。

「家を建てて」「鉄のツルハシを作って」「このモンスターを倒して」と自然な言葉で指示するだけで、AIが状況を判断し、必要な素材集めから道具作り、設計図の生成と建築まで自分で進めます。進行状況はブラウザのダッシュボードでリアルタイムに確認できます。

![CraftMate Dashboard](public/dashboard-preview.svg)

---

## ⬇️ ダウンロード

**[最新版 v1.3.133 をダウンロード (CraftMate_Setup.exe)](https://github.com/kurageno8156-lgtm/craftmate-payload/releases/latest/download/CraftMate_Setup.exe)**

> 常に最新リリースがダウンロードされます。過去のバージョンは [Releases](https://github.com/kurageno8156-lgtm/craftmate-payload/releases) ページから取得できます。

---

## ✨ 主な機能

- **🧠 自律行動（ReActループ）** — 「目標 → 状況認識 → 計画 → 実行 → 観察」を繰り返し、失敗したら自分で方法を変えて再試行します
- **🏗️ 建築** — AIが設計図を自動生成し、コマンドブロック一括建築または手作業で家や建物を建てます
- **⛏️ 採掘・クラフト** — 木・石・鉄鉱石の採掘、作業台・ツルハシ・剣などのレシピ解決クラフトを自動化
- **⚔️ 戦闘・生存** — モブ討伐、動物の狩り、食料確保、自動防御ガード、満腹度管理
- **💬 自然な会話** — Minecraftチャットから直接話しかけ可能。雑談・質問にも応答し、過去のやり取りを記憶します
- **🖥️ 見える化ダッシュボード** — 体力・満腹度・インベントリ・周囲エンティティ・AI思考ログをリアルタイム表示。クイックコマンド対応
- **🗂️ チャットルーム** — 会話をルームごとに整理。履歴はローカルDBに永続化
- **📺 画面共有** — ボットの一人称視点をブラウザで確認可能
- **🔄 アプリ内アップデーター** — ワンクリックで最新版に更新。更新後は自動再起動
- **🔌 AIモデル切替** — Gemini / OpenAI / Groq / Ollama（ローカル・無料）を設定画面から切替

---

## 💻 システム要件

| 項目 | 要件 |
|---|---|
| OS | Windows 10 / 11（64bit） |
| Node.js | **不要**（インストーラーに同梱） |
| Minecraft | Java Edition **1.20.5 〜 1.21.11 推奨**（その他も自動検出・手動選択可） |
| AI | Gemini / Groq / OpenAI の APIキー、またはローカル Ollama |

---

## 🖥️ 対応プラットフォーム

| プラットフォーム | ステータス | 配布形式 | 備考 |
|---|---|---|---|
| **Windows** (x64 / x86 / ARM64) | ✅ **利用可能** | `CraftMate_Setup.exe` | Node.js同梱・完全ポータブル |
| Linux (x64 / ARM64) | ✅ **利用可能** | `CraftMate-linux-{x64,arm64}.AppImage` / `.deb` / `.tar.gz` | Electronデスクトップアプリ＋ポータブルtarball |
| macOS (Intel / Apple Silicon) | 🚧 開発中 | `.dmg` 予定 | 署名・公証対応予定 |
| Android | 💭 検討中 | APK / Google Play 検討 | Minecraft PE 連携が前提 |
| iOS | 💭 検討中 | App Store / TestFlight 検討 | 同上 |

> **macOS / モバイルをお使いの方へ**: macOS 版は開発中です。リリースタグは `v1.4.0-macos` のような OS 識別子付き命名を予定しています。

### Linux 版の起動方法

**デスクトップアプリ（推奨）— AppImage / deb**

```bash
# AppImage: 実行権限を付けて起動（アプリメニュー登録は deb 版のみ）
chmod +x CraftMate-linux-x64.AppImage
./CraftMate-linux-x64.AppImage

# または deb をインストール → アプリメニューの「CraftMate」から起動（x64のみ）
sudo apt install ./CraftMate-linux-x64.deb
```

> ARM64 版は AppImage のみ提供（deb は x64 のみ）。

Electron ラッパーがサーバー（`dist/index.js`）をバックグラウンドで起動し、`http://localhost:3000` をネイティブウィンドウに表示します。ウィンドウを閉じるとサーバープロセスも自動終了します。

**ポータブル tarball（従来版）**

```bash
tar xzf craftmate-linux-x64.tar.gz
cd craftmate-linux-x64
chmod +x start.sh
./start.sh   # ブラウザで http://localhost:3000 を開く
```

> Linux 版は C# 製ランチャー/アップデーターを使いません。in-app アップデーターは Windows 版のみ対応しています。

---

## 📦 インストール方法

1. **[CraftMate_Setup.exe](https://github.com/kurageno8156-lgtm/craftmate-payload/releases/latest/download/CraftMate_Setup.exe)** をダウンロードして実行
2. デスクトップに作成されるショートカットから **CraftMate** を起動
3. 設定画面（⚙️）で AI プロバイダーと API キーを設定 → Minecraftワールドにボットが参加

セットアップは以上です。アンインストールは Windows の「アプリと機能」または `Uninstall.exe` から行えます。

---

## 🔒 セキュリティとプライバシー

- **APIキーはローカルの `.env` にのみ保存**され、CraftMateのサーバーや外部に送信・公開されることはありません
- チャット履歴・AIメモリ・レビューは `%LOCALAPPDATA%\CraftMate\craftmate.db`（SQLite）にローカル保存
- ダッシュボードは `127.0.0.1:3000` のみで待ち受け、外部からのアクセスは遮断されます
- アップデート等のローカル操作APIは認証ガードで保護されています

---

## ❓ トラブルシューティング（FAQ）

**Q. 「サーバーが応答しません」と表示される**
A. v1.3.131 以降、サーバーの自己診断ウォッチドッグが組み込まれており、HTTP応答が止まった場合は約45秒で自動再起動します。ログは `%TEMP%\CraftMate_server.log` に記録されます。

**Q. Minecraftに接続できない**
A. Minecraftのワールドが起動しているか確認してください。シングルプレイの場合は「LANに公開」を有効にして表示されたポートを設定に入力。サーバーの場合はポート25565とファイアウォールを確認してください。

**Q. ブラウザを閉じたら裏でプロセスが残る**
A. v1.3.131 以降、ブラウザ終了を検知して関連プロセスを自動終了します（ボットがMinecraft接続中を除く）。確実に終了するには設定画面の「⏻ アプリを完全に終了」ボタンを使ってください。

**Q. アンインストール方法は？**
A. まず「⏻ アプリを完全に終了」でプロセスを停止し、Windows の「アプリと機能」から CraftMate を削除するか、`Uninstall.exe` を実行してください。

**Q. 建築が途中で止まる**
A. v1.3.132 以降、設計図が無くてもフォールバック設計図で建築を継続し、コマンドブロック設置のタイムアウトにはリトライ＋`/setblock`フォールバックがあります。建築は1ブロックずつ設置するため時間がかかるのが正常です。

**Q. 「WindowsによってPCが保護されました」（SmartScreen警告）が出る**
A. `CraftMate_Setup.exe` はコード署名を行っていないため、初回起動時にSmartScreenの警告が表示されます。対処法:

1. 「**詳細情報**」をクリック
2. 「**実行**」をクリック
3. UAC（ユーザーアカウント制御）で「**はい**」

CraftMateはあなたのPC上でのみ動作し、APIキー等の情報を外部に送信しません。コード署名証明書を導入すればこの警告は解消されます（後述「コード署名」を参照）。

**Q. アップデートはどうやって適用されますか？**
A. ダッシュボード上部に新バージョンの通知バーが表示されたら「今すぐ更新」を押してください。Windows版はアプリ内アップデーターが自動でダウンロード・適用します。Linux版 **AppImage** もアプリ内からダウンロード→SHA256検証→自動置換→再起動まで行えます（deb / tarball 版は手動更新）。設定画面の「↻ アップデートを確認」からも同じ手順で更新できます。

---

## 🔏 コード署名（SmartScreen警告の解消）

SmartScreen警告を根本的に解消するには、信頼されたCA発行のコード署名証明書が必要です。

### 証明書の取得

- **OV証明書**（例: SSL.com, Sectigo, DigiCert）: 年間数万円程度。署名後、SmartScreenの評判が貯まるにつれ警告が出にくくなります。
- **EV証明書**: 即座にSmartScreen警告が出なくなりますが高価です。

### 署名付きビルド方法

1. 証明書を `.pfx` 形式でエクスポート
2. ビルド環境に以下を設定:

```powershell
$env:CRAFTMATE_PFX_PATH = "C:\path\to\cert.pfx"
$env:CRAFTMATE_PFX_PASSWORD = "your-password"   # パスワードなしなら省略可
# または $env:CRAFTMATE_PFX_BASE64 = "<base64エンコードしたpfx>"  # CI用
```

3. `installer/Build-Release.ps1` が自動的に `signtool.exe`（Windows SDK同梱）で `CraftMate.exe` / `Launcher.exe` / `CraftMate_Updater.exe` / `Uninstall.exe` / `CraftMate_Setup.exe` を署名します。GitHub Actions のシークレット `CRAFTMATE_PFX_BASE64` / `CRAFTMATE_PFX_PASSWORD` に設定すればCIでも署名されます。

> ⚠️ 自己署名証明書ではSmartScreen警告は解消されません（警告が「発行元不明」から変わるだけです）。必ず公的CA発行の証明書を使用してください。

---

## 🔐 ログイン認証（OAuth 2.0 / OpenID Connect）

v1.3.157 以降、初回起動時にログイン画面が表示されます。ユーザーは「Googleでログイン」「Microsoftでログイン」「GitHubでログイン」ボタンを押すだけで、各プロバイダの標準ログイン画面に遷移して認証できます。セッションは AES-256-GCM で暗号化してローカルに保存され、次回起動時は自動ログインされます。

### OAuth アプリの登録（開発者向け）

ボタン1つでログインできるようにするには、各プロバイダで OAuth アプリを登録し、Client ID / Client Secret を `.env` に設定してビルドしてください。リダイレクト URI は以下を全プロバイダ共通で登録します:

```
http://127.0.0.1:3000/api/integrations/<provider>/oauth/callback
```

`<provider>` は `google` / `microsoft` / `github` のいずれかです（プロバイダごとに個別のURIを登録）。

#### Google

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「APIとサービス」→「OAuth同意画面」でユーザータイプ（外部/内部）とスコープ（`openid`, `email`, `profile`）を設定
3. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」→ アプリの種類は「ウェブアプリケーション」
4. 承認済みリダイレクトURIに `http://127.0.0.1:3000/api/integrations/google/oauth/callback` を追加
5. 発行された Client ID / Client Secret を控える

#### Microsoft

1. [Azure Portal](https://portal.azure.com/) →「Microsoft Entra ID」→「アプリの登録」→「新規登録」
2. 名前を入力し、「リダイレクトURI」に `http://127.0.0.1:3000/api/integrations/microsoft/oauth/callback` を「Web」プラットフォームで追加
3. 「APIのアクセス許可」で `openid`, `email`, `profile`, `offline_access` を追加し管理者の同意を付与
4. 「証明書とシークレット」で新しいクライアントシークレットを作成
5. 「概要」のアプリケーション (クライアント) ID とシークレットを控える

#### GitHub

1. GitHub → Settings → Developer settings → OAuth Apps →「New OAuth App」
2. Application name と Homepage URL（任意）を入力
3. Authorization callback URL に `http://127.0.0.1:3000/api/integrations/github/oauth/callback` を設定
4. 「Register application」後、Client ID を控え、「Generate a new client secret」でシークレットを発行

### クライアント情報の埋め込み

リポジトリルートに `oauth-clients.json` を作成し（テンプレート: `oauth-clients.example.json`）、Client ID / Secret を記入してからビルドしてください。このファイルは `.gitignore` 済みで、Windows ペイロード（`app_payload.zip`）と Linux tarball の両方に自動で同梱されます。

```json
{
  "google":    { "clientId": "xxxxx.apps.googleusercontent.com", "clientSecret": "GOCSPX-xxxxx" },
  "microsoft": { "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "clientSecret": "xxxxx" },
  "github":    { "clientId": "xxxxx", "clientSecret": "xxxxx" }
}
```

実行時の環境変数（`GOOGLE_CLIENT_ID` 等、`.env.example` 参照）や、ログイン画面の「上級者向け」手動入力も引き続き利用できます。優先順位は **手動入力 > 環境変数 > oauth-clients.json** です。

> **注意**: Client Secret を配布物に埋め込むと、リバースエンジニアリングで取り出される可能性があります。ネイティブアプリ向けの OAuth では一般的なトレードオフですが、公開クライアント（PKCE のみ・シークレットなし）構成も検討してください。GitHub OAuth Apps はシークレット必須です。

Client ID が未設定のビルドでは、ログイン画面に「上級者向け」の手動入力フォームが表示されます。また「ローカルで続行」ボタンで OAuth なしのスキップも可能です。

---

## 📁 ディレクトリ構成

```
├── public/                 # Webダッシュボード & 配布ページ
│   ├── index.html          # ダッシュボードUI
│   ├── app.js / i18n.js    # フロントエンドロジック・多言語
│   ├── distribution.html   # 配布サイト（ダッシュボードの /distribution.html）
│   └── dashboard-preview.svg
├── src/
│   ├── ai/                 # AI頭脳（agent / llmClient / tools）
│   ├── bot/                # Mineflayerボット（mcBot / perception / skills）
│   ├── server/webServer.ts # Express + Socket.IO サーバー
│   ├── db.ts               # SQLite 永続化
│   └── index.ts            # エントリーポイント
├── installer/              # Setup / Updater / Uninstall / ScreenViewer (C#)
└── Launcher.cs             # 起動・監視・プロセス管理 (C#)
```

---

## 📜 ライセンスとクレジット

CraftMate は [MIT License](LICENSE) で公開しています。

使用している主なOSSライブラリ: [Mineflayer](https://github.com/PrismarineJS/mineflayer), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [Socket.IO](https://socket.io/), [Express](https://expressjs.com/), [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), TypeScript / Node.js。

---

## 📝 変更履歴

最新の変更は [Releases](https://github.com/kurageno8156-lgtm/craftmate-payload/releases) を参照してください。v1.3.126〜v1.3.133 で、長期間のデバッグで判明した起動失敗・UIフリーズ・POSTハング・建築停止などの重大な問題が解消されました。
