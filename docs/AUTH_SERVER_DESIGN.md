# CraftMate 公式認証サーバー設計書（改訂版 v2.2）

> 目的：OAuth Client Secret をデスクトップアプリに同梱せず、世界中の一般ユーザーが Google / GitHub / Discord でログインできる「CraftMate 公式アカウント」基盤を導入する。
>
> 本書は設計のみ。実装・DB変更・リリースは別途承認後に行う。
>
> **v2 改訂点**：セキュリティレビューを受け、デスクトップへの認証結果受け渡しを「ワンタイム認可コード方式」に変更。Refresh Token 再利用検知・ローテーション・障害時動作・アカウント削除・既存ユーザー連携の具体的手順を追加。
>
> **v2.1 改訂点**：最終セキュリティ確認を受け、以下を確定・修正。
> - 第2PKCE（token PKCE）を**必須化**（推奨→必須、互換経路なし）
> - 127.0.0.1 コールバックのバインド・Host 検証・ポート競合・外部公開防止を具体化
> - token_history を「セッション有効期間中は全世代保持」に変更（5世代制限の検知漏れを解消）
> - 127.0.0.1 コールバックのポート・redirect_uri検証・state検証タイミング・リスナー終了・横取り対策を具体化
> - Refresh Token の世代管理・ローテーションの原子性・ファミリー単位失効を明確化
> - oauth_flows/oauth_codes は PostgreSQL を正本とし Redis はキャッシュのみに限定（二重発行・状態不整合の防止）
> - jti 失効リストのオフライン時動作を明記（Auth Server 停止中は失効確認不可、Access Token 期限まで継続は許容リスクとして明記）

---

## 1. 現状実装の調査結果

### 1.1 OAuth プロバイダ（`src/integrations.ts`）

| Provider | 認可URL | トークンURL | スコープ | PKCE | nonce |
|---|---|---|---|---|---|
| google | accounts.google.com/o/oauth2/v2/auth | oauth2.googleapis.com/token | `openid email profile` + `access_type=offline` | ✅ S256 | ✅（OIDC 検証: JWKS署名+iss+aud+exp+nonce） |
| github | github.com/login/oauth/authorize | github.com/login/oauth/access_token | `read:user user:email` + `allow_signup=false` | ✅ | ❌（`api.github.com/user` でID取得） |
| discord | discord.com/oauth2/authorize | discord.com/api/oauth2/token | `identify email` | ✅ | ❌（`/users/@me` でID取得） |

- state：32文字ランダム、サーバー側 `pendingOAuth` Map で保持、**10分で期限切れ**
- code_verifier はコールバックまでメモリ内のみ保持（永続化しない）
- clientId 解決順：**リクエスト指定 > 環境変数 > oauth-clients.json**
- トークン交換は `client_secret` を body（GitHub は Basic 認証ヘッダ）で送信

### 1.2 アカウント構造（`src/db.ts`）

- `local_users`：内部アカウント（username + scrypt ハッシュ）。OAuth不要のフォールバック
- `external_identities`：`PRIMARY KEY (provider, provider_user_id)` → `craftmate_user` への所有者マッピング。**所有権は一度紐付いたら変更しない**（多層防御）
- `craftmate_user` 識別子：`oauth:{provider}:{providerUserId}` / `local:{username}` / `oauth:{provider}`（旧形式）
- `integrations` テーブル：`__auth_session` 行にセッションを AES-256-GCM 暗号化して保存。鍵は `%LOCALAPPDATA%\CraftMate\integrations.key`
- その他 `integrations` 行：Google/GitHub/Discord の連携トークンも同様に暗号化保存。refresh_token による自動更新機構あり

### 1.3 セッション管理

- セッションは DB 内 `__auth_session`（暗号化JSON：provider, account, craftmateUser, loginAt, expiresAt）
- `expiresAt`：トークンに期限がある場合のみ設定。内部アカウントは `null`（無期限）
- ローカルHTTPサーバー前提のため Cookie/CSRF トークンは未使用。`isLocalUpdateRequest` でローカル由来リクエストのみ許可
- ログアウト：`__auth_session` 行を削除

### 1.4 ログイン vs 外部連携の違い

| | ログイン（`/api/auth/login/:platform`） | 連携（`/api/integrations/:platform/connect`） |
|---|---|---|
| 目的 | CraftMate アカウントでログイン | ログイン中アカウントへ外部IDを追加紐付け |
| 前提 | 不要 | **ログイン済みセッション必須**（`AUTH_REQUIRED`） |
| pendingOAuth キー | `login:{provider}` | `{provider}` |
| craftmateUser | `external_identities` の所有者 or 新規 `oauth:{provider}:{id}` | セッションの `craftmateUser` に紐付け |

### 1.5 デスクトップアプリの通信方式

- ローカル Web サーバー（既定 `127.0.0.1:3000`、`WEB_PORT` で変更可）が API とダッシュボード静的ファイルを配信
- Electron シェルが `http://127.0.0.1:3000` を `loadURL`（`electron/main.js`）
- **外部への通信は OAuth プロバイダ API のみ**。認証サーバー導入後はここに Auth Server への通信が加わる
- ブラウザからも `127.0.0.1` 経由でアクセス可能（`isLocalUpdateRequest` で保護）

### 1.6 i18n

`public/i18n.js` に日本語・英語・韓国語・スペイン語・インドネシア語の辞書が既存。UI文言は辞書経由のため、新規画面も同方式で多言語対応可能。

---

## 2. 設計方針

### 2.1 基本コンセプト：「CraftMate Auth Server」

```
[Desktop App] ──HTTPS──> [Auth Server (クラウド)] ──> Google/GitHub/Discord
     │                        │
     │  ① auth code + PKCE    │  ② 認可コード交換（Secretはサーバー側のみ）
     │  ③ ワンタイムコード     │
     ▼                        ▼
  ローカルDBにセッション保存   ユーザーDB (クラウド)
```

- **Client Secret は Auth Server のみが保持**。デスクトップアプリは公開可能な Client ID / PKCE のみを扱う
- OAuth の認可コード交換・トークン管理はサーバー側で完結し、**外部プロバイダのアクセストークンをデスクトップに渡さない**（必要最小限のユーザー情報のみ返す）
- CraftMate アカウント = クラウド上のユーザーID。外部ID連携は `external_identities` をクラウドDBに移植

### 2.2 なぜローカル完結型から移行するか

| 課題 | 現状 | Auth Server 導入後 |
|---|---|---|
| Client Secret 配布 | ユーザーが各自 OAuth App 登録必須 | **不要**（運営が一括登録） |
| 一般ユーザーの敷居 | 高い（開発者コンソール操作が必要） | **低い**（ワンクリック） |
| アカウントの引き継ぎ | 端末ローカルのみ | クラウド同期可能 |
| セキュリティ | Secret が端末に存在し得る | Secret はサーバーのみ |

---

## 3. 認証サーバー構成

### 3.1 推奨構成

```
┌─────────────────────────────────────────┐
│  CraftMate Auth Server                  │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ API (REST)│  │ OAuth Broker│ │ Admin │ │
│  │ /v1/*    │  │ /oauth/*  │  │ /ops  │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       └──────────────┼────────────┘      │
│              ┌───────▼────────┐          │
│              │  PostgreSQL    │          │
│              │  (ユーザーDB)  │          │
│              └────────────────┘          │
│  Redis (OAuth state/nonce・レート制限)    │
└─────────────────────────────────────────┘
```

- **API**: Node.js (Express/Fastify) または Go。既存コードが TypeScript のため Node.js が自然
- **DB**: PostgreSQL（ユーザー・外部ID・監査ログ）。**Refresh Token・セッションは PostgreSQL に永続化**（Redis 障害時も認証継続可能にするため）
- **Redis**: OAuth state/nonce・レート制限カウンタなど**揮発性データのみ**。Redis 停止時は DB フォールバックまたは機能縮退
- **HTTPS 必須**: 全通信 TLS 1.2+

