/**
 * Global configuration store — persisted to localStorage, shared via React Context.
 *
 * Architecture: each domain (places, times, accounts, wishlist, theme) has its own
 * "store factory" function (makePlacesStore, etc.) that calls React hooks internally.
 * These factories are called once inside ConfigProvider, and each returns a plain
 * object with state + updater functions.  Separate contexts are used for each domain
 * so that a component subscribing to, say, useAccounts() does not re-render when the
 * wishlist changes.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { Slot } from '@/core/snapshot'

// ── Domain types ──────────────────────────────────────────────────────────────

export interface PlaceProfile {
  name: string
  lat: number
  lng: number
  radius_km: number
}

export interface TimeWindow {
  start: string  // "HH:MM"
  end: string    // "HH:MM"
}

export interface TimeProfile {
  name: string
  weekdays: number[]   // ISO: 1=Mon … 7=Sun; empty = any weekday
  windows: TimeWindow[] // empty = any time of day
}

export interface Account {
  name: string
  email: string
  password: string
  /** EVS student ID obtained after first sign-in; null if never signed in. */
  studentId: string | null
  anonymous: boolean
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch { return fallback }
}

/**
 * Persists a value to localStorage. Returns false (instead of throwing) when the
 * write fails — e.g. iOS Safari Private Browsing, which throws QuotaExceededError
 * on every setItem, or storage eviction under memory pressure. Because these
 * writers run inside React state updaters, an uncaught throw here would tear down
 * the whole component tree (blank screen); swallowing it keeps the in-memory state
 * usable for the session even when it can't be persisted.
 */
function writeLocal<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    console.warn(`Failed to persist "${key}" to localStorage:`, err)
    return false
  }
}

// ── Store factories ───────────────────────────────────────────────────────────
// Each factory is a function that calls React hooks.  They are called exactly
// once inside ConfigProvider (consistent call order, same as any other hook),
// so React's rules of hooks are satisfied.

function makePlacesStore() {
  const [places, setPlaces] = useState<PlaceProfile[]>(() => readLocal('evs_places', []))

  const addPlace = (p: PlaceProfile) => {
    setPlaces(prev => {
      const next = prev.some(x => x.name === p.name)
        ? prev.map(x => (x.name === p.name ? p : x))  // update existing
        : [...prev, p]
      writeLocal('evs_places', next)
      return next
    })
  }

  const removePlace = (name: string) => {
    setPlaces(prev => {
      const next = prev.filter(x => x.name !== name)
      writeLocal('evs_places', next)
      return next
    })
  }

  return { places, addPlace, removePlace }
}

function makeTimesStore() {
  const [times, setTimes] = useState<TimeProfile[]>(() => readLocal('evs_times', []))

  const addTime = (t: TimeProfile) => {
    setTimes(prev => {
      const next = prev.some(x => x.name === t.name)
        ? prev.map(x => (x.name === t.name ? t : x))
        : [...prev, t]
      writeLocal('evs_times', next)
      return next
    })
  }

  const removeTime = (name: string) => {
    setTimes(prev => {
      const next = prev.filter(x => x.name !== name)
      writeLocal('evs_times', next)
      return next
    })
  }

  return { times, addTime, removeTime }
}

/** Migrates the old single-account format (evs_account) to the multi-account format (evs_accounts). */
function loadAccounts(): Account[] {
  const old = localStorage.getItem('evs_account')
  if (old) {
    try {
      const parsed = JSON.parse(old) as { email: string; password: string }
      const migrated: Account[] = [{
        name: 'My account',
        email: parsed.email,
        password: parsed.password,
        studentId: null,
        anonymous: false,
      }]
      writeLocal('evs_accounts', migrated)
      localStorage.removeItem('evs_account')
      return migrated
    } catch { /* ignore malformed data */ }
  }
  return readLocal<Account[]>('evs_accounts', [])
}

