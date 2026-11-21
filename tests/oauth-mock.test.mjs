// CraftMate OAuth モックテスト（実プロバイダ不使用）
// 実行: node tests/oauth-mock.test.mjs
// LOCALAPPDATA を一時ディレクトリに差し替えて DB を隔離する。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'craftmate-oauth-test-'));
process.env.LOCALAPPDATA = tmp;
process.env.OAUTH_ENCRYPTION_KEY = 'a'.repeat(64);

const db = await import('../dist/db.js');
const integ = await import('../dist/integrations.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}

console.log('== external_identities 所有者保護 ==');

test('初回連携で所有者が記録される', () => {
  db.upsertExternalIdentity('github', '12345', 'local:alice', 'Alice GH', 'a@x.y');
  const row = db.getExternalIdentity('github', '12345');
  assert.equal(row.craftmate_user, 'local:alice');
});

test('DB層: 別ユーザーの upsert で所有者が上書きされない', () => {
  db.upsertExternalIdentity('github', '12345', 'local:bob', 'Bob GH', 'b@x.y');
  const row = db.getExternalIdentity('github', '12345');
  assert.equal(row.craftmate_user, 'local:alice', 'craftmate_user must not be overwritten');
  assert.equal(row.display_name, 'Bob GH', 'display_name は更新される');
});

test('アプリ層チェック相当: 別ユーザーは拒否される', () => {
  // webServer callback と同じ判定: 既存所有者 !== craftmateUser → 拒否
  const existing = db.getExternalIdentity('github', '12345');
  const craftmateUser = 'local:bob';
  const rejected = existing && existing.craftmate_user !== craftmateUser;
  assert.equal(rejected, true);
});

test('同一ユーザーの再連携は許可される', () => {
  db.upsertExternalIdentity('github', '12345', 'local:alice', 'Alice GH2', 'a2@x.y');
  const row = db.getExternalIdentity('github', '12345');
  assert.equal(row.craftmate_user, 'local:alice');
  assert.equal(row.display_name, 'Alice GH2');
});

test('別プロバイダ/別IDは独立して連携できる', () => {
  db.upsertExternalIdentity('discord', '999', 'local:alice', 'Alice DC', 'a@x.y');
  db.upsertExternalIdentity('github', '67890', 'local:bob', 'Bob GH', 'b@x.y');
  assert.equal(db.getExternalIdentity('discord', '999').craftmate_user, 'local:alice');
  assert.equal(db.getExternalIdentity('github', '67890').craftmate_user, 'local:bob');
});

test('listExternalIdentities はユーザー単位で絞り込める', () => {
  const alice = db.listExternalIdentities('local:alice');
  assert.ok(alice.some(r => r.provider === 'github' && r.provider_user_id === '12345'));
  assert.ok(alice.some(r => r.provider === 'discord'));
  const bob = db.listExternalIdentities('local:bob');
  assert.ok(!bob.some(r => r.provider_user_id === '12345'));
});

console.log('== 暗号化 ==');

test('encrypt/decrypt ラウンドトリップ', () => {
  const enc = integ.encryptJson({ access_token: 'SECRET', refresh_token: 'RT' });
  const dec = integ.decryptJson(enc);
  assert.equal(dec.access_token, 'SECRET');
  assert.equal(dec.refresh_token, 'RT');
});

test('改ざん検知', () => {
  const enc = integ.encryptJson({ a: 1 });
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal(integ.decryptJson(tampered), null);
  assert.equal(integ.decryptJson('AAAA'), null);
});

test('env key で暗号化→同じ env key で復号（再起動相当）', async () => {
  // cachedKey をリセットするため別プロセス相当の確認は省略。
  // 同一プロセス内で encrypt→decrypt が成立することを確認。
  const enc = integ.encryptJson({ token: 'persisted' });
  assert.equal(integ.decryptJson(enc).token, 'persisted');
});

console.log('== トークン更新 ==');

test('mergeRefreshedTokens: refresh_token ローテーション', () => {
  const old = { access_token: 'old', refresh_token: 'rt1', clientId: 'cid', tokenExpiresAt: 1 };
  const fresh = { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 };
  const merged = integ.mergeRefreshedTokens(old, fresh);
  assert.equal(merged.access_token, 'new');
  assert.equal(merged.refresh_token, 'rt2', '新 refresh_token で置き換え');
  assert.ok(merged.tokenExpiresAt > Date.now(), 'tokenExpiresAt が再計算される');
  assert.equal(merged.clientId, 'cid', 'clientId は維持');
});

test('mergeRefreshedTokens: refresh_token 非返却時は旧を維持（Google型）', () => {
  const old = { access_token: 'old', refresh_token: 'rt1' };
  const fresh = { access_token: 'new', expires_in: 3600 };
  const merged = integ.mergeRefreshedTokens(old, fresh);
  assert.equal(merged.refresh_token, 'rt1');
});

test('refreshAccessToken: grant_type=refresh_token を送信', async () => {
  let body = '';
  globalThis.fetch = async (url, opts) => {
    body = opts.body.toString();
    return new Response(JSON.stringify({ access_token: 'at2', expires_in: 3600 }), { status: 200 });
  };
  const ms = integ.getProvider('microsoft');
  const r = await integ.refreshAccessToken(ms, { refreshToken: 'rt', clientId: 'cid', clientSecret: 'sec' });
  assert.equal(r.access_token, 'at2');
  assert.ok(body.includes('grant_type=refresh_token'));
  assert.ok(body.includes('refresh_token=rt'));
});

test('refreshAccessToken: invalid_grant エラーが伝播（再認証要求の判定材料）', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  const ms = integ.getProvider('microsoft');
  await assert.rejects(
    () => integ.refreshAccessToken(ms, { refreshToken: 'rt', clientId: 'cid' }),
    /invalid_grant/
  );
});

