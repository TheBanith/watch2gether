(() => {
  let socket = null;

  function statusBadge(fileStatus) {
    if (fileStatus === 'ready') return '<span class="badge ok">ready</span>';
    if (fileStatus === 'processing') return '<span class="badge">processing</span>';
    if (!fileStatus) return '<span class="badge warn">gone</span>';
    return '<span class="badge">waiting</span>';
  }

  function render(items) {
    const ol = document.getElementById('queue-list');
    ol.innerHTML = '';
    if (items.length === 0) {
      ol.innerHTML = '<li class="muted">Queue is empty — add movies from the library.</li>';
      return;
    }
    items.forEach((item, pos) => {
      const li = document.createElement('li');
      const p = document.createElement('span');
      p.className = 'q-pos';
      p.textContent = `${pos + 1}.`;
      const title = document.createElement('span');
      title.className = 'q-title';
      title.textContent = ` ${item.title} `;
      li.appendChild(p);
      li.appendChild(title);
      li.insertAdjacentHTML('beforeend', statusBadge(item.fileStatus));
      const meta = document.createElement('div');
      meta.className = 'q-meta muted';
      meta.textContent = `added by ${item.addedBy}`;
      li.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'q-actions';
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.className = 'mini';
        b.addEventListener('click', fn);
        actions.appendChild(b);
      };
      mk('▶', 'Play now', () => socket.emit('queue:play', { itemId: item.id }));
      if (pos > 0) mk('↑', 'Move up', () => socket.emit('queue:move', { itemId: item.id, dir: 'up' }));
      if (pos < items.length - 1)
        mk('↓', 'Move down', () => socket.emit('queue:move', { itemId: item.id, dir: 'down' }));
      mk('✕', 'Remove', () => socket.emit('queue:remove', { itemId: item.id }));
      li.appendChild(actions);
      ol.appendChild(li);
    });
  }

  function init(roomCode, roomSocket) {
    socket = roomSocket;
    socket.on('queue:state', render);
    socket.on('queue:error', ({ message } = {}) => {
      if (message) document.getElementById('queue-status').textContent = message;
    });
    socket.on('queue:notice', ({ message } = {}) => {
      if (message) document.getElementById('queue-status').textContent = message;
    });
    // File readiness changed -> ask for a fresh queue (status badges).
    socket.on('file:ready', () => socket.emit('queue:get'));
    socket.on('file:processing', () => socket.emit('queue:get'));
    document.getElementById('queue-next').addEventListener('click', () => {
      document.getElementById('queue-status').textContent = '';
      socket.emit('queue:next');
    });
  }

  function add(fileId) {
    if (socket) socket.emit('queue:add', { fileId });
  }

  window.W2GQueue = { init, add };
})();
