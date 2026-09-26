const $ = (id) => document.getElementById(id);

function rememberName(input) {
  const name = input.value.trim();
  if (name) sessionStorage.setItem('w2g-name', name);
  return name;
}

$('create-btn').addEventListener('click', async () => {
  $('create-err').textContent = '';
  const name = rememberName($('create-user'));
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('create-name').value.trim() || 'Movie night' }),
    });
    if (!res.ok) throw new Error('Server error');
    const room = await res.json();
    const url = `/room.html?code=${room.code}&name=${encodeURIComponent(name || 'Guest')}`;
    location.href = url;
  } catch {
    $('create-err').textContent = 'Could not create room. Is the server running?';
  }
});

$('join-btn').addEventListener('click', async () => {
  $('join-err').textContent = '';
  const code = $('join-code').value.trim().toUpperCase();
  const name = rememberName($('join-user'));
  if (!code) {
    $('join-err').textContent = 'Enter the room code first.';
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    if (res.status === 404) {
      $('join-err').textContent = 'Room not found. Check the code.';
      return;
    }
    if (!res.ok) throw new Error('Server error');
    location.href = `/room.html?code=${code}&name=${encodeURIComponent(name || 'Guest')}`;
  } catch {
    $('join-err').textContent = 'Could not reach the server.';
  }
});
