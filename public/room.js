const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase().trim();
const errEl = document.getElementById('room-err');

const AVATAR_COLORS = [
  '#5865f2', '#23a55a', '#f0b232', '#eb459e',
  '#9b59b6', '#00a8cc', '#e67e22', '#1abc9c',
];

function avatarColor(name) {
  let h = 0;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

let displayName = params.get('name') || sessionStorage.getItem('w2g-name') || '';
if (!displayName) {
  displayName = (prompt('Your display name:') || 'Guest').trim() || 'Guest';
  sessionStorage.setItem('w2g-name', displayName);
}
document.getElementById('me-name').textContent = displayName;
const _meAvatar = document.getElementById('me-avatar');
_meAvatar.textContent = (displayName[0] || '?').toUpperCase();
_meAvatar.style.background = avatarColor(displayName);

async function init() {
  if (!code) {
    errEl.textContent = 'No room code in the link. Go back home and join a room.';
    return;
  }
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (res.status === 404) {
    errEl.textContent = 'Room not found. Check the code.';
    return;
  }
  const room = await res.json();
  document.getElementById('room-name').textContent = room.name;
  document.getElementById('room-code').textContent = room.code;
  document.title = `${room.name} — Watch2Gether`;

  const socket = io();
  socket.on('connect', () => {
    socket.emit('room:join', { code: room.code, displayName });
  });
  window.W2GUpload.init(room.code, socket);
  window.W2GPlayer.init(room.code, socket);
  window.W2GChat.init(room.code, socket);
  window.W2GQueue.init(room.code, socket);
  window.W2GCall.init(room.code, socket);

  socket.on('room:ended', ({ reason } = {}) => {
    window.W2G_ROOM_ENDED = true;
    const video = document.getElementById('player');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    document.querySelector('main').hidden = true;
    const ended = document.getElementById('ended');
    if (reason === 'idle') {
      document.getElementById('ended-sub').textContent =
        'This room was cleaned up after 30 minutes with nobody in it.';
    } else if (reason === 'empty') {
      document.getElementById('ended-sub').textContent =
        'Everyone left, so this room was cleaned up.';
    }
    ended.hidden = false;
    socket.disconnect();
  });

  document.getElementById('end-room').addEventListener('click', () => {
    if (confirm('End this room for everyone? Movies, queue and chat will be deleted.')) {
      socket.emit('room:end');
    }
  });
  socket.on('room:joined', () => {
    errEl.textContent = '';
  });
  socket.on('room:error', ({ message }) => {
    errEl.textContent = message;
  });
  socket.on('room:members', (membersList) => {
    document.getElementById('member-count').textContent = membersList.length;
    const ul = document.getElementById('members');
    ul.innerHTML = '';
    for (const m of membersList) {
      const li = document.createElement('li');
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = (m.displayName[0] || '?').toUpperCase();
      avatar.style.background = avatarColor(m.displayName);
      const name = document.createElement('span');
      name.className = 'voice-name';
      name.textContent = m.displayName;
      const icon = document.createElement('span');
      icon.className = 'voice-icon';
      icon.textContent = '🔊';
      icon.title = 'In voice channel';
      li.appendChild(avatar);
      li.appendChild(name);
      li.appendChild(icon);
      ul.appendChild(li);
    }
  });
  socket.on('disconnect', () => {
    errEl.textContent = 'Connection lost. Reconnecting…';
  });

  document.getElementById('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
    } catch {
      prompt('Copy this invite link:', location.href);
    }
  });
}

init().catch(() => {
  errEl.textContent = 'Could not reach the server.';
});
