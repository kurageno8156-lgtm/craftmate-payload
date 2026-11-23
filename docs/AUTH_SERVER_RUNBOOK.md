# BlockWhiz Auth Server 障害対応 Runbook

本番障害発生時の対応手順。各シナリオで「対応手順」「確認項目」「復旧完了条件」を記載。

> **原則**: コード変更より先に影響範囲の特定とサービス継続を優先する。
> 秘密情報（JWT鍵・APIキー・パスワード・接続文字列）は本書・ログ・チャットに記載しない。

---

## 1. PostgreSQL の障害（接続不可・クラッシュ）

### 対応手順

1. `/ops/health` で `dbOk:false` を確認（DB障害の切り分け）
2. Render ダッシュボードで PostgreSQL インスタンスの状態を確認（Running / Suspended / Failed）
3. **接続情報の確認**: `DATABASE_URL` が正しい内部URLを指しているか確認
4. **SSL設定の確認**: `DATABASE_SSL` がインスタンスのTLS要件と一致するか確認（`disable`/`prefer`/`require`）
5. Render側の自動復旧を待つ（通常は数分で復旧）
6. 復旧しない場合は §2「PostgreSQL のデータ消失」手順へ

### 確認項目

- `/ops/health` が `{"ok":true}` を返す
- `/auth/login` で既存ユーザーがログイン成功
- `/auth/session/refresh` で既存refresh tokenが有効

### 復旧完了条件

`/ops/health` が `{"ok":true}` を返し、既存ユーザーのログイン・セッション更新が成功すること。

---

## 2. PostgreSQL のデータ消失

### 対応手順

1. **即座にバックアップの有無を確認**: Render PITR（有料）/ スナップショット / 手動 `pg_dump`
2. **新しいDBを用意**: Render新規PostgreSQLインスタンスを作成
3. **ダンプをリストア** — 復元先の状態で手順が異なる：

   #### A. 空の復元先DBへの復元（Phase Xで実証済み）

   バックアップは `pg_dump -Fc`（custom format）で取得したものを使う。

   ```bash
   # バックアップ取得（custom format）
   pg_dump -Fc -f auth_backup.dump "$DATABASE_URL"

   # 空のDBへの復元（owner/権限を引き継がない）
   pg_restore --no-owner --no-privileges -d "$NEW_DATABASE_URL" auth_backup.dump
   ```

   - **検証環境**: PostgreSQL 16.15（EDB公式バイナリ）で実施済み
   - `--no-owner --no-privileges` はマネージドPGでowner差異による権限エラーを回避するため推奨

   #### B. 既存DBへの上書き復元（⚠️ 未検証）

   ```bash
   pg_restore --clean --if-exists -d "$DATABASE_URL" auth_backup.dump
   ```

   - **`--clean --if-exists` はPhase Xで未検証**。本番環境で安易に実行しないこと
   - 実施前に必ず別DBで同じ手順を検証し、問題がないことを確認してから行うこと
   - 可能であれば「空DBへ復元 → 接続先切替」（パターンA）を優先する

4. **環境変数更新**: `DATABASE_URL` を新DBの接続文字列に変更
5. **再デプロイ**: Renderで再デプロイまたは環境変数更新で自動再起動
6. **ヘルス確認**: `/ops/health` が `{"ok":true}` を返すこと

### Phase X 検証結果（PostgreSQL 16.15 / custom format dump→restore）

空の別DBへの `pg_restore --no-owner --no-privileges` で以下を確認済み：

| 項目 | 結果 |
|---|---|
| テーブル件数 | 7テーブル全て一致（users/external_identities/sessions/oauth_flows/oauth_codes/email_tokens/audit_logs） |
| カラム定義 | 69件全て一致 |
| インデックス | 20件全て一致（部分インデックス含む） |
| 制約 | 15件全て一致（PK/FK/UNIQUE） |
| 部分UNIQUE `idx_users_credential_email` | 同一メール+password_hashの重複INSERTを正しく拒否、OAuth専用（password_hash=NULL）との同一メール共存を許可 |
| 外部キー制約 | 存在しないuser_idへのINSERTを正しく拒否 |
| JSONB | sessions.token_history / audit_logs.metadata / device_info が保持 |
| email_tokens | token_hash（SHA-256・64文字）のみ保存・平文なし・used_at保持 |

### 確認項目

