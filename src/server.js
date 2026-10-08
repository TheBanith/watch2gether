import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  createRoom,
  getRoomByCode,
  createFile,
  getFile,
  listRoomFiles,
  listProcessing,
  addChunk,
  getReceivedChunks,
  setFileStatus,
  storedFileName,
  addMessage,
  listMessages,
  pruneMessages,
  addQueueItem,
  listQueue,
  getQueueItem,
  removeQueueItem,
  moveQueueItem,
  popQueueHead,
  listAllFiles,
  removeQueueItemsByFile,
  deleteRoom,
  deleteFile,
  cleanupStaleUploads,
} from './db.js';
import { initMedia, enqueue } from './media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 6144;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

// TURN/STUN for WebRTC. Cross-network calls need a TURN relay when either
// peer is behind a symmetric NAT. Credentials are short-lived HMAC tokens
// derived from a shared secret (coturn `use-auth-secret` scheme).
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_TTL = Number(process.env.TURN_TTL) || 12 * 60 * 60; // seconds

function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_SECRET && TURN_HOST) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}`;
    const credential = crypto
      .createHmac('sha1', TURN_SECRET)
      .update(username)
      .digest('base64');
    list.push({
      urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`],
      username,
      credential,
    });
  }
  return list;
}

const db = openDb(DATA_DIR);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Remove .part files left behind by abandoned uploads.
for (const stale of cleanupStaleUploads(db, STALE_UPLOAD_MS)) {
  try {
    fs.unlinkSync(partPath(stale.id));
  } catch {
    /* already gone */
  }
  deleteFile(db, stale.id);
}

// Remove disk files no DB row references (crash leftovers).
{
  const referenced = new Set();
  for (const f of listAllFiles(db)) {
    referenced.add(`${f.id}.part`);
    referenced.add(storedFileName(f));
    if (f.play_file) referenced.add(path.basename(f.play_file));
  }
  let removed = 0;
  for (const entry of fs.readdirSync(UPLOAD_DIR)) {
    if (!referenced.has(entry)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, entry));
        removed++;
      } catch {
        /* best effort */
      }
    }
  }
  if (removed > 0) console.log(`Removed ${removed} orphaned upload file(s)`);
}

function partPath(fileId) {
  return path.join(UPLOAD_DIR, `${fileId}.part`);
}

function finalPath(file) {
  return path.join(UPLOAD_DIR, storedFileName(file));
}

function totalChunksFor(size) {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

function expectedChunkSize(file, idx) {
  const start = idx * CHUNK_SIZE;
  return Math.min(CHUNK_SIZE, file.size - start);
}

function publicFile(file) {
  return {
    id: file.id,
    filename: file.filename,
    size: file.size,
    mime: file.mime,
    status: file.status,
    receivedBytes: file.received_bytes,
  };
}
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Fresh ICE servers (incl. short-lived TURN creds) for the WebRTC clients.
app.get('/api/ice', (_req, res) => res.json({ iceServers: iceServers() }));

app.post('/api/rooms', (req, res) => {
  const name = String(req.body?.name || 'Movie night').slice(0, 80);
  try {
    const room = createRoom(db, name);
    touchActivity(room.id);
    res.status(201).json({
      id: room.id,
      code: room.code,
      name: room.name,
      url: `/room.html?code=${room.code}`,
    });
  } catch {
    res.status(500).json({ error: 'Could not create room' });
  }
});

app.get('/api/rooms/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const room = getRoomByCode(db, code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    id: room.id,
    code: room.code,
    name: room.name,
    memberCount: membersOf(room.id).length,
  });
});

const httpServer = createServer(app);
const io = new Server(httpServer);

initMedia({ db, io, uploadDir: UPLOAD_DIR });

// roomId -> Map(socketId -> { displayName })
const members = new Map();

function membersOf(roomId) {
  const room = members.get(roomId);
  if (!room) return [];
  return [...room.entries()].map(([socketId, m]) => ({
    socketId,
    displayName: m.displayName,
  }));
}

function broadcastMembers(roomId) {
  io.to(roomId).emit('room:members', membersOf(roomId));
}

// Authoritative playback state per room: { fileId, playing, mediaTime, updatedAt, rate }
const syncStates = new Map();

