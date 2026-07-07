/**
 * Zone-scan orchestration: turns a (lat, lng, radius, gearbox) request into a
 * list of slots, reusing a shared per-gearbox cache so overlapping searches
 * don't redo work.
 *
 * Three cache lifetimes, matched to how fast the data changes:
 *   1. Meeting-point discovery (the expensive quadtree) — skipped entirely when
 *      the requested area already falls inside a fresh "coverage disc".
 *   2. Teacher lists per location — stable, long TTL, fetched once and reused
 *      across every area that contains the location.
 *   3. Slots (availabilities) per pair — volatile, short (client-set) TTL.
 *
 * Concurrent identical requests are de-duplicated (single-flight) so N clients
 * searching the same area trigger ONE scan and share its progress.
 */

import type { Slot, Gearbox, KnownLocation, CoverageDisc } from '../src/core/types'
import {
  ensureAuth, discoverMeetingPoints, getLocationTeachers, getTeacherAvailabilities,
  haversineKm, EvsHttpError,
} from './evs-service'
import {
  zoneKey, getSnapshot, saveZone, evictPastSlots, teachersStale, slotsStale,
  upsertLocation, recordDiscovery, reconcileLocationPairs, replacePairSlots,
} from './cache-store'

const CONCURRENCY = Number(process.env.EVS_MAX_CONCURRENCY ?? 16)
// Meeting points + teachers are stable, so cache them for a long time and reuse
// them across searches; only re-discover / re-list after this many hours.
const STRUCTURE_TTL_HOURS = Number(process.env.EVS_STRUCTURE_TTL_HOURS ?? 24 * 7)

export interface ProgressEvent { phase: 'structure' | 'slots' | 'done'; message: string; current: number; total: number }
export interface ScanResult { slots: Slot[]; structureFetchedAt: string | null; cached: boolean }
export interface ScanParams { lat: number; lng: number; radiusKm: number; gearbox: Gearbox; ttlMin: number }

type Emit = (ev: ProgressEvent) => void
type Center = { lat: number; lng: number }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ── Geometry (kept here, next to haversine) ──────────────────────────────────────

/** True if disc fully contains the query disc (center, radiusKm). */
function discContains(disc: CoverageDisc, center: Center, radiusKm: number): boolean {
  return haversineKm({ lat: disc.lat, lng: disc.lng }, center) + radiusKm <= disc.radiusKm + 1e-6
}

/** True if the requested area is already covered by a fresh discovery disc. */
function areaCovered(discs: CoverageDisc[], center: Center, radiusKm: number, ttlHours: number): boolean {
  const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString()
  return discs.some(d => d.at >= cutoff && discContains(d, center, radiusKm))
}

function locationsInRadius(locations: KnownLocation[], center: Center, radiusKm: number): KnownLocation[] {
  return locations.filter(l => haversineKm(center, { lat: l.lat, lng: l.lng }) <= radiusKm)
}

// ── Scan ─────────────────────────────────────────────────────────────────────────

