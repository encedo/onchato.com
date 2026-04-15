/**
 * Browser node
 *
 * Transport:
 *  - Layer 1: GossipSub via WebSocket relay (always works, fallback)
 *  - Layer 2: RTCDataChannel direct (peer-to-peer, relay cannot see messages)
 *
 * WebRTC signaling via GossipSub:
 *  Topic `_signal/<peerId>` — SDP offer/answer + ICE candidates
 *
 * Single user API: text input + Send.
 * sendMsg() automatically selects DataChannel (if open) or GossipSub.
 */

import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { multiaddr } from '@multiformats/multiaddr'
import { fromString, toString } from 'uint8arrays'

let node = null
let TOPIC = 'libp2p-chat-demo'
const SIG_PREFIX = '_signal/'
const NICK_PREFIX = '_nick/'

// Relay server PeerIds — they have no DataChannel, excluded from allDirect check
const relayPeerIds = new Set()

// peerId → RTCPeerConnection
const peerConns = new Map()
// peerId → RTCDataChannel (open)
const dataChannels = new Map()
// peerId → queued ICE candidates (before remote description is set)
const iceCandidateQueue = new Map()
// peerId → nickname
const nickMap = new Map()

const displayName = (peerId) => nickMap.get(peerId) || (peerId.slice(0, 12) + '...')

// ── Crypto (AES-GCM 256 + PBKDF2/SHA-256) ───────────────────────────────────

const _enc = new TextEncoder()
const _dec = new TextDecoder()
const _b64enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const _b64dec = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

const _getKey = (pass) =>
  crypto.subtle.importKey('raw', _enc.encode(pass), 'PBKDF2', false, ['deriveKey'])

const _deriveKey = (key, salt, usage) =>
  crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    key, { name: 'AES-GCM', length: 256 }, false, usage
  )

// Message format (JSON, readable for debugging):
// {"v":1,"salt":"<b64 16B>","iv":"<b64 12B>","ct":"<b64 ciphertext>"}
// v=1 — format version, allows future migration without breaking changes

async function encryptMsg(text, pass) {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv   = crypto.getRandomValues(new Uint8Array(12))
    const aesKey = await _deriveKey(await _getKey(pass), salt, ['encrypt'])
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, _enc.encode(text))
    return JSON.stringify({
      v:    1,
      salt: _b64enc(salt),
      iv:   _b64enc(iv),
      ct:   _b64enc(new Uint8Array(ct))
    })
  } catch (e) { console.error('encrypt:', e); return text }
}

async function decryptMsg(data, pass) {
  try {
    const { v, salt, iv, ct } = JSON.parse(data)
    if (v !== 1) return '[unknown format version]'
    const aesKey = await _deriveKey(await _getKey(pass), _b64dec(salt), ['decrypt'])
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _b64dec(iv) }, aesKey, _b64dec(ct))
    return _dec.decode(dec)
  } catch (e) { return '[błąd deszyfrowania — złe hasło?]' }
}

// ── UI ────────────────────────────────────────────────────────────────────────

const log = (msg, cls = '') => {
  const el = document.getElementById('log')
  const d = document.createElement('div')
  d.className = 'msg ' + cls
  d.textContent = msg
  el.appendChild(d)
  el.scrollTop = el.scrollHeight
}

const setStatus = (text, ok = true) => {
  const el = document.getElementById('status')
  el.textContent = text
  el.className = ok ? 'ok' : 'err'
}

const updateConnBadge = () => {
  const el = document.getElementById('conn-badge')
  el.style.display = 'inline-block'
  const direct = dataChannels.size
  if (direct > 0) {
    el.textContent = `🟢 WebRTC Direct (${direct})`
    el.className = 'badge direct'
  } else if (peerConns.size > 0) {
    el.textContent = `🟡 WebRTC handshake w toku...`
    el.className = 'badge relay'
  } else {
    el.textContent = `⚪ WebSocket → Relay`
    el.className = 'badge ws'
  }
}

// ── WebRTC signaling ───────────────────────────────────────────────────────────

const webRTCAvailable = typeof RTCPeerConnection !== 'undefined'
const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

async function sendSignal(toPeerId, payload) {
  const topic = SIG_PREFIX + toPeerId
  try {
    await node.services.pubsub.publish(
      topic,
      fromString(JSON.stringify(payload), 'utf8')
    )
  } catch (e) {
    // ignore — subscriber may not exist yet
  }
}

