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
    const configuredVersion = (this.config.mcVersion || '').trim();
    const requestedVersion = configuredVersion && configuredVersion.toLowerCase() !== 'auto' ? configuredVersion : false;
    console.log(`[Bot] Connecting to ${this.config.mcHost}:${this.config.mcPort} as "${this.config.mcUsername}" (Minecraft version ${requestedVersion || 'auto-detection'})...`);

    const botOptions: any = {
      host: this.config.mcHost,
      port: this.config.mcPort,
      username: this.config.mcUsername,
      auth: this.config.mcAuth,
      version: requestedVersion,
      // 描画距離（チャンク）。デフォルトより広く取り、遠くのプレイヤーやMobも検知できるようにする。
      // 実際に届くチャンク数はサーバー側の view-distance 設定が上限になる。
      viewDistance: 16,
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

    console.log('[Bot] Manual reconnect requested. Closing current connection...');
    this.suppressReconnect = true;
    this.isConnected = false;
    const oldBot = this.bot;
    if (oldBot) {
      this.bot = undefined as unknown as Bot;
      // 旧botのイベントリスナーを全て除去してから切断する。
      // quit() は未スポーン状態で例外になることがあるため end() を優先し、
      // リスナー除去で 'end'/'kicked' 経由の二重スケジュールを防ぐ。
      try { oldBot.removeAllListeners(); } catch { }
      try {
        oldBot.end();
      } catch {
        try { oldBot.quit(); } catch (err) {
          console.warn('[Bot] Could not close the previous connection cleanly:', err);
        }
      }
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.suppressReconnect = false;
      console.log('[Bot] Reconnecting to Minecraft server...');
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
    this.skills.guard = this.guard;
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

      // 自動防衛（自衛ガード）開始（管理者設定で無効化可能）
      if (this.config.botAllowAutoguard !== false) {
        this.guard.start();
        console.log('[Bot] 🛡️ Auto-Defense Guard system activated (常時自衛ガード有効)');
      } else {
        console.log('[Bot] Auto-Defense Guard is disabled by admin settings.');
      }

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
    const handledMessages = new Set<string>();
    const emitChatMessage = (rawSender: string, text: string) => {
      if (!text) return;
      // 送信者名の正規化: カラーコード(§)・装飾・括弧・前後の空白を除去する。
      // messagestr 由来の文字列には "[Server] Name" や "§rName" のような装飾が混ざることがある。
      let sender = String(rawSender || '')
        .replace(/§./g, '')
        .replace(/[\[\](){}<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // "[Server] PlayerName" のようなプレフィックスが残った場合は末尾の単語を名前とみなす
      const parts = sender.split(' ').filter(Boolean);
      if (parts.length > 1) sender = parts[parts.length - 1];
      if (!sender || sender === this.bot.username) return;
      // システムメッセージやボット自身の発言を誤って送信者にしない
      if (/^(server|console|system|you|joined|left)$/i.test(sender)) return;
      const dedupeKey = `${sender}:${text}:${Math.floor(Date.now() / 1500)}`;
      if (handledMessages.has(dedupeKey)) return;
      handledMessages.add(dedupeKey);
      if (handledMessages.size > 200) {
        const iter = handledMessages.values();
        for (let i = 0; i < 50; i++) handledMessages.delete(iter.next().value!);
      }
      console.log(`[Chat] <${sender}>: ${text}`);
      const chatMsg: ChatMessage = {
        id: Math.random().toString(36).substring(2, 9),
        sender,
        text,
        timestamp: new Date().toLocaleTimeString(),
        isBot: false,
      };
      this.emit('playerMessage', chatMsg);
    };

    this.bot.on('chat', (username: string, message: string) => {
      if (this.bot !== connectedBot) return;
      emitChatMessage(username, message);
    });

    this.bot.on('messagestr', (messageStr: string) => {
      if (this.bot !== connectedBot) return;
      if (!messageStr) return;
      // 受信チャットの診断ログ（ダッシュボードに反映されない問題の切り分け用）
      console.log(`[Chat:raw] ${messageStr}`);
      const trimmed = messageStr.trim();
      const chatMatch = trimmed.match(/^<([^>]+)>\s+(.+)$/);
      if (chatMatch) {
        emitChatMessage(chatMatch[1], chatMatch[2]);
        return;
      }
      const whisperMatch = trimmed.match(/^([^\s:]+)\s+(?:whispers to you|whispers|が囁きました):\s*(.+)$/i);
      if (whisperMatch) {
        emitChatMessage(whisperMatch[1], whisperMatch[2]);
      }
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
      let reasonStr = typeof reason === 'string' ? reason : '';
      if (!reasonStr) {
        try {
          if (reason && typeof reason === 'object') {
            const r = reason as any;
            reasonStr = r.text || r.value || r.message || r.translate || '';
            if (!reasonStr) reasonStr = JSON.stringify(reason);
          } else if (reason !== undefined && reason !== null) {
            reasonStr = String(reason);
          }
        } catch {
          reasonStr = '[unprintable reason]';
        }
      }
      if (!reasonStr) reasonStr = '(no reason)';
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
