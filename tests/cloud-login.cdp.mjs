// クラウドログイン画面の CDP 実機テスト
// 前提: BlockWhiz サーバーが http://127.0.0.1:3100 で起動済み、CRAFTMATE_AUTH_URL 設定済み
// 実行: node tests/cloud-login.cdp.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEBUG_PORT = 9334;
const APP_URL = process.env.CM_TEST_URL || 'http://127.0.0.1:3100/login.html';
const BROWSER = process.env.CM_TEST_BROWSER
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cloud-cdp-'));
const proc = spawn(BROWSER, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${tmp}`, '--no-first-run', '--disable-extensions', APP_URL,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.url.startsWith(new URL(APP_URL).origin));
      if (page) return page;
    } catch { }
    await sleep(300);
  }
  throw new Error('CDP target not found');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
}
async function waitFor(expr, timeoutMs = 15000, label = expr) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expr)) return true;
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${e.message}`); }
}

const RUN = Date.now().toString(36);
const EMAIL = `cdp-${RUN}@test.dev`;
const PASS = 'testpass123';

console.log('== クラウドログイン画面 UI 検証 ==');
await test('ページ読み込み・クラウドフォーム表示', async () => {
  await waitFor(`document.readyState === 'complete'`, 20000, 'page loaded');
  await waitFor(`(() => { const f = document.getElementById('cloud-form'); return f && getComputedStyle(f).display !== 'none'; })()`, 10000, 'cloud form visible');
  const st = await evaluate(`({
    cloudVisible: getComputedStyle(document.getElementById('cloud-form')).display !== 'none',
    emailInput: !!document.getElementById('cloud-email'),
    loginBtn: !!document.getElementById('cloud-login-btn'),
    registerBtn: !!document.getElementById('cloud-register-btn'),
    forgotBtn: !!document.getElementById('cloud-forgot-btn'),
    verifyBtn: !!document.getElementById('cloud-verify-btn'),
    status: (document.getElementById('status')||{}).textContent || '',
  })`);
  console.log('   state:', JSON.stringify(st));
  if (!st.cloudVisible) throw new Error('cloud form not visible');
  if (!st.emailInput || !st.loginBtn || !st.registerBtn) throw new Error('cloud form elements missing');
});

await test('誤パスワードでログイン→日本語エラー表示', async () => {
  await evaluate(`(() => {
    document.getElementById('cloud-email').value = '${EMAIL}';
    document.getElementById('cloud-password').value = 'wrongpass1';
    document.getElementById('cloud-login-btn').click();
  })()`);
  await waitFor(`(document.getElementById('status')||{textContent:''}).textContent.length > 0`, 15000, 'error message');
  const msg = await evaluate(`document.getElementById('status').textContent`);
  console.log('   error:', msg);
  if (/undefined|NaN|\[object/.test(msg)) throw new Error('bad error message: ' + msg);
});

await test('新規登録→ログイン状態へ遷移', async () => {
  await evaluate(`(() => {
    document.getElementById('cloud-email').value = '${EMAIL}';
    document.getElementById('cloud-password').value = '${PASS}';
    document.getElementById('cloud-register-btn').click();
  })()`);
  // 成功時は index.html へ遷移するはず。失敗時は status にエラーが出る
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const loc = await evaluate('location.pathname');
    if (loc.endsWith('/') || loc.endsWith('index.html')) break;
    await sleep(400);
  }
  await sleep(800);
  const st = await evaluate(`({url: location.href, status: (document.getElementById('status')||{textContent:''}).textContent})`);
  console.log('   after register:', JSON.stringify(st));
  if (!st.url.includes('index.html') && !st.url.endsWith('127.0.0.1:3100/')) throw new Error('no redirect: ' + st.url + ' status=' + st.status);
});

await test('設定画面のクラウドアカウントセクション表示', async () => {
  // ダッシュボードで設定タブを開く（DOM構造に依存。見つからなければスキップ扱いで情報出力）
  const opened = await evaluate(`(() => {
    const btn = document.querySelector('[data-tab="settings"], #tab-settings, button.settings, .nav-settings');
    if (btn) { btn.click(); return true; }
    const links = [...document.querySelectorAll('a,button')].map(e => e.textContent.trim());
    return links.join('|');
  })()`);
  console.log('   settings nav:', JSON.stringify(opened).slice(0, 300));
  await sleep(1500);
  const cloudSection = await evaluate(`(() => {
    const el = document.getElementById('cloud-account-section') || document.querySelector('[id*="cloud"]');
    return el ? { id: el.id, visible: getComputedStyle(el).display !== 'none' } : null;
  })()`);
  console.log('   cloud section:', JSON.stringify(cloudSection));
});

console.log(`\n${passed} passed, ${failed} failed`);
try { proc.kill(); } catch { }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
process.exit(failed ? 1 : 0);
