import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { MinecraftBot } from '../bot/mcBot.js';
import { AutonomousAgent } from '../ai/agent.js';
import { AgentStepLog, ChatMessage } from '../types.js';
import * as fs from 'fs';
import os from 'os';
import { randomBytes, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_ENV_KEYS = {
  gemini: 'GEMINI_MODEL',
  groq: 'GROQ_MODEL',
  ollama: 'OLLAMA_MODEL',
  openai: 'OPENAI_MODEL',
} as const;
type AIProvider = keyof typeof MODEL_ENV_KEYS;
type UpdateLogEntry = { time: string; message: string; level: 'info' | 'error' };

const WINDOWS_UPDATE_HELPER = String.raw`param(
  [int]$ParentPid,
  [string]$ZipPath,
  [string]$InstallationPath,
  [string]$WorkPath,
  [string]$ExpectedVersion,
  [int]$Port
)
$ErrorActionPreference = 'Stop'
$statusPath = Join-Path $InstallationPath '.craftmate-update-status.json'
$resultPath = Join-Path $InstallationPath '.craftmate-update-result.json'
$workStatusPath = Join-Path $WorkPath 'status.json'
$logPath = Join-Path $InstallationPath '.craftmate-update-logs.json'
$workLogPath = Join-Path $WorkPath 'logs.json'
$changes = New-Object System.Collections.ArrayList
$updateLogs = New-Object System.Collections.ArrayList
$newServerPid = 0
$currentVersion = ''
$lastModified = ''
$filesUpdated = 0
if (Test-Path -LiteralPath $workLogPath) {
  try {
    foreach ($entry in (Get-Content -LiteralPath $workLogPath -Raw | ConvertFrom-Json)) { [void]$updateLogs.Add($entry) }
  } catch { }
}

function Add-UpdateLog([string]$Message, [string]$Level = 'info') {
  $entry = @{ time = (Get-Date).ToString('o'); message = $Message; level = $Level }
  [void]$script:updateLogs.Add($entry)
  $json = ConvertTo-Json -InputObject @($script:updateLogs.ToArray()) -Depth 4
  [System.IO.File]::WriteAllText($workLogPath, $json, [System.Text.UTF8Encoding]::new($false))
  try { [System.IO.File]::WriteAllText($logPath, $json, [System.Text.UTF8Encoding]::new($false)) } catch { }
}

function Write-UpdateStatus([string]$State, [int]$Progress, [string]$Message) {
  $status = @{ status = $State; progress = $Progress; message = $Message; version = $ExpectedVersion; currentVersion = $script:currentVersion; lastModified = $script:lastModified; filesUpdated = $script:filesUpdated } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($workStatusPath, $status, [System.Text.UTF8Encoding]::new($false))
  try { [System.IO.File]::WriteAllText($statusPath, $status, [System.Text.UTF8Encoding]::new($false)) } catch { }
}

function Start-CraftMateServer {
  $nodePath = Join-Path $InstallationPath 'node.exe'
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Updated node.exe is missing.' }
  $process = Start-Process -FilePath $nodePath -ArgumentList '"dist\index.js"' -WorkingDirectory $InstallationPath -WindowStyle Hidden -PassThru
  return $process.Id
}

try {
  Add-UpdateLog '更新ヘルパーを開始しました。'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $probePath = Join-Path $InstallationPath ('.craftmate-update-write-test-' + [guid]::NewGuid().ToString('N'))
  $needsElevation = $false
  try { [System.IO.File]::WriteAllText($probePath, ''); Remove-Item -LiteralPath $probePath -Force } catch { $needsElevation = $true }
  if ($needsElevation -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $ps = Join-Path $PSHOME 'powershell.exe'
    $quotedScript = '"' + $PSCommandPath + '"'
    $quotedZip = '"' + $ZipPath + '"'
    $quotedInstall = '"' + $InstallationPath + '"'
    $quotedWork = '"' + $WorkPath + '"'
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $quotedScript,
      '-ParentPid', "$ParentPid", '-ZipPath', $quotedZip, '-InstallationPath', $quotedInstall,
      '-WorkPath', $quotedWork, '-ExpectedVersion', $ExpectedVersion, '-Port', "$Port")
    Start-Process -FilePath $ps -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden | Out-Null
    exit 0
  }

  Write-UpdateStatus 'applying' 82 'Waiting for Windows permission to apply the update.'
  Add-UpdateLog '既存サーバーの終了を待機しています。'
  Start-Sleep -Seconds 2
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { throw 'The current server did not stop in time.' }

  Add-UpdateLog 'ダウンロードした ZIP の展開先と内容を検証しています。'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = [System.IO.Path]::GetFullPath($InstallationPath).TrimEnd('\') + '\'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $archive.Entries) {
      $entryPath = [System.IO.Path]::GetFullPath((Join-Path $InstallationPath $entry.FullName))
      if (-not $entryPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The update archive contains an invalid path.' }
    }
  } finally { $archive.Dispose() }

  $stage = Join-Path $WorkPath 'stage'
  $backupRoot = Join-Path $WorkPath 'backup'
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Add-UpdateLog 'ZIP を解凍しています。'
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $stage -Force
  $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  if ([string]$package.version -ne $ExpectedVersion) { throw 'The update package version does not match the GitHub release.' }
  foreach ($required in @('CraftMate.exe', 'node.exe', 'dist\index.js', 'public\app.ico')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Required update file is missing: $required" }
  }

  Write-UpdateStatus 'applying' 90 'Applying the update files.'
  Add-UpdateLog 'インストール先ファイルをバックアップして上書きしています。'
  foreach ($item in @('dist', 'public', 'node_modules', 'CraftMate.exe', 'node.exe', '.env.example', 'package.json', 'package-lock.json', 'README.md', 'Uninstall.exe')) {
    $source = Join-Path $stage $item
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $destination = Join-Path $InstallationPath $item
    $backup = Join-Path $backupRoot $item
    $hadBackup = Test-Path -LiteralPath $destination
    if ($hadBackup) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
      Move-Item -LiteralPath $destination -Destination $backup
    }
    [void]$changes.Add(@{ destination = $destination; backup = $backup; hadBackup = $hadBackup })
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $destination
    if (Test-Path -LiteralPath $destination -PathType Container) {
      $itemFileCount = @(Get-ChildItem -LiteralPath $destination -File -Recurse -Force).Count
    } else { $itemFileCount = 1 }
    $script:filesUpdated += $itemFileCount
    Add-UpdateLog "上書き完了: $item ($itemFileCount files)"
  }

  Add-UpdateLog '更新後のサーバーを起動し、バージョンを確認しています。'
  $newServerPid = Start-CraftMateServer
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
      $response = Invoke-RestMethod -Uri "http://localhost:$Port/api/version" -TimeoutSec 1
      if ([string]$response.version -eq $ExpectedVersion) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'The updated server did not become ready.' }

  $script:currentVersion = [string]$response.version
  if ($script:currentVersion -ne $ExpectedVersion) { throw 'The running application version does not match the update package.' }
  $packagePath = Join-Path $InstallationPath 'package.json'
  $completedAt = Get-Date
  [System.IO.File]::SetLastWriteTime($packagePath, $completedAt)
  $script:lastModified = (Get-Item -LiteralPath $packagePath).LastWriteTime.ToString('o')
  Add-UpdateLog "上書きとバージョン確認が完了しました: v$($script:currentVersion)、更新ファイル $($script:filesUpdated) 件。"
  $result = @{ currentVersion = $script:currentVersion; lastModified = $script:lastModified; filesUpdated = $script:filesUpdated; completedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($resultPath, $result, [System.Text.UTF8Encoding]::new($false))
  Write-UpdateStatus 'completed' 100 'Update completed.'
  Remove-Item -LiteralPath $WorkPath -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Add-UpdateLog ("更新に失敗しました: " + $_.Exception.Message) 'error'
  if ($newServerPid -gt 0) { Stop-Process -Id $newServerPid -Force -ErrorAction SilentlyContinue }
  for ($index = $changes.Count - 1; $index -ge 0; $index--) {
    $change = $changes[$index]
    if (Test-Path -LiteralPath $change.destination) { Remove-Item -LiteralPath $change.destination -Recurse -Force -ErrorAction SilentlyContinue }
    if ($change.hadBackup -and (Test-Path -LiteralPath $change.backup)) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $change.destination) -Force | Out-Null
      Move-Item -LiteralPath $change.backup -Destination $change.destination -Force
    }
  }
  Write-UpdateStatus 'failed' 0 $_.Exception.Message
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    try { $null = Start-CraftMateServer } catch { }
  }
}
`;

export class WebServer {
  private app: express.Express;
  private server: http.Server;
  private io: SocketIOServer;
  private botWrapper: MinecraftBot;
  private agent: AutonomousAgent;
  private port: number;
  private statusTimer: NodeJS.Timeout | null = null;
  private envPath: string;
  private updateToken: Buffer;
  private activeUpdateWorkPath = '';
  private updateProgress: { status: string; progress: number; message: string; version?: string; currentVersion?: string; lastModified?: string; filesUpdated?: number } = {
    status: 'idle', progress: 0, message: '',
  };

  constructor(
    botWrapper: MinecraftBot,
    agent: AutonomousAgent,
    port: number = 3000,
    envPath: string = path.resolve(__dirname, '../../.env')
  ) {
    this.botWrapper = botWrapper;
    this.agent = agent;
    this.port = port;
    this.envPath = envPath;
    this.updateToken = this.loadUpdateToken();

    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: { origin: '*' },
    });

    this.setupMiddlewares();
    this.setupRoutes();
    this.setupSocketEvents();
    this.setupBotEvents();
  }

  private setupMiddlewares(): void {
    this.app.use(express.json());
    const publicPath = path.resolve(__dirname, '../../public');
    this.app.get('/', (_req, res) => {
      try {
        const html = fs.readFileSync(path.join(publicPath, 'index.html'), 'utf8');
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html.replace('</head>', `<meta name="craftmate-update-token" content="${this.updateToken.toString('hex')}"></head>`));
      } catch {
        res.status(500).send('Dashboard could not be loaded.');
      }
    });
    this.app.use(express.static(publicPath, { index: false }));
  }

  private installationPath(): string {
    return path.resolve(__dirname, '../..');
  }

  private loadUpdateToken(): Buffer {
    const tokenDirectory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CraftMate');
    const tokenPath = path.join(tokenDirectory, 'update-token');
    try {
      fs.mkdirSync(tokenDirectory, { recursive: true });
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) return Buffer.from(existing, 'hex');
    } catch { }
    const token = randomBytes(32);
    fs.writeFileSync(tokenPath, token.toString('hex'), { mode: 0o600 });
    return token;
  }

  private isLocalUpdateRequest(req: express.Request, requireToken: boolean): boolean {
    const address = (req.socket.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
    if (address !== '127.0.0.1' && address !== '::1') return false;
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
    const originHeader = req.headers.origin;
    if (typeof originHeader !== 'string') return false;
    try {
      const origin = new URL(originHeader);
      if (origin.protocol !== 'http:' || origin.host.toLowerCase() !== host) return false;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname.toLowerCase())) return false;
    } catch { return false; }
    if (!requireToken) return true;
    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ') ? Buffer.from(authorization.slice(7), 'hex') : Buffer.alloc(0);
    return supplied.length === this.updateToken.length && timingSafeEqual(supplied, this.updateToken);
  }

  private updateLogs: UpdateLogEntry[] = [];

  private appendUpdateLog(message: string, level: 'info' | 'error' = 'info'): void {
    const entry: UpdateLogEntry = { time: new Date().toISOString(), message, level };
    this.updateLogs.push(entry);
    if (this.updateLogs.length > 1000) this.updateLogs.shift();
    console.log(`[Update] ${message}`);
    if (this.activeUpdateWorkPath) {
      try {
        fs.writeFileSync(path.join(this.activeUpdateWorkPath, 'logs.json'), JSON.stringify(this.updateLogs, null, 2), 'utf8');
      } catch { }
    }
  }

  private async downloadLatestUpdate(onLog: (message: string) => void): Promise<{ zipPath: string; workPath: string; version: string }> {
    const repository = 'kurageno8156-lgtm/craftmate-payload';
    onLog('GitHub Releases の最新バージョンを確認しています。');
    const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CraftMate-Updater' },
      signal: AbortSignal.timeout(30000),
    });
    if (!releaseResponse.ok) throw new Error(`GitHub release lookup failed (${releaseResponse.status}).`);
    const release = await releaseResponse.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('The latest release has an invalid version tag.');
    const packageInfo = JSON.parse(fs.readFileSync(path.join(this.installationPath(), 'package.json'), 'utf8')) as { version?: string };
    const current = String(packageInfo.version || '');
    const toParts = (value: string) => value.split('-')[0].split('.').map(Number);
    const latestParts = toParts(version);
    const currentParts = toParts(current);
    let comparison = 0;
    for (let index = 0; index < 3; index += 1) {
      if (latestParts[index] !== currentParts[index]) { comparison = latestParts[index] > currentParts[index] ? 1 : -1; break; }
    }
    if (comparison === 0 && version !== current) comparison = current.includes('-') && !version.includes('-') ? 1 : version.includes('-') && !current.includes('-') ? -1 : 0;
    const newer = comparison > 0;
    if (!newer) throw new Error(`No newer release is available (installed: v${current}, latest: v${version}).`);
    onLog(`最新リリース v${version} を確認しました。`);
    const asset = (release.assets || []).find(item => item.name === 'app_payload.zip');
    const url = String(asset?.browser_download_url || '');
    if (!url.startsWith(`https://github.com/${repository}/releases/download/`)) throw new Error('The GitHub release does not contain a trusted app_payload.zip asset.');
    onLog('app_payload.zip をダウンロードしています。');
    const download = await fetch(url, { headers: { 'User-Agent': 'CraftMate-Updater' }, signal: AbortSignal.timeout(120000) });
    if (!download.ok || !download.body) throw new Error(`Update download failed (${download.status}).`);
    const length = Number(download.headers.get('content-length') || 0);
    if (length > 512 * 1024 * 1024) throw new Error('The update package exceeds the 512 MiB limit.');
    const workPath = fs.mkdtempSync(path.join(os.tmpdir(), 'craftmate-update-'));
    const zipPath = path.join(workPath, 'app_payload.zip');
    let received = 0;
    let lastLoggedPercent = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > 512 * 1024 * 1024) callback(new Error('The update package exceeds the 512 MiB limit.'));
      else {
        if (length > 0) {
          const percent = Math.min(100, Math.floor((received / length) * 10) * 10);
          if (percent >= lastLoggedPercent + 10) { lastLoggedPercent = percent; onLog(`ダウンロード中... ${percent}%`); }
        }
        this.push(chunk);
        callback();
      }
    } });
    await pipeline(Readable.fromWeb(download.body as import('stream/web').ReadableStream), limiter, fs.createWriteStream(zipPath, { flags: 'wx' }));
    const signature = Buffer.alloc(4);
    const fd = fs.openSync(zipPath, 'r');
    try { fs.readSync(fd, signature, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (signature.toString('hex') !== '504b0304' && signature.toString('hex') !== '504b0506') {
      fs.rmSync(workPath, { recursive: true, force: true });
      throw new Error('The downloaded update is not a valid ZIP archive.');
    }
    onLog(`ZIP のダウンロードが完了しました (${(received / 1024 / 1024).toFixed(1)} MiB)。`);
    return { zipPath, workPath, version };
  }

  private async startUpdate(): Promise<void> {
    let workPath = '';
    try {
      const update = await this.downloadLatestUpdate(message => {
        this.appendUpdateLog(message);
        this.updateProgress.message = message;
        const percent = Number(message.match(/(\d+)%/)?.[1]);
        if (Number.isFinite(percent)) this.updateProgress.progress = Math.min(60, 5 + Math.round(percent * 0.55));
      });
      workPath = update.workPath;
      this.activeUpdateWorkPath = workPath;
      fs.writeFileSync(path.join(workPath, 'logs.json'), JSON.stringify(this.updateLogs, null, 2), 'utf8');
      this.updateProgress = { status: 'applying', progress: 75, message: 'Preparing the update…', version: update.version };
      this.appendUpdateLog('更新ヘルパーを準備しています。');
      const helperPath = path.join(workPath, 'Apply-Update.ps1');
      fs.writeFileSync(helperPath, WINDOWS_UPDATE_HELPER, 'utf8');
      const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
        '-ParentPid', String(process.pid), '-ZipPath', update.zipPath,
        '-InstallationPath', this.installationPath(), '-WorkPath', workPath, '-ExpectedVersion', update.version,
        '-Port', String(this.port),
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', error => {
        const message = `Could not start the update helper: ${error.message}`;
        this.updateProgress = { status: 'failed', progress: 0, message, version: update.version };
        this.appendUpdateLog(message, 'error');
      });
      child.unref();
    } catch (error) {
      if (workPath) fs.rmSync(workPath, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : 'Update failed.';
      this.updateProgress = { status: 'failed', progress: 0, message };
      this.appendUpdateLog(message, 'error');
    }
  }

  private setupRoutes(): void {
    this.app.get('/api/version', (req, res) => {
      try {
        const packagePath = path.resolve(__dirname, '../../package.json');
        const packageInfo = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        res.json({ version: String(packageInfo.version || '0.0.0') });
      } catch {
        res.status(500).json({ error: 'Could not read the application version.' });
      }
    });

    this.app.get('/api/update/status', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Update status is available only to the authenticated local dashboard.' });
      const markerPath = path.join(this.installationPath(), '.craftmate-update-status.json');
      const workStatusPath = this.activeUpdateWorkPath ? path.join(this.activeUpdateWorkPath, 'status.json') : '';
      const statusPath = workStatusPath && fs.existsSync(workStatusPath) ? workStatusPath : markerPath;
      try {
        const activeWithoutHelperStatus = (this.updateProgress.status === 'downloading' || this.updateProgress.status === 'applying'
          || (this.updateProgress.status === 'failed' && this.updateLogs.length > 0))
          && (!workStatusPath || !fs.existsSync(workStatusPath));
        if (!activeWithoutHelperStatus && fs.existsSync(statusPath)) this.updateProgress = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch { }
      if (this.updateProgress.status === 'completed' || this.updateProgress.status === 'failed') {
        try { fs.rmSync(markerPath, { force: true }); } catch { }
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(this.updateProgress);
    });

    this.app.get('/api/update-logs', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Update logs are available only to the authenticated local dashboard.' });
      const workLogPath = this.activeUpdateWorkPath ? path.join(this.activeUpdateWorkPath, 'logs.json') : '';
      const installLogPath = path.join(this.installationPath(), '.craftmate-update-logs.json');
      let logs = this.updateLogs;
      try {
        const selectedPath = this.updateProgress.status === 'downloading' || (this.updateProgress.status === 'failed' && this.updateLogs.length > 0 && !workLogPath)
          ? ''
          : workLogPath && fs.existsSync(workLogPath) ? workLogPath : installLogPath;
        if (fs.existsSync(selectedPath)) {
          const savedLogs = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
          if (Array.isArray(savedLogs)) logs = savedLogs;
        }
      } catch { }
      let result: { currentVersion?: string; lastModified?: string; filesUpdated?: number } = {};
      try { result = JSON.parse(fs.readFileSync(path.join(this.installationPath(), '.craftmate-update-result.json'), 'utf8')); } catch { }
      if (this.updateProgress.status === 'downloading' || this.updateProgress.status === 'applying') result = {};
      let currentVersion = this.updateProgress.currentVersion || '';
      if (!currentVersion) {
        try { currentVersion = String(JSON.parse(fs.readFileSync(path.join(this.installationPath(), 'package.json'), 'utf8')).version || ''); } catch { }
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        logs,
        status: this.updateProgress.status,
        currentVersion: this.updateProgress.currentVersion || result.currentVersion || currentVersion,
        lastModified: this.updateProgress.lastModified || result.lastModified || null,
        filesUpdated: this.updateProgress.filesUpdated || result.filesUpdated || null,
      });
    });

    this.app.post('/api/update', async (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Updates are allowed only from the authenticated local dashboard.' });
      if (this.updateProgress.status === 'downloading' || this.updateProgress.status === 'applying') {
        return res.status(409).json({ error: 'An update is already in progress.' });
      }
      this.updateLogs = [];
      this.activeUpdateWorkPath = '';
      try {
        fs.rmSync(path.join(this.installationPath(), '.craftmate-update-status.json'), { force: true });
        fs.rmSync(path.join(this.installationPath(), '.craftmate-update-result.json'), { force: true });
        fs.rmSync(path.join(this.installationPath(), '.craftmate-update-logs.json'), { force: true });
      } catch { }
      this.updateProgress = { status: 'downloading', progress: 5, message: 'Contacting GitHub Releases…' };
      this.appendUpdateLog('アップデートを開始しました。');
      res.status(202).json({ success: true });
      void this.startUpdate();
    });

    this.app.get('/api/status', (req, res) => {
      const status = this.botWrapper.getStatus(
        this.agent.getCurrentTask(),
        this.agent.isBusy()
      );
      res.json({
        connected: this.botWrapper.isConnected,
        status,
        config: {
          username: this.botWrapper.config.mcUsername,
          host: this.botWrapper.config.mcHost,
          port: this.botWrapper.config.mcPort,
          provider: this.botWrapper.config.llmProvider,
          model: this.getModelName(),
        },
      });
    });

    this.app.get('/api/health', async (req, res) => {
      const minecraftConnected = this.botWrapper.isConnected;
      const aiConnected = await this.checkAIConnection();
      res.json({ minecraftConnected, aiConnected });
    });

    this.app.get('/api/settings', (req, res) => {
      const config = this.botWrapper.config;
      res.json({
        mcPort: config.mcPort,
        username: config.mcUsername,
        webPort: this.port,
        provider: config.llmProvider,
        model: this.getModelName(),
        apiKeyConfigured: this.isProviderConfigured(),
      });
    });

    this.app.post('/api/settings', (req, res) => {
      const { mcPort, username, webPort, provider, model, aiApiKey } = req.body || {};
      const parsedMcPort = Number(mcPort);
      const parsedWebPort = Number(webPort);
      const providers = Object.keys(MODEL_ENV_KEYS) as AIProvider[];

      if (!Number.isInteger(parsedMcPort) || parsedMcPort < 1 || parsedMcPort > 65535) {
        return res.status(400).json({ error: 'Minecraft port must be between 1 and 65535.' });
      }
      if (!Number.isInteger(parsedWebPort) || parsedWebPort < 1 || parsedWebPort > 65535) {
        return res.status(400).json({ error: 'Web port must be between 1 and 65535.' });
      }
      if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(username.trim())) {
        return res.status(400).json({ error: 'Bot name must be 1–16 letters, numbers, or underscores.' });
      }
      if (typeof provider !== 'string' || !providers.includes(provider as AIProvider)) {
        return res.status(400).json({ error: 'Choose Gemini, Groq, Ollama, or OpenAI.' });
      }
      const selectedProvider = provider as AIProvider;
      const selectedModel = typeof model === 'string' ? model.trim() : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(selectedModel)) {
        return res.status(400).json({ error: 'Choose a valid model for the selected provider.' });
      }
      if (aiApiKey !== undefined && (typeof aiApiKey !== 'string' || aiApiKey.length > 512 || /[\r\n]/.test(aiApiKey))) {
        return res.status(400).json({ error: 'The API key is invalid.' });
      }

      const config = this.botWrapper.config;
      const portChanged = parsedWebPort !== this.port;
      const minecraftChanged = parsedMcPort !== config.mcPort || username.trim() !== config.mcUsername;
      const updates: Record<string, string> = {
        MC_PORT: String(parsedMcPort),
        MC_USERNAME: username.trim(),
        WEB_PORT: String(parsedWebPort),
        LLM_PROVIDER: selectedProvider,
        [MODEL_ENV_KEYS[selectedProvider]]: selectedModel,
      };

      const keyName = selectedProvider === 'gemini' ? 'GEMINI_API_KEY' : selectedProvider === 'groq' ? 'GROQ_API_KEY' : selectedProvider === 'openai' ? 'OPENAI_API_KEY' : '';
      const trimmedKey = typeof aiApiKey === 'string' ? aiApiKey.trim() : '';
      if (keyName && trimmedKey) updates[keyName] = trimmedKey;

      try {
        this.writeEnvUpdates(updates);
      } catch (error) {
        console.error('[Settings] Could not save .env:', error);
        return res.status(500).json({ error: 'Could not save settings to .env.' });
      }

      config.mcPort = parsedMcPort;
      config.mcUsername = username.trim();
      config.webPort = parsedWebPort;
      config.llmProvider = selectedProvider;
      if (selectedProvider === 'gemini') config.geminiModel = selectedModel;
      if (selectedProvider === 'groq') config.groqModel = selectedModel;
      if (selectedProvider === 'ollama') config.ollamaModel = selectedModel;
      if (selectedProvider === 'openai') config.openaiModel = selectedModel;
      if (keyName && trimmedKey) {
        if (selectedProvider === 'gemini') config.geminiApiKey = trimmedKey;
        if (selectedProvider === 'groq') config.groqApiKey = trimmedKey;
        if (selectedProvider === 'openai') config.openaiApiKey = trimmedKey;
      }
      this.agent.restartAIClient();
      if (minecraftChanged) this.botWrapper.reconnect();

      res.json({ success: true, reconnecting: minecraftChanged, webPortChanged: portChanged, webPort: parsedWebPort, provider: selectedProvider, model: selectedModel });
      if (portChanged) {
        setTimeout(() => this.changePort(parsedWebPort), 300);
      }
    });

    this.app.post('/api/command', async (req, res) => {
      const { instruction, sender } = req.body;
      if (!instruction) {
        return res.status(400).json({ error: '指示(instruction)が必要です' });
      }
      this.agent.handleInstruction(instruction, sender || 'WebDashboard');
      res.json({ success: true, message: 'タスクを開始しました' });
    });

    this.app.post('/api/cancel', async (req, res) => {
      await this.agent.cancelTask();
      res.json({ success: true, message: 'タスクを中断しました' });
    });

    this.app.post('/api/reconnect', (req, res) => {
      this.botWrapper.reconnect();
      res.json({ success: true });
    });

    this.app.post('/api/ai/restart', (req, res) => {
      this.agent.restartAIClient();
      res.json({ success: true });
    });
  }

  private getModelName(): string {
    const config = this.botWrapper.config;
    if (config.llmProvider === 'gemini') return config.geminiModel;
    if (config.llmProvider === 'groq') return config.groqModel;
    if (config.llmProvider === 'openai') return config.openaiModel;
    return config.ollamaModel;
  }

  private isProviderConfigured(): boolean {
    const config = this.botWrapper.config;
    if (config.llmProvider === 'gemini') return Boolean(config.geminiApiKey);
    if (config.llmProvider === 'groq') return Boolean(config.groqApiKey);
    if (config.llmProvider === 'openai') return Boolean(config.openaiApiKey);
    return true;
  }

  private async checkAIConnection(): Promise<boolean> {
    const config = this.botWrapper.config;
    let url: string;
    const headers: Record<string, string> = {};

    if (config.llmProvider === 'gemini') {
      if (!config.geminiApiKey) return false;
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.geminiApiKey)}`;
    } else if (config.llmProvider === 'groq') {
      if (!config.groqApiKey) return false;
      url = 'https://api.groq.com/openai/v1/models';
      headers.Authorization = `Bearer ${config.groqApiKey}`;
    } else if (config.llmProvider === 'openai') {
      if (!config.openaiApiKey) return false;
      url = 'https://api.openai.com/v1/models';
      headers.Authorization = `Bearer ${config.openaiApiKey}`;
    } else {
      const baseUrl = config.ollamaBaseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
      url = `${baseUrl}/api/tags`;
    }

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private writeEnvUpdates(updates: Record<string, string>): void {
    const envPath = this.envPath;
    let content = '';
    try {
      content = fs.readFileSync(envPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const [key, value] of Object.entries(updates)) {
      const line = `${key}=${JSON.stringify(value)}`;
      const index = lines.findIndex(existing => new RegExp(`^\\s*${key}\\s*=`).test(existing));
      if (index >= 0) lines[index] = line;
      else lines.push(line);
      process.env[key] = value;
    }
    fs.writeFileSync(envPath, `${lines.filter((line, index) => index < lines.length - 1 || line !== '').join('\n').trimEnd()}\n`, 'utf8');
  }

  private changePort(port: number): void {
    if (!this.server.listening) {
      this.port = port;
      this.server.listen(port);
      return;
    }

    this.server.close(error => {
      if (error) {
        console.error('[Web] Could not close the current listener:', error);
        return;
      }
      this.port = port;
      this.server.once('error', err => console.error(`[Web] Could not listen on port ${port}:`, err));
      this.server.listen(port, () => console.log(`[Web] Dashboard moved to http://localhost:${port}`));
    });
  }

  private setupSocketEvents(): void {
    this.io.on('connection', socket => {
      // Send current status immediately upon connection
      socket.emit('status', {
        connected: this.botWrapper.isConnected,
        status: this.botWrapper.getStatus(this.agent.getCurrentTask(), this.agent.isBusy()),
      });

      socket.on('sendInstruction', data => {
        if (data.instruction) {
          this.agent.handleInstruction(data.instruction, data.sender || 'WebUser');
        }
      });

      socket.on('cancelTask', async () => {
        await this.agent.cancelTask();
      });
    });

    this.statusTimer = setInterval(() => {
      try {
        this.io.emit('status', {
          connected: this.botWrapper.isConnected,
          status: this.botWrapper.getStatus(this.agent.getCurrentTask(), this.agent.isBusy()),
        });
      } catch (error) {
        console.error('[Web] Could not broadcast status:', error);
      }
    }, 1000);
  }

  private setupBotEvents(): void {
    this.agent.on('stepLog', (log: AgentStepLog) => {
      this.io.emit('agentLog', log);
    });

    this.agent.on('taskStarted', data => {
      this.io.emit('taskStarted', data);
    });

    this.agent.on('taskFinished', data => {
      this.io.emit('taskFinished', data);
    });

    this.botWrapper.on('playerMessage', (chat: ChatMessage) => {
      this.io.emit('chatMessage', chat);
    });
  }

  public start(): void {
    this.server.listen(this.port, () => {
      console.log('\n======================================================');
      console.log(`🌐 Web Dashboard is running at: http://localhost:${this.port}`);
      console.log('======================================================\n');
    });
  }

  public stop(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.io.close();
  }
}
