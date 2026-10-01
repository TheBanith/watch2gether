# Install & deploy guide

Watch2Gether runs anywhere Node.js 18+ runs. Pick the path that fits.

## 1. Local / LAN (quickest)

**Any OS:**
```bash
npm ci
npm start          # http://localhost:3000
```

**Windows helper:**
```powershell
./install.ps1              # installs deps and starts
./install.ps1 -Port 8080
```

Same-network friends can reach it at `http://<your-lan-ip>:3000`. Camera/mic
needs a secure context, so cross-machine calls over plain HTTP only work on
`localhost`; use the server install below for HTTPS.

## 2. One-command server (Ubuntu/Debian)

Copy the repo to the box, then:

```bash
# App only — reachable at http://<server-ip>:3000
sudo ./install.sh

# Full public setup — HTTPS via Caddy + a TURN relay via coturn
sudo DOMAIN=watch.example.com ./install.sh

# Any of the env vars below can be passed through, e.g. on a small box:
sudo MAX_FILE_MB=3072 DOMAIN=watch.example.com ./install.sh
```

Point your domain's DNS `A` record at the server first; Caddy fetches a
Let's Encrypt cert automatically on start.

What `install.sh` does:
1. Installs Node.js, ffmpeg, and (with `DOMAIN`) Caddy + coturn
2. Creates a `watch` service user and installs to `/opt/watch2gether`
3. Runs `npm ci --omit=dev`
4. Writes and starts a `watch2gether` systemd service
5. With `DOMAIN`: generates a random TURN secret, wires it into the service,
   configures Caddy, and opens the firewall
6. Health-checks `/api/health` before finishing

It's idempotent — re-run it to update after pulling new code.

### Managing the service
```bash
systemctl status watch2gether
journalctl -u watch2gether -f          # live logs
systemctl restart watch2gether
```

## 3. Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite DB + uploads |
| `MAX_FILE_MB` | `6144` | Max upload size (MB) |
| `TURN_SECRET` | — | Shared secret for TURN auth |
| `TURN_HOST` | — | Public IP/host of the TURN server |
| `TURN_TTL` | `43200` | TURN credential lifetime (seconds) |
| `ROOM_IDLE_MS` | `1800000` | Idle-room cleanup (30 min) |
| `ROOM_EMPTY_MS` | `180000` | Empty-room cleanup (3 min) |

Set these as `Environment=` lines in the systemd unit (the installer already
does this for the TURN values).

## Why TURN matters

WebRTC tries a direct peer-to-peer path first (helped by STUN). When both
peers are behind strict/symmetric NATs — common on home ISPs and mobile data —
the direct path fails and media needs a relay. `install.sh` with `DOMAIN` sets
up coturn and hands the app short-lived HMAC credentials via `/api/ice`, so
cross-network calls work reliably. Media relayed through TURN uses the
server's bandwidth.

## Restoring from a backup archive

A backup tarball contains `app/` (code + `data/`) and `config/` (systemd unit,
Caddyfile, turnserver.conf). To restore, drop `app/` into `/opt/watch2gether`,
run `install.sh` (which reinstalls deps and the service), then copy any config
you want to keep — adjusting `TURN_HOST`/`DOMAIN` to the new server.
