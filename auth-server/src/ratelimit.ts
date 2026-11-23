import { config } from './config.js';
import { getRedis, redisStatus } from './redis.js';

// ログイン試行レート制限。
// - REDIS_URL 未設定: メモリ内実装（開発/単一インスタンス用）
// - REDIS_URL 設定時: Redis 実装（複数インスタンスで共有）
// - Redis 設定済みだが接続不可: 'unavailable' を返し、呼び出し側はフェイルクローズ（拒否）する。
//   メモリへの静かなフォールバックは行わない（複数インスタンスで制限が無効化されるのを防ぐ）。

export type LimitResult = 'allow' | 'deny' | 'unavailable';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// ---------- メモリ実装（開発/テスト） ----------
const memFails = new Map<string, { count: number; lockedUntil: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memFails) if (v.lockedUntil < now && v.count === 0) memFails.delete(k);
}, 60 * 1000).unref();

function memCheck(key: string): LimitResult {
  const e = memFails.get(key);
  return e && e.lockedUntil > Date.now() ? 'deny' : 'allow';
}
function memFail(key: string): void {
  const e = memFails.get(key) || { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAILS) { e.lockedUntil = Date.now() + LOCK_MS; e.count = 0; }
  memFails.set(key, e);
}
function memClear(key: string): void { memFails.delete(key); }

// ---------- Redis 実装 ----------
// fail key: rl:fail:{key}（失敗カウンタ、LOCK_MSでexpire）
// lock key: rl:lock:{key}（ロック中フラグ、LOCK_MSでexpire）
async function redisCheck(key: string): Promise<LimitResult> {
  const r = getRedis();
  if (!r || redisStatus() !== 'ready') return 'unavailable';
  try {
    const locked = await r.exists(`rl:lock:${key}`);
    return locked ? 'deny' : 'allow';
  } catch { return 'unavailable'; }
}
async function redisFail(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const count = await r.incr(`rl:fail:${key}`);
    if (count === 1) await r.pexpire(`rl:fail:${key}`, LOCK_MS);
    if (count >= MAX_FAILS) {
      await r.set(`rl:lock:${key}`, '1', 'PX', LOCK_MS);
      await r.del(`rl:fail:${key}`);
    }
  } catch { /* unavailable は check 側で判定 */ }
}
async function redisClear(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try { await r.del(`rl:fail:${key}`, `rl:lock:${key}`); } catch { /* ignore */ }
}

// ---------- 公開API ----------
export async function checkLoginLimit(key: string): Promise<LimitResult> {
  if (!config.redis.url) return memCheck(key);
  return redisCheck(key);
}
export async function recordLoginFail(key: string): Promise<void> {
  if (!config.redis.url) { memFail(key); return; }
  await redisFail(key);
}
export async function clearLoginFails(key: string): Promise<void> {
  if (!config.redis.url) { memClear(key); return; }
  await redisClear(key);
}
