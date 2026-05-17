# Development guide

## Quick start

```bash
npm install
npm run dev     # Vite SPA on :5173 + Express proxy on :3001
```

Vite proxies `/proxy/*` and `/geocode` to `:3001`, so the frontend hits a single origin.

## Build & run

```bash
npm run build   # tsc → dist-server/ + vite → dist/
npm start       # node dist-server/server.js (port 3000)
```

---

## Key patterns — read before touching anything

### 1. Always call `loadAccountTokens` before any EVS API call

`evsClient` is a module-level singleton. It starts with `tokens = null`. Every component that calls the API must first load the active account's tokens:

```typescript
evsClient.loadAccountTokens(account.name)
if (evsClient.isExpired()) await evsClient.signIn(account.email, account.password)
// now safe to call evsClient.*
```

The `withAuth` helper in `AccountPage.tsx` wraps this pattern for TanStack Query `queryFn`s. **Forgetting this means requests go out unauthenticated (no headers) and the API returns 401.**

### 2. Store factories are called inside `ConfigProvider` — never elsewhere

The `make*Store()` functions in `config.tsx` call React hooks. They are called as regular function calls inside `ConfigProvider`:

```typescript
export function ConfigProvider({ children }) {
  const places = makePlacesStore()   // ← hooks called here
  const accounts = makeAccountsStore()
  // ...
}
```

This satisfies React's rules of hooks (consistent call order, always inside a component). Do not call these functions anywhere else.

### 3. Memoize callbacks that are used as `useCallback` dependencies

If a function is listed in a `useCallback` dependency array, it must itself be stable (memoized). In `QueryStateProvider`, `setState` and `resetResults` are wrapped with `useCallback(fn, [])` specifically because `runQuery` in `QueryPage` depends on `setQs`:

```typescript
// QueryStateProvider — MUST be memoized
const setState = useCallback(
  (patch: Partial<QueryState>) => setStateFull(prev => ({ ...prev, ...patch })),
  [],
)
```

Without this, `runQuery`'s `useCallback` would get a new `setQs` reference every render, making `runQuery` itself recreate every render.

### 4. `toggleTheme` must use the functional updater form

```typescript
// CORRECT — reads previous state from React, not from a closure
const toggleTheme = useCallback(() => setThemeState(prev => {
  const next = prev === 'dark' ? 'light' : 'dark'
  // apply class and save to localStorage...
  return next
}), [])

// WRONG — `theme` from outer scope could be stale
const toggleTheme = () => {
  const next = theme === 'dark' ? 'light' : 'dark'
  // ...
}
```

### 5. `useEscapeKey` and `useEnterKey` require stable callbacks

Both hooks in `src/hooks/useKeyShortcuts.ts` add/remove a `keydown` listener on `document`. If you pass an inline arrow function, the listener re-registers on every render. Always use `useCallback`:

```typescript
const closeModals = useCallback(() => { setOpen(false) }, [])
useEscapeKey(closeModals)
useEnterKey(primaryAction)  // fires on Enter from anywhere in the document
```

Both accept an optional `enabled` second argument (default `true`) to conditionally disable the listener — use this to prevent Enter/Escape firing while an async operation is in progress.

### 6. PlaceModal must not have `overflow-y-auto` on its panel

The geocode dropdown in `PlaceEditor` is `position: absolute`. If any ancestor has `overflow: hidden` or `overflow: auto`, the dropdown is clipped and invisible. `PlaceModal` intentionally omits `overflow-y-auto` from the panel div for this reason.

If you need to add scrolling to a modal that contains `PlaceEditor`, you must either:
- Wrap only the non-dropdown content in an overflow container, or
- Render the dropdown with `ReactDOM.createPortal` to escape the overflow context.

---

## Adding a new modal

Every modal should handle both Escape and Enter:

**Form modals** (have text inputs): wrap in `<form onSubmit={e => { e.preventDefault(); handleSave() }}>` and use `type="submit"` on the confirm button, `type="button"` on cancel. This gives Enter-to-submit for free. If a search/autocomplete input should not submit the form on Enter, add `onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}` to that specific input.

**Confirmation / action modals** (no text inputs): use `useEscapeKey` and `useEnterKey` from `src/hooks/useKeyShortcuts.ts`:

```typescript
import { useEscapeKey, useEnterKey } from '@/hooks/useKeyShortcuts'

useEscapeKey(onCancel)
useEnterKey(onConfirm)
```

