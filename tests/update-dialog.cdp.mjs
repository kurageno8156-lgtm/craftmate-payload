// アップデート確認ダイアログの CDP 実機テスト
// 前提: CraftMate サーバーが http://127.0.0.1:3000 で起動済み、ログイン済みセッションあり
// 実行: node tests/update-dialog.cdp.mjs
// Edge/Chrome をヘッドレスで起動し、実際の app.js を動かしてダイアログを検証する。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEBUG_PORT = 9333;
const APP_URL = process.env.CM_TEST_URL || 'http://127.0.0.1:3100/';
const BROWSER = process.env.CM_TEST_BROWSER
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cdp-'));
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
const dialogState = `(() => {
  const d = document.getElementById('update-dialog');
  return {
    hidden: d ? d.hidden : null,
    body: (document.getElementById('update-dialog-body')||{}).textContent || '',
    actions: [...(document.getElementById('update-dialog-actions')||{querySelectorAll:()=>[]}).querySelectorAll('button')].map(b => b.textContent),
    btnDisabled: (document.getElementById('btn-check-updates')||{}).disabled,
  };
})()`;

console.log('== 表示テスト（実サーバー・実GitHub応答）==');
await test('ページ読み込み・認証済み', async () => {
  await waitFor(`!!document.getElementById('btn-check-updates') && document.readyState === 'complete'`, 20000, 'dashboard loaded');
});
await test('ボタン押下→確認中→最新版ダイアログ', async () => {
  await evaluate(`document.getElementById('btn-check-updates').click()`);
  await waitFor(`!document.getElementById('update-dialog').hidden`, 5000, 'dialog opens');
  await waitFor(`document.getElementById('update-dialog-body').textContent.includes('確認') || document.getElementById('update-dialog-body').textContent.includes('Checking')`, 3000, 'checking text').catch(() => { });
  await waitFor(`document.getElementById('update-dialog-actions').querySelectorAll('button').length > 0`, 20000, 'result rendered');
  const st = await evaluate(dialogState);
  console.log('   state:', JSON.stringify(st));
  if (!st.body.includes('最新バージョン') && !st.body.includes('latest version')) throw new Error('up-to-date message missing: ' + st.body);
  if (!/v\d+\.\d+\.\d+/.test(st.body)) throw new Error('version missing: ' + st.body);
  if (st.actions.length !== 1) throw new Error('expected 1 button (close), got ' + st.actions.join(','));
});

console.log('== モック: 更新あり ==');
await test('新バージョン案内 + 2ボタン', async () => {
  await evaluate(`(() => {
    window.__origFetch = window.fetch;
    window.fetch = (url, opts) => String(url).includes('/api/version/check')
      ? Promise.resolve(new Response(JSON.stringify({currentVersion:'1.5.0',latestVersion:'9.9.9',updateAvailable:true,platform:'win32',arch:'x64',assetName:'CraftMate_Setup.exe',downloadUrl:'https://example.com/x',releaseUrl:'https://example.com/r',canAutoUpdate:true}), {status:200, headers:{'Content-Type':'application/json'}}))
      : window.__origFetch(url, opts);
    document.getElementById('btn-check-updates').click();
  })()`);
  await waitFor(`document.getElementById('update-dialog-actions').querySelectorAll('button').length === 2`, 15000, 'two buttons');
  const st = await evaluate(dialogState);
  console.log('   state:', JSON.stringify(st));
  if (!st.body.includes('9.9.9')) throw new Error('new version missing');
  if (!st.body.includes('利用可能') && !st.body.includes('available')) throw new Error('available msg missing');
});

console.log('== モック: エラー ==');
await test('エラーメッセージ + 再試行/閉じる', async () => {
  await evaluate(`(() => {
    window.fetch = () => Promise.reject(new Error('network down'));
    document.getElementById('btn-check-updates').click();
  })()`);
  await waitFor(`document.getElementById('update-dialog-actions').querySelectorAll('button').length === 2`, 15000, 'retry+close');
  const st = await evaluate(dialogState);
  console.log('   state:', JSON.stringify(st));
  if (!st.body.includes('確認できませんでした') && !st.body.includes('Could not check')) throw new Error('error msg missing: ' + st.body);
  if (!st.actions.some(a => a.includes('再試行') || a.includes('Retry'))) throw new Error('retry button missing: ' + st.actions);
});

