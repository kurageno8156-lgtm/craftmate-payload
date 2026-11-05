import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { MinecraftBot } from '../bot/mcBot.js';
import { AutonomousAgent } from '../ai/agent.js';
import { AgentStepLog, ChatMessage } from '../types.js';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
  private app: express.Express;
  private server: http.Server;
  private io: SocketIOServer;
  private botWrapper: MinecraftBot;
  private agent: AutonomousAgent;
  private port: number;
  private statusTimer: NodeJS.Timeout | null = null;
  private envPath: string;

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
    this.app.use(cors());
    this.app.use(express.json());
    const publicPath = path.resolve(__dirname, '../../public');
    this.app.use(express.static(publicPath));
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
        apiKeyConfigured: this.isProviderConfigured(),
      });
    });

    this.app.post('/api/settings', (req, res) => {
      const { mcPort, username, webPort, provider, aiApiKey } = req.body || {};
      const parsedMcPort = Number(mcPort);
      const parsedWebPort = Number(webPort);
      const providers = ['gemini', 'groq', 'ollama', 'openai'] as const;

      if (!Number.isInteger(parsedMcPort) || parsedMcPort < 1 || parsedMcPort > 65535) {
        return res.status(400).json({ error: 'Minecraft port must be between 1 and 65535.' });
      }
      if (!Number.isInteger(parsedWebPort) || parsedWebPort < 1 || parsedWebPort > 65535) {
        return res.status(400).json({ error: 'Web port must be between 1 and 65535.' });
      }
      if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(username.trim())) {
        return res.status(400).json({ error: 'Bot name must be 1–16 letters, numbers, or underscores.' });
      }
      if (!providers.includes(provider)) {
        return res.status(400).json({ error: 'Choose Gemini, Groq, Ollama, or OpenAI.' });
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
        LLM_PROVIDER: provider,
      };

      const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'groq' ? 'GROQ_API_KEY' : provider === 'openai' ? 'OPENAI_API_KEY' : '';
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
      config.llmProvider = provider;
      if (keyName && trimmedKey) {
        if (provider === 'gemini') config.geminiApiKey = trimmedKey;
        if (provider === 'groq') config.groqApiKey = trimmedKey;
        if (provider === 'openai') config.openaiApiKey = trimmedKey;
      }
      this.agent.restartAIClient();
      if (minecraftChanged) this.botWrapper.reconnect();

      res.json({ success: true, reconnecting: minecraftChanged, webPortChanged: portChanged, webPort: parsedWebPort });
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
