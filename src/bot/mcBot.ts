import mineflayer, { Bot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { loader as autoEat } from 'mineflayer-auto-eat';
import armorManager from 'mineflayer-armor-manager';
import { plugin as pvp } from 'mineflayer-pvp';
import { BotConfig } from '../config.js';
import { PerceptionManager } from './perception.js';
import { SkillManager } from './skills.js';
import { AutoGuard } from './guard.js';
import { ChatMessage, BotStatus } from '../types.js';
import { EventEmitter } from 'events';

export class MinecraftBot extends EventEmitter {
  public bot!: Bot;
  public perception!: PerceptionManager;
  public skills!: SkillManager;
  public guard!: AutoGuard;
  public config: BotConfig;
  public isConnected: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private suppressReconnect = false;

  constructor(config: BotConfig) {
    super();
    this.config = config;
  }

  /**
   * ボットの接続開始
   */
  public start(): void {
    console.log(`[Bot] Connecting to ${this.config.mcHost}:${this.config.mcPort} as "${this.config.mcUsername}" (Minecraft version auto-detection enabled)...`);

    const botOptions: any = {
      host: this.config.mcHost,
      port: this.config.mcPort,
      username: this.config.mcUsername,
      auth: this.config.mcAuth,
      version: false,
    };

    try {
      this.bot = mineflayer.createBot(botOptions);
      this.setupPlugins();
      this.setupEvents();
    } catch (err: any) {
      console.error('[Bot] Initialization error:', err.message);
      this.scheduleReconnect();
    }
  }

  public reconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.suppressReconnect = true;
    this.isConnected = false;
    const oldBot = this.bot;
    if (oldBot) {
      this.bot = undefined as unknown as Bot;
      try {
        oldBot.quit();
      } catch (err) {
        console.warn('[Bot] Could not close the previous connection cleanly:', err);
      }
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.suppressReconnect = false;
      this.start();
    }, 500);
  }

  private setupPlugins(): void {
    this.bot.loadPlugin(pathfinder);
    this.bot.loadPlugin(collectBlock);
    if (typeof autoEat === 'function') {
      this.bot.loadPlugin(autoEat);
    }
    this.bot.loadPlugin(armorManager);
    this.bot.loadPlugin(pvp);

    this.perception = new PerceptionManager(this.bot);
    this.skills = new SkillManager(this.bot);
    this.guard = new AutoGuard(this.bot);
  }

  private setupEvents(): void {
    const connectedBot = this.bot;
    this.bot.on('login', () => {
      if (this.bot !== connectedBot) return;
      console.log(`[Bot] Logged into server successfully as ${this.bot.username}`);
      console.log(`[Bot] Detected Minecraft ${this.bot.version} (protocol ${this.bot.protocolVersion}).`);
      this.isConnected = true;
      this.emit('connected');
    });

    this.bot.once('spawn', () => {
      if (this.bot !== connectedBot) return;
      console.log('[Bot] Bot spawned in the world!');

      // 自動防衛（自衛ガード）開始
      this.guard.start();
      console.log('[Bot] 🛡️ Auto-Defense Guard system activated (常時自衛ガード有効)');

      // 空腹度15以下で安全なインベントリ食料を自動で食べる
      const eater = (this.bot as any).autoEat;
      if (eater) {
        if (this.config.autoEat) {
          eater.setOpts({
            priority: 'foodPoints',
            minHunger: 15,
            bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'],
          });
          if (typeof eater.enableAuto === 'function') eater.enableAuto();
          console.log('[Bot] Auto-eat enabled (starts at food level 15).');
        } else {
          if (typeof eater.disableAuto === 'function') eater.disableAuto();
          console.log('[Bot] Auto-eat disabled by configuration.');
        }
      } else if (this.config.autoEat) {
        console.warn('[Bot] Auto-eat plugin is unavailable.');
      }

      this.emit('spawned');
    });

    const eater = (connectedBot as any).autoEat;
    if (eater && typeof eater.on === 'function') {
      eater.on('eatStart', (opts: any) => {
        if (this.bot === connectedBot) console.log(`[Bot] Auto-eating ${opts?.food?.name || 'food'} (food level ${this.bot.food}).`);
      });
      eater.on('eatFinish', (opts: any) => {
        if (this.bot === connectedBot) console.log(`[Bot] Finished eating ${opts?.food?.name || 'food'} (food level ${this.bot.food}).`);
      });
      eater.on('eatFail', (error: any) => {
        if (this.bot === connectedBot) console.warn('[Bot] Auto-eat failed:', error?.message || error);
      });
    }

    // プレイヤーからのチャット受信
    this.bot.on('chat', (username: string, message: string) => {
      if (this.bot !== connectedBot) return;
      if (username === this.bot.username) return; // 自分の発言は無視

      console.log(`[Chat] <${username}>: ${message}`);
      const chatMsg: ChatMessage = {
        id: Math.random().toString(36).substring(2, 9),
        sender: username,
        text: message,
        timestamp: new Date().toLocaleTimeString(),
        isBot: false,
      };

      this.emit('playerMessage', chatMsg);
    });

    // 体力・満腹度変化
    this.bot.on('health', () => {
      if (this.bot !== connectedBot) return;
      this.emit('statusUpdate', this.getStatus());
    });

    // 死亡時
    this.bot.on('death', () => {
      if (this.bot !== connectedBot) return;
      console.warn('[Bot] Bot died! Respawning...');
      this.emit('botDied');
    });

    // エラーハンドリング (未接続時や切断時)
    this.bot.on('error', (err: any) => {
      if (this.bot !== connectedBot) return;
      console.warn(`[Bot] Connection Notice: ${err.message || '接続待ち中...'}`);
      this.isConnected = false;
      this.emit('botError', err);
      if (!this.suppressReconnect) this.scheduleReconnect();
    });

    this.bot.on('kicked', (reason: any) => {
      if (this.bot !== connectedBot) return;
      let reasonStr = reason;
      try {
        if (typeof reason === 'object') {
          reasonStr = reason.text || reason.value || JSON.stringify(reason);
        }
      } catch {
        // ignore
      }
      console.warn(`[Bot] ⚠️ Kicked from server: ${reasonStr}`);
      this.isConnected = false;
      this.emit('kicked', reasonStr);
      if (!this.suppressReconnect) this.scheduleReconnect();
    });

    this.bot.on('end', (reason: any) => {
      if (this.bot !== connectedBot) return;
      console.log(`[Bot] Disconnected from server (Reason: ${reason || 'normal'}).`);
      this.isConnected = false;
      this.emit('disconnected');
      if (!this.suppressReconnect) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    console.log('[Bot] Minecraftサーバーへの接続を10秒後に再試行します (マイクラを起動してLAN公開またはサーバー起動をお待ちください)...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.start();
    }, 10000);
  }

  /**
   * 現在のBotステータスを取得
   */
  public getStatus(currentTask: string | null = null, isExecuting: boolean = false): BotStatus {
    if (!this.perception || !this.isConnected) {
      return {
        health: 0,
        food: 0,
        position: { x: 0, y: 0, z: 0 },
        dimension: 'offline',
        gameTime: '未接続',
        biome: 'offline',
        inventory: [],
        heldItem: null,
        equippedArmor: {},
        nearbyEntities: [],
        nearbyBlocksSummary: {},
        currentTask,
        isExecuting,
      };
    }
    return this.perception.getStatus(currentTask, isExecuting);
  }
}