### 3.2 OAuth Broker の役割

デスクトップアプリの代わりに各プロバイダと OAuth フローを行う中継層。

- 各プロバイダの Client Secret を環境変数/Secret Manager で管理
- 認可コード → トークン交換 → ユーザー情報取得 → CraftMate ユーザー解決、までをサーバー側で実行
- デスクトップには **ワンタイム認可コード** のみ返す（トークンは返さない）

### 3.3 代替案の比較

| 案 | メリット | デメリット |
|---|---|---|
| **A. フルマネージド Auth (Auth0/Firebase/Supabase)** | 実装最小、運用不要 | コスト、ベンダーロックイン、カスタマイズ制限 |
| **B. 自前 Auth Server (推奨)** | 完全制御、コスト最小化可能 | 運用・セキュリティ責任は自前 |
| C. ハイブリッド | Firebase Auth + 独自API | 複雑さ増、結局サーバー必要 |

**推奨：B（自前）**。理由：CraftMate の規模ではマネージドのオーバーヘッドが大きく、既存の暗号化・監査設計を流用できる。将来的に負荷が増えたら A への移行も可能な API 設計とする。

---

## 4. API 設計

ベース URL：`https://auth.craftmate.app/v1`（仮）

### 4.1 認証フロー系

| Method | Path | 説明 |
|---|---|---|
| POST | `/auth/oauth/start` | OAuth フロー開始。provider 指定で認可URLを返す |
| GET | `/auth/oauth/callback/:provider` | プロバイダからのコールバック。code交換・ユーザー解決・ワンタイムコード発行 |
| POST | `/auth/token` | ワンタイムコード → Access/Refresh Token 交換 |
| POST | `/auth/session/refresh` | Refresh Token で Access Token 再発行 |
| POST | `/auth/logout` | セッション無効化（Refresh Token 失効） |
| GET | `/auth/me` | 現在のユーザー情報取得 |

#### `POST /auth/oauth/start`

```json
// Request
{
  "provider": "google|github|discord",
  "redirectUri": "http://127.0.0.1:PORT/api/auth/callback",  // ローカルコールバック（推奨）
  "deviceId": "device-uuid"                                  // デバイス識別（任意）
}
// Response
{
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "flowId": "flw_abc123"                                     // フロー追跡用ID
}
```

#### `GET /auth/oauth/callback/:provider`

プロバイダからのリダイレクトを受け、以下を実行：

1. `state` 検証（Redis/DB に保存した値と照合、ワンタイム使用）
2. `code` + `code_verifier` でトークン交換（**Client Secret はサーバー側のみ使用**）
3. ユーザー情報取得（`sub`/`id` 等のプロバイダ固有ID）
4. `external_identities` で既存ユーザー解決 or 新規作成
5. **ワンタイム認可コード発行**（有効期限60秒、1回限り使用）
6. デスクトップへリダイレクト：
   - **推奨**：`http://127.0.0.1:{port}/api/auth/callback?code=xxx&state=yyy`（ローカルサーバーが直接受信）
   - **代替**：`craftmate://auth/callback?code=xxx&state=yyy`（カスタムスキーム）

#### `POST /auth/token`

```json
// Request（デスクトップ → Auth Server、TLS経由）
{
  "code": "one_time_auth_code",    // ワンタイム認可コード（60秒有効・1回限り）
  "tokenCodeVerifier": "...",      // 必須: デスクトップ側PKCE verifier（第2PKCE）
  "state": "...",                  // デスクトップが生成したstate（ローカルコールバック時）
  "deviceId": "device-uuid",
  "deviceName": "Windows PC"
}
// Response
{
  "accessToken": "eyJ...",         // JWT、10分有効（実装デフォルト600秒）
  "refreshToken": "rfr_...",       // 不透明トークン、30日有効
  "tokenType": "Bearer",
  "expiresIn": 600,
  "user": {
    "id": "usr_...",
    "displayName": "...",
    "email": "...",
    "provider": "google"
  }
}
```

### 4.2 外部アカウント連携系

| Method | Path | 説明 |
|---|---|---|
| GET | `/integrations` | 連携済みプロバイダ一覧 |
| POST | `/integrations/:provider/connect` | 外部アカウント連携開始（要ログイン） |
| DELETE | `/integrations/:provider` | 連携解除 |

※ 既存の「連携」機能（`purpose != login`）も同じ OAuth Broker を利用。ログイン済みセッションの `craftmateUser` に紐付ける。

### 4.3 ユーザー管理系

| Method | Path | 説明 |
|---|---|---|
| GET | `/users/me` | プロフィール取得 |
| PATCH | `/users/me` | プロフィール更新 |
| DELETE | `/users/me` | アカウント削除（GDPR対応、30日猶予） |
| GET | `/users/me/export` | データエクスポート（GDPR対応） |

### 4.4 管理系（内部向け）

| Method | Path | 説明 |
|---|---|---|
| GET | `/ops/health` | ヘルスチェック |
| GET | `/ops/metrics` | メトリクス |
| POST | `/ops/users/:id/suspend` | ユーザー停止 |
| POST | `/ops/users/:id/unsuspend` | ユーザー停止解除 |

---

## 5. OAuth 認証フロー詳細

### 5.1 全体シーケンス（推奨：ローカルコールバック方式）

```
Desktop App          Auth Server           Google/GitHub/Discord
    │                    │                        │
    │─ POST /auth/oauth/start ──>│                │
    │   {provider, redirectUri}  │                │
    │                    │─ PKCE生成、state+nonce を Redis/DB 保存 (TTL 10min)
    │<── {authUrl, flowId} ──────│                │
    │                    │                        │
    │── ブラウザで authUrl を開く ──────────────────>│
    │                    │<── ユーザー認証 ─────────│
    │                    │<── GET /callback?code&state│
    │                    │─ state 検証（ワンタイム） │
    │                    │─ code + verifier + SECRET で token交換 ──>│
    │                    │<── access_token + userinfo│
    │                    │─ external_identities でユーザー解決      │
    │                    │─ ワンタイムコード発行 (60秒)               │
    │<── GET 127.0.0.1:{port}/api/auth/callback?code=xxx&state=yyy ──│
    │                    │                        │
    │─ POST /auth/token {code, deviceId} ──>│      │
    │                    │─ コード検証（ワンタイム・60秒）           │
    │<── {accessToken, refreshToken, user} ─│     │
    │                    │                        │
    │─ ローカルDBにセッション保存（既存 __auth_session 形式流用）    │
```

### 5.2 デスクトップへの認証結果受け渡し（重要・改訂）

#### 問題：craftmate:// URL にトークンを含める危険性

v1 設計では `craftmate://auth/callback?token=xxx` でトークンを直接渡していたが、以下のリスクがある：

- **URL はブラウザ履歴・ログ・プロキシに残る**：Access Token/Refresh Token が漏洩する可能性
- **カスタムスキームは他アプリが登録可能**：悪意あるアプリが `craftmate://` を横取りする可能性（特に Windows/Linux）
- **URL 長制限**：JWT + Refresh Token で URL が長くなりすぎる可能性

#### 推奨設計：ワンタイム認可コード方式

```
Auth Server → Desktop: craftmate://auth/callback?code=ONE_TIME_CODE&state=STATE
Desktop → Auth Server: POST /auth/token {code: "ONE_TIME_CODE", ...}
Auth Server → Desktop: {accessToken, refreshToken, user}
```

**ワンタイムコードの仕様**：

| 項目 | 値 |
|---|---|
| 形式 | `otc_` + 32バイト乱数（base64url） |
| 有効期限 | **60秒** |
| 使用回数 | **1回限り**（使用後即削除） |
| 保存場所 | **PostgreSQL `oauth_codes` を正本**。Redis は読み取りキャッシュのみ（TTL 60秒）。キャッシュと DB の不整合時は DB を優先 |
| 紐付け | `state` + `flow_id` + `redirect_uri` + `device_id` |
| 交換時検証 | `state` 一致、`redirect_uri` 一致、未使用、期限内 |