function broadcastSync(roomId) {
  const st = syncStates.get(roomId);
  if (st) io.to(roomId).emit('sync:state', st);
}

function publicMessage(row) {
  return { id: row.id, sender: row.sender, body: row.body, createdAt: row.created_at };
}

// roomId -> timestamp of last activity (for idle cleanup)
const roomActivity = new Map();

// roomId -> timestamp when the room became empty (for empty-room cleanup)
const emptySince = new Map();

function touchActivity(roomId) {
  if (roomId) roomActivity.set(roomId, Date.now());
}

// socketId -> timestamp of last accepted chat message (spam throttle)
const lastChatAt = new Map();

// roomId -> timestamp of last queue advance (stops double-advance when
// both viewers' 'ended' events arrive)
const lastAdvance = new Map();
const ADVANCE_GUARD_MS = 5000;

// roomId -> Map(socketId -> { filter, overlay }) for camera effects.
// Memory-only; entries are removed when a socket leaves the room.
const fxByRoom = new Map();
const FX_FILTERS = new Set(['none', 'noir', 'retro', 'dream', 'neon', 'frost', 'acid']);
const FX_OVERLAYS = new Set([
  'none', 'sparkles', 'hearts', 'embers', 'neon', 'rainbow',
  'starfall', 'matrix', 'fireworks', 'petals', 'bubbles',
  'film', 'frost', 'fire', 'gold',
]);

// roomId -> Set(socketId) of people currently in the voice/video call.
// Peers only establish WebRTC connections with others in this set, so the
// offer/answer handshake can't deadlock on join order.
const callMembers = new Map();

function callMembersOf(roomId) {
  return [...(callMembers.get(roomId) || [])];
}

function broadcastCallMembers(roomId) {
  io.to(roomId).emit('call:members', callMembersOf(roomId));
}

function leaveCallSet(roomId, socketId) {
  const set = callMembers.get(roomId);
  if (!set) return;
  if (set.delete(socketId)) {
    if (set.size === 0) callMembers.delete(roomId);
    broadcastCallMembers(roomId);
  }
}

function broadcastQueue(roomId) {
  io.to(roomId).emit('queue:state', listQueue(db, roomId));
}

function loadFileForRoom(roomId, file) {
  syncStates.set(roomId, {
    fileId: file.id,
    playing: false,
    mediaTime: 0,
    updatedAt: Date.now(),
    rate: 1,
  });
  broadcastSync(roomId);
}

function cleanName(value) {
  return String(value || 'Guest').trim().slice(0, 30) || 'Guest';
}