Both hooks fire on `document` — they activate as long as the modal is mounted. Use the `enabled` argument to disable them during async operations (e.g. `useEscapeKey(onCancel, !loading)`).

---

## Adding a new page

1. Create `src/pages/MyPage.tsx`
2. Add a `<Route path="my-page" element={<MyPage />} />` inside the `<Route element={<Layout />}>` in `src/App.tsx`
3. Add to the `navItems` array in `src/components/Layout.tsx` (both the sidebar and bottom nav are built from this array)

---

## Adding a new API call

All API calls go through `evsClient` in `src/api/evs.ts`:

1. Add the response type interface near the top of the file
2. Add a method to `EVSClient` using `this.request(method, path, body?)`
3. Call `evsClient.loadAccountTokens(name)` before calling the new method in any component

The `request` method automatically:
- Adds auth headers from `this.tokens`
- Sends `X-App-Version` and `evs_auth_issued_at`
- Persists refreshed tokens from the response

---

## Adding a new localStorage key

All persistence goes through `readLocal` / `writeLocal` in `src/store/config.tsx`. Add a new store factory following the existing pattern:

```typescript
function makeMyStore() {
  const [data, setData] = useState(() => readLocal('evs_my_key', defaultValue))
  const update = (val: MyType) => {
    setData(val)
    writeLocal('evs_my_key', val)
  }
  return { data, update }
}
```

Call it inside `ConfigProvider`, create a context, and export a `useMyStore()` hook.

---

## Dark mode

Every Tailwind class that affects appearance needs a `dark:` variant. Colour mapping:

| Light | Dark |
|-------|------|
| `bg-white` | `dark:bg-slate-800` |
| `bg-slate-50` (page background) | `dark:bg-slate-900` |
| `bg-slate-50` (section header) | `dark:bg-slate-700/50` |
| `border-slate-200` | `dark:border-slate-700` |
| `border-slate-100` (divider) | `dark:border-slate-700` |
| `text-slate-900` | `dark:text-slate-100` |
| `text-slate-800` | `dark:text-slate-200` |
| `text-slate-600` | `dark:text-slate-300` |
| `text-slate-500` | `dark:text-slate-400` |
| `text-slate-400` | `dark:text-slate-500` |
| Inputs: `bg-white border-slate-200` | `dark:bg-slate-700 dark:border-slate-600` |
| Input text | `dark:text-slate-100 dark:placeholder-slate-400` |

Do **not** put the `dark` class on `<html>` in your JSX — it is managed exclusively by `makeThemeStore()` in `config.tsx` to prevent flash on load.

---

## Account flow — decision matrix

**Real account** = `Account` with `anonymous: false`. Only these are visible to the user.  
**Anonymous account** = `Account` with `anonymous: true`, stored internally as `'Anonymous'`, never shown in UI.

| Situation | Behaviour |
|-----------|-----------|
| No real accounts | Top-right shows "Add account" button only. AccountPage shows empty state. |
| Query page, no real account, clicks "Fetch & search" | Silently reuses existing anonymous account, or creates one via `registerAnonymous()`. If creation fails, shows an error modal — fetch is aborted. |
| Anonymous account created | Stored in `evs_accounts` but never becomes `activeAccount`. Reused on subsequent fetches (fixed name `'Anonymous'`). |
| Real account added | Auto-selected as active. `evsClient.loadAccountTokens` called immediately. |
| Account switched (top-right dropdown) | `evsClient.loadAccountTokens` called; TanStack Query caches are keyed by `account.name` so they refetch automatically. |
| Real account removed | If it was active, the first remaining real account becomes active. Tokens deleted from localStorage. |
| AccountPage with only anonymous account | Shows "no account" empty state (same as having no accounts at all). |

---

## TanStack Query keys

AccountPage uses TanStack Query. Keys include `account.name` so data refetches when the user switches accounts:

```typescript
queryKey: ['profile', account.name, account.studentId]
queryKey: ['lessons', account.name, account.studentId]
queryKey: ['credits', account.name, account.studentId]
```

If you add more queries, always include `account.name` as a key segment.

---

## Known gotchas

### APP_VERSION in `src/api/evs.ts`
The string `'1.155.5'` is sent as `X-App-Version`. If the EVS backend starts returning errors with no other apparent cause, try updating this to a newer version string (check the official iOS/Android app with a MITM proxy).

