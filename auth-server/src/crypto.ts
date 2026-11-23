import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SignJWT, jwtVerify, importPKCS8, importSPKI, createRemoteJWKSet, jwtVerify as joseVerify } from 'jose';
import { config } from './config.js';

// ---------- 乱数・ハッシュ ----------
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
export function b64urlSha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('base64url');
}
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48); // 64文字 base64url
  return { verifier, challenge: b64urlSha256(verifier) };
}
export function verifyPkce(verifier: string, challenge: string): boolean {
  const calc = b64urlSha256(verifier);
  const a = Buffer.from(calc);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- JWT 署名鍵 ----------
let privateKey: crypto.KeyObject | null = null;
let publicKey: crypto.KeyObject | null = null;
let previousPublicKey: crypto.KeyObject | null = null; // ローテーション中の旧公開鍵（検証のみ）
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function loadKeys() {
  if (privateKey && publicKey) return;
  // 本番では自動生成・ファイル保存を一切行わない（config.ts でも起動時に拒否するが二重防御）
  if (config.isProd && !(config.jwt.privateKeyPem && config.jwt.publicKeyPem)) {
    throw new Error('JWT keys must be provided via AUTH_JWT_PRIVATE_KEY_PEM/AUTH_JWT_PUBLIC_KEY_PEM in production');
  }
  fs.mkdirSync(config.jwt.keyDir, { recursive: true });
  const keyFile = path.join(config.jwt.keyDir, 'jwt-keys.json');
  if (config.jwt.privateKeyPem && config.jwt.publicKeyPem) {
    privateKey = crypto.createPrivateKey(config.jwt.privateKeyPem);
    publicKey = crypto.createPublicKey(config.jwt.publicKeyPem);
    if (config.jwt.previousPublicKeyPem) {
      try { previousPublicKey = crypto.createPublicKey(config.jwt.previousPublicKeyPem); } catch { /* 無効な旧鍵は無視 */ }
    }
    return;
  }
  if (fs.existsSync(keyFile)) {
    const k = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    privateKey = crypto.createPrivateKey(k.privateKeyPem);
    publicKey = crypto.createPublicKey(k.publicKeyPem);
    return;
  }
  // 開発用鍵ペアを自動生成（data/ は gitignore 済み。本番では環境変数で設定すること）
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  publicKey = pub;
  fs.writeFileSync(keyFile, JSON.stringify({
    privateKeyPem: priv.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pub.export({ type: 'spki', format: 'pem' }),
  }), { mode: 0o600 });
  console.log('[auth] generated dev JWT keypair at data/jwt-keys.json (set AUTH_JWT_* env vars in production)');
}

export async function signAccessToken(payload: { sub: string; provider: string; scope?: string }): Promise<string> {
  await loadKeys();
  const key = await importPKCS8(privateKey!.export({ type: 'pkcs8', format: 'pem' }) as string, 'RS256');
  return new SignJWT({ provider: payload.provider, scope: payload.scope || 'openid email profile' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: config.jwt.kid })
    .setSubject(payload.sub)
    .setIssuer(config.jwt.issuer)
    .setAudience(config.jwt.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.jwt.accessTtlSec}s`)
    .setJti(randomToken(16))
    .sign(key);
}

export async function verifyAccessToken(token: string) {
  await loadKeys();
  const opts = {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    algorithms: ['RS256' as const],
  };
  // 現在鍵で検証。失敗時はローテーション中の旧公開鍵でも試行する。
  const currentKey = await importSPKI(publicKey!.export({ type: 'spki', format: 'pem' }) as string, 'RS256');
  try {
    const { payload } = await joseVerify(token, currentKey, opts);
    return payload as { sub: string; provider?: string; scope?: string; jti?: string; exp?: number };
  } catch (e) {
    if (previousPublicKey) {
      const oldKey = await importSPKI(previousPublicKey.export({ type: 'spki', format: 'pem' }) as string, 'RS256');
      const { payload } = await joseVerify(token, oldKey, opts);
      return payload as { sub: string; provider?: string; scope?: string; jti?: string; exp?: number };
    }
    throw e;
  }
}

// ---------- パスワードハッシュ（scrypt） ----------
// 形式: scrypt$N$r$p$saltHex$hashHex。パラメータはハッシュ文字列に埋め込み、
// 検証時に保存値から読み取るため将来のパラメータ変更にも対応できる。
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n <= 0 || r <= 0 || p <= 0) return false;
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  let calc: Buffer;
  try {
    calc = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

// 存在しないユーザーでも同等の計算コストを掛け、ユーザー列挙を困難にする
const DUMMY_PASSWORD_HASH = hashPassword('dummy-password-for-timing');
export function dummyVerify(password: string): void {
  verifyPassword(password, DUMMY_PASSWORD_HASH);
}

// ---------- Google OIDC id_token 検証 ----------
export async function verifyGoogleIdToken(idToken: string, clientId: string, expectedNonce?: string) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.google.jwksUrl));
  const { payload } = await joseVerify(idToken, jwks, {
    issuer: config.google.issuer,
    audience: clientId,
    algorithms: ['RS256'],
  });
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('OIDC nonce mismatch');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('id_token missing sub');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    name: typeof payload.name === 'string' ? payload.name : '',
    picture: typeof payload.picture === 'string' ? payload.picture : '',
    emailVerified: payload.email_verified === true,
  };
}
