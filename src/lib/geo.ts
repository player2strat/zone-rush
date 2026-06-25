// =============================================================================
// Zone Rush — Geo Utilities
// Point-in-polygon check for GPS proximity warnings
// =============================================================================

/**
 * Ray-casting algorithm to check if a point (lat, lng) is inside a GeoJSON polygon.
 * GeoJSON coordinates are [lng, lat] — this function expects (lat, lng) as inputs
 * and handles the coordinate flip internally.
 */
// Ray-cast a point against a SINGLE linear ring: [[lng, lat], [lng, lat], ...].
// This is the core test; the exported functions below decide which rings to feed it.
function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
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
 * Check if a point (lat, lng) is inside a GeoJSON polygon.
 * GeoJSON coordinates are [lng, lat]; this expects (lat, lng) and flips internally.
 *
 * Handles BOTH geometry shapes, inferred from nesting depth, because callers
 * pass `boundary.coordinates` without the geometry `type`:
 *   - Polygon:      coordinates = [ ring ][ point ][ lng, lat ]   → coordinates[0] is a ring
 *   - MultiPolygon: coordinates = [ polygon ][ ring ][ point ][ lng, lat ] → coordinates[0] is a polygon
 *
 * A point counts as inside if it falls in the OUTER RING of ANY polygon.
 * (Inner rings / holes are ignored — none of our zone data uses them, and
 * treating holes as solid is the safe, permissive choice for GPS proximity.)
 */
export function isPointInPolygon(
  lat: number,
  lng: number,
  coordinates: any
): boolean {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false

  // Distinguish Polygon from MultiPolygon by how deep the nesting goes.
  // For a Polygon,      coordinates[0][0] is a [lng, lat] pair → a number.
  // For a MultiPolygon, coordinates[0][0] is a ring (array of pairs) → an array.
  const isMultiPolygon = Array.isArray(coordinates[0]?.[0]?.[0])

  if (isMultiPolygon) {
    // Test the outer ring of each polygon; inside ANY = inside the zone.
    for (const polygon of coordinates as number[][][][]) {
      if (pointInRing(lat, lng, polygon[0])) return true
    }
    return false
  }

  // Polygon: outer ring is coordinates[0].
  return pointInRing(lat, lng, (coordinates as number[][][])[0])
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
/**
 * Detect which zone a player is currently in based on GPS coordinates.
 * Returns the zone ID or null if outside all zones.
 */
export function detectZone(
  lat: number | null,
  lng: number | null,
  zones: { id: string; boundary: { coordinates: number[][][] } }[]
): string | null {
  if (!lat || !lng) return null
  for (const zone of zones) {
    if (isPointInPolygon(lat, lng, zone.boundary.coordinates)) {
      return zone.id
    }
  }
  return null
}