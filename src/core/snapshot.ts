import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Gearbox } from './search'

// ── Domain types ──────────────────────────────────────────────────────────────

/** One (location, teacher) pair discovered during structure discovery. */
export interface PairMeta {
  locationId: string
  locationName: string
  locationLat: number
  locationLng: number
  teacherId: string
  teacherName: string
  teacherRating: number
  teacherAutomaticCar: boolean
  /** ISO timestamp of the last availability fetch; null = never fetched. */
  slotsFetchedAt: string | null
}

/** An available driving-lesson time slot. */
export interface Slot {
  locationId: string
  locationName: string
  locationLat: number
  locationLng: number
  teacherId: string
  teacherName: string
  teacherRating: number
  teacherAutomaticCar: boolean
  gearboxType: Gearbox
  /** Local Paris time as ISO string, e.g. "2024-06-01T09:00:00". Used for display and time-filter matching. */
  startsAtLocal: string
  /** UTC ISO string. Used for booking and past-slot eviction. */
  startsAtUtc: string
  durationMinutes: number
  bookingUrl: string
}

/**
 * A per-zone cache snapshot stored in IndexedDB.
 *
 * A "zone" is a (lat, lng, radius_km) tuple representing a search area.
 * The snapshot has two TTL layers:
 *   - structureFetchedAt: when the list of (location, teacher) pairs was last refreshed (24h TTL).
 *   - slotsFetchedAt per pair: when availabilities were last fetched for that pair (1h TTL).
 */
export interface Snapshot {
  /** ISO timestamp of the last structure discovery, or null if never fetched. */
  structureFetchedAt: string | null
  /** Known (location, teacher) pairs in this zone. */
  pairs: PairMeta[]
  /** All cached availability slots across all pairs. */
  slots: Slot[]
}

// ── IndexedDB persistence ─────────────────────────────────────────────────────

interface EVSSchema extends DBSchema {
  snapshots: { key: string; value: Snapshot }
}

// Lazy singleton — opened once, reused for all reads and writes.
let db: IDBPDatabase<EVSSchema> | null = null

async function getDb(): Promise<IDBPDatabase<EVSSchema>> {
  if (!db) {
    db = await openDB<EVSSchema>('evs-app', 1, {
      upgrade(database) {
        database.createObjectStore('snapshots')
      },
    })
  }
  return db
}

export async function loadSnapshot(zoneKey: string): Promise<Snapshot | null> {
  return (await (await getDb()).get('snapshots', zoneKey)) ?? null
}

export async function saveSnapshot(zoneKey: string, s: Snapshot): Promise<void> {
  await (await getDb()).put('snapshots', s, zoneKey)
}

export function emptySnapshot(): Snapshot {
  return { structureFetchedAt: null, pairs: [], slots: [] }
}

// ── Staleness checks ──────────────────────────────────────────────────────────

/** Returns true if the pair list hasn't been refreshed within `ttlHours`. */
export function structureIsStale(s: Snapshot, ttlHours: number): boolean {
  if (!s.structureFetchedAt) return true
  const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString()
  return s.structureFetchedAt < cutoff
}

/** Returns the set of "locationId:teacherId" keys whose slots are older than `ttlHours`. */
export function stalePairs(s: Snapshot, ttlHours: number): Set<string> {
  const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString()
  const stale = new Set<string>()
  for (const p of s.pairs) {
    if (!p.slotsFetchedAt || p.slotsFetchedAt < cutoff) {
      stale.add(`${p.locationId}:${p.teacherId}`)
    }
  }
  return stale
}

// ── Mutations (all mutate `s` in-place for performance) ───────────────────────

/**
 * Removes slots that have already started. Returns the count of evicted slots.
 * Mutates `s.slots` in place — call before any read to keep the cache clean.
 */
export function evictPastSlots(s: Snapshot): number {
  const now = new Date().toISOString()
  const before = s.slots.length
  s.slots = s.slots.filter(slot => slot.startsAtUtc > now)
  return before - s.slots.length
}

/**
 * Reconciles the pair list with freshly discovered pairs:
 * - Adds pairs not previously known.
 * - Removes pairs that are no longer returned by the API (teacher/location no longer active).
 * - Updates `structureFetchedAt`.
 *
 * Returns `[added, removed]` counts (informational — can be used for progress display).
 * Mutates `s` in place.
 */
export function updateStructure(
  s: Snapshot,
  discovered: PairMeta[],
  now: Date,
): [added: number, removed: number] {
  const existingKeys = new Set(s.pairs.map(p => `${p.locationId}:${p.teacherId}`))
  const discoveredKeys = new Set(discovered.map(p => `${p.locationId}:${p.teacherId}`))

  let added = 0
  for (const p of discovered) {
    if (!existingKeys.has(`${p.locationId}:${p.teacherId}`)) {
      s.pairs.push(p)
      added++
    }
  }

  // Count pairs that exist locally but are no longer in the discovered set.
  const sizeBefore = s.pairs.length
  s.pairs = s.pairs.filter(p => discoveredKeys.has(`${p.locationId}:${p.teacherId}`))
  const removed = sizeBefore - s.pairs.length  // added pairs always survive the filter

  s.structureFetchedAt = now.toISOString()
  return [added, removed]
}

/**
 * Replaces all cached slots for a given (location, teacher) pair with fresh data
 * and records when the fetch happened.
 * Mutates `s` in place.
 */
export function replacePairSlots(
  s: Snapshot,
  locId: string,
  teacherId: string,
  newSlots: Slot[],
  now: Date,
): void {
  s.slots = s.slots.filter(sl => !(sl.locationId === locId && sl.teacherId === teacherId))
  s.slots.push(...newSlots)

  const pair = s.pairs.find(p => p.locationId === locId && p.teacherId === teacherId)
  if (pair) pair.slotsFetchedAt = now.toISOString()
}