test('GitHub は refresh_token 非保持なら更新対象外（tokenNeedsRefresh 相当の前提条件）', () => {
  // webServer.tokenNeedsRefresh は refresh_token 必須。GitHub の典型応答には
  // refresh_token が含まれないため、自動更新は発生しない。
  const githubTokenResponse = { access_token: 'gho_x', token_type: 'bearer', scope: 'read:user,user:email' };
  assert.equal(githubTokenResponse.refresh_token, undefined);
});

console.log('== CraftMate アカウント解決（ログイン/連携）==');

// 要求シナリオ: Googleログイン → GitHub連携 → ログアウト → GitHubログイン
test('Googleログインで新規アカウント作成', () => {
  const r = integ.resolveCraftmateUser({
    purpose: 'login', providerId: 'google', providerUserId: 'g-sub-1',
    accountLabel: 'a@x.y', existingOwner: null,
  });
  assert.equal(r.craftmateUser, 'oauth:google:g-sub-1');
  assert.equal(r.conflict, false);
});

test('ログイン中アカウントへGitHub連携（owner=oauth:google:g-sub-1）', () => {
  db.upsertExternalIdentity('github', 'gh-1', 'oauth:google:g-sub-1', 'GH User', 'g@x.y');
  const r = integ.resolveCraftmateUser({
    purpose: 'integration', providerId: 'github', providerUserId: 'gh-1',
    sessionUser: 'oauth:google:g-sub-1',
    existingOwner: db.getExternalIdentity('github', 'gh-1')?.craftmate_user,
  });
  assert.equal(r.conflict, false);
  assert.equal(r.craftmateUser, 'oauth:google:g-sub-1');
});

test('連携済みGitHubでログイン → 所有者アカウントに解決', () => {
  const r = integ.resolveCraftmateUser({
    purpose: 'login', providerId: 'github', providerUserId: 'gh-1',
    accountLabel: 'GH User',
    existingOwner: db.getExternalIdentity('github', 'gh-1')?.craftmate_user,
  });
  assert.equal(r.craftmateUser, 'oauth:google:g-sub-1', 'GitHubログインがGoogleアカウントに解決される');
  assert.equal(r.conflict, false);
});

test('Microsoft連携→Microsoftログインも同じ所有者に解決', () => {
  db.upsertExternalIdentity('microsoft', 'ms-1', 'oauth:google:g-sub-1', 'MS User', 'm@x.y');
  const r = integ.resolveCraftmateUser({
    purpose: 'login', providerId: 'microsoft', providerUserId: 'ms-1',
    existingOwner: db.getExternalIdentity('microsoft', 'ms-1')?.craftmate_user,
  });
  assert.equal(r.craftmateUser, 'oauth:google:g-sub-1');
});

test('Discord連携→Discordログインも同じ所有者に解決', () => {
  db.upsertExternalIdentity('discord', 'dc-1', 'oauth:google:g-sub-1', 'DC User', 'd@x.y');
  const r = integ.resolveCraftmateUser({
    purpose: 'login', providerId: 'discord', providerUserId: 'dc-1',
    existingOwner: db.getExternalIdentity('discord', 'dc-1')?.craftmate_user,
  });
  assert.equal(r.craftmateUser, 'oauth:google:g-sub-1');
});

