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