io.on('connection', (socket) => {
  let joinedRoomId = null;

  // Any member event counts as room activity (idle cleanup).
  socket.use((packet, next) => {
    if (joinedRoomId) touchActivity(joinedRoomId);
    next();
  });

  socket.on('room:join', ({ code, displayName } = {}) => {
    const room = getRoomByCode(db, String(code || '').toUpperCase().trim());
    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Check the code.' });
      return;
    }
    joinedRoomId = room.id;
    socket.join(room.id);
    socket.data.roomId = room.id;
    touchActivity(room.id);
    emptySince.delete(room.id); // someone's here: cancel empty-room countdown
    if (!members.has(room.id)) members.set(room.id, new Map());
    members.get(room.id).set(socket.id, { displayName: cleanName(displayName) });
    socket.emit('room:joined', {
      room: { id: room.id, code: room.code, name: room.name },
    });
    broadcastMembers(room.id);
    // Late joiner catches up to whatever is playing.
    const current = syncStates.get(room.id);
    if (current) socket.emit('sync:state', current);
    socket.emit(
      'chat:history',
      listMessages(db, room.id, 50).map(publicMessage)
    );
    socket.emit('queue:state', listQueue(db, room.id));
  });

  socket.on('chat:send', ({ body, kind, id } = {}) => {
    if (!joinedRoomId) return;
    let text;
    if (kind === 'sticker' || kind === 'gif') {
      // Media messages reference a catalog id only; the client renders an
      // image solely when the id exists in its local whitelist.
      const ref = String(id || '');
      if (!/^[a-z0-9-]{1,40}$/.test(ref)) return;
      text = `${kind}:${ref}`;
    } else {
      text = String(body || '').trim().slice(0, 500);
      if (!text) return;
    }
    const now = Date.now();
    if (now - (lastChatAt.get(socket.id) || 0) < 500) {
      socket.emit('chat:error', { message: 'Slow down a little.' });
      return;
    }
    lastChatAt.set(socket.id, now);
    const sender =
      members.get(joinedRoomId)?.get(socket.id)?.displayName || 'Guest';
    const row = addMessage(db, joinedRoomId, sender, text);
    pruneMessages(db, joinedRoomId);
    io.to(joinedRoomId).emit('chat:message', publicMessage(row));
  });

  socket.on('typing:start', () => {
    if (!joinedRoomId) return;
    const sender = members.get(joinedRoomId)?.get(socket.id)?.displayName || 'Guest';
    socket.to(joinedRoomId).emit('typing', { from: socket.id, name: sender });
  });

  socket.on('queue:get', () => {
    if (!joinedRoomId) return;
    socket.emit('queue:state', listQueue(db, joinedRoomId));
  });

  socket.on('queue:add', ({ fileId } = {}) => {
    if (!joinedRoomId) return;
    const file = getFile(db, String(fileId || ''));
    if (!file || file.room_id !== joinedRoomId) {
      socket.emit('queue:error', { message: 'Unknown file for this room.' });
      return;
    }
    const sender = members.get(joinedRoomId)?.get(socket.id)?.displayName || 'Guest';
    addQueueItem(db, joinedRoomId, file.id, file.filename, sender);
    broadcastQueue(joinedRoomId);
  });

  socket.on('queue:remove', ({ itemId } = {}) => {
    if (!joinedRoomId) return;
    if (removeQueueItem(db, joinedRoomId, Number(itemId))) broadcastQueue(joinedRoomId);
  });

  socket.on('queue:move', ({ itemId, dir } = {}) => {
    if (!joinedRoomId) return;
    if (dir !== 'up' && dir !== 'down') return;
    if (moveQueueItem(db, joinedRoomId, Number(itemId), dir)) broadcastQueue(joinedRoomId);
  });

  // Play a queue item now (removes it from the queue).
  socket.on('queue:play', ({ itemId } = {}) => {
    if (!joinedRoomId) return;
    const item = getQueueItem(db, joinedRoomId, Number(itemId));
    if (!item) return;
    const file = getFile(db, item.file_id);
    if (!file || (file.status !== 'ready' && file.status !== 'error')) {
      socket.emit('sync:error', { message: 'That movie is not ready yet.' });
      return;
    }
    removeQueueItem(db, joinedRoomId, item.id);
    loadFileForRoom(joinedRoomId, file);
    broadcastQueue(joinedRoomId);
  });

  // Advance to the next playable item. Guarded so the two viewers'
  // simultaneous 'ended' events only advance once.
  socket.on('queue:next', () => {
    if (!joinedRoomId) return;
    const now = Date.now();
    if (now - (lastAdvance.get(joinedRoomId) || 0) < ADVANCE_GUARD_MS) {
      // Guarded (likely the other viewer's simultaneous 'ended'): don't
      // consume anything, but still answer a manual press on an empty queue.
      if (listQueue(db, joinedRoomId).length === 0) {
        socket.emit('queue:notice', { message: 'Queue is empty.' });
      }
      return;
    }
    let head = popQueueHead(db, joinedRoomId);
    while (head) {
      const file = getFile(db, head.file_id);
      if (file && (file.status === 'ready' || file.status === 'error')) {
        lastAdvance.set(joinedRoomId, now);
        loadFileForRoom(joinedRoomId, file);
        broadcastQueue(joinedRoomId);
        return;
      }
      head = popQueueHead(db, joinedRoomId); // drop unplayable head, try next
    }
    broadcastQueue(joinedRoomId);
    socket.emit('queue:notice', { message: 'Queue is empty.' });
  });

  // WebRTC signaling relay. The server only routes; media is peer-to-peer.
  // Messages stay inside the sender's room.
  function relayCall(event, { to, payload } = {}) {
    const roomId = socket.data.roomId;
    if (!roomId || roomId !== joinedRoomId) return;
    const target = io.sockets.sockets.get(String(to || ''));
    if (!target || target.data.roomId !== roomId) return;
    target.emit(event, { from: socket.id, ...(payload !== undefined ? { payload } : {}) });
  }

  socket.on('call:signal', (msg) => {
    if (!msg || !msg.payload || typeof msg.payload.type !== 'string') return;
    relayCall('call:signal', msg);
  });
  socket.on('call:bye', (msg = {}) => relayCall('call:bye', msg));

  // Presence in the call itself (separate from room membership). Clients only
  // open WebRTC connections with others who have announced they're in the
  // call, so the offer/answer handshake can't race the join order.
  socket.on('call:join', () => {
    if (!joinedRoomId) return;
    let set = callMembers.get(joinedRoomId);
    if (!set) callMembers.set(joinedRoomId, (set = new Set()));
    set.add(socket.id);
    broadcastCallMembers(joinedRoomId);
  });
  socket.on('call:leave', () => {
    if (joinedRoomId) leaveCallSet(joinedRoomId, socket.id);
  });
  socket.on('call:members-get', () => {
    if (joinedRoomId) socket.emit('call:members', callMembersOf(joinedRoomId));
  });

  // Camera effects: whitelisted, per-room last-write-wins, relayed to peers.
  socket.on('call:fx', (msg = {}) => {
    if (!joinedRoomId) return;
    const filter = FX_FILTERS.has(msg.filter) ? msg.filter : 'none';
    const overlay = FX_OVERLAYS.has(msg.overlay) ? msg.overlay : 'none';
    let roomFx = fxByRoom.get(joinedRoomId);
    if (!roomFx) fxByRoom.set(joinedRoomId, (roomFx = new Map()));
    roomFx.set(socket.id, { filter, overlay });
    socket.to(joinedRoomId).emit('call:fx', { from: socket.id, filter, overlay });
  });

  socket.on('call:fx-sync', () => {
    if (!joinedRoomId) return;
    const roomFx = fxByRoom.get(joinedRoomId);
    if (!roomFx || roomFx.size === 0) return;
    const state = {};
    for (const [id, fx] of roomFx) state[id] = fx;
    socket.emit('call:fx-state', state);
  });

  socket.on('call:fx-burst', () => {
    if (!joinedRoomId) return;
    socket.to(joinedRoomId).emit('call:fx-burst', { from: socket.id });
  });

  socket.on('room:end', () => {
    if (!joinedRoomId) return;
    const id = joinedRoomId;
    joinedRoomId = null;
    endRoom(id, 'ended');
  });

  socket.on('sync:load', ({ fileId } = {}) => {
    if (!joinedRoomId) return;
    const file = getFile(db, String(fileId || ''));
    if (!file || file.room_id !== joinedRoomId) {
      socket.emit('sync:error', { message: 'Unknown file for this room.' });
      return;
    }
    if (file.status !== 'ready' && file.status !== 'error') {
      socket.emit('sync:error', { message: 'That movie is not ready yet.' });
      return;
    }
    syncStates.set(joinedRoomId, {
      fileId: file.id,
      playing: false,
      mediaTime: 0,
      updatedAt: Date.now(),
      rate: 1,
    });
    broadcastSync(joinedRoomId);
  });

  socket.on('sync:action', ({ type, mediaTime } = {}) => {
    if (!joinedRoomId) return;
    const st = syncStates.get(joinedRoomId);
    if (!st || !st.fileId) return;
    if (type !== 'play' && type !== 'pause' && type !== 'seek') return;
    const t = Number(mediaTime);
    if (!Number.isFinite(t) || t < 0) return;
    const now = Date.now();
    if (type === 'play') {
      st.playing = true;
      st.mediaTime = t;
      st.updatedAt = now;
    } else if (type === 'pause') {
      st.playing = false;
      st.mediaTime = t;
      st.updatedAt = now;
    } else {
      st.mediaTime = t;
      st.updatedAt = now;
    }
    broadcastSync(joinedRoomId);
  });

  socket.on('disconnect', () => {
    lastChatAt.delete(socket.id);
    delete socket.data.roomId;
    if (!joinedRoomId) return;
    const roomFx = fxByRoom.get(joinedRoomId);
    if (roomFx) {
      roomFx.delete(socket.id);
      if (roomFx.size === 0) fxByRoom.delete(joinedRoomId);
    }
    leaveCallSet(joinedRoomId, socket.id);
    const room = members.get(joinedRoomId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) {
        members.delete(joinedRoomId);
        // Last one out: start the empty-room countdown (survives refreshes).
        emptySince.set(joinedRoomId, Date.now());
      } else broadcastMembers(joinedRoomId);
    }
    joinedRoomId = null;
  });
});

