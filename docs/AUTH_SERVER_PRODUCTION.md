# BlockWhiz Auth Server 本番デプロイ設計書

> 本書は準備・設計文書です。実際のサーバー公開・ドメイン取得・有料サービス契約は別途承認が必要です。

## 1. 推奨アーキテクチャ

```
[ユーザーPC] ──HTTPS──→ [CDN/WAF: Cloudflare] ──→ [リバースプロキシ: Caddy/nginx]
                                                          │ TLS終端 :443
                                                          ▼
                                                [Auth Server: Node.js]
                                                BIND_HOST=127.0.0.1:8080
                                                TRUSTED_PROXY=loopback
                                                          │
                                              ┌───────────┴───────────┐
                                              ▼                       ▼
                                        [PostgreSQL]            [Redis]
                                        (マネージド・非公開)    (マネージド・非公開)
                                              │
                                              ▼
                                        [メール送信API]
                                        (Resend/SES等・要契約)
```

## 2. コンポーネント別設定

### 2.1 PostgreSQL（本番必須）

| 項目 | 設定 |
|---|---|
| 接続 | `DATABASE_URL=postgres://user:pass@host:5432/dbname` |
| SSL | `DATABASE_SSL=require`（本番デフォルト） |
| ドライバ | `pg`（node-postgres）— `DATABASE_URL` 設定時に自動選択 |
| PGlite | **本番では使用禁止**（`NODE_ENV=production` で `DATABASE_URL` 未設定なら起動拒否） |
| 推奨サービス | Neon / Supabase / AWS RDS / Railway PostgreSQL |
| バックアップ | 日次自動 + PITR（Point-in-Time Recovery） |
| 非公開 | DBポート（5432）をインターネットに公開しない。Auth Serverからのみ接続 |

### 2.2 Redis（レート制限共有）

| 項目 | 設定 |
|---|---|
| 接続 | `REDIS_URL=redis://user:pass@host:6379` または `rediss://`（TLS） |
| 用途 | ログイン試行レート制限の複数インスタンス共有 |
| 未設定時 | メモリ内レート制限（単一インスタンスのみ有効） |
| 障害時 | フェイルクローズ（503 `AUTH_UNAVAILABLE`）— 制限なしでログインを通さない |
| 推奨サービス | Upstash / Redis Cloud / AWS ElastiCache |
| 非公開 | Redisポート（6379）をインターネットに公開しない |

### 2.3 HTTPSリバースプロキシ

Auth Server自体はHTTPのみ。TLS終端はリバースプロキシで行う。

**Caddy例（自動HTTPS）:**
```
auth.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx例:**
```nginx
server {
    listen 443 ssl;
    server_name auth.example.com;
    ssl_certificate /etc/letsencrypt/live/auth.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/auth.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
    }
}
```

### 2.4 BIND_HOST / TRUSTED_PROXY

| 環境 | BIND_HOST | TRUSTED_PROXY | 理由 |
|---|---|---|---|
| 本番（プロキシ同一ホスト） | `127.0.0.1` | `loopback` | プロキシからのX-Forwarded-Forのみ信頼。外部からの直接接続はプロキシ経由のみ |
| 本番（プロキシ別ホスト） | `0.0.0.0` | プロキシIP/CIDR | プロキシのIPのみ信頼。ファイアウォールでプロキシ以外からの8080ポートを遮断 |
| 開発 | `127.0.0.1` | 未設定 | loopbackのみ |

**重要**: `TRUSTED_PROXY` 未設定でリバースプロキシ越しに運用すると、`req.ip` がプロキシIPになりレート制限が全ユーザー共通になる。必ず設定すること。

### 2.5 ドメイン・TLS証明書

| 項目 | 内容 |
|---|---|
| ドメイン例 | `auth.blockwhiz.app` または `api.blockwhiz.com` |
| 親ドメイン | 既存ドメインのサブドメインなら追加費用なし。新規取得は ~$10-15/年 |
| TLS証明書 | Let's Encrypt（Caddy自動 or certbot）。無料・自動更新 |
| DNS | `auth.example.com` → サーバーIP（Aレコード） |

## 3. JWT鍵管理

### 3.1 鍵の生成

```bash
# RSA 2048-bit 鍵ペア生成（例）
openssl genrsa -out jwt-private.pem 2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

### 3.2 環境変数設定

