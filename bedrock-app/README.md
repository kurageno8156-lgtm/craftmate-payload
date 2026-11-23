# BlockWhiz Bedrock

Minecraft **統合版（Bedrock Edition）専用**の BlockWhiz アドオンです。
Java 版の BlockWhiz（Mineflayer 製デスクトップアプリ）とは完全に別物で、
**ゲーム内だけで完結**します。外部サーバー・LAN ポート・ダッシュボードは不要です。

## 仕組み

- **ビヘイビアパック（BP/）**: `@minecraft/server` Script API で動作する
  ゲーム内スクリプト。チャットコマンドと日本語の自然言語コマンドを処理します。
- **リソースパック（RP/）**: HUD 左上に「BlockWhiz Bedrock」のステータス表示を追加します。

リソースパック単体ではゲームロジックを実行できないため、
**ビヘイビアパックのスクリプト API** を採用しています（方法B）。
これによりシングルプレイ（オフライン）でも動作し、LAN ポート（19132 等）は一切使用しません。

## インストール

1. `dist/CraftMate-Bedrock.mcaddon` をダウンロード
   （またはこのフォルダを ZIP 圧縮して `.mcaddon` にリネーム）
2. Minecraft 統合版にドラッグ＆ドロップ（または「設定 → ストレージ →
   「統合版」→「ビヘイビアパック / リソースパック → ファイルを選択」）
3. ワールド作成/編集時に「ビヘイビアパック」と「リソースパック」の
   両方で **BlockWhiz Bedrock** を有効化（実験版機能は不要）
4. ワールドに入るとチャットに `[BlockWhiz Bedrock] アドオンが有効化されました` と表示されます

## 使い方

### スラッシュコマンド（推奨）

ゲーム内チャットで `/` から始まる **カスタムコマンド** として実行できます
（Minecraft 1.20.10 以降の `customCommandRegistry` を使用）:

```
/craftmate:help
/craftmate:status
/craftmate:say こんにちは
/craftmate:follow
/craftmate:stop
/craftmate:come
/craftmate:build 家        （塔 / 橋 も可）
/craftmate:time night
/craftmate:weather rain
/craftmate:give diamond 16
/craftmate:tp 100 64 -200
/craftmate:pos
/craftmate:bot spawn
/craftmate:bot dismiss
/craftmate:gamemode creative
/craftmate:difficulty hard
```

> カスタムコマンド名は必ず `craftmate:` 名前空間付きです。
> `/craftmate help`（スペース区切り）は Minecraft の仕様上登録できないため、
> `/craftmate:help` の形式を使ってください。

### チャットコマンド（従来形式・引き続き利用可能）

`!craftmate <command>` または `craftmate <command>` をチャットに入力しても動作します
（`!` は省略可、大文字小文字は区別しません）。

### scriptevent フォールバック

カスタムコマンドが使えない環境では `/scriptevent` 経由でも実行できます:

```
/scriptevent craftmate:run help
/scriptevent craftmate:status
/scriptevent craftmate:run build 家
```

### コマンド一覧

| コマンド | 説明 |
|---|---|
| `!craftmate help` | コマンド一覧を表示 |
| `!craftmate status` | 時刻・天気・位置・HP・ゲームモード・ボット状態を表示 |
| `!craftmate say <メッセージ>` | ボットがチャットで発言 |
| `!craftmate follow` | ボットがプレイヤーに追従（未召喚なら自動召喚） |
| `!craftmate stop` | 追従を停止 |
| `!craftmate come` | ボットがプレイヤーの位置にテレポート |
| `!craftmate build <家\|塔\|橋>` | 定型建築を実行（`house`/`tower`/`bridge` も可） |
| `!craftmate time <day\|night>` | 時間を変更（`noon`/`midnight`/tick数 も可） |
| `!craftmate weather <clear\|rain\|thunder>` | 天気を変更 |
| `!craftmate give <アイテム> <個数>` | アイテムを付与（例: `give diamond 16`） |
| `!craftmate tp <x> <y> <z>` | 座標へテレポート（`tp <プレイヤー名>` も可） |
| `!craftmate pos` | 現在位置を表示 |
| `!craftmate bot spawn` | コンパニオン（アーマースタンド）を召喚 |
| `!craftmate bot dismiss` | ボットを消去 |
| `!craftmate gamemode <...>` | ゲームモード変更（survival/creative/adventure/spectator） |
| `!craftmate difficulty <...>` | 難易度変更（peaceful/easy/normal/hard） |

### 使用例

```
!craftmate help
!craftmate status
!craftmate say こんにちは！
!craftmate bot spawn
!craftmate follow
!craftmate come
!craftmate build 家
!craftmate build 塔
!craftmate time night
!craftmate weather rain
!craftmate give diamond 16
!craftmate tp 100 64 -200
!craftmate pos
```

### 日本語の自然言語

```
家建てて / 塔を建てて / 橋を架けて
夜にして / 雨降らせて / 晴れにして
ここに来て / ついてきて / 止まれ
こんにちは
```

### フィードバック

- 各コマンドの結果はチャット（`[BlockWhiz]` プレフィックス）に表示されます
- 直近の実行結果は**アクションバー（HUD上部）**にも表示されます
- 引数不足・不明なコマンドの場合は「使用方法: !craftmate help を参照してください」と表示されます
- `time`/`weather`/`gamemode`/`difficulty` はワールドの「コマンド」設定が有効な場合のみ動作します（それ以外は失敗メッセージが表示されます）

## ビルド

```bash
node bedrock-app/build.mjs
# → bedrock-app/dist/CraftMate-Bedrock.mcaddon
```

## 制限事項（正直な説明）

- ゲーム内スクリプトのため、**外部の大規模言語モデル（LLM）には接続しません**。
  「AI 機能」はルールベースのコマンド解釈＋定型アクションです。
- 自律的な採掘・探索・複雑な建築は未対応です（`build` は定型の小屋のみ）。
- Java 版 BlockWhiz の Mineflayer ボット機能（自律行動・画面認識など）は
  プロトコルが異なるため統合版では利用できません。
- LAN ワールドへの接続や Realm への参加機能はありません
  （このアドオンはワールド内で動作するゲーム内機能です）。
