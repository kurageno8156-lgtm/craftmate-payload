// 外部サービス連携（OAuth2 / トークン）の共通ロジック。
// - プロバイダごとのエンドポイント・スコープ定義
// - PKCE (S256) 生成
// - トークン交換
// - AES-256-GCM による保存データの暗号化（鍵は %LOCALAPPDATA%/CraftMate/integrations.key）

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

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
    // refresh_token を取得するため offline アクセスを要求
    extraAuthParams: { access_type: 'offline' },
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
    // 最小権限: プロフィール + メール取得のみ（repo 等の過剰スコープは要求しない）
    scopes: 'read:user user:email',
    extraAuthParams: { allow_signup: 'false' },
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
  {
    id: 'discord',
    label: 'Discord',
    description: 'Discord アカウント連携（OAuth2 / OIDC）',
    style: 'oauth',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    // identify: ユーザー情報 / email: メールアドレス取得
    scopes: 'identify email',
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

// ---------- プロバイダエンドポイント解決 ----------
// Microsoft は MICROSOFT_TENANT_ID でテナントを切り替え可能（既定: common）。
// 個人用/組織用アカウントの対象範囲を絞りたい場合に 'consumers' / 'organizations' / テナントID を指定する。
export function resolveAuthorizeUrl(provider: IntegrationProvider): string {
  if (provider.id === 'microsoft') {
    const tenant = (process.env.MICROSOFT_TENANT_ID || 'common').trim() || 'common';
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
  }
  return provider.authorizeUrl as string;
}

export function resolveTokenUrl(provider: IntegrationProvider): string {
  if (provider.id === 'microsoft') {
    const tenant = (process.env.MICROSOFT_TENANT_ID || 'common').trim() || 'common';
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  }
  return provider.tokenUrl as string;
}

// OIDC の nonce を使うプロバイダ（GitHub OAuth Apps / Discord identify+email は nonce 非対応）
export function providerUsesNonce(provider: IntegrationProvider): boolean {
  return provider.id === 'google' || provider.id === 'microsoft';
}

// ---------- OAuth 認可URL ----------
export function buildAuthorizeUrl(
  provider: IntegrationProvider,
  opts: { redirectUri: string; state: string; codeChallenge?: string; clientId: string; nonce?: string }
): string {
  const authorizeUrl = resolveAuthorizeUrl(provider);
  if (!authorizeUrl) throw new Error('provider has no authorizeUrl');
  const u = new URL(authorizeUrl);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', opts.state);
  if (provider.scopes) u.searchParams.set('scope', provider.scopes);
  if (provider.extraAuthParams) {
    for (const [k, v] of Object.entries(provider.extraAuthParams)) u.searchParams.set(k, v);
  }
  // X は PKCE 必須。Google/Microsoft/Discord も PKCE 対応のため常に付与してよい
  if (opts.codeChallenge) {
    u.searchParams.set('code_challenge', opts.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  // OIDC nonce（リプレイ対策）。対応プロバイダのみ付与。
  if (opts.nonce && providerUsesNonce(provider)) {
    u.searchParams.set('nonce', opts.nonce);
  }
  return u.toString();
}

// ---------- トークン交換 ----------
export async function exchangeCode(
  provider: IntegrationProvider,
  opts: { code: string; redirectUri: string; clientId: string; clientSecret?: string; codeVerifier?: string }
): Promise<Record<string, unknown>> {
  const tokenUrl = resolveTokenUrl(provider);
  if (!tokenUrl) throw new Error('provider has no tokenUrl');
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

  const res = await fetch(tokenUrl, { method: 'POST', headers, body });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* GitHub は JSON で返す */ }
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  if (data.error) throw new Error(`token exchange error: ${data.error} ${data.error_description || ''}`.trim());
  return data as Record<string, unknown>;
}

// ---------- リフレッシュトークン ----------
// Google / Microsoft / Discord が refresh_token を発行した場合に更新する。
// GitHub OAuth Apps はリフレッシュトークンを発行しない（期限切れ・失効時は再連携が必要）。
export async function refreshAccessToken(
  provider: IntegrationProvider,
  opts: { refreshToken: string; clientId: string; clientSecret?: string }
): Promise<Record<string, unknown>> {
  const tokenUrl = resolveTokenUrl(provider);
  if (!tokenUrl) throw new Error('provider has no tokenUrl');
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', opts.refreshToken);
  body.set('client_id', opts.clientId);
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);

  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
  if (provider.id === 'github' && opts.clientSecret) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    body.delete('client_secret');
  }

  const res = await fetch(tokenUrl, { method: 'POST', headers, body });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  if (data.error) throw new Error(`token refresh error: ${data.error} ${data.error_description || ''}`.trim());
  return data as Record<string, unknown>;
}

