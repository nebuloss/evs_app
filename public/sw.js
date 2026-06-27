/* Minimal service worker — enough to make the app installable (PWA) and give
 * basic offline shell caching. API calls (/proxy, /geocode) are never cached. */
const CACHE = 'evs-shell-v1'

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
  // Never cache API/auth/geocode traffic — always go to network.
  if (url.pathname.startsWith('/proxy') || url.pathname.startsWith('/geocode')) return

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
