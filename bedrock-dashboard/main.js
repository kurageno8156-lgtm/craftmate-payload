// BlockWhiz Bedrock - independent Electron dashboard for Minecraft Bedrock
// Dedicated Server (BDS). Separate app identity, userData, port and
// single-instance lock from the Java edition BlockWhiz app.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'BlockWhiz Bedrock';
const DASHBOARD_PORT = 3001; // Java版(3000)と衝突しない独立ポート
const BDS_DIR = process.env.BDS_DIR || path.join(os.homedir(), '.blockwhiz-bedrock', 'bds');

let mainWindow = null;
let bdsProc = null;

// 独立した設定保存領域（Java版の %APPDATA%/CraftMate とは別）
app.setName(APP_NAME);
app.setPath('userData', path.join(os.homedir(), '.blockwhiz-bedrock'));

function diagLog(msg) {
  try {
    const p = path.join(os.tmpdir(), 'BlockWhizBedrock_server.log');
    fs.appendFileSync(p, `[${new Date().toISOString()}] [bedrock-main] ${msg}\n`);
  } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// BDS プロセス管理（bedrock_server.exe の起動/停止/状態取得）
function bdsExe() {
  return path.join(BDS_DIR, 'bedrock_server.exe');
}

function startBds() {
  if (bdsProc) return { ok: false, error: 'already running' };
  const exe = bdsExe();
  if (!fs.existsSync(exe)) return { ok: false, error: `BDS not found at ${exe}. Set BDS_DIR or install Bedrock Dedicated Server.` };
  bdsProc = require('child_process').spawn(exe, [], {
    cwd: BDS_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  bdsProc.stdout.on('data', d => diagLog('bds-out ' + d.toString().slice(0, 200)));
  bdsProc.stderr.on('data', d => diagLog('bds-err ' + d.toString().slice(0, 200)));
  bdsProc.on('exit', (code) => { diagLog(`bds exited code=${code}`); bdsProc = null; });
  return { ok: true, pid: bdsProc.pid };
}

function stopBds() {
  if (!bdsProc) return { ok: false, error: 'not running' };
  try { bdsProc.stdin.write('stop\n'); } catch (_) {}
  setTimeout(() => { try { if (bdsProc) bdsProc.kill(); } catch (_) {} }, 5000);
  return { ok: true };
}

function bdsStatus() {
  return { running: !!bdsProc, pid: bdsProc ? bdsProc.pid : null, bdsDir: BDS_DIR, exeExists: fs.existsSync(bdsExe()) };
}

function registerIpc() {
  ipcMain.handle('bedrock:bds-status', () => bdsStatus());
  ipcMain.handle('bedrock:bds-start', () => startBds());
  ipcMain.handle('bedrock:bds-stop', () => stopBds());
  ipcMain.handle('bedrock:get-config', () => {
    try {
      const cfg = fs.readFileSync(path.join(BDS_DIR, 'server.properties'), 'utf8');
      return { ok: true, config: cfg };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  diagLog('second instance; quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => {
    try { if (bdsProc) bdsProc.kill(); } catch (_) {}
    app.quit();
  });
}
