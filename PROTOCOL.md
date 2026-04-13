# chat/v5 — Protocol & Architecture

## Transport layers

The application uses two independent transport layers simultaneously. The sender always attempts both; the receiver deduplicates.

| Layer | Protocol | Who can see messages | Fallback for |
|-------|----------|----------------------|--------------|
| 1 | GossipSub over WebSocket → relay | Relay (sees encrypted blobs) | everyone |
| 2 | WebRTC DataChannel (direct P2P) | Nobody except endpoints | peers behind normal NAT |

**Deduplication rule** (receiver side): if a GossipSub message arrives from a peer that already has an open DataChannel, it is silently dropped.

**GossipSub send optimisation**: the sender skips GossipSub publish when every subscriber returned by `getSubscribers(TOPIC)` has an open DataChannel. If this causes missed messages during testing, replace the conditional with an unconditional publish (see comment in `app.js sendMsg()`).

---

## E2E encryption

Algorithm: AES-GCM-256 with PBKDF2-SHA256 key derivation (250,000 iterations).

Wire format (JSON string, sent as UTF-8):
```json
{"v":1,"salt":"<base64 16 B>","iv":"<base64 12 B>","ct":"<base64 ciphertext>"}
```

- `v` — format version; allows future migration without breaking parsers
- `salt` — random per message, fed into PBKDF2 alongside the passphrase
- `iv` — random per message, used as AES-GCM nonce
- `ct` — AES-GCM ciphertext + 16 B authentication tag

The relay never sees plaintext. The relay does see the JSON envelope (field names and lengths), but not the content.

---

## GossipSub topic model

Messages are strictly scoped to the topic they are published on. A message on `room-A` is never delivered to subscribers of `room-B`.

```
Topic "room-A":  user1, user2, user3, user4
Topic "room-B":  user5, user6, user7, user8

Message from user1 → relay retransmits only within room-A
user5-8 receive nothing
```

The relay auto-subscribes to every topic that any connected peer subscribes to (capped at `MAX_TOPICS = 50`). This is necessary for GossipSub retransmission to work — a relay that does not subscribe to a topic will not propagate messages on that topic.

### Relay mesh (multi-relay)

Relays interconnect via `--peers`. GossipSub mesh distributes messages across all connected relays using flood + seen-message deduplication.

```
user1 (relay1) sends to "room-A"
  relay1 → relay2 → relay3 → relay4 → user2
```

Relays do not route: they flood within the mesh. Each relay keeps a seen-message cache (2 windows, ~2 min) and drops already-seen message IDs. No cycles.

For a relay farm it is sufficient for each relay to connect to 2–3 others. A ring topology works; full mesh is not needed.

---

## WebRTC signaling flow

Signaling travels over GossipSub (through the relay mesh). Each peer subscribes to a private signal topic `_signal/<ownPeerId>`. The peer with the lexicographically higher PeerId always initiates the offer (prevents double-offer races).

```
t = 0 s   user1 and user2 connect to their respective relays
t = 1 s   subscription-change for _signal/<peerId> propagates across mesh
t = 1.5 s higher PeerId sends SDP offer via GossipSub → _signal/<remotePeerId>
t = 2 s   remote sends SDP answer via GossipSub → _signal/<localPeerId>
t = 2–4 s ICE candidates exchanged via the same signal topics
t = 4 s   UDP hole punching attempted (STUN: stun.l.google.com:19302)
t = 4 s+  DataChannel open (🟢) or WebRTC fails → GossipSub fallback (⚪)
```

Signaling messages are small (~2 KB SDP + ICE candidates). After the DataChannel opens, the relay carries no application data for that peer pair.

### Why WebRTC may fail (symmetric NAT)

STUN discovers each peer's public IP:port. On a symmetric NAT, the router assigns a different port for every outbound destination — STUN-discovered candidates are invalid for direct connection. Without a TURN server the DataChannel cannot be established; the application falls back to GossipSub relay transparently.

---

## Mixed connectivity scenario

4 users on `room-A`. D is behind a symmetric NAT; A, B, C have mutual WebRTC connections.

