# 🤖 Minecraft 自律型 AI Agent (頭脳: LLM × 作業: Mineflayer Bot)

Minecraft内でプレイヤーが自然言語（日本語）で指示を出すと、**AI（Gemini / OpenAI / Ollama）が自律的に状況を認識・計画立案**し、**Mineflayer Botが木を切ったり、アイテムをクラフトしたり、プレイヤーについてきたり、モンスターを迎撃する**システムです。

---

## 🌟 特徴

- **🧠 自律思考 ReAct ループ**: 
  指示を受けると、「現在地・所持品・周囲ブロック・敵対Mob」を把握した上で、段階的な行動計画（Thought → Action → Observation）を立てて自律実行します。
- **🪵 多彩なアクション（スキル群）**:
  - **移動・追従**: `goToPlayer`（プレイヤーの元へ移動）, `followPlayer`（追従）, `goToCoordinates`（座標移動）
  - **採掘・収集**: `mineAndCollect`（木・原木・丸石・鉄鉱石等の自動探索＆採掘・回収）
  - **クラフト**: `craftItem`（木材、作業台、木のツルハシ等のレシピ自動解決クラフト）
  - **建築・設置**: `placeBlock`（作業台やブロックの設置）
  - **戦闘・護衛**: `attackTarget`（ゾンビ等の迎撃・防衛）
  - **アイテム受け渡し**: `giveItemsToPlayer`（手持ち素材をプレイヤーへ届ける）
- **🌐 リアルタイム Web ダッシュボード (http://localhost:3000)**:
  - Botの体力・満腹度・座標・装備・インベントリ・周囲Mobをグラフィカルに表示
  - AIの思考ログ（ReAct Timeline）をリアルタイム表示
  - Web画面から直接指示の送信やタスク中断が可能
- **⚡ マルチLLMプロバイダ対応**:
  - **Google Gemini API** (無料＆超高速・推奨)
  - **OpenAI API** (GPT-4o 等)
  - **Ollama** (ローカルLLM完全オフライン動作)

---

## 🚀 クイックスタートガイド

### 1. 動作環境
- **Node.js**: v18 以上 (推奨: v20 / v22 / v24)
- **Minecraft**: Java Edition (1.8 ～ 1.20.x 等)

---

### 2. 設定 (`.env` ファイルの編集)

プロジェクトルートの `.env` ファイルを開き、必要な項目を設定します。

```env
# --- Minecraft サーバー接続設定 ---
MC_HOST=localhost
MC_PORT=25565
MC_USERNAME=AI_Worker
MC_AUTH=offline

# --- AI 頭脳 (LLM) 設定 ---
LLM_PROVIDER=gemini

# Google Gemini API キー (https://aistudio.google.com/ で無料取得可能)
GEMINI_API_KEY=ここにAPIキーを貼り付け
GEMINI_MODEL=gemini-2.5-flash
```

> [!TIP]
> **Gemini APIキーの取得方法（完全無料）**:
> [Google AI Studio](https://aistudio.google.com/) にアクセスし、Googleアカウントでログイン後「Get API key」から発行できます。

---

### 3. Minecraft 側の準備（シングルプレイの場合）

1. Minecraft Java Edition を起動し、シングルプレイでワールドに入ります。
2. `Esc` キーを押し、**「LANに公開 (Open to LAN)」** をクリックします。
3. **「チート許可: オン」** にし、**「LANワールドを開始」** をクリックします。
4. チャット欄に `ローカルゲームをポート ##### でホストしています` と表示されます。
5. 表示された **5桁のポート番号** を `.env` の `MC_PORT` に設定します。
   （例: `MC_PORT=51234`）

*(※専用サーバー Paper/Spigot 等をローカルで動かしている場合はデフォルトポート `25565` のままでOKです)*

---

### 4. 起動

ターミナル（PowerShell等）で以下を実行します：

```bash
npm start
```

起動すると、自動的に：
1. Minecraftワールドに `AI_Worker` がログインします。
2. Webダッシュボードが `http://localhost:3000` で起動します。

---

## 💬 指示・命令の出し方

以下の3つの方法のいずれからでも指示できます：

1. **ゲーム内チャット**:
   Tキーでチャットを開き、通常通り発言します。
   - `木を3つ切って集めてきて`
   - `私についてきて`
   - `木のツルハシを1本作って`
   - `手持ちの木材を私に渡して`
   - `ストップ`
2. **Web ダッシュボード (`http://localhost:3000`)**:
   ブラウザからクイックコマンドボタンを押すか、自由な日本語指示を入力して「指示送信」をクリック。
3. **ターミナル コンソール**:
   サーバーのコマンドプロンプトに直接指示を入力。

---

## 🛠️ 指示の具体例

| やりたいこと | 指示の言葉の例 | AIの自律動作 |
|---|---|---|
| **原木集め** | `木を5個切ってきて` | 周囲の木（オーク/シラカバ等）を探し、斧を装備して伐採し、ドロップ品を回収 |
| **ツール作り** | `木のツルハシを作って` | 木を切る → 木材クラフト → 作業台クラフト＆設置 → 棒クラフト → ツルハシクラフト |
| **プレイヤー追従** | `私についてきて` | プレイヤーの背後を一定距離で自動追従 |
| **アイテム渡し** | `木材を私に渡して` | プレイヤーの元へ移動し、インベントリから木材をドロップして手渡す |
| **防衛・戦闘** | `近くのゾンビを倒して` | 武器（剣など）を装備し、最寄りのゾンビに接近して攻撃 |
| **行動停止** | `ストップ` / `止まって` | 現在実行中のタスク・移動を即座に中断 |

---

## 📁 ディレクトリ構成

```
├── public/                 # Webダッシュボード（HTML/CSS/JS）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/
│   ├── ai/                 # AI頭脳レイヤー
│   │   ├── agent.ts        # 自律ReActエージェントループ
│   │   ├── llmClient.ts    # Gemini / OpenAI / Ollama マルチクライアント
│   │   └── tools.ts        # Function Calling ツール定義
│   ├── bot/                # Mineflayer Botレイヤー
│   │   ├── mcBot.ts        # ボット本体 & イベント管理
│   │   ├── perception.ts   # 環境認識・知覚モジュール
│   │   └── skills.ts       # 移動・採掘・クラフト・戦闘等スキル実装
│   ├── server/
│   │   └── webServer.ts    # Express + Socket.IO Webサーバー
│   ├── config.ts           # 環境変数・設定ロード
│   ├── types.ts            # 共通型定義
│   └── index.ts            # メインエントリーポイント
├── .env.example            # 設定テンプレート
├── package.json
└── tsconfig.json
```

---

## ❓ トラブルシューティング

- **Q. Botがサーバーに入ってこない**
  - A. シングルプレイの「LANに公開」で表示された5桁のポート番号と `.env` の `MC_PORT` が一致しているか確認してください。
  - A. オフラインサーバーやLAN公開の場合は `MC_AUTH=offline` に設定してください。
- **Q. APIキーのエラーが出る**
  - A. `.env` の `GEMINI_API_KEY` または `OPENAI_API_KEY` に正しいキーが入力されているか確認してください。
- **Q. タスクが途中で止まってしまった**
  - A. チャットまたはWeb画面から「`ストップ`」と送るか、WebUIの「タスク中断」ボタンを押せばリセットされます。