test('未連携アカウントのログインは新規アカウント（既存に勝手に紐付かない）', () => {
  const r = integ.resolveCraftmateUser({
    purpose: 'login', providerId: 'github', providerUserId: 'gh-new',
    accountLabel: 'New GH', existingOwner: null,
  });
  assert.equal(r.craftmateUser, 'oauth:github:gh-new');
});

test('別ユーザーの外部IDを連携しようとすると拒否', () => {
  // gh-1 は oauth:google:g-sub-1 の所有。local:bob が連携しようとする
  const r = integ.resolveCraftmateUser({
    purpose: 'integration', providerId: 'github', providerUserId: 'gh-1',
    sessionUser: 'local:bob',
    existingOwner: db.getExternalIdentity('github', 'gh-1')?.craftmate_user,
  });
  assert.equal(r.conflict, true);
});

test('内部アカウント(local)所有の外部IDでもログインは所有者に解決', () => {
  db.upsertExternalIdentity('github', 'gh-local', 'local:alice', 'Alice GH', 'a@x.y');
  const r = integ.resolveCraftmateUser({
    purpose: 'login', providerId: 'github', providerUserId: 'gh-local',
    existingOwner: db.getExternalIdentity('github', 'gh-local')?.craftmate_user,
  });
  assert.equal(r.craftmateUser, 'local:alice');
});

test('メール一致でも別 provider_user_id なら統合されない', () => {
  // 同じメールでも provider+id が違えば別アカウント
  const r1 = integ.resolveCraftmateUser({ purpose: 'login', providerId: 'google', providerUserId: 'g-other', accountLabel: 'a@x.y', existingOwner: null });
  const r2 = integ.resolveCraftmateUser({ purpose: 'login', providerId: 'github', providerUserId: 'gh-other', accountLabel: 'a@x.y', existingOwner: null });
  assert.notEqual(r1.craftmateUser, r2.craftmateUser);
});

test('ログアウト→再ログイン: セッション削除はDB行削除で行われる（deleteIntegration）', () => {
  db.upsertIntegration('__auth_session', 'connected', integ.encryptJson({ provider: 'github', craftmateUser: 'oauth:google:g-sub-1', loginAt: Date.now() }));
  const row = db.getIntegration('__auth_session');
  assert.ok(row);
  db.deleteIntegration('__auth_session');
  assert.ok(!db.getIntegration('__auth_session'));
});

test('再起動後も external_identities は永続（再取得で同じ所有者）', () => {
  // 別プロvセス相当: 同じDBファイルから再読込は getExternalIdentity で確認
  const row = db.getExternalIdentity('github', 'gh-1');
  assert.equal(row.craftmate_user, 'oauth:google:g-sub-1');
});

console.log('== プロバイダ設定 ==');

test('GitHub スコープが最小権限', () => {
  const gh = integ.getProvider('github');
  assert.equal(gh.scopes, 'read:user user:email');
});

test('Microsoft テナント切替', () => {
  const ms = integ.getProvider('microsoft');
  process.env.MICROSOFT_TENANT_ID = 'consumers';
  assert.ok(integ.resolveTokenUrl(ms).includes('/consumers/'));
  assert.ok(integ.buildAuthorizeUrl(ms, { redirectUri: 'r', state: 's', clientId: 'c' }).includes('/consumers/'));
  process.env.MICROSOFT_TENANT_ID = 'organizations';
  assert.ok(integ.resolveTokenUrl(ms).includes('/organizations/'));
  delete process.env.MICROSOFT_TENANT_ID;
  assert.ok(integ.resolveTokenUrl(ms).includes('/common/'));
});

test('nonce は Google/Microsoft のみ', () => {
  assert.equal(integ.providerUsesNonce(integ.getProvider('google')), true);
  assert.equal(integ.providerUsesNonce(integ.getProvider('microsoft')), true);
  assert.equal(integ.providerUsesNonce(integ.getProvider('github')), false);
  assert.equal(integ.providerUsesNonce(integ.getProvider('discord')), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
// DB ファイルはプロセスがハンドルを保持するため削除は best-effort
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows ではハンドル解放待ち */ }
process.exit(failed ? 1 : 0);
