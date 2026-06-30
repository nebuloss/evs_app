/**
 * Persistent per-zone slot cache (server side, dependency-free).
 *
 * One JSON file per zone under CACHE_DIR. A "zone" is (lat, lng, radius, gearbox).
 * Two TTL layers mirror the old client cache:
 *   - structureFetchedAt: when the (location, teacher) pair list was refreshed.
 *   - slotsFetchedAt per pair: when that pair's availabilities were fetched.
 *
 * Survives appliance updates (install.sh never removes CACHE_DIR).
 */

import fs from 'fs'
import path from 'path'
import type { Snapshot, PairMeta, Slot, Gearbox } from '../src/core/types'

const CACHE_DIR = process.env.EVS_CACHE_DIR || path.join(process.cwd(), 'cache')
const ZONES_DIR = path.join(CACHE_DIR, 'zones')

// ── Keys & files ─────────────────────────────────────────────────────────────────

/** Zone key, coordinates rounded to ~1 m so the same place reuses the same entry. */
export function zoneKey(lat: number, lng: number, radiusKm: number, gearbox: Gearbox): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)},${radiusKm},${gearbox}`
}

function zoneFile(key: string): string {
  return path.join(ZONES_DIR, Buffer.from(key).toString('base64url') + '.json')
}

export function emptySnapshot(): Snapshot {
  return { structureFetchedAt: null, pairs: [], slots: [] }
}

/**
 * Loads and SANITIZES a zone snapshot. The cache self-heals: malformed JSON or a
 * structurally-broken file is treated as a miss (→ re-scan), and individual
 * corrupt pairs/slots and orphan slots (whose pair no longer exists) are dropped
 * rather than served. Clients never clear the cache; bad data is repaired here.
 */
export function loadZone(key: string): Snapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(zoneFile(key), 'utf8'))
  } catch { return null }  // missing or unparseable → miss
  return sanitizeSnapshot(raw)
}

const isStr = (x: unknown): x is string => typeof x === 'string'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

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
  const sfa = o.structureFetchedAt
  if (!(sfa === null || sfa === undefined || isStr(sfa))) return null  // core field corrupt → miss

  const pairs: PairMeta[] = Array.isArray(o.pairs) ? (o.pairs as unknown[]).filter(validPair) : []
  let slots: Slot[] = Array.isArray(o.slots) ? (o.slots as unknown[]).filter(validSlot) : []
  // Drop orphan slots whose (location, teacher) pair is no longer in the structure.
  const pairKeys = new Set(pairs.map(p => `${p.locationId}:${p.teacherId}`))
  slots = slots.filter(s => pairKeys.has(`${s.locationId}:${s.teacherId}`))

  return { structureFetchedAt: isStr(sfa) ? sfa : null, pairs, slots }
}

export function saveZone(key: string, snap: Snapshot): void {
  try {
    fs.mkdirSync(ZONES_DIR, { recursive: true })
    const file = zoneFile(key)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(snap))
    fs.renameSync(tmp, file)  // atomic replace
  } catch (err) { console.warn('Failed to save zone cache:', (err as Error).message) }
}

// ── Staleness & mutations (ported from the old client snapshot.ts) ───────────────

export function structureIsStale(s: Snapshot, ttlHours: number): boolean {
  if (!s.structureFetchedAt) return true
  const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString()
  return s.structureFetchedAt < cutoff
}

export function stalePairs(s: Snapshot, ttlHours: number): Set<string> {
  const cutoff = new Date(Date.now() - ttlHours * 3_600_000).toISOString()
  const stale = new Set<string>()
  for (const p of s.pairs) {
    if (!p.slotsFetchedAt || p.slotsFetchedAt < cutoff) stale.add(`${p.locationId}:${p.teacherId}`)
  }
  return stale
}

export function evictPastSlots(s: Snapshot): number {
  const now = new Date().toISOString()
  const before = s.slots.length
  s.slots = s.slots.filter(slot => slot.startsAtUtc > now)
  return before - s.slots.length
}

export function updateStructure(s: Snapshot, discovered: PairMeta[], now: Date): [number, number] {
  const existing = new Set(s.pairs.map(p => `${p.locationId}:${p.teacherId}`))
  const discoveredKeys = new Set(discovered.map(p => `${p.locationId}:${p.teacherId}`))
  let added = 0
  for (const p of discovered) {
    if (!existing.has(`${p.locationId}:${p.teacherId}`)) { s.pairs.push(p); added++ }
  }
  const before = s.pairs.length
  s.pairs = s.pairs.filter(p => discoveredKeys.has(`${p.locationId}:${p.teacherId}`))
  const removed = before - s.pairs.length
  s.structureFetchedAt = now.toISOString()
  return [added, removed]
}

export function replacePairSlots(s: Snapshot, locId: string, teacherId: string, newSlots: Slot[], now: Date): void {
  s.slots = s.slots.filter(sl => !(sl.locationId === locId && sl.teacherId === teacherId))
  s.slots.push(...newSlots)
  const pair = s.pairs.find(p => p.locationId === locId && p.teacherId === teacherId)
  if (pair) pair.slotsFetchedAt = now.toISOString()
}
