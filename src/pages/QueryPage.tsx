import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, MapPin, Heart, Clock, Star, Circle as CircleIcon, ChevronDown, X } from 'lucide-react'
import LocationMapModal from '@/components/LocationMapModal'
import WishlistSlotModal from '@/components/WishlistSlotModal'
import FetchProgress, { type ProgressState } from '@/components/FetchProgress'
import {
  useAccounts, useWishlist, useSettings, wishlistKey,
  loadRecents, saveRecents, loadLastSearch, saveLastSearch,
  type Account, type RecentSearch,
} from '@/store/config'
import { useQueryState, type GeoPoint } from '@/store/queryState'
import { evsClient } from '@/api/evs'
import { contains, type SearchPlace } from '@/core/geo'
import { applySearch } from '@/core/search'
import { type TimeSpec } from '@/core/time'
import {
  loadSnapshot, saveSnapshot, emptySnapshot,
  evictPastSlots, stalePairs, structureIsStale,
  updateStructure, replacePairSlots,
  type PairMeta, type Slot,
} from '@/core/snapshot'
import { cn, mapLimit } from '@/lib/utils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function zoneKey(p: GeoPoint, radiusKm: number): string { return `${p.lat},${p.lng},${radiusKm}` }
function toSearchPlace(p: GeoPoint, radiusKm: number): SearchPlace { return { name: p.name, lat: p.lat, lng: p.lng, radiusKm } }

/** Builds a TimeSpec from inline day/window state, or null when nothing is constrained. */
function buildTimeSpec(days: number[], anyTime: boolean, tStart: string, tEnd: string): TimeSpec | null {
  if (days.length === 0 && anyTime) return null
  return { type: 'schedule', weekdays: days, windows: anyTime ? [] : [{ start: tStart, end: tEnd }] }
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

interface TeacherGroup {
  teacherId: string; teacherName: string; teacherRating: number
  locationName: string; locationLat: number; locationLng: number; slots: Slot[]
}
interface DayGroup { date: string; label: string; teacherGroups: TeacherGroup[] }

function groupSlots(slots: Slot[]): DayGroup[] {
  const sorted = [...slots].sort((a, b) => a.startsAtLocal.localeCompare(b.startsAtLocal))
  const byDate = new Map<string, Map<string, TeacherGroup>>()
  for (const s of sorted) {
    const date = s.startsAtLocal.slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, new Map())
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
    label: new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
    teacherGroups: [...byTeacher.values()],
  }))
}