// ---- Upload API (resumable, chunked) ----

// Start (or re-attach to) an upload. Returns which chunks are still missing.
app.post('/api/rooms/:code/files', async (req, res) => {
  const room = getRoomByCode(db, String(req.params.code).toUpperCase().trim());
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const rawName = String(req.body?.filename || '');
  const filename = rawName.split(/[\\/]/).pop().trim().slice(0, 255);
  const size = Number(req.body?.size);
  const mime = String(req.body?.mime || '').slice(0, 128) || null;

  if (!filename) return res.status(400).json({ error: 'filename is required' });
  if (!Number.isInteger(size) || size <= 0)
    return res.status(400).json({ error: 'size must be a positive integer' });
  if (size > MAX_FILE_MB * 1024 * 1024)
    return res.status(413).json({ error: `File too large (max ${MAX_FILE_MB} MB)` });

  try {
    const file = createFile(db, room.id, filename, size, mime);
    const handle = await fs.promises.open(partPath(file.id), 'w');
    await handle.truncate(size); // preallocate (sparse) so chunks can land at offsets
    await handle.close();
    const payload = {
      ...publicFile(file),
      chunkSize: CHUNK_SIZE,
      totalChunks: totalChunksFor(size),
      received: [],
    };
    io.to(room.id).emit('file:added', payload);
    res.status(201).json(payload);
  } catch {
    res.status(500).json({ error: 'Could not start upload' });
  }
});