async function scan(key: string, p: ScanParams, emit: Emit): Promise<ScanResult> {
  await ensureAuth()
  const snap = getSnapshot(key)  // shared in-memory snapshot for this gearbox
  evictPastSlots(snap)
  const center: Center = { lat: p.lat, lng: p.lng }

  // 1. Discovery — only when the area isn't already covered by a fresh disc. This
  //    is the expensive part (a quadtree of up to 500 EVS queries); reusing prior
  //    discovery is the biggest win for overlapping/repeated searches.
  const covered = areaCovered(snap.discs, center, p.radiusKm, STRUCTURE_TTL_HOURS)
  if (!covered) {
    emit({ phase: 'structure', message: 'Scanning area…', current: 0, total: 0 })
    const { points, failures, truncated } = await discoverMeetingPoints(
      center, p.radiusKm, p.gearbox,
      found => emit({ phase: 'structure', message: `Scanning area… ${found} meeting point(s)`, current: 0, total: 0 }),
    )
    if (points.length === 0 && failures > 0) {
      throw new EvsHttpError(502, `Couldn't reach EVS to scan the area (${failures} request(s) failed)`)
    }
    for (const pt of points) upsertLocation(snap, pt)
    // Only mark the area covered when discovery was complete — a truncated or
    // partly-failed sweep leaves gaps, so let a later search re-discover it.
    if (!truncated && failures === 0) recordDiscovery(snap, center, p.radiusKm, new Date(), discContains)
    saveZone(key, snap)
  }

  // 2. In-radius meeting points, drawn from the shared registry (which now
  //    includes anything discovered by earlier searches of other areas).
  const inRadius = locationsInRadius(snap.locations, center, p.radiusKm)
  const inRadiusIds = new Set(inRadius.map(l => l.id))

  // 3. Teacher lists — fetch only for in-radius locations whose list is missing
  //    or past the long structure TTL; reconcile each location's pairs in place.
  const staleLocs = inRadius.filter(l => teachersStale(l, STRUCTURE_TTL_HOURS))
  let loaded = 0
  await mapLimit(staleLocs, CONCURRENCY, async loc => {
    try {
      const teachers = await getLocationTeachers(loc.id, p.gearbox)
      reconcileLocationPairs(snap, loc, teachers, new Date())
    } catch { /* leave this location's pairs as-is; retried next scan */ }
    loaded++
    emit({ phase: 'structure', message: `Loading teachers… ${loaded}/${staleLocs.length} locations`, current: loaded, total: staleLocs.length })
  })
  if (staleLocs.length) saveZone(key, snap)

  // 4. Slots — refresh only stale pairs among the in-radius locations (short TTL).
  const ttlHours = p.ttlMin / 60
  const stale = snap.pairs.filter(pr => inRadiusIds.has(pr.locationId) && slotsStale(pr, ttlHours))
  let fetched = 0
  const now = new Date()
  await mapLimit(stale, CONCURRENCY, async pair => {
    let slots: Slot[] = []
    try { slots = await getTeacherAvailabilities(pair.locationId, pair.teacherId, p.gearbox, pair) } catch { /* no slots */ }
    replacePairSlots(snap, pair.locationId, pair.teacherId, slots, now)
    fetched++
    emit({ phase: 'slots', message: 'Fetching slots…', current: fetched, total: stale.length })
  })
  if (stale.length) saveZone(key, snap)

  // 5. Return only the slots at in-radius locations (the snapshot spans the whole
  //    gearbox; a single search must not leak slots from other areas).
  const result = snap.slots.filter(s => inRadiusIds.has(s.locationId))
  const structureFetchedAt = snap.discs.reduce<string | null>(
    (max, d) => (max === null || d.at > max ? d.at : max), null)
  emit({ phase: 'done', message: `Found ${result.length} slot(s).`, current: 0, total: 0 })
  return { slots: result, structureFetchedAt, cached: covered && staleLocs.length === 0 && stale.length === 0 }
}

// ── Single-flight: dedupe concurrent identical scans, share their progress ────────

interface Job { promise: Promise<ScanResult>; listeners: Set<Emit>; last: ProgressEvent | null }
const jobs = new Map<string, Job>()

export async function getZoneSlots(p: ScanParams, emit: Emit): Promise<ScanResult> {
  const storeKey = zoneKey(p.gearbox)
  // Dedupe on the exact request (area + gearbox), NOT the storage key — different
  // areas of the same gearbox are distinct scans that share the underlying cache.
  const jobKey = `${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.radiusKm},${p.gearbox}`
  const existing = jobs.get(jobKey)
  if (existing) {
    if (existing.last) emit(existing.last)  // catch the joiner up to current progress
    existing.listeners.add(emit)
    try { return await existing.promise } finally { existing.listeners.delete(emit) }
  }
  const job: Job = { listeners: new Set([emit]), last: null, promise: Promise.resolve({ slots: [], structureFetchedAt: null, cached: false }) }
  job.promise = scan(storeKey, p, ev => { job.last = ev; for (const l of job.listeners) l(ev) }).finally(() => jobs.delete(jobKey))
  jobs.set(jobKey, job)
  try { return await job.promise } finally { job.listeners.delete(emit) }
}