- `SELECT count(*) FROM users` — 復元前の行数と一致
- `SELECT count(*) FROM external_identities` — OAuth紐付けが保持されていること
- `SELECT count(*) FROM audit_logs WHERE user_id IS NULL` — 削除済みユーザーの監査証跡が残っていること
- `SELECT indexdef FROM pg_indexes WHERE indexname='idx_users_credential_email'` — 部分UNIQUEのpredicateが保持されていること
- sessionsとtoken_history: `token_family_id` の共有関係と `token_history` JSONB配列が保持されていること
- email_tokens: `token_hash` が64文字のハッシュのみで平文を含まないこと
- 既存ユーザーで `/auth/login` → `/auth/session/refresh` 成功
- OAuthユーザーで `/auth/oauth/start` → callback → `/auth/token` 成功

### 未検証事項

以下はPhase Xで確認していないため、本番適用前に別途検証が必要：

- `pg_restore --clean --if-exists` による既存DB上書き（パターンB）
- Render PITR / スナップショットからの復元
- 大規模データ・長時間トランザクション中の整合性
- `pg_dump` plain形式（`-Fc`以外）での復元

### 復旧完了条件

`/ops/health` が `{"ok":true}` を返し、既存ユーザーのログイン・OAuth再ログイン・セッション更新が全て成功すること。

---

## 3. JWT秘密鍵の紛失

> **前提**: 第三者への漏えいがないことを確認済み。漏えいの疑いがある場合は §4「JWT秘密鍵の漏えい」へ。

### 対応手順

1. **新しい鍵ペアを生成**:
   ```bash
   openssl genrsa -out jwt-private.pem 2048
   openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
   ```
2. **環境変数を更新**:
   - `AUTH_JWT_PRIVATE_KEY_PEM` = 新秘密鍵のPEM全文
   - `AUTH_JWT_PUBLIC_KEY_PEM` = 新公開鍵のPEM全文
   - `AUTH_JWT_KID` = 新しいKID（例: `key-2026-11`）
   - `AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM` = **旧公開鍵**（後述の条件付き）
3. **再デプロイ**: Renderで再デプロイ
4. **動作確認**: `/auth/login` で新access tokenが発行され、JWTヘッダの `kid` が新KIDであることを確認

### 旧公開鍵を残す場合の条件と期限

- **残す条件**: 旧鍵で署名されたaccess tokenがまだ有効期限内（最大 `ACCESS_TOKEN_TTL_SECONDS` = 600秒）であり、ユーザー体験を損なわないようにする場合
- **期限**: アクセストークンTTL経過後（最大10分）に `AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM` を削除して再デプロイ
- **残さない場合**: 即座に削除して再デプロイ。旧トークンは即座に無効になる

### 確認項目

- `/auth/login` で新access tokenが発行される
- JWTヘッダの `kid` が新KIDである
- `/auth/session/refresh` で既存refresh tokenが有効（refresh tokenはDB管理のため影響なし）

### 復旧完了条件

新しい鍵ペアでトークン発行・検証が正常に動作し、旧鍵で署名されたトークンが期限切れまたは `PREVIOUS_PUBLIC_KEY_PEM` 削除により無効化されること。

---

## 4. JWT秘密鍵の漏えい

> **最優先**: 旧秘密鍵で署名された**偽造トークンを受け入れない**こと。

### 対応手順

1. **即座に新しい鍵ペアを生成**（§3と同じ手順）
2. **KIDを変更**: `AUTH_JWT_KID` を新しい値に変更（例: `key-2026-11-emergency`）
3. **環境変数を更新**:
   - `AUTH_JWT_PRIVATE_KEY_PEM` = 新秘密鍵
   - `AUTH_JWT_PUBLIC_KEY_PEM` = 新公開鍵
   - `AUTH_JWT_KID` = 新KID
   - **`AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM` を削除または空にする**（旧公開鍵を検証対象から外す）
4. **影響を受けた既存セッションの失効**:
   ```sql
   -- 全セッションを失効（漏えい期間中に発行されたトークンを無効化）
   UPDATE sessions SET revoked_at = now(), revoke_reason = 'jwt_key_compromise' WHERE revoked_at IS NULL;
   ```
   または、影響範囲が限定的な場合は該当ユーザーの `token_family_id` 単位で失効
