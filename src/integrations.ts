// 外部サービス連携（OAuth2 / トークン）の共通ロジック。
// - プロバイダごとのエンドポイント・スコープ定義
// - PKCE (S256) 生成
// - トークン交換
// - AES-256-GCM による保存データの暗号化（鍵は %LOCALAPPDATA%/CraftMate/integrations.key）

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface IntegrationProvider {
  id: string;
  label: string;
  description: string;
  // 'oauth' = 認証コードフロー / 'token' = トークン貼り付けのみ
  style: 'oauth' | 'token';
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  extraAuthParams?: Record<string, string>;
  // クライアントID/シークレットをユーザーが入力するか、.env から読むか
  clientIdEnv?: string;
  clientSecretEnv?: string;
  tokenHint?: string; // token モード時の入力欄ヒント
}

export const INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  {
    id: 'google',
    label: 'Google',
    description: 'Google アカウント連携（Gemini API / Google Cloud）',
    style: 'oauth',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  {
    id: 'microsoft',
    label: 'Microsoft',
    description: 'Microsoft アカウント連携（Azure OpenAI / Entra ID）',
    style: 'oauth',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: 'openid email profile offline_access',
    clientIdEnv: 'MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'GitHub 連携（リポジトリ / Copilot）',
    style: 'oauth',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: 'read:user repo',
    extraAuthParams: { allow_signup: 'false' },
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
  {
    id: 'discord',
    label: 'Discord',
    description: 'Discord アカウント連携（OAuth2）',
    style: 'oauth',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scopes: 'identify',
    clientIdEnv: 'DISCORD_CLIENT_ID',
    clientSecretEnv: 'DISCORD_CLIENT_SECRET',
  },
];

export function getProvider(id: string): IntegrationProvider | undefined {
  return INTEGRATION_PROVIDERS.find(p => p.id === id);
}

// ---------- PKCE ----------
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ---------- OAuth 認可URL ----------
export function buildAuthorizeUrl(
  provider: IntegrationProvider,
  opts: { redirectUri: string; state: string; codeChallenge?: string; clientId: string }
): string {
  if (!provider.authorizeUrl) throw new Error('provider has no authorizeUrl');
  const u = new URL(provider.authorizeUrl);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', opts.state);
  if (provider.scopes) u.searchParams.set('scope', provider.scopes);
  if (provider.extraAuthParams) {
    for (const [k, v] of Object.entries(provider.extraAuthParams)) u.searchParams.set(k, v);
  }
  // X は PKCE 必須。Google/Microsoft も PKCE 対応のため常に付与してよい
  if (opts.codeChallenge) {
    u.searchParams.set('code_challenge', opts.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

// ---------- トークン交換 ----------
export async function exchangeCode(
  provider: IntegrationProvider,
  opts: { code: string; redirectUri: string; clientId: string; clientSecret?: string; codeVerifier?: string }
): Promise<Record<string, unknown>> {
  if (!provider.tokenUrl) throw new Error('provider has no tokenUrl');
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', opts.code);
  body.set('redirect_uri', opts.redirectUri);
  body.set('client_id', opts.clientId);
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  if (opts.codeVerifier) body.set('code_verifier', opts.codeVerifier);

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
  // GitHub は Basic 認証を推奨（client_secret を body に入れない）
  if (provider.id === 'github' && opts.clientSecret) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    body.delete('client_secret');
  }

  const res = await fetch(provider.tokenUrl, { method: 'POST', headers, body });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* GitHub は JSON で返す */ }
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  if (data.error) throw new Error(`token exchange error: ${data.error} ${data.error_description || ''}`.trim());
  return data as Record<string, unknown>;
}

// ---------- 暗号化（AES-256-GCM） ----------
// 注意: これは OS キーチェーンではなく、ローカル鍵ファイルによる暗号化。
// 鍵ファイルは %LOCALAPPDATA%\CraftMate\integrations.key（mode 0600）。
// DPAPI/Keychain/libsecret を使うにはネイティブモジュールが必要なため
// 現状はこの方式。DB 単体が漏れても鍵が無ければ復号できない。

let cachedKey: Buffer | null = null;

function keyPath(): string {
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CraftMate');
  return path.join(dir, 'integrations.key');
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const kp = keyPath();
  try {
    const existing = fs.readFileSync(kp);
    if (existing.length === 32) { cachedKey = existing; return cachedKey; }
  } catch { /* generate */ }
  fs.mkdirSync(path.dirname(kp), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(kp, key, { mode: 0o600 });
  cachedKey = key;
  return key;
}

export function encryptJson(obj: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptJson<T = any>(payload: string): T | null {
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8')) as T;
  } catch {
    return null;
  }
}

// ---------- アカウント情報の抽出（表示用・トークンは含めない） ----------
export function summarizeAccount(platform: string, tokenData: Record<string, unknown>): { label?: string; detail?: string } {
  try {
    if (platform === 'google' && tokenData.id_token) {
      const payload = JSON.parse(Buffer.from(String(tokenData.id_token).split('.')[1], 'base64url').toString());
      return { label: payload.email || payload.name, detail: payload.name };
    }
    if (platform === 'microsoft' && tokenData.id_token) {
      const payload = JSON.parse(Buffer.from(String(tokenData.id_token).split('.')[1], 'base64url').toString());
      return { label: payload.email || payload.preferred_username, detail: payload.name };
    }
    if (platform === 'github' && tokenData.access_token) {
      return { label: 'GitHub token', detail: 'connected' };
    }
    if (platform === 'discord' && tokenData.access_token) {
      return { label: 'Discord account', detail: 'connected' };
    }
  } catch { /* ignore */ }
  return { label: platform, detail: 'connected' };
}