**セキュリティ効果**：

- URL に含まれるのは **60秒で失効するワンタイムコードのみ**（トークンは含まない）
- コードを傍受されても、60秒以内に正規デスクトップが `/auth/token` で交換しないと無効
- `state` による CSRF 対策は維持
- `device_id` による紐付けで、別デバイスでのコード悪用を防止

#### craftmate:// vs 127.0.0.1 コールバックの比較

| 方式 | メリット | デメリット | 推奨度 |
|---|---|---|---|
| **127.0.0.1:{port}/callback** | OS標準、追加設定不要、URLにコードのみ | ポート番号をAuth Serverに伝える必要、WEB_PORT変更時に対応必要 | **◎ 推奨** |
| craftmate://auth/callback | ポート不要、OS深いリンク対応 | カスタムスキーム登録が必要、他アプリによる横取りリスク、URL検証が複雑 | ○ 代替 |
| デスクトップがポーリング | コールバック不要 | UX悪い（数秒待機）、サーバー負荷増 | △ 非推奨 |

**推奨：127.0.0.1 コールバックを主軸、craftmate:// をフォールバック**

```
優先順位：
1. http://127.0.0.1:{WEB_PORT}/api/auth/callback?code=xxx&state=yyy
   └─ 既存のローカルWebサーバーが直接受信。追加設定不要。
   └─ WEB_PORT は起動時に決定されるため、/auth/oauth/start 時に redirectUri として送信。

2. craftmate://auth/callback?code=xxx&state=yyy
   └─ ローカルサーバーが応答しない場合のフォールバック。
   └─ Electron の setAsDefaultProtocolClient で登録。
```

#### 5.2.1 127.0.0.1 コールバックの詳細仕様（v2.1 で確定）

| 項目 | 仕様 |
|---|---|
| **ポート** | `WEB_PORT`（既定3000）を使用。**エフェメラルポートは使わない**（redirect_uri の安定性・ファイアウォール許可リストの観点） |
| **redirect_uri 検証** | `/auth/oauth/start` で受け取った `redirectUri` を `http://127.0.0.1:{port}/api/auth/callback` の形式で**完全一致検証**。`oauth_flows.redirect_uri` に保存し、コールバック時に照合。他のパス・クエリ・ホストは拒否 |
| **state 検証タイミング** | **2段階**：(1) Auth Server がプロバイダコールバックで `state` を検証（oauth_flows.state と照合）(2) デスクトップがローカルコールバック受信時に `state` を照合（デスクトップ側で生成した state を保持） |
| **リスナー終了** | 認証完了（コールバック受信 or タイムアウト10分 or エラー）で待受を終了。既存のローカルWebサーバーのルートとして実装するため、常駐リスナーの追加は不要 |
| **他ローカルプロセスによる横取り対策** | ① `state` がデスクトップ側で生成・保持されるため、他プロセスがコールバックを偽装しても `state` が一致しない ② ワンタイムコードは60秒・1回限り ③ `device_id` + **`tokenCodeVerifier`（第2PKCE・必須）** で紐付け — 別プロセスがコードを取得しても verifier が無ければ `/auth/token` で交換不可 ④ `isLocalRequest` によるローカルIP検証は既存実装を流用するが**認証の唯一の根拠にはしない**（下記参照） |
| **待受バインド** | callback は **127.0.0.1 のみにバインド**。`0.0.0.0` / `::` / LAN IP では待ち受けない。既存 Web サーバーが全インターフェースで listen している場合（`server.listen(port)` はホスト未指定＝全IF）は、**callback ルート側で `req.socket.remoteAddress` が loopback であること + `Host` ヘッダが `127.0.0.1`/`localhost` であることを必須検証**し、外部からのアクセスを拒否する |
| **ポート使用中** | `EADDRINUSE` 時は**安全に失敗**（他プロセスのポートを奪わない・既存サーバーの再利用を試行）。CraftMate 起動時にポート競合がある場合はユーザーに通知 |
| **Host ヘッダ検証** | `Host: 127.0.0.1:{port}` または `localhost:{port}` のみ許可。DNS rebinding 対策として外部ドメインの Host は拒否 |
| **外部公開の防止** | 既存 Web サーバーが `0.0.0.0` で listen していても、`/api/auth/callback` は remoteAddress=loopback + Host=loopback の両方を満たさない限り 403 を返す。`craftmate://` フォールバック時も同様に第2PKCE が適用される |
| **craftmate:// フォールバックの PKCE** | craftmate:// でも同じワンタイムコード + state + **`tokenCodeVerifier`（第2PKCE・必須）** が適用される。PKCE はデスクトップ↔サーバー間の `/auth/token` で検証されるため、コールバック方式に依存しない |

#### 5.2.2 デスクトップ↔サーバー間の第2 PKCE（v2.2 で**必須化**）

プロバイダ向け PKCE（Auth Server が生成・管理）とは**別系統**として、デスクトップ↔Auth Server 間のトークン交換にも PKCE を**必須**で適用する。

**用語の区別**：

| 名称 | 方向 | 生成者 | 用途 |
|---|---|---|---|
| プロバイダ向け PKCE | Desktop → Provider（Auth Server 経由） | Auth Server | プロバイダの認可コードを Auth Server が交換する際の保護 |
| **第2 PKCE（token PKCE）** | Desktop ↔ Auth Server | **Desktop** | ワンタイムコードを `/auth/token` で交換する際の保護 |

**仕様（必須・互換経路なし）**：

```
1. Desktop: token_code_verifier を暗号学的に安全な乱数（32バイト以上、base64url）で生成
   └─ S256: token_code_challenge = BASE64URL(SHA256(token_code_verifier))
2. Desktop → Auth Server: POST /auth/oauth/start
   └─ {provider, redirectUri, tokenCodeChallenge}  ※verifier は送らない
3. Auth Server: token_code_challenge を oauth_flows に保存（10分TTL）
4. （プロバイダOAuth + コールバック + ワンタイムコード発行は同様）
5. Desktop → Auth Server: POST /auth/token
   └─ {code, tokenCodeVerifier, deviceId, deviceName, state?}  ※tokenCodeVerifier は必須
6. Auth Server:
   a. ワンタイムコードを原子的UPDATEで消費（使用済み・期限切れは拒否）
   b. tokenCodeVerifier から challenge を再計算し oauth_flows と照合
   c. 不一致 → 即座に拒否（コードは既に消費済みのため再試行不可）
   d. 一致 → Access Token + Refresh Token を発行
```

**必須化の根拠**：

- `device_id` は端末側で自由に設定可能な値であり、それ単独では認証保護にならない
- `state` はCSRF対策であり、コード横取りの防止にはならない
- ワンタイムコードが漏洩（例：プロキシログ、ブラウザ履歴、他プロセスによるローカル傍受）しても、`token_code_verifier` を知らない攻撃者は `/auth/token` で交換できない
- PKCE 省略の互換経路は設けない（実装・設定ミスによる保護漏れを防ぐ）

**セキュリティ効果**：ローカルの別プロセスが `127.0.0.1` コールバックを横取りしてワンタイムコードを取得しても、`token_code_verifier` を持たないため `/auth/token` での交換に失敗する。

### 5.3 PKCE / state / nonce の扱い

| 要素 | 生成者 | 保存場所 | 検証者 | TTL |
|---|---|---|---|---|
| `state` | Auth Server | **PostgreSQL `oauth_flows` を正本**、Redis はキャッシュのみ | Auth Server（コールバック時） | 10分 |
| `code_verifier` | Auth Server | **PostgreSQL `oauth_flows` を正本**、Redis はキャッシュのみ | Auth Server（code交換時） | 10分 |
| `code_challenge` | Auth Server | 認可URLパラメータ | プロバイダ → Auth Server | — |
| `nonce` | Auth Server | **PostgreSQL `oauth_flows` を正本**、Redis はキャッシュのみ | Auth Server（Google OIDC id_token 検証時） | 10分 |
| `one_time_code` | Auth Server | **PostgreSQL `oauth_codes` を正本**、Redis はキャッシュのみ | Auth Server（`/auth/token` 時） | 60秒 |
| `token_code_challenge` | デスクトップ | Auth Server が `oauth_flows` に保存 | Auth Server（`/auth/token` 時） | 10分 |

