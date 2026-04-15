/**
 * auth-server.mjs — mikroserwis autoryzacji dla nginx auth_request
 *
 * Nasłuchuje na http://127.0.0.1:9002
 * Nginx wywołuje GET /check przed każdym nowym połączeniem WebSocket z relayem.
 *
 * Teraz: wpuszcza wszystkich (zwraca 200).
 * Docelowo: zwaliduj JWT z nagłówka Authorization u 3rd party i zwróć 200 lub 401.
 *
 * Uruchomienie: node src/auth-server.mjs
 * Systemd:      deploy/auth-server.service
 */

import { createServer } from 'http'

const PORT = 9002
const HOST = '127.0.0.1'

const server = createServer((req, res) => {
  if (req.url === '/check') {
    const token = req.headers['authorization'] || '(brak)'
    const uri   = req.headers['x-original-uri'] || ''

    // ── Tutaj docelowa weryfikacja JWT ───────────────────────────────────────
    //
    // Przykład (JWT od 3rd party):
    //   const jwt = token.replace('Bearer ', '')
    //   const ok  = await verify3rdParty(jwt)
    //   if (!ok) { res.writeHead(401); res.end('Unauthorized'); return }
    //
    // Na razie: wpuszczamy wszystkich.
    // ────────────────────────────────────────────────────────────────────────

    console.log(`[auth] ALLOW uri=${uri} token=${token.slice(0, 40)}`)
    res.writeHead(200)
    res.end('ok')
    return
  }

  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, HOST, () => {
  console.log(`✅ Auth server nasłuchuje na http://${HOST}:${PORT}`)
  console.log(`   Tryb: wpuszczaj wszystkich (stub)`)
})
