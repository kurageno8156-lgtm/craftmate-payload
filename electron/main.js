// CraftMate Desktop (Electron wrapper for Linux/macOS)
// - Spawns the bundled Node server (payload/dist/index.js) using the
//   Electron binary itself in ELECTRON_RUN_AS_NODE mode (no separate
//   Node.js install required).
// - Waits for http://localhost:3000 to respond, then shows it in a
//   native window.
// - Kills the server process when the app quits.

const { app, BrowserWindow, ipcMain, shell, net: electronNet } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Linux/WSL 等で GPU/Vulkan 初期化が SIGSEGV を起こすケースがあるため、
// Linux ではハードウェアアクセラレーションを完全に無効化する。
// (app ready 前に呼ぶ必要がある)
if (process.platform === 'linux') {
  try {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.disableHardwareAcceleration();
  } catch (_) { /* ignore */ }
}

// 127.0.0.1 を明示使用: WSL等で localhost が ::1 (IPv6) に解決されて
// IPv4 のみで listen しているサーバーに届かない問題を回避する。
const DASHBOARD_URL = 'http://127.0.0.1:3000';
const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_PORT = 3000;
const SERVER_READY_TIMEOUT_MS = 120000;

let mainWindow = null;
let serverProc = null;
let quitting = false;
let payloadDirGlobal = null;

// 診断ログ: パッケージ版では console 出力が見えないため
// %TEMP%\CraftMate_server.log にも記録する（サーバー側と同じファイル）
function diagLog(message) {
  try {
    const logPath = path.join(require('os').tmpdir(), 'CraftMate_server.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [main] ${message}\n`);
  } catch (_) { /* ignore */ }
}

// ---------- Linux デスクトップ登録（.desktop + アイコン） ----------
// AppImage はシステムに登録されないため、ユーザー領域
// (~/.local/share/applications, ~/.local/share/icons) に登録する。
// deb は electron-builder が /usr/share/applications に配置済みだが、
// ユーザー側の登録で上書きしても害はない（Exec は実行中バイナリを指す）。
function installDesktopEntry() {
  if (process.platform !== 'linux') {
    return { ok: false, error: 'not-linux' };
  }
  try {
    const home = os.homedir();
    const appsDir = path.join(home, '.local', 'share', 'applications');
    const iconDir = path.join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps');
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });

    // AppImage 実行時は APPIMAGE 環境変数に実ファイルのパスが入る。
    // deb/開発時は process.execPath（実バイナリ）を使う。
    const execPath = process.env.APPIMAGE || process.execPath;
    const desktopPath = path.join(appsDir, 'craftmate.desktop');
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=BlockWhiz',
      'Comment=Minecraft AI autonomous agent',
      `Exec="${execPath}" %U`,
      'Icon=craftmate',
      'Terminal=false',
      'Categories=Utility;Game;',
      'StartupNotify=true',
      '',
    ].join('\n');
    fs.writeFileSync(desktopPath, desktop);

    // アイコンを hicolor テーマに配置（Electron の fs は asar 内も読める）
    let iconInstalled = false;
    try {
      fs.copyFileSync(path.join(__dirname, 'icon.png'), path.join(iconDir, 'craftmate.png'));
      iconInstalled = true;
    } catch (_) { /* アイコン失敗は無視 */ }

    // デスクトップデータベース / アイコンキャッシュの更新（ベストエフォート）
    try { execFile('update-desktop-database', [appsDir], () => { }); } catch (_) { }
    try {
      execFile('gtk-update-icon-cache', ['-f', '-t', path.join(home, '.local', 'share', 'icons', 'hicolor')], () => { });
    } catch (_) { }

    return { ok: true, desktopPath, execPath, iconInstalled };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function desktopEntryStatus() {
  if (process.platform !== 'linux') return { installed: false, reason: 'not-linux' };
  const desktopPath = path.join(os.homedir(), '.local', 'share', 'applications', 'craftmate.desktop');
  let content = '';
  try { content = fs.readFileSync(desktopPath, 'utf8'); } catch (_) { }
  return {
    installed: /CraftMate|BlockWhiz/.test(content),
    desktopPath,
    execLine: (content.match(/^Exec=(.*)$/m) || [])[1] || '',
  };
}