app.get('/api/files/:id/status', (req, res) => {
  const file = getFile(db, String(req.params.id));
  if (!file) return res.status(404).json({ error: 'Upload not found' });
  res.json({
    ...publicFile(file),
    chunkSize: CHUNK_SIZE,
    totalChunks: totalChunksFor(file.size),
    received: getReceivedChunks(db, file.id),
  });
});

app.get('/api/rooms/:code/files', (req, res) => {
  const room = getRoomByCode(db, String(req.params.code).toUpperCase().trim());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(listRoomFiles(db, room.id).map(publicFile));
});

const rawChunk = express.raw({ type: 'application/octet-stream', limit: '8mb' });

app.put('/api/files/:id/chunks/:index', rawChunk, async (req, res) => {
  const file = getFile(db, String(req.params.id));
  if (!file) return res.status(404).json({ error: 'Upload not found' });
  if (file.status !== 'uploading')
    return res.status(409).json({ error: `Upload is ${file.status}` });

  const idx = Number(req.params.index);
  const total = totalChunksFor(file.size);
  if (!Number.isInteger(idx) || idx < 0 || idx >= total)
    return res.status(400).json({ error: 'Chunk index out of range' });

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length !== expectedChunkSize(file, idx))
    return res.status(400).json({ error: 'Chunk body has unexpected size' });

  try {
    const handle = await fs.promises.open(partPath(file.id), 'r+');
    await handle.write(body, 0, body.length, idx * CHUNK_SIZE);
    await handle.close();
    addChunk(db, file.id, idx, body.length);
    res.json({ received: idx });
  } catch {
    res.status(500).json({ error: 'Could not store chunk' });
  }
});

app.post('/api/files/:id/complete', async (req, res) => {  const file = getFile(db, String(req.params.id));
  if (!file) return res.status(404).json({ error: 'Upload not found' });
  if (file.status !== 'uploading')
    return res.status(409).json({ error: `Upload is ${file.status}` });

  const total = totalChunksFor(file.size);
  const received = getReceivedChunks(db, file.id);
  if (received.length !== total)
    return res
      .status(400)
      .json({ error: `Incomplete upload (${received.length}/${total} chunks)` });

  try {
    const stat = await fs.promises.stat(partPath(file.id));
    if (stat.size !== file.size)
      return res.status(400).json({ error: 'Size mismatch, re-upload missing chunks' });
    await fs.promises.rename(partPath(file.id), finalPath(file));
    setFileStatus(db, file.id, 'processing');
    enqueue(file.id);
    const done = { ...publicFile(getFile(db, file.id)) };
    io.to(file.room_id).emit('file:processing', { id: file.id });
    res.json(done);
  } catch {
    res.status(500).json({ error: 'Could not finalize upload' });
  }
});

