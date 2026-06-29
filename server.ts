/**
 * Express server — two responsibilities:
 *
 * 1. API proxy (/proxy/*): forwards requests to the EVS backend while injecting
 *    the Origin, Referer, and User-Agent headers that the EVS API requires.
 *    Browsers cannot set these headers directly (CORS preflight would block it),
 *    so a same-origin server-side proxy is the only viable approach.
 *
 * 2. Static file server: serves the Vite-built SPA from dist/ and falls back to
 *    index.html for client-side routing.
 *
 * In development, Vite's dev server handles the SPA and this process only runs
 * the proxy on port 3001. In production both roles are served on PORT (default 3000).
 */

import express from 'express'
import https from 'https'
import http from 'http'
import path from 'path'
import { URL } from 'url'

const app = express()
app.set('trust proxy', 1)
const PORT = Number(process.env.PORT ?? 3000)
const DEV_PORT = 3001

const EVS_BASE = 'https://api.envoituresimone.com'
const NOMINATIM = 'https://nominatim.openstreetmap.org'

const INJECTED_HEADERS: Record<string, string> = {
  Origin: 'https://app.envoituresimone.com',
  Referer: 'https://app.envoituresimone.com/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
}

const PASSTHROUGH_HEADERS = [
  'authorization',
  'access-token',
  'client',
  'uid',
  'evs_auth_issued_at',
  'x-app-version',
  'content-type',
  'token-type',
]

const RESPONSE_PASSTHROUGH = [
  'authorization',
  'access-token',
  'client',
  'uid',
  'expiry',
  'token-type',
  'content-type',
]

function forwardRequest(
  req: express.Request,
  res: express.Response,
  targetUrl: string,
): void {
  const url = new URL(targetUrl)
  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...INJECTED_HEADERS },
  }

  for (const h of PASSTHROUGH_HEADERS) {
    const val = req.headers[h]
    if (val) (options.headers as Record<string, string>)[h] = val as string
  }

  const lib = url.protocol === 'https:' ? https : http
  const upstream = lib.request(options, upRes => {
    for (const h of RESPONSE_PASSTHROUGH) {
      const val = upRes.headers[h]
      if (val) res.setHeader(h, val)
    }
    res.status(upRes.statusCode ?? 200)
    upRes.pipe(res)
  })

  upstream.on('error', err => {
    console.error('Proxy error:', err.message)
    if (!res.headersSent) res.status(502).json({ error: 'Bad gateway' })
  })

  if (req.body && Buffer.isBuffer(req.body)) {
    upstream.write(req.body)
  }
  upstream.end()
}

// EVS proxy: /proxy/* → EVS_BASE/*
app.use('/proxy', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const downstream = req.path + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')
  forwardRequest(req, res, `${EVS_BASE}${downstream}`)
})

// Nominatim geocode: /geocode?q=…
let lastNominatimCall = 0
app.get('/geocode', async (req, res) => {
  const q = req.query.q as string
  if (!q) return void res.json([])

  // Rate-limit to 1 req/s (Nominatim policy)
  const now = Date.now()
  const wait = 1000 - (now - lastNominatimCall)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastNominatimCall = Date.now()

  const url = `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=0`
  https.get(url, { headers: { 'User-Agent': 'evs-app/1.0' } }, upRes => {
    let data = ''
    upRes.on('data', chunk => { data += chunk })
    upRes.on('end', () => {
      try {
        const raw = JSON.parse(data) as Array<{ display_name: string; lat: string; lon: string; type: string; boundingbox?: [string, string, string, string] }>
        const candidates = raw.map(r => ({
          display_name: r.display_name,
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          place_type: r.type,
          // [south, north, west, east] — lets the client auto-fit the search radius
          // to the place's actual extent (a city vs a single address).
          boundingbox: r.boundingbox ? r.boundingbox.map(parseFloat) : null,
        }))
        res.json(candidates)
      } catch {
        res.json([])
      }
    })
  }).on('error', () => res.json([]))
})

// Serve built SPA (production)
const distDir = path.join(__dirname, '..', 'dist')
app.use(express.static(distDir))
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

const listenPort = process.env.NODE_ENV === 'development' ? DEV_PORT : PORT
app.listen(listenPort, () => {
  console.log(`EVS proxy running on port ${listenPort}`)
})
