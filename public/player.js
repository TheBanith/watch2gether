// Synced playback: server is authoritative. Local video events are emitted
// as actions; remote state is applied to the video element. Programmatic
// changes are muted via a quiet window so they never echo back.
(() => {
  const DRIFT_TOL = 0.4; // seconds
  const DRIFT_CHECK_MS = 3000;

  let socket = null;
  let lastState = null;
  let pendingState = null;
  let pendingSeekTimer = null;
  let quietUntil = 0;

  const el = () => document.getElementById('player');
  const streamUrl = (id) => `/api/files/${encodeURIComponent(id)}/stream`;
  const quiet = (ms) => {
    quietUntil = Date.now() + ms;
  };
  const isQuiet = () => Date.now() < quietUntil;

  function currentFileId() {
    const video = el();
    const src = video.currentSrc || video.src || '';
    const m = /\/api\/files\/([^/]+)\/stream/.exec(src);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function expectedTime(st) {
    if (st.playing) {
      return st.mediaTime + ((Date.now() - st.updatedAt) / 1000) * (st.rate || 1);
    }
    return st.mediaTime;
  }

  function emitAction(type, mediaTime) {
    if (socket) socket.emit('sync:action', { type, mediaTime });
  }

  function applyPositionAndPlay(st) {
    const video = el();
    const exp = expectedTime(st);
    if (!Number.isFinite(exp) || exp < 0) return;
    quiet(800);
    if (Math.abs(video.currentTime - exp) > DRIFT_TOL) {
      video.currentTime = exp;
    }
    if (st.playing && video.paused) {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else if (!st.playing && !video.paused) {
      video.pause();
    }
  }

  function applyState(st) {
    if (!st) return;
    if (!st.fileId) {
      // Nothing loaded (e.g. the playing movie was deleted): stop and clear.
      lastState = null;
      pendingState = null;
      const video = el();
      quiet(800);
      video.pause();
      video.removeAttribute('src');
      video.load();
      return;
    }
    lastState = st;
    const errEl = document.getElementById('room-err');
    if (errEl && errEl.dataset.sync === '1') {
      errEl.textContent = '';
      errEl.dataset.sync = '';
    }
    if (currentFileId() !== st.fileId) {
      pendingState = st;
      quiet(1500);
      el().src = streamUrl(st.fileId);
      return;
    }
    applyPositionAndPlay(st);
  }

  function driftCheck() {
    const video = el();
    if (!lastState || !lastState.playing) return;
    if (currentFileId() !== lastState.fileId) return;
    if (video.seeking || video.readyState < 2 || video.ended) return;
    const exp = expectedTime(lastState);
    if (Math.abs(video.currentTime - exp) > DRIFT_TOL) {
      quiet(600);
      video.currentTime = exp;
    }
  }

  function init(roomCode, roomSocket) {
    socket = roomSocket;
    const video = el();

    socket.on('sync:state', applyState);
    socket.on('sync:error', ({ message } = {}) => {
      const errEl = document.getElementById('room-err');
      if (errEl) {
        errEl.textContent = message || 'Sync error.';
        errEl.dataset.sync = '1';
      }
    });
    socket.on('file:progress', ({ id, pct }) => {
      const prog = document.querySelector(`[data-prog="${id}"]`);
      if (prog) prog.textContent = `processing ${pct}%…`;
    });

    video.addEventListener('play', () => {
      if (isQuiet()) return;
      emitAction('play', video.currentTime);
    });
    video.addEventListener('pause', () => {
      if (isQuiet()) return;
      emitAction('pause', video.currentTime);
    });
    video.addEventListener('seeked', () => {
      if (isQuiet()) return;
      clearTimeout(pendingSeekTimer);
      pendingSeekTimer = setTimeout(() => {
        if (isQuiet()) return;
        emitAction('seek', video.currentTime);
      }, 300);
    });
    video.addEventListener('loadedmetadata', () => {
      if (pendingState && currentFileId() === pendingState.fileId) {
        const st = pendingState;
        pendingState = null;
        applyPositionAndPlay(st);
      }
    });
    // Auto-advance the queue when the movie ends (server guards double-fire).
    video.addEventListener('ended', () => {
      if (isQuiet()) return;
      socket.emit('queue:next');
    });

    setInterval(driftCheck, DRIFT_CHECK_MS);
  }

  // User picked a movie: load it locally, tell the room (server rebroadcasts state).
  function playFile(id) {
    const video = el();
    if (currentFileId() !== id) {
      quiet(800);
      video.src = streamUrl(id);
    }
    if (socket) socket.emit('sync:load', { fileId: id });
    video.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  window.W2GPlayer = { init, playFile };
})();
