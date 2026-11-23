# BlockWhiz Auth Server アカウントフロー設計メモ（Phase F）

## 1. OAuth専用ユーザーのパスワード設定・メール確認（設計案・未実装）

### 現状
- OAuth（Google等）で登録したユーザーは `password_hash IS NULL`。
- `/auth/email/verify/request`・`/auth/password/reset/request` は `password_hash IS NOT NULL` のユーザーのみ対象。
- そのため OAuth専用ユーザーはメール確認もパスワードログインもできない。

### 設計案A：パスワード設定フロー（推奨）
1. `POST /auth/password/set/request`（Bearer必須）：ログイン中のOAuth専用ユーザーが「パスワードを設定するメール」を要求。
   - `email_tokens` に `purpose='set_password'`、`new_email` 不要のトークンを発行。
   - 列挙防止：Bearer認証済みなのでメールアドレス存在確認は不要（自分のアドレスに送るだけ）。
2. `GET /auth/password/set?token=` → 確認ページ（GETは消費しない）。
3. `POST /auth/password/set/complete`：トークン消費 + `password_hash` 設定 + `email_verified` はIdPの検証結果を維持。
   - 既に `password_hash` がある場合は 409（パスワード変更は `/auth/password/change` を使う）。
4. 設定後はメール+パスワードでもログイン可能になる（同一 `users` 行、`external_identities` も維持）。

### 設計案B：メール確認のみ先に行う
- `verify_email` トークンを OAuth専用ユーザーにも許可し、確認後にパスワード設定を別途案内。
- 実装は単純だが「確認済みなのにパスワードが無い」状態が続くため、案Aの方がUXが良い。

### 注意点
- OAuth専用ユーザーにパスワードを設定しても、**OAuthアイデンティティと資格情報は同一ユーザーに紐づく**（自動マージではなく明示的な紐付け）。
- パスワード設定後にOAuth連携を解除する機能は現状ないため、少なくとも1つのログイン手段は常に残る。

## 2. メール確認を無効化した場合のセキュリティ評価

| 項目 | 評価 |
|---|---|
| なりすまし登録 | ⚠️ 他人のメールアドレスで登録可能。確認なしでは「そのメールの所有者か」を検証できない。ただしログインにはパスワードが必要なため、第三者がログインすることはできない。影響は「メールアドレスの占有」と「パスワードリセットメールが他人に届く」点 |
| パスワードリセット悪用 | ⚠️ リセットメールは登録アドレスに送られるため、他人のアドレスで登録された場合、本物の所有者がリセットを要求すると攻撃者のアカウントのパスワードが変更される。**確認済みメールのみリセット許可にするのが望ましい** |
| 推奨ポリシー | Beta初期は「確認任意・リセットは確認済みのみ」または「確認必須」にする。完全に確認を無効化するとリセット悪用リスクが残る |

## 3. 実メールプロバイダ実装時のインターフェース（確定済み）

```ts
interface Mailer { send(msg: { to: string; subject: string; text: string }): Promise<void>; }
```

- `config.mail.provider`（`MAIL_PROVIDER`）で選択。既定 `mock`。
- 実装追加時は `mailer.ts` に `ResendMailer` 等を追加し `switch` に case を足すだけ。
- APIキーは環境変数（例: `RESEND_API_KEY`）から読み、ソース・ログ・配布物に含めない。
- 送信失敗時：監査ログ記録 + API応答は成功（列挙防止）。ユーザーは再送ボタンで再試行可能。
