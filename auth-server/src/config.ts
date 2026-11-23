import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const nodeEnv = opt('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

const publicUrl = opt('AUTH_PUBLIC_URL', 'http://127.0.0.1:8080').replace(/\/+$/, '');
const insecureHttpAllowed = opt('AUTH_DEV_INSECURE_HTTP', '0') === '1';
if (!publicUrl.startsWith('https://') && !insecureHttpAllowed) {
  throw new Error('AUTH_PUBLIC_URL must use https:// unless AUTH_DEV_INSECURE_HTTP=1 (local dev only)');
}
if (insecureHttpAllowed && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(publicUrl)) {
  throw new Error('AUTH_DEV_INSECURE_HTTP=1 is only allowed for loopback AUTH_PUBLIC_URL');
}

// ---- 本番環境の必須設定（起動拒否） ----
const databaseUrl = opt('DATABASE_URL');
const redisUrl = opt('REDIS_URL');
const jwtPrivateKeyPem = opt('AUTH_JWT_PRIVATE_KEY_PEM');
const jwtPublicKeyPem = opt('AUTH_JWT_PUBLIC_KEY_PEM');
if (isProd) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required in production (PGlite is dev/test only)');
  }
  if (!jwtPrivateKeyPem || !jwtPublicKeyPem) {
    throw new Error('AUTH_JWT_PRIVATE_KEY_PEM and AUTH_JWT_PUBLIC_KEY_PEM are required in production (auto-generated keys are dev-only)');
  }
}

// ---- メールプロバイダ検証 ----
// 本番では実送信プロバイダ必須（mock は実メールを送らないため禁止）。
// 未対応のプロバイダ名・resend の設定不足は全環境で起動拒否。
const mailProvider = opt('MAIL_PROVIDER', 'mock').toLowerCase();
// メールアドレス形式の簡易検証。「addr」「Display Name <addr>」の両方を許可。
// 過剰に厳しいRFC準拠は行わず、@とドメインの最低限の形だけを見る。
function isValidMailAddress(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 320) return false;
  const m = trimmed.match(/<([^<>\s]+@[^<>\s]+)>/);
  const addr = (m ? m[1] : trimmed).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr);
}
const SUPPORTED_MAIL_PROVIDERS = new Set(['mock', 'resend']);
if (!SUPPORTED_MAIL_PROVIDERS.has(mailProvider)) {
  throw new Error(`Unsupported MAIL_PROVIDER: ${mailProvider} (supported: mock, resend)`);
}
if (isProd && mailProvider === 'mock') {
  throw new Error('MAIL_PROVIDER=mock is not allowed in production (no real email is sent). Set MAIL_PROVIDER=resend with RESEND_API_KEY and MAIL_FROM.');
}
if (mailProvider === 'resend') {
  if (!opt('RESEND_API_KEY')) {
    throw new Error('RESEND_API_KEY is required when MAIL_PROVIDER=resend');
  }
  const mailFrom = opt('MAIL_FROM');
  if (!mailFrom) {
    throw new Error('MAIL_FROM is required when MAIL_PROVIDER=resend (e.g. BlockWhiz <noreply@your-domain.com>)');
  }
  if (!isValidMailAddress(mailFrom)) {
    throw new Error('MAIL_FROM is not a valid email address (plain addr or "Display Name <addr>" format)');
  }
  const mailReplyTo = opt('MAIL_REPLY_TO');
  if (mailReplyTo && !isValidMailAddress(mailReplyTo)) {
    throw new Error('MAIL_REPLY_TO is not a valid email address');
  }
}

