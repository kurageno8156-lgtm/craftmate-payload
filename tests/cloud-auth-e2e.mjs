// Phase C E2E: desktop cloudAuth client <-> auth-server (PGlite dev)
// 使い方: node tests/cloud-auth-e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const AUTH_DIR = path.join(root, 'auth-server');
const AUTH_PORT = 18990;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
const TMP_LOCAL = path.join(root, '.test-cloud-localappdata');
fs.rmSync(TMP_LOCAL, { recursive: true, force: true });
fs.mkdirSync(TMP_LOCAL, { recursive: true });

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ..  ${name}\n`);
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 30s')), 30000))]); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`FAIL  ${name}: ${e.message}\n`); }
}

// ---------- Auth Server 起動 ----------
const authEnv = {
  ...process.env,
  AUTH_PUBLIC_URL: AUTH_URL,
  AUTH_DEV_INSECURE_HTTP: '1',
  PORT: String(AUTH_PORT),
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  PGLITE_DIR: path.join(AUTH_DIR, '.test-data-e2e'),
};
const authProc = spawn(process.execPath, [path.join(AUTH_DIR, 'dist', 'index.js')], { env: authEnv, stdio: ['ignore', 'pipe', 'pipe'] });
authProc.stderr.on('data', (d) => process.stderr.write('[auth] ' + d));

async function waitAuth() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${AUTH_URL}/ops/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('auth server did not start');
}

// ---------- desktop cloudAuth クライアント ----------
// db.js は LOCALAPPDATA 配下に craftmate.db を作る。env を設定してから import。
process.env.LOCALAPPDATA = TMP_LOCAL;
process.env.CRAFTMATE_AUTH_URL = AUTH_URL;
const cloud = await import('../dist/server/cloudAuth.js');

await waitAuth();
process.stdout.write('== cloud auth E2E ==\n');

const EMAIL = `e2e-${Date.now()}@example.com`;
const PASS = 'E2ePass123!';

await test('cloudAuthConfigured true with loopback http', () => {
  assert.equal(cloud.cloudAuthConfigured(), true);
});

await test('register via cloudAuth', async () => {
  const tokens = await cloud.cloudRegister(EMAIL, PASS, 'E2E User');
  assert.ok(tokens.accessToken && tokens.refreshToken);
  cloud.saveCloudSessionForLogin(tokens);
});

await test('getCloudSession returns stored session', () => {
  const s = cloud.getCloudSession();
  assert.ok(s && s.user.email === EMAIL);
  assert.equal(cloud.cloudCraftmateUser(), `cloud:${s.user.id}`);
});

await test('duplicate register rejected', async () => {
  await assert.rejects(() => cloud.cloudRegister(EMAIL, 'OtherPass1!'), (e) => e.status === 409 || /already exists/i.test(e.message));
});

await test('wrong password login rejected', async () => {
  await assert.rejects(() => cloud.cloudLogin(EMAIL, 'WrongPass1!'));
});

await test('login via cloudAuth', async () => {
  const tokens = await cloud.cloudLogin(EMAIL, PASS);
  cloud.saveCloudSessionForLogin(tokens);
});

await test('cloudMe returns user', async () => {
  const me = await cloud.cloudMe();
  assert.ok(me && me.email === EMAIL);
});

await test('ensureFreshAccessToken keeps session when fresh', async () => {
  const ok = await cloud.ensureFreshAccessToken();
  assert.equal(ok, true);
});

await test('password change revokes session locally', async () => {
  await cloud.cloudChangePassword(PASS, 'E2eNewPass456!');
  assert.equal(cloud.getCloudSession(), null, 'session should be cleared after password change');
});

await test('login with new password works', async () => {
  const tokens = await cloud.cloudLogin(EMAIL, 'E2eNewPass456!');
  cloud.saveCloudSessionForLogin(tokens);
});

await test('refresh token reuse detection clears session', async () => {
  const { getIntegration, upsertIntegration } = await import('../dist/db.js');
  const { encryptJson, decryptJson } = await import('../dist/integrations.js');
  const forceExpire = () => {
    const row = getIntegration('__cloud_auth_session');
    const sess = decryptJson(row.payload);
    sess.tokenExpiresAt = Date.now() - 1000;
    upsertIntegration('__cloud_auth_session', 'connected', encryptJson(sess));
  };

  const s1 = cloud.getCloudSession();
  const oldRefresh = s1.refreshToken;
  // アクセストークン期限切れにして強制リフレッシュ → サーバー側でローテーション
  forceExpire();
  const ok = await cloud.ensureFreshAccessToken();
  assert.equal(ok, true);
  // 旧リフレッシュトークンで直接サーバーを叩く → token_history 経由で再利用検知
  const r = await fetch(`${AUTH_URL}/auth/session/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: oldRefresh }),
  });
  assert.equal(r.status, 401);
  const data = await r.json();
  assert.equal(data.code, 'TOKEN_REUSE');
  // family 全失効済み → ローカルの新トークンも次回リフレッシュで拒否されセッション削除
  forceExpire();
  const ok2 = await cloud.ensureFreshAccessToken();
  assert.equal(ok2, false, 'refresh should fail after family revocation');
  assert.equal(cloud.getCloudSession(), null, 'session should be cleared on token reuse');
});

await test('cloudLogout clears session', async () => {
  const tokens = await cloud.cloudLogin(EMAIL, 'E2eNewPass456!');
  cloud.saveCloudSessionForLogin(tokens);
  assert.ok(cloud.getCloudSession());
  await cloud.cloudLogout();
  assert.equal(cloud.getCloudSession(), null);
});

await test('auth server stop → ensureFreshAccessToken keeps session (network failure safe)', async () => {
  const tokens = await cloud.cloudLogin(EMAIL, 'E2eNewPass456!');
  cloud.saveCloudSessionForLogin(tokens);
  // サーバー停止
  authProc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  // 期限切れにしてリフレッシュ試行 → ネットワーク障害でもセッション保持
  const { getIntegration, upsertIntegration } = await import('../dist/db.js');
  const { encryptJson, decryptJson } = await import('../dist/integrations.js');
  const row = getIntegration('__cloud_auth_session');
  const sess = decryptJson(row.payload);
  sess.tokenExpiresAt = Date.now() - 1000;
  upsertIntegration('__cloud_auth_session', 'connected', encryptJson(sess));
  const ok = await cloud.ensureFreshAccessToken();
  assert.equal(ok, true, 'network failure should not clear session');
  assert.ok(cloud.getCloudSession(), 'session should be preserved on network failure');
  await cloud.cloudLogout();
});

// ---------- クリーンアップ ----------
authProc.kill('SIGKILL');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
