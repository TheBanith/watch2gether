import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  received_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_by TEXT,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_room ON files(room_id);
CREATE INDEX IF NOT EXISTS idx_queue_room ON queue_items(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  PRIMARY KEY (file_id, idx)
);
`;

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'watch2gether.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumn(db, 'files', 'play_file', 'TEXT');
  ensureColumn(db, 'files', 'play_mime', 'TEXT');
  return db;
}

function ensureColumn(db, table, column, type) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Stored on-disk name for the originally uploaded bytes: <id>.<ext>
export function storedFileName(file) {
  const ext = (file.filename.split('.').pop() || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5);
  return ext ? `${file.id}.${ext}` : file.id;
}

export function createRoom(db, name) {
  const insert = db.prepare(
    'INSERT INTO rooms (id, code, name, created_at) VALUES (?, ?, ?, ?)'
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const room = {
      id: randomUUID(),
      code: makeCode(),
      name,
      created_at: Date.now(),
    };
    try {
      insert.run(room.id, room.code, room.name, room.created_at);
      return room;
    } catch (err) {
      if (err?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    }
  }
  throw new Error('Could not generate a unique room code');
}

export function getRoomByCode(db, code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) ?? null;
}

export function getRoomById(db, id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) ?? null;
}

export function deleteRoom(db, id) {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

export function createFile(db, roomId, filename, size, mime) {
  const file = {
    id: randomUUID(),
    room_id: roomId,
    filename,
    size,
    mime: mime || null,
    status: 'uploading',
    received_bytes: 0,
    created_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO files (id, room_id, filename, size, mime, status, received_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    file.id,
    file.room_id,
    file.filename,
    file.size,
    file.mime,
    file.status,
    file.received_bytes,
    file.created_at
  );
  return file;
}

export function getFile(db, id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) ?? null;
}

export function listRoomFiles(db, roomId) {
  return db
    .prepare('SELECT * FROM files WHERE room_id = ? ORDER BY created_at ASC')
    .all(roomId);
}

export function addChunk(db, fileId, idx, bytes) {
  const info = db
    .prepare('INSERT OR IGNORE INTO file_chunks (file_id, idx) VALUES (?, ?)')
    .run(fileId, idx);
  if (info.changes > 0) {
    db.prepare('UPDATE files SET received_bytes = received_bytes + ? WHERE id = ?').run(
      bytes,
      fileId
    );
  }
}

export function getReceivedChunks(db, fileId) {
  return db
    .prepare('SELECT idx FROM file_chunks WHERE file_id = ? ORDER BY idx ASC')
    .all(fileId)
    .map((row) => row.idx);
}

export function setFileStatus(db, id, status) {
  db.prepare('UPDATE files SET status = ? WHERE id = ?').run(status, id);
}

export function setPlayOutput(db, id, playFile, playMime) {
  db.prepare('UPDATE files SET play_file = ?, play_mime = ? WHERE id = ?').run(
    playFile,
    playMime,
    id
  );
}

export function listProcessing(db) {
  return db.prepare("SELECT * FROM files WHERE status = 'processing'").all();
}

export function addMessage(db, roomId, sender, body) {
  const info = db
    .prepare('INSERT INTO messages (room_id, sender, body, created_at) VALUES (?, ?, ?, ?)')
    .run(roomId, sender, body, Date.now());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

export function listMessages(db, roomId, limit = 50) {
  return db
    .prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?')
    .all(roomId, limit)
    .reverse();
}

export function pruneMessages(db, roomId, keep = 200) {
  db.prepare(
    `DELETE FROM messages WHERE room_id = ?
     AND id NOT IN (SELECT id FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(roomId, roomId, keep);
}

export function addQueueItem(db, roomId, fileId, title, addedBy) {
  const pos = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM queue_items WHERE room_id = ?')
    .get(roomId).p;
  const info = db
    .prepare(
      'INSERT INTO queue_items (room_id, file_id, title, position, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(roomId, fileId, title, pos, addedBy, Date.now());
  return info.lastInsertRowid;
}

export function listQueue(db, roomId) {
  return db
    .prepare(
      `SELECT q.id, q.file_id AS fileId, q.title, q.added_by AS addedBy,
              f.status AS fileStatus
       FROM queue_items q LEFT JOIN files f ON f.id = q.file_id
       WHERE q.room_id = ? ORDER BY q.position ASC, q.id ASC`
    )
    .all(roomId);
}

export function getQueueItem(db, roomId, itemId) {
  return (
    db.prepare('SELECT * FROM queue_items WHERE id = ? AND room_id = ?').get(itemId, roomId) ??
    null
  );
}

export function removeQueueItem(db, roomId, itemId) {
  return (
    db.prepare('DELETE FROM queue_items WHERE id = ? AND room_id = ?').run(itemId, roomId)
      .changes > 0
  );
}

export function moveQueueItem(db, roomId, itemId, dir) {
  const items = listQueue(db, roomId);
  const i = items.findIndex((x) => x.id === Number(itemId));
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= items.length) return false;
  const a = items[i];
  const b = items[j];
  const upd = db.prepare('UPDATE queue_items SET position = ? WHERE id = ?');
  const aPos = db.prepare('SELECT position FROM queue_items WHERE id = ?').get(a.id).position;
  const bPos = db.prepare('SELECT position FROM queue_items WHERE id = ?').get(b.id).position;
  upd.run(bPos, a.id);
  upd.run(aPos, b.id);
  return true;
}

export function popQueueHead(db, roomId) {
  const head = db
    .prepare('SELECT * FROM queue_items WHERE room_id = ? ORDER BY position ASC, id ASC LIMIT 1')
    .get(roomId);
  if (head) db.prepare('DELETE FROM queue_items WHERE id = ?').run(head.id);
  return head ?? null;
}

export function listAllFiles(db) {
  return db.prepare('SELECT * FROM files').all();
}

export function removeQueueItemsByFile(db, roomId, fileId) {
  db.prepare('DELETE FROM queue_items WHERE room_id = ? AND file_id = ?').run(roomId, fileId);
}

export function deleteFile(db, id) {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
}

export function cleanupStaleUploads(db, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  return db
    .prepare("SELECT * FROM files WHERE status = 'uploading' AND created_at < ?")
    .all(cutoff);
}