async function createOffer(remotePeerId) {
  if (!webRTCAvailable) return
  if (peerConns.has(remotePeerId)) return // already in progress

  log(`WebRTC: inicjuję połączenie z ${remotePeerId.slice(0, 16)}...`, 'info')
  const pc = new RTCPeerConnection(STUN)
  peerConns.set(remotePeerId, pc)
  iceCandidateQueue.set(remotePeerId, [])

  // DataChannel — initiating side
  const dc = pc.createDataChannel('chat')
  setupDataChannel(dc, remotePeerId)

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(remotePeerId, { type: 'ice', from: node.peerId.toString(), candidate: e.candidate })
    }
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      peerConns.delete(remotePeerId)
      updateConnBadge()
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  sendSignal(remotePeerId, { type: 'offer', from: node.peerId.toString(), sdp: offer })
}

async function handleOffer(fromPeerId, offer) {
  if (!webRTCAvailable) return
  if (peerConns.has(fromPeerId)) return

  log(`WebRTC: odbieram offer od ${fromPeerId.slice(0, 16)}...`, 'info')
  const pc = new RTCPeerConnection(STUN)
  peerConns.set(fromPeerId, pc)
  iceCandidateQueue.set(fromPeerId, [])

  // DataChannel — answering side
  pc.ondatachannel = (e) => {
    setupDataChannel(e.channel, fromPeerId)
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(fromPeerId, { type: 'ice', from: node.peerId.toString(), candidate: e.candidate })
    }
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      peerConns.delete(fromPeerId)
      updateConnBadge()
    }
  }

  await pc.setRemoteDescription(offer)

  // Flush queued ICE candidates
  const queued = iceCandidateQueue.get(fromPeerId) || []
  for (const c of queued) await pc.addIceCandidate(c)
  iceCandidateQueue.set(fromPeerId, [])

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  sendSignal(fromPeerId, { type: 'answer', from: node.peerId.toString(), sdp: answer })
}

async function handleAnswer(fromPeerId, answer) {
  const pc = peerConns.get(fromPeerId)
  if (!pc) return
  await pc.setRemoteDescription(answer)

  // Flush queued ICE candidates
  const queued = iceCandidateQueue.get(fromPeerId) || []
  for (const c of queued) await pc.addIceCandidate(c)
  iceCandidateQueue.set(fromPeerId, [])
}

async function handleICE(fromPeerId, candidate) {
  const pc = peerConns.get(fromPeerId)
  if (!pc) return
  if (pc.remoteDescription) {
    await pc.addIceCandidate(candidate)
  } else {
    // Queue — remote description not set yet
    const q = iceCandidateQueue.get(fromPeerId) || []
    q.push(candidate)
    iceCandidateQueue.set(fromPeerId, q)
  }
}

function setupDataChannel(dc, remotePeerId) {
  dc.onopen = () => {
    dataChannels.set(remotePeerId, dc)
    log(`🟢 WebRTC DataChannel otwarty z ${remotePeerId.slice(0, 16)}...`, 'ok')
    updateConnBadge()
  }
  dc.onclose = () => {
    dataChannels.delete(remotePeerId)
    log(`DataChannel zamknięty z ${remotePeerId.slice(0, 16)}...`, 'info')
    updateConnBadge()
  }
  dc.onmessage = async (e) => {
    const text = await decryptMsg(e.data, document.getElementById('passphrase-input').value.trim() || 'libp2p-default-2025')
    log(`[${displayName(remotePeerId)}] ${text}`, 'peer-msg')
  }
  dc.onerror = (e) => {
    log(`DataChannel błąd: ${e.message}`, 'err')
  }
}

// ── GossipSub message handler ─────────────────────────────────────────────────

async function handlePubsubMessage(evt) {
  const topic = evt.detail.topic
  const from = evt.detail.from.toString()

  // Chat messages via relay — ignore if we have an open DataChannel with this peer
  if (topic === TOPIC) {
    if (dataChannels.has(from)) return // already received via WebRTC
    const raw = toString(evt.detail.data, 'utf8')
    const text = await decryptMsg(raw, document.getElementById('passphrase-input').value.trim() || 'libp2p-default-2025')
    log(`[${displayName(from)}] ${text}`, 'peer-msg')
    return
  }

  // Nick announcements
  if (topic === NICK_PREFIX + TOPIC) {
    try {
      const { type, nick, peer } = JSON.parse(toString(evt.detail.data, 'utf8'))
      if (type === 'nick' && nick && peer && peer !== node.peerId.toString()) {
        const prev = nickMap.get(peer)
        nickMap.set(peer, nick)
        if (!prev) log(`→ ${nick} dołączył/a`, 'info')
        else if (prev !== nick) log(`→ ${prev} zmienił/a nick na ${nick}`, 'info')
      }
    } catch (e) { /* ignore */ }
    return
  }

  // WebRTC signals — only messages addressed to us
  if (topic === SIG_PREFIX + node.peerId.toString()) {
    try {
      const msg = JSON.parse(toString(evt.detail.data, 'utf8'))
      if (msg.from === node.peerId.toString()) return // own echo

      if (msg.type === 'offer') handleOffer(msg.from, msg.sdp)
      else if (msg.type === 'answer') handleAnswer(msg.from, msg.sdp)
      else if (msg.type === 'ice') handleICE(msg.from, msg.candidate)
    } catch (e) {
      // ignore parse errors
    }
  }
}

