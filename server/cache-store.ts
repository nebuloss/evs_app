/**
 * Shared slot cache (server side, dependency-free).
 *
 * ONE snapshot per gearbox (not per search area), grown incrementally and kept
 * in memory (loaded from disk once), so overlapping searches reuse everything
 * already discovered/fetched. Meeting points and teachers (structure) are stable
 * and cached for a long time; slots (availabilities) are volatile and cached
 * briefly. Search-area geometry (which points are in radius, whether an area is
 * already covered) lives in search.ts, next to the haversine helper.
 *
 * Self-healing: malformed JSON or a structurally-broken file is treated as a
 * miss (→ rebuilt), and individual corrupt records / orphans are dropped.
 * Survives appliance updates (install.sh never removes CACHE_DIR).
 */

import fs from 'fs'
import path from 'path'
import type { Snapshot, KnownLocation, CoverageDisc, PairMeta, Slot, Gearbox } from '../src/core/types'

const CACHE_DIR = process.env.EVS_CACHE_DIR || path.join(process.cwd(), 'cache')
const ZONES_DIR = path.join(CACHE_DIR, 'zones')
// Bump when the cached data shape/semantics change so old files are ignored
// (treated as a miss → rebuilt). v2: locale-independent slot times. v3: stop
// pruning points by next_availability. v4: coerce null teacher ratings. v5:
// per-gearbox incremental cache (locations/teachers cached long + reused across
// areas, coverage discs gate re-discovery).
const CACHE_VERSION = 5

// ── Keys & files ─────────────────────────────────────────────────────────────────

/** Storage key: one snapshot per gearbox, shared across every search area. */
export function zoneKey(gearbox: Gearbox): string {
  return gearbox
}

function zoneFile(key: string): string {
  return path.join(ZONES_DIR, Buffer.from(key).toString('base64url') + '.json')
}

export function emptySnapshot(): Snapshot {
  return { discs: [], locations: [], pairs: [], slots: [] }
}

// ── Validation / sanitization ────────────────────────────────────────────────────

const isStr = (x: unknown): x is string => typeof x === 'string'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function validLocation(l: any): l is KnownLocation {
  return !!l && isStr(l.id) && isStr(l.name) && isNum(l.lat) && isNum(l.lng) &&
    (l.teachersFetchedAt === null || isStr(l.teachersFetchedAt))
}

function validDisc(d: any): d is CoverageDisc {
  return !!d && isNum(d.lat) && isNum(d.lng) && isNum(d.radiusKm) && isStr(d.at)
}

function validPair(p: any): p is PairMeta {
  return !!p && isStr(p.locationId) && isStr(p.teacherId) && isStr(p.locationName) &&
    isNum(p.locationLat) && isNum(p.locationLng) && isStr(p.teacherName) &&
    isNum(p.teacherRating) && typeof p.teacherAutomaticCar === 'boolean' &&
    (p.slotsFetchedAt === null || isStr(p.slotsFetchedAt))
}

function validSlot(s: any): s is Slot {
  return !!s && isStr(s.locationId) && isStr(s.teacherId) && isStr(s.locationName) &&
    isNum(s.locationLat) && isNum(s.locationLng) && isStr(s.teacherName) && isNum(s.teacherRating) &&
    (s.gearboxType === 'bvm' || s.gearboxType === 'bva') &&
    isStr(s.startsAtLocal) && isStr(s.startsAtUtc) && isNum(s.durationMinutes) && isStr(s.bookingUrl)
}

/** Returns a cleaned snapshot, or null if the file is too broken to trust. */
export function sanitizeSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const discs: CoverageDisc[] = Array.isArray(o.discs) ? (o.discs as unknown[]).filter(validDisc) : []
  const locations: KnownLocation[] = Array.isArray(o.locations) ? (o.locations as unknown[]).filter(validLocation) : []
  let pairs: PairMeta[] = Array.isArray(o.pairs) ? (o.pairs as unknown[]).filter(validPair) : []
  let slots: Slot[] = Array.isArray(o.slots) ? (o.slots as unknown[]).filter(validSlot) : []

  // Drop pairs whose location is no longer in the registry, then orphan slots.
  const locIds = new Set(locations.map(l => l.id))
  pairs = pairs.filter(p => locIds.has(p.locationId))
  const pairKeys = new Set(pairs.map(p => `${p.locationId}:${p.teacherId}`))
  slots = slots.filter(s => pairKeys.has(`${s.locationId}:${s.teacherId}`))

  return { discs, locations, pairs, slots }
}

// ── Load / save (in-memory shared per gearbox) ───────────────────────────────────

function loadFromDisk(key: string): Snapshot | null {
  let raw: { version?: number; snapshot?: unknown }
  try {
    raw = JSON.parse(fs.readFileSync(zoneFile(key), 'utf8'))
  } catch { return null }  // missing or unparseable → miss
  if (!raw || raw.version !== CACHE_VERSION) return null  // incompatible format → miss
  return sanitizeSnapshot(raw.snapshot)
}

// One live snapshot object per gearbox, shared by all concurrent scans so they
// reuse each other's discovered points and fetched slots.
const memCache = new Map<string, Snapshot>()

