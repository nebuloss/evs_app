# Architecture

## Overview

EVS Slot Finder is a single-page React application backed by a lightweight Node.js proxy. There is no server-side database — all state lives in the browser (localStorage and IndexedDB).

```
Browser                       Node.js (server.ts)        Internet
─────────────────────         ───────────────────        ──────────────────
React SPA (Vite)     ──/proxy/api/*──►  Express proxy ──► EVS API (HTTPS)
                     ◄── tokens ─────                   ◄── tokens ────────

                     ──/geocode?q=──► Express proxy ──► Nominatim (HTTPS)
```

### Why the proxy?

The EVS mobile API requires `Origin: https://app.envoituresimone.com` and a specific `User-Agent`. Browsers enforce CORS and prevent JavaScript from setting these headers directly. The Express proxy injects them server-side, making requests indistinguishable from the official app.

---

## Proxy configuration

**Headers injected by the proxy** (`server.ts`):
```
Origin: https://app.envoituresimone.com
Referer: https://app.envoituresimone.com/
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0 (Linux; Android 10; …) Mobile Safari/537.36
```

**Headers forwarded from browser → EVS** (passthrough):
`authorization`, `access-token`, `client`, `uid`, `evs_auth_issued_at`, `x-app-version`, `content-type`, `token-type`

**Headers forwarded from EVS → browser** (passthrough):
`authorization`, `access-token`, `client`, `uid`, `expiry`, `token-type`, `content-type`

**Geocode endpoint** (`GET /geocode?q=`): proxies to Nominatim with a 1 req/s rate limit (Nominatim policy). Returns `{ display_name, lat, lng, place_type }[]`.

**Development**: Vite dev server proxies `/proxy/*` and `/geocode` to Express on port 3001. The SPA runs on port 5173.

**Production**: Express serves both the proxy and the built SPA from `dist/` on port 3000 (configurable via `PORT` env var).

---

## EVS API

**Base URL** (after proxy): `/proxy` → `https://api.envoituresimone.com`

**App version**: The constant `APP_VERSION = '1.155.5'` in `src/api/evs.ts` must match a version the EVS backend accepts (sent as `X-App-Version` header). If the API starts returning 403s with no other cause, update this string to a newer version from the official app.

**Auth scheme**: devise-token-auth. Tokens are in response headers: `access-token`, `client`, `uid`, `expiry` (unix seconds), `token-type`. Every response returns a refreshed set of tokens — the client saves the latest set after each request. Tokens are valid ~2 weeks.

