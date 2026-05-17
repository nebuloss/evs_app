# EVS Slot Finder

A personal web application for finding and booking available driving lessons on the [En Voiture Simone](https://www.envoituresimone.com) platform. Browse availabilities by location and time profile, save slots to a wishlist, and book directly from the app.

---

## Features

- **Multi-account support** — manage several EVS accounts (or anonymous accounts) and switch between them from the top-right switcher.
- **Location profiles** — save named search areas with a configurable radius; slots are filtered to only show teachers within that radius.
- **Time profiles** — filter by day-of-week and time windows (e.g. "weekdays, 07:00–09:00").
- **Two-layer local cache** — availabilities are stored in IndexedDB and refreshed incrementally (structure: 24h TTL; slots per teacher: 1h TTL), so repeat queries are near-instant.
- **Wishlist** — save interesting slots across sessions; book directly from the wishlist page.
- **Dark / light mode** — toggle in the top bar; preference persisted in localStorage.
- **Map view** — click any location name to see it on an OpenStreetMap Leaflet map.
- **Mobile-first** — sidebar on desktop, bottom tab bar on mobile with safe-area insets.

---

## Project structure

```
evs-app/
├── server.ts              # Express proxy (header injection) + SPA static server
├── src/
│   ├── api/
│   │   └── evs.ts         # EVSClient class, all API types, evsClient singleton
│   ├── core/
│   │   ├── geo.ts         # Haversine distance, radius filter
│   │   ├── search.ts      # Client-side slot filtering and sorting
│   │   ├── snapshot.ts    # Cache schema, IndexedDB I/O, TTL helpers
│   │   └── time.ts        # Schedule/precise time-filter matching
│   ├── store/
│   │   ├── config.tsx     # Places, times, accounts, wishlist, theme — React Context
│   │   └── queryState.tsx # Query filter + result state shared across pages
│   ├── pages/
│   │   ├── QueryPage.tsx     # Main search page
│   │   ├── WishlistPage.tsx  # Saved slots + booking
│   │   ├── AccountPage.tsx   # Profile, lessons, credits + remove account
│   │   └── SettingsPage.tsx  # Places and time profiles
│   └── components/        # Reusable UI components and modals
└── install.sh             # Self-contained deploy script (Alpine + Debian)
```

---

## Prerequisites

- **Node.js** 20+ (22 recommended)
- **npm** 9+
- An En Voiture Simone account, or use anonymous registration (no credentials needed — a random account is created on the EVS platform)

---

## Quick start (development)

```bash
npm install
npm run dev
```

Two processes start concurrently:
- Vite dev server on **http://localhost:5173** (SPA with HMR)
- Express proxy on **http://localhost:3001** (API + geocode proxy)

Vite proxies `/proxy/*` and `/geocode` to port 3001, so the frontend talks to a single origin.

---

## Production build

```bash
npm run build   # compiles server.ts → dist-server/ and SPA → dist/
npm start       # runs dist-server/server.js (serves both proxy and SPA)
```

Default port is **3000**. Override with the `PORT` environment variable.

---

## Deployment

A single-command install script handles Node.js installation, building, and service setup on Alpine (OpenRC) and Debian/Ubuntu (systemd):

```bash
curl -fsSL https://raw.githubusercontent.com/nebuloss/evs_app/refs/heads/master/install.sh | bash
```

The app will be available on **http://localhost:3000** — point Nginx Proxy Manager (or any reverse proxy) at that port.

See [docs/deployment.md](docs/deployment.md) for full details including Docker, Nginx/Caddy reverse proxy, and service management commands.

---

## Configuration

All user data is stored in the browser (localStorage + IndexedDB). No server-side database is needed.

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | HTTP port for the production server |

---

## How it works

1. The user picks a saved **place profile** (location + radius) and optionally a **time profile**.
2. Clicking **Fetch & search** triggers an incremental cache refresh:
   - If the list of (location, teacher) pairs is older than 24h, the app re-discovers all meeting points and teachers in the zone.
   - For each pair whose slots are older than 1h, fresh availabilities are fetched from the EVS API.
   - Results are stored in IndexedDB and immediately filtered client-side.
3. Slot pills are shown grouped by day → teacher. Clicking a pill opens a detail modal to save the slot to the wishlist.
4. The wishlist page shows all saved slots and allows booking with one click (requires a credited account).

All API requests go through the local Express proxy, which injects the `Origin`, `Referer`, and `User-Agent` headers required by the EVS API (browsers cannot set these directly due to CORS).

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — System design, data flows, API details, component hierarchy, state management, dark mode implementation, all localStorage keys.
- [docs/development.md](docs/development.md) — Patterns to follow, common pitfalls, how to add pages/API calls/stores, dark mode colour mapping, account flow decision matrix.
- [docs/deployment.md](docs/deployment.md) — Install script, Docker, Nginx/Caddy, service management.