/** Returns the shared in-memory snapshot for a key, loading it from disk once. */
export function getSnapshot(key: string): Snapshot {
  let s = memCache.get(key)
  if (!s) { s = loadFromDisk(key) ?? emptySnapshot(); memCache.set(key, s) }
  return s
}

export function saveZone(key: string, snap: Snapshot): void {
  memCache.set(key, snap)
  try {
    fs.mkdirSync(ZONES_DIR, { recursive: true })
    const file = zoneFile(key)
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, snapshot: snap }))
    fs.renameSync(tmp, file)  // atomic replace
  } catch (err) { console.warn('Failed to save zone cache:', (err as Error).message) }
}

// ── Staleness ────────────────────────────────────────────────────────────────────

function isoCutoff(ttlHours: number): string {
  return new Date(Date.now() - ttlHours * 3_600_000).toISOString()
}

/** A location needs a teacher-list (re)fetch if never fetched or past the TTL. */
export function teachersStale(loc: KnownLocation, ttlHours: number): boolean {
  return !loc.teachersFetchedAt || loc.teachersFetchedAt < isoCutoff(ttlHours)
}

/** A pair needs a slot (re)fetch if never fetched or past the TTL. */
export function slotsStale(pair: PairMeta, ttlHours: number): boolean {
  return !pair.slotsFetchedAt || pair.slotsFetchedAt < isoCutoff(ttlHours)
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export function evictPastSlots(s: Snapshot): number {
  const now = new Date().toISOString()
  const before = s.slots.length
  s.slots = s.slots.filter(slot => slot.startsAtUtc > now)
  return before - s.slots.length
}

/** Adds a newly-discovered meeting point to the registry (or refreshes its name/
 *  coords), preserving its teacher-fetch timestamp so we don't refetch teachers. */
export function upsertLocation(s: Snapshot, point: { id: string; name: string; lat: number; lng: number }): void {
  const existing = s.locations.find(l => l.id === point.id)
  if (existing) {
    existing.name = point.name; existing.lat = point.lat; existing.lng = point.lng
  } else {
    s.locations.push({ id: point.id, name: point.name, lat: point.lat, lng: point.lng, teachersFetchedAt: null })
  }
}

/** Records that an area's discovery completed, so future scans inside it skip
 *  re-discovery while the disc is fresh. Superseded discs (already contained by
 *  the new one) are pruned to keep the list small. */
export function recordDiscovery(
  s: Snapshot,
  center: { lat: number; lng: number },
  radiusKm: number,
  now: Date,
  contains: (disc: CoverageDisc, c: { lat: number; lng: number }, r: number) => boolean,
): void {
  s.discs = s.discs.filter(d => !contains({ lat: center.lat, lng: center.lng, radiusKm, at: now.toISOString() }, { lat: d.lat, lng: d.lng }, d.radiusKm))
  s.discs.push({ lat: center.lat, lng: center.lng, radiusKm, at: now.toISOString() })
}

/**
 * Reconciles ONE location's (location, teacher) pairs against a freshly-fetched
 * teacher list: updates existing pairs, adds new teachers, drops departed ones
 * (and their slots), and stamps the location's teacher-fetch time. Scoped to a
 * single location so it never wrongly prunes pairs elsewhere on the map.
 */
export function reconcileLocationPairs(
  s: Snapshot,
  loc: KnownLocation,
  teachers: Array<{ id: string; firstName: string; automaticCar: boolean; rating: number }>,
  now: Date,
): void {
  const wanted = new Set(teachers.map(t => t.id))
  // Drop this location's pairs whose teacher is gone, and their orphaned slots.
  s.pairs = s.pairs.filter(p => p.locationId !== loc.id || wanted.has(p.teacherId))
  s.slots = s.slots.filter(sl => sl.locationId !== loc.id || wanted.has(sl.teacherId))
  for (const t of teachers) {
    const existing = s.pairs.find(p => p.locationId === loc.id && p.teacherId === t.id)
    if (existing) {
      existing.teacherName = t.firstName
      existing.teacherRating = t.rating
      existing.teacherAutomaticCar = t.automaticCar
      existing.locationName = loc.name; existing.locationLat = loc.lat; existing.locationLng = loc.lng
    } else {
      s.pairs.push({
        locationId: loc.id, locationName: loc.name, locationLat: loc.lat, locationLng: loc.lng,
        teacherId: t.id, teacherName: t.firstName, teacherRating: t.rating, teacherAutomaticCar: t.automaticCar,
        slotsFetchedAt: null,
      })
    }
  }
  loc.teachersFetchedAt = now.toISOString()
}

export function replacePairSlots(s: Snapshot, locId: string, teacherId: string, newSlots: Slot[], now: Date): void {
  s.slots = s.slots.filter(sl => !(sl.locationId === locId && sl.teacherId === teacherId))
  s.slots.push(...newSlots)
  const pair = s.pairs.find(p => p.locationId === locId && p.teacherId === teacherId)
  if (pair) pair.slotsFetchedAt = now.toISOString()
}
