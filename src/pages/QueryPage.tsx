import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, MapPin, Heart, Clock, Star, Circle as CircleIcon, ChevronDown, X, CalendarDays } from 'lucide-react'
import LocationMapModal from '@/components/LocationMapModal'
import WishlistSlotModal from '@/components/WishlistSlotModal'
import FetchProgress, { type ProgressState } from '@/components/FetchProgress'
import {
  useWishlist, useSettings, wishlistKey,
  loadRecents, saveRecents, loadLastSearch, saveLastSearch,
  type RecentSearch,
} from '@/store/config'
import { useQueryState, type GeoPoint } from '@/store/queryState'
import { type SearchPlace } from '@/core/geo'
import { applySearch } from '@/core/search'
import { type TimeSpec } from '@/core/time'
import { type Slot } from '@/core/types'
import { cn } from '@/lib/utils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSearchPlace(p: GeoPoint, radiusKm: number): SearchPlace { return { name: p.name, lat: p.lat, lng: p.lng, radiusKm } }

/** Result payload from the server's /api/slots[/stream] endpoint. */
interface SlotsResult { slots: Slot[]; structureFetchedAt: string | null; cached: boolean }

/** Builds a TimeSpec from inline day/window state, or null when nothing is constrained. */
function buildTimeSpec(days: number[], anyTime: boolean, tStart: string, tEnd: string): TimeSpec | null {
  if (days.length === 0 && anyTime) return null
  return { type: 'schedule', weekdays: days, windows: anyTime ? [] : [{ start: tStart, end: tEnd }] }
}

/** Search radius bounds (km) when auto-fitting to a picked place. */
const MIN_RADIUS = 3
const MAX_RADIUS = 25

/**
 * Derives a sensible search radius from a geocoded place's bounding box, so
 * picking a city uses the city's own extent (e.g. Paris ≈ 10 km) and a precise
 * address uses the floor. Returns null when no usable box is available.
 * `bbox` is Nominatim's [south, north, west, east] in degrees.
 */
function radiusFromBBox(bbox: number[] | null | undefined, lat: number): number | null {
  if (!bbox || bbox.length !== 4) return null
  const [south, north, west, east] = bbox
  const latKm = Math.abs(north - south) * 111
  const lngKm = Math.abs(east - west) * 111 * Math.cos((lat * Math.PI) / 180)
  if (!isFinite(latKm) || !isFinite(lngKm)) return null
  // Half-diagonal covers the whole box from its centre.
  const halfDiag = 0.5 * Math.sqrt(latKm * latKm + lngKm * lngKm)
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(halfDiag)))
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const DAYS: Array<[string, number]> = [['M', 1], ['T', 2], ['W', 3], ['T', 4], ['F', 5], ['S', 6], ['S', 7]]
const DAY_FULL = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ── Grouping ──────────────────────────────────────────────────────────────────

// Display is derived from startsAtUtc (a valid UTC ISO string, always present)
// using the BROWSER's timezone formatting — browsers always ship full ICU, so
// this is immune to the server's locale build and to any stale-cached
// startsAtLocal. Europe/Paris is the booking timezone.
const PARIS_TZ = 'Europe/Paris'
const parisDateKey = (utc: string): string => new Date(utc).toLocaleDateString('en-CA', { timeZone: PARIS_TZ })       // "YYYY-MM-DD"
const parisDayLabel = (utc: string): string => new Date(utc).toLocaleDateString('fr-FR', { timeZone: PARIS_TZ, weekday: 'long', day: 'numeric', month: 'long' })
const parisTime = (utc: string): string => new Date(utc).toLocaleTimeString('fr-FR', { timeZone: PARIS_TZ, hour: '2-digit', minute: '2-digit' })

interface TeacherGroup {
  teacherId: string; teacherName: string; teacherRating: number
  locationName: string; locationLat: number; locationLng: number; slots: Slot[]
}
interface DayGroup { date: string; label: string; teacherGroups: TeacherGroup[] }

