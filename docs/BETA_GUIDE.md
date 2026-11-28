# BlockWhiz Beta 版 ガイド・既知の問題

## 1. クラウドアカウントの設定方法（利用者向け）

Beta版でクラウドアカウントを使うには、Auth ServerのURLを環境変数で指定します。

```powershell
# Windows（ユーザー環境変数、永続）
[Environment]::SetEnvironmentVariable('CRAFTMATE_AUTH_URL', 'https://<auth-server-url>', 'User')
```

- `https://` 必須。`http://` は `127.0.0.1`/`localhost` のみ許可（開発用）。
- 未設定の場合：ログイン画面のクラウドフォームは非表示、`/api/cloud/*` は 503。**ローカルアカウント・Minecraft機能には影響なし**。
- 設定後はアプリ再起動で有効化。

## 2. 複数PCでの同一アカウント利用（テスト手順）

### 前提
- PC-A・PC-B ともに `CRAFTMATE_AUTH_URL` 設定済み
- 同じメールアドレス+パスワードで登録/ログイン

### 手順
1. PC-A でクラウドアカウント新規登録 → ダッシュボード表示を確認
2. PC-B で同じアカウントに**ログイン**（登録ではなくログイン）→ ダッシュボード表示を確認
3. PC-A を再起動 → セッション自動復元を確認
4. PC-B でログアウト → PC-A のセッションが**継続する**ことを確認（後述のセッション仕様）
5. PC-A でパスワード変更 → **全デバイスのセッションが失効**することを確認

### セッション仕様（実装確認済み）

| 操作 | 影響範囲 |
|---|---|
| `/auth/logout`（アプリのログアウト） | **そのデバイスのセッションのみ**失効。他デバイスは継続 |
| `/auth/logout-all` | 全デバイスのセッション失効（パスワード変更・リセット・アカウント削除時に自動実行） |
| Refresh Token | デバイスごとに独立（ログイン毎に新規発行・ローテーション）。片方の失効はもう片方に影響しない |
| パスワード変更/リセット | `revoke_reason='password_change'/'password_reset'` で**全セッション失効** → 全デバイス再ログイン必要 |
| アカウント削除 | 全セッション失効 + ログイン・リフレッシュ・OAuth全て拒否 |

## 3. CraftMate → BlockWhiz 更新・再インストール時のデータ保持

### 保持されるもの（%LOCALAPPDATA%\CraftMate）
- `craftmate.db` — チャット履歴・AI記憶・**integrations テーブル（クラウドセッション・OAuthトークン）**
- `oauth-clients.json` — OAuth クライアント設定（配布物には非含有、ユーザー配置）

### アンインストール時
- `craftmate.db` の削除は**確認ダイアログ**（「いいえ」で保持）
- `oauth-clients.json` は削除対象外 → 再インストール後も OAuth 設定維持
- クラウドセッションは craftmate.db 内 → DB保持を選べば**再インストール後もクラウドログイン状態が復元**される

### ショートカット
- Beta版以降：`BlockWhiz.lnk` / `BlockWhiz Updater.lnk` / `BlockWhiz 画面共有ビューア.lnk`
- インストール時に旧 `CraftMate*.lnk` は自動削除（重複防止）

## 4. Beta 既知の問題・注意事項

| 項目 | 内容 |
|---|---|
| メール確認 | MockMailerのみ（実メール未送信）。確認メールのリンクは開発環境のoutboxに記録されるのみ |
| パスワードリセット | 同上。実メール未実装のため利用者はリセット不可（ローカルでの再設定手段なし） |
| OAuth専用ユーザー | パスワード設定・メール確認フロー未実装（設計案は `AUTH_ACCOUNT_FLOWS.md`） |
| 表示名 | インストーラー・ダッシュボード・ログイン画面は BlockWhiz 統一。内部識別子（`CraftMate.exe`、`%LOCALAPPDATA%\CraftMate`、レジストリキー、リポジトリ名 `blockwhiz`（旧 `craftmate-payload`）、配布ファイル名 `CraftMate_Setup.exe`）は互換性のため維持 |
| アイドル自動終了 | ダッシュボード未接続90秒+ボット未接続でアプリ自動終了（仕様） |
| 実DB/Redis結合 | Auth ServerはPGlite/メモリ実装で検証済み。**実PostgreSQL・実Redisとのアプリ結合テストは未実施** |
| PGバックアップ/復元 | PostgreSQL 16.15で `pg_dump -Fc` → 空DBへの `pg_restore --no-owner --no-privileges` を検証済み（スキーマ・データ・制約が完全一致）。既存DB上書き（`--clean --if-exists`）は未検証 |
| Render/Resend実環境 | Renderへの実接続、Redis(Key Value)接続、Resend実メール送信は**全て未検証** |

## 5. Beta → 正式版のデータ互換性

- `craftmate.db` スキーマは `CREATE TABLE IF NOT EXISTS` で非破壊的に拡張 → Beta→正式版でそのまま利用可能
- integrations テーブルの `__cloud_auth_session` 行はそのまま有効（トークンはAuth Server側で管理）
- Auth Server側DBスキーマも追加のみ（`email_tokens`等）→ 正式版移行時にデータ変換不要
- `CRAFTMATE_AUTH_URL` の値を変える場合は全クライアントで再設定が必要（セッションはAuth Server側に紐づく）