**デスクトップ側の PKCE は2系統に分かれる（v2.2 で確定）**：

- **プロバイダ向け PKCE**：Auth Server が生成・管理。デスクトップは `code_verifier` を持たない（Auth Server がプロバイダとのトークン交換を行うため）
- **第2 PKCE（token PKCE）**：**デスクトップが生成**し、`/auth/token` でのワンタイムコード交換時に `tokenCodeVerifier` を提示。**必須**（§5.2.2）

これにより、デスクトップが悪意あるコードを注入するリスクを排除しつつ、トークン交換の保護も強化する。

### 5.4 craftmate:// カスタムスキームの安全性

craftmate:// をフォールバックとして使う場合の対策：

- **URL パラメータの厳格検証**：`code` と `state` のみ許可。他のパラメータは拒否
- **state の照合**：デスクトップが `/auth/oauth/start` 時に生成した `state` を保持し、コールバック時に照合
- **ワンタイムコードの即時交換**：受信後すぐに `/auth/token` で交換。失敗時はユーザーに再試行を促す
- **OS別の登録方法**：
  - Windows：レジストリ `HKEY_CLASSES_ROOT\craftmate`（インストーラーで登録）
  - macOS：`Info.plist` の `CFBundleURLTypes`
  - Linux：`.desktop` ファイルの `MimeType=x-scheme-handler/craftmate`

---

## 6. セッション・トークン管理

### 6.1 セッショントークン設計

| 方式 | メリット | デメリット |
|---|---|---|
| **JWT (Access Token)** | ステートレス、検証が高速 | 失効が困難、トークンサイズ大 |
| **Opaque Token + DB** | 即時失効可能、サイズ小 | DB負荷増 |
| **ハイブリッド（推奨）** | Access JWT (短命10分) + Refresh Token (DB管理30日) | 実装やや複雑 |

**推奨：ハイブリッド方式**

- **Access Token**：JWT、**10分有効**（実装デフォルト `ACCESS_TOKEN_TTL_SECONDS=600`）、`sub`（ユーザーID）+ `provider` + `scope` + `jti` を含む
- **Refresh Token**：不透明文字列、**PostgreSQL に SHA-256 ハッシュで保存**、30日有効、ローテーションあり
- **デスクトップ側**：`__auth_session` と同様に暗号化保存。`expiresAt` を Access Token の期限に設定

### 6.2 JWT のセキュリティ要件

| 項目 | 要件 |
|---|---|
| 署名アルゴリズム | **RS256 または ES256**（HMAC は不可、鍵漏洩リスク） |
| 鍵管理 | 秘密鍵は Secret Manager / HSM。公開鍵は JWKS エンドポイントで公開 |
| 有効期限 | **10分**（実装デフォルト `ACCESS_TOKEN_TTL_SECONDS=600`。短命化で漏洩影響を最小化） |
| `jti` | 各トークンに一意ID。失効リストでの個別無効化は**設計上の想定（未実装）**。現行実装では `jti` クレームは発行されるが失効リスト照合は行わず、失効は Refresh Token の family 失効＋Access Token の `exp` 自然失効で担保 |
| `iss` / `aud` | `https://auth.craftmate.app` / `craftmate-desktop` を必須検証 |
| `nbf` / `exp` | 必須。時計ずれ許容は ±30秒 |
| アルゴリズム混同攻撃対策 | `alg: none` 拒否、`kid` ヘッダで鍵選択 |

### 6.3 Refresh Token の管理（重要・改訂）

#### 保存形式

```
Refresh Token: "rfr_" + 32バイト乱数（base64url）
DB保存: SHA-256(token) のハッシュ値のみ（平文は保存しない）
```

#### ローテーションと再利用検知

```
1. 初回発行: refresh_token_hash を DB に保存、有効期限30日
2. リフレッシュ時（単一トランザクション内で実行）:
   a. SELECT ... FROM sessions WHERE refresh_token_hash = ? FOR UPDATE  -- 行ロック
   b. 有効なトークン → 同一トランザクション内で:
      - 旧トークンのハッシュを token_history に追加（セッション有効期間中は全世代保持）
      - 旧トークンを revoked_at = now(), revoke_reason='rotated' に更新
      - 新しい Refresh Token を発行・保存
   c. 無効化済みトークンが再提示された → **再利用検知**：全セッションを即時失効
3. 再利用検知時の対応:
   a. 該当 token_family_id の全セッションを失効
   b. 全 Access Token の jti を失効リストに追加（Redis → DB フォールバック）※設計上の想定。**現行実装では jti 失効リストは未実装**のため、family 失効＋Access Token の `exp` 自然失効（最大10分）で担保する
   c. 監査ログに記録 + アラート送信
   d. ユーザーにメール通知（登録済みの場合）
```

**ローテーションの原子性**：旧トークン無効化と新トークン発行は**必ず単一DBトランザクション**で実行。`SELECT ... FOR UPDATE` で行ロックを取得し、並行リフレッシュ要求による二重発行・状態不整合を防止。

#### Refresh Token ファミリー管理（v2.1 で改訂）

```
-- セッション管理テーブル（改訂 v2.1）
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  token_family_id UUID NOT NULL,        -- 同一ログインセッションの系列ID
  refresh_token_hash VARCHAR(64) NOT NULL,  -- 現在のハッシュ（平文は保存しない）
  token_history JSONB NOT NULL DEFAULT '[]', -- セッション有効期間中は全世代のハッシュを保持（再利用検知用）
  device_info JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,      -- 30日（スライディング or 絶対）
  revoked_at TIMESTAMPTZ,
  revoke_reason VARCHAR(50)             -- logout/password_change/rotated/token_reuse/account_suspend/admin_action
);
```

**token_history の仕様（v2.2 で改訂：5世代制限を廃止）**：

- ローテーションごとに旧ハッシュを配列に追加。**セッションの有効期間中（expires_at まで、または revoked まで）は全世代を保持**
- セッション失効・期限切れ後は行ごと削除またはアーカイブ（後述「削除タイミング」）
- 再利用検知は「現在のハッシュ」+「token_history 内の全ハッシュ」を検索 → **セッション有効期間内のあらゆる世代のトークン再利用を検知可能**
- 5世代制限を廃止した理由：1ハッシュ=64バイト、月30回リフレッシュでも ~2KB/セッション。保存容量・検索性能への影響は無視できる一方、5世代より古いトークン再利用を見逃すリスクを完全に排除できる
- 残るリスク：セッション失効後に同じトークンが提示されても履歴が削除済みなら検知不可 → ただし失効済みセッションのトークンはそもそも無効であり、新規セッションのファミリーとは別系統のため実害は限定的

**削除タイミング**：

- セッション行（`sessions`）の `expires_at` 経過後、または `revoked_at` 設定後 **30日間は token_history を保持**（監査・再利用検知の猶予期間）
- 30日経過後は `token_history` を空配列にクリア（行自体は監査目的で残す）
- ユーザーアカウント削除時は関連する全セッション・履歴を物理削除（GDPR対応）

**再利用検知のロジック**：

```sql
-- 現在または履歴に一致するハッシュを検索
SELECT * FROM sessions 
WHERE user_id = ? AND (
  refresh_token_hash = ? OR 
  token_history @> to_jsonb(ARRAY[?]::text[])
);
-- revoked_at IS NOT NULL の行が見つかった場合 → 同じ token_family_id の全セッションを失効
UPDATE sessions SET revoked_at = now(), revoke_reason = 'token_reuse' 
WHERE token_family_id = ?;
```