function groupSlots(slots: Slot[]): DayGroup[] {
  const sorted = [...slots].sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))
  const byDate = new Map<string, Map<string, TeacherGroup>>()
  const sampleUtc = new Map<string, string>()  // a representative instant per date for the label
  for (const s of sorted) {
    const date = parisDateKey(s.startsAtUtc)
    if (!byDate.has(date)) { byDate.set(date, new Map()); sampleUtc.set(date, s.startsAtUtc) }
    const byTeacher = byDate.get(date)!
    if (!byTeacher.has(s.teacherId)) {
      byTeacher.set(s.teacherId, {
        teacherId: s.teacherId, teacherName: s.teacherName, teacherRating: s.teacherRating,
        locationName: s.locationName, locationLat: s.locationLat, locationLng: s.locationLng, slots: [],
      })
    }
    byTeacher.get(s.teacherId)!.slots.push(s)
  }
  return [...byDate.entries()].map(([date, byTeacher]) => ({
    date,
    label: parisDayLabel(sampleUtc.get(date)!),
    teacherGroups: [...byTeacher.values()],
  }))
}

function SlotPill({ slot, wishlisted, onClick }: { slot: Slot; wishlisted: boolean; onClick: () => void }) {
  const startTime = parisTime(slot.startsAtUtc)
  const endUtc = new Date(new Date(slot.startsAtUtc).getTime() + slot.durationMinutes * 60_000).toISOString()
  const endTime = parisTime(endUtc)
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-sm transition-colors text-left',
        wishlisted
          ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400'
          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:border-indigo-200 dark:hover:border-indigo-700 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/20',
      )}
    >
      {wishlisted && <Heart size={11} className="shrink-0 fill-indigo-500 text-indigo-500 mr-0.5" />}
      <span className="font-semibold tabular-nums">{startTime}</span>
      <span className={cn('tabular-nums', wishlisted ? 'text-indigo-400 dark:text-indigo-500' : 'text-slate-400 dark:text-slate-500')}>–{endTime}</span>
    </button>
  )
}

// ── Popover ───────────────────────────────────────────────────────────────────

function Popover({ trigger, children, panelClass }: { trigger: React.ReactNode; children: React.ReactNode; panelClass?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700/40 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:border-indigo-400 transition-colors"
      >
        {trigger}
        <ChevronDown size={13} className={cn('text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className={cn('absolute z-40 mt-1 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-xl p-4', panelClass)}>
          {children}
        </div>
      )}
    </div>
  )
}

// ── Location autocomplete ─────────────────────────────────────────────────────

interface GeoCandidate { display_name: string; lat: number; lng: number; place_type: string; boundingbox: number[] | null }