// ── Nick announcement ─────────────────────────────────────────────────────────

function announceNick() {
  if (!node) return
  const nick = document.getElementById('nick-input').value.trim()
  if (!nick) return
  const payload = fromString(JSON.stringify({ type: 'nick', nick, peer: node.peerId.toString() }), 'utf8')
  node.services.pubsub.publish(NICK_PREFIX + TOPIC, payload).catch(() => {})
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-start').addEventListener('click', async () => {
  const relayAddrs = Array.from(document.querySelectorAll('.relay-addr'))
    .map(el => el.value.trim()).filter(Boolean)
  if (relayAddrs.length === 0) return alert('Dodaj przynajmniej jeden relay!')

  TOPIC = document.getElementById('topic-input').value.trim() || 'libp2p-chat-demo'
  // passphrase is read on each send
  document.getElementById('btn-start').disabled = true
  document.getElementById('topic-input').disabled = true
  setStatus('Łączenie...', true)
  log(`Startuję węzeł... (temat: ${TOPIC})`)

  try {
    node = await createLibp2p({
      transports: [webSockets({ filter: addrs => addrs.filter(ma => /\/(wss?)(\/|$)/.test(ma.toString())) })],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: { denyDialMultiaddr: () => false },
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
          floodPublish: true,
          D: 8, Dlo: 6, Dhi: 12, Dout: 0
        })
      }
    })

    window.__libp2pNode = node

    // Subscribe to chat topic + own signaling channel (if WebRTC available)
    node.services.pubsub.subscribe(TOPIC)
    if (webRTCAvailable) {
      node.services.pubsub.subscribe(SIG_PREFIX + node.peerId.toString())
    } else {
      log('⚠️ WebRTC niedostępne — tryb fallback WebSocket/GossipSub', 'info')
    }

    node.services.pubsub.addEventListener('message', handlePubsubMessage)

    // When a new peer appears on GossipSub → initiate WebRTC offer.
    // Only the peer with the higher PeerId initiates (deterministic, avoids double offer).
    node.services.pubsub.addEventListener('subscription-change', (evt) => {
      if (!webRTCAvailable) return
      for (const { topic, subscribe } of evt.detail.subscriptions) {
        if (!subscribe) continue
        // Another peer subscribed to their own signaling channel
        if (topic.startsWith(SIG_PREFIX)) {
          const theirPeerId = topic.slice(SIG_PREFIX.length)
          if (theirPeerId === node.peerId.toString()) continue
          // Subscribe to their signaling channel so they receive our signals
          if (!node.services.pubsub.getTopics().includes(topic)) {
            node.services.pubsub.subscribe(topic)
          }
          // Higher PeerId initiates offer (single offer, no collision)
          if (node.peerId.toString() > theirPeerId) {
            setTimeout(() => createOffer(theirPeerId), 500)
          }
        }
      }
    })

    node.addEventListener('peer:connect', (evt) => {
      log('Peer połączony: ' + evt.detail.toString().slice(0, 16) + '...', 'ok')
      setTimeout(announceNick, 1000) // introduce ourselves to the new peer
    })

    await node.start()
    log('PeerID: ' + node.peerId.toString(), 'info')

    log(`Łączę z ${relayAddrs.length} relay...`, 'info')
    const results = await Promise.allSettled(
      relayAddrs.map(addr => {
        const ma = multiaddr(addr)
        const pid = ma.getPeerId()
        if (pid) relayPeerIds.add(pid)
        return node.dial(ma)
      })
    )
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') log(`  ✓ relay ${i + 1} połączony`, 'ok')
      else log(`  ✗ relay ${i + 1}: ${r.reason?.message}`, 'err')
    })

    const connected = results.filter(r => r.status === 'fulfilled').length
    if (connected === 0) throw new Error('Żaden relay niedostępny')

    setStatus(`Połączono z ${connected}/${relayAddrs.length} relay ✓`, true)
    document.getElementById('chat-section').style.display = 'block'
    document.getElementById('send-section').style.display = 'block'
    document.getElementById('conn-badge').style.display = 'inline-block'
    document.getElementById('nick-input').disabled = true
    updateConnBadge()

    // Subscribe to nick topic and announce own nick
    node.services.pubsub.subscribe(NICK_PREFIX + TOPIC)
    setTimeout(announceNick, 2000) // after 2s — give GossipSub time to settle
    setInterval(announceNick, 60000) // keepalive every 60s

    // Poll until GossipSub mesh is ready
    const poll = setInterval(() => {
      if (!node) return clearInterval(poll)
      const subs = node.services.pubsub.getSubscribers(TOPIC)
      if (subs.length > 0) {
        log(`✓ GossipSub gotowy — ${subs.length} subskrybent/ów`, 'ok')
        if (webRTCAvailable) log('Czekam na WebRTC handshake...', 'info')
        clearInterval(poll)
      }
    }, 1000)
    setTimeout(() => clearInterval(poll), 30000)

  } catch (err) {
    console.error(err)
    log('Błąd: ' + err.message, 'err')
    setStatus('Błąd', false)
    document.getElementById('btn-start').disabled = false
    document.getElementById('topic-input').disabled = false
  }
})