/**
 * リフレッシュ応答を既存トークンデータにマージする。
 * - 新しい refresh_token が返れば置き換え、返らなければ旧トークンを維持
 * - expires_in があれば tokenExpiresAt を再計算
 */
export function mergeRefreshedTokens(
  existing: Record<string, unknown>,
  fresh: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...existing, ...fresh };
  if (!fresh.refresh_token && existing.refresh_token) {
    merged.refresh_token = existing.refresh_token;
  }
  if (Number(fresh.expires_in) > 0) {
    merged.tokenExpiresAt = Date.now() + Number(fresh.expires_in) * 1000;
  }
  return merged;
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
  // 環境変数で鍵を上書き可能（CI/本番運用向け）。
  // OAUTH_ENCRYPTION_KEY: 32バイトを hex(64文字) または base64 で指定。
  // OAUTH_SESSION_SECRET: 任意長の秘密文字列（SHA-256で32バイトに導出）。
  const envHex = process.env.OAUTH_ENCRYPTION_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(envHex)) {
    cachedKey = Buffer.from(envHex, 'hex');
    return cachedKey;
  }
  if (envHex) {
    const raw = Buffer.from(envHex, 'base64');
    cachedKey = raw.length === 32 ? raw : crypto.createHash('sha256').update(envHex).digest();
    return cachedKey;
  }
  const envSecret = process.env.OAUTH_SESSION_SECRET || '';
  if (envSecret) {
    cachedKey = crypto.createHash('sha256').update(envSecret).digest();
    return cachedKey;
  }
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

// ---------- OIDC ID トークン検証（JWKS / 署名 / iss / aud / exp / nonce） ----------
// Google / Microsoft が発行する id_token を検証する。
// GitHub OAuth Apps は id_token を発行しない。Discord は identify+email 構成では
// id_token を発行しないため API プロフィール取得のみ（将来 openid スコープ対応時に検証可能）。

const OIDC_ISSUERS: Record<string, string[]> = {
  google: ['https://accounts.google.com', 'accounts.google.com'],
  microsoft: ['https://login.microsoftonline.com/{tenant}/v2.0'],
  discord: ['https://discord.com'],
};

// Microsoft の iss はマルチテナント構成では実際のテナント GUID を含む
// （例: https://login.microsoftonline.com/{tenant-guid}/v2.0）。
// 'common' 指定時も GUID が返るため、厳密一致ではなく Entra ドメイン + /v2.0 を検査する。
function issuerMatches(providerId: string, issuer: unknown): boolean {
  if (typeof issuer !== 'string') return false;
  const candidates = issuerCandidates(providerId);
  if (candidates.includes(issuer)) return true;
  if (providerId === 'microsoft') {
    return /^https:\/\/login\.microsoftonline\.com\/[A-Za-z0-9\-_.]+\/v2\.0$/.test(issuer);
  }
  return false;
}