function LocationSearch({ value, onPick }: { value: string; onPick: (g: GeoPoint, suggestedRadius: number | null) => void }) {
  const [q, setQ] = useState(value)
  const [cands, setCands] = useState<GeoCandidate[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setQ(value) }, [value])

  useEffect(() => {
    if (!open || q.trim().length < 2) { setCands([]); return }
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await fetch('/geocode?q=' + encodeURIComponent(q.trim()))
        setCands(r.ok ? await r.json() : [])
      } catch { setCands([]) } finally { setLoading(false) }
    }, 350)
    return () => clearTimeout(t)
  }, [q, open])

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const pick = (c: GeoCandidate) => {
    const name = c.display_name.split(',')[0].trim()
    setQ(name); setOpen(false); setCands([])
    onPick({ name, lat: c.lat, lng: c.lng }, radiusFromBBox(c.boundingbox, c.lat))
  }

  return (
    <div className="relative" ref={ref}>
      <div className="flex items-center gap-2 rounded-xl border-2 border-slate-200 dark:border-slate-600 focus-within:border-indigo-500 bg-white dark:bg-slate-700/40 px-3 transition-colors">
        <Search size={18} className="text-slate-400 shrink-0" />
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Search a city, address or postal code…"
          className="w-full bg-transparent py-3 text-base sm:text-sm outline-none placeholder-slate-400 dark:placeholder-slate-500 text-slate-900 dark:text-slate-100"
        />
        {loading && <span className="text-xs text-slate-400 shrink-0">…</span>}
        {q && <button onClick={() => { setQ(''); setCands([]); setOpen(false) }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0"><X size={16} /></button>}
      </div>
      {open && cands.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-xl text-sm max-h-64 overflow-auto">
          {cands.map((c, i) => (
            <li key={i} onMouseDown={() => pick(c)}
              className="px-3 py-2.5 cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 border-b border-slate-100 dark:border-slate-700 last:border-0">
              <div className="font-medium text-slate-900 dark:text-slate-100">{c.display_name.split(',')[0]}
                <span className="ml-1 text-xs text-slate-400">{c.place_type}</span>
              </div>
              <div className="text-xs text-slate-400 dark:text-slate-500 truncate">{c.display_name}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const PAGE_SIZE = 5

// ── Main page ─────────────────────────────────────────────────────────────────

export default function QueryPage() {
  const { add: addToWishlist, remove: removeFromWishlist, has: inWishlist } = useWishlist()
  const { cacheTtlMin } = useSettings()
  const { state: qs, setState: setQs } = useQueryState()

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', message: '', current: 0, total: 0 })
  const [recents, setRecents] = useState<RecentSearch[]>(() => loadRecents())
  const [mapLocation, setMapLocation] = useState<{ name: string; lat: number; lng: number } | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<{ slot: Slot; dateLabel: string } | null>(null)

  // Full slot set from the last fetch, kept so rating/day/time filters re-apply instantly (no refetch).
  const lastSlotsRef = useRef<Slot[] | null>(null)
  const didInit = useRef(false)
  // Aborts the in-flight search stream (the server keeps scanning to warm the cache).
  const abortRef = useRef<AbortController | null>(null)

  const cancelSearch = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
    setProgress({ phase: 'idle', message: '', current: 0, total: 0 })
  }, [])

  // Search runs server-side now: one streamed request to /api/slots/stream. The
  // server does the shared, cached discovery + slot fetching with its own
  // anonymous session; the client just renders progress and filters the result.
  const runQuery = useCallback(async (override: Partial<typeof qs> = {}) => {
    const s = { ...qs, ...override }
    const place = s.place
    if (!place) return

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setRunning(true)
    setProgress({ phase: 'structure', message: 'Connecting…', current: 0, total: 0 })
    setQs({ error: null, results: null, snapshotInfo: null, visibleDays: PAGE_SIZE })

    const applyResult = (data: SlotsResult): void => {
      lastSlotsRef.current = data.slots
      const timeSpec = buildTimeSpec(s.days, s.anyTime, s.tStart, s.tEnd)
      const filtered = applySearch({ place: toSearchPlace(place, s.radiusKm), time: timeSpec, gearbox: s.gearbox, minRating: s.minRating }, data.slots)
      setProgress({ phase: 'done', message: `Found ${filtered.length} slot(s).`, current: 0, total: 0 })
      setQs({ results: filtered, snapshotInfo: { slots: data.slots.length, fetchedAt: data.structureFetchedAt } })

      const rec: RecentSearch = {
        place: { name: place.name, lat: place.lat, lng: place.lng, radius_km: s.radiusKm },
        gearbox: s.gearbox, minRating: s.minRating, days: s.days, anyTime: s.anyTime, tStart: s.tStart, tEnd: s.tEnd,
      }
      saveLastSearch(rec)
      const next = [rec, ...recents.filter(r => !(r.place.name === rec.place.name && r.place.radius_km === rec.place.radius_km))].slice(0, 8)
      saveRecents(next); setRecents(next)
    }

    const params = new URLSearchParams({
      lat: String(place.lat), lng: String(place.lng), radius: String(s.radiusKm),
      gearbox: s.gearbox, ttl: String(cacheTtlMin),
    })

    try {
      const resp = await fetch(`/api/slots/stream?${params}`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } })
      if (!resp.ok || !resp.body) throw new Error(`Search failed (HTTP ${resp.status}).`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let finished = false
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line.
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep); buf = buf.slice(sep + 2)
          let event = 'message'; let dataStr = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
          }
          if (!dataStr) continue
          if (event === 'progress') { try { setProgress(JSON.parse(dataStr) as ProgressState) } catch { /* ignore */ } }
          else if (event === 'result') { finished = true; applyResult(JSON.parse(dataStr) as SlotsResult) }
          else if (event === 'error') { throw new Error((JSON.parse(dataStr) as { message?: string }).message || 'Search failed.') }
        }
      }
      if (!finished) throw new Error('Search ended unexpectedly. Please try again.')
    } catch (err) {
      if (ac.signal.aborted) return  // user cancelled — not a real error
      setProgress({ phase: 'idle', message: '', current: 0, total: 0 })
      setQs({ error: (err as Error).message })
    } finally {
      if (abortRef.current === ac) { abortRef.current = null; setRunning(false) }
    }
  }, [qs, setQs, cacheTtlMin, recents])

  // Restore last search on first mount (filters only; user taps Search or a recent chip to run).
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    if (!qs.place) {
      const last = loadLastSearch()
      if (last) setQs({
        place: { name: last.place.name, lat: last.place.lat, lng: last.place.lng },
        radiusKm: last.place.radius_km, gearbox: last.gearbox, minRating: last.minRating,
        days: last.days, anyTime: last.anyTime, tStart: last.tStart, tEnd: last.tEnd,
      })
    }
  }, [qs.place, setQs])

  // Instant re-filter when rating/day/time change (re-applies on the already-fetched slots).
  useEffect(() => {
    const slots = lastSlotsRef.current
    if (!slots || !qs.place) return
    const timeSpec = buildTimeSpec(qs.days, qs.anyTime, qs.tStart, qs.tEnd)
    setQs({ results: applySearch({ place: toSearchPlace(qs.place, qs.radiusKm), time: timeSpec, gearbox: qs.gearbox, minRating: qs.minRating }, slots) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs.minRating, qs.days, qs.anyTime, qs.tStart, qs.tEnd])

  const applyRecent = (r: RecentSearch) => {
    const override = {
      place: { name: r.place.name, lat: r.place.lat, lng: r.place.lng } as GeoPoint,
      radiusKm: r.place.radius_km, gearbox: r.gearbox, minRating: r.minRating,
      days: r.days, anyTime: r.anyTime, tStart: r.tStart, tEnd: r.tEnd,
    }
    setQs(override)
    runQuery(override)
  }

  // Picking a place only sets the location (and auto-fits the radius to its
  // extent). The search runs when the user presses Search — picking alone must
  // not trigger a query.
  const onPickLocation = (g: GeoPoint, suggestedRadius: number | null) => {
    const radiusKm = suggestedRadius ?? qs.radiusKm
    setQs({ place: g, radiusKm })
  }

  const dayGroups = qs.results ? groupSlots(qs.results) : []
  const visibleGroups = dayGroups.slice(0, qs.visibleDays)
  const hiddenDays = dayGroups.length - qs.visibleDays

  const timeLabel = (() => {
    const d = qs.days.length ? qs.days.map(n => DAY_FULL[n].slice(0, 2)).join('') : ''
    const w = qs.anyTime ? '' : `${qs.tStart}–${qs.tEnd}`
    return !d && !w ? 'Any time' : [d, w].filter(Boolean).join(' · ')
  })()

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">

      {/* ── Search card ── */}
      <section className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm p-4 sm:p-5 space-y-4">
        <LocationSearch value={qs.place?.name ?? ''} onPick={onPickLocation} />

        {/* Compact controls */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Radius */}
          <Popover panelClass="w-64" trigger={<><CircleIcon size={14} className="text-slate-400" /><span>{qs.radiusKm} km</span></>}>
            <div className="flex justify-between text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
              <span>Search radius</span><span className="text-indigo-600 dark:text-indigo-400 font-bold">{qs.radiusKm} km</span>
            </div>
            <input type="range" min={1} max={50} step={1} value={qs.radiusKm}
              onChange={e => setQs({ radiusKm: Number(e.target.value) })} className="w-full accent-indigo-600" />
          </Popover>

          {/* Gearbox */}
          <div className="inline-flex rounded-xl border border-slate-200 dark:border-slate-600 overflow-hidden text-sm">
            {(['bvm', 'bva'] as const).map((g, i) => (
              <button key={g} onClick={() => setQs({ gearbox: g })}
                className={cn('px-3 py-2 font-medium transition-colors', i === 1 && 'border-l border-slate-200 dark:border-slate-600',
                  qs.gearbox === g ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-700/40 text-slate-600 dark:text-slate-300')}>
                {g === 'bvm' ? 'Manual' : 'Auto'}
              </button>
            ))}
          </div>

          {/* Rating */}
          <Popover panelClass="w-56" trigger={<><Star size={14} className="text-amber-400" /><span>{qs.minRating ? qs.minRating.toFixed(1) + '★' : 'Any'}</span></>}>
            <div className="flex justify-between text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
              <span>Minimum rating</span><span className="text-indigo-600 dark:text-indigo-400 font-bold">{qs.minRating ? qs.minRating.toFixed(1) + ' ★' : 'Any'}</span>
            </div>
            <input type="range" min={0} max={5} step={0.5} value={qs.minRating}
              onChange={e => setQs({ minRating: Number(e.target.value) })} className="w-full accent-indigo-600" />
          </Popover>

          {/* Time */}
          <Popover panelClass="w-72" trigger={<><Clock size={14} className="text-slate-400" /><span>{timeLabel}</span></>}>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Days <span className="font-normal text-slate-400">(none = any)</span></p>
            <div className="flex gap-1 mb-3">
              {DAYS.map(([label, iso]) => (
                <button key={iso} title={DAY_FULL[iso]}
                  onClick={() => setQs({ days: qs.days.includes(iso) ? qs.days.filter(d => d !== iso) : [...qs.days, iso].sort((a, b) => a - b) })}
                  className={cn('flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors',
                    qs.days.includes(iso) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600')}>
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer mb-2 text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={qs.anyTime} onChange={e => setQs({ anyTime: e.target.checked })} className="accent-indigo-600" /> Any time of day
            </label>
            {!qs.anyTime && (
              <div className="flex items-center gap-2 text-sm">
                <input type="time" value={qs.tStart} onChange={e => setQs({ tStart: e.target.value })} className="rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-2 py-1.5 text-slate-900 dark:text-slate-100" />
                <span className="text-slate-400">→</span>
                <input type="time" value={qs.tEnd} onChange={e => setQs({ tEnd: e.target.value })} className="rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-2 py-1.5 text-slate-900 dark:text-slate-100" />
              </div>
            )}
          </Popover>
        </div>

        {/* Recent searches */}
        {recents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 shrink-0">Recent</span>
            <div className="flex gap-2 overflow-x-auto py-0.5">
              {recents.map((r, i) => (
                <button key={i} onClick={() => applyRecent(r)}
                  className="shrink-0 flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700/40 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                  <MapPin size={11} className="text-slate-400" /><span>{r.place.name}</span><span className="text-slate-400">{r.place.radius_km}km</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {running ? (
          <button onClick={cancelSearch}
            className="w-full rounded-xl py-3 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors">
            Cancel search
          </button>
        ) : (
          <button onClick={() => runQuery()} disabled={!qs.place}
            className={cn('w-full rounded-xl py-3 text-sm font-semibold text-white transition-colors',
              !qs.place ? 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700')}>
            Search
          </button>
        )}

        {progress.phase !== 'idle' && <FetchProgress state={progress} />}
      </section>

      {qs.error && (
        <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-400">{qs.error}</div>
      )}

      {/* ── Results ── */}
      {qs.results !== null && (
        <section className="space-y-1">
          <div className="flex items-center justify-between px-1 pb-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-slate-100">{qs.results.length}</span> slot(s) across{' '}
              <span className="font-semibold text-slate-900 dark:text-slate-100">{dayGroups.length}</span> day(s)
            </p>
            {qs.snapshotInfo && (
              <p className="text-[10px] text-slate-400 dark:text-slate-500">
                {qs.snapshotInfo.slots} cached{qs.snapshotInfo.fetchedAt && ` · ${relativeTime(qs.snapshotInfo.fetchedAt)}`}
              </p>
            )}
          </div>
          {qs.results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-10 text-center text-sm text-slate-500 dark:text-slate-400">No slots match your filters.</div>
          ) : (
            <>
              <div className="space-y-4">
                {visibleGroups.map(day => {
                  const dayCount = day.teacherGroups.reduce((n, tg) => n + tg.slots.length, 0)
                  return (
                    <div key={day.date} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm">
                      {/* Prominent day header — sticks under the topbar while scrolling a long list */}
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl bg-indigo-600 px-4 py-2.5 text-white">
                        <h3 className="flex items-center gap-2 text-sm font-bold tracking-wide first-letter:uppercase">
                          <CalendarDays size={15} className="shrink-0 opacity-80" />
                          {day.label}
                        </h3>
                        <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold tabular-nums">
                          {dayCount} slot{dayCount > 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="divide-y divide-slate-100 dark:divide-slate-700">
                        {day.teacherGroups.map(tg => (
                          <div key={tg.teacherId} className="px-4 py-3">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className="font-medium text-sm text-slate-800 dark:text-slate-200">{tg.teacherName}</span>
                              {tg.teacherRating > 0 && <span className="text-xs text-amber-500">{'★'.repeat(Math.round(tg.teacherRating))} {tg.teacherRating.toFixed(1)}</span>}
                              <span className="text-slate-200 dark:text-slate-600">·</span>
                              <button onClick={() => setMapLocation({ name: tg.locationName, lat: tg.locationLat, lng: tg.locationLng })}
                                className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
                                <MapPin size={11} />{tg.locationName}
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {tg.slots.map(slot => (
                                <SlotPill key={wishlistKey(slot)} slot={slot} wishlisted={inWishlist(wishlistKey(slot))}
                                  onClick={() => setSelectedSlot({ slot, dateLabel: day.label })} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              {hiddenDays > 0 && (
                <button onClick={() => setQs({ visibleDays: qs.visibleDays + PAGE_SIZE })}
                  className="w-full rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-600 py-3 text-sm text-slate-500 dark:text-slate-400 hover:border-indigo-300 hover:text-indigo-600 transition-colors mt-3">
                  Show {Math.min(hiddenDays, PAGE_SIZE)} more day{Math.min(hiddenDays, PAGE_SIZE) > 1 ? 's' : ''}
                  <span className="text-slate-400 ml-1">({hiddenDays} remaining)</span>
                </button>
              )}
            </>
          )}
        </section>
      )}

      {/* Modals */}
      {selectedSlot && (
        <WishlistSlotModal
          slot={selectedSlot.slot} dateLabel={selectedSlot.dateLabel}
          wishlisted={inWishlist(wishlistKey(selectedSlot.slot))}
          onAdd={() => addToWishlist(selectedSlot.slot)}
          onRemove={() => removeFromWishlist(wishlistKey(selectedSlot.slot))}
          onClose={() => setSelectedSlot(null)}
          onShowMap={() => setMapLocation({ name: selectedSlot.slot.locationName, lat: selectedSlot.slot.locationLat, lng: selectedSlot.slot.locationLng })}
        />
      )}
      {mapLocation && <LocationMapModal name={mapLocation.name} lat={mapLocation.lat} lng={mapLocation.lng} onClose={() => setMapLocation(null)} />}
    </div>
  )
}
