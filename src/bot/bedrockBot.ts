// Minecraft統合版（Bedrock Edition）ボット
// bedrock-protocol を使い、統合版サーバー（自鯖・Realm は不可）へ接続する。
// Java 版の Mineflayer とは別経路。できることは接続・チャット送受信・
// 位置/状態の取得まで（行動AIは未対応）。
interface BedrockClientLike {
  on(event: string, listener: (...args: any[]) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  queue(name: string, params: Record<string, unknown>): void;
  disconnect(reason?: string): void;
}

export interface BedrockStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  host: string;
  port: number;
  username: string;
  position: { x: number; y: number; z: number } | null;
  message: string;
  updatedAt: number;
}

export interface BedrockEvents {
  onChat?: (sender: string, message: string) => void;
  onStatus?: (status: BedrockStatus) => void;
}

export class BedrockBot {
  private client: BedrockClientLike | null = null;
  private status: BedrockStatus = {
    state: 'disconnected', host: '', port: 19132, username: 'CraftMate',
    position: null, message: '', updatedAt: Date.now(),
  };
  private events: BedrockEvents;
  private lastMoveAt = 0;

  constructor(events: BedrockEvents = {}) {
    this.events = events;
  }

  getStatus(): BedrockStatus { return { ...this.status }; }

  private setStatus(patch: Partial<BedrockStatus>) {
    this.status = { ...this.status, ...patch, updatedAt: Date.now() };
    this.events.onStatus?.(this.getStatus());
  }

  isConnected(): boolean { return this.status.state === 'connected'; }

  connect(opts: { host: string; port?: number; username?: string }): void {
    this.disconnect('reconnect');
    const host = (opts.host || '').trim();
    if (!host) { this.setStatus({ state: 'error', message: 'ホスト名を入力してください' }); return; }
    const port = Number(opts.port) || 19132;
    const username = (opts.username || 'CraftMate').trim().slice(0, 32) || 'CraftMate';
    this.setStatus({ state: 'connecting', host, port, username, message: '接続中…', position: null });

    // bedrock-protocol は CJS のため動的 import
    import('bedrock-protocol').then((mod) => {
      const bp = (mod as any).default || mod;
      let client: BedrockClientLike;
      try {
        client = bp.createClient({
          host, port, username,
          offline: true,               // Microsoft アカウント不要（offline モード）
          connectTimeout: 15000,
          // 新しいプロトコルバージョンを自動選択
          version: undefined,
        }) as BedrockClientLike;
      } catch (e) {
        this.setStatus({ state: 'error', message: `接続開始に失敗: ${(e as Error).message}` });
        return;
      }
      this.client = client;

      client.on('spawn', () => {
        this.setStatus({ state: 'connected', message: '接続しました', position: null });
      });
      client.on('start_game', () => {
        this.setStatus({ state: 'connected', message: 'ワールドに参加しました' });
      });
      client.on('move_player', (packet: any) => {
        const now = Date.now();
        if (now - this.lastMoveAt < 2000) return; // 位置更新は2秒間隔に間引く
        this.lastMoveAt = now;
        const p = packet?.position;
        if (p) this.setStatus({ position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } });
      });
      client.on('text', (packet: any) => {
        const msg = packet?.message;
        if (typeof msg === 'string' && msg.trim()) {
          const sender = packet?.source_name || 'server';
          this.events.onChat?.(sender, msg);
        }
      });
      const onClose = (reason?: string) => {
        if (this.client !== client) return;
        this.client = null;
        this.setStatus({ state: 'disconnected', message: reason ? `切断: ${reason}` : '切断しました', position: null });
      };
      client.on('kick', (packet: any) => onClose(packet?.message || 'kick'));
      client.on('disconnect', () => onClose());
      client.on('close', () => onClose());
      client.on('error', (err: any) => {
        this.setStatus({ state: 'error', message: `エラー: ${err?.message || err}` });
      });
    }).catch((e) => {
      this.setStatus({ state: 'error', message: `bedrock-protocol の読み込みに失敗: ${(e as Error).message}` });
    });
  }

  say(text: string): boolean {
    if (!this.client || this.status.state !== 'connected') return false;
    const message = String(text || '').slice(0, 200);
    if (!message.trim()) return false;
    try {
      this.client.queue('text', {
        type: 'chat',
        needs_translation: false,
        source_name: this.status.username,
        message,
        xuid: '',
        platform_chat_id: '',
        filtered_message: '',
      });
      return true;
    } catch {
      return false;
    }
  }

  disconnect(reason = 'user'): void {
    const c = this.client;
    this.client = null;
    if (c) { try { c.disconnect(reason); } catch { /* ignore */ } }
    if (this.status.state !== 'disconnected') {
      this.setStatus({ state: 'disconnected', message: '切断しました', position: null });
    }
  }
}
