// Text chat. Messages are rendered with textContent (never innerHTML),
// so message bodies cannot inject markup.
(() => {
  const AVATAR_COLORS = [
    '#5865f2', '#23a55a', '#f0b232', '#eb459e',
    '#9b59b6', '#00a8cc', '#e67e22', '#1abc9c',
  ];
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const TYPING_TTL_MS = 3000;

  let lastSender = null;
  let lastTime = 0;
  let lastTypingEmit = 0;
  const typers = new Map(); // name -> timeout id
  let socket = null;

  function avatarColor(name) {
    let h = 0;
    const s = String(name || '?');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendMessage({ sender, body, createdAt }) {
    const log = document.getElementById('chat-log');
    const grouped = sender === lastSender && createdAt - lastTime < GROUP_WINDOW_MS;
    lastSender = sender;
    lastTime = createdAt;
    const li = document.createElement('li');
    li.className = grouped ? 'msg grouped' : 'msg';
    if (!grouped) {
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = (sender[0] || '•').toUpperCase();
      avatar.style.background = avatarColor(sender);
      li.appendChild(avatar);
    }
    const wrap = document.createElement('div');
    wrap.className = 'msg-body';
    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('strong');
      who.textContent = sender;
      const when = document.createElement('span');
      when.className = 'muted msg-time';
      when.textContent = fmtTime(createdAt);
      head.appendChild(who);
      head.appendChild(when);
      wrap.appendChild(head);
    }
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = body;
    wrap.appendChild(text);
    li.appendChild(wrap);
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function appendSystem(text) {
    const log = document.getElementById('chat-log');
    lastSender = null;
    const li = document.createElement('li');
    li.className = 'sys-msg';
    li.textContent = text;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function typingRow() {
    let row = document.getElementById('typing');
    if (!row) {
      row = document.createElement('div');
      row.id = 'typing';
      row.className = 'typing';
      row.hidden = true;
      const log = document.getElementById('chat-log');
      log.parentNode.insertBefore(row, log.nextSibling);
    }
    return row;
  }

  function showTyping(name) {
    const row = typingRow();
    if (typers.has(name)) clearTimeout(typers.get(name));
    typers.set(
      name,
      setTimeout(() => {
        typers.delete(name);
        renderTypers();
      }, TYPING_TTL_MS)
    );
    renderTypers();
  }

  function renderTypers() {
    const row = typingRow();
    const names = [...typers.keys()];
    if (names.length === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    row.textContent =
      names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  }

  function init(roomCode, roomSocket) {
    socket = roomSocket;
    const input = document.getElementById('chat-text');

    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      roomSocket.emit('chat:send', { body: text });
      input.value = '';
    };
    document.getElementById('chat-send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    input.addEventListener('input', () => {
      const now = Date.now();
      if (now - lastTypingEmit > 2500) {
        lastTypingEmit = now;
        roomSocket.emit('typing:start');
      }
    });

    roomSocket.on('chat:history', (messages) => {
      document.getElementById('chat-log').innerHTML = '';
      lastSender = null;
      lastTime = 0;
      for (const m of messages) appendMessage(m);
    });
    roomSocket.on('chat:message', appendMessage);
    roomSocket.on('chat:error', ({ message } = {}) => {
      if (message) appendSystem(message);
    });
    roomSocket.on('typing', ({ name } = {}) => {
      if (name) showTyping(name);
    });
  }

  window.W2GChat = { init };
})();
