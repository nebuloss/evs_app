import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Heart, MapPin } from 'lucide-react'
import PlacePicker from '@/components/PlacePicker'
import TimePicker from '@/components/TimePicker'
import LocationMapModal from '@/components/LocationMapModal'
import WishlistSlotModal from '@/components/WishlistSlotModal'
import FetchProgress, { type ProgressState } from '@/components/FetchProgress'
import { usePlaces, useTimes, useAccounts, useWishlist, wishlistKey, type PlaceProfile, type TimeProfile, type Account } from '@/store/config'
import { useQueryState } from '@/store/queryState'
import { evsClient } from '@/api/evs'
import { contains, type SearchPlace } from '@/core/geo'
import { applySearch, type Gearbox } from '@/core/search'
import {
  loadSnapshot, saveSnapshot, emptySnapshot,
  evictPastSlots, stalePairs, structureIsStale,
  updateStructure, replacePairSlots,
  type PairMeta, type Slot,
} from '@/core/snapshot'
import { cn } from '@/lib/utils'

// ── Helpers ───────────────────────────────────────────────────────────────────

function zoneKey(p: PlaceProfile): string { return `${p.lat},${p.lng},${p.radius_km}` }
function toSearchPlace(p: PlaceProfile): SearchPlace { return { name: p.name, lat: p.lat, lng: p.lng, radiusKm: p.radius_km } }
function toTimeSpec(t: TimeProfile) { return { type: 'schedule' as const, weekdays: t.weekdays, windows: t.windows } }

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Grouping ──────────────────────────────────────────────────────────────────

