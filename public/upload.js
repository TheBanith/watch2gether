// Resumable chunked uploader: parallel chunk PUTs, per-chunk retry with
// backoff, and resume across reloads via localStorage + server chunk index.
(() => {
  const PARALLEL = 3;
  const MAX_RETRIES = 5;

  let code = null;
  let socket = null;
  let state = null; // { fileId, file, chunkSize, total, received:Set, paused, done }

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

  function resumeKey(file) {
    return `w2g-upload:${code}:${file.name}:${file.size}`;
  }

  function setStatus(text, isErr = false) {
    const el = $('upload-status');
    el.textContent = text;
    el.classList.toggle('err', isErr);
  }

  function updateButton() {
    const btn = $('upload-btn');
    if (!state || state.done) btn.textContent = 'Upload';
    else btn.textContent = state.paused ? 'Resume' : 'Pause';
  }

  function updateProgress() {
    const pct = state.total === 0 ? 0 : (state.received.size / state.total) * 100;
    $('upload-bar').style.width = `${pct.toFixed(1)}%`;
    if (!state.done && !state.paused) {
      setStatus(`Uploading ${pct.toFixed(0)}% (${state.received.size}/${state.total} chunks)…`);
    }
  }

  async function refreshLibrary() {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/files`);
      if (!res.ok) return;
      const files = await res.json();
      const ul = $('library');
      ul.innerHTML = '';
      if (files.length === 0) {
        ul.innerHTML = '<li class="muted">Nothing here yet — upload the first movie.</li>';
        return;
      }
      for (const f of files) {
        const li = document.createElement('li');
        li.setAttribute('data-file-id', f.id);
        li.className = 'lib-row';
        const main = document.createElement('div');
        main.className = 'lib-main';
        const name = document.createElement('span');
        name.className = 'lib-name';
        name.textContent = `${f.filename} (${fmtMB(f.size)})`;
        main.appendChild(name);
        if (f.status === 'ready') {
          main.insertAdjacentHTML('beforeend', '<span class="badge ok">ready</span>');
        } else if (f.status === 'processing') {
          const prog = document.createElement('span');
          prog.className = 'muted';
          prog.setAttribute('data-prog', f.id);
          prog.textContent = 'processing…';
          main.appendChild(prog);
        } else if (f.status === 'error') {
          main.insertAdjacentHTML('beforeend', '<span class="badge warn">unconverted</span>');
        } else {
          main.insertAdjacentHTML('beforeend', '<span class="badge">uploading</span>');
        }
        li.appendChild(main);
        const actions = document.createElement('div');
        actions.className = 'lib-actions';
        if (f.status === 'ready' || f.status === 'error') {
          const btn = document.createElement('button');
          btn.textContent = f.status === 'ready' ? '▶ Play' : '▶ Try anyway';
          btn.className = 'mini';
          btn.addEventListener('click', () => window.W2GPlayer.playFile(f.id));
          actions.appendChild(btn);
        }
        const qbtn = document.createElement('button');
        qbtn.textContent = '+ Queue';
        qbtn.className = 'mini';
        qbtn.title = 'Add to play queue';
        qbtn.addEventListener('click', () => window.W2GQueue.add(f.id));
        actions.appendChild(qbtn);
        const del = document.createElement('button');
        del.textContent = '✕';
        del.className = 'mini';
        del.title = 'Delete movie for everyone';
        del.addEventListener('click', async () => {
          if (!confirm(`Delete "${f.filename}" for everyone?`)) return;
          try {
            const r = await fetch(`/api/files/${f.id}`, { method: 'DELETE' });
            if (!r.ok) throw new Error();
            refreshLibrary();
          } catch {
            setStatus('Could not delete movie.', true);
          }
        });
        actions.appendChild(del);
        li.appendChild(actions);
        ul.appendChild(li);
      }
    } catch {
      /* server unreachable; library refreshes on next event */
    }
  }

  async function fetchStatus(fileId) {
    const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/status`);
    return res.ok ? res.json() : null;
  }

  async function startOrResume() {
    if (window.W2G_ROOM_ENDED) {
      setStatus('This room has ended.', true);
      return;
    }
    if (state && !state.done) {
      // Toggle pause / resume for the active upload.
      state.paused = !state.paused;
      updateButton();
      if (!state.paused) {
        setStatus('');
        pump();
      } else {
        setStatus('Paused. Press Resume to continue.');
      }
      return;
    }
    const input = $('file-input');
    const file = input.files && input.files[0];
    if (!file) {
      setStatus('Choose a movie file first.', true);
      return;
    }
    setStatus('');
    $('upload-bar').style.width = '0%';

    try {
      let fileId = localStorage.getItem(resumeKey(file));
      let meta = fileId ? await fetchStatus(fileId) : null;
      if (!meta || meta.status !== 'uploading' || meta.size !== file.size) {
        const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/files`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type }),
        });
        if (res.status === 413) {
          setStatus('File too large for this server.', true);
          return;
        }
        if (!res.ok) throw new Error(`init failed: HTTP ${res.status}`);
        meta = await res.json();
        fileId = meta.id;
        localStorage.setItem(resumeKey(file), fileId);
      }
      state = {
        fileId,
        file,
        chunkSize: meta.chunkSize,
        total: meta.totalChunks,
        received: new Set(meta.received),
        paused: false,
        done: false,
      };
      updateButton();
      updateProgress();
      await pump();
    } catch (err) {
      setStatus(`Upload error: ${err.message}`, true);
    }
  }

  async function pump() {
    const queue = [];
    for (let i = 0; i < state.total; i++) {
      if (!state.received.has(i)) queue.push(i);
    }
    if (queue.length === 0) {
      await finish();
      return;
    }
    const workers = [];
    for (let w = 0; w < Math.min(PARALLEL, queue.length); w++) {
      workers.push(worker(queue));
    }
    await Promise.all(workers);
    if (!state.paused && !state.done) await finish();
  }

  async function worker(queue) {
    while (queue.length > 0 && !state.paused) {
      const idx = queue.shift();
      try {
        await putChunkWithRetry(idx);
        state.received.add(idx);
        updateProgress();
      } catch {
        state.paused = true;
        setStatus('Connection issue — paused. Press Resume to continue.', true);
        updateButton();
        return;
      }
    }
  }

  async function putChunkWithRetry(idx) {
    const start = idx * state.chunkSize;
    const buf = await state.file.slice(start, start + state.chunkSize).arrayBuffer();
    let delay = 1000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`/api/files/${state.fileId}/chunks/${idx}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: buf,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return;
      } catch (err) {
        if (attempt === MAX_RETRIES || state.paused) throw err;
        await sleep(delay);
        delay *= 2;
      }
    }
  }

  async function finish() {
    const res = await fetch(`/api/files/${state.fileId}/complete`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `complete failed: HTTP ${res.status}`);
    }
    state.done = true;
    localStorage.removeItem(resumeKey(state.file));
    $('upload-bar').style.width = '100%';
    setStatus('Upload complete — movie is ready. ✓');
    updateButton();
    await refreshLibrary();
  }

  function init(roomCode, roomSocket) {
    code = roomCode;
    socket = roomSocket;
    $('upload-btn').addEventListener('click', startOrResume);
    socket.on('file:added', refreshLibrary);
    socket.on('file:processing', refreshLibrary);
    socket.on('file:ready', refreshLibrary);
    socket.on('file:error', refreshLibrary);
    socket.on('file:removed', refreshLibrary);
    refreshLibrary();
  }

  window.W2GUpload = { init };
})();
