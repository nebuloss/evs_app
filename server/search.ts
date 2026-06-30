/**
 * Zone-scan orchestration: turns a (lat, lng, radius, gearbox) request into a
 * cached list of slots, doing discovery + teacher + slot fetching only when the
 * cache is stale. Concurrent identical requests are de-duplicated (single-flight)
 * so N clients searching the same area trigger ONE scan and share its progress.
 */

import type { PairMeta, Slot, Gearbox } from '../src/core/types'
import {
  ensureAuth, discoverMeetingPoints, getLocationTeachers, getTeacherAvailabilities,
  haversineKm, EvsHttpError,
} from './evs-service'
import {
  zoneKey, loadZone, saveZone, emptySnapshot, structureIsStale, stalePairs,
  evictPastSlots, updateStructure, replacePairSlots,
} from './cache-store'

const CONCURRENCY = Number(process.env.EVS_MAX_CONCURRENCY ?? 16)
const STRUCTURE_TTL_HOURS = 24

export interface ProgressEvent { phase: 'structure' | 'slots' | 'done'; message: string; current: number; total: number }
export interface ScanResult { slots: Slot[]; structureFetchedAt: string | null; cached: boolean }
export interface ScanParams { lat: number; lng: number; radiusKm: number; gearbox: Gearbox; ttlMin: number }

type Emit = (ev: ProgressEvent) => void

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

async function scan(key: string, p: ScanParams, emit: Emit): Promise<ScanResult> {
  await ensureAuth()
  const snap = loadZone(key) ?? emptySnapshot()
  evictPastSlots(snap)
  const center = { lat: p.lat, lng: p.lng }

  const structureStale = structureIsStale(snap, STRUCTURE_TTL_HOURS) || snap.pairs.length === 0
  if (structureStale) {
    emit({ phase: 'structure', message: 'Scanning area…', current: 0, total: 0 })
    const { points, failures } = await discoverMeetingPoints(
      center, p.radiusKm, p.gearbox,
      found => emit({ phase: 'structure', message: `Scanning area… ${found} meeting point(s)`, current: 0, total: 0 }),
    )
    if (points.length === 0 && failures > 0) {
      throw new EvsHttpError(502, `Couldn't reach EVS to scan the area (${failures} request(s) failed)`)
    }
    const inRadius = points.filter(pt => haversineKm(center, pt) <= p.radiusKm && pt.nextAvailability !== null)

    let loaded = 0
    const teacherLists = await mapLimit(inRadius, CONCURRENCY, async point => {
      let teachers: Awaited<ReturnType<typeof getLocationTeachers>> = []
      try { teachers = await getLocationTeachers(point.id, p.gearbox) } catch { /* skip point */ }
      loaded++
      emit({ phase: 'structure', message: `Loading teachers… ${loaded}/${inRadius.length} locations`, current: loaded, total: inRadius.length })
      return { point, teachers }
    })
    const discovered: PairMeta[] = []
    for (const { point, teachers } of teacherLists) {
      for (const t of teachers) {
        discovered.push({
          locationId: point.id, locationName: point.name, locationLat: point.lat, locationLng: point.lng,
          teacherId: t.id, teacherName: t.firstName, teacherRating: t.rating, teacherAutomaticCar: t.automaticCar,
          slotsFetchedAt: null,
        })
      }
    }
    updateStructure(snap, discovered, new Date())
    saveZone(key, snap)
  }

  const ttlHours = p.ttlMin / 60
  const stale = [...stalePairs(snap, ttlHours)]
  let fetched = 0
  const now = new Date()
  await mapLimit(stale, CONCURRENCY, async pairKey => {
    const [locId, teacherId] = pairKey.split(':')
    const pair = snap.pairs.find(pr => pr.locationId === locId && pr.teacherId === teacherId)
    if (!pair) return
    let slots: Slot[] = []
    try { slots = await getTeacherAvailabilities(locId, teacherId, p.gearbox, pair) } catch { /* no slots */ }
    replacePairSlots(snap, locId, teacherId, slots, now)
    fetched++
    emit({ phase: 'slots', message: 'Fetching slots…', current: fetched, total: stale.length })
  })
  if (stale.length) saveZone(key, snap)

  emit({ phase: 'done', message: `Found ${snap.slots.length} slot(s).`, current: 0, total: 0 })
  return { slots: snap.slots, structureFetchedAt: snap.structureFetchedAt, cached: !structureStale && stale.length === 0 }
}

// ── Single-flight: dedupe concurrent identical scans, share their progress ────────

interface Job { promise: Promise<ScanResult>; listeners: Set<Emit>; last: ProgressEvent | null }
const jobs = new Map<string, Job>()

export async function getZoneSlots(p: ScanParams, emit: Emit): Promise<ScanResult> {
  const key = zoneKey(p.lat, p.lng, p.radiusKm, p.gearbox)
  const existing = jobs.get(key)
  if (existing) {
    if (existing.last) emit(existing.last)  // catch the joiner up to current progress
    existing.listeners.add(emit)
    try { return await existing.promise } finally { existing.listeners.delete(emit) }
  }
  const job: Job = { listeners: new Set([emit]), last: null, promise: Promise.resolve({ slots: [], structureFetchedAt: null, cached: false }) }
  job.promise = scan(key, p, ev => { job.last = ev; for (const l of job.listeners) l(ev) }).finally(() => jobs.delete(key))
  jobs.set(key, job)
  try { return await job.promise } finally { job.listeners.delete(emit) }
}
