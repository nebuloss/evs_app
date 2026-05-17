/**
 * Client-side slot filtering.
 *
 * All filtering is done in-browser against the cached snapshot — no extra network
 * requests are made when the user changes gearbox, rating, or time filters.
 */

import { contains, type SearchPlace } from './geo'
import { matchesTime, type TimeSpec } from './time'
import type { Slot } from './snapshot'

export type Gearbox = 'bvm' | 'bva'

export interface SearchOptions {
  place: SearchPlace
  time: TimeSpec | null  // null = no time filter
  gearbox: Gearbox
  minRating: number      // 0 = no filter
}

/** Filters and sorts slots according to the given search options. */
export function applySearch(opts: SearchOptions, slots: Slot[]): Slot[] {
  return slots
    .filter(s => {
      if (s.gearboxType !== opts.gearbox) return false
      if (s.teacherRating < opts.minRating) return false
      if (!contains(opts.place, { lat: s.locationLat, lng: s.locationLng })) return false
      if (opts.time && !matchesTime(opts.time, { startsAtLocal: s.startsAtLocal })) return false
      return true
    })
    .sort((a, b) => a.startsAtLocal.localeCompare(b.startsAtLocal))
}