```
A ←─ WebRTC ─→ B
A ←─ WebRTC ─→ C
B ←─ WebRTC ─→ C
A, B, C ←─ GossipSub ─→ relay ←─ GossipSub ─→ D
```

**A sends:**
- WebRTC → B ✓, WebRTC → C ✓
- GossipSub → relay → D ✓
- GossipSub copy arrives at B, C → dropped (deduplication)

**D sends:**
- No DataChannels → GossipSub only → relay → A, B, C ✓
- A, B, C: D not in `dataChannels` → message displayed

| Sender | Via WebRTC | Via relay |
|--------|-----------|-----------|
| A | B, C | D |
| B | A, C | D |
| C | A, B | D |
| D | — | A, B, C |

---

## Performance & scaling

### Memory per relay node

| Component | Size |
|-----------|------|
| Node.js + libp2p baseline | ~70 MB |
| Per connected peer (WebSocket + NOISE + Yamux + GossipSub state) | ~120 KB |
| Circuit relay reservations (max 256 × ~10 KB) | ~2.5 MB |
| GossipSub message cache (50 topics × ~20 msg × 64 KB worst case) | up to 64 MB |
| Seen-message dedup cache (~2 min window) | ~10 MB |

### Estimated RAM vs concurrent users (text chat workload)

| Users | RAM |
|-------|-----|
| 100 | ~100 MB |
| 500 | ~150 MB |
| 1 000 | ~200 MB |
| 5 000 | ~700 MB |

Dominant bottleneck at scale is **outbound network bandwidth**, not RAM. The relay is a hub: one incoming message is forwarded to all topic subscribers.

```
Example: 1 000 users, 10 messages/min, 500 B average
  Inbound:  1 000 × 500 B/min = 500 KB/min  (negligible)
  Outbound: 10 msg × 999 recipients × 500 B = ~5 MB/min per active topic
```

Traffic is proportional to (messages/min × subscribers per topic), not total user count. Users on different topics do not affect each other's bandwidth.

### Relay node sizing

| Concurrent users | RAM | CPU | Network |
|-----------------|-----|-----|---------|
| up to 500 | 512 MB | 1 vCPU | 100 Mbps |
| up to 2 000 | 1 GB | 2 vCPU | 1 Gbps |
| up to 5 000 | 2 GB | 2 vCPU | 1 Gbps |

### Enforced limits (relay)

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `maxConnections` | 520 | libp2p connection cap (512 clients + inter-relay headroom) |
| `maxReservations` | 256 | circuit-relay v2 reservation cap |
| `MAX_TOPICS` | 50 | GossipSub topic subscription cap (DoS protection) |
| `maxMessageSize` | 65 536 B (64 KB) | GossipSub per-message size limit |
| `historyLength` | 2 | GossipSub message cache windows (~2 min) |
| `historyGossip` | 1 | GossipSub gossip announcement window |
| `LimitNOFILE` | 65 536 | OS file descriptor limit (systemd) |

### Horizontal scaling (relay farm)

Hard-code 3–5 relay addresses in the application as bootstrap nodes. Each relay connects to at least 2 others via `--peers`. A ring or partial mesh is sufficient — GossipSub builds the full mesh automatically.

```
app bootstrap list:
  relay1.onchato.com
  relay2.onchato.com
  relay3.onchato.com

inter-relay connections:
  relay1 ←→ relay2 ←→ relay3 ←→ relay1  (ring)
```

Adding a new relay: connect it to any 2 existing relays via `--peers`. It will be discovered by GossipSub mesh expansion within seconds.

---

## Open items

- TURN server: required for WebRTC on symmetric NAT networks (corporate, some LTE). Without it, affected users fall back to GossipSub relay. Evaluate after initial deployment testing.
- Per-IP rate limiting: not implemented; can be added at the nginx level if abuse is observed.

## Scope note

This document describes v5 — a PoC/testbed. The full product (React + TypeScript + Vite, Tauri desktop, Capacitor mobile) will reuse the crypto and signaling protocol defined here, implemented as framework-agnostic modules. Identity layer (Encedo HEM) is out of scope for v5.
