// CraftMate Desktop (Electron wrapper for Linux/macOS)
// - Spawns the bundled Node server (payload/dist/index.js) using the
//   Electron binary itself in ELECTRON_RUN_AS_NODE mode (no separate
//   Node.js install required).
// - Waits for http://localhost:3000 to respond, then shows it in a
//   native window.
// - Kills the server process when the app quits.

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const DASHBOARD_URL = 'http://localhost:3000';
const SERVER_READY_TIMEOUT_MS = 90000;

let mainWindow = null;
let serverProc = null;
let quitting = false;

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

function startServer(payloadDir) {
  const entry = path.join(payloadDir, 'dist', 'index.js');
  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    CRAFTMATE_DESKTOP: '1',
  });
  serverProc = spawn(process.execPath, [entry], {
    cwd: payloadDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  serverProc.on('exit', (code, signal) => {
    if (!quitting) {
      console.error(`[CraftMate] server exited unexpectedly (code=${code}, signal=${signal})`);
    }
    serverProc = null;
  });
  return serverProc;
}

function probeDashboard(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get(DASHBOARD_URL, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode < 500);
      });
      req.on('error', () => {
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
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.on('render-process-gone', () => app.quit());
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function showError(message) {
  const win = createWindow();
  const html = `<!doctype html><html><body style="background:#0b0f14;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:520px;text-align:center"><h2 style="color:#f87171">CraftMate server failed to start</h2><pre style="white-space:pre-wrap;color:#a1a1aa;font-size:12px">${message.replace(/</g, '&lt;')}</pre><p>サーバーログは stderr / CraftMate_server.log を確認してください。</p></div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

async function boot() {
  const payloadDir = resolvePayloadDir();
  console.log('[CraftMate] payload dir:', payloadDir);

  // If something already serves the dashboard (e.g. previous instance), reuse it.
  if (await probeDashboard(1500)) {
    console.log('[CraftMate] dashboard already reachable, attaching window only');
    createWindow().loadURL(DASHBOARD_URL);
    return;
  }

  const win = createWindow();
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="background:#0b0f14;color:#e4e4e7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>CraftMate</h2><p>Starting server…</p></div></body></html>'));

  startServer(payloadDir);

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeDashboard(1500)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(DASHBOARD_URL);
      }
      return;
    }
    if (!serverProc) break; // server died
    await new Promise(r => setTimeout(r, 500));
  }
  showError('Timed out waiting for http://localhost:3000.\nThe server process may have crashed — see logs.');
}

function killServer() {
  if (!serverProc) return;
  const proc = serverProc;
  serverProc = null;
  try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
  setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }, 3000).unref();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    quitting = true;
    killServer();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    killServer();
  });

  app.on('will-quit', killServer);
}