function SlotPill({ slot, wishlisted, onClick }: { slot: Slot; wishlisted: boolean; onClick: () => void }) {
  const start = new Date(slot.startsAtLocal)
  const startTime = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const endTime = new Date(start.getTime() + slot.durationMinutes * 60_000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
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

interface GeoCandidate { display_name: string; lat: number; lng: number; place_type: string }

function LocationSearch({ value, onPick }: { value: string; onPick: (g: GeoPoint) => void }) {
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
    onPick({ name, lat: c.lat, lng: c.lng })
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
  const { accounts, activeAccount: account, addAccount } = useAccounts()
  const { add: addToWishlist, remove: removeFromWishlist, has: inWishlist } = useWishlist()
  const { cacheTtlMin } = useSettings()
  const { state: qs, setState: setQs } = useQueryState()

  const [running, setRunning] = useState(false)
  const [anonError, setAnonError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', message: '', current: 0, total: 0 })
  const [recents, setRecents] = useState<RecentSearch[]>(() => loadRecents())
  const [mapLocation, setMapLocation] = useState<{ name: string; lat: number; lng: number } | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<{ slot: Slot; dateLabel: string } | null>(null)

  // Full slot set from the last fetch, kept so rating/day/time filters re-apply instantly (no refetch).
  const lastSlotsRef = useRef<Slot[] | null>(null)
  const didInit = useRef(false)

  const runQuery = useCallback(async (override: Partial<typeof qs> = {}) => {
    const s = { ...qs, ...override }
    const place = s.place
    if (!place) return

    let fetchAccount = account
    if (!fetchAccount) {
      const existing = accounts.find(a => a.anonymous) ?? null
      if (existing) fetchAccount = existing
      else {
        try {
          evsClient.loadAccountTokens('__anon_tmp__')
          const { studentId, email, password } = await evsClient.registerAnonymous()
          const anon: Account = { name: 'Anonymous', email, password, studentId, anonymous: true }
          addAccount(anon)
          fetchAccount = anon
        } catch (err) { setAnonError((err as Error).message); return }
      }
    }

    setRunning(true)
    setProgress({ phase: 'evict', message: 'Preparing cache…', current: 0, total: 0 })
    setQs({ error: null, results: null, snapshotInfo: null, visibleDays: PAGE_SIZE })

    const radius = s.radiusKm
    const searchPlace = toSearchPlace(place, radius)
    const key = zoneKey(place, radius)

    try {
      evsClient.loadAccountTokens(fetchAccount.name)
      await evsClient.ensureAuth(fetchAccount.email, fetchAccount.password)

      let snapshot = (await loadSnapshot(key)) ?? emptySnapshot()
      evictPastSlots(snapshot)

      if (structureIsStale(snapshot, 24)) {
        setProgress({ phase: 'structure', message: 'Scanning area…', current: 0, total: 0 })
        const { points } = await evsClient.discoverMeetingPoints(
          { lat: place.lat, lng: place.lng }, radius, s.gearbox,
          found => setProgress({ phase: 'structure', message: `Scanning area… ${found} meeting point(s)`, current: 0, total: 0 }),
        )
        const inRadius = points.filter(p => contains(searchPlace, p) && p.nextAvailability !== null)

        let loaded = 0
        const teacherLists = await mapLimit(inRadius, 16, async point => {
          const teachers = await evsClient.getLocationTeachers(point.id, s.gearbox)
          loaded++
          setProgress({ phase: 'structure', message: `Loading teachers… ${loaded}/${inRadius.length} locations`, current: loaded, total: inRadius.length })
          return { point, teachers }
        })
        const discovered: PairMeta[] = []
        for (const { point, teachers } of teacherLists) {
          for (const t of teachers) {
            discovered.push({
              locationId: point.id, locationName: point.name,
              locationLat: point.lat, locationLng: point.lng,
              teacherId: t.id, teacherName: t.firstName,
              teacherRating: t.rating, teacherAutomaticCar: t.automaticCar,
              slotsFetchedAt: null,
            })
          }
        }
        updateStructure(snapshot, discovered, new Date())
        await saveSnapshot(key, snapshot)
      }

      // Slot freshness governed by the user's cache-expiration setting (0 = always refetch).
      const ttlHours = cacheTtlMin / 60
      const stale = [...stalePairs(snapshot, ttlHours)]
      let fetched = 0
      const now = new Date()
      await mapLimit(stale, 16, async pairKey => {
        const [locId, teacherId] = pairKey.split(':')
        const pair = snapshot.pairs.find(p => p.locationId === locId && p.teacherId === teacherId)
        if (!pair) return
        const slots = await evsClient.getTeacherAvailabilities(locId, teacherId, s.gearbox, pair)
        replacePairSlots(snapshot, locId, teacherId, slots, now)
        fetched++
        setProgress({ phase: 'slots', message: 'Fetching slots…', current: fetched, total: stale.length })
      })
      if (stale.length) await saveSnapshot(key, snapshot)

      lastSlotsRef.current = snapshot.slots
      const timeSpec = buildTimeSpec(s.days, s.anyTime, s.tStart, s.tEnd)
      const filtered = applySearch({ place: searchPlace, time: timeSpec, gearbox: s.gearbox, minRating: s.minRating }, snapshot.slots)
      setProgress({ phase: 'done', message: `Found ${filtered.length} slot(s).`, current: 0, total: 0 })
      setQs({ results: filtered, snapshotInfo: { slots: snapshot.slots.length, fetchedAt: snapshot.structureFetchedAt } })

      const rec: RecentSearch = {
        place: { name: place.name, lat: place.lat, lng: place.lng, radius_km: radius },
        gearbox: s.gearbox, minRating: s.minRating, days: s.days, anyTime: s.anyTime, tStart: s.tStart, tEnd: s.tEnd,
      }
      saveLastSearch(rec)
      const next = [rec, ...recents.filter(r => !(r.place.name === rec.place.name && r.place.radius_km === rec.place.radius_km))].slice(0, 8)
      saveRecents(next); setRecents(next)
    } catch (err) {
      setProgress({ phase: 'idle', message: '', current: 0, total: 0 })
      setQs({ error: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }, [qs, account, accounts, addAccount, setQs, cacheTtlMin, recents])

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

  const onPickLocation = (g: GeoPoint) => { setQs({ place: g }); runQuery({ place: g }) }

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

        <button onClick={() => runQuery()} disabled={!qs.place || running}
          className={cn('w-full rounded-xl py-3 text-sm font-semibold text-white transition-colors',
            !qs.place ? 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed' : running ? 'bg-indigo-400 cursor-wait' : 'bg-indigo-600 hover:bg-indigo-700')}>
          {running ? 'Searching…' : 'Search'}
        </button>

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
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
                {visibleGroups.map(day => (
                  <div key={day.date}>
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700">
                      <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest capitalize">{day.label}</h3>
                    </div>
                    {day.teacherGroups.map((tg, i) => (
                      <div key={tg.teacherId} className={cn('px-4 py-3', i < day.teacherGroups.length - 1 && 'border-b border-slate-100 dark:border-slate-700')}>
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
                            <SlotPill key={slot.startsAtLocal} slot={slot} wishlisted={inWishlist(wishlistKey(slot))}
                              onClick={() => setSelectedSlot({ slot, dateLabel: day.label })} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
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
      {anonError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setAnonError(null)} />
          <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <p className="font-semibold text-slate-900 dark:text-slate-100">Could not start session</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">Failed to create a temporary session to fetch slots. Check your connection and try again.</p>
            <p className="text-xs text-red-600 dark:text-red-400 font-mono">{anonError}</p>
            <button onClick={() => setAnonError(null)} className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 py-2.5 text-sm font-semibold text-white">Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
