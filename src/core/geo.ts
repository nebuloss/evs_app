/** Minimal geodesy utilities for the search-radius filter. */

export interface Point { lat: number; lng: number }
export interface Place extends Point { name: string }
export interface SearchPlace extends Place { radiusKm: number }

/** Great-circle distance between two points using the haversine formula. Returns kilometres. */
export function haversineKm(a: Point, b: Point): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng
  return R * 2 * Math.asin(Math.sqrt(h))
}

/** Returns true if point `p` falls within the search radius of `place`. */
export function contains(place: SearchPlace, p: Point): boolean {
  return haversineKm(place, p) <= place.radiusKm
}