**原子性の確保**：リフレッシュ処理全体を単一トランザクションで実行。`SELECT ... FOR UPDATE` で対象行をロックし、並行するリフレッシュ要求が二重にトークンを発行しないようにする。

### 6.4 ログアウト・強制ログアウト

| 操作 | 処理 |
|---|---|
| ユーザー自身のログアウト | `POST /auth/logout` → 該当 Refresh Token を失効、Access Token の `jti` を失効リストに追加（オプション） |
| 全デバイスからログアウト | `POST /auth/logout-all` → ユーザーの全 Refresh Token を失効 |
| 管理者による強制ログアウト | `POST /ops/users/:id/suspend` → 全 Refresh Token 失効 + ユーザー status を `suspended` に |
| パスワード変更 | 全 Refresh Token 失効（セキュリティ上の理由） |

### 6.5 アカウント停止時の失効処理

```
1. 管理者が POST /ops/users/:id/suspend を実行
2. サーバー側処理:
   a. users.status = 'suspended'
   b. 該当ユーザーの全 sessions.revoked_at = now()
   c. 全 Access Token の jti を Redis 失効リストに追加（TTL=10分）※設計上の想定。**現行実装では未実装**
   d. 監査ログに記録
3. 影響:
   - 新規ログイン: 不可（status チェックで拒否）
   - 既存 Access Token: jti 失効リストは未実装のため、Refresh Token 失効により更新は即時不可。Access Token 自体は `exp` まで有効（最大10分）
   - Refresh Token: 即時失効
4. **オフライン時の注意（v2.1 明記）**：Auth Server 停止中、デスクトップは失効リストを確認できない。JWT の署名検証はローカルで可能なため、**停止中に発行済みの Access Token は期限（最大10分）まで有効**。これは §10.2 の「既存セッション継続」と整合する許容リスクであり、停止中の強制ログアウトは保証しない。Access Token の実装デフォルトは `ACCESS_TOKEN_TTL_SECONDS=600`（10分）。
```

### 6.6 Redis 障害時の動作（現行実装準拠）

> **注意**: 下表は当初設計を含む。現行実装との差異は各行に明記。

| 機能 | Redis 依存 | 障害時の動作 |
|---|---|---|
| OAuth state/nonce | なし（PG正本） | 影響なし。`oauth_flows` は PostgreSQL が正本で Redis は未使用 |
| ワンタイムコード | なし（PG正本） | 影響なし。`oauth_codes` は PostgreSQL が正本 |
| レート制限 | あり | **`REDIS_URL` 設定時に Redis が利用不能 → ログイン等は 503 `AUTH_UNAVAILABLE` でフェイルクローズ**（制限なしでは通さない）。`REDIS_URL` 未設定時はプロセス内メモリ制限にフォールバック（**単一インスタンス限定**） |
| Access Token 失効リスト | — | **未実装**（jti 失効リストなし）。Access Token は `exp` まで有効（最大10分）、Refresh Token 失効で更新を遮断 |
| Refresh Token | **なし** | 影響なし（PostgreSQL に永続化） |

**設計原則**：認証の根幹（Refresh Token・ユーザー情報・OAuthフロー）は PostgreSQL に永続化。Redis はレート制限カウンタのみを担い、揮発性データの消失でデータ損失は発生しない。

---

## 7. データベース設計（Auth Server 側）

### 7.1 テーブル設計（改訂）

```sql
-- ユーザー（CraftMate アカウント）
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) UNIQUE,           -- メールアドレス（任意・変更可）
  display_name VARCHAR(100),
  avatar_url TEXT,
  status VARCHAR(20) DEFAULT 'active', -- active/suspended/deleted
  email_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,              -- ソフトデリート（GDPR）
  deletion_scheduled_at TIMESTAMPTZ    -- 物理削除予定日時
);

-- 外部ID連携（既存 external_identities のクラウド版）
CREATE TABLE external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider VARCHAR(20) NOT NULL,       -- google/github/discord
  provider_user_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  email VARCHAR(320),
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(provider, provider_user_id)   -- 所有権は一度紐付いたら変更しない
);

-- セッション（Refresh Token 管理・改訂）
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_family_id UUID NOT NULL,       -- 同一ログインセッションの系列ID
  refresh_token_hash VARCHAR(64) NOT NULL,
  token_history JSONB NOT NULL DEFAULT '[]', -- セッション有効期間中は全世代保持（再利用検知用）
  device_info JSONB,                   -- User-Agent, IP, device_name
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,     -- 30日
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason VARCHAR(50)            -- logout/password_change/rotated/token_reuse/account_suspend/admin_action
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_family ON sessions(token_family_id);

-- OAuth フロー（一時的。PostgreSQL を正本、Redis はキャッシュのみ）
-- 使用済み判定は必ず原子的 UPDATE で行う:
--   UPDATE oauth_flows SET used_at = now() WHERE state = ? AND used_at IS NULL AND expires_at > now() RETURNING *;
--   → 0行なら拒否（キャッシュ不整合・二重使用を防止）
CREATE TABLE oauth_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state VARCHAR(64) NOT NULL UNIQUE,
  provider VARCHAR(20) NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce VARCHAR(64),
  redirect_uri TEXT NOT NULL,
  device_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,     -- 10分
  used_at TIMESTAMPTZ                  -- ワンタイム使用
);
CREATE INDEX idx_oauth_flows_expires ON oauth_flows(expires_at) WHERE used_at IS NULL;

-- ワンタイム認可コード（60秒有効。PostgreSQL を正本、Redis はキャッシュのみ）
-- 使用済み判定は必ず原子的 UPDATE で行う:
--   UPDATE oauth_codes SET used_at = now() WHERE code = ? AND used_at IS NULL AND expires_at > now() RETURNING *;
--   → 0行なら拒否（二重交換・キャッシュ不整合を防止）
CREATE TABLE oauth_codes (
  code VARCHAR(64) PRIMARY KEY,        -- otc_ + 32バイト乱数
  flow_id UUID NOT NULL REFERENCES oauth_flows(id),
  user_id UUID NOT NULL REFERENCES users(id),
  state VARCHAR(64) NOT NULL,          -- CSRF対策用
  device_id VARCHAR(64),
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,     -- 60秒
  used_at TIMESTAMPTZ                  -- ワンタイム使用
);
CREATE INDEX idx_oauth_codes_expires ON oauth_codes(expires_at) WHERE used_at IS NULL;

-- 監査ログ（セキュリティ・GDPR対応）
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  event VARCHAR(50) NOT NULL,          -- login/logout/connect/disconnect/delete/token_reuse/suspend
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,                      -- Secret・トークンは含めない
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_event ON audit_logs(event, created_at DESC);
```

### 7.2 既存ローカルDBとの対応

| ローカル（SQLite） | クラウド（PostgreSQL） | 移行方針 |
|---|---|---|
| `external_identities` | `external_identities` | 同一構造。`craftmate_user` → `user_id` にマッピング |
| `local_users` | `users` + `external_identities(provider='local')` | 内部アカウントもクラウドユーザーに移行可能 |
| `__auth_session` | `sessions` + JWT | セッションはサーバー管理に移行 |
| `integrations` (連携トークン) | 別途検討 | 外部トークンはデスクトップ側に残す or サーバー管理 |

---

## 8. 不正アクセス対策

### 8.1 認証・認可

- **PKCE 必須**：全 OAuth フローで S256 を強制。`plain` は拒否
- **state 検証**：CSRF対策、Redis/DB でワンタイム使用（使用後即削除）
- **nonce 検証**：Google OIDC の id_token 検証（既存実装を踏襲）
- **レート制限**：IP・ユーザー単位で `/auth/*` に厳格な制限（例：10req/min、ログイン失敗時は指数バックオフ）
- **ブルートフォース対策**：ログイン失敗の指数バックオフ、CAPTCHA（必要に応じて）

### 8.2 トークン・セッション

