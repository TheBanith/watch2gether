// Voice/video call: WebRTC mesh, signaling relayed through the room.
// Deterministic offerer (smaller socket id offers) so glare can't happen.
// UI is a Discord-style dock below the player: camera tiles in a filmstrip,
// avatar pills for camera-off peers, a floating control pill, and camera
// effects (CSS filters + overlays) relayed to everyone in the room.
(() => {
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  // Populated from /api/ice (adds a TURN relay for cross-NAT calls).
  let iceServers = STUN;
  fetch('/api/ice')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && Array.isArray(d.iceServers) && d.iceServers.length) iceServers = d.iceServers;
    })
    .catch(() => {});

  const MIC_ON =
    '<svg class="mic-on-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const MIC_OFF =
    '<svg class="mic-muted-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9v3a3 3 0 0 0 5 2.2M15 9V5a3 3 0 0 0-6-.2M5 10v2a7 7 0 0 0 12 4.9M19 10v2a7 7 0 0 1-.5 2.6M12 19v3m-4 0h8M3 3l18 18"/></svg>';
  const AVATAR_COLORS = [
    '#5865f2', '#23a55a', '#f0b232', '#eb459e',
    '#9b59b6', '#00a8cc', '#e67e22', '#1abc9c',
  ];

  // Camera effects (whitelisted client-side AND server-side).
  const FX_FILTERS = ['none', 'noir', 'retro', 'dream', 'neon', 'frost', 'acid'];
  const FX_OVERLAYS = [
    'none', 'sparkles', 'hearts', 'embers', 'starfall', 'matrix',
    'fireworks', 'petals', 'bubbles', 'neon', 'rainbow',
    'film', 'frost', 'fire', 'gold',
  ];
  // Overlay values that draw an animated border instead of particles.
  const FX_FRAMES = ['neon', 'rainbow', 'film', 'frost', 'fire', 'gold'];
  const FX_ART = {
    sparkles:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ffd76a' d='M12 2l2.2 6.4L21 11l-6.8 2.6L12 20l-2.2-6.4L3 11l6.8-2.6z'/%3E%3C/svg%3E\")",
    hearts:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ff6b9d' d='M12 21s-7.5-4.9-9.6-9.3C.7 8.3 3 4.8 6.7 4.8c2.1 0 3.6 1.1 4.3 2.2.7-1.1 2.2-2.2 4.3-2.2 3.7 0 6 3.5 4.3 6.9C19.5 16.1 12 21 12 21z'/%3E%3C/svg%3E\")",
    embers:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23ff8c2a' d='M12 2c1.2 3.2-1.8 4.8-1.8 7.4a3.9 3.9 0 0 0 7.8 0c0-1.5-.7-2.8-1.6-3.9 1.6 1.3 3.1 3.6 3.1 6.6A7.5 7.5 0 1 1 4.5 12C4.5 7.6 8.4 5.6 12 2z'/%3E%3C/svg%3E\")",
    starfall:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23fde68a' d='M12 1.5l2.3 6.7 6.7 2.3-6.7 2.3L12 19.5l-2.3-6.7-6.7-2.3 6.7-2.3z'/%3E%3C/svg%3E\")",
    petals:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cdefs%3E%3ClinearGradient id='p' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23fbcfe8'/%3E%3Cstop offset='1' stop-color='%23f472b6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23p)' d='M12 1.5c3.6 3.4 6.6 7.6 6.6 12.2 0 4.4-2.9 7.6-6.6 8.8-3.7-1.2-6.6-4.4-6.6-8.8C5.4 9.1 8.4 4.9 12 1.5z'/%3E%3C/svg%3E\")",
    bubbles:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cdefs%3E%3CradialGradient id='b' cx='35%25' cy='30%25' r='75%25'%3E%3Cstop offset='0' stop-color='%23ffffff' stop-opacity='.85'/%3E%3Cstop offset='.3' stop-color='%23bae6fd' stop-opacity='.35'/%3E%3Cstop offset='.85' stop-color='%2338bdf8' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%237dd3fc' stop-opacity='.85'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='12' cy='12' r='10.5' fill='url(%23b)'/%3E%3Ccircle cx='8.6' cy='7.4' r='2' fill='%23ffffff' opacity='.9'/%3E%3C/svg%3E\")",
    matrix:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='96' viewBox='0 0 12 96'%3E%3Cg fill='%234ade80' font-family='monospace' font-size='10' text-anchor='middle'%3E%3Ctext x='6' y='9' fill-opacity='0.95'%3E%26%23x30A2;%3C/text%3E%3Ctext x='6' y='21' fill-opacity='0.7'%3E7%3C/text%3E%3Ctext x='6' y='33' fill-opacity='0.9'%3E%26%23x30DF;%3C/text%3E%3Ctext x='6' y='45' fill-opacity='0.6'%3EZ%3C/text%3E%3Ctext x='6' y='57' fill-opacity='0.95'%3E%26%23x30E9;%3C/text%3E%3Ctext x='6' y='69' fill-opacity='0.75'%3E1%3C/text%3E%3Ctext x='6' y='81' fill-opacity='0.9'%3E%26%23x30B1;%3C/text%3E%3Ctext x='6' y='93' fill-opacity='0.65'%3E0%3C/text%3E%3C/g%3E%3C/svg%3E\")",
  };

  let socket = null;
  let myId = null;
  let memberIds = [];        // everyone in the room (for names/labels)
  let callIds = [];          // socketIds currently in the call (peers to connect)
  const peerNames = new Map(); // socketId -> displayName
  let localStream = null;
  let inCall = false;
  let localUnwatch = null;
  const peers = new Map(); // socketId -> { pc, stream, unwatch }
  let myFx = { filter: 'none', overlay: 'none' };
  const peerFx = new Map(); // socketId -> { filter, overlay }

  // View modes: spotlight focus, active-speaker follow, fullscreen, resize.
  let focusId = null;      // 'me' | socketId of the spotlighted tile
  let autoFollow = true;   // follow the active remote speaker
  let lastFocusSwitch = 0;

  const el = (id) => document.getElementById(id);

  function avatarColor(name) {
    let h = 0;
    const s = String(name || '?');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function setStatus(text, isErr = false) {
    const s = el('call-status');
    s.textContent = text;
    s.classList.toggle('err', isErr);
  }

  // Turn a getUserMedia DOMException into advice a phone user can act on.
  function gumErrorMessage(err) {
    const name = err && err.name ? err.name : '';
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera/mic permission was denied. Tap the address bar\u2019s lock/\u24d8 icon \u2192 allow Camera & Microphone, then rejoin. (In-app browsers often block this \u2014 open the link in Safari or Chrome.)';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No camera/mic found on this device.';
      case 'NotReadableError':
        return 'Your camera is in use by another app. Close it (or other tabs) and try again.';
      case 'AbortError':
        return 'Camera start was interrupted. Try rejoining.';
      default:
        return `Could not access mic/camera: ${err && err.message ? err.message : name || 'unknown error'}`;
    }
  }

  function updateButtons() {
    el('call-join').disabled = inCall;
    el('call-leave').disabled = !inCall;
    el('call-mic').disabled = !inCall;
    el('call-cam').disabled = !inCall;
    el('call-fx').disabled = !inCall;
    el('call-view').disabled = !inCall;
    el('call-auto').disabled = !inCall;
    el('call-full').disabled = !inCall;
    updateStrip();
  }

  // The filmstrip only shows while at least one camera (mine or a peer's)
  // is actually on; otherwise the dock collapses to the control pill alone.
  function anyCameraOn() {
    if (localStream) {
      const v = localStream.getVideoTracks()[0];
      if (v && v.enabled && !v.muted) return true;
    }
    for (const st of peers.values()) {
      if (!st.stream) continue;
      const v = st.stream.getVideoTracks()[0];
      if (v && v.enabled && !v.muted) return true;
    }
    return false;
  }

  function updateStrip() {
    const strip = el('call-strip');
    if (!strip) return;
    strip.classList.toggle('no-cam', inCall && !anyCameraOn());
    const dock = strip.closest ? strip.closest('.call') : document.querySelector('.call');
    if (dock) dock.classList.toggle('in-call', inCall);
  }

  // Calls onSpeaking(true/false) as the stream gets loud/quiet.
  function watchVolume(stream, onSpeaking) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !stream || stream.getAudioTracks().length === 0) return () => {};
      const ctx = watchVolume.ctx || (watchVolume.ctx = new AC());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let speaking = false;
      let stopped = false;
      const tick = () => {
        if (stopped) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const live = Math.sqrt(sum / buf.length) > 0.06;
        if (live !== speaking) {
          speaking = live;
          onSpeaking(live);
        }
        requestAnimationFrame(tick);
      };
      tick();
      return () => {
        stopped = true;
        try {
          src.disconnect();
        } catch {
          /* already gone */
        }
      };
    } catch {
      return () => {};
    }
  }

  function localTile() {
    const v = el('local-video');
    return v && v.closest ? v.closest('.video-tile') : null;
  }

  function refreshLocalTile() {
    const tile = localTile();
    if (!tile || !localStream) return;
    const audio = localStream.getAudioTracks()[0];
    const video = localStream.getVideoTracks()[0];
    const mic = tile.querySelector('.mic-state');
    if (mic) {
      const muted = !audio || !audio.enabled;
      mic.classList.toggle('is-muted', muted);
      mic.innerHTML = muted ? MIC_OFF : MIC_ON;
    }
    tile.classList.toggle('camera-off', !video || !video.enabled);
    updateStrip();
  }

  function remoteTileFor(peerId) {
    let tile = document.querySelector(`[data-tile="${peerId}"]`);
    if (tile) return tile;
    const name = peerNames.get(peerId) || 'Guest';
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.setAttribute('data-tile', peerId);
    const v = document.createElement('video');
    v.setAttribute('data-remote', peerId);
    v.autoplay = true;
    v.playsInline = true;
    const overlay = document.createElement('div');
    overlay.className = 'camera-off-overlay';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = (name[0] || '?').toUpperCase();
    avatar.style.background = avatarColor(name);
    const who = document.createElement('span');
    who.className = 'tile-who';
    who.textContent = name;
    overlay.appendChild(avatar);
    overlay.appendChild(who);
    const label = document.createElement('span');
    label.className = 'tile-name';
    label.textContent = name;
    const mic = document.createElement('span');
    mic.className = 'mic-state';
    mic.innerHTML = MIC_ON;
    tile.appendChild(v);
    tile.appendChild(overlay);
    tile.appendChild(label);
    tile.appendChild(mic);
    el('remote-videos').appendChild(tile);
    const fx = peerFx.get(peerId);
    if (fx) applyFxToTile(tile, fx.filter, fx.overlay);
    updateStrip();
    return tile;
  }

  function refreshTileNames() {
    for (const [peerId, name] of peerNames) {
      const tile = document.querySelector(`[data-tile="${peerId}"]`);
      if (!tile) continue;
      const label = tile.querySelector('.tile-name');
      if (label) label.textContent = name;
      const who = tile.querySelector('.tile-who');
      if (who) who.textContent = name;
      const avatar = tile.querySelector('.camera-off-overlay .avatar');
      if (avatar) {
        avatar.textContent = (name[0] || '?').toUpperCase();
        avatar.style.background = avatarColor(name);
      }
    }
  }

  function refreshRemoteTile(peerId) {
    const tile = document.querySelector(`[data-tile="${peerId}"]`);
    const st = peers.get(peerId);
    if (!tile || !st || !st.stream) return;
    const audio = st.stream.getAudioTracks()[0];
    const video = st.stream.getVideoTracks()[0];
    const mic = tile.querySelector('.mic-state');
    if (mic) {
      const muted = !audio || audio.muted || !audio.enabled;
      mic.classList.toggle('is-muted', muted);
      mic.innerHTML = muted ? MIC_OFF : MIC_ON;
    }
    tile.classList.toggle('camera-off', !video || video.muted || !video.enabled);
    updateStrip();
  }

  function dropPeer(peerId, notify) {
    const st = peers.get(peerId);
    if (notify && st) {
      try {
        socket.emit('call:bye', { to: peerId });
      } catch {
        /* offline */
      }
    }
    if (st) {
      try {
        if (st.unwatch) st.unwatch();
      } catch {
        /* noop */
      }
      try {
        st.pc.close();
      } catch {
        /* already closed */
      }
      peers.delete(peerId);
    }
    document.querySelector(`[data-tile="${peerId}"]`)?.remove();
    if (focusId === peerId) setFocus(null);
    updateStrip();
  }

  // ---- View modes ----------------------------------------------------------
  const callPanel = () => (el('call-strip') ? el('call-strip').closest('.call') : null);
  const allTiles = () => document.querySelectorAll('.call-videos .video-tile');
  const tileKey = (t) => t.getAttribute('data-tile');

  function setFocus(key) {
    focusId = key;
    for (const t of allTiles()) t.classList.toggle('is-focus', tileKey(t) === key);
    const strip = el('call-strip');
    if (strip) strip.classList.toggle('mode-focus', !!key);
    const v = el('call-view');
    if (v) v.setAttribute('aria-pressed', key ? 'true' : 'false');
  }

  function reportSpeaking(key, tile, speaking) {
    if (tile) tile.classList.toggle('speaking', speaking);
    if (
      speaking && autoFollow && key !== 'me' && focusId !== key &&
      Date.now() - lastFocusSwitch > 700
    ) {
      lastFocusSwitch = Date.now();
      setFocus(key);
    }
  }

  function setAutoFollow(on) {
    autoFollow = on;
    const a = el('call-auto');
    if (a) a.setAttribute('aria-pressed', String(on));
    if (on) {
      const loudest = document.querySelector(
        '.video-tile.speaking[data-tile]:not([data-tile="me"])'
      );
      if (loudest) setFocus(tileKey(loudest));
    }
  }

  function toggleViewMode() {
    if (focusId) {
      setFocus(null);
      setAutoFollow(false);
      return;
    }
    const first =
      document.querySelector('#remote-videos .video-tile') ||
      document.querySelector('.call-videos .video-tile');
    if (first) setFocus(tileKey(first));
    setAutoFollow(false);
  }

  function toggleFullscreen() {
    const panel = callPanel();
    if (!panel) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (panel.requestFullscreen) {
      panel.requestFullscreen().catch(() => {
        panel.classList.toggle('call-fs');
        syncFsState();
      });
    } else {
      panel.classList.toggle('call-fs');
      syncFsState();
    }
  }

  function syncFsState() {
    const panel = callPanel();
    if (!panel) return;
    const on = !!document.fullscreenElement || panel.classList.contains('call-fs');
    panel.classList.toggle('is-fullscreen', on);
    const b = el('call-full');
    if (b) {
      b.title = on ? 'Exit fullscreen' : 'Fullscreen';
      b.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    }
  }
  document.addEventListener('fullscreenchange', syncFsState);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const panel = callPanel();
    if (panel && panel.classList.contains('call-fs') && !document.fullscreenElement) {
      panel.classList.remove('call-fs');
      syncFsState();
    }
  });

  function initResize() {
    const strip = el('call-strip');
    const handle = el('call-resize');
    if (!strip || !handle) return;
    const clampH = (v) => Math.max(120, Math.min(640, Math.round(v)));
    const saved = Number(localStorage.getItem('w2g-call-h'));
    if (saved >= 120 && saved <= 640) {
      strip.style.setProperty('--tile-h', saved + 'px');
      strip.setAttribute('data-sized', '');
    }
    const currentH = () => {
      const t = document.querySelector('.call-videos .video-tile');
      return t ? t.getBoundingClientRect().height || 240 : 240;
    };
    let dragging = false, startY = 0, startH = 0;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = strip.hasAttribute('data-sized')
        ? parseInt(strip.style.getPropertyValue('--tile-h'), 10) || 240
        : currentH();
      try { handle.setPointerCapture(e.pointerId); } catch { /* noop */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      strip.setAttribute('data-sized', '');
      strip.style.setProperty('--tile-h', clampH(startH + (e.clientY - startY)) + 'px');
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const h = parseInt(strip.style.getPropertyValue('--tile-h'), 10);
      if (h) localStorage.setItem('w2g-call-h', String(h));
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('dblclick', () => {
      strip.removeAttribute('data-sized');
      strip.style.removeProperty('--tile-h');
      try { localStorage.removeItem('w2g-call-h'); } catch { /* noop */ }
    });
  }

  function ensurePeer(peerId) {
    if (!inCall || !localStream || peerId === myId || peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers });
    peers.set(peerId, { pc, stream: null, unwatch: null, pendingIce: [], remoteSet: false });
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('call:signal', { to: peerId, payload: { type: 'ice', candidate } });
    };
    pc.ontrack = (e) => {
      const tile = remoteTileFor(peerId);
      const video = tile.querySelector('video');
      video.srcObject = e.streams[0];
      const st = peers.get(peerId);
      if (st) {
        st.stream = e.streams[0];
        if (st.unwatch) st.unwatch();
        st.unwatch = watchVolume(e.streams[0], (speaking) =>
          reportSpeaking(peerId, tile, speaking)
        );
      }
      for (const track of e.streams[0].getTracks()) {
        track.addEventListener('mute', () => refreshRemoteTile(peerId));
        track.addEventListener('unmute', () => refreshRemoteTile(peerId));
      }
      refreshRemoteTile(peerId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') setStatus(`Connection to a peer failed.`, true);
    };

    // Deterministic offerer: only the smaller id offers.
    if (myId < peerId) {
      pc.onnegotiationneeded = async () => {
        try {
          await pc.setLocalDescription();
          socket.emit('call:signal', {
            to: peerId,
            payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        } catch (err) {
          setStatus(`Call setup failed: ${err.message}`, true);
        }
      };
    }
  }

  // Apply any ICE candidates that arrived before the remote description was set.
  async function flushPendingIce(st) {
    const queued = st.pendingIce.splice(0);
    for (const candidate of queued) {
      try {
        await st.pc.addIceCandidate(candidate);
      } catch {
        /* stale candidate; ignore */
      }
    }
  }

  async function onSignal({ from, payload }) {
    if (!inCall || !payload) return;
    if (!peers.has(from)) {
      if (!memberIds.includes(from)) return; // stranger: ignore
      ensurePeer(from);
    }
    const st = peers.get(from);
    if (!st) return;
    const { pc } = st;
    try {
      if (payload.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        st.remoteSet = true;
        await flushPendingIce(st);
        await pc.setLocalDescription();
        socket.emit('call:signal', {
          to: from,
          payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        });
      } else if (payload.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        st.remoteSet = true;
        await flushPendingIce(st);
      } else if (payload.type === 'ice' && payload.candidate) {
        // Candidates can beat the offer/answer; queue until the remote
        // description exists, then addIceCandidate is safe.
        if (st.remoteSet && pc.remoteDescription) {
          await pc.addIceCandidate(payload.candidate);
        } else {
          st.pendingIce.push(payload.candidate);
        }
      }
    } catch (err) {
      setStatus(`Call error: ${err.message}`, true);
    }
  }

  async function joinCall() {
    if (inCall) return;
    // getUserMedia only exists in secure contexts (HTTPS/localhost). On phones
    // opened from an in-app browser (Instagram/Telegram/etc.) it's often absent
    // or blocked entirely.
    if (!window.isSecureContext) {
      setStatus('Camera/mic need a secure (HTTPS) page. Open this link directly in your browser.', true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('This browser can\u2019t access the camera. Open the link in Safari or Chrome (not inside another app).', true);
      return;
    }
    let voiceOnly = false;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (err) {
      // If the camera specifically is unavailable (missing/in use), still let
      // them join with voice only rather than blocking the whole call.
      if (err && (err.name === 'NotFoundError' || err.name === 'NotReadableError' || err.name === 'OverconstrainedError')) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          voiceOnly = true;
        } catch (err2) {
          setStatus(gumErrorMessage(err2), true);
          return;
        }
      } else {
        setStatus(gumErrorMessage(err), true);
        return;
      }
    }
    inCall = true;
    el('call-strip').hidden = false;
    const local = el('local-video');
    local.srcObject = localStream;
    local.play().catch(() => {});
    refreshLocalTile();
    if (localUnwatch) localUnwatch();
    localUnwatch = watchVolume(localStream, (speaking) => {
      reportSpeaking('me', localTile(), speaking);
    });
    const others = `${callIds.length} other${callIds.length === 1 ? '' : 's'} here`;
    setStatus(voiceOnly ? `In call, voice only \u2014 no camera (${others}).` : `In call (${others}).`);
    updateButtons();
    // Announce presence, then connect to everyone already in the call.
    socket.emit('call:join');
    for (const id of callIds) ensurePeer(id);
  }

  function leaveCall() {
    if (!inCall) return;
    for (const id of [...peers.keys()]) dropPeer(id, true);
    if (localUnwatch) {
      try {
        localUnwatch();
      } catch {
        /* noop */
      }
      localUnwatch = null;
    }
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
    }
    el('local-video').srcObject = null;
    el('call-strip').hidden = true;
    inCall = false;
    setFocus(null);
    setAutoFollow(true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setStatus('Not in call.');
    const micBtn = el('call-mic');
    const camBtn = el('call-cam');
    micBtn.classList.remove('is-off');
    camBtn.classList.remove('is-off');
    micBtn.setAttribute('aria-label', 'Mute microphone');
    micBtn.title = 'Mute microphone';
    camBtn.setAttribute('aria-label', 'Turn camera off');
    camBtn.title = 'Camera';
    setFxPanel(false);
    if (socket) socket.emit('call:leave');
    updateButtons();
  }

  function toggleTrack(kind, btn) {
    if (!localStream) return;
    const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
    const track = tracks[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const off = !track.enabled;
    btn.classList.toggle('is-off', off);
    const label =
      kind === 'audio'
        ? off
          ? 'Unmute microphone'
          : 'Mute microphone'
        : off
          ? 'Turn camera on'
          : 'Turn camera off';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    refreshLocalTile();
  }

  // ---- Camera effects -------------------------------------------------
  function clearFxLayer(tile) {
    for (const layer of tile.querySelectorAll ? tile.querySelectorAll('.fx-layer') : []) {
      layer.remove();
    }
  }

  const fxRnd = (a, b) => a + Math.random() * (b - a);

  function fxP(layer, o) {
    const p = document.createElement('i');
    p.className = 'fx-particle';
    if (o.left != null) p.style.left = o.left;
    if (o.top != null) p.style.top = o.top;
    p.style.setProperty('--fx-size', o.size + 'px');
    p.style.setProperty('--fx-dur', o.dur + 's');
    p.style.setProperty('--fx-delay', o.delay + 's');
    if (o.art) p.style.backgroundImage = FX_ART[o.art] || FX_ART.sparkles;
    layer.appendChild(p);
    return p;
  }

  function spawnParticles(tile, kind) {
    const layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.dataset.kind = kind;
    if (kind === 'starfall') {
      // twinkling stars pinned across the tile + occasional shooting streaks
      for (let i = 0; i < 14; i++) {
        fxP(layer, {
          left: fxRnd(4, 92).toFixed(1) + '%',
          top: fxRnd(4, 88).toFixed(1) + '%',
          size: Math.round(fxRnd(7, 15)),
          dur: fxRnd(1.6, 3.4).toFixed(1),
          delay: fxRnd(0, 3).toFixed(1),
          art: 'starfall',
        });
      }
      for (let i = 0; i < 2; i++) {
        const s = document.createElement('i');
        s.className = 'fx-shoot';
        s.style.top = fxRnd(8, 38).toFixed(0) + '%';
        s.style.left = '-18%';
        s.style.setProperty('--fx-dur', fxRnd(1.6, 2.6).toFixed(1) + 's');
        s.style.setProperty('--fx-delay', fxRnd(0.6, 3.4).toFixed(1) + 's');
        layer.appendChild(s);
      }
    } else if (kind === 'matrix') {
      // glyph columns raining down, head bright / tail fading via mask
      for (let i = 0; i < 11; i++) {
        const p = fxP(layer, {
          left: (i * 8.6 + fxRnd(0, 3)).toFixed(1) + '%',
          dur: fxRnd(1.1, 2.6).toFixed(2),
          delay: fxRnd(0, 2.4).toFixed(2),
          art: 'matrix',
        });
        p.style.width = '12px';
        p.style.height = Math.round(fxRnd(80, 130)) + 'px';
      }
    } else if (kind === 'fireworks') {
      // staggered burst points; each burst's sparks share a delay
      const colors = ['#fde68a', '#5eead4', '#f9a8d4', '#93c5fd'];
      for (let b = 0; b < 3; b++) {
        const burst = document.createElement('i');
        burst.className = 'fx-burst';
        burst.style.left = fxRnd(18, 78).toFixed(0) + '%';
        burst.style.top = fxRnd(14, 58).toFixed(0) + '%';
        burst.style.setProperty('--fx-delay', (b * 0.95).toFixed(2) + 's');
        burst.style.setProperty('--fx-c', colors[b % colors.length]);
        for (let k = 0; k < 10; k++) {
          const s = document.createElement('i');
          s.className = 'fx-spark';
          s.style.setProperty('--a', Math.round(k * 36 + fxRnd(-7, 7)) + 'deg');
          burst.appendChild(s);
        }
        layer.appendChild(burst);
      }
    } else if (kind === 'petals') {
      for (let i = 0; i < 12; i++) {
        fxP(layer, {
          left: fxRnd(2, 92).toFixed(1) + '%',
          size: Math.round(fxRnd(11, 19)),
          dur: fxRnd(4, 7).toFixed(1),
          delay: fxRnd(0, 5).toFixed(1),
          art: 'petals',
        });
      }
    } else if (kind === 'bubbles') {
      for (let i = 0; i < 9; i++) {
        fxP(layer, {
          left: fxRnd(4, 88).toFixed(1) + '%',
          size: Math.round(fxRnd(14, 32)),
          dur: fxRnd(3.2, 5.4).toFixed(1),
          delay: fxRnd(0, 4).toFixed(1),
          art: 'bubbles',
        });
      }
    } else {
      // legacy risers: sparkles / hearts / embers
      for (let i = 0; i < 10; i++) {
        fxP(layer, {
          left: fxRnd(4, 88).toFixed(1) + '%',
          size: Math.round(fxRnd(10, 20)),
          dur: fxRnd(2.4, 4.6).toFixed(1),
          delay: fxRnd(0, 3).toFixed(1),
          art: kind,
        });
      }
    }
    tile.appendChild(layer);
  }

  function applyFxToTile(tile, filter, overlay) {
    if (!tile) return;
    const f = FX_FILTERS.includes(filter) ? filter : 'none';
    const o = FX_OVERLAYS.includes(overlay) ? overlay : 'none';
    for (const name of FX_FILTERS) tile.classList.remove('fx-f-' + name);
    if (f !== 'none') tile.classList.add('fx-f-' + f);
    for (const frame of FX_FRAMES) tile.classList.remove('fx-frame-' + frame);
    clearFxLayer(tile);
    if (FX_FRAMES.includes(o)) tile.classList.add('fx-frame-' + o);
    else if (o !== 'none') spawnParticles(tile, o);
  }

  function applyFxToPeers() {
    for (const [peerId, fx] of peerFx) {
      applyFxToTile(document.querySelector(`[data-tile="${peerId}"]`), fx.filter, fx.overlay);
    }
  }

  function broadcastFx() {
    if (!inCall || !socket) return;
    socket.emit('call:fx', { filter: myFx.filter, overlay: myFx.overlay });
  }

  function chooseFx(which, value) {
    if (!FX_FILTERS.includes(value) && !FX_OVERLAYS.includes(value)) return;
    myFx[which] = value;
    applyFxToTile(localTile(), myFx.filter, myFx.overlay);
    broadcastFx();
  }

  function playConfettiBurst() {
    const colors = ['#5865f2', '#7b5cff', '#22d3ee', '#22c55e', '#f0b232', '#eb459e'];
    for (const tile of document.querySelectorAll('.video-tile')) {
      const layer = document.createElement('div');
      layer.className = 'fx-layer';
      layer.dataset.burst = '1';
      for (let i = 0; i < 22; i++) {
        const c = document.createElement('i');
        c.className = 'fx-confetti';
        c.style.left = (Math.random() * 100).toFixed(1) + '%';
        c.style.setProperty('--fx-size', (7 + Math.random() * 7).toFixed(0) + 'px');
        c.style.setProperty('--fx-color', colors[i % colors.length]);
        c.style.setProperty('--fx-dur', (1.2 + Math.random() * 0.9).toFixed(1) + 's');
        c.style.setProperty('--fx-delay', (Math.random() * 0.5).toFixed(2) + 's');
        layer.appendChild(c);
      }
      tile.appendChild(layer);
      setTimeout(() => layer.remove(), 2600);
    }
  }

  function sendBurst() {
    playConfettiBurst();
    if (inCall && socket) socket.emit('call:fx-burst');
  }

  function setFxPanel(open) {
    const panel = el('fx-panel');
    const btn = el('call-fx');
    if (!panel || !btn) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  function fxChipGroup(chip) {
    const group = chip.parentNode;
    if (!group || !group.children) return;
    for (const c of group.children) {
      if (c.setAttribute) c.setAttribute('aria-pressed', String(c === chip));
    }
  }

  function init(roomCode, roomSocket) {
    socket = roomSocket;
    socket.on('connect', () => {
      myId = socket.id;
    });
    myId = socket.id || null;

    socket.on('room:members', (list) => {
      const ids = list.map((m) => m.socketId).filter((id) => id !== socket.id);
      peerNames.clear();
      for (const m of list) peerNames.set(m.socketId, m.displayName);
      memberIds = ids;
      refreshTileNames();
      // Room membership means we are joined: pull current call roster + effects.
      socket.emit('call:members-get');
      socket.emit('call:fx-sync');
    });

    // Who is actually in the call. Only these become WebRTC peers.
    socket.on('call:members', (list) => {
      const ids = (list || []).filter((id) => id !== socket.id);
      const left = callIds.filter((id) => !ids.includes(id));
      callIds = ids;
      for (const id of left) {
        dropPeer(id, false);
        peerFx.delete(id);
      }
      if (inCall) {
        for (const id of ids) ensurePeer(id);
        setStatus(`In call (${ids.length} other${ids.length === 1 ? '' : 's'} here).`);
      }
    });

    socket.on('call:signal', onSignal);
    socket.on('call:bye', ({ from } = {}) => {
      if (from) dropPeer(from, false);
    });

    // Effects relay
    socket.on('call:fx', ({ from, filter, overlay } = {}) => {
      if (!from) return;
      const fx = {
        filter: FX_FILTERS.includes(filter) ? filter : 'none',
        overlay: FX_OVERLAYS.includes(overlay) ? overlay : 'none',
      };
      if (from === myId) {
        myFx = fx;
        applyFxToTile(localTile(), fx.filter, fx.overlay);
        return;
      }
      peerFx.set(from, fx);
      applyFxToTile(document.querySelector(`[data-tile="${from}"]`), fx.filter, fx.overlay);
    });
    socket.on('call:fx-state', (state = {}) => {
      for (const [id, raw] of Object.entries(state)) {
        const fx = {
          filter: FX_FILTERS.includes(raw && raw.filter) ? raw.filter : 'none',
          overlay: FX_OVERLAYS.includes(raw && raw.overlay) ? raw.overlay : 'none',
        };
        if (id === myId) {
          myFx = fx;
          applyFxToTile(localTile(), fx.filter, fx.overlay);
        } else {
          peerFx.set(id, fx);
          applyFxToTile(document.querySelector(`[data-tile="${id}"]`), fx.filter, fx.overlay);
        }
      }
      applyFxToPeers();
    });
    socket.on('call:fx-burst', () => playConfettiBurst());

    el('call-join').addEventListener('click', joinCall);
    el('call-leave').addEventListener('click', leaveCall);
    el('call-mic').addEventListener('click', () => toggleTrack('audio', el('call-mic')));
    el('call-cam').addEventListener('click', () => toggleTrack('video', el('call-cam')));

    el('call-fx').addEventListener('click', () => setFxPanel(el('fx-panel').hidden));
    el('fx-close').addEventListener('click', () => setFxPanel(false));
    el('call-view').addEventListener('click', toggleViewMode);
    el('call-auto').addEventListener('click', () => setAutoFollow(!autoFollow));
    el('call-full').addEventListener('click', toggleFullscreen);
    el('call-strip').addEventListener('click', (e) => {
      if (!inCall || !e.target || !e.target.closest) return;
      const tile = e.target.closest('.video-tile');
      if (!tile) return;
      const key = tileKey(tile);
      if (focusId === key) {
        setFocus(null);
        setAutoFollow(false);
      } else {
        setFocus(key);
        setAutoFollow(false);
      }
    });
    initResize();
    el('fx-panel').addEventListener('click', (e) => {
      const t = e && e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.fxFilter) {
        fxChipGroup(t);
        chooseFx('filter', t.dataset.fxFilter);
      } else if (t.dataset.fxOverlay) {
        fxChipGroup(t);
        chooseFx('overlay', t.dataset.fxOverlay);
      } else if (t.id === 'fx-burst') {
        sendBurst();
      }
    });

    updateButtons();
  }

  window.W2GCall = { init };
})();
