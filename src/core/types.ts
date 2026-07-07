/**
 * Shared domain types used by BOTH the browser client and the Express server.
 *
 * Keep this module dependency-free (no idb, no DOM, no Node APIs) so it can be
 * compiled into the server bundle (tsconfig.server.json) and imported in the
 * client via the @/ alias. The wire format of the /api/slots endpoints is these
 * types as plain JSON.
 */

export type Gearbox = 'bvm' | 'bva'

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

/** A meeting point (pickup location) known to the server for a gearbox. The set
 *  of points and their teachers is stable, so it's cached for a long time and
 *  reused across every overlapping search area. */
export interface KnownLocation {
  id: string
  name: string
  lat: number
  lng: number
  /** ISO timestamp of the last teacher-list fetch; null = teachers never fetched. */
  teachersFetchedAt: string | null
}

/** A geographic disc whose meeting-point discovery has completed. While the disc
 *  is fresh, a scan whose area falls entirely inside it skips the (expensive)
 *  quadtree re-discovery and reuses the already-known points. */
export interface CoverageDisc {
  lat: number
  lng: number
  radiusKm: number
  /** ISO timestamp when discovery of this disc completed. */
  at: string
}

/**
 * Shared slot cache for ONE gearbox, grown incrementally and keyed by gearbox
 * (NOT by search area) so overlapping searches reuse everything already found.
 * Two cache lifetimes, per the data's volatility:
 *   - structure (locations + their teachers) is stable → long TTL, rarely refetched;
 *   - slots (availabilities) are volatile → short TTL.
 */
export interface Snapshot {
  /** Areas whose meeting-point discovery is complete (skip re-discovery while fresh). */
  discs: CoverageDisc[]
  /** Registry of known meeting points for this gearbox, across all searched areas. */
  locations: KnownLocation[]
  /** Known (location, teacher) pairs. */
  pairs: PairMeta[]
  /** All cached availability slots across all pairs. */
  slots: Slot[]
}
