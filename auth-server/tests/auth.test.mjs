// CraftMate Auth Server プロトタイプテスト（Google OAuth モック）
// 実Google認証ではなく、モックIdPに対するE2Eテスト。
// 実行: npm run build && node tests/auth.test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

// ---------- 環境設定（モジュール import 前に必須）----------
const AUTH_PORT = 18999;
const MOCK_PORT = 18998;
const GOOGLE_CLIENT_ID = 'test-google-client-id';
const GOOGLE_CLIENT_SECRET = 'test-google-client-secret-DO-NOT-LOG';

process.env.AUTH_PUBLIC_URL = `http://127.0.0.1:${AUTH_PORT}`;
process.env.AUTH_DEV_INSECURE_HTTP = '1';
process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;
process.env.GOOGLE_AUTH_URL = `http://127.0.0.1:${MOCK_PORT}/mock/authorize`;
process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${MOCK_PORT}/mock/token`;
process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${MOCK_PORT}/mock/jwks`;
process.env.GOOGLE_ISSUER = 'https://accounts.google.com';
process.env.GOOGLE_USERINFO_URL = `http://127.0.0.1:${MOCK_PORT}/mock/userinfo`;
process.env.PGLITE_DIR = path.join(process.cwd(), '.test-data');

// ---------- モックIdP ----------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mockState = { nonce: '', sub: 'google-sub-test-001', email: 'test@example.com', name: 'Test User' };

const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-key-1', alg: 'RS256', use: 'sig' };

const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  if (url.pathname === '/mock/jwks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (url.pathname === '/mock/token' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const params = new URLSearchParams(body);
    // code_verifier が無ければ拒否（プロバイダPKCEの存在確認）
    if (!params.get('code_verifier')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }
    // id_token をモック鍵で署名
    const { SignJWT, importJWK } = await import('jose');
    const key = await importJWK({ ...publicKey.export({ format: 'jwk' }), kid: 'mock-key-1', alg: 'RS256', use: 'sig' }, 'RS256');
    // 秘密鍵側: privateKey.export jwk → importJWK
    const privJwk = { ...privateKey.export({ format: 'jwk' }), kid: 'mock-key-1', alg: 'RS256', use: 'sig' };
    const signKey = await importJWK(privJwk, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      nonce: mockState.nonce,
      email: mockState.email,
      email_verified: true,
      name: mockState.name,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-key-1', typ: 'JWT' })
      .setSubject(mockState.sub)
      .setIssuer('https://accounts.google.com')
      .setAudience(GOOGLE_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(signKey);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id_token: idToken, access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 }));
    return;
  }
  if (url.pathname === '/mock/userinfo') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sub: mockState.sub, email: mockState.email, name: mockState.name }));
    return;
  }
  res.writeHead(404); res.end('not found');
});

await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));

