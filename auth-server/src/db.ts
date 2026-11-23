import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { config } from './config.js';

// DB ドライバー: DATABASE_URL 設定時は実PostgreSQL（node-postgres Pool）、
// 未設定時は PGlite（組み込みPostgreSQL/WASM、開発・テスト専用）。
// いずれも標準的な PostgreSQL 構文のみ使用し、FOR UPDATE / トランザクション / JSONB を利用する。
type Driver = 'pglite' | 'pg';
let driver: Driver;
let pglite: PGlite | null = null;
let pool: pg.Pool | null = null;

interface Queryable {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

export async function initDb() {
  if (config.db.url) {
    pool = new pg.Pool({
      connectionString: config.db.url,
      ssl: config.db.ssl === 'require' ? { rejectUnauthorized: true }
        : config.db.ssl === 'prefer' ? { rejectUnauthorized: false }
        : false,
      max: 10,
      connectionTimeoutMillis: 10000,
    });
    // 接続確認: 失敗時は例外を投げて安全に起動を中止する
    await pool.query('SELECT 1');
    driver = 'pg';
  } else {
    fs.mkdirSync(config.db.dataDir, { recursive: true });
    pglite = new PGlite(config.db.pgliteDir);
    await pglite.waitReady;
    driver = 'pglite';
  }
  await exec(SCHEMA);
}

export function dbDriver(): Driver { return driver; }

export async function pingDb(): Promise<boolean> {
  try {
    if (driver === 'pg' && pool) { await pool.query('SELECT 1'); return true; }
    if (driver === 'pglite' && pglite) { await pglite.query('SELECT 1'); return true; }
    return false;
  } catch { return false; }
}

export async function closeDb() {
  try { if (pool) await pool.end(); } catch { /* ignore */ }
  try { if (pglite) await pglite.close(); } catch { /* ignore */ }
  pool = null; pglite = null;
}

function base(): Queryable {
  if (driver === 'pg' && pool) return pool as unknown as Queryable;
  if (driver === 'pglite' && pglite) return pglite as unknown as Queryable;
  throw new Error('DB not initialized');
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await base().query(sql, params);
  return res.rows as T[];
}
export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
export async function exec(sql: string) {
  // PGlite は exec、node-postgres は複数文を simple query として実行可能
  if (driver === 'pglite' && pglite) { await pglite.exec(sql); return; }
  await base().query(sql);
}
// トランザクション: fn 内で t.query を使用
export async function tx<T>(fn: (t: { query: typeof query }) => Promise<T>): Promise<T> {
  if (driver === 'pglite' && pglite) {
    return pglite.transaction(async (t) => {
      const tq = async <R = any>(sql: string, params: any[] = []): Promise<R[]> =>
        (await t.query(sql, params)).rows as R[];
      return fn({ query: tq as any });
    }) as Promise<T>;
  }
  if (driver === 'pg' && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tq = async <R = any>(sql: string, params: any[] = []): Promise<R[]> =>
        (await client.query(sql, params)).rows as R[];
      const result = await fn({ query: tq as any });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  throw new Error('DB not initialized');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320),                        -- 表示用。認証の根拠にしないため UNIQUE にしない（v2.2: メール一致での自動統合を行わない）
  display_name VARCHAR(100) NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  email_verified BOOLEAN NOT NULL DEFAULT false,
  password_hash VARCHAR(255),                  -- メール+パスワード認証用。OAuth専用ユーザーは NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deletion_scheduled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider VARCHAR(20) NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL DEFAULT '',
  email VARCHAR(320) NOT NULL DEFAULT '',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_family_id UUID NOT NULL,
  refresh_token_hash VARCHAR(64) NOT NULL,
  token_history JSONB NOT NULL DEFAULT '[]',
  device_info JSONB NOT NULL DEFAULT '{}',
  ip_address INET,
  provider VARCHAR(32) NOT NULL DEFAULT 'google',  -- 発行時の認証方式（google/password等）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoke_reason VARCHAR(50)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(token_family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token_hash);

CREATE TABLE IF NOT EXISTS oauth_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state VARCHAR(64) NOT NULL UNIQUE,
  provider VARCHAR(20) NOT NULL,
  code_verifier TEXT NOT NULL,
  code_challenge VARCHAR(128) NOT NULL,
  nonce VARCHAR(64),
  token_code_challenge VARCHAR(128),          -- 第2PKCE（Desktop↔Auth Server）
  client_state VARCHAR(128),                  -- Desktop 側 state（コールバックでエコー）
  redirect_uri TEXT NOT NULL,
  device_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_expires ON oauth_flows(expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_codes (
  code VARCHAR(64) PRIMARY KEY,
  flow_id UUID NOT NULL REFERENCES oauth_flows(id),
  user_id UUID NOT NULL REFERENCES users(id),
  state VARCHAR(64) NOT NULL,
  client_state VARCHAR(128),
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  purpose VARCHAR(30) NOT NULL,               -- verify_email | reset_password | change_email
  token_hash VARCHAR(64) NOT NULL,            -- SHA-256ハッシュのみ保存（平文は保存しない）
  new_email VARCHAR(320),                     -- change_email 用の新アドレス
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_expires ON email_tokens(expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  event VARCHAR(50) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event, created_at DESC);

-- 既存DB向けマイグレーション（冪等）
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'google';
-- メール認証ユーザー間でのみメールアドレスを一意にする。
-- OAuth専用ユーザー（password_hash IS NULL）は対象外のため、
-- 同一メールの OAuth アカウントと内部アカウントは自動統合されず共存できる。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_credential_email
  ON users (lower(email)) WHERE password_hash IS NOT NULL AND deleted_at IS NULL;
`;

// ---------- アカウント削除の物理削除 ----------
// ソフトデリート（deleted_at 設定）から retentionDays 経過したユーザーを物理削除する。
// 保持期間の設計: deleted_at から ACCOUNT_PURGE_DAYS 日（既定30日）。
// 物理削除時は関連行（sessions/external_identities/email_tokens）を先に削除し、
// audit_logs は user_id を NULL にして証跡を保持する（個人情報は users 行ごと消える）。
export async function purgeDeletedUsers(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  return tx(async (t) => {
    const doomed = await t.query<any>(
      `SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < $1`, [cutoff]
    );
    if (!doomed.length) return 0;
    const ids = doomed.map((r) => r.id);
    for (const id of ids) {
      await t.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await t.query(`DELETE FROM external_identities WHERE user_id = $1`, [id]);
      await t.query(`DELETE FROM email_tokens WHERE user_id = $1`, [id]);
      // oauth_codes.flow_id → oauth_flows(id) のFKがあるため、
      // コード削除で参照が切れた後にフローを削除する。
      // 他ユーザーのコードが同じフローを参照する場合に備え、
      // 残存コードが無いフローのみ削除する（NOT EXISTS で安全側に倒す）。
      const flows = await t.query<{ flow_id: string }>(
        `SELECT DISTINCT flow_id FROM oauth_codes WHERE user_id = $1`, [id]
      );
      await t.query(`DELETE FROM oauth_codes WHERE user_id = $1`, [id]);
      if (flows.length) {
        await t.query(
          `DELETE FROM oauth_flows f WHERE f.id = ANY($1)
             AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.flow_id = f.id)`,
          [flows.map((r) => r.flow_id)]
        );
      }
      await t.query(`UPDATE audit_logs SET user_id = NULL WHERE user_id = $1`, [id]);
      await t.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
    return ids.length;
  });
}

// ---------- ヘルパー ----------
export async function audit(event: string, userId: string | null, meta: Record<string, unknown> = {}, ip: string | null = '', ua = '') {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, event, ip_address, user_agent, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [userId, event, ip || null, ua.slice(0, 300) || null, JSON.stringify(meta)]
    );
  } catch { /* 監査ログ失敗で認証を止めない */ }
}