interface TeacherGroup {
  teacherId: string
  teacherName: string
  teacherRating: number
  locationName: string
  locationLat: number
  locationLng: number
  slots: Slot[]
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
        teacherId: s.teacherId,
        teacherName: s.teacherName,
        teacherRating: s.teacherRating,
        locationName: s.locationName,
        locationLat: s.locationLat,
        locationLng: s.locationLng,
        slots: [],
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

// ── SlotPill ──────────────────────────────────────────────────────────────────

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

const PAGE_SIZE = 5

// ── Main page ─────────────────────────────────────────────────────────────────

export default function QueryPage() {
  const navigate = useNavigate()
  const { places } = usePlaces()
  const { times } = useTimes()
  const { accounts, activeAccount: account, addAccount } = useAccounts()
  const { add: addToWishlist, remove: removeFromWishlist, has: inWishlist } = useWishlist()
  const { state: qs, setState: setQs } = useQueryState()

  // Seed place from saved profiles if nothing set yet
  const place = qs.place ?? places[0] ?? null
  useEffect(() => {
    if (!qs.place && places[0]) setQs({ place: places[0] })
  }, [places, qs.place, setQs])
  const setPlace = (p: PlaceProfile | null) => setQs({ place: p, results: null, snapshotInfo: null, error: null })
  const time = qs.time
  const setTime = (t: TimeProfile | null) => setQs({ time: t, results: null })
  const gearbox = qs.gearbox
  const setGearbox = (g: typeof qs.gearbox) => setQs({ gearbox: g, results: null })
  const minRating = qs.minRating
  const setMinRating = (r: number) => setQs({ minRating: r, results: null })

  const [running, setRunning] = useState(false)
  const [anonError, setAnonError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressState>({ phase: 'idle', message: '', current: 0, total: 0 })

  const [mapLocation, setMapLocation] = useState<{ name: string; lat: number; lng: number } | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<{ slot: Slot; dateLabel: string } | null>(null)

  const runQuery = useCallback(async (currentPlace: PlaceProfile = place!) => {
    if (!currentPlace) return

    // If no real account is active, silently create/reuse an anonymous one.
    let fetchAccount = account
    if (!fetchAccount) {
      const existing = accounts.find(a => a.anonymous) ?? null
      if (existing) {
        fetchAccount = existing
      } else {
        try {
          evsClient.loadAccountTokens('__anon_tmp__')
          const { studentId, email, password } = await evsClient.registerAnonymous()
          const anon: Account = { name: 'Anonymous', email, password, studentId, anonymous: true }
          addAccount(anon)
          fetchAccount = anon
        } catch (err) {
          setAnonError((err as Error).message)
          return
        }
      }
    }

    setRunning(true)
    setProgress({ phase: 'evict', message: 'Preparing cache…', current: 0, total: 0 })
    setQs({ error: null, results: null, snapshotInfo: null, visibleDays: PAGE_SIZE })

    const key = zoneKey(currentPlace)
    const searchPlace = toSearchPlace(currentPlace)

    try {
      evsClient.loadAccountTokens(fetchAccount.name)
      await evsClient.ensureAuth(fetchAccount.email, fetchAccount.password)

      let snapshot = (await loadSnapshot(key)) ?? emptySnapshot()

      evictPastSlots(snapshot)

      if (structureIsStale(snapshot, 24)) {
        setProgress({ phase: 'structure', message: 'Discovering meeting points…', current: 0, total: 0 })
        const points = await evsClient.getMeetingPoints(currentPlace.lat, currentPlace.lng, gearbox)
        const inRadius = points.filter(p => contains(searchPlace, p))
        const discovered: PairMeta[] = []

        for (const point of inRadius) {
          setProgress({ phase: 'structure', message: `Loading teachers at ${point.name}…`, current: 0, total: 0 })
          const teachers = await evsClient.getLocationTeachers(point.id, gearbox)
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
      }

      const stale = [...stalePairs(snapshot, 1)]
      for (let i = 0; i < stale.length; i++) {
        const pairKey = stale[i]
        const [locId, teacherId] = pairKey.split(':')
        const pair = snapshot.pairs.find(p => p.locationId === locId && p.teacherId === teacherId)
        if (!pair) continue
        setProgress({ phase: 'slots', message: `Fetching slots for ${pair.teacherName} at ${pair.locationName}…`, current: i + 1, total: stale.length })
        const slots = await evsClient.getTeacherAvailabilities(locId, teacherId, gearbox, pair)
        replacePairSlots(snapshot, locId, teacherId, slots, new Date())
        await saveSnapshot(key, snapshot)
      }

      const timeSpec = time ? toTimeSpec(time) : null
      const filtered = applySearch({ place: searchPlace, time: timeSpec, gearbox, minRating }, snapshot.slots)
      setProgress({ phase: 'done', message: `Found ${filtered.length} slot(s).`, current: 0, total: 0 })
      setQs({
        results: filtered,
        snapshotInfo: { slots: snapshot.slots.length, fetchedAt: snapshot.structureFetchedAt },
      })
    } catch (err) {
      setProgress({ phase: 'idle', message: '', current: 0, total: 0 })
      setQs({ error: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }, [place, gearbox, minRating, time, account, accounts, addAccount, setQs])

  const dayGroups = qs.results ? groupSlots(qs.results) : []
  const visibleGroups = dayGroups.slice(0, qs.visibleDays)
  const hiddenDays = dayGroups.length - qs.visibleDays

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Slots</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Fetch and search available driving lessons.</p>
      </div>

      {qs.snapshotInfo && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="h-2 w-2 rounded-full shrink-0 bg-emerald-400" />
            <span className="font-medium text-slate-700 dark:text-slate-300">{qs.snapshotInfo.slots}</span> slots in local cache
            {qs.snapshotInfo.fetchedAt && (
              <span className="text-slate-400 dark:text-slate-500">· updated {relativeTime(qs.snapshotInfo.fetchedAt)}</span>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 space-y-6">
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Location</h2>
          <PlacePicker places={places} selected={place} onChange={p => { setPlace(p); }} onAddNew={() => navigate('/settings')} />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Time profile{' '}
            <span className="text-slate-400 dark:text-slate-500 font-normal normal-case">(optional)</span>
          </h2>
          <TimePicker times={times} selected={time} onChange={t => { setTime(qs.time?.name === t.name ? null : t); }} onAddNew={() => navigate('/settings')} />
        </section>

        <section className="flex flex-wrap gap-8 items-end">
          <div>
            <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Gearbox</h2>
            <div className="flex gap-4">
              {(['bvm', 'bva'] as const).map(g => (
                <label key={g} className="flex items-center gap-1.5 cursor-pointer text-sm text-slate-700 dark:text-slate-300">
                  <input type="radio" name="gearbox-q" value={g} checked={gearbox === g}
                    onChange={() => { setGearbox(g); }} className="accent-indigo-600" />
                  {g === 'bvm' ? 'Manual' : 'Automatic'}
                </label>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-48">
            <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Min rating: <span className="text-indigo-600 dark:text-indigo-400 font-bold">{minRating.toFixed(1)} ★</span>
            </h2>
            <input type="range" min={0} max={5} step={0.5} value={minRating}
              onChange={e => { setMinRating(Number(e.target.value)); }}
              className="w-full accent-indigo-600" />
          </div>
        </section>

        <button
          onClick={() => runQuery()}
          disabled={!place || running}
          className={cn(
            'w-full rounded-xl py-2.5 text-sm font-semibold text-white transition-colors',
            !place ? 'bg-slate-300 dark:bg-slate-600 cursor-not-allowed'
              : running ? 'bg-indigo-400 cursor-wait'
              : 'bg-indigo-600 hover:bg-indigo-700',
          )}
        >
          {running ? 'Fetching…' : 'Fetch & search'}
        </button>

        {progress.phase !== 'idle' && (
          <FetchProgress state={progress} />
        )}
      </div>

      {qs.error && (
        <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-400">{qs.error}</div>
      )}

      {/* Grouped results */}
      {qs.results !== null && (
        <section className="space-y-1">
          <p className="text-xs text-slate-500 dark:text-slate-400 pb-2">
            <span className="font-semibold text-slate-900 dark:text-slate-100">{qs.results.length}</span> slot(s) across{' '}
            <span className="font-semibold text-slate-900 dark:text-slate-100">{dayGroups.length}</span> day(s)
          </p>
          {qs.results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
              No slots match your filters.
            </div>
          ) : (
            <>
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
                {visibleGroups.map(day => (
                  <div key={day.date}>
                    {/* Day header */}
                    <div className="px-4 py-2 bg-slate-50 dark:bg-slate-700/50 border-b border-slate-100 dark:border-slate-700">
                      <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest capitalize">
                        {day.label}
                      </h3>
                    </div>
                    {/* Teacher rows */}
                    {day.teacherGroups.map((tg, i) => (
                      <div
                        key={tg.teacherId}
                        className={cn('px-4 py-3', i < day.teacherGroups.length - 1 && 'border-b border-slate-100 dark:border-slate-700')}
                      >
                        {/* Teacher + location header */}
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-medium text-sm text-slate-800 dark:text-slate-200">{tg.teacherName}</span>
                          {tg.teacherRating > 0 && (
                            <span className="text-xs text-amber-500">{'★'.repeat(Math.round(tg.teacherRating))} {tg.teacherRating.toFixed(1)}</span>
                          )}
                          <span className="text-slate-200 dark:text-slate-600">·</span>
                          <button
                            onClick={() => setMapLocation({ name: tg.locationName, lat: tg.locationLat, lng: tg.locationLng })}
                            className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                          >
                            <MapPin size={11} />
                            {tg.locationName}
                          </button>
                        </div>
                        {/* Slot pills */}
                        <div className="flex flex-wrap gap-1.5">
                          {tg.slots.map(s => {
                            const key = wishlistKey(s)
                            return (
                              <SlotPill
                                key={s.startsAtLocal}
                                slot={s}
                                wishlisted={inWishlist(key)}
                                onClick={() => setSelectedSlot({ slot: s, dateLabel: day.label })}
                              />
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {hiddenDays > 0 && (
                <button
                  onClick={() => setQs({ visibleDays: qs.visibleDays + PAGE_SIZE })}
                  className="w-full rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-600 py-3 text-sm text-slate-500 dark:text-slate-400 hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors mt-3"
                >
                  Show {Math.min(hiddenDays, PAGE_SIZE)} more day{Math.min(hiddenDays, PAGE_SIZE) > 1 ? 's' : ''}
                  <span className="text-slate-400 dark:text-slate-500 ml-1">({hiddenDays} remaining)</span>
                </button>
              )}
            </>
          )}
        </section>
      )}

      {/* Modals */}
      {selectedSlot && (
        <WishlistSlotModal
          slot={selectedSlot.slot}
          dateLabel={selectedSlot.dateLabel}
          wishlisted={inWishlist(wishlistKey(selectedSlot.slot))}
          onAdd={() => addToWishlist(selectedSlot.slot)}
          onRemove={() => removeFromWishlist(wishlistKey(selectedSlot.slot))}
          onClose={() => setSelectedSlot(null)}
          onShowMap={() => {
            setMapLocation({ name: selectedSlot.slot.locationName, lat: selectedSlot.slot.locationLat, lng: selectedSlot.slot.locationLng })
          }}
        />
      )}

      {mapLocation && (
        <LocationMapModal
          name={mapLocation.name}
          lat={mapLocation.lat}
          lng={mapLocation.lng}
          onClose={() => setMapLocation(null)}
        />
      )}

      {anonError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setAnonError(null)} />
          <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4">
            <p className="font-semibold text-slate-900 dark:text-slate-100">Could not start session</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Failed to create a temporary session to fetch slots. Check your internet connection and try again.
            </p>
            <p className="text-xs text-red-600 dark:text-red-400 font-mono">{anonError}</p>
            <button
              onClick={() => setAnonError(null)}
              className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 py-2.5 text-sm font-semibold text-white transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