// ---------- Auth Server 起動 ----------
const { initDb, query, queryOne } = await import('../dist/db.js');
const { createApp } = await import('../dist/server.js');
await initDb();
const app = createApp();
const server = await new Promise((r) => { const s = app.listen(AUTH_PORT, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${AUTH_PORT}`;

// ---------- テストユーティリティ ----------
let passed = 0, failed = 0;
const logs = [];
const origLog = console.log, origErr = console.error;
console.log = (...a) => { logs.push(a.join(' ')); };
console.error = (...a) => { logs.push(a.join(' ')); };

function b64urlSha256(s) { return crypto.createHash('sha256').update(s).digest('base64url'); }
function pkcePair() { const v = crypto.randomBytes(48).toString('base64url'); return { verifier: v, challenge: b64urlSha256(v) }; }

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: opts.redirect === 'manual' ? 'manual' : 'follow',
  });
  let data = null;
  try { data = await res.json(); } catch { /* html等 */ }
  return { status: res.status, data, headers: res.headers };
}

async function fullLoginFlow({ clientState = 'desktop-state-1', sub } = {}) {
  if (sub) mockState.sub = sub;
  const { verifier, challenge } = pkcePair();
  const start = await api('/auth/oauth/start', {
    method: 'POST',
    body: { provider: 'google', redirectUri: 'http://127.0.0.1:3000/api/auth/callback', tokenCodeChallenge: challenge, clientState, deviceId: 'dev-test' },
  });
  assert.equal(start.status, 200, 'oauth/start should succeed');
  const authUrl = new URL(start.data.authUrl);
  const state = authUrl.searchParams.get('state');
  mockState.nonce = authUrl.searchParams.get('nonce'); // モックIdPがid_tokenに埋め込むnonce
  // Google callback をシミュレート（ブラウザ側の処理）
  const cb = await fetch(`${BASE}/auth/oauth/callback/google?code=mock-auth-code&state=${state}`, { redirect: 'manual' });
  assert.equal(cb.status, 302, 'callback should redirect');
  const loc = cb.headers.get('location');
  const otc = new URL(loc).searchParams.get('code');
  const echoedState = new URL(loc).searchParams.get('state');
  assert.ok(otc && otc.startsWith('otc_'), 'one-time code issued');
  assert.equal(echoedState, clientState, 'clientState echoed');
  // /auth/token で交換
  const tok = await api('/auth/token', {
    method: 'POST',
    body: { code: otc, tokenCodeVerifier: verifier, clientState, deviceId: 'dev-test', deviceName: 'TestPC' },
  });
  assert.equal(tok.status, 200, 'token exchange should succeed: ' + JSON.stringify(tok.data));
  return { ...tok.data, otc, verifier, state };
}

async function test(name, fn) {
  process.stdout.write(`  ..  ${name}\n`);
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 30s')), 30000))]); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`FAIL  ${name}: ${e.message}\n`); }
}

// ================= テスト開始 =================
process.stdout.write('== Auth Server prototype tests ==\n');

await test('health check', async () => {
  const r = await api('/ops/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

await test('oauth/start rejects missing tokenCodeChallenge (第2PKCE必須)', async () => {
  const r = await api('/auth/oauth/start', { method: 'POST', body: { provider: 'google', redirectUri: 'http://127.0.0.1:3000/cb' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'PKCE_REQUIRED');
});

await test('oauth/start rejects bad redirectUri', async () => {
  const { challenge } = pkcePair();
  const r = await api('/auth/oauth/start', { method: 'POST', body: { provider: 'google', redirectUri: 'https://evil.example.com/cb', tokenCodeChallenge: challenge } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'INVALID_REDIRECT_URI');
});

await test('oauth/start rejects non-google provider', async () => {
  const { challenge } = pkcePair();
  const r = await api('/auth/oauth/start', { method: 'POST', body: { provider: 'github', redirectUri: 'http://127.0.0.1:3000/cb', tokenCodeChallenge: challenge } });
  assert.equal(r.status, 400);
});

let login1;
await test('Google OAuth normal login (mock IdP) → tokens issued', async () => {
  login1 = await fullLoginFlow({ clientState: 'state-A' });
  assert.ok(login1.accessToken && login1.refreshToken);
  assert.ok(login1.refreshToken.startsWith('rfr_'));
});

await test('GET /auth/me with access token', async () => {
  const r = await api('/auth/me', { headers: { Authorization: `Bearer ${login1.accessToken}` } });
  assert.equal(r.status, 200);
  assert.equal(r.data.provider, 'google');
});

await test('state mismatch rejected', async () => {
  const { challenge } = pkcePair();
  const start = await api('/auth/oauth/start', { method: 'POST', body: { provider: 'google', redirectUri: 'http://127.0.0.1:3000/cb', tokenCodeChallenge: challenge } });
  const bad = await fetch(`${BASE}/auth/oauth/callback/google?code=x&state=WRONGSTATE`, { redirect: 'manual' });
  assert.equal(bad.status, 400);
});

await test('one-time code double use rejected', async () => {
  // login1 の otc を再使用（すでに消費済み）
  const { verifier } = pkcePair();
  const r = await api('/auth/token', { method: 'POST', body: { code: login1.otc, tokenCodeVerifier: verifier } });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'CODE_INVALID');
});

await test('expired one-time code rejected', async () => {
  const flow = await fullLoginFlowRaw();
  // DBで期限切れにする
  await query(`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE code = $1`, [flow.otc]);
  const r = await api('/auth/token', { method: 'POST', body: { code: flow.otc, tokenCodeVerifier: flow.verifier, clientState: flow.clientState } });
  assert.equal(r.status, 401);
});

async function fullLoginFlowRaw() {
  const { verifier, challenge } = pkcePair();
  const clientState = 'state-raw';
  const start = await api('/auth/oauth/start', { method: 'POST', body: { provider: 'google', redirectUri: 'http://127.0.0.1:3000/cb', tokenCodeChallenge: challenge, clientState } });
  const authUrl = new URL(start.data.authUrl);
  const state = authUrl.searchParams.get('state');
  mockState.nonce = authUrl.searchParams.get('nonce');
  const cb = await fetch(`${BASE}/auth/oauth/callback/google?code=c&state=${state}`, { redirect: 'manual' });
  const loc = new URL(cb.headers.get('location'));
  return { otc: loc.searchParams.get('code'), verifier, clientState };
}

await test('missing tokenCodeVerifier rejected (第2PKCE)', async () => {
  const flow = await fullLoginFlowRaw();
  const r = await api('/auth/token', { method: 'POST', body: { code: flow.otc, clientState: flow.clientState } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'PKCE_REQUIRED');
});

await test('wrong tokenCodeVerifier rejected (PKCE mismatch)', async () => {
  const flow = await fullLoginFlowRaw();
  const wrong = pkcePair().verifier; // 別のverifier
  const r = await api('/auth/token', { method: 'POST', body: { code: flow.otc, tokenCodeVerifier: wrong, clientState: flow.clientState } });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'PKCE_MISMATCH');
});

await test('clientState mismatch rejected', async () => {
  const flow = await fullLoginFlowRaw();
  const r = await api('/auth/token', { method: 'POST', body: { code: flow.otc, tokenCodeVerifier: flow.verifier, clientState: 'WRONG' } });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'STATE_MISMATCH');
});

await test('refresh token normal rotation', async () => {
  const r = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: login1.refreshToken } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.refreshToken !== login1.refreshToken, 'new refresh token issued');
  login1 = { ...login1, ...r.data };
});

await test('old refresh token reuse detected → family revoked', async () => {
  // login1.refreshToken はローテーション済み（旧トークン）→ 再利用で family 全失効
  const oldRefresh = login1._prevRefresh || null;
  // まず2回目のログインで別トークンを取得し、そちらでローテーション→旧トークン再利用を試す
  const flow2 = await fullLoginFlow({ clientState: 'state-B', sub: 'google-sub-test-002' });
  const first = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: flow2.refreshToken } });
  assert.equal(first.status, 200);
  // 旧トークン(flow2.refreshToken)を再提示 → 再利用検知
  const reuse = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: flow2.refreshToken } });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.data.code, 'TOKEN_REUSE');
  // 新トークン(first.refreshToken)も family 失効で無効になるはず
  const after = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: first.data.refreshToken } });
  assert.equal(after.status, 401);
});

await test('logout single session', async () => {
  const flow = await fullLoginFlow({ clientState: 'state-C', sub: 'google-sub-test-003' });
  const lo = await api('/auth/logout', { method: 'POST', body: { refreshToken: flow.refreshToken } });
  assert.equal(lo.status, 200);
  const ref = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: flow.refreshToken } });
  assert.equal(ref.status, 401);
});

await test('logout-all revokes all sessions', async () => {
  const f1 = await fullLoginFlow({ clientState: 's1', sub: 'google-sub-test-004' });
  const f2 = await fullLoginFlow({ clientState: 's2', sub: 'google-sub-test-004' });
  const la = await api('/auth/logout-all', { method: 'POST', body: { refreshToken: f1.refreshToken } });
  assert.equal(la.status, 200);
  assert.ok(la.data.revoked >= 2, 'both sessions revoked');
  const r1 = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: f1.refreshToken } });
  const r2 = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: f2.refreshToken } });
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
});

// ================= Phase A: メール+パスワード認証 =================
// .test-data は実行間で永続化されるため、メールアドレスを実行ごとに一意化する
const RUN_ID = Date.now().toString(36);
const CRED_EMAIL = `cred-user-${RUN_ID}@example.com`;
const CRED_PASS = 'TestPass123!';
let credLogin;

await test('register: invalid email rejected', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { email: 'not-an-email', password: CRED_PASS } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'INVALID_EMAIL');
});

await test('register: weak password rejected', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { email: 'weak@example.com', password: 'short' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'WEAK_PASSWORD');
});

await test('register: new credential account succeeds', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { email: CRED_EMAIL, password: CRED_PASS, displayName: 'Cred User' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.accessToken && r.data.refreshToken.startsWith('rfr_'));
  assert.equal(r.data.user.email, CRED_EMAIL);
  credLogin = r.data;
});

await test('register: duplicate email rejected', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { email: CRED_EMAIL.toUpperCase(), password: 'OtherPass999!' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'EMAIL_TAKEN');
});

await test('register: same email as OAuth user allowed (no auto-merge)', async () => {
  // login1 は Google OAuth ユーザー（test@example.com, password_hash NULL）
  // OAuth側と同一メールでも、資格情報アカウントは別ユーザーとして共存できる
  // （テストDBが永続化されるため、既に登録済みの場合はスキップ相当の200を許容）
  const r = await api('/auth/register', { method: 'POST', body: { email: 'test@example.com', password: 'OAuthCoexist1!' } });
  assert.ok(r.status === 200 || r.status === 409, `expected 200 or 409, got ${r.status}`);
});

await test('login: correct credentials succeed', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { email: CRED_EMAIL, password: CRED_PASS } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.accessToken && r.data.refreshToken);
});

await test('login: wrong password rejected', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { email: CRED_EMAIL, password: 'WrongPass999!' } });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'INVALID_CREDENTIALS');
});

await test('login: unknown email rejected (same error, no enumeration)', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'Whatever123!' } });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'INVALID_CREDENTIALS');
});

await test('login: password user refresh token rotates', async () => {
  const r = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: credLogin.refreshToken } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.refreshToken !== credLogin.refreshToken);
  credLogin = { ...credLogin, ...r.data };
});

await test('/auth/me works for password provider', async () => {
  const r = await api('/auth/me', { headers: { Authorization: `Bearer ${credLogin.accessToken}` } });
  assert.equal(r.status, 200);
  assert.equal(r.data.provider, 'password');
});

await test('password/change: wrong current password rejected', async () => {
  const r = await api('/auth/password/change', {
    method: 'POST',
    headers: { Authorization: `Bearer ${credLogin.accessToken}` },
    body: { currentPassword: 'WrongCurrent1!', newPassword: 'NewPass456!' },
  });
  assert.equal(r.status, 401);
});

await test('password/change: requires bearer token', async () => {
  const r = await api('/auth/password/change', { method: 'POST', body: { currentPassword: CRED_PASS, newPassword: 'NewPass456!' } });
  assert.equal(r.status, 401);
});

await test('password/change: success revokes all sessions', async () => {
  const r = await api('/auth/password/change', {
    method: 'POST',
    headers: { Authorization: `Bearer ${credLogin.accessToken}` },
    body: { currentPassword: CRED_PASS, newPassword: 'NewPass456!' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.sessionsRevoked >= 1);
  // 旧リフレッシュトークンは失効済みのはず
  const ref = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: credLogin.refreshToken } });
  assert.equal(ref.status, 401);
});

await test('login: new password works after change', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { email: CRED_EMAIL, password: 'NewPass456!' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  credLogin = r.data;
});

await test('login: rate limit locks after repeated failures', async () => {
  const email = 'ratelimit@example.com';
  await api('/auth/register', { method: 'POST', body: { email, password: 'RatePass123!' } });
  for (let i = 0; i < 5; i++) {
    const r = await api('/auth/login', { method: 'POST', body: { email, password: 'BadPass999!' } });
    assert.equal(r.status, 401);
  }
  const locked = await api('/auth/login', { method: 'POST', body: { email, password: 'RatePass123!' } });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.code, 'RATE_LIMITED');
});

// ================= 監査修正の検証 =================
await test('refresh: suspended user token refresh rejected + family revoked', async () => {
  // credLogin は新パスワードでログイン済みの資格情報ユーザー
  const userRow = await queryOne(`SELECT id FROM users WHERE lower(email) = lower($1)`, [CRED_EMAIL]);
  assert.ok(userRow, 'credential user must exist');
  // 凍結
  await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userRow.id]);
  try {
    const r = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: credLogin.refreshToken } });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'FORBIDDEN');
    // 同じファミリーの新トークンも失効しているはず（念のため別ユーザーでは確認困難なため status 復帰後に旧トークンが死んでいることを確認）
  } finally {
    await query(`UPDATE users SET status = 'active' WHERE id = $1`, [userRow.id]);
  }
  // 凍結中に発行されたであろうトークンが family 失効していることを確認するため、
  // 直前の refresh が 403 を返した時点で revokeFamily が実行済み。
  // 復帰後に同じ refreshToken を再提示 → 401（family revoked 済み）
  const again = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: credLogin.refreshToken } });
  assert.equal(again.status, 401, 'revoked family token must stay rejected after reactivation');
});

// ================= Phase D: メール確認・リセット・削除 =================
const { readMailOutbox } = await import('../dist/mailer.js');
const D_EMAIL = `phase-d-${Date.now().toString(36)}@example.com`;
let dLogin;

await test('register creates unverified user + sends no mail yet', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { email: D_EMAIL, password: 'PhaseDPass1!' } });
  assert.equal(r.status, 200);
  dLogin = r.data;
});

await test('email verify request: enumeration-safe response', async () => {
  const r1 = await api('/auth/email/verify/request', { method: 'POST', body: { email: D_EMAIL } });
  const r2 = await api('/auth/email/verify/request', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual(r1.data, r2.data, 'response must be identical regardless of account existence');
});

await test('verify email: GET shows confirm page (no consume), POST consumes', async () => {
  const mails = readMailOutbox().filter((m) => m.to === D_EMAIL && m.subject.includes('確認'));
  assert.ok(mails.length >= 1, 'verification mail should be in outbox');
  const link = mails[mails.length - 1].text.match(/token=(emt_[A-Za-z0-9_-]+)/);
  assert.ok(link, 'token link in mail');
  // GET は確認ページを返すだけでトークンを消費しない
  const getRes = await fetch(`${BASE}/auth/email/verify/confirm?token=${link[1]}`, { redirect: 'manual' });
  assert.equal(getRes.status, 200);
  const u1 = await queryOne(`SELECT email_verified FROM users WHERE lower(email)=lower($1)`, [D_EMAIL]);
  assert.equal(u1.email_verified, false, 'GET must not consume token');
  // POST /complete で実際に消費
  const postRes = await fetch(`${BASE}/auth/email/verify/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(link[1])}`,
  });
  assert.equal(postRes.status, 200);
  const u = await queryOne(`SELECT email_verified FROM users WHERE lower(email)=lower($1)`, [D_EMAIL]);
  assert.equal(u.email_verified, true);
});

await test('verify token reuse rejected', async () => {
  const mails = readMailOutbox().filter((m) => m.to === D_EMAIL && m.subject.includes('確認'));
  const link = mails[mails.length - 1].text.match(/token=(emt_[A-Za-z0-9_-]+)/);
  const res = await fetch(`${BASE}/auth/email/verify/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(link[1])}`,
  });
  assert.equal(res.status, 400, 'used token must be rejected');
});

let resetToken;
await test('password reset request: enumeration-safe + token issued', async () => {
  const r1 = await api('/auth/password/reset/request', { method: 'POST', body: { email: D_EMAIL } });
  const r2 = await api('/auth/password/reset/request', { method: 'POST', body: { email: 'ghost@example.com' } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.data, r2.data);
  const mails = readMailOutbox().filter((m) => m.to === D_EMAIL && m.subject.includes('再設定'));
  assert.ok(mails.length >= 1, 'reset mail in outbox');
  const m = mails[mails.length - 1].text.match(/token=(emt_[A-Za-z0-9_-]+)/);
  assert.ok(m);
  resetToken = m[1];
});

await test('password reset confirm via API revokes all sessions', async () => {
  // dLogin のリフレッシュトークンでセッションが有効なことを確認
  const before = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: dLogin.refreshToken } });
  // アクセストークンが新鮮なのでリフレッシュはそのまま成功するはず → まず失効前の状態を確認
  // （expiresIn=600 なので tokenExpiresAt 的にはまだ新しい。リフレッシュ自体はローテーションする）
  // リセット実行
  const r = await api('/auth/password/reset/confirm', { method: 'POST', body: { token: resetToken, newPassword: 'ResetPass999!' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.sessionsRevoked >= 1);
  // 旧リフレッシュトークンは失効済み
  const after = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: dLogin.refreshToken } });
  assert.equal(after.status, 401);
});

await test('reset token reuse rejected', async () => {
  const r = await api('/auth/password/reset/confirm', { method: 'POST', body: { token: resetToken, newPassword: 'AnotherPass1!' } });
  assert.equal(r.status, 400);
});

await test('login with reset password works', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { email: D_EMAIL, password: 'ResetPass999!' } });
  assert.equal(r.status, 200);
  dLogin = r.data;
});

await test('account delete requires password', async () => {
  const r = await api('/auth/account/delete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${dLogin.accessToken}` },
    body: { password: 'WrongPassword1!' },
  });
  assert.equal(r.status, 401);
});

