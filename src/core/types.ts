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

/** A per-zone cache snapshot (structure + slots) shared by client and server. */
export interface Snapshot {
  /** ISO timestamp of the last structure discovery, or null if never fetched. */
  structureFetchedAt: string | null
  /** Known (location, teacher) pairs in this zone. */
  pairs: PairMeta[]
  /** All cached availability slots across all pairs. */
  slots: Slot[]
}