function makeAccountsStore() {
  const [accounts, setAccounts] = useState<Account[]>(loadAccounts)
  const [activeName, setActiveNameState] = useState<string | null>(() =>
    readLocal<string | null>('evs_active_account', null),
  )

  // Anonymous accounts are internal only — activeAccount is always a real (non-anonymous) account.
  const realAccounts = accounts.filter(a => !a.anonymous)
  const activeAccount = realAccounts.find(a => a.name === activeName) ?? realAccounts[0] ?? null

  const addAccount = (a: Account) => {
    setAccounts(prev => {
      const next = prev.some(x => x.name === a.name)
        ? prev.map(x => (x.name === a.name ? a : x))
        : [...prev, a]
      writeLocal('evs_accounts', next)
      return next
    })
    // Explicitly adding/saving a real account selects it (so the 2nd, 3rd… account
    // you add actually becomes active). Anonymous accounts are never auto-selected.
    if (!a.anonymous) {
      setActiveNameState(a.name)
      writeLocal('evs_active_account', a.name)
    }
  }

  const updateAccount = (a: Account) => {
    setAccounts(prev => {
      const next = prev.map(x => (x.name === a.name ? a : x))
      writeLocal('evs_accounts', next)
      return next
    })
  }

  const removeAccount = (name: string) => {
    setAccounts(prev => {
      const next = prev.filter(x => x.name !== name)
      writeLocal('evs_accounts', next)
      localStorage.removeItem(`evs_tokens_${name}`)
      return next
    })
    setActiveNameState(prev => {
      if (prev !== name) return prev
      // Switch to the first remaining real account.
      const remaining = accounts.filter(x => x.name !== name && !x.anonymous)
      const next = remaining[0]?.name ?? null
      writeLocal('evs_active_account', next)
      return next
    })
  }

  const setActiveAccount = (name: string) => {
    setActiveNameState(name)
    writeLocal('evs_active_account', name)
  }

  return { accounts, activeAccount, addAccount, updateAccount, removeAccount, setActiveAccount }
}

function makeWishlistStore() {
  const [items, setItems] = useState<Slot[]>(() => readLocal('evs_wishlist', []))

  const add = (slot: Slot) => {
    setItems(prev => {
      if (prev.some(s => wishlistKey(s) === wishlistKey(slot))) return prev
      const next = [...prev, slot]
      writeLocal('evs_wishlist', next)
      return next
    })
  }

  const remove = (key: WishlistKey) => {
    setItems(prev => {
      const next = prev.filter(s => wishlistKey(s) !== key)
      writeLocal('evs_wishlist', next)
      return next
    })
  }

  const has = (key: WishlistKey): boolean => items.some(s => wishlistKey(s) === key)

  return { items, add, remove, has }
}

function makeThemeStore() {
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    const saved = readLocal<'light' | 'dark'>('evs_theme', 'light')
    // Apply class immediately in the initializer to avoid a flash of wrong theme.
    if (saved === 'dark') document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
    return saved
  })

  const setTheme = useCallback((t: 'light' | 'dark') => {
    setThemeState(t)
    writeLocal('evs_theme', t)
    if (t === 'dark') document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
  }, [])

  const toggleTheme = useCallback(() => setThemeState(prev => {
    const next = prev === 'dark' ? 'light' : 'dark'
    writeLocal('evs_theme', next)
    if (next === 'dark') document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
    return next
  }), [])

  return { theme, setTheme, toggleTheme }
}

/** App settings. cacheTtlMin = how long cached availability slots are reused before
 *  re-querying EVS (0 = always refetch). Mirrors the search prototype's setting. */
function makeSettingsStore() {
  const [cacheTtlMin, setCacheTtlMinState] = useState<number>(() => {
    const v = Number(readLocal<number>('evs_cache_ttl_min', 60))
    return Number.isFinite(v) && v >= 0 ? v : 60
  })
  const setCacheTtlMin = useCallback((v: number) => {
    const n = Math.max(0, Math.round(v) || 0)
    setCacheTtlMinState(n)
    writeLocal('evs_cache_ttl_min', n)
  }, [])
  return { cacheTtlMin, setCacheTtlMin }
}

// ── Contexts ──────────────────────────────────────────────────────────────────