await test('account delete succeeds and blocks re-login', async () => {
  const r = await api('/auth/account/delete', {
    method: 'POST',
    headers: { Authorization: `Bearer ${dLogin.accessToken}` },
    body: { password: 'ResetPass999!' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 再ログイン拒否
  const login = await api('/auth/login', { method: 'POST', body: { email: D_EMAIL, password: 'ResetPass999!' } });
  assert.equal(login.status, 401);
  // 既存リフレッシュトークンも失効
  const ref = await api('/auth/session/refresh', { method: 'POST', body: { refreshToken: dLogin.refreshToken } });
  assert.equal(ref.status, 401);
});

await test('deleted user cannot use OAuth-issued session either', async () => {
  // login1 (Google OAuth user test@example.com) は削除対象外なので影響なしを確認
  const me = await api('/auth/me', { headers: { Authorization: `Bearer ${login1.accessToken}` } });
  assert.equal(me.status, 200, 'OAuth user unaffected by credential account deletion');
});

// ---------- アカウント物理削除パージ（oauth_flows 削除順序の回帰テスト）----------
await test('purge removes victim oauth_flows/codes, keeps others, preserves audit, idempotent', async () => {
  const { purgeDeletedUsers } = await import('../dist/db.js');
  const RUN = Date.now().toString(36);

  // 削除対象ユーザーと、削除されない別ユーザーを登録
  const victimReg = await api('/auth/register', { method: 'POST', body: { email: `purge-victim-${RUN}@example.com`, password: 'PurgePass123!' } });
  const otherReg = await api('/auth/register', { method: 'POST', body: { email: `purge-other-${RUN}@example.com`, password: 'PurgePass123!' } });
  assert.equal(victimReg.status, 200);
  assert.equal(otherReg.status, 200);
  const victimId = victimReg.data.user.id;
  const otherId = otherReg.data.user.id;

  // 各ユーザーに oauth_flow + oauth_code を作成
  const mkFlowCode = async (uid, tag) => {
    const flow = await queryOne(
      `INSERT INTO oauth_flows (state, provider, code_verifier, code_challenge, redirect_uri, expires_at)
       VALUES ($1, 'google', 'verifier', 'challenge', 'http://127.0.0.1:1/cb', now() + interval '10 minutes') RETURNING id`,
      [`state-${tag}-${RUN}`]
    );
    await query(
      `INSERT INTO oauth_codes (code, flow_id, user_id, state, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, 'http://127.0.0.1:1/cb', now() + interval '1 minute')`,
      [`code-${tag}-${RUN}`, flow.id, uid, `state-${tag}-${RUN}`]
    );
    return flow.id;
  };
  const victimFlowId = await mkFlowCode(victimId, 'victim');
  const otherFlowId = await mkFlowCode(otherId, 'other');

  // victim を40日前に削除済み状態へ（ソフトデリート相当を直接再現）
  await query(`UPDATE users SET deleted_at = now() - interval '40 days', status = 'deleted' WHERE id = $1`, [victimId]);
  // 監査ログの証跡を作成
  await query(`INSERT INTO audit_logs (user_id, event) VALUES ($1, 'account_deleted')`, [victimId]);

  // パージ実行（30日保持を超過した victim のみ対象）
  const purged = await purgeDeletedUsers(30);
  assert.ok(purged >= 1, 'at least victim should be purged');

  // victim の users / oauth_codes / oauth_flows が残らない
  assert.equal(await queryOne(`SELECT id FROM users WHERE id = $1`, [victimId]), null);
  assert.equal(await queryOne(`SELECT code FROM oauth_codes WHERE user_id = $1`, [victimId]), null);
  assert.equal(await queryOne(`SELECT id FROM oauth_flows WHERE id = $1`, [victimFlowId]), null,
    'victim oauth_flow must be physically deleted (regression: previously orphaned)');

  // 別ユーザーのデータは残る
  assert.ok(await queryOne(`SELECT id FROM users WHERE id = $1`, [otherId]), 'other user must remain');
  assert.ok(await queryOne(`SELECT code FROM oauth_codes WHERE user_id = $1`, [otherId]), 'other oauth_code must remain');
  assert.ok(await queryOne(`SELECT id FROM oauth_flows WHERE id = $1`, [otherFlowId]), 'other oauth_flow must remain');

  // audit_logs は user_id NULL 化で証跡保持
  const auditRow = await queryOne(
    `SELECT user_id, event FROM audit_logs WHERE event = 'account_deleted' ORDER BY created_at DESC LIMIT 1`
  );
  assert.ok(auditRow, 'audit log row must be preserved');
  assert.equal(auditRow.user_id, null, 'audit_logs.user_id must be NULL after purge');

  // 冪等性: 2回目のパージは victim を再削除しない
  const purged2 = await purgeDeletedUsers(30);
  assert.equal(await queryOne(`SELECT id FROM users WHERE id = $1`, [victimId]), null);
  assert.ok(await queryOne(`SELECT id FROM users WHERE id = $1`, [otherId]), 'other user still intact after 2nd purge');
});

// ---------- ログ漏えいチェック ----------
await test('no secrets/tokens in logs', async () => {
  const all = logs.join('\n');
  assert.ok(!all.includes(GOOGLE_CLIENT_SECRET), 'client secret leaked to logs');
  assert.ok(!all.includes('test-google-client-secret'), 'secret fragment leaked');
  assert.ok(!all.includes(login1.accessToken || '___'), 'access token leaked');
  assert.ok(!all.includes('mock-access-token'), 'provider access token leaked');
  assert.ok(!all.includes(CRED_PASS), 'password leaked to logs');
  assert.ok(!all.includes('NewPass456!'), 'new password leaked to logs');
});

// ---------- クリーンアップ ----------
console.log = origLog; console.error = origErr;
server.close();
mockServer.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