```bash
# 現行鍵
AUTH_JWT_PRIVATE_KEY_PEM="$(cat jwt-private.pem)"
AUTH_JWT_PUBLIC_KEY_PEM="$(cat jwt-public.pem)"
AUTH_JWT_KID="key-2025-01"          # 鍵ID（ローテーション識別用）

# ローテーション中のみ: 旧公開鍵（検証専用）
AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM="$(cat jwt-public-old.pem)"
```

### 3.3 ローテーション手順

1. **新鍵ペア生成**: `openssl genrsa` + `openssl rsa -pubout`
2. **デプロイ**: 新 `AUTH_JWT_PRIVATE_KEY_PEM`/`PUBLIC_KEY_PEM`/`KID` を設定、旧公開鍵を `AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM` に設定
3. **移行期間**: アクセストークンTTL（600秒）経過後、旧鍵で署名されたトークンは全て期限切れ
4. **旧鍵削除**: `AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM` を削除して再デプロイ

**制約**: リフレッシュトークンはJWTではなくDB管理のため、鍵ローテーションの影響を受けない。アクセストークンのみが影響。

## 4. メール送信（Resend）

| 項目 | 設定 |
|---|---|
| 開発/テスト | `MAIL_PROVIDER=mock`（既定）— `data/mail-outbox.jsonl` に記録。実メールは送信されない |
| 本番 | `MAIL_PROVIDER=resend` — **必須**。`mock`・未設定・未対応プロバイダは起動拒否 |
| 実装 | `src/mailer.ts` の `ResendMailer`（公式 `resend` Node.js SDK使用） |

### Resend 設定手順

