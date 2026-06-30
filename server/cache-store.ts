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

export function loadZone(key: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(zoneFile(key), 'utf8')) as Snapshot
  } catch { return null }
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

/** Clears all cached zones. Returns the number of zone files removed. */
export function clearAllZones(): number {
  let n = 0
  try {
    for (const f of fs.readdirSync(ZONES_DIR)) {
      if (f.endsWith('.json')) { fs.rmSync(path.join(ZONES_DIR, f)); n++ }
    }
  } catch { /* dir may not exist yet */ }
  return n
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