function issuerCandidates(providerId: string): string[] {
  const list = OIDC_ISSUERS[providerId] || [];
  if (providerId === 'microsoft') {
    const tenant = (process.env.MICROSOFT_TENANT_ID || 'common').trim() || 'common';
    return [`https://login.microsoftonline.com/${tenant}/v2.0`];
  }
  return list;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

const OIDC_JWKS: Record<string, string> = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  microsoft: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  discord: 'https://discord.com/api/oauth2/keys',
};

export interface VerifiedIdToken { sub?: string; email?: string; name?: string; nonce?: string; [k: string]: unknown }

/** id_token の署名・issuer・audience・有効期限・nonce を検証して claims を返す */
export async function verifyIdToken(
  providerId: string,
  idToken: string,
  opts: { clientId: string; nonce?: string }
): Promise<VerifiedIdToken> {
  const jwksUri = OIDC_JWKS[providerId];
  if (!jwksUri) throw new Error(`id_token verification not supported for ${providerId}`);
  // issuer はプロバイダごとの規則で別途検査（Microsoft はテナント GUID を許容）
  const { payload } = await jwtVerify(idToken, getJwks(jwksUri), {
    audience: opts.clientId,
  });
  if (!issuerMatches(providerId, payload.iss)) {
    throw new Error(`id_token issuer mismatch: ${String(payload.iss)}`);
  }
  if (opts.nonce && payload.nonce !== opts.nonce) {
    throw new Error('id_token nonce mismatch (possible replay)');
  }
  return payload as VerifiedIdToken;
}

// ---------- プロバイダ・プロフィール取得 ----------
export interface ProviderProfile {
  providerUserId?: string;
  label?: string;
  email?: string;
  name?: string;
  detail?: string;
}

