// BlockWhiz Bedrock - independent Electron dashboard for Minecraft Bedrock
// Dedicated Server (BDS). Separate app identity, userData, IPC and
// single-instance lock from the Java edition BlockWhiz app.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const APP_NAME = 'BlockWhiz Bedrock';
const BDS_DIR = process.env.BDS_DIR || path.join(os.homedir(), '.blockwhiz-bedrock', 'bds');
const BACKUP_DIR = path.join(os.homedir(), '.blockwhiz-bedrock', 'backups');
const LOG_MAX = 2000;

app.setName(APP_NAME);
app.setPath('userData', path.join(os.homedir(), '.blockwhiz-bedrock'));

let mainWindow = null;
let bdsProc = null;
const logBuf = [];

function diagLog(msg) {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'BlockWhizBedrock_server.log'),
    `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
}
function pushLog(line) {
  logBuf.push(line);
  if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
  try { if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('bedrock:log', line); } catch (_) {}
}

function bdsExe() { return path.join(BDS_DIR, 'bedrock_server.exe'); }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function writeJsonSafe(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function startBds() {
  if (bdsProc) return { ok: false, error: 'already running' };
  const exe = bdsExe();
  if (!fs.existsSync(exe)) return { ok: false, error: `bedrock_server.exe not found: ${exe}` };
  try {
    bdsProc = require('child_process').spawn(exe, [], { cwd: BDS_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const onData = (d) => d.toString().split(/\r?\n/).forEach(l => { if (l.trim()) pushLog(l); });
  bdsProc.stdout.on('data', onData);
  bdsProc.stderr.on('data', onData);
  bdsProc.on('exit', (code) => { pushLog(`[bedrock] exited code=${code}`); bdsProc = null; });
  pushLog('[bedrock] BDS started pid=' + bdsProc.pid);
  return { ok: true, pid: bdsProc.pid };
}
function stopBds() {
  if (!bdsProc) return { ok: false, error: 'not running' };
  try { bdsProc.stdin.write('stop\n'); } catch (_) {}
  const p = bdsProc;
  setTimeout(() => { try { if (!p.killed) p.kill(); } catch (_) {} }, 8000);
  return { ok: true };
}
function bdsStatus() {
  return {
    running: !!bdsProc, pid: bdsProc ? bdsProc.pid : null,
    bdsDir: BDS_DIR, exeExists: fs.existsSync(bdsExe()),
    worldExists: fs.existsSync(path.join(BDS_DIR, 'worlds')),
  };
}
function sendCommand(cmd) {
  if (!bdsProc) return { ok: false, error: 'BDS is not running' };
  try { bdsProc.stdin.write(String(cmd).slice(0, 500) + '\n'); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---- File-based management (follows BDS JSON/properties formats) ----
function readServerProperties() {
  const p = path.join(BDS_DIR, 'server.properties');
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const props = {};
    for (const l of lines) {
      if (!l || l.startsWith('#') || !l.includes('=')) continue;
      const i = l.indexOf('=');
      props[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    return { ok: true, path: p, lines, props };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
function writeServerProperties(props) {
  const p = path.join(BDS_DIR, 'server.properties');
  const orig = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : [];
  const out = orig.map(l => {
    if (!l || l.startsWith('#') || !l.includes('=')) return l;
    const i = l.indexOf('='); const k = l.slice(0, i).trim();
    return k in props ? `${k}=${props[k]}` : l;
  });
  for (const k of Object.keys(props)) {
    if (!out.some(l => l.startsWith(k + '='))) out.push(`${k}=${props[k]}`);
  }
  fs.writeFileSync(p, out.join('\n'));
  return { ok: true };
}
function listJson(name) {
  const p = path.join(BDS_DIR, name);
  const d = readJsonSafe(p);
  return { ok: true, path: p, data: Array.isArray(d) ? d : (d ? Object.values(d) : []) };
}
function writeJson(name, data) {
  try { writeJsonSafe(path.join(BDS_DIR, name), data); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---- Backup: copy worlds folder ----
function createBackup() {
  const worlds = path.join(BDS_DIR, 'worlds');
  if (!fs.existsSync(worlds)) return { ok: false, error: 'worlds folder not found' };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const dest = path.join(BACKUP_DIR, name);
  fs.cpSync(worlds, dest, { recursive: true });
  return { ok: true, path: dest };
}
function listBackups() {
  try { return { ok: true, items: fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith('backup-')) }; }
  catch (_) { return { ok: true, items: [] }; }
}
function restoreBackup(name) {
  const src = path.join(BACKUP_DIR, name);
  const worlds = path.join(BDS_DIR, 'worlds');
  if (!fs.existsSync(src) || !/^backup-[\w-]+$/.test(name)) return { ok: false, error: 'invalid backup name' };
  if (bdsProc) return { ok: false, error: 'cannot restore while BDS is running' };
  const safety = worlds + '.pre-restore-' + Date.now();
  if (fs.existsSync(worlds)) fs.renameSync(worlds, safety);
  try {
    fs.cpSync(src, worlds, { recursive: true });
    return { ok: true, safety };
  } catch (e) {
    if (fs.existsSync(safety)) fs.renameSync(safety, worlds);
    return { ok: false, error: String(e.message || e) };
  }
}

// ---- Version check (GitHub releases API) ----
async function checkLatestVersion() {
  try {
    const res = await fetch('https://api.github.com/repos/kurageno8156-lgtm/blockwhiz-bedrock/releases/latest',
      { headers: { 'User-Agent': 'BlockWhizBedrock' } });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const d = await res.json();
    return { ok: true, tag: d.tag_name, url: d.html_url };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME, width: 1280, height: 800, minWidth: 900, minHeight: 600,
    autoHideMenuBar: true, backgroundColor: '#0b0f14',
    webPreferences: { contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle('bedrock:bds-status', () => bdsStatus());
  ipcMain.handle('bedrock:bds-start', () => startBds());
  ipcMain.handle('bedrock:bds-stop', () => stopBds());
  ipcMain.handle('bedrock:bds-cmd', (_e, cmd) => sendCommand(cmd));
  ipcMain.handle('bedrock:logs', () => ({ ok: true, lines: logBuf.slice() }));
  ipcMain.handle('bedrock:props-get', () => readServerProperties());
  ipcMain.handle('bedrock:props-set', (_e, props) => writeServerProperties(props || {}));
  ipcMain.handle('bedrock:list-json', (_e, name) => {
    const allowed = ['allowlist.json', 'permissions.json', 'ops.json'];
    return allowed.includes(name) ? listJson(name) : { ok: false, error: 'not allowed' };
  });
  ipcMain.handle('bedrock:write-json', (_e, name, data) => {
    const allowed = ['allowlist.json', 'permissions.json', 'ops.json'];
    return allowed.includes(name) ? writeJson(name, data) : { ok: false, error: 'not allowed' };
  });
  ipcMain.handle('bedrock:backup-create', () => createBackup());
  ipcMain.handle('bedrock:backup-list', () => listBackups());
  ipcMain.handle('bedrock:backup-restore', (_e, name) => restoreBackup(String(name)));
  ipcMain.handle('bedrock:version-check', () => checkLatestVersion());
  ipcMain.handle('bedrock:pick-bds-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    return { ok: true, dir: r.filePaths[0] };
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
  app.whenReady().then(() => { registerIpc(); createWindow(); });
  app.on('window-all-closed', () => {
    try {
      if (bdsProc) {
        bdsProc.stdin.write('stop\n');
        const p = bdsProc;
        setTimeout(() => { try { p.kill(); } catch (_) {} }, 3000);
      }
    } catch (_) {}
    app.quit();
  });
}