// ---------- 旧プロセス掃除 ----------
// ポート3000を掴んでいる「CraftMate 系」プロセスを特定して終了する。
// ダッシュボードが応答しない（wedged）場合の起動前クリーンアップ用。
function port3000ListenerPids() {
  return new Promise((resolve) => {
    execFile('ss', ['-ltnp'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const pids = new Set();
      for (const line of String(stdout).split('\n')) {
        if (!line.includes(':3000')) continue;
        const matches = line.match(/pid=(\d+)/g) || [];
        for (const m of matches) pids.add(parseInt(m.slice(4), 10));
      }
      resolve([...pids].filter(n => n > 0));
    });
  });
}

function procCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch (_) { return ''; }
}

async function sweepPort3000() {
  if (process.platform === 'win32') return;
  try {
    const pids = await port3000ListenerPids();
    for (const pid of pids) {
      const cmd = procCmdline(pid);
      // CraftMate のサーバーらしきプロセスのみ対象（他アプリは殺さない）
      const isOurs = cmd.includes('craftmate') || cmd.includes('dist/index.js') ||
        (payloadDirGlobal && cmd.includes(payloadDirGlobal));
      if (!isOurs) continue;
      console.log(`[CraftMate] killing stale server on :3000 pid=${pid} cmd=${cmd.slice(0, 120)}`);
      try { process.kill(pid, 'SIGTERM'); } catch (_) { }
    }
    // SIGTERM 後に残ったものを SIGKILL
    await new Promise(r => setTimeout(r, 1200));
    for (const pid of await port3000ListenerPids()) {
      const cmd = procCmdline(pid);
      const isOurs = cmd.includes('craftmate') || cmd.includes('dist/index.js') ||
        (payloadDirGlobal && cmd.includes(payloadDirGlobal));
      if (!isOurs) continue;
      try { process.kill(pid, 'SIGKILL'); } catch (_) { }
    }
  } catch (e) {
    console.warn('[CraftMate] sweepPort3000 failed:', e && e.message);
  }
}

// payload ディレクトリを指す node/craftmate-node の残存プロセスを掃除
function sweepPayloadProcesses() {
  if (process.platform === 'win32' || !payloadDirGlobal) return;
  execFile('pkill', ['-TERM', '-f', payloadDirGlobal], () => { });
  setTimeout(() => {
    execFile('pkill', ['-KILL', '-f', payloadDirGlobal], () => { });
  }, 3000).unref();
}

// ---------- AppImage アプリ内アップデート ----------
// AppImage は実行中のファイルを上書きできないため、
// 新バージョンを `<AppImage>.new` にダウンロードし、
// 脱出シェルスクリプトがこのプロセスの終了を待ってから
// 置き換えて再起動する方式を取る。
function sendUpdateProgress(phase, percent, extra) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('craftmate:update-progress',
        Object.assign({ phase, percent }, extra || {}));
    }
  } catch (_) { /* ignore */ }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function downloadToFile(url, destPath, onProgress) {
  const res = await electronNet.fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error('download failed: HTTP ' + res.status);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(destPath);
  const reader = res.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      received += value.length;
      if (onProgress && total > 0) onProgress(received / total);
    }
  } finally {
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  }
  return received;
}