- **Refresh Token**：SHA-256 ハッシュで保存、ローテーション、再利用検知、絶対期限あり
- **Access Token**：10分の短命 JWT（実装デフォルト `ACCESS_TOKEN_TTL_SECONDS=600`）、`jti` クレームは発行されるが失効リスト照合は未実装
- **セッション固定攻撃対策**：ログイン成功時にセッショントークンを再発行
- **同時セッション制限**：1ユーザーあたり最大Nデバイス（例：5）。超過時は最も古いセッションを失効

### 8.3 通信・インフラ

- **TLS 1.2+ 必須**、HSTS ヘッダ
- **CORS**：`craftmate://` スキームと `http://127.0.0.1` のみ許可
- **SQL インジェクション対策**：パラメータ化クエリ（ORM or プリペアドステートメント）
- **秘密情報管理**：Client Secret は環境変数/Secret Manager（AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault 等）
- **ログ**：Secret・トークン・パスワード・ワンタイムコードは絶対にログに出力しない（既存の `debugLog` 方針を踏襲）。構造化ログで個人情報をマスキング

### 8.4 アカウント乗っ取り対策

- **メールアドレス検証**：登録時に確認メール送信（任意プロバイダの場合）
- **怪しいログイン検知**：新デバイス・異常IPからのログイン時に通知
- **アカウント復旧**：メール or サポート経由の本人確認フロー
- **デバイス管理**：ユーザーが自分のセッション一覧を確認・個別失効可能

---

## 9. サーバー運用費用の概算

### 9.1 初期段階（ユーザー ~1,000人）

| 項目 | サービス | 月額目安 |
|---|---|---|
| API サーバー | VPS (2vCPU/4GB) or Cloud Run | $10-30 |
| DB | PostgreSQL (Supabase/Neon/RDS) | $0-25 |
| Redis | Upstash/Redis Cloud | $0-10 |
| ドメイン・SSL | お名前.com/Let's Encrypt | $10-15 |
| バックアップ | S3/Backblaze | $1-5 |
| **合計** | | **$20-85/月** |

### 9.2 成長段階（ユーザー ~10,000人）

| 項目 | 月額目安 |
|---|---|
| API（オートスケール） | $50-150 |
| DB（専用インスタンス） | $50-100 |
| Redis（クラスタ） | $20-50 |
| 監視・ログ | $20-50 |
| **合計** | **$140-350/月** |

### 9.3 コスト削減のポイント

- **静的アセットは CDN**：ダッシュボードのJS/CSSは GitHub Pages or Cloudflare Pages（無料）
- **DB はサーバーレス**：Supabase/Neon の無料枠で開始可能
- **Redis は Upstash**：従量課金で無料枠あり
- **バックアップは日次スナップショット**：リアルタイムレプリケーションは不要な規模

---

## 10. 障害発生時の対応

### 10.1 障害シナリオと対策

| 障害 | 影響 | 対策 |
|---|---|---|
| Auth Server 停止 | 新規ログイン不可、既存セッションは継続（JWT検証はローカルで可能） | ヘルスチェック + 自動再起動 + ステータスページ |
| DB 障害 | 全認証不可 | リードレプリカ、日次バックアップからの復旧手順 |
| Redis 障害 | レート制限に影響（`REDIS_URL` 設定時はログインが503でフェイルクローズ。未設定時はメモリ内制限にフォールバック・単一インスタンス限定） | Key Value 再起動を待つか `REDIS_URL` 一時削除。データ損失なし（Redisは揮発性カウンタのみ） |
| プロバイダ障害 | 特定プロバイダのログイン不可 | 他プロバイダ・内部アカウントで継続利用可能 |
| Secret 漏洩 | 全ユーザーのなりすまし可能 | 即座にローテーション + 影響範囲調査 + ユーザー通知 |

### 10.2 Auth Server 停止時にユーザーが利用できるもの（重要・改訂）

| 機能 | Auth Server 停止時 | 理由 |
|---|---|---|
| **既存セッションの継続利用** | ✅ 可能 | Access Token (JWT) はローカルで署名検証可能。期限内（最大10分）は継続 |
| **新規ログイン** | ❌ 不可 | Auth Server が必要 |
| **セッションリフレッシュ** | ❌ 不可 | Refresh Token はサーバー側で検証が必要 |
| **外部アカウント連携** | ❌ 不可 | Auth Server が必要 |
| **ローカルアカウント（internal）** | ✅ 可能 | ローカルDBで完結 |
| **ローカル OAuth（oauth-clients.json）** | ✅ 可能 | 従来方式にフォールバック |
| **Minecraft ボット機能** | ✅ 可能 | 認証とは無関係 |
| **ダッシュボード設定** | ✅ 可能 | ローカル機能 |

**設計上の配慮**：

- Access Token の有効期限は実装デフォルト10分（`ACCESS_TOKEN_TTL_SECONDS=600`）で、Auth Server 停止時の影響を最小化
- 既存ユーザーは「ログイン済み」のまま最大10分間は利用継続可能
- 10分経過後は再ログインが必要（内部アカウント or ローカル OAuth で代替可能）

### 10.3 監視・アラート

- **ヘルスチェック**：`/ops/health` を外部監視サービス（UptimeRobot 等）で監視
- **エラーレート**：5xx エラーが閾値超過でアラート
- **レスポンスタイム**：p95 が 500ms 超でアラート
- **ログ集約**：構造化ログを CloudWatch / Datadog / Loki に送信
- **セキュリティアラート**：トークン再利用検知・異常ログイン・ブルートフォース試行を即時通知

---

## 11. プライバシーポリシーと利用規約

### 11.1 プライバシーポリシーに必要な事項

- **収集する情報**：メールアドレス、表示名、アバターURL、OAuth プロバイダID、ログイン日時・IP・デバイス情報
- **利用目的**：アカウント認証、サービス提供、セキュリティ確保、不正利用防止
- **第三者提供**：OAuth プロバイダ（Google/GitHub/Discord）への認証リクエスト、法的要請時
- **データ保存期間**：アカウント存続中 + 削除後30日の猶予期間
- **ユーザーの権利**：アクセス・訂正・削除・ポータビリティ（GDPR/CCPA対応）
- **Cookie/トラッキング**：使用しない旨を明記
- **セキュリティ対策**：暗号化、アクセス制御、監査ログ

### 11.2 利用規約に必要な事項

- **アカウント管理責任**：ユーザー自身の認証情報管理責任
- **禁止事項**：不正利用、スクレイピング、リバースエンジニアリング（規約で制限）
- **サービス変更・終了**：事前通知と猶予期間
- **免責事項**：サービスの可用性・データ損失に関する免責
- **準拠法・管轄**：運営者の所在地に応じて設定

### 11.3 GDPR/CCPA 対応（実装可能性の確認）

| 要件 | 実装方法 | 実装可能性 |
|---|---|---|
| **データエクスポート** | `GET /users/me/export` で全データを JSON で提供 | ✅ 実装可能 |
| **アカウント削除** | `DELETE /users/me` → `deleted_at` 設定 → 30日後に物理削除 | ✅ 実装可能 |
| **同意管理** | OAuth 連携時にデータ利用への同意を取得 | ✅ 実装可能 |
| **データ処理者の明記** | OAuth プロバイダ・クラウドプロバイダを「処理者」として明記 | ✅ 文書化可能 |
| **アクセス権** | `GET /users/me` で全データ確認可能 | ✅ 実装可能 |
| **訂正権** | `PATCH /users/me` でプロフィール更新 | ✅ 実装可能 |
| **削除権** | `DELETE /users/me` で即時削除可能 | ✅ 実装可能 |

**注意点**：

- **ローカルデータは対象外**：`craftmate.db` や `integrations.key` はユーザーのローカルマシンにあるため、サーバー側の GDPR 対応は「クラウドに保存したデータ」に限定される
- **バックアップの扱い**：バックアップ内のデータも30日以内に削除される設計が必要
- **監査ログの保持**：セキュリティ目的で一定期間保持（例：1年）。削除要求時も匿名化して保持するか、保持期間を明示