async function fetchJson(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extraHeaders },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`profile fetch failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * トークン交換後にプロバイダからユーザー情報を取得する。
 * id_token がある場合はまず署名検証し、検証済み claims を優先する。
 * 取得できない場合はユーザー情報エンドポイントにフォールバックする。
 */
export async function fetchProviderProfile(
  provider: IntegrationProvider,
  tokenData: Record<string, unknown>,
  opts: { clientId: string; nonce?: string }
): Promise<ProviderProfile> {
  const accessToken = String(tokenData.access_token || '');
  const idToken = tokenData.id_token ? String(tokenData.id_token) : '';

  // 1) id_token があれば検証して claims を使う
  if (idToken && providerUsesNonce(provider)) {
    try {
      const claims = await verifyIdToken(provider.id, idToken, opts);
      const profile: ProviderProfile = {
        providerUserId: claims.sub ? String(claims.sub) : undefined,
        label: (claims.email as string) || (claims.preferred_username as string) || (claims.name as string) || undefined,
        email: (claims.email as string) || undefined,
        name: (claims.name as string) || undefined,
        detail: provider.id,
      };
      if (profile.providerUserId) return profile;
    } catch (e) {
      // id_token 検証失敗は致命的（なりすまし防止のためプロフィール取得に進まない）
      throw new Error(`id_token verification failed: ${(e as Error).message}`);
    }
  }

  // 2) アクセストークンでユーザー情報エンドポイントから取得
  if (!accessToken) return { detail: provider.id };
  try {
    switch (provider.id) {
      case 'google': {
        const info = await fetchJson('https://openidconnect.googleapis.com/v1/userinfo', accessToken);
        return {
          providerUserId: info.sub ? String(info.sub) : undefined,
          label: info.email || info.name,
          email: info.email,
          name: info.name,
          detail: 'google',
        };
      }
      case 'microsoft': {
        // Graph OIDC userinfo（openid/email/profile スコープで利用可能）
        const info = await fetchJson('https://graph.microsoft.com/oidc/userinfo', accessToken);
        return {
          providerUserId: info.sub ? String(info.sub) : undefined,
          label: info.email || info.preferred_username || info.name,
          email: info.email,
          name: info.name,
          detail: 'microsoft',
        };
      }
      case 'github': {
        const user = await fetchJson('https://api.github.com/user', accessToken, {
          'User-Agent': 'CraftMate',
          'X-GitHub-Api-Version': '2022-11-28',
        });
        // メールが非公開の場合は /user/emails から primary を取得
        let email = user.email as string | null;
        if (!email) {
          try {
            const emails = await fetchJson('https://api.github.com/user/emails', accessToken, {
              'User-Agent': 'CraftMate',
              'X-GitHub-Api-Version': '2022-11-28',
            });
            const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary && e.verified) || emails[0] : null;
            email = primary?.email || null;
          } catch { /* email なしでも続行 */ }
        }
        return {
          providerUserId: user.id != null ? String(user.id) : undefined,
          label: user.login || email || 'GitHub user',
          email: email || undefined,
          name: user.name || user.login,
          detail: 'github',
        };
      }
      case 'discord': {
        const user = await fetchJson('https://discord.com/api/users/@me', accessToken);
        return {
          providerUserId: user.id ? String(user.id) : undefined,
          label: user.global_name || user.username,
          email: user.email || undefined,
          name: user.global_name || user.username,
          detail: 'discord',
        };
      }
    }
  } catch (e) {
    throw new Error(`failed to fetch ${provider.id} profile: ${(e as Error).message}`);
  }
  return { detail: provider.id };
}

// ---------- CraftMate アカウント識別 ----------
// provider + provider_user_id が外部アカウントの一意キー。
// external_identities.craftmate_user がその外部IDの所有者（CraftMateアカウントID）。
// ログイン時は所有者が見つかればそのアカウントでログインし、
// 見つからなければ新規アカウント（oauth:<provider>:<id>）を作る。
// 連携時はログイン中ユーザーのみが実行でき、別所有者なら拒否する。

export interface CraftmateUserResolution {
  craftmateUser: string;
  /** 連携時に別ユーザー所有の外部IDだった場合 true（呼び出し側で拒否する） */
  conflict: boolean;
}

export function resolveCraftmateUser(opts: {
  purpose?: 'login' | 'integration';
  providerId: string;
  providerUserId?: string;
  /** 連携時のログイン中 CraftMate ユーザー（local:<name> / oauth:<provider>:<id>） */
  sessionUser?: string;
  accountLabel?: string;
  /** getExternalIdentity() の craftmate_user（未連携なら null/undefined） */
  existingOwner?: string | null;
}): CraftmateUserResolution {
  const { purpose, providerId, providerUserId, sessionUser, accountLabel, existingOwner } = opts;

  if (purpose === 'login') {
    // 連携済みの外部ID → 所有者アカウントでログイン。
    // 未連携 → このプロバイダ固有の新規アカウント。
    const craftmateUser = existingOwner
      || `oauth:${providerId}:${providerUserId || accountLabel || 'unknown'}`;
    return { craftmateUser, conflict: false };
  }

  // 連携: ログイン中ユーザーに紐付ける。別所有者なら拒否。
  const craftmateUser = sessionUser || `oauth:${providerId}:${providerUserId || accountLabel || 'unknown'}`;
  const conflict = !!(existingOwner && existingOwner !== craftmateUser);
  return { craftmateUser, conflict };
}

// ---------- アカウント情報の抽出（表示用・トークンは含めない） ----------
export function summarizeAccount(platform: string, tokenData: Record<string, unknown>): { label?: string; detail?: string } {
  // 保存済みプロフィールを優先（fetchProviderProfile の結果）
  const profile = tokenData.profile as ProviderProfile | undefined;
  if (profile && (profile.label || profile.email)) {
    return { label: profile.label || profile.email, detail: profile.detail || platform };
  }
  try {
    if ((platform === 'google' || platform === 'microsoft') && tokenData.id_token) {
      const payload = JSON.parse(Buffer.from(String(tokenData.id_token).split('.')[1], 'base64url').toString());
      return { label: payload.email || payload.name || payload.preferred_username, detail: platform };
    }
  } catch { /* ignore */ }
  return { label: platform, detail: 'connected' };
}
