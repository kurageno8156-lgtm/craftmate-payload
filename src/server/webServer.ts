import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { MinecraftBot } from '../bot/mcBot.js';
import { AutonomousAgent } from '../ai/agent.js';
import { AgentStepLog, ChatMessage } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
  private app: express.Express;
  private server: http.Server;
  private io: SocketIOServer;
  private botWrapper: MinecraftBot;
  private agent: AutonomousAgent;
  private port: number;

  constructor(botWrapper: MinecraftBot, agent: AutonomousAgent, port: number = 3000) {
    this.botWrapper = botWrapper;
    this.agent = agent;
    this.port = port;

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
    // public フォルダを静的ファイルとして配信
    const publicPath = path.resolve(__dirname, '../../public');
    this.app.use(express.static(publicPath));
  }

  private setupRoutes(): void {
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
          model: this.botWrapper.config.llmProvider === 'gemini'
            ? this.botWrapper.config.geminiModel
            : this.botWrapper.config.openaiModel,
        },
      });
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
  }

  private setupSocketEvents(): void {
    this.io.on('connection', (socket) => {
      // 接続時に最新ステータスを即座に送信
      socket.emit('status', this.botWrapper.getStatus(
        this.agent.getCurrentTask(),
        this.agent.isBusy()
      ));

      socket.on('sendInstruction', (data: { instruction: string; sender?: string }) => {
        if (data.instruction) {
          this.agent.handleInstruction(data.instruction, data.sender || 'WebUser');
        }
      });

      socket.on('cancelTask', async () => {
        await this.agent.cancelTask();
      });
    });

    // 定期的なステータス同期 (1秒毎)
    setInterval(() => {
      if (this.botWrapper.isConnected) {
        this.io.emit('status', this.botWrapper.getStatus(
          this.agent.getCurrentTask(),
          this.agent.isBusy()
        ));
      }
    }, 1000);
  }

  private setupBotEvents(): void {
    this.agent.on('stepLog', (log: AgentStepLog) => {
      this.io.emit('agentLog', log);
    });

    this.agent.on('taskStarted', (data: { task: string; requester: string }) => {
      this.io.emit('taskStarted', data);
    });

    this.agent.on('taskFinished', (data: { task: string }) => {
      this.io.emit('taskFinished', data);
    });

    this.botWrapper.on('playerMessage', (chat: ChatMessage) => {
      this.io.emit('chatMessage', chat);
    });
  }

  public start(): void {
    this.server.listen(this.port, () => {
      console.log(`\n======================================================`);
      console.log(`🌐 Web Dashboard is running at: http://localhost:${this.port}`);
      console.log(`======================================================\n`);
    });
  }
}