---

## 12. 既存ユーザーへの影響

### 12.1 影響範囲

| 項目 | 影響 | 対策 |
|---|---|---|
| 既存セッション | **なし** | `__auth_session` はそのまま有効。Auth Server セッションは別途発行 |
| 外部連携 | **なし** | `external_identities` はローカルに残る。Auth Server とは別管理 |
| ローカルアカウント | **なし** | `local_users` はそのまま利用可能 |
| OAuth 設定ファイル | **任意** | `oauth-clients.json` は引き続き利用可能（フォールバック） |
| UI | **追加のみ** | 「CraftMate アカウントでログイン」ボタンを追加。既存ボタンは残す |

### 12.2 既存ユーザーのアカウントとクラウドアカウントの安全な関連付け（重要・改訂）

#### 問題

既存ユーザーが「ローカルの external_identities」を「クラウドアカウント」に安全に関連付ける方法が必要。

#### 推奨フロー

```
1. ユーザーが「CraftMate アカウントに移行」を選択
2. Auth Server で OAuth ログイン（例：Google）
3. サーバー側で external_identities を検索:
   - provider='google' AND provider_user_id='xxx' が既存 → そのユーザーに紐付け
   - 存在しない → 新規ユーザー作成
4. デスクトップ側で「ローカル連携データの移行」を確認:
   - 「このアカウントに既存の連携データを移行しますか？」
   - ユーザーが承認 → ローカル external_identities をクラウドにエクスポート
   - サーバー側で既存の external_identities とマージ（重複はスキップ）
5. 移行完了後、ローカルの __auth_session をクラウドセッションに置き換え
```

#### 安全性の確保

| リスク | 対策 |
|---|---|
| **アカウント乗っ取り** | OAuth 認証は各プロバイダの公式フローを使用。CraftMate 側でパスワードを扱わない |
| **既存アカウントへの不正アクセス** | `external_identities` の `provider + provider_user_id` が一致しない限り、既存アカウントにアクセス不可 |
| **メールアドレス一致での自動統合** | **行わない**。メールアドレスは表示用であり、認証の根拠にしない |
| **ローカルデータの漏洩** | 移行はユーザーの明示的な承認が必要。暗号化された `integrations` データは移行対象外 |

#### 移行時のデータ対応

| ローカルデータ | クラウド移行 | 備考 |
|---|---|---|
| `external_identities` | ✅ 移行可能 | `provider + provider_user_id` をキーに upsert |
| `local_users` | ✅ 移行可能 | `provider='local'` として `external_identities` に登録 |
| `__auth_session` | ❌ 移行しない | 新規セッションを発行 |
| `integrations` (連携トークン) | ❌ 移行しない | トークンはローカルに残す（セキュリティ上の理由） |

### 12.3 データ移行の安全性

- **ローカルデータは削除しない**：Auth Server 移行後も `craftmate.db` はローカルに残る
- **external_identities の同期**：`craftmate_user` をキーにクラウドへエクスポート/インポート
- **セッショントークン**：ローカル `__auth_session` は暗号化のまま保持。クラウドセッションとは別管理

---

## 13. 段階的な移行計画

### Phase 1：Auth Server 基盤構築（〜1-2ヶ月）

- [ ] Auth Server のプロトタイプ構築（OAuth Broker + JWT + Refresh Token）
- [ ] Google OAuth のみで E2E フロー検証（ワンタイムコード方式）
- [ ] セッショントークン発行・検証の実装
- [ ] `craftmate://` + `127.0.0.1` コールバック対応（Electron + デスクトップ）
- [ ] Refresh Token ローテーション・再利用検知の実装

### Phase 2：GitHub・Discord 対応（〜1ヶ月）

- [ ] GitHub OAuth Broker 実装
- [ ] Discord OAuth Broker 実装
- [ ] 外部アカウント連携機能のクラウド版 API
- [ ] 既存 `resolveCraftmateUser` ロジックのサーバー版移植

### Phase 3：デスクトップアプリ統合（〜1ヶ月）

- [ ] Auth Server クライアント実装（`src/auth-client.ts`）
- [ ] ログイン画面に「CraftMate アカウントでログイン」ボタン追加
- [ ] セッション管理のハイブリッド対応（ローカル + クラウド）
- [ ] i18n 対応（日本語・英語最低限）
- [ ] 既存ユーザー向け移行フローの実装

### Phase 4：移行・安定化（〜1ヶ月）

- [ ] 既存ユーザー向け移行ガイド
- [ ] データエクスポート/インポート機能
- [ ] 監視・アラート・ステータスページ
- [ ] セキュリティ監査（外部 or 社内）

### Phase 5：正式リリース（〜2週間）

- [ ] プライバシーポリシー・利用規約公開
- [ ] OAuth App の審査対応（Google の verified app 等）
- [ ] 段階的ロールアウト（ベータ → 正式）

---

## 14. 推奨アーキテクチャと実装順序

### 14.1 推奨アーキテクチャ（改訂）

```
┌─────────────────────────────────────────────────────────────┐
│  CraftMate Desktop App (Electron / Node.js)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ ローカルWeb   │  │ Auth Client   │  │ craftmate.db     │   │
│  │ Server :3000 │  │ (HTTPS→Auth)  │  │ (SQLite)         │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────┘   │
│         │                 │                                  │
│         │  ① ローカルUI    │  ② Auth Server API               │
│         │  ③ セッション保存 │                                  │
└─────────┼─────────────────┼──────────────────────────────────┘
          │                 │
          ▼                 ▼
┌─────────────────┐  ┌─────────────────────────────────────┐
│  ローカルDB      │  │  Auth Server (クラウド)              │
│  - __auth_session│  │  - OAuth Broker (Secret管理)        │
│  - integrations │  │  - JWT Access (10分) + Refresh (30日)│
│  - external_ids │  │  - PostgreSQL (永続化) + Redis (一時) │
│  - local_users  │  │  - ワンタイムコード (60秒)            │
│                 │  │  - 監査ログ・レート制限・再利用検知    │
└─────────────────┘  └─────────────────────────────────────┘
```

### 14.2 実装順序（推奨）

1. **Auth Server プロトタイプ**：OAuth Broker + JWT + Refresh Token + ワンタイムコード。まず Google で E2E 検証
2. **コールバック対応**：`127.0.0.1` ローカルコールバック + `craftmate://` フォールバック
3. **デスクトップ Auth Client**：`/auth/oauth/start` → ブラウザ → コールバック → `/auth/token` → セッション保存
4. **Refresh Token 管理**：ローテーション・再利用検知・失効処理
5. **GitHub/Discord 対応**：OAuth Broker にプロバイダ追加
6. **外部連携のクラウド版**：既存「連携」機能を Auth Server API に移植
7. **UI 統合**：「CraftMate アカウントでログイン」ボタン、i18n対応
8. **移行ツール**：既存ユーザーのデータエクスポート/インポート
9. **運用基盤**：監視・バックアップ・ステータスページ
10. **セキュリティ監査**：外部監査 or 脆弱性診断
11. **正式リリース**：ポリシー公開、段階的ロールアウト

### 14.3 技術スタック推奨

| 層 | 技術 | 理由 |
|---|---|---|
| Auth Server | Node.js + Fastify | 既存コードが TypeScript、型安全 |
| DB | PostgreSQL (Supabase/Neon) | マネージドで運用負荷低、ACID準拠 |
| セッション | Redis (Upstash) + PostgreSQL | Redis はキャッシュ、PostgreSQL は永続化 |
| JWT | `jose` (JWKS対応) | 標準的、軽量、RS256/ES256対応 |
| Desktop Client | 既存 `src/integrations.ts` を拡張 | OAuth ロジック流用 |
| Electron | `craftmate://` + `127.0.0.1` コールバック | 既存 Electron シェルに追加 |

---

## 15. セキュリティ上の注意（設計時点での確認事項）

