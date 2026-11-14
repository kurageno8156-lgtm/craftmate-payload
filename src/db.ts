import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// DBファイルはアンインストール後も残る %LOCALAPPDATA%\CraftMate に保存する
const dataDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CraftMate');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'craftmate.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
`);

// ---- チャットルーム ----
export interface ChatRoomRow { id: string; title: string; created_at: number; }
export interface ChatMessageRow { id: number; room_id: string; sender: string; content: string; created_at: number; }

export function listChatRooms(): ChatRoomRow[] {
  return db.prepare('SELECT id, title, created_at FROM chat_rooms ORDER BY created_at DESC').all() as ChatRoomRow[];
}

export function createChatRoom(id: string, title: string): ChatRoomRow {
  const createdAt = Date.now();
  db.prepare('INSERT OR REPLACE INTO chat_rooms (id, title, created_at) VALUES (?, ?, ?)').run(id, title, createdAt);
  return { id, title, created_at: createdAt };
}

export function setChatRoomTitleIfEmpty(id: string, title: string): void {
  db.prepare("UPDATE chat_rooms SET title = ? WHERE id = ? AND (title IS NULL OR title = '')").run(title.slice(0, 100), id);
}

export function deleteChatRoom(id: string): void {
  db.prepare('DELETE FROM chat_messages WHERE room_id = ?').run(id);
  db.prepare('DELETE FROM chat_rooms WHERE id = ?').run(id);
}

export function listChatMessages(roomId: string): ChatMessageRow[] {
  return db.prepare('SELECT id, room_id, sender, content, created_at FROM chat_messages WHERE room_id = ? ORDER BY id ASC').all(roomId) as ChatMessageRow[];
}

export function addChatMessage(roomId: string, sender: string, content: string): ChatMessageRow {
  const createdAt = Date.now();
  const result = db.prepare('INSERT INTO chat_messages (room_id, sender, content, created_at) VALUES (?, ?, ?, ?)').run(roomId, sender, content, createdAt);
  return { id: Number(result.lastInsertRowid), room_id: roomId, sender, content, created_at: createdAt };
}

// ---- AI記憶 ----
export function addAiMemory(requester: string, task: string, outcome: string): void {
  db.prepare('INSERT INTO ai_memory (requester, task, outcome, created_at) VALUES (?, ?, ?, ?)').run(requester, task.slice(0, 500), outcome, Date.now());
  // 古い記憶は最大200件まで保持
  db.prepare('DELETE FROM ai_memory WHERE id NOT IN (SELECT id FROM ai_memory ORDER BY id DESC LIMIT 200)').run();
}

export function getRecentAiMemory(limit = 8): Array<{ requester: string; task: string; outcome: string; created_at: number }> {
  return db.prepare('SELECT requester, task, outcome, created_at FROM ai_memory ORDER BY id DESC LIMIT ?').all(limit) as any[];
}

// ---- レビュー ----
export interface ReviewRow { id: number; rating: number; name: string; comment: string; created_at: number; }

export function listReviews(): { reviews: ReviewRow[]; average: number; count: number } {
  const reviews = db.prepare('SELECT id, rating, name, comment, created_at FROM reviews ORDER BY id DESC LIMIT 200').all() as ReviewRow[];
  const count = reviews.length;
  const average = count > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
  return { reviews, average: Math.round(average * 10) / 10, count };
}

export function addReview(rating: number, name: string, comment: string): ReviewRow {
  const createdAt = Date.now();
  const result = db.prepare('INSERT INTO reviews (rating, name, comment, created_at) VALUES (?, ?, ?, ?)').run(rating, name.slice(0, 30), comment.slice(0, 1000), createdAt);
  return { id: Number(result.lastInsertRowid), rating, name, comment, created_at: createdAt };
}
