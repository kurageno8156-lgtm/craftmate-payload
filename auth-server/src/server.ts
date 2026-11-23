import express, { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import { config } from './config.js';
import { query, queryOne, tx, audit, pingDb, dbDriver } from './db.js';
import { redisStatus } from './redis.js';
import { checkLoginLimit, recordLoginFail, clearLoginFails } from './ratelimit.js';
import {
  randomToken, sha256Hex, pkcePair, verifyPkce,
  signAccessToken, verifyAccessToken, verifyGoogleIdToken,
  hashPassword, verifyPassword, dummyVerify,
} from './crypto.js';
import { buildGoogleAuthUrl, exchangeGoogleCode } from './google.js';
import { getMailer } from './mailer.js';

const CALLBACK_PATH = '/auth/oauth/callback/google';
const PROVIDER_CALLBACK_URI = `${config.publicUrl}${CALLBACK_PATH}`;

// ---------- バリデーション ----------
const B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const OTC_RE = /^otc_[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^rfr_[A-Za-z0-9_-]{43}$/;

function isValidRedirectUri(uri: string): boolean {
  // 許可: http://127.0.0.1:<port>/<path> または craftmate://<path>
  if (/^craftmate:\/\/[^/]+/.test(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch { return false; }
}

// IPv4/IPv6 の厳密検証 + IPv4-mapped IPv6 (::ffff:a.b.c.d) の正規化。
// 'unknown'・空・非IP文字列は null を返す。
function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  if (!ip || ip.toLowerCase() === 'unknown') return null;
  // IPv4-mapped IPv6 を IPv4 に正規化（例: ::ffff:203.0.113.1）
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) ip = mapped[1];
  // ブラケット付きIPv6 ([::1]) を除去
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  // ポート付き (1.2.3.4:5678) は拒否（XFFにはポートを含めないのが正しい）
  if (!net.isIP(ip)) return null;
  return ip;
}

function socketIp(req: Request): string | null {
  return normalizeIp(String(req.socket.remoteAddress || ''));
}

// クライアントIP取得。TRUSTED_PROXY=render の場合は X-Forwarded-For 先頭を採用
// （Renderが先頭を実クライアントIPに設定するため。他環境ではXFF偽装の危険がある）。
// 取得失敗時は null を返し、呼び出し側でフェイルクローズ判断する。
function clientIp(req: Request): string | null {
  if (config.trustedProxy === 'render') {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : String(xff || '');
    const first = raw.split(',')[0] || '';
    const ip = normalizeIp(first);
    if (ip) return ip;
    // XFF欠落・不正時はsocketにフォールバックせず null（全利用者の同一IP誤認を防ぐ）
    return null;
  }
  // req.ip は trust proxy 設定を考慮する。未設定時は socket アドレスと同じ。
  const ip = normalizeIp(String(req.ip || req.socket.remoteAddress || ''));
  return ip;
}
function clientUa(req: Request): string {
  return String(req.headers['user-agent'] || '');
}

// ---------- ログイン試行レート制限 ----------
// 実装は ratelimit.ts: REDIS_URL 設定時はRedis共有（複数インスタンス対応）、
// 未設定時はメモリ内。Redis設定済みで接続不可の場合は 'unavailable' → フェイルクローズ。
function loginKey(ip: string, email: string): string {
  return `${ip}|${email.trim().toLowerCase()}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

// セッション発行 + トークン返却の共通処理（/auth/token, /auth/login, /auth/register で共用）
async function issueTokens(userId: string, provider: string, req: Request, deviceId?: unknown, deviceName?: unknown) {
  const refreshToken = 'rfr_' + randomToken(32);
  const refreshHash = sha256Hex(refreshToken);
  const familyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlSec * 1000);
  const deviceInfo = JSON.stringify({
    deviceId: typeof deviceId === 'string' ? deviceId.slice(0, 64) : null,
    deviceName: typeof deviceName === 'string' ? deviceName.slice(0, 100) : null,
    userAgent: clientUa(req).slice(0, 300),
  });
  await query(
    `INSERT INTO sessions (user_id, token_family_id, refresh_token_hash, token_history, device_info, ip_address, provider, expires_at)
     VALUES ($1,$2,$3,'[]',$4,$5,$6,$7)`,
    [userId, familyId, refreshHash, deviceInfo, clientIp(req) || null, provider, expiresAt]
  );
  const accessToken = await signAccessToken({ sub: userId, provider });
  const user = await queryOne<any>(`SELECT id, email, display_name, avatar_url FROM users WHERE id = $1`, [userId]);
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: config.jwt.accessTtlSec,
    user: user ? { id: user.id, email: user.email, displayName: user.display_name, avatarUrl: user.avatar_url } : null,
  };
}

function jsonError(res: Response, status: number, error: string, code?: string) {
  res.status(status).json({ error, ...(code ? { code } : {}) });
}

// ---------- ルート ----------
export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // 信頼するプロキシを明示設定（X-Forwarded-For の解釈範囲を限定）
  // 'render' モードでは Express の trust proxy を有効化しない
  // （XFF先頭を clientIp で直接読むため。trust proxy を有効にすると二重解釈になる）
  if (config.trustedProxy && config.trustedProxy !== 'render') {
    if (config.trustedProxy === 'loopback') app.set('trust proxy', 'loopback');
    else app.set('trust proxy', config.trustedProxy.split(',').map((s) => s.trim()).filter(Boolean));
  }
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' })); // パスワードリセット確認フォーム用

  // セキュリティヘッダー
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (config.isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // ヘルスチェック（DB/Redis の実接続確認を含む。認証不要）
  // 本番では詳細を公開せず ok のみ返す（内部構成の情報漏えい防止）
  app.get('/ops/health', async (_req, res) => {
    const dbOk = await pingDb();
    const redis = redisStatus();
    const ok = dbOk && (!config.redis.url || redis === 'ready');
    if (!ok) {
      res.status(503).json(config.isProd ? { ok: false } : { ok: false, service: 'craftmate-auth', dbOk, redis: config.redis.url ? redis : 'disabled' });
      return;
    }
    res.json(config.isProd
      ? { ok: true }
      : { ok: true, service: 'craftmate-auth', db: dbDriver(), dbOk, redis: config.redis.url ? redis : 'disabled' });
  });

  // ---- POST /auth/oauth/start ----
  app.post('/auth/oauth/start', async (req: Request, res: Response) => {
    try {
      const { provider, redirectUri, tokenCodeChallenge, clientState, deviceId } = req.body || {};
      if (provider !== 'google') return jsonError(res, 400, 'Only provider "google" is supported in this prototype.', 'PROVIDER_UNSUPPORTED');
      if (typeof redirectUri !== 'string' || !isValidRedirectUri(redirectUri)) {
        return jsonError(res, 400, 'Invalid redirectUri. Must be http://127.0.0.1:<port>/... or craftmate://...', 'INVALID_REDIRECT_URI');
      }
      if (typeof tokenCodeChallenge !== 'string' || !B64URL_RE.test(tokenCodeChallenge)) {
        return jsonError(res, 400, 'tokenCodeChallenge is required (base64url SHA256, 43 chars). 第2PKCEは必須です。', 'PKCE_REQUIRED');
      }
      if (clientState !== undefined && (typeof clientState !== 'string' || clientState.length > 128)) {
        return jsonError(res, 400, 'Invalid clientState.');
      }

      const state = randomToken(32);
      const { verifier, challenge } = pkcePair();
      const nonce = randomToken(32);
      const expiresAt = new Date(Date.now() + config.oauth.flowTtlSec * 1000);

      await query(
        `INSERT INTO oauth_flows (state, provider, code_verifier, code_challenge, nonce, token_code_challenge, client_state, redirect_uri, device_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [state, 'google', verifier, challenge, nonce, tokenCodeChallenge, clientState || null, redirectUri, typeof deviceId === 'string' ? deviceId.slice(0, 64) : null, expiresAt]
      );
      await audit('oauth_start', null, { provider: 'google' }, clientIp(req), clientUa(req));

      const authUrl = buildGoogleAuthUrl({ redirectUri: PROVIDER_CALLBACK_URI, state, nonce, codeChallenge: challenge });
      res.json({ success: true, authUrl, state, expiresIn: config.oauth.flowTtlSec });
    } catch (e) {
      console.error('[auth] /auth/oauth/start error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- GET /auth/oauth/callback/google ----
  app.get(CALLBACK_PATH, async (req: Request, res: Response) => {
    const ip = clientIp(req);
    const ua = clientUa(req);
    try {
      const { code, state, error: oauthError } = req.query as Record<string, string>;

      // プロバイダからのエラー
      if (oauthError) {
        await audit('oauth_callback_error', null, { provider: 'google', error: oauthError }, ip, ua);
        return res.status(400).type('html').send(errorPage('OAuth error: ' + escapeHtml(oauthError)));
      }
      if (!code || !state) return res.status(400).type('html').send(errorPage('Missing code or state.'));

      // state 検証 + ワンタイム消費（原子的UPDATE）
      const flow = await queryOne<any>(
        `UPDATE oauth_flows SET used_at = now()
         WHERE state = $1 AND provider = 'google' AND used_at IS NULL AND expires_at > now()
         RETURNING *`,
        [state]
      );
      if (!flow) {
        await audit('oauth_state_invalid', null, { provider: 'google' }, ip, ua);
        return res.status(400).type('html').send(errorPage('Invalid or expired state.'));
      }

      // プロバイダ code → token 交換（Client Secret はここでのみ使用）
      let tokens;
      try {
        tokens = await exchangeGoogleCode(code, PROVIDER_CALLBACK_URI, flow.code_verifier);
      } catch (e) {
        await audit('oauth_token_exchange_failed', null, { provider: 'google', reason: (e as Error).message.slice(0, 120) }, ip, ua);
        return res.status(502).type('html').send(errorPage('Token exchange failed.'));
      }
      if (!tokens.id_token) {
        await audit('oauth_no_id_token', null, { provider: 'google' }, ip, ua);
        return res.status(502).type('html').send(errorPage('No id_token in response.'));
      }

      // id_token 検証（JWKS署名 + iss/aud/exp/nonce）
      let idClaims;
      try {
        idClaims = await verifyGoogleIdToken(tokens.id_token, config.google.clientId, flow.nonce || undefined);
      } catch (e) {
        await audit('oauth_id_token_invalid', null, { provider: 'google', reason: (e as Error).message.slice(0, 120) }, ip, ua);
        return res.status(401).type('html').send(errorPage('ID token verification failed.'));
      }

      // ユーザー解決: external_identities(provider+provider_user_id) のみ。メール一致での自動統合は行わない
      const identity = await queryOne<any>(
        `SELECT ei.*, u.status AS user_status FROM external_identities ei JOIN users u ON u.id = ei.user_id
         WHERE ei.provider = 'google' AND ei.provider_user_id = $1`,
        [idClaims.sub]
      );

      let userId: string;
      if (identity) {
        if (identity.user_status !== 'active') {
          await audit('oauth_login_blocked', identity.user_id, { provider: 'google', reason: 'user_not_active' }, ip, ua);
          return res.status(403).type('html').send(errorPage('Account is not active.'));
        }
        userId = identity.user_id;
        await query(`UPDATE external_identities SET display_name=$1, email=$2, updated_at=now() WHERE id=$3`,
          [idClaims.name.slice(0, 100), idClaims.email.slice(0, 320), identity.id]);
      } else {
        const u = await queryOne<any>(
          `INSERT INTO users (email, display_name, avatar_url, email_verified) VALUES ($1,$2,$3,$4) RETURNING id`,
          [idClaims.email || null, idClaims.name.slice(0, 100), idClaims.picture || '', idClaims.emailVerified]
        );
        userId = u!.id;
        await query(
          `INSERT INTO external_identities (user_id, provider, provider_user_id, display_name, email) VALUES ($1,'google',$2,$3,$4)`,
          [userId, idClaims.sub, idClaims.name.slice(0, 100), idClaims.email.slice(0, 320)]
        );
      }

      // ワンタイム認可コード発行（60秒・1回限り）
      const otc = 'otc_' + randomToken(32);
      const codeExpires = new Date(Date.now() + config.oauth.oneTimeCodeTtlSec * 1000);
      await query(
        `INSERT INTO oauth_codes (code, flow_id, user_id, state, client_state, redirect_uri, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [otc, flow.id, userId, flow.state, flow.client_state, flow.redirect_uri, codeExpires]
      );
      await audit('oauth_login_success', userId, { provider: 'google' }, ip, ua);

      // Desktop の redirect_uri にワンタイムコードのみを付与（トークンは含めない）
      const sep = flow.redirect_uri.includes('?') ? '&' : '?';
      const cbState = flow.client_state || flow.state;
      res.redirect(302, `${flow.redirect_uri}${sep}code=${encodeURIComponent(otc)}&state=${encodeURIComponent(cbState)}`);
    } catch (e) {
      console.error('[auth] /auth/oauth/callback error:', (e as Error).message);
      res.status(500).type('html').send(errorPage('Internal error.'));
    }
  });

  // ---- POST /auth/token ----
  app.post('/auth/token', async (req: Request, res: Response) => {
    try {
      const { code, tokenCodeVerifier, clientState, deviceId, deviceName } = req.body || {};
      if (typeof code !== 'string' || !OTC_RE.test(code)) return jsonError(res, 400, 'Invalid code.', 'INVALID_CODE');
      if (typeof tokenCodeVerifier !== 'string' || tokenCodeVerifier.length < 43 || tokenCodeVerifier.length > 128) {
        return jsonError(res, 400, 'tokenCodeVerifier is required (第2PKCE).', 'PKCE_REQUIRED');
      }

      // ワンタイムコードを原子的に消費（使用済み・期限切れは拒否）
      const otc = await queryOne<any>(
        `UPDATE oauth_codes SET used_at = now()
         WHERE code = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING *`,
        [code]
      );
      if (!otc) {
        await audit('token_exchange_rejected', null, { reason: 'code_invalid_or_used' }, clientIp(req), clientUa(req));
        return jsonError(res, 401, 'Invalid or expired code.', 'CODE_INVALID');
      }

      // clientState 照合（設定されていた場合は必須一致）
      if (otc.client_state && clientState !== otc.client_state) {
        await audit('token_exchange_rejected', otc.user_id, { reason: 'client_state_mismatch' }, clientIp(req), clientUa(req));
        return jsonError(res, 401, 'State mismatch.', 'STATE_MISMATCH');
      }

      // 第2PKCE 検証: verifier → challenge を再計算し oauth_flows と照合
      const flow = await queryOne<any>(`SELECT token_code_challenge FROM oauth_flows WHERE id = $1`, [otc.flow_id]);
      if (!flow?.token_code_challenge || !verifyPkce(tokenCodeVerifier, flow.token_code_challenge)) {
        await audit('token_exchange_rejected', otc.user_id, { reason: 'pkce_mismatch' }, clientIp(req), clientUa(req));
        return jsonError(res, 401, 'PKCE verification failed.', 'PKCE_MISMATCH');
      }

      const tokens = await issueTokens(otc.user_id, 'google', req, deviceId, deviceName);
      await audit('token_issued', otc.user_id, { provider: 'google' }, clientIp(req), clientUa(req));

      res.json(tokens);
    } catch (e) {
      console.error('[auth] /auth/token error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/register（メール+パスワード新規登録）----
  app.post('/auth/register', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const { email, password, displayName, deviceId, deviceName } = req.body || {};
      const mail = String(email || '').trim();
      const pass = String(password || '');
      if (!EMAIL_RE.test(mail) || mail.length > 320) {
        return jsonError(res, 400, 'Invalid email address.', 'INVALID_EMAIL');
      }
      if (pass.length < PASSWORD_MIN || pass.length > PASSWORD_MAX) {
        return jsonError(res, 400, `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`, 'WEAK_PASSWORD');
      }

      // メール認証ユーザー間でのみ一意（OAuth専用ユーザーの同一メールとは共存可・自動統合しない）
      const existing = await queryOne<any>(
        `SELECT id FROM users WHERE lower(email) = lower($1) AND password_hash IS NOT NULL AND status = 'active' AND deleted_at IS NULL`,
        [mail]
      );
      if (existing) {
        await audit('register_rejected', null, { reason: 'email_taken' }, ip, clientUa(req));
        return jsonError(res, 409, 'An account with this email already exists.', 'EMAIL_TAKEN');
      }

      const hash = hashPassword(pass);
      const name = String(displayName || '').trim().slice(0, 100) || mail.split('@')[0].slice(0, 100);
      let user;
      try {
        user = await queryOne<any>(
          `INSERT INTO users (email, display_name, password_hash, email_verified) VALUES ($1,$2,$3,false) RETURNING id`,
          [mail, name, hash]
        );
      } catch (e: any) {
        // 事前チェックとの競合: 部分ユニークインデックス違反は 409 として返す
        if (e?.code === '23505') {
          await audit('register_rejected', null, { reason: 'email_taken_race' }, ip, clientUa(req));
          return jsonError(res, 409, 'An account with this email already exists.', 'EMAIL_TAKEN');
        }
        throw e;
      }
      const tokens = await issueTokens(user!.id, 'password', req, deviceId, deviceName);
      await audit('register_success', user!.id, {}, ip, clientUa(req));
      res.json(tokens);
    } catch (e) {
      console.error('[auth] /auth/register error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/login（メール+パスワードログイン）----
  app.post('/auth/login', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const { email, password, deviceId, deviceName } = req.body || {};
      const mail = String(email || '').trim();
      const pass = String(password || '');
      // render モード等でクライアントIPを特定できない場合、
      // 全利用者を同一IPとしてレート制限キーに集約しないようフェイルクローズする。
      if (ip === null) {
        return jsonError(res, 503, 'Authentication temporarily unavailable.', 'AUTH_UNAVAILABLE');
      }
      const key = loginKey(ip, mail);

      const limit = await checkLoginLimit(key);
      if (limit === 'unavailable') {
        // Redis設定済みだが利用不可 → フェイルクローズ（制限なしで通さない）
        return jsonError(res, 503, 'Authentication temporarily unavailable.', 'AUTH_UNAVAILABLE');
      }
      if (limit === 'deny') {
        await audit('login_locked', null, { reason: 'rate_limit' }, ip, clientUa(req));
        return jsonError(res, 429, 'Too many failed attempts. Try again later.', 'RATE_LIMITED');
      }

      const user = await queryOne<any>(
        `SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1) AND password_hash IS NOT NULL AND deleted_at IS NULL`,
        [mail]
      );
      // ユーザー不存在でも同じ計算コストを掛けて列挙を困難にする
      const ok = user && user.status === 'active'
        ? verifyPassword(pass, user.password_hash)
        : (dummyVerify(pass), false);

      if (!ok) {
        await recordLoginFail(key);
        await audit('login_failed', user?.id ?? null, { reason: 'bad_credentials' }, ip, clientUa(req));
        return jsonError(res, 401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
      }
      await clearLoginFails(key);
      const tokens = await issueTokens(user!.id, 'password', req, deviceId, deviceName);
      await audit('login_success', user!.id, {}, ip, clientUa(req));
      res.json(tokens);
    } catch (e) {
      console.error('[auth] /auth/login error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/password/change（パスワード変更）----
  // Bearer アクセストークン必須。成功後は全セッションを失効させ再ログインを要求する。
  app.post('/auth/password/change', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return jsonError(res, 401, 'Bearer token required.', 'UNAUTHORIZED');
      let payload;
      try { payload = await verifyAccessToken(token); } catch {
        return jsonError(res, 401, 'Invalid or expired token.', 'TOKEN_INVALID');
      }

      const { currentPassword, newPassword } = req.body || {};
      const cur = String(currentPassword || '');
      const next = String(newPassword || '');
      if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
        return jsonError(res, 400, `New password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`, 'WEAK_PASSWORD');
      }
      const user = await queryOne<any>(
        `SELECT id, password_hash, status FROM users WHERE id = $1 AND password_hash IS NOT NULL AND deleted_at IS NULL`,
        [payload.sub]
      );
      if (!user || user.status !== 'active' || !verifyPassword(cur, user.password_hash)) {
        await audit('password_change_failed', payload.sub, { reason: 'bad_current_password' }, ip, clientUa(req));
        return jsonError(res, 401, 'Current password is incorrect.', 'INVALID_CREDENTIALS');
      }
      await query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hashPassword(next), user.id]);
      // 全デバイスのセッションを失効（パスワード変更後は再ログイン必須）
      const revoked = await query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_change' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [user.id]
      );
      await audit('password_changed', user.id, { sessions_revoked: revoked.length }, ip, clientUa(req));
      res.json({ success: true, sessionsRevoked: revoked.length });
    } catch (e) {
      console.error('[auth] /auth/password/change error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- メールトークン共通処理 ----
  // トークンはランダム32バイト。DBにはSHA-256ハッシュのみ保存し、
  // 平文トークンはメール本文にのみ含める（ログには出さない）。
  const issueEmailToken = async (userId: string, purpose: string, ttlSec: number, newEmail?: string) => {
    const token = 'emt_' + randomToken(32);
    const hash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    await query(
      `INSERT INTO email_tokens (user_id, purpose, token_hash, new_email, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [userId, purpose, hash, newEmail || null, expiresAt]
    );
    return token;
  };
  const consumeEmailToken = async (token: string, purpose: string) => {
    if (typeof token !== 'string' || !/^emt_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = sha256Hex(token);
    const row = await queryOne<any>(
      `UPDATE email_tokens SET used_at = now()
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING *`,
      [hash, purpose]
    );
    return row || null;
  };

  // ---- POST /auth/email/verify/request ----
  // メールアドレスの存在を外部に漏らさないため、登録の有無に関わらず同じ応答を返す。
  app.post('/auth/email/verify/request', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const { email } = req.body || {};
      const mail = String(email || '').trim();
      if (!EMAIL_RE.test(mail) || mail.length > 320) {
        return jsonError(res, 400, 'Invalid email address.', 'INVALID_EMAIL');
      }
      const user = await queryOne<any>(
        `SELECT id, email, email_verified FROM users WHERE lower(email) = lower($1) AND password_hash IS NOT NULL AND status = 'active' AND deleted_at IS NULL`,
        [mail]
      );
      if (user && !user.email_verified) {
        const token = await issueEmailToken(user.id, 'verify_email', config.mail.tokenTtlSec);
        const link = `${config.publicUrl}/auth/email/verify/confirm?token=${encodeURIComponent(token)}`;
        try {
          await getMailer().send({
            to: user.email,
            subject: 'BlockWhiz メールアドレス確認',
            text: `以下のリンクを開いてメールアドレスを確認してください（24時間有効）:\n${link}\n\nこのメールに心当たりがない場合は無視してください。`,
            html: mailHtml('BlockWhiz メールアドレス確認', '以下のリンクを開いてメールアドレスを確認してください（24時間有効）:', link),
          });
          await audit('email_verify_sent', user.id, {}, ip, clientUa(req));
        } catch (e) {
          await audit('email_verify_send_failed', user.id, { reason: (e as Error).message.slice(0, 120) }, ip, clientUa(req));
        }
      }
      // 存在しない・確認済みでも同じ応答（列挙防止）
      res.json({ success: true, message: 'If the email is registered, a verification link has been sent.' });
    } catch (e) {
      console.error('[auth] /auth/email/verify/request error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- GET /auth/email/verify/confirm?token=... ----
  // GETではトークンを消費しない（メールクライアントのプリフェッチ・リンクスキャナによる
  // 誤消費を防ぐ）。確認ボタンのPOSTで実際に消費する。
  app.get('/auth/email/verify/confirm', async (req: Request, res: Response) => {
    const token = String(req.query.token || '');
    const hash = sha256Hex(token);
    const valid = await queryOne<any>(
      `SELECT id FROM email_tokens WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now()`,
      [hash]
    );
    if (!valid) return res.status(400).type('html').send(errorPage('確認リンクが無効か期限切れです。もう一度お試しください。'));
    res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:400px"><h2 style="color:#e4e4e7">BlockWhiz メールアドレス確認</h2><p>下のボタンを押して確認を完了してください。</p><form method="POST" action="/auth/email/verify/complete"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="padding:10px 24px;border:none;border-radius:6px;background:#10b981;color:#052e1b;font-weight:600;cursor:pointer">確認する</button></form></div></body></html>`);
  });

  // ---- POST /auth/email/verify/complete ----
  // 実際のトークン消費はここで行う（GETでは消費しない）
  app.post('/auth/email/verify/complete', async (req: Request, res: Response) => {
    try {
      const token = String(req.body?.token || '');
      const row = await consumeEmailToken(token, 'verify_email');
      if (!row) {
        return res.status(400).type('html').send(errorPage('確認リンクが無効か期限切れです。もう一度お試しください。'));
      }
      await query(`UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`, [row.user_id]);
      await audit('email_verified', row.user_id, {}, clientIp(req), clientUa(req));
      res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#4ade80">メールアドレスを確認しました</h2><p>BlockWhiz アプリに戻ってログインしてください。</p></div></body></html>`);
    } catch (e) {
      console.error('[auth] /auth/email/verify/complete error:', (e as Error).message);
      res.status(500).type('html').send(errorPage('Internal error.'));
    }
  });

  // ---- POST /auth/email/verify/confirm（API版・デスクトップアプリ用）----
  // デスクトップアプリからトークンを直接送信する場合（POST complete と同等）
  app.post('/auth/email/verify/confirm', async (req: Request, res: Response) => {
    try {
      const { token } = req.body || {};
      const row = await consumeEmailToken(String(token || ''), 'verify_email');
      if (!row) {
        return jsonError(res, 400, 'Verification link is invalid or expired.', 'TOKEN_INVALID');
      }
      await query(`UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`, [row.user_id]);
      await audit('email_verified', row.user_id, {}, clientIp(req), clientUa(req));
      res.json({ success: true });
    } catch (e) {
      console.error('[auth] /auth/email/verify/confirm error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/password/reset/request ----
  // メールアドレスの存在を漏らさない。登録の有無に関わらず同じ応答。
  app.post('/auth/password/reset/request', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const { email } = req.body || {};
      const mail = String(email || '').trim();
      if (!EMAIL_RE.test(mail) || mail.length > 320) {
        return jsonError(res, 400, 'Invalid email address.', 'INVALID_EMAIL');
      }
      const user = await queryOne<any>(
        `SELECT id, email, status FROM users WHERE lower(email) = lower($1) AND password_hash IS NOT NULL AND status = 'active' AND deleted_at IS NULL`,
        [mail]
      );
      if (user) {
        const token = await issueEmailToken(user.id, 'reset_password', config.mail.resetTokenTtlSec);
        const link = `${config.publicUrl}/auth/password/reset/confirm?token=${encodeURIComponent(token)}`;
        try {
          await getMailer().send({
            to: user.email,
            subject: 'BlockWhiz パスワード再設定',
            text: `パスワード再設定のリクエストを受け付けました。以下のリンクを開いて新しいパスワードを設定してください（30分有効）:\n${link}\n\nこのメールに心当たりがない場合は無視してください。`,
            html: mailHtml('BlockWhiz パスワード再設定', 'パスワード再設定のリクエストを受け付けました。以下のリンクを開いて新しいパスワードを設定してください（30分有効）:', link),
          });
          await audit('password_reset_sent', user.id, {}, ip, clientUa(req));
        } catch (e) {
          await audit('password_reset_send_failed', user.id, { reason: (e as Error).message.slice(0, 120) }, ip, clientUa(req));
        }
      }
      res.json({ success: true, message: 'If the email is registered, a reset link has been sent.' });
    } catch (e) {
      console.error('[auth] /auth/password/reset/request error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- GET /auth/password/reset/confirm?token=... ----
  // 確認ページ（パスワード入力フォーム）を表示。実際の変更は POST /auth/password/reset/complete
  app.get('/auth/password/reset/confirm', async (req: Request, res: Response) => {
    const token = String(req.query.token || '');
    // トークンの存在確認のみ（消費はしない。POST complete で消費する）
    const hash = sha256Hex(token);
    const valid = await queryOne<any>(
      `SELECT id FROM email_tokens WHERE token_hash = $1 AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now()`,
      [hash]
    );
    if (!valid) return res.status(400).type('html').send(errorPage('リセットリンクが無効か期限切れです。もう一度お試しください。'));
    res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:400px;width:100%"><h2 style="color:#e4e4e7">BlockWhiz パスワード再設定</h2><form method="POST" action="/auth/password/reset/complete" style="display:grid;gap:10px"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="password" name="password" placeholder="新しいパスワード（8文字以上）" minlength="8" required style="padding:10px;border-radius:6px;border:1px solid #333;background:#111;color:#fff"><button type="submit" style="padding:10px;border:none;border-radius:6px;background:#10b981;color:#052e1b;font-weight:600;cursor:pointer">パスワードを変更</button></form></div></body></html>`);
  });

  // ---- POST /auth/password/reset/complete ----
  // トークン消費 + パスワード更新 + 全セッション失効
  app.post('/auth/password/reset/complete', async (req: Request, res: Response) => {
    try {
      // form-urlencoded または JSON 両対応
      const token = String(req.body?.token || '');
      const pass = String(req.body?.password || '');
      if (pass.length < PASSWORD_MIN || pass.length > PASSWORD_MAX) {
        return res.status(400).type('html').send(errorPage('パスワードは8〜128文字で入力してください。'));
      }
      const row = await consumeEmailToken(token, 'reset_password');
      if (!row) {
        return res.status(400).type('html').send(errorPage('リセットリンクが無効か期限切れです。もう一度お試しください。'));
      }
      await query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hashPassword(pass), row.user_id]);
      const revoked = await query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [row.user_id]
      );
      await audit('password_reset_completed', row.user_id, { sessions_revoked: revoked.length }, clientIp(req), clientUa(req));
      res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#4ade80">パスワードを変更しました</h2><p>全デバイスのセッションが無効になりました。BlockWhiz アプリで再度ログインしてください。</p></div></body></html>`);
    } catch (e) {
      console.error('[auth] /auth/password/reset/complete error:', (e as Error).message);
      res.status(500).type('html').send(errorPage('Internal error.'));
    }
  });

  // ---- POST /auth/password/reset/confirm（API版・デスクトップアプリ用）----
  // デスクトップアプリからトークン+新パスワードを直接送信する場合
  app.post('/auth/password/reset/confirm', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const { token, newPassword } = req.body || {};
      const pass = String(newPassword || '');
      if (pass.length < PASSWORD_MIN || pass.length > PASSWORD_MAX) {
        return jsonError(res, 400, `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`, 'WEAK_PASSWORD');
      }
      const row = await consumeEmailToken(String(token || ''), 'reset_password');
      if (!row) {
        return jsonError(res, 400, 'Reset link is invalid or expired.', 'TOKEN_INVALID');
      }
      await query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hashPassword(pass), row.user_id]);
      const revoked = await query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [row.user_id]
      );
      await audit('password_reset_completed', row.user_id, { sessions_revoked: revoked.length }, ip, clientUa(req));
      res.json({ success: true, sessionsRevoked: revoked.length });
    } catch (e) {
      console.error('[auth] /auth/password/reset/confirm error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/account/delete ----
  // 本人確認（パスワード）→ ソフトデリート + 全セッション失効 + 監査ログ
  app.post('/auth/account/delete', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return jsonError(res, 401, 'Bearer token required.', 'UNAUTHORIZED');
      let payload;
      try { payload = await verifyAccessToken(token); } catch {
        return jsonError(res, 401, 'Invalid or expired token.', 'TOKEN_INVALID');
      }
      const { password } = req.body || {};
      const user = await queryOne<any>(
        `SELECT id, password_hash, status, email FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [payload.sub]
      );
      if (!user || user.status !== 'active') {
        return jsonError(res, 403, 'Account is not active.', 'FORBIDDEN');
      }
      // パスワード認証ユーザーはパスワード必須。OAuth専用ユーザーはBearerのみで可。
      if (user.password_hash) {
        if (!verifyPassword(String(password || ''), user.password_hash)) {
          await audit('account_delete_failed', user.id, { reason: 'bad_password' }, ip, clientUa(req));
          return jsonError(res, 401, 'Password is incorrect.', 'INVALID_CREDENTIALS');
        }
      }
      // ソフトデリート: deleted_at 設定 + status 変更 + 全セッション失効
      // 個人情報は保持期間ポリシーに基づき後で物理削除（現時点では論理削除のみ）
      await query(
        `UPDATE users SET deleted_at = now(), status = 'deleted', updated_at = now() WHERE id = $1`,
        [user.id]
      );
      const revoked = await query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'account_delete' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [user.id]
      );
      // external_identities は削除しない（再登録時の重複防止・監査証跡のため保持）
      await audit('account_deleted', user.id, { sessions_revoked: revoked.length }, ip, clientUa(req));
      res.json({ success: true, sessionsRevoked: revoked.length });
    } catch (e) {
      console.error('[auth] /auth/account/delete error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/email/change ----
  // Bearer必須。新メールアドレスに確認メールを送信し、確認完了まで email_verified=false に戻す。
  app.post('/auth/email/change', async (req: Request, res: Response) => {
    try {
      const ip = clientIp(req);
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return jsonError(res, 401, 'Bearer token required.', 'UNAUTHORIZED');
      let payload;
      try { payload = await verifyAccessToken(token); } catch {
        return jsonError(res, 401, 'Invalid or expired token.', 'TOKEN_INVALID');
      }
      const { newEmail } = req.body || {};
      const mail = String(newEmail || '').trim();
      if (!EMAIL_RE.test(mail) || mail.length > 320) {
        return jsonError(res, 400, 'Invalid email address.', 'INVALID_EMAIL');
      }
      const user = await queryOne<any>(
        `SELECT id, email, password_hash FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [payload.sub]
      );
      if (!user) return jsonError(res, 403, 'Account is not active.', 'FORBIDDEN');
      // メール認証ユーザーは新アドレスの一意性を確認（OAuth専用は email 非一意のため対象外）
      if (user.password_hash) {
        const dup = await queryOne<any>(
          `SELECT id FROM users WHERE lower(email) = lower($1) AND password_hash IS NOT NULL AND id != $2 AND status = 'active' AND deleted_at IS NULL`,
          [mail, user.id]
        );
        if (dup) return jsonError(res, 409, 'Email already in use.', 'EMAIL_TAKEN');
      }
      // 新アドレスを仮設定し、未確認状態に戻す
      await query(`UPDATE users SET email = $1, email_verified = false, updated_at = now() WHERE id = $2`, [mail, user.id]);
      const vtoken = await issueEmailToken(user.id, 'verify_email', config.mail.tokenTtlSec);
      const link = `${config.publicUrl}/auth/email/verify/confirm?token=${encodeURIComponent(vtoken)}`;
      try {
        await getMailer().send({
          to: mail,
          subject: 'BlockWhiz 新しいメールアドレスの確認',
          text: `メールアドレス変更を確認するには以下のリンクを開いてください（24時間有効）:\n${link}\n\nこのメールに心当たりがない場合は無視してください。`,
          html: mailHtml('BlockWhiz 新しいメールアドレスの確認', 'メールアドレス変更を確認するには以下のリンクを開いてください（24時間有効）:', link),
        });
        await audit('email_change_sent', user.id, {}, ip, clientUa(req));
      } catch (e) {
        await audit('email_change_send_failed', user.id, { reason: (e as Error).message.slice(0, 120) }, ip, clientUa(req));
      }
      res.json({ success: true, message: 'Verification email sent to new address.' });
    } catch (e) {
      console.error('[auth] /auth/email/change error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/session/refresh ----
  app.post('/auth/session/refresh', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body || {};
      if (typeof refreshToken !== 'string' || !REFRESH_RE.test(refreshToken)) {
        return jsonError(res, 400, 'Invalid refreshToken.', 'INVALID_TOKEN');
      }
      const hash = sha256Hex(refreshToken);
      const ip = clientIp(req);
      const ua = clientUa(req);

      // 現在のハッシュで検索
      const session = await queryOne<any>(
        `SELECT * FROM sessions WHERE refresh_token_hash = $1`, [hash]
      );

      if (session) {
        if (session.revoked_at) {
          // 現在ハッシュだが失効済み → 再利用検知
          await revokeFamily(session.token_family_id, 'token_reuse');
          await audit('token_reuse_detected', session.user_id, { family: session.token_family_id }, ip, ua);
          return jsonError(res, 401, 'Token reuse detected. All sessions revoked.', 'TOKEN_REUSE');
        }
        if (new Date(session.expires_at).getTime() < Date.now()) {
          return jsonError(res, 401, 'Refresh token expired.', 'TOKEN_EXPIRED');
        }
        // 正常ローテーション（単一トランザクション・行ロック）
        // 注意: tx 内でグローバル query/audit を呼ぶと単一接続DBでデッドロックするため、
        // トランザクション内は t.query のみ使用し、audit は tx 完了後に行う。
        const result = await tx(async (t) => {
          const locked = await t.query<any>(
            `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [session.id]
          );
          const s = locked[0];
          // 行ロック後に再検証: 失効済み or ハッシュが既にローテーション済みなら再利用扱い
          if (!s || s.revoked_at || s.refresh_token_hash !== hash) {
            return { error: 'reuse' as const };
          }
          const newRefresh = 'rfr_' + randomToken(32);
          const newHash = sha256Hex(newRefresh);
          const history = Array.isArray(s.token_history) ? [...s.token_history, s.refresh_token_hash].slice(-500) : [s.refresh_token_hash];
          // ローテーション: 行は有効のまま、ハッシュのみ更新。旧ハッシュは token_history へ。
          await t.query(
            `UPDATE sessions SET refresh_token_hash = $1, token_history = $2, last_used_at = now() WHERE id = $3`,
            [newHash, JSON.stringify(history), s.id]
          );
          const user = (await t.query<any>(`SELECT id, email, display_name, avatar_url, status, deleted_at FROM users WHERE id = $1`, [s.user_id]))[0];
          // 凍結・削除済みユーザーのトークン更新を拒否（セッションも失効させる）
          if (!user || user.status !== 'active' || user.deleted_at) {
            return { error: 'user_inactive' as const };
          }
          return { s, newRefresh, user };
        });
        if ('error' in result) {
          if (result.error === 'user_inactive') {
            await revokeFamily(session.token_family_id, 'user_inactive');
            await audit('token_refresh_blocked', session.user_id, { reason: 'user_inactive' }, ip, ua);
            return jsonError(res, 403, 'Account is not active.', 'FORBIDDEN');
          }
          await revokeFamily(session.token_family_id, 'token_reuse');
          await audit('token_reuse_detected', session.user_id, { family: session.token_family_id }, ip, ua);
          return jsonError(res, 401, 'Token reuse detected.', 'TOKEN_REUSE');
        }
        const accessToken = await signAccessToken({ sub: result.s.user_id, provider: result.s.provider || 'password' });
        await audit('token_refreshed', result.s.user_id, {}, ip, ua);
        res.json({
          accessToken, refreshToken: result.newRefresh, tokenType: 'Bearer',
          expiresIn: config.jwt.accessTtlSec,
          user: result.user ? { id: result.user.id, email: result.user.email, displayName: result.user.display_name, avatarUrl: result.user.avatar_url } : null,
        });
        return;
      }

      // 現在ハッシュに無い → token_history を検索（過去世代の再利用検知）
      const hist = await queryOne<any>(
        `SELECT * FROM sessions WHERE token_history @> to_jsonb(ARRAY[$1]::text[]) LIMIT 1`, [hash]
      );
      if (hist) {
        await revokeFamily(hist.token_family_id, 'token_reuse');
        await audit('token_reuse_detected', hist.user_id, { family: hist.token_family_id, via: 'history' }, ip, ua);
        return jsonError(res, 401, 'Token reuse detected. All sessions revoked.', 'TOKEN_REUSE');
      }

      return jsonError(res, 401, 'Invalid refresh token.', 'INVALID_TOKEN');
    } catch (e) {
      console.error('[auth] /auth/session/refresh error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/logout（単体セッション失効）----
  app.post('/auth/logout', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body || {};
      if (typeof refreshToken === 'string' && REFRESH_RE.test(refreshToken)) {
        const hash = sha256Hex(refreshToken);
        const s = await queryOne<any>(`SELECT id, user_id, token_family_id FROM sessions WHERE refresh_token_hash = $1`, [hash]);
        if (s && !s.revoked_at) {
          await query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1`, [s.id]);
          await audit('logout', s.user_id, {}, clientIp(req), clientUa(req));
        }
      }
      res.json({ success: true }); // 冪等
    } catch (e) {
      console.error('[auth] /auth/logout error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- POST /auth/logout-all（全デバイス失効）----
  app.post('/auth/logout-all', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body || {};
      if (typeof refreshToken !== 'string' || !REFRESH_RE.test(refreshToken)) {
        return jsonError(res, 400, 'Invalid refreshToken.', 'INVALID_TOKEN');
      }
      const hash = sha256Hex(refreshToken);
      const s = await queryOne<any>(`SELECT user_id FROM sessions WHERE refresh_token_hash = $1 AND revoked_at IS NULL`, [hash]);
      if (!s) return jsonError(res, 401, 'Invalid or expired token.', 'INVALID_TOKEN');
      const r = await query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout_all' WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
        [s.user_id]
      );
      await audit('logout_all', s.user_id, { count: r.length }, clientIp(req), clientUa(req));
      res.json({ success: true, revoked: r.length });
    } catch (e) {
      console.error('[auth] /auth/logout-all error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- GET /auth/me ----
  app.get('/auth/me', async (req: Request, res: Response) => {
    try {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return jsonError(res, 401, 'Bearer token required.', 'UNAUTHORIZED');
      let payload;
      try {
        payload = await verifyAccessToken(token);
      } catch {
        return jsonError(res, 401, 'Invalid or expired token.', 'TOKEN_INVALID');
      }
      const user = await queryOne<any>(
        `SELECT id, email, display_name, avatar_url, status, created_at FROM users WHERE id = $1`, [payload.sub]
      );
      if (!user || user.status !== 'active') return jsonError(res, 403, 'Account not active.', 'FORBIDDEN');
      res.json({
        id: user.id, email: user.email, displayName: user.display_name,
        avatarUrl: user.avatar_url, provider: payload.provider, scope: payload.scope,
      });
    } catch (e) {
      console.error('[auth] /auth/me error:', (e as Error).message);
      jsonError(res, 500, 'Internal error.');
    }
  });

  // ---- エラーハンドリング（JSONパースエラー等。内部情報を返さない）----
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return jsonError(res, 400, 'Invalid request body.', 'BAD_REQUEST');
    }
    console.error('[auth] unhandled error:', err?.message || 'unknown');
    jsonError(res, 500, 'Internal error.');
  });

  return app;
}

async function revokeFamily(familyId: string, reason: string) {
  await query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE token_family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason]
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
// メール本文のHTML版。リンクはエスケープしてhrefに埋め込む。
function mailHtml(subject: string, leadText: string, link: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;padding:32px"><div style="max-width:480px;margin:0 auto"><h2 style="color:#e4e4e7">${escapeHtml(subject)}</h2><p>${escapeHtml(leadText)}</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 24px;border-radius:6px;background:#10b981;color:#052e1b;font-weight:600;text-decoration:none">リンクを開く</a></p><p style="color:#71717a;font-size:13px;word-break:break-all">${escapeHtml(link)}</p><p style="color:#71717a;font-size:13px">このメールに心当たりがない場合は無視してください。</p></div></body></html>`;
}
function errorPage(msg: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;background:#0b0f14;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:480px"><h2 style="color:#f87171">BlockWhiz Auth</h2><p>${escapeHtml(msg)}</p><p style="color:#71717a;font-size:13px">このウィンドウは閉じて BlockWhiz に戻ってください。</p></div></body></html>`;
}