1. [resend.com](https://resend.com) でアカウント作成・APIキー発行
2. **送信元ドメインのDNS認証**: Resendダッシュボードでドメインを追加し、表示される SPF/DKIM レコードをDNSに設定して認証を完了させる（未認証ドメインからは送信不可）
3. Render等の環境変数に以下を設定:

```bash
MAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxx        # Resendダッシュボードで発行
MAIL_FROM=BlockWhiz <noreply@your-domain.com>   # 認証済みドメインのアドレス
MAIL_REPLY_TO=support@your-domain.com           # 任意
```

4. `AUTH_PUBLIC_URL` が正しいHTTPS URLであることを確認（メール内リンクの基点）

### セキュリティ注意

- **`RESEND_API_KEY` はRender等のシークレット管理にのみ設定する。GitHub・ソースコード・`.env.example`・チャットに絶対に書かない**
- APIキーがエラーログに出力されないことをテストで確認済み（`tests/resend.test.mjs`）
- 送信失敗時は監査ログ（`*_send_failed`）に記録されるが、API応答は列挙防止のため成功のまま。ユーザーは「確認メールを再送」「パスワード再設定の再リクエスト」で再試行可能
- Resend API呼び出しには **10秒のタイムアウト**（`AbortSignal.timeout`）を設定済み。タイムアウト時も送信失敗として監査ログに記録される

### 送信メール種別

| 用途 | トリガー | 内容 |
|---|---|---|
| メールアドレス確認 | 登録後・`/auth/email/verify/request`・メールアドレス変更 | 確認リンク（24時間有効） |
| パスワードリセット | `/auth/password/reset/request` | リセットリンク（30分有効） |

いずれもプレーンテキスト＋HTMLのマルチパートで送信。日本語対応。

## 5. 環境変数一覧（本番）

> **重要**: `NODE_ENV` は `production` と**完全一致**で判定される。
> `Production`・`staging`・未設定・その他の値は**全て開発モード扱い**になり、
> JWT自動生成・PGlite許容・mockメール許容・HSTS無効など本番保護が全て無効化される。
> Render等の環境変数には必ず `NODE_ENV=production` を**小文字で正確に**設定すること。

```bash
NODE_ENV=production                  # 必須・完全一致。開発モードへの誤設定は静かに全保護を無効化する
PORT=8080
BIND_HOST=127.0.0.1                  # プロキシ同一ホストの場合
TRUSTED_PROXY=loopback               # プロキシ同一ホストの場合
AUTH_PUBLIC_URL=https://auth.example.com
DATABASE_URL=postgres://...
DATABASE_SSL=require
REDIS_URL=redis://...
AUTH_JWT_PRIVATE_KEY_PEM=...
AUTH_JWT_PUBLIC_KEY_PEM=...
AUTH_JWT_KID=key-2025-01
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# AUTH_DEV_INSECURE_HTTP は本番では設定しない
# メール（本番必須: mock/未設定は起動拒否）
MAIL_PROVIDER=resend
RESEND_API_KEY=...
MAIL_FROM=BlockWhiz <noreply@your-domain.com>
# MAIL_REPLY_TO=...（任意）
```

## 6. デスクトップ側設定

```bash
# ユーザー環境変数またはアプリ設定
CRAFTMATE_AUTH_URL=https://auth.example.com
```

- https必須。httpは127.0.0.1/localhostのみ許可（開発用）
- 未設定時はクラウド認証フォーム非表示・503応答

## 7. 運用・監視

| 項目 | 内容 |
|---|---|
| ヘルスチェック | `GET /ops/health` — DB/Redis実接続確認。本番は `{ok:true}` のみ返却 |
| 監視 | UptimeRobot / Better Stack 等で `/ops/health` を外部監視 |
| ログ | `console.log`/`console.error` — トークン・パスワード・秘密鍵は出力しない設計 |
| 監査ログ | `audit_logs` テーブルに全認証イベントを記録（user_id, event, ip, ua, metadata） |
| バックアップ | PostgreSQL日次 + Redis不要（揮発性データのみ） |
| 障害時 | Auth Server停止→デスクトップは既存セッション継続・新規ログイン不可 |

## 8. アカウント削除データ保持

| データ | 保持期間 | 削除方法 |
|---|---|---|
| `users` 行 | `deleted_at` + 30日 | `purgeDeletedUsers()` が日次実行（`ACCOUNT_PURGE_DAYS`で変更可、0で無効） |
| `sessions` | 削除時に即時失効 | パージ時に物理削除 |
| `external_identities` | パージ時に物理削除 | OAuth連携情報も削除 |
| `email_tokens` | パージ時に物理削除 | 未使用トークンも削除 |
| `audit_logs` | **保持** | `user_id` を NULL にして証跡のみ残す（個人情報は users 行ごと消える） |
| `oauth_flows`/`oauth_codes` | パージ時に物理削除 | 進行中フローも削除 |

## 9. Docker デプロイ（Phase I）

### 9.1 イメージビルド

```bash
cd auth-server
docker build -t craftmate-auth-server .
```

- マルチステージビルド：`npm ci` → `tsc` → `npm prune --omit=dev` で本番依存のみ
- 非rootユーザー `node` で実行。`.dockerignore` で `.env`/`*.pem`/`data/`/`tests/`/`node_modules` を除外（秘密情報はイメージに含まれない）
- 起動コマンド: `node dist/index.js`（`npm start` 相当）

### 9.2 起動例

```bash
# VPS + 同一ホストCaddy（TLS終端はCaddy）
docker run -d --name craftmate-auth \
  --env-file /etc/craftmate-auth.env \
  -p 127.0.0.1:8080:8080 \
  --restart unless-stopped \
  craftmate-auth-server
```

- `-p 127.0.0.1:8080:8080` でホストのloopbackのみに公開。外部からの直接アクセスは不可
- 環境変数は `--env-file` またはプラットフォームのシークレット機能で注入（`auth-server/.env.example` 参照）

### 9.3 ヘルスチェック・ログ・停止

```bash
# ヘルスチェック（コンテナ内 or プロキシ経由）
curl -f http://127.0.0.1:8080/ops/health   # → {"ok":true}

# ログ（トークン・パスワード・秘密鍵は出力されない設計）
docker logs -f craftmate-auth

# 安全な停止（SIGTERM → graceful shutdown、10秒猶予）
docker stop craftmate-auth    # または docker compose down
docker compose down           # compose利用時
```

## 10. ネットワーク設定の注意点（構成別）

### 10.1 VPS + Caddy同一ホスト（推奨・最も単純）

| 項目 | 設定 |
|---|---|
| `BIND_HOST` | `127.0.0.1`（コンテナ内もホストもloopbackのみ） |
| `TRUSTED_PROXY` | `loopback`（Caddyが同一ホストから接続） |
| ポート公開 | `-p 127.0.0.1:8080:8080` — ホスト外部には非公開 |
| TLS | Caddyが443で終端→80/8080へプロキシ |

### 10.2 コンテナ型PaaS（Railway/Render/Fly.io等）

**VPS用設定をそのまま流用しないこと。** PaaSでは外部プロキシがコンテナのプライベートネットワーク経由で接続するため：

| 項目 | 設定 |
|---|---|
| `BIND_HOST` | `0.0.0.0`（プラットフォームがコンテナへルーティングするため必須。PaaSのドキュメントを確認） |
| `TRUSTED_PROXY` | **Render の場合は `render`**（X-Forwarded-For 先頭をクライアントIPとして採用。Renderが先頭を実クライアントIPに設定するため安全）。その他PaaSはプラットフォーム指定のプロキシIP/CIDR。**`true`/`all` は使用不可**（バリデータが拒否） |
| ポート公開 | PaaSが管理（独自のファイアウォール/ingress）。`0.0.0.0` bind はPaaS内では安全だが、VPSでの `0.0.0.0` は危険 |
| TLS | PaaSが自動終端（独自ドメインをアタッチ） |

> `0.0.0.0` を「とりあえず」で設定しない。VPSでは外部直アクセスを許してしまい、`TRUSTED_PROXY` 未設定と組み合わさるとレート制限がプロキシIP単位になり全ユーザー共通化する。

### 10.3 PostgreSQL / Redis の非公開

- **絶対にインターネットへ公開しない**（5432/6379ポートを外部に開放しない）
- VPS構成：DB/Redisは同一VPSのloopback、またはマネージドサービスのTLS+認証経由
- PaaS構成：プラットフォームの内部ネットワークまたはマネージドアドオン経由
- `DATABASE_SSL=require`・`rediss://`（Redis TLS）を使用

## 11. 未解決・今後の課題

- [ ] 実メール送信プロバイダの実装（Resend/SES等）
- [ ] 実PostgreSQL/Redisでの結合テスト
- [ ] GitHub/Discord OAuth プロバイダ追加
- [ ] レート制限の `/auth/register` への拡張
- [ ] `/auth/password/change` へのレート制限追加
- [ ] メール確認の必須化ポリシー決定

## 12. バックアップ・復旧

### 12.1 PostgreSQL バックアップ

#### 対象データ（`db.ts` スキーマ）

| テーブル | 復旧重要度 | 消失時の影響 |
|---|---|---|
| `users` | Critical | 全ユーザー消失（password_hashは復元不可） |
| `external_identities` | Critical | OAuthユーザーが別ユーザーとして再作成される |
| `sessions` | High | 全ユーザー強制ログアウト（再ログインで回復） |
| `oauth_flows`/`oauth_codes`/`email_tokens` | Low | 進行中フロー・送信済みリンクが無効化（再送で回復） |
| `audit_logs` | Medium | 監査証跡の欠落 |

#### 論理バックアップ（pg_dump）

```bash
# フルダンプ（論理バックアップ）
pg_dump "$DATABASE_URL" --format=custom --file=authserver_$(date +%Y%m%d).dump

# 復元
pg_restore --clean --if-exists --dbname="$DATABASE_URL" authserver_YYYYMMDD.dump
```

> **検証状況（Phase X / PostgreSQL 16.15）**: 空の別DBへの `pg_restore --no-owner --no-privileges` は実証済み（7テーブル件数・69カラム・20インデックス・15制約が完全一致）。一方 `--clean --if-exists` による**既存DB上書きは未検証**。復旧時は可能な限り「空DBへ復元→接続先切替」を優先し、上書きが必要な場合は事前に別DBで検証すること。詳細は `docs/AUTH_SERVER_RUNBOOK.md` §2 を参照。

- **頻度**: 日次を推奨（Beta規模なら十分）。大きな変更作業前にも手動取得
- **保管先**: 暗号化されたオフラインストレージ（例: `gpg -c` で暗号化したうえでバックアップ保管場所へ）。**Git・Docker image・アプリ配布物に含めない**
- **世代管理**: 日次7世代＋週次4世代を目安にローテーション。古いダンプは暗号化したまま保管
- **整合性確認**: 復元後に `SELECT count(*) FROM users; SELECT count(*) FROM external_identities;` で行数一致を確認し、`/ops/health` が `{"ok":true}` を返すこと

#### Render PostgreSQL の場合

- **PITR（Point-in-Time Recovery）**: 有料プランで利用可能。任意時点への復元が可能だが、無料枠では使用不可
- **スナップショット**: 有料プランでダッシュボードから手動取得可能
- **pg_dump**: 内部URL経由で直接実行可能。外部URL（`postgresql://`）でも可
- **注意**: Render無料PGは作成後30日で失効するため、バックアップを取ってもDB自体が消える。**有料プランへの移行が前提**

### 12.2 PostgreSQL 復旧手順

1. **新しいDBを用意**（Render新規PG or 復元先）
2. **ダンプをリストア**: `pg_restore --clean --if-exists --dbname="$NEW_DATABASE_URL" backup.dump`
3. **環境変数更新**: `DATABASE_URL` を新DBの接続文字列に変更
4. **再デプロイ**: Renderで再デプロイまたは環境変数更新で自動再起動
5. **ヘルス確認**: `/ops/health` が `{"ok":true}` を返すこと
6. **整合性確認**:
   - `SELECT count(*) FROM users` — 復元前の行数と一致
   - `SELECT count(*) FROM external_identities` — OAuth紐付けが保持されていること
   - `SELECT count(*) FROM audit_logs WHERE user_id IS NULL` — 削除済みユーザーの監査証跡が残っていること
7. **動作確認**: 既存ユーザーで `/auth/login` → `/auth/session/refresh` → OAuth ユーザーで `/auth/oauth/start` → callback → `/auth/token`

### 12.3 Redis / Key Value 障害

#### Redis停止時にログインが503になる理由

`redis.ts` で `REDIS_URL` 設定時にRedis接続を確立。`ratelimit.ts` の `checkLoginLimit` は `redisStatus() !== 'ready'` の場合 `'unavailable'` を返し、`server.ts` の `/auth/login` は `limit === 'unavailable'` で **503 `AUTH_UNAVAILABLE`** を返す。これは「レート制限なしで通さない」フェイルクローズ設計。

#### 再接続後の確認方法

1. `/ops/health` の `redis` フィールドが `"ready"` になることを確認
2. `/auth/login` でダミー認証情報を送信し、503ではなく401/200が返ることを確認
3. Redisの `rl:fail:*` / `rl:lock:*` キーが再作成されることを確認（`redis-cli KEYS 'rl:*'`）

#### Redisを一時的に利用できない場合の運用注意

- `REDIS_URL` を**一時的に削除**して再起動すると、メモリ内レート制限にフォールバック（`ratelimit.ts` の `memCheck`/`memFail`/`memClear`）。**単一インスタンス限定**であり、複数インスタンスでは各インスタンスが独立したカウンタを持つため制限が実質無効化される
- Render Key Value がスリープ中は `redisStatus()` が `error` のまま → ログインが503を返し続ける。**Key Value のスリープ解除を待つか、有料プランへの移行を検討**

### 12.4 Render 復旧

#### Web Service 再作成時

環境変数が全て消失するため、以下を再設定：

```bash
NODE_ENV=production
BIND_HOST=0.0.0.0
TRUSTED_PROXY=render
AUTH_PUBLIC_URL=https://<service>.onrender.com
DATABASE_URL=<Render Postgres 内部URL>
DATABASE_SSL=<実測に基づく値>
REDIS_URL=<Render Key Value 内部URL>
AUTH_JWT_PRIVATE_KEY_PEM=<PEM>
AUTH_JWT_PUBLIC_KEY_PEM=<PEM>
AUTH_JWT_KID=key-1
GOOGLE_CLIENT_ID=<本番値>
GOOGLE_CLIENT_SECRET=<本番値>
MAIL_PROVIDER=resend
RESEND_API_KEY=<APIキー>
MAIL_FROM=BlockWhiz <noreply@your-domain.com>
# MAIL_REPLY_TO=（任意）
```

#### PostgreSQL 復元後の接続先更新

- `DATABASE_URL` を新しいPGの内部URLに更新
- `DATABASE_SSL` が新インスタンスのTLS要件に合致するか確認（`disable`/`prefer`/`require`）

#### Redis 再作成後の接続先更新

- `REDIS_URL` を新しいKey Valueの内部URLに更新
- `rediss://`（外部）か `redis://`（内部）かを接続経路に応じて選択

#### /ops/health による復旧確認

`GET /ops/health` が `{"ok":true}` を返すことを全復旧シナリオの完了条件とする。
