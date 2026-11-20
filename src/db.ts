import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// DBファイルはアンインストール後も残る %LOCALAPPDATA%\CraftMate に保存する
const dataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CraftMate');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'craftmate.db');

// CRAFTMATE_USE_SQLJS=1 で純粋JSの sql.js（WASM）モードに切り替わる。
// better-sqlite3 がネイティブクラッシュ（SIGSEGV）する環境（WSL等）向けの
// 互換モード。Electron 側がクラッシュ検知時に自動でこの環境変数を付けて再起動する。
const useSqlJs = process.env.CRAFTMATE_USE_SQLJS === '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, id);
CREATE TABLE IF NOT EXISTS ai_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rating INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  platform TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'connected',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// ---- DB 初期化（モード分岐）----
let nativeDb: any = null;   // better-sqlite3 Database
let sqlJsDb: any = null;    // sql.js Database
let persistTimer: NodeJS.Timeout | null = null;

if (useSqlJs) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(here, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  // 既存DBファイルがあれば読み込み、無ければ空のインメモリDB
  if (fs.existsSync(dbFile)) {
    try {
      sqlJsDb = new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)));
    } catch {
      sqlJsDb = new SQL.Database();
    }
  } else {
    sqlJsDb = new SQL.Database();
  }
  sqlJsDb.exec(SCHEMA);
  // sql.js はインメモリDBのため、定期的にディスクへ書き出す
  const persist = () => {
    try {
      const data = Buffer.from(sqlJsDb.export());
      fs.writeFileSync(dbFile, data);
    } catch (e) {
      console.error('[DB] sql.js persist failed:', (e as Error).message);
    }
  };
  persistTimer = setInterval(persist, 20000);
  persistTimer.unref();
  process.on('exit', persist);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { persist(); process.exit(0); });
  }
  console.log('[DB] sql.js compatibility mode (better-sqlite3 disabled, data persisted every 20s)');
} else {
  const Database = (await import('better-sqlite3')).default;
  nativeDb = new Database(dbFile);
  nativeDb.pragma('journal_mode = WAL');
  nativeDb.exec(SCHEMA);
}

// ---- better-sqlite3 互換 prepare ラッパー ----
interface PreparedStatement {
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
}

function sqlJsPrepare(sql: string): PreparedStatement {
  return {
    all(...params: any[]) {
      const stmt = sqlJsDb.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        const rows: any[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    run(...params: any[]) {
      const stmt = sqlJsDb.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        while (stmt.step()) { /* execute */ }
        const lid = sqlJsDb.exec('SELECT last_insert_rowid() AS id');
        return {
          changes: sqlJsDb.getRowsModified(),
          lastInsertRowid: Number(lid[0].values[0][0]),
        };
      } finally {
        stmt.free();
      }
    },
  };
}

function prepare(sql: string): PreparedStatement {
  if (useSqlJs) return sqlJsPrepare(sql);
  return nativeDb.prepare(sql);
}

// ---- チャットルーム ----
export interface ChatRoomRow { id: string; title: string; created_at: number; }
export interface ChatMessageRow { id: number; room_id: string; sender: string; content: string; created_at: number; }

export function listChatRooms(): ChatRoomRow[] {
  return prepare('SELECT id, title, created_at FROM chat_rooms ORDER BY created_at DESC').all() as ChatRoomRow[];
}

export function createChatRoom(id: string, title: string): ChatRoomRow {
  const createdAt = Date.now();
  prepare('INSERT OR REPLACE INTO chat_rooms (id, title, created_at) VALUES (?, ?, ?)').run(id, title, createdAt);
  return { id, title, created_at: createdAt };
}

export function setChatRoomTitleIfEmpty(id: string, title: string): void {
  prepare("UPDATE chat_rooms SET title = ? WHERE id = ? AND (title IS NULL OR title = '')").run(title.slice(0, 100), id);
}

export function renameChatRoom(id: string, title: string): void {
  prepare('UPDATE chat_rooms SET title = ? WHERE id = ?').run(title.slice(0, 100), id);
}

export function deleteChatRoom(id: string): void {
  prepare('DELETE FROM chat_messages WHERE room_id = ?').run(id);
  prepare('DELETE FROM chat_rooms WHERE id = ?').run(id);
}

export function listChatMessages(roomId: string): ChatMessageRow[] {
  return prepare('SELECT id, room_id, sender, content, created_at FROM chat_messages WHERE room_id = ? ORDER BY id ASC').all(roomId) as ChatMessageRow[];
}

export function addChatMessage(roomId: string, sender: string, content: string): ChatMessageRow {
  const createdAt = Date.now();
  const result = prepare('INSERT INTO chat_messages (room_id, sender, content, created_at) VALUES (?, ?, ?, ?)').run(roomId, sender, content, createdAt);
  return { id: Number(result.lastInsertRowid), room_id: roomId, sender, content, created_at: createdAt };
}

// ---- AI記憶 ----
export function addAiMemory(requester: string, task: string, outcome: string): void {
  prepare('INSERT INTO ai_memory (requester, task, outcome, created_at) VALUES (?, ?, ?, ?)').run(requester, task.slice(0, 500), outcome, Date.now());
  // 古い記憶は最大200件まで保持
  prepare('DELETE FROM ai_memory WHERE id NOT IN (SELECT id FROM ai_memory ORDER BY id DESC LIMIT 200)').run();
}

export function getRecentAiMemory(limit = 8): Array<{ requester: string; task: string; outcome: string; created_at: number }> {
  return prepare('SELECT requester, task, outcome, created_at FROM ai_memory ORDER BY id DESC LIMIT ?').all(limit) as any[];
}

// ---- レビュー ----
export interface ReviewRow { id: number; rating: number; name: string; comment: string; created_at: number; }

export function listReviews(): { reviews: ReviewRow[]; average: number; count: number } {
  const reviews = prepare('SELECT id, rating, name, comment, created_at FROM reviews ORDER BY id DESC LIMIT 200').all() as ReviewRow[];
  const count = reviews.length;
  const average = count > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
  return { reviews, average: Math.round(average * 10) / 10, count };
}

export function addReview(rating: number, name: string, comment: string): ReviewRow {
  const createdAt = Date.now();
  const result = prepare('INSERT INTO reviews (rating, name, comment, created_at) VALUES (?, ?, ?, ?)').run(rating, name.slice(0, 30), comment.slice(0, 1000), createdAt);
  return { id: Number(result.lastInsertRowid), rating, name, comment, created_at: createdAt };
}

export function isSqlJsMode(): boolean {
  return useSqlJs;
}

// ---- 外部サービス連携 ----
export interface IntegrationRow {
  platform: string;
  status: string;
  payload: string; // 暗号化済みJSON文字列
  created_at: number;
  updated_at: number;
}

export function listIntegrations(): IntegrationRow[] {
  return prepare('SELECT platform, status, payload, created_at, updated_at FROM integrations ORDER BY platform').all() as IntegrationRow[];
}

export function getIntegration(platform: string): IntegrationRow | undefined {
  const rows = prepare('SELECT platform, status, payload, created_at, updated_at FROM integrations WHERE platform = ?').all(platform) as IntegrationRow[];
  return rows[0];
}

export function upsertIntegration(platform: string, status: string, payload: string): void {
  const now = Date.now();
  prepare(`INSERT INTO integrations (platform, status, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(platform) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`)
    .run(platform, status, payload, now, now);
}

export function deleteIntegration(platform: string): void {
  prepare('DELETE FROM integrations WHERE platform = ?').run(platform);
}