type PlacesStore = ReturnType<typeof makePlacesStore>
type TimesStore = ReturnType<typeof makeTimesStore>
type AccountsStore = ReturnType<typeof makeAccountsStore>
type WishlistStore = ReturnType<typeof makeWishlistStore>
type ThemeStore = ReturnType<typeof makeThemeStore>
type SettingsStore = ReturnType<typeof makeSettingsStore>

const PlacesCtx = createContext<PlacesStore | null>(null)
const TimesCtx = createContext<TimesStore | null>(null)
const AccountsCtx = createContext<AccountsStore | null>(null)
const WishlistCtx = createContext<WishlistStore | null>(null)
const ThemeCtx = createContext<ThemeStore | null>(null)
const SettingsCtx = createContext<SettingsStore | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────────

export function ConfigProvider({ children }: { children: ReactNode }) {
  const places = makePlacesStore()
  const times = makeTimesStore()
  const accounts = makeAccountsStore()
  const wishlist = makeWishlistStore()
  const theme = makeThemeStore()
  const settings = makeSettingsStore()

  return (
    <ThemeCtx.Provider value={theme}>
      <SettingsCtx.Provider value={settings}>
        <PlacesCtx.Provider value={places}>
          <TimesCtx.Provider value={times}>
            <AccountsCtx.Provider value={accounts}>
              <WishlistCtx.Provider value={wishlist}>
                {children}
              </WishlistCtx.Provider>
            </AccountsCtx.Provider>
          </TimesCtx.Provider>
        </PlacesCtx.Provider>
      </SettingsCtx.Provider>
    </ThemeCtx.Provider>
  )
}

// ── Public hooks ──────────────────────────────────────────────────────────────

export function usePlaces(): PlacesStore {
  const ctx = useContext(PlacesCtx)
  if (!ctx) throw new Error('usePlaces must be inside ConfigProvider')
  return ctx
}

export function useTimes(): TimesStore {
  const ctx = useContext(TimesCtx)
  if (!ctx) throw new Error('useTimes must be inside ConfigProvider')
  return ctx
}

export function useAccounts(): AccountsStore {
  const ctx = useContext(AccountsCtx)
  if (!ctx) throw new Error('useAccounts must be inside ConfigProvider')
  return ctx
}

export function useWishlist(): WishlistStore {
  const ctx = useContext(WishlistCtx)
  if (!ctx) throw new Error('useWishlist must be inside ConfigProvider')
  return ctx
}

export function useTheme(): ThemeStore {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme must be inside ConfigProvider')
  return ctx
}

export function useSettings(): SettingsStore {
  const ctx = useContext(SettingsCtx)
  if (!ctx) throw new Error('useSettings must be inside ConfigProvider')
  return ctx
}

// ── Wishlist key helpers ──────────────────────────────────────────────────────

/**
 * Stable identity key for a bookable slot. It MUST include duration (and
 * location + gearbox): EVS offers e.g. a 1h AND a 2h lesson at the SAME start
 * time with the SAME teacher, so keying on start+teacher alone collides —
 * wishlisting the 2h slot would then mark the 1h slot as saved too, and two
 * list items would share a React key.
 */
export type WishlistKey = string

export function wishlistKey(slot: Slot): WishlistKey {
  return `${slot.locationId}::${slot.teacherId}::${slot.startsAtUtc}::${slot.durationMinutes}::${slot.gearboxType}`
}

// ── Recent searches + last search (localStorage; no context needed) ────────────

/** A complete ad-hoc search the user ran — saved so it can be repeated in one tap. */
export interface RecentSearch {
  place: PlaceProfile           // { name, lat, lng, radius_km }
  gearbox: 'bvm' | 'bva'
  minRating: number
  days: number[]                // ISO weekdays; empty = any
  anyTime: boolean
  tStart: string                // "HH:MM"
  tEnd: string
}

export function loadRecents(): RecentSearch[] { return readLocal<RecentSearch[]>('evs_recent', []) }
export function saveRecents(r: RecentSearch[]): void { writeLocal('evs_recent', r) }
export function loadLastSearch(): RecentSearch | null { return readLocal<RecentSearch | null>('evs_last_search', null) }
export function saveLastSearch(r: RecentSearch): void { writeLocal('evs_last_search', r) }