**Key endpoints used**:
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/auth/sign_in` | Sign in with email/password |
| `POST` | `/api/auth` | Register anonymous account |
| `GET` | `/api/v3/availabilities?latitude=&longitude=&gearbox_type=` | Meeting points in zone |
| `GET` | `/api/v3/locations/:id/teachers?gearbox_type=` | Teachers at a location |
| `GET` | `/api/v3/locations/:id/teachers_availabilities?teacher_id=&gearbox_type=` | Available slots for a teacher |
| `POST` | `/api/v3/lessons` | Book a lesson |
| `GET` | `/api/v1/students/:id` | Student profile |
| `GET` | `/api/v1/account/:id/lessons` | Lesson history |
| `GET` | `/api/v1/account/:id/credits_provisions_history` | Credit history |

---

## Data layers

### 1. localStorage (config)

Small, synchronous, used for config that must survive page reloads. All keys are read/written by helpers in `src/store/config.tsx`.

| Key | Type | Content |
|-----|------|---------|
| `evs_accounts` | `Account[]` | All accounts (name, email, password, studentId, anonymous flag) |
| `evs_active_account` | `string \| null` | Name of the currently selected account |
| `evs_tokens_<name>` | `AuthTokens` | Per-account session tokens (access-token, client, uid, expiry, etc.) |
| `evs_places` | `PlaceProfile[]` | Saved search areas (name, lat, lng, radius_km) |
| `evs_times` | `TimeProfile[]` | Saved time filters (name, weekdays[], windows[]) |
| `evs_wishlist` | `Slot[]` | Saved slots |
| `evs_theme` | `'light' \| 'dark'` | UI theme preference |

**Migration**: The store auto-migrates the old single-account format (`evs_account` key) to the new `evs_accounts` array format on first load (`loadAccounts()` in `config.tsx`).

### 2. IndexedDB (`evs-app`, store: `snapshots`)

Large async store for availability data. Key is `"lat,lng,radius_km"` (zone key). Value is a `Snapshot` object:

```typescript
interface Snapshot {
  structureFetchedAt: string | null   // ISO timestamp of last structure discovery
  pairs: PairMeta[]                   // known (location, teacher) pairs in this zone
  slots: Slot[]                       // all cached availability slots across all pairs
}
```

Cache TTLs:
- **Structure** (`structureFetchedAt`): 24 hours — discovering all meeting points and teachers in a zone is expensive (many sequential API calls).
- **Slots per pair** (`PairMeta.slotsFetchedAt`): 1 hour — individual availability windows change frequently.

All snapshot mutations are in-place (no object copies) for performance. Functions that mutate are annotated "Mutates `s` in place" in their JSDoc.

---

## State management

Five independent React Context stores prevent unnecessary re-renders:

```
ConfigProvider (src/store/config.tsx)
├── ThemeCtx       → useTheme()      — dark/light mode
├── PlacesCtx      → usePlaces()     — saved place profiles
├── TimesCtx       → useTimes()      — saved time profiles
├── AccountsCtx    → useAccounts()   — accounts + active selection
└── WishlistCtx    → useWishlist()   — saved slots

QueryStateProvider (src/store/queryState.tsx)
└── QueryStateCtx  → useQueryState() — query filters + fetched results (persists across page navigation)
```

**Store factory pattern**: Each store is implemented as a `make*Store()` function that calls React hooks internally (e.g. `makePlacesStore`, `makeAccountsStore`). These are called exactly once inside `ConfigProvider`, satisfying React's rules of hooks while keeping each domain's logic self-contained.

**Stability requirement**: `setState` and `resetResults` in `QueryStateProvider` are wrapped with `useCallback(fn, [])` so `runQuery`'s `useCallback` in `QueryPage` receives stable references and is not invalidated on every render.

### Token management

`EVSClient` is a module-level singleton (`src/api/evs.ts`). Its `tokens` field holds the currently active account's session. **Before any API call**, callers must invoke `evsClient.loadAccountTokens(accountName)` to switch to the right account's tokens. The client automatically persists refreshed tokens (returned in every API response) back to localStorage.

Pattern used in all components that call the API:
```typescript
async function withAuth<T>(account: Account, fn: () => Promise<T>): Promise<T> {
  evsClient.loadAccountTokens(account.name)
  if (evsClient.isExpired()) await evsClient.signIn(account.email, account.password)
  return fn()
}
```

---

## Dark mode

Tailwind v4 class-based dark mode. Key details:

- **CSS declaration** (`src/index.css`): `@custom-variant dark (&:where(.dark, .dark *));`
- **Toggle mechanism**: The `dark` class is added/removed on `document.documentElement`.
- **No flash on load**: The `dark` class is applied synchronously inside the `useState` initializer of `makeThemeStore()` — this runs before the first paint, unlike a `useEffect` which runs after.
- **stale-closure protection**: `toggleTheme` uses `setThemeState(prev => ...)` instead of reading `theme` from the outer closure.

---

## Component hierarchy

```
App (routing)
└── Layout (src/components/Layout.tsx)
    ├── Sidebar nav (desktop only, hidden md:flex)
    ├── Topbar
    │   ├── ThemeToggle — pill button with Sun/Moon icon
    │   └── AccountSwitcher — dropdown; add/remove accounts with ConfirmDeleteModal
    │       └── AccountModal — centered modal with blurred backdrop (z-50)
    │           └── AccountEditor — sign-in form (email + password)
    └── <Outlet>
        ├── QueryPage (src/pages/QueryPage.tsx)
        │   ├── PlacePicker — chips for saved place profiles; "Add place" → /settings
        │   ├── TimePicker — chips for saved time profiles; "Add time" → /settings
        │   ├── Gearbox + MinRating filters
        │   ├── SlotPill (×N)
        │   ├── WishlistSlotModal (when slot clicked) — z-50
        │   └── LocationMapModal (when location clicked) — z-[60] (stacked above WishlistSlotModal)
        ├── WishlistPage (src/pages/WishlistPage.tsx)
        │   ├── SlotCard (×N)
        │   └── BookingModal — z-50
        ├── AccountPage (src/pages/AccountPage.tsx)
        │   ├── ProfileSection (react-query)
        │   ├── LessonsSection (react-query)
        │   ├── CreditsSection (react-query)
        │   └── "Remove account" danger zone + ConfirmDeleteModal
        └── SettingsPage (src/pages/SettingsPage.tsx)
            ├── Places section → PlaceModal → PlaceEditor (geocode search + map)
            └── Time profiles section → TimeModal → TimeEditor