console.log('== モック: 今すぐアップデート（launch-updater をスタブ）==');
await test('適用中はダイアログが閉じない・成功で閉じる', async () => {
  await evaluate(`(() => {
    // fetch を戻し、version/check は更新あり、launch-updater は成功を返す
    window.fetch = window.__origFetch;
    const orig = window.fetch;
    window.fetch = (url, opts) => String(url).includes('/api/version/check')
      ? Promise.resolve(new Response(JSON.stringify({currentVersion:'1.5.0',latestVersion:'9.9.9',updateAvailable:true,platform:'win32',arch:'x64',assetName:'x',downloadUrl:null,releaseUrl:'https://example.com/r',canAutoUpdate:true}), {status:200, headers:{'Content-Type':'application/json'}}))
      : orig(url, opts);
    window.__launcherCalls = 0;
    window.fetchWithLocalSettingsAuth = (url, opts) => {
      if (String(url).includes('launch-updater')) { window.__launcherCalls++; return Promise.resolve(new Response(JSON.stringify({success:true}), {status:202, headers:{'Content-Type':'application/json'}})); }
      return orig(url, opts);
    };
    document.getElementById('btn-check-updates').click();
  })()`);
  await waitFor(`document.getElementById('update-dialog-actions').querySelectorAll('button').length === 2`, 15000, 'update buttons');
  await evaluate(`[...document.querySelectorAll('#update-dialog-actions button')].find(b => b.classList.contains('update-dialog-primary')).click()`);
  await sleep(500);
  const during = await evaluate(`({hidden: document.getElementById('update-dialog').hidden, calls: window.__launcherCalls})`);
  console.log('   during:', JSON.stringify(during));
  if (during.calls !== 1) throw new Error('launch-updater not called exactly once: ' + during.calls);
  await waitFor(`document.getElementById('update-dialog').hidden === true`, 10000, 'dialog closes after apply');
});

console.log('== モック: 適用中はダイアログを閉じられない ==');
await test('更新実行中のクローズ抑止→完了後に閉じる', async () => {
  await evaluate(`(() => {
    window.fetch = (url, opts) => String(url).includes('/api/version/check')
      ? Promise.resolve(new Response(JSON.stringify({currentVersion:'1.5.0',latestVersion:'9.9.9',updateAvailable:true,platform:'win32',arch:'x64',downloadUrl:null,releaseUrl:'https://example.com/r',canAutoUpdate:true}), {status:200, headers:{'Content-Type':'application/json'}}))
      : window.__origFetch(url, opts);
    window.__releaseUpdate = null;
    window.fetchWithLocalSettingsAuth = () => new Promise((res) => { window.__releaseUpdate = () => res(new Response(JSON.stringify({success:true}), {status:202, headers:{'Content-Type':'application/json'}})); });
    document.getElementById('btn-check-updates').click();
  })()`);
  await waitFor(`document.getElementById('update-dialog-actions').querySelectorAll('button').length === 2`, 15000, 'update buttons');
  await evaluate(`[...document.querySelectorAll('#update-dialog-actions button')].find(b => b.classList.contains('update-dialog-primary')).click()`);
  await sleep(400);
  // 適用中: ×ボタン・背景クリック・Esc相当のクローズを試みる
  await evaluate(`document.querySelector('#update-dialog .inventory-modal-close').click()`);
  await evaluate(`document.querySelector('#update-dialog [data-close-update-dialog]').click()`);
  await sleep(300);
  const locked = await evaluate(`({hidden: document.getElementById('update-dialog').hidden, disabled: [...document.querySelectorAll('#update-dialog-actions button')].every(b => b.disabled)})`);
  console.log('   locked:', JSON.stringify(locked));
  if (locked.hidden) throw new Error('dialog closed while update in progress');
  if (!locked.disabled) throw new Error('buttons not disabled during apply');
  await evaluate(`window.__releaseUpdate()`);
  await waitFor(`document.getElementById('update-dialog').hidden === true`, 10000, 'dialog closes after apply completes');
});

console.log('== モック: 「後で」で閉じる ==');
await test('後で→更新せず閉じる', async () => {
  await evaluate(`(() => {
    window.fetch = (url, opts) => String(url).includes('/api/version/check')
      ? Promise.resolve(new Response(JSON.stringify({currentVersion:'1.5.0',latestVersion:'9.9.9',updateAvailable:true,platform:'win32',arch:'x64',downloadUrl:null,releaseUrl:'https://example.com/r',canAutoUpdate:true}), {status:200, headers:{'Content-Type':'application/json'}}))
      : window.__origFetch(url, opts);
    window.__launcherCalls = 0;
    document.getElementById('btn-check-updates').click();
  })()`);
  await waitFor(`document.getElementById('update-dialog-actions').querySelectorAll('button').length === 2`, 15000, 'buttons');
  await evaluate(`[...document.querySelectorAll('#update-dialog-actions button')].find(b => !b.classList.contains('update-dialog-primary')).click()`);
  await sleep(300);
  const st = await evaluate(`({hidden: document.getElementById('update-dialog').hidden, calls: window.__launcherCalls || 0})`);
  if (!st.hidden) throw new Error('dialog did not close');
  if (st.calls !== 0) throw new Error('updater was launched on "later"');
});

console.log('== 連打防止 ==');
await test('ボタン連打で重複チェックされない', async () => {
  await evaluate(`(() => {
    window.__checkCalls = 0;
    const orig = window.__origFetch;
    window.fetch = (url, opts) => { if (String(url).includes('/api/version/check')) window.__checkCalls++; return orig(url, opts); };
    const btn = document.getElementById('btn-check-updates');
    btn.click(); btn.click(); btn.click();
  })()`);
  await sleep(1000);
  const calls = await evaluate(`window.__checkCalls`);
  console.log('   check calls:', calls);
  if (calls !== 1) throw new Error(`expected 1 check, got ${calls}`);
  await evaluate(`document.querySelector('[data-close-update-dialog]').click()`);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { proc.kill(); } catch { }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
process.exit(failed ? 1 : 0);
