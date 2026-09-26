# Watch2Gether

Self-hosted movie nights: upload a video, share a room code, and watch in
perfect sync with friends. Includes live chat, a shared queue, and a
Discord-style voice/video call with camera effects.

- **Synced playback** — play/pause/seek stays in lockstep for everyone
- **Bring-your-own-file** — resumable chunked uploads, optional ffmpeg transcode
- **Live chat** with typing indicators and message grouping
- **Watch queue** — line up the next films together
- **Voice & video** — WebRTC mesh with a TURN relay for cross-network calls,
  plus camera filters/overlays that everyone in the room sees
- **Ephemeral by design** — rooms and their files are cleaned up automatically

## Quick start (local)

Requires **Node.js 18+**. `ffmpeg`/`ffprobe` are optional (uploads stream
as-is without them).

```bash
npm ci        # or: npm install
npm start     # serves on http://localhost:3000
```

Open http://localhost:3000, create a room, and share the link.

## One-command server setup

The installers provision the whole stack (app + systemd service, and
optionally Caddy for HTTPS and coturn for a TURN relay) on a fresh box.

**Linux (Ubuntu/Debian, run as root):**
```bash
sudo ./install.sh                      # app only, http://<ip>:3000
sudo DOMAIN=watch.example.com ./install.sh   # + Caddy HTTPS + TURN relay
```

**Windows (PowerShell):**
```powershell
./install.ps1                          # installs deps and runs the app
```

See [`INSTALL.md`](INSTALL.md) for options, environment variables, and how the
TURN relay is configured.

## Configuration

All settings are environment variables (all optional):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite DB + uploads |
| `MAX_FILE_MB` | `6144` | Max upload size |
| `TURN_SECRET` | — | Shared secret for TURN auth (enables relay) |
| `TURN_HOST` | — | Public IP/host of the TURN server |
| `TURN_TTL` | `43200` | TURN credential lifetime (seconds) |
| `ROOM_IDLE_MS` | `1800000` | Idle room cleanup timeout |
| `ROOM_EMPTY_MS` | `180000` | Empty room cleanup timeout |

Without `TURN_SECRET`/`TURN_HOST` the call uses public STUN only, which works
on the same network but may fail across strict NATs.

## Architecture

- **`src/server.js`** — Express + Socket.IO: rooms, chat, queue, playback sync,
  WebRTC signaling relay, uploads/streaming
- **`src/db.js`** — SQLite (better-sqlite3) schema and queries
- **`src/media.js`** — ffmpeg transcode pipeline (optional)
- **`public/`** — vanilla-JS client, one module per feature

## License

MIT