// BIND_HOST: 本番では明示必須。開発時のみ loopback に限定。
const bindHost = opt('BIND_HOST');
if (isProd && !bindHost) {
  throw new Error('BIND_HOST is required in production (e.g. 127.0.0.1 behind a TLS reverse proxy)');
}
// 信頼するプロキシ: 'none' | 'loopback' | 'linklocal' | 'uniquelocal' | 'render' | カンマ区切りIP/CIDR
// 'render' は Render 専用モード（X-Forwarded-For 先頭をクライアントIPとして採用）。
// 他の値との併用は不可。VPS等の他環境では使用しないこと（XFF偽装の危険がある）。
const trustedProxy = opt('TRUSTED_PROXY', '');
if (trustedProxy) {
    const allowedKeywords = new Set(['loopback', 'linklocal', 'uniquelocal', 'render']);
    const ipCidr = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/;
    const parts = trustedProxy.split(',').map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (!allowedKeywords.has(part) && !ipCidr.test(part)) {
        throw new Error(`Invalid TRUSTED_PROXY entry: ${part} (use 'loopback', 'render', or IP/CIDR list)`);
      }
    }
    if (parts.includes('render') && parts.length > 1) {
      throw new Error("TRUSTED_PROXY='render' cannot be combined with other values");
    }
  }

export const config = {
  nodeEnv,
  isProd,
  port: num('PORT', 8080),
  publicUrl,
  insecureHttpAllowed,
  bindHost: bindHost || (insecureHttpAllowed ? '127.0.0.1' : '127.0.0.1'),
  trustedProxy,
  google: {
    clientId: req('GOOGLE_CLIENT_ID'),
    clientSecret: req('GOOGLE_CLIENT_SECRET'),
    authUrl: opt('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: opt('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    jwksUrl: opt('GOOGLE_JWKS_URL', 'https://www.googleapis.com/oauth2/v3/certs'),
    issuer: opt('GOOGLE_ISSUER', 'https://accounts.google.com'),
    userinfoUrl: opt('GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo'),
  },
  jwt: {
    issuer: opt('AUTH_JWT_ISSUER', 'craftmate-auth'),
    audience: opt('AUTH_JWT_AUDIENCE', 'craftmate-desktop'),
    accessTtlSec: num('ACCESS_TOKEN_TTL_SECONDS', 600),
    refreshTtlSec: num('REFRESH_TOKEN_TTL_SECONDS', 2592000),
    privateKeyPem: jwtPrivateKeyPem,
    publicKeyPem: jwtPublicKeyPem,
    // 鍵ローテーション: 旧公開鍵（検証のみ）。新ペア発行後、旧鍵で署名された
    // トークンが期限切れになるまで検証に使い、その後削除する。
    previousPublicKeyPem: opt('AUTH_JWT_PREVIOUS_PUBLIC_KEY_PEM'),
    kid: opt('AUTH_JWT_KID', 'key-1'),
    keyDir: path.join(here, '..', 'data'),
  },
  oauth: {
    flowTtlSec: num('OAUTH_FLOW_TTL_SECONDS', 600),
    oneTimeCodeTtlSec: num('ONE_TIME_CODE_TTL_SECONDS', 60),
  },
  mail: {
    provider: opt('MAIL_PROVIDER', 'mock').toLowerCase(),      // 'mock' | 'resend'
    resendApiKey: opt('RESEND_API_KEY'),
    from: opt('MAIL_FROM'),
    replyTo: opt('MAIL_REPLY_TO'),
    tokenTtlSec: num('EMAIL_TOKEN_TTL_SECONDS', 3600),       // メール確認・リセットトークン有効期限（1時間）
    resetTokenTtlSec: num('PASSWORD_RESET_TOKEN_TTL_SECONDS', 1800), // パスワードリセット（30分）
  },
  db: {
    // DATABASE_URL 設定時は実PostgreSQL（node-postgres）。未設定時は PGlite（開発/テスト用）
    url: databaseUrl,
    ssl: opt('DATABASE_SSL', isProd ? 'require' : 'prefer') as 'require' | 'prefer' | 'disable',
    dataDir: path.join(here, '..', 'data'),
    pgliteDir: opt('PGLITE_DIR') || path.join(here, '..', 'data', 'authserver.pglite'),
  },
  redis: {
    url: redisUrl,
  },
  server: {
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 30000),
    headersTimeoutMs: num('HEADERS_TIMEOUT_MS', 15000),
    keepAliveTimeoutMs: num('KEEP_ALIVE_TIMEOUT_MS', 65000),
  },
} as const;
