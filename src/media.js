import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  getFile,
  setFileStatus,
  setPlayOutput,
  storedFileName,
} from './db.js';

let db = null;
let io = null;
let uploadDir = null;
let mediaAvailable = false;

const queue = [];
let active = false;

export function isMediaAvailable() {
  return mediaAvailable;
}

export function initMedia({ db: dbRef, io: ioRef, uploadDir: dir }) {
  db = dbRef;
  io = ioRef;
  uploadDir = dir;
  execFile('ffprobe', ['-version'], (err) => {
    mediaAvailable = !err;
    if (!mediaAvailable) {
      console.warn('ffprobe/ffmpeg not found: uploads will stream as-is without conversion');
    }
  });
}

export function enqueue(fileId) {
  queue.push(fileId);
  pump();
}

async function pump() {
  if (active) return;
  active = true;
  try {
    while (queue.length > 0) {
      await processOne(queue.shift());
    }
  } finally {
    active = false;
  }
}

function emit(roomId, event, payload) {
  if (io && roomId) io.to(roomId).emit(event, payload);
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('ffprobe could not read this file'));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('ffprobe returned invalid data'));
        }
      }
    );
  });
}

// direct: stream as-is. remux: copy codecs into MP4 (fast).
// audio: copy video, transcode audio to AAC. full: transcode everything.
function decide(ext, info) {
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!video) return { action: 'unsupported', reason: 'no video stream found' };
  const v = video.codec_name;
  const a = audio ? audio.codec_name : null;
  const audioOk = !a || ['aac', 'mp3'].includes(a);

  if (['mp4', 'm4v', 'mov'].includes(ext) && v === 'h264' && audioOk) {
    return { action: 'direct', mime: 'video/mp4' };
  }
  if (
    ext === 'webm' &&
    ['vp8', 'vp9', 'av1'].includes(v) &&
    (!a || ['vorbis', 'opus'].includes(a))
  ) {
    return { action: 'direct', mime: 'video/webm' };
  }
  if (v === 'h264' && audioOk) return { action: 'remux' };
  if (v === 'h264') return { action: 'audio' };
  return { action: 'full' };
}

function durationOf(info) {
  const d = Number(info.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

function runFfmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-nostats', ...args]);
    let stderr = '';
    let lastEmit = 0;
    let lastPct = -1;
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text.slice(-4000);
      if (duration && onProgress) {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(text);
        if (m) {
          const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          const pct = Math.min(99, Math.floor((secs / duration) * 100));
          const now = Date.now();
          if (pct > lastPct && now - lastEmit > 500) {
            lastPct = pct;
            lastEmit = now;
            onProgress(pct);
          }
        }
      }
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function processOne(fileId) {
  const file = getFile(db, fileId);
  if (!file || file.status !== 'processing') return;
  emit(file.room_id, 'file:processing', { id: file.id });

  const original = path.join(uploadDir, storedFileName(file));
  try {
    if (!mediaAvailable) {
      // No ffmpeg here: serve the original and let the browser try.
      setPlayOutput(db, file.id, storedFileName(file), file.mime);
      setFileStatus(db, file.id, 'ready');
      emit(file.room_id, 'file:ready', { id: file.id });
      return;
    }

    const ext = (file.filename.split('.').pop() || '').toLowerCase();
    const info = await probe(original);
    const plan = decide(ext, info);
    if (plan.action === 'unsupported') throw new Error(plan.reason);

    if (plan.action === 'direct') {
      setPlayOutput(db, file.id, storedFileName(file), plan.mime);
      setFileStatus(db, file.id, 'ready');
      emit(file.room_id, 'file:ready', { id: file.id });
      return;
    }

    const duration = durationOf(info);
    const hasAudio = (info.streams || []).some((s) => s.codec_type === 'audio');
    const outName = `${file.id}.conv.mp4`;
    const outPath = path.join(uploadDir, outName);
    const maps = ['-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : [])];
    let codecArgs;
    if (plan.action === 'remux') {
      codecArgs = ['-c', 'copy'];
    } else if (plan.action === 'audio') {
      codecArgs = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k'];
    } else {
      codecArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k'];
    }

    await runFfmpeg(
      ['-i', original, ...maps, ...codecArgs, '-movflags', '+faststart', outPath],
      duration,
      (pct) => emit(file.room_id, 'file:progress', { id: file.id, pct })
    );

    // Swap in the converted file and delete the original to save disk.
    const finalName = `${file.id}.mp4`;
    const final = path.join(uploadDir, finalName);
    try {
      await fs.promises.unlink(final);
    } catch {
      /* not there (or it IS the original with a different name) */
    }
    if (path.resolve(original) !== path.resolve(final)) {
      try {
        await fs.promises.unlink(original);
      } catch {
        /* keep going; disk cleanup is best-effort */
      }
    }
    await fs.promises.rename(outPath, final);
    setPlayOutput(db, file.id, finalName, 'video/mp4');
    setFileStatus(db, file.id, 'ready');
    emit(file.room_id, 'file:ready', { id: file.id });
  } catch (err) {
    // Leave the original in place so the user can still try playing it.
    setPlayOutput(db, file.id, storedFileName(file), file.mime);
    setFileStatus(db, file.id, 'error');
    emit(file.room_id, 'file:error', { id: file.id, error: err.message });
  }
}
