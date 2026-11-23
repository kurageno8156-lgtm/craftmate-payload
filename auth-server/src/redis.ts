import { Redis } from 'ioredis';
import { config } from './config.js';

// Redis: REDIS_URL 設定時のみ接続。未設定時は null（レート制限はメモリ実装）。
// 接続失敗時は「レート制限無効」ではなく「利用不可」として扱い、
// 呼び出し側でフェイルクローズ（拒否）する設計。秘密情報はログに出さない。
let client: Redis | null = null;
let status: 'disabled' | 'connecting' | 'ready' | 'error' = 'disabled';

export function getRedis(): Redis | null { return client; }
export function redisStatus(): string { return status; }

export async function initRedis(): Promise<void> {
  if (!config.redis.url) { status = 'disabled'; return; }
  status = 'connecting';
  client = new Redis(config.redis.url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false, // 障害時にリクエストを滞留させない
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 500, 10000),
  });
  client.on('ready', () => { status = 'ready'; });
  client.on('error', () => { status = 'error'; }); // URL等を含み得るため詳細は出さない
  client.on('close', () => { if (status === 'ready') status = 'error'; });
  try {
    await client.ping();
    status = 'ready';
  } catch {
    status = 'error';
    // 起動は継続するが、Redis依存機能は利用不可として扱う
    console.error('[craftmate-auth] redis: connection failed (rate limiting will fail closed)');
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    try { await client.quit(); } catch { /* ignore */ }
    client = null;
  }
  status = 'disabled';
}
