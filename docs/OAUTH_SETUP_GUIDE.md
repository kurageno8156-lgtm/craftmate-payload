# BlockWhiz OAuth 設定マニュアル

BlockWhiz のダッシュボードログイン／外部アカウント連携（Google・GitHub・Discord）を使うための、一般ユーザー向け設定手順です。

> **対象外**：Minecraft 本体の Microsoft アカウント認証は別機能であり、このマニュアルの対象ではありません。

---

## 第1章：OAuth とは

OAuth は「BlockWhiz があなたの代わりに Google / GitHub / Discord のアカウント情報を安全に利用するための仕組み」です。

- 各サービス（Google など）で「BlockWhiz というアプリ」を登録すると、**Client ID** と **Client Secret** という2つの鍵が発行されます
- その鍵を BlockWhiz の設定ファイルに記入すると、ログイン画面に各サービスのボタンが有効になります
- パスワードを BlockWhiz に教える必要はなく、認証は各サービスの公式画面で行われます

**なぜ自分で設定するのか**

配布版の BlockWhiz には、セキュリティ上の理由から Client Secret を同梱していません。そのため、OAuth ログインを使いたい場合は、ご自身で各サービスにアプリを登録し、鍵を設定ファイルに記入する必要があります。登録は各サービスで無料・数分で完了します。

パスワードログイン（ユーザー名/パスワード）や、設定しないままの利用も可能です。

---

## 第2章：設定ファイルの作成

### 保存場所

OS ごとに以下の場所に `oauth-clients.json` を保存してください。

| OS | 保存場所 |
|---|---|
| Windows | `%LOCALAPPDATA%\CraftMate\oauth-clients.json` |
| Linux | `~/.config/craftmate/oauth-clients.json`（`$XDG_CONFIG_HOME` が設定されている場合は `$XDG_CONFIG_HOME/craftmate/oauth-clients.json`） |
| macOS | `~/.config/craftmate/oauth-clients.json` |

Windows での具体例：エクスプローラーのアドレスバーに `%LOCALAPPDATA%\CraftMate` と入力して開き、その中に `oauth-clients.json` という名前でファイルを作成します。フォルダが無ければ作成してください。

### ファイルの内容（JSON サンプル）

使うプロバイダの分だけ記入すれば構いません。未使用のプロバイダは空のままか、行ごと削除しても問題ありません。

```json
{
  "google": {
    "clientId": "ここに Google の Client ID",
    "clientSecret": "ここに Google の Client Secret"
  },
  "github": {
    "clientId": "ここに GitHub の Client ID",
    "clientSecret": "ここに GitHub の Client Secret"
  },
  "discord": {
    "clientId": "ここに Discord の Client ID",
    "clientSecret": "ここに Discord の Client Secret"
  }
}
```

### JSON 編集時の注意点

- **キー名は `clientId` / `clientSecret`（先頭小文字）** です。`client_id` などは認識されません
- 文字列は必ず **ダブルクォート `"`** で囲んでください
- 各行の末尾のカンマ `,` を忘れないでください（最後の項目の後ろにはカンマ不要）
- メモ用のコメント（`//` や `/* */`）は JSON では使えません
- ファイル名は **`oauth-clients.json`（拡張子 .json）** です。`oauth-clients.json.txt` のような名前は認識されません
- 保存は **UTF-8** で行ってください

### 補足：環境変数での設定（上級者向け）

設定ファイルの代わりに、環境変数 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` でも設定できます。優先順位は「リクエスト指定 > 環境変数 > 設定ファイル」です。通常は設定ファイルで十分です。

---

## 第3章：Google の設定

### 手順

1. [Google Cloud Console](https://console.cloud.google.com/) にログイン
2. プロジェクトを作成（または既存を選択）
3. **「APIとサービス」→「OAuth 同意画面」** を開き、アプリ名などを入力して同意画面を設定
4. **「APIとサービス」→「認証情報」→「+ 認証情報を作成」→「OAuth クライアント ID」**
5. アプリケーションの種類で **「デスクトップアプリ」** を選択
6. 名前を入力して作成

### コールバック URL

Google のデスクトップアプリ種別では、コールバック URL の登録は不要です（BlockWhiz が自動でリダイレクトを処理します）。

BlockWhiz が実際に使うリダイレクト先は以下の形式です（ポートは BlockWhiz の設定により異なります）：

```
http://127.0.0.1:3000/api/integrations/google/oauth/callback
```

### Client ID / Secret の取得

作成後に表示される **「クライアント ID」** と **「クライアントシークレット」** をコピーし、`oauth-clients.json` の `google` に貼り付けます。

---

## 第4章：GitHub の設定

### 手順

1. GitHub にログインし、右上アイコン → **「Settings」**
2. 左メニュー最下部 **「Developer settings」**
3. **「OAuth Apps」→「New OAuth App」**
4. 以下を入力：

| 項目 | 入力値 |
|---|---|
| Application name | `BlockWhiz`（任意の名前） |
| Homepage URL | `http://127.0.0.1:3000`（任意のURLでも可） |
| **Authorization callback URL** | `http://127.0.0.1:3000/api/integrations/github/oauth/callback` |

> BlockWhiz のポートが 3000 以外の場合は、URL のポート番号を実際のポートに合わせてください（第6章参照）。複数ポートを使う場合は、OAuth App 作成後に **「Edit」** から callback URL を追加登録できます。