// ── Debug ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-debug').addEventListener('click', () => {
  if (!node) return log('Węzeł nie uruchomiony', 'err')
  const conns = node.getConnections()
  log('── Diagnostyka ──', 'info')
  conns.forEach(c => log(`⚪ WS ${c.remoteAddr.toString().slice(0, 65)}`, 'info'))
  const subs = node.services.pubsub.getSubscribers(TOPIC)
  log(`GossipSub: peers=${node.services.pubsub.getPeers().length} subs=${subs.length}`, 'info')
  log(`WebRTC: conns=${peerConns.size} dataChannels=${dataChannels.size}`, 'info')
  log(`Moje tematy: ${node.services.pubsub.getTopics().length}`, 'info')
})

// ── Send ──────────────────────────────────────────────────────────────────────

document.getElementById('btn-send').addEventListener('click', sendMsg)
document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMsg()
})

async function sendMsg() {
  const input = document.getElementById('msg-input')
  const text = input.value.trim()
  if (!text || !node) return
  input.value = ''

  const pass = document.getElementById('passphrase-input').value.trim() || 'libp2p-default-2025'
  const encrypted = await encryptMsg(text, pass)

  // Send via all open DataChannels (WebRTC direct)
  let sentDirect = 0
  for (const [, dc] of dataChannels) {
    if (dc.readyState === 'open') {
      dc.send(encrypted)
      sentDirect++
    }
  }

  // Send via GossipSub only if not all peers have an open DataChannel.
  // Relay server PeerIds are excluded — they never have a DataChannel.
  // If any browser peer lacks WebRTC (handshake in progress, symmetric NAT,
  // no WebRTC support), GossipSub must deliver the message.
  //
  // FALLBACK: if messages are not arriving, replace the if/allDirect block
  // with an unconditional publish:
  //   await node.services.pubsub.publish(TOPIC, fromString(encrypted, 'utf8'))
  const topicPeers = node.services.pubsub.getSubscribers(TOPIC)
    .filter(p => !relayPeerIds.has(p.toString()))
  const allDirect = topicPeers.length > 0 &&
    topicPeers.every(p => {
      const dc = dataChannels.get(p.toString())
      return dc && dc.readyState === 'open'
    })

  if (!allDirect) {
    try {
      await node.services.pubsub.publish(TOPIC, fromString(encrypted, 'utf8'))
    } catch (_) {}
  }

  const modeLabel = sentDirect > 0
    ? `🟢 WebRTC: ${sentDirect}${!allDirect ? ' +relay' : ''}`
    : '⚪ relay'
  log(`[ja] ${text} (${modeLabel})`, 'self-msg')
}

// ── Relay list ────────────────────────────────────────────────────────────────

document.getElementById('btn-add-relay').addEventListener('click', () => addRelayRow(''))

function addRelayRow(value) {
  const container = document.getElementById('relay-list')
  const row = document.createElement('div')
  row.className = 'relay-row'
  row.innerHTML = `
    <input type="text" class="relay-addr" value="${value}"
           placeholder="/dns4/onchato.com/tcp/443/wss/http-path/%2Frelay/p2p/12D3Koo..." />
    <button class="btn-remove" onclick="this.parentElement.remove()">✕</button>
  `
  container.appendChild(row)
}

addRelayRow('')