```

**Modal z-index layering**: standard modals `z-50`; `LocationMapModal` (stacked above `WishlistSlotModal`) `z-[60]`; `ConfirmDeleteModal` in Layout uses `z-[60]`.

**Mobile layout**: Sidebar is `hidden md:flex` (desktop only). A bottom tab bar (`md:hidden`) replaces it on mobile with `env(safe-area-inset-bottom)` padding for iPhone home indicator. The topbar shows the app title on mobile (`md:hidden mr-auto`).

### Account management UX rules

- **Top-right AccountSwitcher**: only real (non-anonymous) accounts are listed. Allows switching, adding (opens AccountModal), and removing (opens ConfirmDeleteModal). When no real accounts exist, shows only an "Add account" button.
- **AccountPage**: shows data for the active real account. Shows "no account" empty state even if an anonymous account exists. Bottom of page has a "Remove this account" danger zone.
- **SettingsPage**: only manages Places and Time profiles. **No account management here.**
- **QueryPage**: if user clicks "Fetch & search" with no real account, silently creates/reuses a background anonymous account. If anonymous creation fails, shows an error modal.

---

## Fetch flow (QueryPage)

```
runQuery()
  │
  ├─ resolve fetch account:
  │   ├─ if real activeAccount → use it
  │   ├─ else if anonymous account exists in storage → reuse it
  │   └─ else → registerAnonymous() → addAccount() → use it
  │              (on failure: show error modal, abort)
  │
  ├─ evsClient.loadAccountTokens(fetchAccount) + ensureAuth
  │
  ├─ loadSnapshot(zoneKey)         — read IndexedDB
  │
  ├─ evictPastSlots(snapshot)      — drop slots that have already started
  │
  ├─ [if structureIsStale > 24h]
  │   ├─ getMeetingPoints(lat, lng, gearbox)      — API
  │   ├─ getLocationTeachers(locId, gearbox)      — API (sequential, per location)
  │   └─ updateStructure(snapshot, discovered)    — reconcile pair list
  │
  ├─ stalePairs(snapshot, 1h)
  │   └─ [for each stale pair]
  │       ├─ getTeacherAvailabilities             — API
  │       └─ replacePairSlots + saveSnapshot      — update IndexedDB
  │
  └─ applySearch(opts, snapshot.slots) → setQs({ results, snapshotInfo })