async function applyAppImageUpdate(opts) {
  if (process.platform !== 'linux') return { ok: false, error: 'このプラットフォームではアプリ内更新を利用できません。' };
  // AppImage 実行時は APPIMAGE 環境変数に実ファイルのパスが入る。
  // フォールバックとして APPDIR（実行中のマウントポイント）からは
  // 本体パスを復元できないため、APPIMAGE 必須とする。
  const appImage = process.env.APPIMAGE;
  if (!appImage) return { ok: false, error: 'AppImage 形式でのみ自動更新できます。deb / tarball 版は最新の AppImage を手動でダウンロードしてください。' };
  const downloadUrl = opts && opts.downloadUrl;
  if (!downloadUrl) return { ok: false, error: 'ダウンロードURLが取得できませんでした。' };

  const target = appImage;
  const staging = target + '.new';
  const scriptPath = path.join(os.tmpdir(), 'craftmate-update-' + process.pid + '.sh');
  sendUpdateProgress('download', 0);
  try {
    await downloadToFile(downloadUrl, staging, (ratio) => {
      sendUpdateProgress('download', Math.round(ratio * 100));
    });

    // SHA256 検証: リリースに `<asset>.sha256` があれば必ず照合する。
    // 無い場合は警告ログのみで続行（旧リリース互換）。
    const shaUrl = downloadUrl.replace(/([^/?#]+)(\?[^#]*)?$/, '$1.sha256$2');
    try {
      const shaRes = await electronNet.fetch(shaUrl, { redirect: 'follow' });
      if (shaRes.ok) {
        const text = await shaRes.text();
        const expected = (String(text).match(/[0-9a-fA-F]{64}/) || [''])[0].toLowerCase();
        if (expected) {
          sendUpdateProgress('verify', 0);
          const actual = await sha256File(staging);
          if (actual !== expected) {
            try { fs.unlinkSync(staging); } catch (_) { }
            return { ok: false, error: 'ダウンロードしたファイルのハッシュ検証に失敗しました（破損または改ざんの可能性）。更新を中止しました。' };
          }
        }
      }
    } catch (e) {
      console.warn('[CraftMate] sha256 check skipped:', e && e.message);
    }

    fs.chmodSync(staging, 0o755);
    sendUpdateProgress('replace', 0);

    // このプロセスが終了するまで待ってから .new を本体に置き換えて再起動する。
    const script = [
      '#!/bin/sh',
      '# CraftMate AppImage updater: wait for app exit, then replace and relaunch',
      'TARGET="' + target.replace(/"/g, '\\"') + '"',
      'STAGING="' + staging.replace(/"/g, '\\"') + '"',
      'SELF="' + scriptPath.replace(/"/g, '\\"') + '"',
      'for i in $(seq 1 240); do',
      '  kill -0 ' + process.pid + ' 2>/dev/null || break',
      '  sleep 0.5',
      'done',
      'sleep 1',
      'mv -f "$STAGING" "$TARGET" && chmod +x "$TARGET"',
      'nohup "$TARGET" >/dev/null 2>&1 &',
      'rm -f "$SELF"',
      '',
    ].join('\n');
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    const helper = spawn('sh', [scriptPath], { detached: true, stdio: 'ignore' });
    helper.unref();

    // 少し待ってから終了（IPC応答を返すため）
    setTimeout(() => { app.exit(0); }, 800);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(staging); } catch (_) { }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function registerUpdateIpc() {
  ipcMain.handle('craftmate:update:apply', (_event, opts) => applyAppImageUpdate(opts));
}

// ---------- GUI インストーラー（--install / --uninstall） ----------
function registerInstallerIpc() {
  ipcMain.handle('craftmate:status', () => desktopEntryStatus());
  ipcMain.handle('craftmate:install', () => installDesktopEntry());
  ipcMain.handle('craftmate:launch', () => {
    const result = installDesktopEntry();
    if (result.ok) {
      setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
    }
    return result;
  });
}

function showInstaller() {
  registerInstallerIpc();
  const win = createWindow();
  win.setSize(560, 480);
  win.setResizable(false);
  win.loadFile(path.join(__dirname, 'installer.html'));
}

function resolvePayloadDir() {
  // Packaged: resources/payload (via electron-builder extraResources)
  const packaged = path.join(process.resourcesPath || '', 'payload');
  if (fs.existsSync(path.join(packaged, 'dist', 'index.js'))) return packaged;
  // Dev / unpacked: <repo>/craftmate-payload produced by build-release.sh
  const repoPayload = path.join(__dirname, '..', 'craftmate-payload');
  if (fs.existsSync(path.join(repoPayload, 'dist', 'index.js'))) return repoPayload;
  // Fallback: any craftmate-* staging dir
  const parent = path.join(__dirname, '..');
  try {
    for (const entry of fs.readdirSync(parent)) {
      const candidate = path.join(parent, entry);
      if (entry.startsWith('craftmate-') && fs.existsSync(path.join(candidate, 'dist', 'index.js'))) {
        return candidate;
      }
    }
  } catch (_) { /* ignore */ }
  return packaged;
}

let lastServerExit = null; // { code, signal }
let retryingWithSqlJs = false;
let serverExtraEnv = {};   // 追加で子プロセスへ渡す環境変数

function startServer(payloadDir) {
  diagLog(`startServer payloadDir=${payloadDir}`);
  const entry = path.join(payloadDir, 'dist', 'index.js');
  // 同梱の Node.js バイナリを優先使用する。
  // ELECTRON_RUN_AS_NODE で Electron を Node として使うと、
  // better-sqlite3 等のネイティブモジュールが ABI 不一致で SIGSEGV するため。
  // Windows では craftmate-node.exe、POSIX では craftmate-node として同梱される。
  const bundledNode = process.platform === 'win32'
    ? path.join(payloadDir, 'craftmate-node.exe')
    : path.join(payloadDir, 'craftmate-node');
  const useBundled = fs.existsSync(bundledNode);
  const execPath = useBundled ? bundledNode : process.execPath;

  // Electron 固有の環境変数を除去してから spawn する。
  // 特に LD_LIBRARY_PATH / LD_PRELOAD は Electron 同梱のライブラリを
  // 指し、子プロセス（craftmate-node + better-sqlite3）のロードを壊して
  // SIGSEGV を起こす原因になる（WSL 等で顕著）。
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LD_PRELOAD;
  delete env.LD_LIBRARY_PATH;
  delete env.LD_AUDIT;
  // Electron が内部で使うパスも念のため除去（通常は未設定）
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.CHROME_DESKTOP;
  delete env.GIO_LAUNCHED_DESKTOP_FILE_PID;
  Object.assign(env, serverExtraEnv);
  env.CRAFTMATE_DESKTOP = '1';
  if (!useBundled) env.ELECTRON_RUN_AS_NODE = '1';

  // デバッグ: spawn 直前の環境を記録（原因切り分け用）
  console.log('[CraftMate] spawn:', execPath);
  console.log('[CraftMate] env: LD_LIBRARY_PATH=' + (env.LD_LIBRARY_PATH ?? '(unset)') +
    ' LD_PRELOAD=' + (env.LD_PRELOAD ?? '(unset)') +
    ' ELECTRON_RUN_AS_NODE=' + (env.ELECTRON_RUN_AS_NODE ?? '(unset)') +
    ' bundledNode=' + useBundled);
  try {
    const logPath = path.join(require('os').tmpdir(), 'CraftMate_server.log');
    fs.appendFileSync(logPath,
      `[${new Date().toISOString()}] spawn ${execPath} bundled=${useBundled} ` +
      `LD_LIBRARY_PATH=${env.LD_LIBRARY_PATH ?? 'unset'} LD_PRELOAD=${env.LD_PRELOAD ?? 'unset'}\n`);
  } catch (_) { /* ignore */ }

  serverProc = spawn(execPath, [entry], {
    cwd: payloadDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Linux/WSL では detached でプロセスグループを分離し、
    // 終了時にグループ全体へシグナルを送れるようにする。
    detached: process.platform !== 'win32',
  });
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  // パッケージ版では stderr が失われるため、末尾2KBを保持して終了時にログへ出す
  let stderrTail = '';
  serverProc.stderr.on('data', d => {
    process.stderr.write('[server] ' + d);
    stderrTail = (stderrTail + d.toString()).slice(-2048);
  });
  serverProc.on('error', (err) => {
    diagLog(`spawn error: ${err && err.message}`);
  });
  serverProc.on('exit', (code, signal) => {
    lastServerExit = { code, signal };
    serverProc = null;
    diagLog(`server exited code=${code} signal=${signal} stderrTail=${JSON.stringify(stderrTail)}`);
    const crashSignal = signal === 'SIGSEGV' || signal === 'SIGABRT' || signal === 'SIGILL' || signal === 'SIGTRAP';
    if (!quitting && crashSignal && !serverExtraEnv.CRAFTMATE_USE_SQLJS) {
      // ネイティブモジュールのクラッシュ（WSL等）→ sql.js 互換モードで自動再起動
      retryingWithSqlJs = true;
      console.log(`[CraftMate] server crashed (${signal}); retrying with CRAFTMATE_USE_SQLJS=1 compatibility mode`);
      try {
        const logPath = path.join(require('os').tmpdir(), 'CraftMate_server.log');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] native crash (${signal}) -> retry with sql.js mode\n`);
      } catch (_) { /* ignore */ }
      showInfoScreen('ネイティブモジュールがクラッシュしたため、互換モード（sql.js）で再起動しています…');
      try {
        serverExtraEnv.CRAFTMATE_USE_SQLJS = '1';
        startServer(payloadDir);
      } catch (e) {
        console.error('[CraftMate] sql.js retry failed:', e);
      }
      return;
    }
    if (!quitting) {
      retryingWithSqlJs = false;
      console.error(`[CraftMate] server exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });
  return serverProc;
}

function tcpProbe(timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: DASHBOARD_HOST, port: DASHBOARD_PORT, timeout: timeoutMs }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function probeDashboard(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get(DASHBOARD_URL, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode < 500);
      });
      req.on('error', async () => {
        // HTTPが失敗してもTCPでポートが開いていればサーバーは生きている
        // (WSL等でHTTP GETだけが詰まるケースへのフォールバック)
        if (await tcpProbe(1500)) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 700);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'BlockWhiz',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.removeMenu();
  // window.open（OAuth認証ページ等）はアプリ内ウィンドウを増やさず
  // システムブラウザで開く。ポップアップ自体は拒否する。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => { });
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('render-process-gone', () => app.quit());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// スプラッシュ/情報/エラー画面は既存ウィンドウを再利用する。
// 新規ウィンドウを作ると「Starting server...」が残ってしまうため。
function reuseOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return createWindow();
}

function showInfoScreen(message) {
  const win = reuseOrCreateWindow();
  const html = `<!doctype html><html><body style="background:#0b0f14;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:520px;text-align:center"><h2 style="color:#fbbf24">BlockWhiz</h2><p>${message.replace(/</g, '&lt;')}</p></div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function showTimeoutScreen() {
  const win = reuseOrCreateWindow();
  const html = `<!doctype html><html><body style="background:#0b0f14;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:520px;text-align:center"><h2 style="color:#fbbf24">BlockWhiz</h2><p>サーバーは起動していますが、ダッシュボードへの応答が確認できませんでした。</p><p style="color:#a1a1aa;font-size:13px">ブラウザで <b>http://127.0.0.1:3000</b> を直接開くか、下のボタンで再読み込みしてください。</p><button onclick="location.reload()" style="margin-top:12px;padding:10px 24px;font-size:15px;border:none;border-radius:8px;background:#22c55e;color:#fff;cursor:pointer">再読み込み</button></div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function showError(message) {
  const win = reuseOrCreateWindow();
  const html = `<!doctype html><html><body style="background:#0b0f14;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:520px;text-align:center"><h2 style="color:#f87171">BlockWhiz server failed to start</h2><pre style="white-space:pre-wrap;color:#a1a1aa;font-size:12px">${message.replace(/</g, '&lt;')}</pre><p>サーバーログは stderr / CraftMate_server.log を確認してください。</p></div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

async function boot() {
  diagLog('boot() start');
  const payloadDir = resolvePayloadDir();
  payloadDirGlobal = payloadDir;
  diagLog(`payload dir: ${payloadDir}`);
  console.log('[CraftMate] payload dir:', payloadDir);

  // AppImage の場合はアプリケーションメニューへ自動登録（冪等・軽量）
  if (process.platform === 'linux' && process.env.APPIMAGE && app.isPackaged) {
    const reg = installDesktopEntry();
    console.log('[CraftMate] desktop entry:', JSON.stringify(reg));
  }

  // 起動速度改善: ウィンドウ（ローディング画面）を最初に表示し、
  // その後でポート確認・サーバー起動を行う。ユーザーは即座に
  // ウィンドウを得られ、サーバー起動はバックグラウンドで進む。
  const win = createWindow();
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="background:#0b0f14;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>BlockWhiz</h2><p>Starting server…</p></div></body></html>'));

  // If something already serves the dashboard (e.g. previous instance), reuse it.
  const alreadyUp = await probeDashboard(1500);
  diagLog(`probeDashboard(pre-start) => ${alreadyUp}`);
  if (alreadyUp) {
    console.log('[CraftMate] dashboard already reachable, attaching window only');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(DASHBOARD_URL);
    return;
  }

  // ポート3000を掴む古い CraftMate サーバーが残っていれば掃除してから起動
  await sweepPort3000();

  startServer(payloadDir);

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeDashboard(1500)) {
      diagLog('dashboard ready');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(DASHBOARD_URL);
      }
      return;
    }
    if (!serverProc && !retryingWithSqlJs) { diagLog('server died during startup wait'); break; } // server died
    await new Promise(r => setTimeout(r, 500));
  }
  // TCPプローブで最終確認: HTTPが詰まっていてもポートが開いていれば
  // ダッシュボードURLをそのまま開く（ブラウザ側の再試行に任せる）
  const tcpOk = await tcpProbe(2000);
  diagLog(`tcpProbe(final) => ${tcpOk} serverProc=${!!serverProc}`);
  if (tcpOk) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(DASHBOARD_URL);
    }
    return;
  }
  if (!serverProc) {
    const sig = lastServerExit && lastServerExit.signal;
    if (sig === 'SIGSEGV' || sig === 'SIGABRT' || sig === 'SIGILL') {
      showError('The server crashed during startup (signal=' + sig + ').\n\n' +
        'This usually means a native module (e.g. better-sqlite3) failed to load.\n' +
        'DBの初期化に失敗しました。最新版を再ダウンロードするか、\n' +
        'ポータブル版 craftmate-linux-*.tar.gz をお試しください。');
    } else {
      showError('The server process exited before the dashboard became ready.\n' +
        'code=' + (lastServerExit && lastServerExit.code) + ' signal=' + sig);
    }
  } else {
    showTimeoutScreen();
  }
}

function killServer() {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  const isPosix = process.platform !== 'win32';
  try {
    if (isPosix && proc.pid) {
      // detached spawn で作ったプロセスグループごと終了させる。
      // WSL等で SIGTERM が子に届かないケースに備え、負のPIDでグループ送信。
      process.kill(-proc.pid, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch (_) {
    try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
  setTimeout(() => {
    try {
      if (isPosix && proc.pid) process.kill(-proc.pid, 'SIGKILL');
      else if (!proc.killed) proc.kill('SIGKILL');
    } catch (_) { /* ignore */ }
  }, 3000).unref();
}

const gotLock = app.requestSingleInstanceLock();
diagLog(`requestSingleInstanceLock => ${gotLock}`);
const installerMode = process.argv.includes('--install') || process.argv.includes('--uninstall');
if (!gotLock) {
  diagLog('no single-instance lock; quitting (another instance assumed running)');
  app.quit();
} else {
  app.on('second-instance', () => {
    diagLog('second-instance event');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerUpdateIpc();
    if (installerMode) showInstaller();
    else boot();
  });

  app.on('window-all-closed', () => {
    quitting = true;
    killServer();
    sweepPayloadProcesses();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    killServer();
    sweepPayloadProcesses();
  });

  app.on('will-quit', () => {
    killServer();
    sweepPayloadProcesses();
  });
}