5. **再デプロイ**: Renderで再デプロイ
6. **漏えいした鍵をGit・ログ・チャットに掲載しない**

### 確認項目

- 旧KIDで署名されたトークンが**拒否される**こと（`/auth/session/refresh` で401）
- 新KIDで署名されたトークンが正常に検証されること
- `audit_logs` に `token_reuse_detected` や `session_revoked` が記録されること

### 復旧完了条件

旧秘密鍵で署名されたトークンが一切受け入れられず、新しい鍵ペアでのみトークン発行・検証が行われること。

---

## 5. Redis 停止

### 対応手順

1. `/ops/health` で `redis:"error"` または `redis:"disabled"` を確認
2. Render Key Value の状態を確認（Running / Suspended / Failed）
3. **自動復旧を待つ**: `retryStrategy` で指数バックオフ再接続するため、通常は数分で回復
4. **復旧しない場合**: `REDIS_URL` を一時的に削除して再起動 → メモリ内レート制限にフォールバック（**単一インスタンス限定**）

### 確認項目

- `/ops/health` の `redis` フィールドが `"ready"` になること
- `/auth/login` で503ではなく401/200が返ること
- Redisの `rl:fail:*` / `rl:lock:*` キーが再作成されること

### 復旧完了条件

`/ops/health` が `{"ok":true}` を返し、`/auth/login` が503ではなく正常応答を返すこと。

---

## 6. Render Web Service 再作成

### 対応手順

1. **環境変数の全消失を確認**: Render ダッシュボードで環境変数が空であることを確認
2. **全環境変数を再設定**（`docs/AUTH_SERVER_PRODUCTION.md` §5の一覧を参照）
3. **再デプロイ**: Renderで再デプロイ
4. **ヘルス確認**: `/ops/health` が `{"ok":true}` を返すこと

### 確認項目

- `/ops/health` が `{"ok":true}` を返す
- `/auth/login` でダミーユーザー作成→ログイン成功
- `/auth/register` で新規ユーザー作成→メール確認メールがResend経由で送信される（`MAIL_PROVIDER=resend` 設定時）

### 復旧完了条件

`/ops/health` が `{"ok":true}` を返し、登録・ログイン・メール送信が全て正常に動作すること。

---

## 7. 環境変数の消失

### 対応手順

1. **起動失敗を確認**: `config.ts` の必須チェックで起動拒否される
2. **エラーログで不足変数を特定**: `Missing required env var: XXX` または `XXX is required` のエラーメッセージを確認
3. **環境変数を再設定**: Render ダッシュボードで不足している変数を追加
4. **再デプロイ**: Renderで再デプロイ

### 確認項目

- `/ops/health` が `{"ok":true}` を返す
- 全ての必須環境変数が設定されていること（`docs/AUTH_SERVER_PRODUCTION.md` §5参照）

### 復旧完了条件

`/ops/health` が `{"ok":true}` を返し、サーバーが正常に起動すること。

---

## 8. Resend のメール送信障害

### 対応手順

1. **送信失敗を確認**: `audit_logs` に `*_send_failed` が記録されていることを確認
2. **Resend APIキーの有効性を確認**: Resend ダッシュボードでAPIキーが有効か確認
3. **送信元ドメインのDNS認証を確認**: SPF/DKIMレコードが正しく設定されているか確認
4. **Resend APIのステータスを確認**: [resend.com/status](https://resend.com/status) で障害情報を確認
5. **一時的な代替手段**: `MAIL_PROVIDER=mock` に戻すとメールは送信されないが、アプリケーションは起動する（**本番では非推奨**）

### 確認項目

- `audit_logs` に `email_verify_sent` / `password_reset_sent` / `email_change_sent` が記録されること
- 実際にメールが届くこと（テスト用アドレスで確認）

### 復旧完了条件

Resend APIが正常に応答し、確認メール・パスワードリセットメール・メールアドレス変更メールが実際に送信されること。

---

## 付録：復旧完了の共通判定基準

全ての障害復旧で以下を確認：

1. `/ops/health` が `{"ok":true}` を返す
2. `POST /auth/login` で既存ユーザーがログイン成功
3. `POST /auth/session/refresh` で既存refresh tokenが有効
4. OAuthユーザーが `/auth/oauth/start` → callback → `/auth/token` で再ログイン成功
5. `audit_logs` に `login_success` / `token_issued` が記録される
