# chat/v5 — CLAUDE.md

## What it is

Browser-based P2P chat application built on **libp2p**. Two communication layers:
- **Layer 1 (fallback):** GossipSub over WebSocket → relay server (relay sees encrypted blobs)
- **Layer 2 (direct):** WebRTC DataChannel — relay cannot see messages

E2E encryption: AES-GCM-256, PBKDF2-SHA256 (250k iterations). Wire format: `{"v":1,"salt":"<b64>","iv":"<b64>","ct":"<b64>"}` (JSON, debuggable).

## Key files

| File | Description |
|------|-------------|
| `src/app.js` | Browser client |
| `PROTOCOL.md` | Protocol design, connection scenarios, scaling analysis |
| `src/relay.mjs` | Relay server (Node.js, circuit-relay-v2 + GossipSub) |
| `index.html` | UI (Polish, GitHub dark theme) |
| `webpack.config.cjs` | Bundler — output: `dist/` |

## Commands

```bash
npm run dev        # webpack dev server on port 3000
npm run build      # build dist/ (production frontend)
npm run relay      # start relay server (see flags below)
```

### Relay flags

```bash
node src/relay.mjs --port 9001 --pass <secret> [--host bs1.onchato.com] [--peers <multiaddr>...]
```

- `--pass` — determines PeerId (sha256 → Ed25519 seed); **must be stable across restarts**
- `--port` — TCP port for WebSocket listener
- `--host` — if set, prints the production WSS multiaddr (via nginx)
- `--peers` — addresses of other relays to dial on startup

## Local testing

Start three terminals:

```bash
# Terminal 1 — relay (note the printed multiaddr)
npm run relay -- --port 9001 --pass test123

# Terminal 2 — frontend
npm run dev
```

Open two separate browser windows at `http://localhost:3000`, paste the relay multiaddr into each, click Start. WebRTC DataChannel should establish after GossipSub connects.

### Multi-relay mesh (local)

```bash
# Start relay 1 first, copy its multiaddr AAA...
npm run relay -- --port 9001 --pass r1

# Relay 2 and 3 connect to relay 1 on startup
npm run relay -- --port 9002 --pass r2 --peers /ip4/127.0.0.1/tcp/9001/ws/p2p/AAA...
npm run relay -- --port 9003 --pass r3 --peers /ip4/127.0.0.1/tcp/9001/ws/p2p/AAA...
```

GossipSub mesh propagates messages between all relays — clients on different relays can chat.

## Production architecture (onchato.com)

```
Internet
  ├── onchato.com:443     (nginx + Let's Encrypt TLS)
  │     └── GET /         →  /var/www/onchato/   (dist/)
  └── bs1.onchato.com:443 (nginx + Let's Encrypt TLS)
        ├── WSS /relay    →  ws://127.0.0.1:9001  (Node.js relay)
        └── GET /health   →  "bs1 ok"

Node.js relay:  /opt/onchato/src/relay.mjs
systemd:        onchato-relay.service
```

**Browser multiaddr:**
```
/dns4/bs1.onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/<PEERID>
```

PeerId is deterministic from `--pass` — the relay prints it on startup.

## Deployment files

| File | Target on server |
|------|-----------------|
| `deploy/nginx-onchato.conf` | `/etc/nginx/sites-available/onchato` |
| `deploy/relay.service` | `/etc/systemd/system/onchato-relay.service` |
| `deploy/deploy.sh` | local script — build + rsync + restart |

## First deployment instructions

### On the server (one time)

```bash
# 1. Install Node.js and nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx

# 2. Create directories
sudo mkdir -p /opt/onchato /var/www/onchato
sudo chown $USER:$USER /opt/onchato

# 3. nginx config
sudo cp /opt/onchato/deploy/nginx-onchato.conf /etc/nginx/sites-available/onchato
sudo ln -s /etc/nginx/sites-available/onchato /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. TLS
sudo certbot --nginx -d onchato.com

# 5. Edit --pass in relay.service, then install
sudo cp /opt/onchato/deploy/relay.service /etc/systemd/system/onchato-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now onchato-relay

# 6. Check logs — copy PeerId from output
sudo journalctl -u onchato-relay -f
```

### Locally — each deploy

```bash
./deploy/deploy.sh [user@onchato.com]
```

## Security

### Limits in place
- GossipSub `maxMessageSize: 65536` (64 KB) — prevents message flood abuse
- GossipSub topic cap: `MAX_TOPICS = 50` — prevents topic exhaustion DoS
- Circuit relay reservations: `maxReservations: 256`
- Port 9001 not exposed directly — nginx reverse proxy only
- NOISE encryption on libp2p transport layer

### Not implemented (acceptable for current scope)
- Per-peer rate limiting
- TURN server (WebRTC falls back to GossipSub relay on symmetric NAT)

## Status

### Done
- [x] P2P chat over GossipSub (relay fallback)
- [x] WebRTC DataChannel with automatic signaling via GossipSub
- [x] E2E encryption AES-GCM-256
- [x] `npm run build` script
- [x] `--host` flag in relay.mjs (prints production WSS multiaddr)
- [x] Security limits: maxMessageSize, topic cap, maxConnections, LimitNOFILE
- [x] E2E wire format changed from binary base64 blob to JSON (debuggable)
- [x] GossipSub send optimisation: skip relay publish when all peers have open DataChannel
- [x] Deployment files: nginx config, systemd service, deploy.sh

### Done (continued)
- [x] First deployment to onchato.com
- [x] Connection tests: via relay (GossipSub) ✓ and direct (WebRTC DataChannel) ✓
- [x] Fix: custom WebSocket filter to support `http-path` multiaddr (was rejected by `exactMatch`)
- [x] Fix: relay node excluded from `allDirect` check (`relayPeerIds` Set)
- [x] Nickname system: `_nick/<TOPIC>` GossipSub topic, displayed in messages
- [x] GossipSub mesh degree increased: D=8, Dlo=6, Dhi=12 (for ~25 clients)
- [x] Auth stub: `src/auth-server.mjs` + nginx `auth_request` block (commented out)
- [x] Cleaned up version refs (v3/v4), added `dist/` to `.gitignore`

### In progress
- [ ] 25-client load test

### To consider later
- [ ] Enable auth: uncomment nginx `auth_request`, plug 3rd party JWT into `auth-server.mjs`
- [ ] TURN server (if WebRTC fails on symmetric NAT networks)
- [ ] Second relay instance (redundancy)

## Full product — architecture decisions

v5 is a **PoC/testbed**. After deployment evaluation, the full product will be a separate project.

**Planned stack:** React + TypeScript + Vite → Tauri (desktop) + Capacitor (mobile). One codebase, three platforms.

**UI:** ready-made Slack-like React template from marketplace. P2P logic plugged in as framework-agnostic modules.

**Module structure (agreed):**
```
src/lib/       — pure P2P logic (port crypto + signaling from v5)
src/store/     — state management (Zustand/Redux)
src/hooks/     — React bindings
```

**Identity:** Encedo HEM will handle identity, user list, peer associations. Placeholder in `store/identity.ts` until integration spec is ready.

**Message history:** user-selectable — persistent (IndexedDB) or ephemeral (in-memory).