// Delete a movie: drops queue entries, clears it from the player if loaded,
// removes all bytes from disk.
app.delete('/api/files/:id', async (req, res) => {
  const file = getFile(db, String(req.params.id));
  if (!file) return res.status(404).json({ error: 'File not found' });

  removeQueueItemsByFile(db, file.room_id, file.id);
  deleteFile(db, file.id);
  for (const name of [file.play_file, storedFileName(file), `${file.id}.part`]) {
    if (!name) continue;
    try {
      await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(name)));
    } catch {
      /* best effort */
    }
  }

  const wasLoaded = syncStates.get(file.room_id)?.fileId === file.id;
  if (wasLoaded) syncStates.delete(file.room_id);
  io.to(file.room_id).emit('file:removed', { id: file.id });
  broadcastQueue(file.room_id);
  if (wasLoaded) io.to(file.room_id).emit('sync:state', { fileId: null });
  res.json({ deleted: file.id });
});

// ---- Playback (HTTP Range streaming) ----

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    start = size - end;
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!Number.isInteger(start) || start < 0 || start >= size || start > end) return null;
  return { start, end };
}

app.get('/api/files/:id/stream', async (req, res) => {
  const file = getFile(db, String(req.params.id));
  if (!file) return res.status(404).end();
  if (file.status !== 'ready' && file.status !== 'error') {
    return res.status(409).json({ error: `File is ${file.status}` });
  }
  const diskName = path.basename(file.play_file || storedFileName(file));
  let stat;
  try {
    stat = await fs.promises.stat(path.join(UPLOAD_DIR, diskName));
  } catch {
    return res.status(404).end();
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', file.play_mime || file.mime || 'video/mp4');

  const range = parseRange(req.headers.range, stat.size);
  if (req.headers.range && !range) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(path.join(UPLOAD_DIR, diskName))
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }
  const { start, end } = range;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(path.join(UPLOAD_DIR, diskName), { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
});

// Resume conversions interrupted by a restart.
for (const pending of listProcessing(db)) {
  enqueue(pending.id);
}

// ---- Room lifecycle ----

function endRoom(roomId, reason) {
  for (const f of listRoomFiles(db, roomId)) {
    for (const name of [f.play_file, storedFileName(f), `${f.id}.part`]) {
      if (!name) continue;
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(name)));
      } catch {
        /* best effort */
      }
    }
  }
  deleteRoom(db, roomId); // cascades files, queue, messages
  syncStates.delete(roomId);
  fxByRoom.delete(roomId);
  callMembers.delete(roomId);
  lastAdvance.delete(roomId);
  roomActivity.delete(roomId);
  emptySince.delete(roomId);
  io.to(roomId).emit('room:ended', { reason: reason || 'ended' });
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomId === roomId) {
      sock.leave(roomId);
      delete sock.data.roomId;
      members.get(roomId)?.delete(sock.id);
    }
  }
  members.delete(roomId);
  console.log(`Room ${roomId} ended (${reason || 'ended'})`);
}

const ROOM_SWEEP_MS = Number(process.env.ROOM_SWEEP_MS) || 5 * 60 * 1000;
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS) || 30 * 60 * 1000;
// Grace after the last user leaves: survives refreshes/reconnects,
// but doesn't keep movies on disk for empty rooms.
const ROOM_EMPTY_MS = Number(process.env.ROOM_EMPTY_MS) || 3 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [roomId, since] of emptySince) {
    if ((members.get(roomId)?.size || 0) === 0 && now - since > ROOM_EMPTY_MS) {
      endRoom(roomId, 'empty');
    }
  }
  for (const [roomId, last] of roomActivity) {
    if ((members.get(roomId)?.size || 0) === 0 && now - last > ROOM_IDLE_MS) {
      endRoom(roomId, 'idle');
    }
  }
}, ROOM_SWEEP_MS);

httpServer.listen(PORT, () => {
  console.log(`Watch2Gether listening on http://localhost:${PORT}`);
});
