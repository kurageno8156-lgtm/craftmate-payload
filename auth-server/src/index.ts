import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { config } from './config.js';
import { initDb, closeDb, purgeDeletedUsers } from './db.js';
import { initRedis, closeRedis, redisStatus } from './redis.js';
import { createApp } from './server.js';

export interface RunningServer {
  server: Server;
  shutdown: (reason?: string) => Promise<void>;
}

export async function start(): Promise<RunningServer> {
  await initDb();          // DATABASE_URL 接続失敗時はここで例外 → 安全に起動中止
  await initRedis();       // Redis 未設定なら disabled、設定済みで失敗なら error（フェイルクローズ側で処理）
  const app = createApp();

  const server = app.listen(config.port, config.bindHost);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  console.log(`[craftmate-auth] listening on http://${config.bindHost}:${config.port}`);
  console.log(`[craftmate-auth] public URL: ${config.publicUrl}`);
  console.log(`[craftmate-auth] db driver: ${config.db.url ? 'postgresql' : 'pglite (dev)'}`);
  console.log(`[craftmate-auth] redis: ${redisStatus()}`);
  console.log(`[craftmate-auth] node env: ${config.nodeEnv}`);
  if (config.insecureHttpAllowed) {
    console.log('[craftmate-auth] WARNING: AUTH_DEV_INSECURE_HTTP=1 (local dev only, no TLS)');
  }

  // リクエストタイムアウト
  server.requestTimeout = config.server.requestTimeoutMs;
  server.headersTimeout = config.server.headersTimeoutMs;
  server.keepAliveTimeout = config.server.keepAliveTimeoutMs;

  // Graceful Shutdown
  let shuttingDown = false;
  const shutdown = async (reason = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[craftmate-auth] ${reason} received, shutting down gracefully`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 猶予10秒で強制終了
      setTimeout(() => { console.error('[craftmate-auth] forced exit after grace period'); process.exit(1); }, 10000).unref();
    });
    try { await closeRedis(); } catch { /* ignore */ }
    try { await closeDb(); } catch { /* ignore */ }
    console.log('[craftmate-auth] shutdown complete');
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 削除済みアカウントの物理削除ジョブ（既定30日保持。ACCOUNT_PURGE_DAYS=0 で無効）
  const purgeDays = Number(process.env.ACCOUNT_PURGE_DAYS ?? '30');
  if (Number.isFinite(purgeDays) && purgeDays > 0) {
    const runPurge = async () => {
      try {
        const n = await purgeDeletedUsers(purgeDays);
        if (n > 0) console.log(`[craftmate-auth] purged ${n} deleted account(s)`);
      } catch (e) { console.error('[craftmate-auth] purge failed:', (e as Error).message); }
    };
    void runPurge();
    setInterval(() => void runPurge(), 24 * 60 * 60 * 1000).unref();
  }

  return { server, shutdown };
}

// エントリーポイントとして直接実行された場合のみ main を実行
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((e) => {
    console.error('[craftmate-auth] fatal:', (e as Error).message || e);
    process.exit(1);
  });
}