5. **「Register application」** をクリック

### Client ID / Secret の取得

作成後のページに **Client ID** が表示されます。**「Generate a new client secret」** をクリックすると Client Secret が発行されます（**一度しか表示されない**ので必ずコピーしてください）。

---

## 第5章：Discord の設定

### 手順

1. [Discord Developer Portal](https://discord.com/developers/applications) にログイン
2. **「New Application」** をクリックし、アプリ名（例：`BlockWhiz`）を入力
3. 左メニュー **「OAuth2」** を開く
4. **「Redirects」** の **「Add Redirect」** をクリックし、以下を入力して **「Save Changes」**：

```
http://127.0.0.1:3000/api/integrations/discord/oauth/callback
```

> ポートが 3000 以外の場合は実際のポートに合わせてください。複数の callback URL を登録できます。

5. 同じ **「OAuth2」** ページの **「Client Information」** に **Client ID** が表示されています
6. **「Client Secret」** の **「Reset Secret」** をクリックしてシークレットを発行（**一度しか表示されない**ので必ずコピー）

---

## 第6章：BlockWhiz への反映

1. `oauth-clients.json` を上記の保存場所に保存
2. **BlockWhiz を完全に終了して再起動**してください
   - 設定ファイルは BlockWhiz 起動時に一度だけ読み込まれます。編集後の再起動が必須です
3. ダッシュボードを開き、ログイン画面または「外部アカウント連携」画面で確認：
   - 設定済みのプロバイダには **「設定済み」** バッジが表示され、ログイン／連携ボタンが有効になります
   - 未設定のプロバイダは **「未設定」** と表示され、ボタンを押すと設定方法の案内が表示されます

### ポート番号の確認方法

コールバック URL のポートは BlockWhiz の `WEB_PORT` 設定で決まります。

- 既定値：**3000**（`http://127.0.0.1:3000/...`）
- `.env` や設定で `WEB_PORT` を変更している場合はその値
- 開発モード等で別ポート（例：3100）を使っている場合は `http://127.0.0.1:3100/api/integrations/<プロバイダ>/oauth/callback` になります

**`CRAFTMATE_PUBLIC_URL` 環境変数** が設定されている場合は、その URL がコールバックの基点になります（例：`https://example.com` なら `https://example.com/api/integrations/...`）。この場合は各サービス側にも同じ URL を登録してください。

---

## 第7章：トラブルシューティング

### 「未設定」と表示される／ボタンが押せない

- `oauth-clients.json` の保存場所が正しいか確認（第2章の表を参照）
- ファイル名が `oauth-clients.json` ちょうどか確認（`.txt` 等が付いていないか）
- **BlockWhiz を再起動**したか確認
- JSON の構文エラーがないか確認（`clientId` の綴り、カンマ、引用符）
- `clientId` が空文字 `""` のままになっていないか確認

### 「redirect_uri が無効」等のエラー（Discord / GitHub）

- サービス側に登録した callback URL と、BlockWhiz が実際に使う URL が**完全一致**しているか確認
  - ホスト：`127.0.0.1`（`localhost` ではありません）
  - ポート：BlockWhiz の実際のポート（既定 3000）
  - パス：`/api/integrations/<プロバイダ>/oauth/callback`（プロバイダ名は小文字：`google` / `github` / `discord`）
- 末尾の `/` や空白の有無も一致させてください
- ポートを変えた場合はサービス側の登録 URL も更新してください

### 認証は進むが失敗する

- Client ID / Client Secret のコピーミスを確認（Secret の再発行・再コピー）
- JSON 内で値をダブルクォートで囲んでいるか確認
- 対象プロバイダのキー名（`google` / `github` / `discord`）が正しいか確認

### 再起動しても反映されない

- 設定ファイルが**最初に見つかった候補パス**から読み込まれます。アプリのインストールフォルダ等に古い `oauth-clients.json` が残っている場合、そちらが優先されることがあります。その場合はそちらを削除するか、正しい場所に正しい内容で上書きしてください
- BlockWhiz のログ（ダッシュボードのデバッグログ）に `oauth-clients: path=...` という行があり、実際に読み込まれたファイルパスを確認できます

---

## セキュリティ上の注意

- **Client Secret はパスワード同等の秘密情報です。** 他人に共有しないでください
- `oauth-clients.json` を Discord・GitHub 等の公開場所やリポジトリに**アップロード・コミットしない**でください
- スクリーンショットや画面共有に Secret が写らないよう注意してください
- 設定ファイルのアクセス権を自分のユーザーのみに制限することを推奨します（Windows：ファイルのプロパティ → セキュリティ）
- 各サービスの OAuth 設定は、各サービスの利用規約・ポリシーに従って行ってください
- 万が一 Secret が漏洩した場合は、各サービスの管理画面で直ちに再発行してください

---

## 参考：設定の優先順位

BlockWhiz が OAuth クライアント情報を解決する順序：

1. ダッシュボードからのリクエストで直接指定された値
2. 環境変数（`GOOGLE_CLIENT_ID` など）
3. `oauth-clients.json`（上記の候補パスのうち最初に見つかったもの）

※ 配布版には `oauth-clients.json` は同梱されていません。ユーザーが配置したファイルのみが使われます。
