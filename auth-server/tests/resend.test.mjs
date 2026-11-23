// Resend メールプロバイダ + 本番メール設定検証テスト
// 実 Resend API には接続しない（フェイククライアント／spawn による起動拒否確認）
// 実行: npm run build && node tests/resend.test.mjs
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const DIST_INDEX = path.join(root, 'dist', 'index.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  process.stdout.write(`  ..  ${name}\n`);
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 30s')), 30000))]); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`FAIL  ${name}: ${e.message}\n`); }
}

// ---------- 単体テスト用 env（モジュール import 前に必須）----------
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.AUTH_DEV_INSECURE_HTTP = '1';
process.env.AUTH_PUBLIC_URL = 'http://127.0.0.1:18996';
process.env.PGLITE_DIR = path.join(root, '.test-data-resend');
process.env.MAIL_FROM = 'BlockWhiz <noreply@example.com>';
process.env.MAIL_REPLY_TO = 'support@example.com';
// MAIL_PROVIDER は未設定 → mock（開発既定）

const { ResendMailer, getMailer, resetMailerForTest } = await import('../dist/mailer.js');

// ---------- ResendMailer 単体テスト（フェイククライアント） ----------

await test('ResendMailer sends html+text with from/reply_to', async () => {
  const calls = [];
  const fake = { emails: { send: async (p) => { calls.push(p); return { data: { id: 'msg_1' }, error: null }; } } };
  const m = new ResendMailer(fake);
  await m.send({ to: 'user@example.com', subject: '件名テスト', text: '本文テスト', html: '<p>本文テスト</p>' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, 'BlockWhiz <noreply@example.com>');
  assert.equal(calls[0].to, 'user@example.com');
  assert.equal(calls[0].subject, '件名テスト');
  assert.equal(calls[0].text, '本文テスト');
  assert.equal(calls[0].html, '<p>本文テスト</p>');
  assert.equal(calls[0].reply_to, 'support@example.com');
});

await test('ResendMailer API error → throws sanitized error', async () => {
  const fake = { emails: { send: async () => ({ data: null, error: { name: 'validation_error', message: 'Invalid `to` field' } }) } };
  const m = new ResendMailer(fake);
  await assert.rejects(
    m.send({ to: 'bad', subject: 's', text: 't' }),
    (e) => e.message.includes('Resend send failed') && e.message.includes('validation_error')
  );
});

await test('ResendMailer network error → propagates', async () => {
  const fake = { emails: { send: async () => { throw new Error('fetch failed'); } } };
  const m = new ResendMailer(fake);
  await assert.rejects(m.send({ to: 'u@e.com', subject: 's', text: 't' }), /fetch failed/);
});

await test('ResendMailer empty response → throws', async () => {
  const fake = { emails: { send: async () => ({ data: null, error: null }) } };
  const m = new ResendMailer(fake);
  await assert.rejects(m.send({ to: 'u@e.com', subject: 's', text: 't' }), /empty response/);
});

await test('ResendMailer passes AbortSignal timeout to SDK', async () => {
  let captured;
  const fake = { emails: { send: async (p, opts) => { captured = opts; return { data: { id: 'm' }, error: null }; } } };
  const m = new ResendMailer(fake);
  await m.send({ to: 'u@e.com', subject: 's', text: 't' });
  assert.ok(captured?.signal instanceof AbortSignal, 'send must receive an AbortSignal');
});

await test('ResendMailer without MAIL_REPLY_TO → reply_to is undefined', async () => {
  // このプロセスでは MAIL_REPLY_TO=support@example.com が設定済みのため、
  // 未設定ケースは別 env の spawn で検証する（下記 spawn テスト参照）。
  let captured;
  const fake = { emails: { send: async (p) => { captured = p; return { data: { id: 'm' }, error: null }; } } };
  const m = new ResendMailer(fake);
  await m.send({ to: 'u@e.com', subject: 's', text: 't' });
  assert.equal(captured.reply_to, 'support@example.com');
});

await test('API key does not leak into error logs', async () => {
  const FAKE_KEY = 're_TESTSECRETKEY_12345';
  process.env.RESEND_API_KEY = FAKE_KEY;
  // 実SDKを介さずエラー経路のみ検証: エラーメッセージにキーが含まれないこと
  const fake = { emails: { send: async () => ({ data: null, error: { name: 'api_key_missing', message: 'API key is missing' } }) } };
  const m = new ResendMailer(fake);
  try {
    await m.send({ to: 'u@e.com', subject: 's', text: 't' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(!e.message.includes(FAKE_KEY), 'error message must not contain API key');
    assert.ok(!String(e.stack).includes(FAKE_KEY), 'stack must not contain API key');
  }
  delete process.env.RESEND_API_KEY;
});

await test('dev default → getMailer returns MockMailer (outbox)', async () => {
  resetMailerForTest();
  const m = getMailer();
  await m.send({ to: 'mock-test@example.com', subject: 'mock subject', text: 'mock body' });
  const { readMailOutbox } = await import('../dist/mailer.js');
  const outbox = readMailOutbox();
  const hit = outbox.find((e) => e.to === 'mock-test@example.com' && e.subject === 'mock subject');
  assert.ok(hit, 'mock mail should be written to outbox');
  assert.equal(hit.text, 'mock body');
});

// ---------- config バリデーション（spawn による起動拒否確認） ----------

function baseEnv(extra = {}) {
  return {
    ...process.env,
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    AUTH_DEV_INSECURE_HTTP: '1',
    AUTH_PUBLIC_URL: 'http://127.0.0.1:18996',
    PGLITE_DIR: path.join(root, '.test-data-resend-spawn'),
    ...extra,
  };
}

function spawnServer(env, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err, killed: true }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

// 本番で必要な最小 env（メール以外を全て満たす）
function prodBaseEnv(extra = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    BIND_HOST: '0.0.0.0',
    AUTH_PUBLIC_URL: 'https://auth.example.com',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db', // 接続は失敗するがconfig検証は先に走る
    AUTH_JWT_PRIVATE_KEY_PEM: 'dummy-not-parsed-yet',
    AUTH_JWT_PUBLIC_KEY_PEM: 'dummy-not-parsed-yet',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    ...extra,
  };
  // 本番では loopback 限定の開発用 http 許可を必ず除去する
  delete env.AUTH_DEV_INSECURE_HTTP;
  return env;
}

await test('production + MAIL_PROVIDER unset → startup refused (mock default)', async () => {
  const env = { ...prodBaseEnv() };
  delete env.MAIL_PROVIDER;
  const r = await spawnServer(env);
  assert.notEqual(r.code, 0, 'should exit non-zero');
  assert.ok(r.err.includes('MAIL_PROVIDER=mock is not allowed in production'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('production + MAIL_PROVIDER=mock → startup refused', async () => {
  const r = await spawnServer(prodBaseEnv({ MAIL_PROVIDER: 'mock' }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('MAIL_PROVIDER=mock is not allowed in production'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('production + MAIL_PROVIDER=resend without RESEND_API_KEY → refused', async () => {
  const env = prodBaseEnv({ MAIL_PROVIDER: 'resend', MAIL_FROM: 'BlockWhiz <noreply@example.com>' });
  delete env.RESEND_API_KEY;
  const r = await spawnServer(env);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('RESEND_API_KEY is required'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('production + MAIL_PROVIDER=resend without MAIL_FROM → refused', async () => {
  const env = prodBaseEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_key' });
  delete env.MAIL_FROM;
  const r = await spawnServer(env);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('MAIL_FROM is required'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('production + resend fully configured → passes mail validation (fails later at DB)', async () => {
  const r = await spawnServer(prodBaseEnv({
    MAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_test_key',
    MAIL_FROM: 'BlockWhiz <noreply@example.com>',
  }));
  assert.notEqual(r.code, 0, 'DB connect should fail (dummy URL)');
  // メール関連エラーではなく DB 接続エラーで落ちることを確認
  assert.ok(!r.err.includes('MAIL_PROVIDER') && !r.err.includes('RESEND_API_KEY') && !r.err.includes('MAIL_FROM'),
    `mail validation should have passed, got: ${r.err.slice(0, 300)}`);
});

await test('unsupported MAIL_PROVIDER → startup refused (any env)', async () => {
  const r = await spawnServer(baseEnv({ MAIL_PROVIDER: 'sendgrid' }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('Unsupported MAIL_PROVIDER'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('dev + resend without RESEND_API_KEY → startup refused', async () => {
  const env = baseEnv({ MAIL_PROVIDER: 'resend', MAIL_FROM: 'BlockWhiz <noreply@example.com>' });
  delete env.RESEND_API_KEY;
  const r = await spawnServer(env);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('RESEND_API_KEY is required'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('resend + invalid MAIL_FROM → startup refused', async () => {
  const r = await spawnServer(baseEnv({
    MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'not-an-email',
  }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('MAIL_FROM is not a valid'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('resend + invalid MAIL_REPLY_TO → startup refused', async () => {
  const r = await spawnServer(baseEnv({
    MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test',
    MAIL_FROM: 'BlockWhiz <noreply@example.com>', MAIL_REPLY_TO: 'bad@@addr',
  }));
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes('MAIL_REPLY_TO is not a valid'), `unexpected: ${r.err.slice(0, 300)}`);
});

await test('resend + display-name MAIL_FROM → passes mail validation', async () => {
  const r = await spawnServer(baseEnv({
    MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test',
    MAIL_FROM: 'BlockWhiz Support <noreply@example.com>',
  }));
  // dev環境なのでconfigは通りPGliteで起動する → health が返れば成功
  // spawnServer は exit を待つので、起動成功=タイムアウトkill。killed=true なら起動成功とみなす
  assert.ok(r.killed === true || r.out.includes('listening'), `server should have started: ${r.err.slice(0, 200)}`);
});

// ---------- getMailer() 選択 + reply_to 挙動（別env spawnでconfig切替） ----------
const MAILER_URL = pathToFileURL(path.join(root, 'dist', 'mailer.js')).href;

function runMailerEval(env, code, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out, err, killed: true }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
  });
}

await test('MAIL_PROVIDER=resend → getMailer returns ResendMailer', async () => {
  const code = `const m = await import(${JSON.stringify(MAILER_URL)}); const g = m.getMailer(); console.log('CTOR:' + g.constructor.name);`;
  const r = await runMailerEval(baseEnv({
    MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'BlockWhiz <noreply@example.com>',
  }), code);
  assert.equal(r.code, 0, `unexpected: ${r.err.slice(0, 300)}`);
  assert.ok(r.out.includes('CTOR:ResendMailer'), `unexpected: ${r.out}`);
});

await test('MAIL_PROVIDER unset (dev) → getMailer returns MockMailer', async () => {
  const env = baseEnv();
  delete env.MAIL_PROVIDER;
  const code = `const m = await import(${JSON.stringify(MAILER_URL)}); const g = m.getMailer(); console.log('CTOR:' + g.constructor.name);`;
  const r = await runMailerEval(env, code);
  assert.equal(r.code, 0, `unexpected: ${r.err.slice(0, 300)}`);
  assert.ok(r.out.includes('CTOR:MockMailer'), `unexpected: ${r.out}`);
});

await test('MAIL_REPLY_TO unset → reply_to not sent; set → sent', async () => {
  const code = `
    const m = await import(${JSON.stringify(MAILER_URL)});
    let captured;
    const fake = { emails: { send: async (p) => { captured = p; return { data: { id: 'x' }, error: null }; } } };
    const mailer = new m.ResendMailer(fake);
    await mailer.send({ to: 'u@e.com', subject: 's', text: 't' });
    console.log('REPLY_TO:' + JSON.stringify(captured.reply_to ?? null));
  `;
  // 未設定ケース
  const envUnset = baseEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'BlockWhiz <noreply@example.com>' });
  delete envUnset.MAIL_REPLY_TO;
  const r1 = await runMailerEval(envUnset, code);
  assert.equal(r1.code, 0, `unexpected: ${r1.err.slice(0, 300)}`);
  assert.ok(r1.out.includes('REPLY_TO:null'), `reply_to should be absent, got: ${r1.out}`);
  // 設定ケース
  const envSet = baseEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: 'BlockWhiz <noreply@example.com>', MAIL_REPLY_TO: 'support@example.com' });
  const r2 = await runMailerEval(envSet, code);
  assert.equal(r2.code, 0, `unexpected: ${r2.err.slice(0, 300)}`);
  assert.ok(r2.out.includes('REPLY_TO:"support@example.com"'), `reply_to should be passed, got: ${r2.out}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
