/* Minimal service worker — enough to make the app installable (PWA) and give
 * basic offline shell caching. Dynamic traffic (/api, /proxy, /geocode) is
 * NEVER cached — only the static app shell is. */
// Bump this on any change to cached assets/manifest so old caches are purged on
// activate (v3: stop caching /api responses, which served stale slot data).
const CACHE = 'evs-shell-v3'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never cache dynamic API traffic (slots, proxy, geocode) — always go to network.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/proxy') || url.pathname.startsWith('/geocode')) return
  // Always fetch the manifest fresh so icon/manifest changes apply immediately
  // (a cached manifest can otherwise block or stale the PWA install).
  if (url.pathname === '/manifest.webmanifest') return

  // Navigations: network-first, fall back to cached app shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then(r => r || caches.match('/'))),
    )
    return
  }

  // Static assets: cache-first, then network (and cache the result).
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(resp => {
      if (resp.ok && resp.type === 'basic') {
        const copy = resp.clone()
        caches.open(CACHE).then(c => c.put(request, copy))
      }
      return resp
    }).catch(() => cached)),
  )
})