- ✅ **Client Secret はサーバーのみ**：デスクトップアプリ・リポジトリ・ログに含めない
- ✅ **PKCE 必須**：全フローで S256 を強制。`plain` は拒否
- ✅ **state/nonce 検証**：CSRF・リプレイ攻撃対策。ワンタイム使用
- ✅ **ワンタイムコード**：60秒有効・1回限り・state/redirect_uri/device_id に紐付け
- ✅ **トークンの最小権限**：外部プロバイダのアクセストークンはデスクトップに渡さない
- ✅ **Refresh Token 再利用検知**：ローテーション済みトークンの再提示で全セッション失効
- ✅ **監査ログ**：全認証イベントを記録（個人情報は最小限、Secret・トークンは含めない）
- ✅ **暗号化**：転送時 TLS、保存時は DB レベル暗号化 + アプリケーション層暗号化
- ⚠️ **`craftmate://` スキームの悪用**：URL パラメータの検証を厳格に（code/state のみ許可）
- ⚠️ **オープンリダイレクト**：`redirect_uri` パラメータは許可リストで検証（`127.0.0.1` + `craftmate://` のみ）
- ⚠️ **レート制限の迂回**：IP ベース + ユーザー基準の二重制限
- ⚠️ **秘密情報のログ出力**：`debugLog` に Secret・トークン・ワンタイムコードを出さないことをコードレビューで確認
- ⚠️ **JWT アルゴリズム混同攻撃**：`alg` ヘッダを検証、`none` 拒否、`kid` で鍵選択
- ⚠️ **タイミング攻撃**：トークン比較は `crypto.timingSafeEqual` を使用

---

## 16. セキュリティリスク一覧（改訂で追加）

| # | リスク | 重要度 | 対策 | 状態 |
|---|---|---|---|---|
| 1 | craftmate:// URL にトークンを含める | 🔴 高 | ワンタイムコード方式に変更（60秒・1回限り） | ✅ 改訂済み |
| 2 | カスタムスキームの横取り | 🟡 中 | 127.0.0.1 コールバックを主軸に、craftmate:// はフォールバック | ✅ 改訂済み |
| 3 | Refresh Token 再利用 | 🔴 高 | ローテーション + 再利用検知 + 全セッション失効 | ✅ 改訂済み |
| 4 | JWT 失効の困難さ | 🟡 中 | 短命化（実装10分）+ Refresh Token ローテーション（jti 失効リストは設計上の想定・未実装） | ✅ 改訂済み |
| 5 | Redis 障害時の認証不可 | 🟡 中 | PostgreSQL に永続化、Redis はキャッシュのみ | ✅ 改訂済み |
| 6 | メールアドレス一致での自動統合 | 🔴 高 | provider+provider_user_id のみで紐付け、メールは表示用 | ✅ 明記済み |
| 7 | 既存アカウントへの不正アクセス | 🔴 高 | OAuth 認証必須、external_identities の所有権保護 | ✅ 維持 |
| 8 | ログへの個人情報・トークン漏洩 | 🟡 中 | 構造化ログ + マスキング + コードレビュー | ✅ 明記済み |
| 9 | アカウント削除後のデータ残存 | 🟡 中 | ソフトデリート + 30日猶予 + 物理削除 | ✅ 明記済み |
| 10 | Auth Server 停止時の影響 | 🟢 低 | JWT ローカル検証 + 内部アカウント/ローカル OAuth フォールバック | ✅ 明記済み |

---

## 17. 実装前に解決すべき課題一覧

### 必須（実装前に決定が必要）

- [ ] **ドメイン決定**：`auth.craftmate.app` 等の正式ドメイン
- [ ] **ホスティング環境**：AWS/GCP/Azure/Cloudflare の選定
- [ ] **DB 選定**：PostgreSQL のマネージドサービス（Supabase/Neon/RDS）
- [ ] **Redis 選定**：Upstash/Redis Cloud/セルフホスト
- [ ] **JWT 署名鍵**：RS256 or ES256 の選定、鍵管理方法（Secret Manager/HSM）
- [ ] **レート制限の具体値**：IP・ユーザー単位の閾値
- [ ] **セッション同時接続数**：1ユーザーあたりの最大デバイス数
- [ ] **プライバシーポリシー・利用規約**：法務レビュー

### 推奨（実装中に決定可能）

- [ ] **メール送信基盤**：確認メール・通知メールの送信方法（SendGrid/SES等）
- [ ] **監視基盤**：UptimeRobot/Datadog/CloudWatch の選定
- [ ] **バックアップ戦略**：日次スナップショットの保持期間
- [ ] **OAuth App 審査**：Google の verified app 申請が必要か確認
- [ ] **craftmate:// スキームの登録方法**：OS別の実装詳細

### 検討事項（将来的に決定）

- [ ] **2要素認証（2FA）**：TOTP/SMS の導入検討
- [ ] **ソーシャルログイン以外の認証**：メール/パスワード認証の追加
- [ ] **組織・チーム機能**：将来的なマルチユーザー対応
- [ ] **API レート制限の詳細**：エンドポイント別の制限値

---

## 18. 推奨設定値（v2.2 で確定）

| 項目 | 推奨値 | 理由 |
|---|---|---|
| **Access Token 有効期限** | **10分** | 失効確認ができないオフライン期間を最小化。15分と比較してリフレッシュ頻度は2倍になるが、ユーザー体感への影響はほぼない（バックグラウンドで自動リフレッシュ）。アカウント停止・トークン漏洩時の影響窓を狭める |
| **token_history 保持** | **セッション有効期間中は全世代**（失効後30日でクリア） | 64バイト/世代で容量影響は無視できる。5世代制限による検知漏れを完全に排除 |
| **第2 PKCE** | **必須**（互換経路なし） | `device_id`/`state` 単独ではコード横取りに対して不十分。実装コストは PKCE ペア1組の生成のみ |
| **Redis + PostgreSQL 両方が利用不可の場合** | **Auth Server 自体が機能停止**。デスクトップ側は既存 Access Token が期限切れまで利用継続（最大10分）、Refresh Token リフレッシュは不可。jti 失効リストの確認も不可のため、停止中に発行済みトークンは自然失効まで有効（許容リスク）。フォールバックとして内部アカウント・ローカル OAuth が利用可能 | 認証の根幹（ユーザーDB・セッション）は PostgreSQL に永続化されているため、Redis 単独障害ではサービス継続可能。両方停止は Auth Server 全停止と同義 |

## 19. まとめ（改訂版）

| 項目 | 現状 | Auth Server 導入後 |
|---|---|---|
| Client Secret | ユーザーが各自管理 | **サーバーのみが管理** |
| OAuth 設定 | ユーザーが各サービスで登録 | **ワンクリック** |
| アカウント | ローカルのみ | **クラウド同期可能** |
| セキュリティ | Secret が端末に存在し得る | **Secret はサーバーのみ** |
| 認証結果の受け渡し | 直接トークン | **ワンタイムコード（60秒）** |
| Refresh Token | なし | **ローテーション + 再利用検知** |
| コスト | $0 | **$20-350/月**（規模による） |
| 運用負荷 | なし | **サーバー運用が必要** |

**結論**：世界中の一般ユーザーに無料公開し、OAuth 設定を要求しない製品を実現するには、公式認証サーバーの導入が不可欠です。既存の OAuth 実装・暗号化・監査設計を最大限活用し、段階的に移行することで、既存ユーザーへの影響を最小限に抑えられます。

**v2 改訂の要点**：

- デスクトップへの認証結果は **ワンタイムコード方式** に変更（トークンをURLに含めない）
- Refresh Token に **ローテーション + 再利用検知** を追加
- Redis 障害時の **PostgreSQL フォールバック** を明記
- 既存ユーザーの **アカウント関連付けフロー** を具体化
- アカウント削除時の **サーバー/ローカル両方のデータ扱い** を明記
- セキュリティリスク一覧と実装前課題一覧を追加