```

No progress UI is shown during the fetch — the "Fetch & search" button enters a loading state (`cursor-wait`, text "Fetching…"). Errors are shown inline below the filters.

---

## Time filtering

`matchesTime()` in `src/core/time.ts` supports two modes:
- **`schedule`** (used in UI): filter by ISO weekdays (1=Mon…7=Sun, empty=any) and time windows (HH:MM pairs, empty=any time). Both conditions must pass.
- **`precise`** (not in UI): check if a slot starts within N minutes of a target ISO datetime.

The `getDay()` → ISO weekday conversion: `d.getDay() === 0 ? 7 : d.getDay()` (JS returns 0 for Sunday, ISO uses 7).

**`startsAtLocal` generation**: UTC ISO from the API is converted to local Paris time using the `sv-SE` locale trick: `toLocaleString('sv-SE', { timeZone: 'Europe/Paris' })` produces `"YYYY-MM-DD HH:MM:SS"`, then `.replace(' ', 'T')` gives a standard ISO string with no timezone suffix. This avoids importing a date library.

---

## Geocoding (PlaceEditor)

`PlaceEditor` (`src/components/PlaceEditor.tsx`) has an autocomplete search backed by `/geocode?q=`. Key details:
- 400ms debounce before firing the query
- Only fires when input is ≥ 2 characters
- Dropdown uses `position: absolute` — **the parent modal must not have `overflow: hidden` or `overflow: auto`**, otherwise the dropdown is clipped. `PlaceModal` deliberately omits `overflow-y-auto` on its panel for this reason.
- Results click uses `onMouseDown` (not `onClick`) to fire before the input's `onBlur` hides the dropdown.

---

## Wishlist

- Wishlist items are `Slot` objects stored in localStorage as `evs_wishlist`.
- Identity key: `"startsAtUtc::teacherId"` (type `WishlistKey`) — two slots for the same teacher at the same UTC time are considered the same slot regardless of location or cache version.
- Booking from wishlist opens `BookingModal`, which calls `evsClient.bookLesson(slot)` via the proxy.
- The `bookingUrl` field on each slot is a direct link to `https://app.envoituresimone.com/booking?...` as a fallback if in-app booking fails.

---

## Anonymous accounts

Anonymous accounts are real EVS accounts registered with randomly generated credentials, used as a transparent fallback when no real account is configured.

**Registration flow** (triggered automatically by `QueryPage` when no real account exists):
1. Load a temporary token context (`loadAccountTokens('__anon_tmp__')`)
2. Call `POST /api/auth` with a random email/password/name
3. Store under the fixed name `'Anonymous'` in `evs_accounts`

**Visibility rules** — anonymous accounts are intentionally hidden from the user:
- `activeAccount` in `makeAccountsStore()` only resolves to real (`anonymous: false`) accounts
- `AccountSwitcher` only lists real accounts (`accounts.filter(a => !a.anonymous)`)
- `AccountPage` shows the "no account" empty state even when an anonymous account exists
- There is exactly one anonymous account per browser (fixed name `'Anonymous'`); subsequent fetches reuse it

**Why credentials are stored**: tokens expire after ~2 weeks. On expiry, `ensureAuth` re-signs in using the stored email/password to get fresh tokens without requiring user input.

Anonymous accounts have no credit balance and cannot book lessons, but can browse all availabilities.

---

## Technology choices

| Concern | Choice | Notes |
|---------|--------|-------|
| UI framework | React 18 | Component model, ecosystem |
| Build tool | Vite + TypeScript | Fast HMR, strict types |
| Styling | Tailwind CSS v4 | Class-based dark mode; `@custom-variant dark` directive |
| Routing | React Router v6 | `<Outlet>` pattern; `Layout` wraps all pages |
| Server queries | TanStack Query v5 | Used only on AccountPage for profile/lessons/credits |
| Local persistence | localStorage + IndexedDB (idb) | No backend needed |
| Map | React-Leaflet + OpenStreetMap | Free, no API key; used in PlaceEditor and LocationMapModal |
| Proxy server | Express (server.ts) | Header injection + SPA static serving in production |
| Geocoding | Nominatim | Free; 1 req/s rate limit enforced in proxy |