### `evs_auth_issued_at` header
This is sent as the current `Date.now()` timestamp on every request. It is expected by the EVS API but not validated for accuracy.

### Booking requires credits
`evsClient.bookLesson()` (`POST /api/v3/lessons`) will return an error if the account has no credits. Anonymous accounts always lack credits.

### `postal_code_id: 6187` in anonymous registration
This is a hardcoded postal code ID used during anonymous registration. It is an internal EVS ID (not a real postal code). If anonymous creation starts failing, this may need updating.

### Anonymous account is transparent — don't expose it
Anonymous accounts live in `evs_accounts` with `anonymous: true`. Never pass them to `setActiveAccount`, never list them in the `AccountSwitcher`, and never show them in `AccountPage`. All filtering happens in `makeAccountsStore()` (`realAccounts`) and in `AccountSwitcher` (`accounts.filter(a => !a.anonymous)`). If you add a new account-listing UI, apply the same filter.

### IndexedDB zone key format
The zone key is `"lat,lng,radius_km"` — e.g. `"48.8566,2.3522,20"`. Changing a place profile's radius_km creates a new cache entry; the old one is not deleted (it will just sit in IndexedDB unused).

### Slot identity
Two slots are considered the same wishlist entry if `startsAtUtc + '::' + teacherId` matches. This means if a teacher moves to a different location but keeps the same timeslot, it would be treated as the same wishlist entry.

---

## File map

```
evs-app/
├── server.ts                  # Express proxy + SPA server
├── src/
│   ├── main.tsx               # React root, QueryStateProvider + ConfigProvider
│   ├── App.tsx                # Route declarations
│   ├── index.css              # Tailwind v4 imports + dark mode variant
│   ├── api/
│   │   └── evs.ts             # EVSClient class + evsClient singleton + all API types
│   ├── core/
│   │   ├── geo.ts             # haversineKm, contains — radius filter
│   │   ├── search.ts          # applySearch — client-side slot filtering
│   │   ├── snapshot.ts        # Snapshot type, IndexedDB I/O, TTL helpers
│   │   └── time.ts            # matchesTime — schedule/precise time filter
│   ├── store/
│   │   ├── config.tsx         # 5 context stores + ConfigProvider + all hooks
│   │   └── queryState.tsx     # Query filter + result state (QueryStateProvider)
│   ├── pages/
│   │   ├── QueryPage.tsx      # Main search page (fetch + filter + display)
│   │   ├── WishlistPage.tsx   # Saved slots + booking
│   │   ├── AccountPage.tsx    # Profile / lessons / credits + remove account
│   │   └── SettingsPage.tsx   # Places + Time profiles only
│   ├── components/
│   │   ├── Layout.tsx         # Sidebar + topbar + mobile nav + AccountSwitcher
│   │   ├── AccountModal.tsx   # Centered modal wrapping AccountEditor
│   │   ├── AccountEditor.tsx  # Sign-in form (email + password); submits on Enter via <form>
│   │   ├── PlaceModal.tsx     # Wrapper modal for PlaceEditor
│   │   ├── PlaceEditor.tsx    # Geocode search + map + radius + name; submits on Enter via <form>
│   │   ├── PlacePicker.tsx    # Chip selector for saved places
│   │   ├── TimeModal.tsx      # Wrapper modal for TimeEditor
│   │   ├── TimeEditor.tsx     # Weekday + time window selector; submits on Enter via <form>
│   │   ├── TimePicker.tsx     # Chip selector for saved time profiles
│   │   ├── SlotCard.tsx       # Wishlist page slot card
│   │   ├── BookingModal.tsx   # Booking confirmation + result; Enter confirms
│   │   ├── WishlistSlotModal.tsx  # Slot detail + wishlist toggle; Enter saves/closes
│   │   ├── LocationMapModal.tsx   # Leaflet map modal (z-[60])
│   │   └── FetchProgress.tsx  # Progress bar component (unused — kept for potential future use)
│   └── hooks/
│       └── useKeyShortcuts.ts # useEscapeKey + useEnterKey — document-level keydown hooks
└── docs/
    ├── architecture.md        # System design, data flows, component hierarchy
    ├── development.md         # This file — patterns, gotchas, how-tos
    └── deployment.md          # Deploy script, Docker, service management
```
