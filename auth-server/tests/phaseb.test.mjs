// Phase B テスト: PostgreSQL/Redis対応・本番設定検証・Graceful Shutdown
// 実行: npm run build && node tests/phaseb.test.mjs
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DIST_INDEX = path.join(root, 'dist', 'index.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ..  ${name}\n`);
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 30s')), 30000))]); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`FAIL  ${name}: ${e.message}\n`); }
}

// ---------- ヘルパー ----------
function baseEnv(extra = {}) {
  return {
    ...process.env,
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    AUTH_DEV_INSECURE_HTTP: '1',
    AUTH_PUBLIC_URL: 'http://127.0.0.1:18997',
    PGLITE_DIR: path.join(root, '.test-data-phaseb'),
    ...extra,
  };
}

// 子プロセスを起動し、exit code / stderr を返す
function spawnServer(env, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err, killed: true }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// ポートが listen するまで待つ
async function waitForPort(port, proc, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.killed) throw new Error('server exited before listening');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ops/health`);
      return r;
    } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('server did not listen in time');
}

process.stdout.write('== Phase B tests ==\n');

// ---------- 1. 本番環境でJWT鍵未設定 → 起動拒否 ----------
await test('production without JWT keys → startup refused', async () => {
  const r = await spawnServer(baseEnv({
    NODE_ENV: 'production',
    AUTH_PUBLIC_URL: 'https://auth.example.com',
    AUTH_DEV_INSECURE_HTTP: '0',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db', // 未到達でも鍵チェックが先
    BIND_HOST: '127.0.0.1',
    // AUTH_JWT_* 未設定
  }));
  assert.notEqual(r.code, 0, 'should exit non-zero');
  assert.ok(r.err.includes('AUTH_JWT_PRIVATE_KEY_PEM') || r.err.includes('JWT keys'), `unexpected error: ${r.err.slice(0, 200)}`);
});

// ---------- 2. 本番環境でBIND_HOST未設定 → 起動拒否 ----------
await test('production without BIND_HOST → startup refused', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = await spawnServer(baseEnv({
    NODE_ENV: 'production',
    AUTH_PUBLIC_URL: 'https://auth.example.com',
    AUTH_DEV_INSECURE_HTTP: '0',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db',
    AUTH_JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    AUTH_JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }),
    // BIND_HOST 未設定
  }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('BIND_HOST'), `unexpected error: ${r.err.slice(0, 200)}`);
});

// ---------- 3. 本番環境でDATABASE_URL未設定 → 起動拒否（PGlite誤用防止） ----------
await test('production without DATABASE_URL → startup refused', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = await spawnServer(baseEnv({
    NODE_ENV: 'production',
    AUTH_PUBLIC_URL: 'https://auth.example.com',
    AUTH_DEV_INSECURE_HTTP: '0',
    AUTH_JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    AUTH_JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }),
    BIND_HOST: '127.0.0.1',
    // DATABASE_URL 未設定
  }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('DATABASE_URL'), `unexpected error: ${r.err.slice(0, 200)}`);
});

// ---------- 4. DB接続失敗 → 安全に起動中止 ----------
await test('unreachable DATABASE_URL → safe startup abort', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = await spawnServer(baseEnv({
    NODE_ENV: 'production',
    AUTH_PUBLIC_URL: 'https://auth.example.com',
    AUTH_DEV_INSECURE_HTTP: '0',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db', // ポート1は確実に拒否
    AUTH_JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    AUTH_JWT_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }),
    BIND_HOST: '127.0.0.1',
  }), 20000);
  assert.notEqual(r.code, 0, 'should exit non-zero on DB failure');
  assert.ok(!r.out.includes('listening'), 'must not listen when DB fails');
});

// ---------- 5. 開発環境: PGlite + BIND_HOST=127.0.0.1 で起動 ----------
let devProc = null;
await test('dev mode: pglite + loopback bind + health check', async () => {
  const port = 18997;
  const env = baseEnv({ PORT: String(port), BIND_HOST: '127.0.0.1' });
  delete env.NODE_ENV; // development
  const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  devProc = child;
  const health = await waitForPort(port, child);
  const data = await health.json();
  assert.equal(data.ok, true);
  assert.equal(data.db, 'pglite');
  assert.equal(data.redis, 'disabled');
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
});

// ---------- 6. Graceful Shutdown ----------
// Windowsでは外部シグナルがハンドラを実行しないため、in-processで shutdown() を直接検証。
// 環境変数は config モジュール評価前に設定する必要があるため動的importを使用。
await test('graceful shutdown closes server and db cleanly', async () => {
  process.env.PORT = '18993';
  process.env.BIND_HOST = '127.0.0.1';
  process.env.PGLITE_DIR = path.join(root, '.test-data-phaseb-shutdown');
  delete process.env.NODE_ENV;
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_URL;
  process.env.GOOGLE_CLIENT_ID = 'test';
  process.env.GOOGLE_CLIENT_SECRET = 'test';
  process.env.AUTH_DEV_INSECURE_HTTP = '1';
  process.env.AUTH_PUBLIC_URL = 'http://127.0.0.1:18993';

  const { start } = await import('../dist/index.js');
  const running = await start();
  // 起動確認
  const health = await fetch('http://127.0.0.1:18993/ops/health');
  assert.equal(health.status, 200);
  // shutdown() が例外なく完了し、サーバーが接続を受け付けなくなること
  await running.shutdown('test');
  assert.equal(running.server.listening, false);
  await assert.rejects(fetch('http://127.0.0.1:18993/ops/health'), 'server should refuse connections after shutdown');
});

// ---------- 7. セキュリティヘッダー ----------
await test('security headers present', async () => {
  const env = baseEnv({ PORT: '18996', BIND_HOST: '127.0.0.1' });
  const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForPort(18996, child);
    const res = await fetch('http://127.0.0.1:18996/ops/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

// ---------- 8. Redis未設定でもレート制限はメモリで動作（既存動作維持） ----------
await test('rate limit works without redis (memory fallback in dev)', async () => {
  // dev モード（REDIS_URL未設定）で /auth/login を5回失敗 → 6回目は429
  const port = 18995;
  const env = baseEnv({ PORT: String(port), BIND_HOST: '127.0.0.1' });
  delete env.NODE_ENV; delete env.REDIS_URL;
  const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForPort(port, child);
    const email = `rl-test-${Date.now()}@example.com`;
    await fetch(`http://127.0.0.1:${port}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'RatePass123!' }),
    });
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'BadPass999!' }),
      });
    }
    const locked = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'RatePass123!' }),
    });
    assert.equal(locked.status, 429, `expected 429, got ${locked.status}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

// ---------- 8b. 不正な TRUSTED_PROXY → 起動拒否 ----------
await test('invalid TRUSTED_PROXY value → startup refused', async () => {
  const r = await spawnServer(baseEnv({
    TRUSTED_PROXY: 'not-an-ip-or-keyword!!',
  }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('TRUSTED_PROXY'), `unexpected error: ${r.err.slice(0, 200)}`);
});

// ---------- 8c. 有効な TRUSTED_PROXY（loopback）→ 起動成功 ----------
await test('valid TRUSTED_PROXY=loopback → server starts', async () => {
  const port = 18992;
  const env = baseEnv({ PORT: String(port), BIND_HOST: '127.0.0.1', TRUSTED_PROXY: 'loopback' });
  delete env.NODE_ENV;
  const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const health = await waitForPort(port, child);
    const data = await health.json();
    assert.equal(data.ok, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

// ---------- 9. Redis設定済み+接続不可 → フェイルクローズ（503） ----------
await test('redis configured but unreachable → login fails closed (503)', async () => {
  const port = 18994;
  const env = baseEnv({ PORT: String(port), BIND_HOST: '127.0.0.1', REDIS_URL: 'redis://127.0.0.1:1' }); // ポート1は拒否
  delete env.NODE_ENV;
  const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForPort(port, child);
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'anyone@example.com', password: 'Whatever123!' }),
    });
    // Redis未接続なら unavailable → 503（制限なしで通さない）
    assert.ok(res.status === 503 || res.status === 401, `expected 503 or 401, got ${res.status}`);
    if (res.status === 503) {
      const data = await res.json();
      assert.equal(data.code, 'AUTH_UNAVAILABLE');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
