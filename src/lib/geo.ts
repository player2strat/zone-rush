// =============================================================================
// Zone Rush — Geo Utilities
// Point-in-polygon check for GPS proximity warnings
// =============================================================================

/**
 * Ray-casting algorithm to check if a point (lat, lng) is inside a GeoJSON polygon.
 * GeoJSON coordinates are [lng, lat] — this function expects (lat, lng) as inputs
 * and handles the coordinate flip internally.
 */
export function isPointInPolygon(
  lat: number,
  lng: number,
  coordinates: number[][][]
): boolean {
  // coordinates[0] is the outer ring: [[lng, lat], [lng, lat], ...]
  const ring = coordinates[0]
  if (!ring || ring.length < 3) return false

  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [lngI, latI] = ring[i]
    const [lngJ, latJ] = ring[j]

    const intersect =
      lngI > lng !== lngJ > lng &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Approximate distance in meters between two lat/lng points (Haversine formula).
 * Used for "how far outside the zone" estimates.
 */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000 // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}