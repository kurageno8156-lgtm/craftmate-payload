import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { MinecraftBot } from '../bot/mcBot.js';
import { AutonomousAgent } from '../ai/agent.js';
import { captureScreenRegion } from '../bot/vision.js';
import { AgentStepLog, ChatMessage } from '../types.js';
import * as fs from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_ENV_KEYS = {
  gemini: 'GEMINI_MODEL',
  groq: 'GROQ_MODEL',
  ollama: 'OLLAMA_MODEL',
  openai: 'OPENAI_MODEL',
} as const;
type AIProvider = keyof typeof MODEL_ENV_KEYS;


export class WebServer {
  private app: express.Express;
  private server: http.Server;
  private io: SocketIOServer;
  private botWrapper: MinecraftBot;
  private agent: AutonomousAgent;
  private port: number;
  private statusTimer: NodeJS.Timeout | null = null;
  private envPath: string;
  private isScreenSharing: boolean = false;
  private screenShareInterval: NodeJS.Timeout | null = null;
  private updateToken: Buffer = Buffer.alloc(32);
  private appVersion: string = '0.0.0';


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
    try {
      this.updateToken = this.loadUpdateToken();
    } catch (error) {
      console.error('[Web] Failed to load update token:', error);
      this.updateToken = Buffer.alloc(32);
    }
    try {
      const packageInfo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
      this.appVersion = String(packageInfo.version || '0.0.0');
    } catch { }

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
    this.app.use((req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    });
    this.app.use(express.json({ limit: '256kb' }));
    const publicPath = path.resolve(__dirname, '../../public');
    this.app.get('/', (_req, res) => {
      try {
        let html = fs.readFileSync(path.join(publicPath, 'index.html'), 'utf8');
        html = html.replace(/(src|href)="(\/?)(app\.js|i18n\.js|style\.css|manifest\.json)(\?[^"]*)?"/g, `$1="$2$3?v=${this.appVersion}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html.replace('</head>', `<meta name="craftmate-update-token" content="${this.updateToken.toString('hex')}"></head>`));
      } catch {
        res.status(500).send('Dashboard could not be loaded.');
      }
    });
    this.app.use(express.static(publicPath, { index: false }));
    this.app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      const parseError = error as { status?: number; type?: string };
      if (parseError && (parseError.type === 'entity.parse.failed' || parseError.status === 400)) {
        return res.status(400).json({ error: 'The request body must contain valid JSON.', code: 'INVALID_JSON' });
      }
      next(error);
    });
  }

  private installationPath(): string {
    return path.resolve(__dirname, '../..');
  }

  private loadUpdateToken(): Buffer {
    const tokenDirectory = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local'), 'CraftMate');
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
    let originValue = typeof originHeader === 'string' ? originHeader : '';
    if (!originValue && typeof req.headers.referer === 'string') {
      try { originValue = new URL(req.headers.referer).origin; } catch { return false; }
    }
    // Same-origin GET fetches may omit Origin. Require the browser's fetch metadata
    // or a same-origin Referer in that case; the bearer token remains mandatory.
    if (!originValue) {
      if (req.headers['sec-fetch-site'] !== 'same-origin') return false;
    } else {
      try {
        const origin = new URL(originValue);
        if (origin.protocol !== 'http:' || origin.host.toLowerCase() !== host) return false;
        if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname.toLowerCase())) return false;
      } catch { return false; }
    }
    if (!requireToken) return true;
    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ') ? Buffer.from(authorization.slice(7), 'hex') : Buffer.alloc(0);
    return supplied.length === this.updateToken.length && timingSafeEqual(supplied, this.updateToken);
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

    this.app.post('/api/launch-updater', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'The updater can be launched only from the authenticated local dashboard.' });
      const updaterPath = path.join(this.installationPath(), 'CraftMate_Updater.exe');
      if (!fs.existsSync(updaterPath)) return res.status(404).json({ error: 'CraftMate_Updater.exe was not found. Reinstall CraftMate to add the updater.' });
      try {
        const child = spawn(updaterPath, ['--install-dir', this.installationPath()], {
          cwd: this.installationPath(), detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.once('error', error => console.error('[Updater] Could not start the desktop updater:', error));
        child.unref();
        res.status(202).json({ success: true });
      } catch (error) {
        console.error('[Updater] Could not start the desktop updater:', error);
        res.status(500).json({ error: 'Could not start CraftMate_Updater.exe.' });
      }
    });

    this.app.get('/api/backup', (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Backups are available only to the authenticated local dashboard.' });
      try {
        let env = '';
        try { env = fs.readFileSync(this.envPath, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, '0');
        const fileName = `craftmate_backup_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ format: 'craftmate-settings-backup', version: 1, createdAt: now.toISOString(), fileName, env });
      } catch (error) {
        console.error('[Backup] Could not read .env:', error);
        res.status(500).json({ error: 'Could not create a settings backup.' });
      }
    });

    this.app.post('/api/restore', async (req, res) => {
      if (!this.isLocalUpdateRequest(req, true)) return res.status(403).json({ error: 'Restore is available only to the authenticated local dashboard.' });
      const body = req.body as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'This is not a supported CraftMate settings backup.', code: 'INVALID_BACKUP_DATA' });
      }
      const backup = body as { format?: unknown; version?: unknown; env?: unknown; createdAt?: unknown; fileName?: unknown };
      if (backup.format !== 'craftmate-settings-backup' || backup.version !== 1 || typeof backup.env !== 'string' ||
          (backup.createdAt !== undefined && (typeof backup.createdAt !== 'string' || !Number.isFinite(Date.parse(backup.createdAt)))) ||
          (backup.fileName !== undefined && (typeof backup.fileName !== 'string' || !/^craftmate_backup_\d{8}_\d{6}\.json$/.test(backup.fileName)))) {
        return res.status(400).json({ error: 'This is not a supported CraftMate settings backup.', code: 'INVALID_BACKUP_DATA' });
      }
      if (Buffer.byteLength(backup.env, 'utf8') > 128 * 1024 || backup.env.includes('\0')) {
        return res.status(413).json({ error: 'The backup file is too large or contains invalid data.', code: 'INVALID_BACKUP_DATA' });
      }

      let values: Record<string, string>;
      try { values = dotenv.parse(backup.env); }
      catch { return res.status(400).json({ error: 'The backup settings could not be parsed.', code: 'INVALID_BACKUP_DATA' }); }
      const knownSettings = ['MC_HOST', 'MC_PORT', 'MC_USERNAME', 'MINECRAFT_VERSION', 'WEB_PORT', 'LLM_PROVIDER', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_MODEL'];
      if (!Object.keys(values).some(key => knownSettings.includes(key))) {
        return res.status(400).json({ error: 'The backup does not contain CraftMate settings.', code: 'INVALID_BACKUP_DATA' });
      }
      const providers = ['gemini', 'groq', 'openai', 'ollama'];
      const provider = values.LLM_PROVIDER || 'gemini';
      const mcPort = Number(values.MC_PORT || 25565);
      const webPort = Number(values.WEB_PORT || 3000);
      const username = values.MC_USERNAME || 'AIMAN';
      const auth = values.MC_AUTH || 'offline';
      const minecraftVersion = values.MINECRAFT_VERSION || 'auto';
      if (!providers.includes(provider)) return res.status(400).json({ error: 'The backup contains an unsupported AI provider.' });
      if (!Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535 || !Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
        return res.status(400).json({ error: 'The backup contains an invalid port number.' });
      }
      if (!/^[A-Za-z0-9_]{1,16}$/.test(username) || (auth !== 'offline' && auth !== 'microsoft')) {
        return res.status(400).json({ error: 'The backup contains invalid Minecraft settings.' });
      }
      if (minecraftVersion.toLowerCase() !== 'auto' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(minecraftVersion)) {
        return res.status(400).json({ error: 'The backup contains an invalid Minecraft version.' });
      }
      for (const key of Object.values(MODEL_ENV_KEYS)) {
        if (values[key] && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(values[key])) {
          return res.status(400).json({ error: `The backup contains an invalid model value (${key}).` });
        }
      }
      for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY']) {
        if (values[key] && (values[key].length > 512 || /[\r\n]/.test(values[key]))) {
          return res.status(400).json({ error: `The backup contains an invalid API key value (${key}).`, code: 'INVALID_BACKUP_DATA' });
        }
      }
      if (values.OLLAMA_BASE_URL) {
        try {
          const ollamaUrl = new URL(values.OLLAMA_BASE_URL);
          if (!['http:', 'https:'].includes(ollamaUrl.protocol)) throw new Error('unsupported protocol');
        } catch { return res.status(400).json({ error: 'The backup contains an invalid Ollama URL.', code: 'INVALID_BACKUP_DATA' }); }
      }
      for (const key of ['AUTO_EAT', 'AUTO_ARMOR']) {
        if (values[key] && !['true', 'false'].includes(values[key].toLowerCase())) {
          return res.status(400).json({ error: `The backup contains an invalid value for ${key}.`, code: 'INVALID_BACKUP_DATA' });
        }
      }

      const config = this.botWrapper.config;
      const previousEnv = (() => {
        try { return dotenv.parse(fs.readFileSync(this.envPath, 'utf8')); } catch { return {}; }
      })();
      const portChanged = webPort !== this.port;
      const minecraftChanged = mcPort !== config.mcPort || username !== config.mcUsername ||
        (values.MC_HOST || 'localhost') !== config.mcHost || auth !== config.mcAuth || minecraftVersion !== (config.mcVersion || 'auto');
      const temporaryPath = `${this.envPath}.restore-${randomBytes(8).toString('hex')}`;
      try {
        fs.writeFileSync(temporaryPath, backup.env, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await this.renameFileWithRetry(temporaryPath, this.envPath);
      } catch (error) {
        try { fs.rmSync(temporaryPath, { force: true }); } catch { }
        console.error('[Restore] Could not replace .env:', error);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          return res.status(500).json({ error: 'Access was denied while replacing .env. The CraftMate install folder may require write permission.', code: 'RESTORE_PERMISSION_DENIED' });
        }
        return res.status(500).json({ error: 'Could not restore the settings file. Close applications that may be locking .env and try again.', code: 'RESTORE_WRITE_FAILED' });
      }

      for (const key of Object.keys(previousEnv)) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(values)) process.env[key] = value;

      config.mcHost = values.MC_HOST || 'localhost';
      config.mcPort = mcPort;
      config.mcUsername = username;
      config.mcAuth = auth as 'offline' | 'microsoft';
      config.mcVersion = minecraftVersion;
      config.llmProvider = provider as AIProvider;
      config.geminiApiKey = values.GEMINI_API_KEY || '';
      config.geminiModel = values.GEMINI_MODEL || 'gemini-3.1-flash-lite';
      config.openaiApiKey = values.OPENAI_API_KEY || '';
      config.openaiModel = values.OPENAI_MODEL || 'gpt-4o';
      config.groqApiKey = values.GROQ_API_KEY || '';
      config.groqModel = values.GROQ_MODEL || 'openai/gpt-oss-120b';
      config.ollamaBaseUrl = values.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      config.ollamaModel = values.OLLAMA_MODEL || 'llama3.1';
      config.webPort = webPort;
      config.autoEat = values.AUTO_EAT !== 'false';
      config.autoArmor = values.AUTO_ARMOR !== 'false';
      config.maxAgentSteps = 100;
      this.agent.restartAIClient();
      if (minecraftChanged) this.botWrapper.reconnect();

      res.json({ success: true, reconnecting: minecraftChanged, webPortChanged: portChanged, webPort });
      if (portChanged) setTimeout(() => this.changePort(webPort), 300);
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
        mcVersion: config.mcVersion || 'auto',
        username: config.mcUsername,
        webPort: this.port,
        provider: config.llmProvider,
        model: this.getModelName(),
        apiKeyConfigured: this.isProviderConfigured(),
      });
    });

    this.app.post('/api/settings', async (req, res) => {
      const { mcPort, mcVersion, username, webPort, provider, model, aiApiKey } = req.body || {};
      const parsedMcPort = Number(mcPort);
      const parsedWebPort = Number(webPort);
      const providers = Object.keys(MODEL_ENV_KEYS) as AIProvider[];

      if (!Number.isInteger(parsedMcPort) || parsedMcPort < 1 || parsedMcPort > 65535) {
        return res.status(400).json({ error: 'Minecraft port must be between 1 and 65535.' });
      }
      const selectedMinecraftVersion = typeof mcVersion === 'string' ? mcVersion.trim() : 'auto';
      if (selectedMinecraftVersion.toLowerCase() !== 'auto' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(selectedMinecraftVersion)) {
        return res.status(400).json({ error: 'Enter auto or a valid Minecraft version such as 1.21.1.' });
      }
      if (selectedMinecraftVersion !== 'auto') {
        const versionParts = selectedMinecraftVersion.split('.').map(part => {
          const n = Number(part);
          if (!Number.isInteger(n) || String(n) !== part.trim()) return NaN;
          return n;
        });
        if (versionParts.some(n => Number.isNaN(n))) {
          return res.status(400).json({ error: 'Enter auto or a valid Minecraft version such as 1.21.1.' });
        }
        const major = versionParts[0];
        const minor = versionParts[1] || 0;
        const patch = versionParts[2] || 0;
        if (major > 26 || (major === 26 && minor > 1) || (major === 26 && minor === 1 && patch > 0)) {
          return res.status(400).json({ error: 'Minecraft version must be 26.1 or lower.' });
        }
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
      const minecraftChanged = parsedMcPort !== config.mcPort || username.trim() !== config.mcUsername || selectedMinecraftVersion !== (config.mcVersion || 'auto');
      const updates: Record<string, string> = {
        MC_PORT: String(parsedMcPort),
        MINECRAFT_VERSION: selectedMinecraftVersion || 'auto',
        MC_USERNAME: username.trim(),
        WEB_PORT: String(parsedWebPort),
        LLM_PROVIDER: selectedProvider,
        [MODEL_ENV_KEYS[selectedProvider]]: selectedModel,
      };

      const keyName = selectedProvider === 'gemini' ? 'GEMINI_API_KEY' : selectedProvider === 'groq' ? 'GROQ_API_KEY' : selectedProvider === 'openai' ? 'OPENAI_API_KEY' : '';
      const trimmedKey = typeof aiApiKey === 'string' ? aiApiKey.trim() : '';
      if (keyName && trimmedKey) updates[keyName] = trimmedKey;

      try {
        await this.writeEnvUpdates(updates);
      } catch (error) {
        console.error('[Settings] Could not save .env:', error);
        return res.status(500).json({ error: 'Could not save settings to .env.' });
      }

      config.mcPort = parsedMcPort;
      config.mcVersion = selectedMinecraftVersion || 'auto';
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

      res.json({ success: true, reconnecting: minecraftChanged, webPortChanged: portChanged, webPort: parsedWebPort, provider: selectedProvider, model: selectedModel, mcVersion: config.mcVersion });
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

  private async writeEnvUpdates(updates: Record<string, string>): Promise<void> {
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
    }
    const output = `${lines.filter((line, index) => index < lines.length - 1 || line !== '').join('\n').trimEnd()}\n`;
    const retryDelays = [50, 100, 150];
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.writeFileSync(envPath, output, 'utf8');
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || '';
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= retryDelays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }
    }
    for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  }

  private async renameFileWithRetry(source: string, destination: string): Promise<void> {
    const retryableErrors = new Set(['EBUSY', 'EACCES', 'EPERM']);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(source, destination);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || '';
        if (!retryableErrors.has(code) || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
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
      socket.on('start-screen-share', () => {
        if (!this.isScreenSharing) {
          this.isScreenSharing = true;
          let capturing = false;
          this.screenShareInterval = setInterval(async () => {
            if (!this.isScreenSharing || capturing) return;
            capturing = true;
            try {
              const img = await captureScreenRegion(0, 0, 1920, 1080);
              if (img) socket.emit('bot-screen', img);
            } catch (error) {
              console.error('[Web] Screen share capture failed:', error);
            } finally {
              capturing = false;
            }
          }, 100);
        }
      });

      socket.on('stop-screen-share', () => {
        this.isScreenSharing = false;
        if (this.screenShareInterval) {
          clearInterval(this.screenShareInterval);
          this.screenShareInterval = null;
        }
      });

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
