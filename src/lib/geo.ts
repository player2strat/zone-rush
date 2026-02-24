// =============================================================================
// Zone Rush — Geo Utilities
// Point-in-polygon detection for zone identification
// =============================================================================

/**
 * Ray-casting algorithm to check if a point is inside a polygon.
 * GeoJSON coordinates are [longitude, latitude] — this handles that.
 */
function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    // GeoJSON stores coordinates as [lng, lat], so ring[i][0] = lng, ring[i][1] = lat
    const xi = ring[i][1], yi = ring[i][0]
    const xj = ring[j][1], yj = ring[j][0]

    if ((yi > lng) !== (yj > lng) && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Detect which zone a GPS coordinate falls inside.
 * Returns the zone ID, or empty string if not in any zone.
 */
export function detectZone(
  lat: number | null,
  lng: number | null,
  zones: Array<{ id: string; boundary: { type: string; coordinates: number[][][] } }>
): string {
  if (lat === null || lng === null) return ''

  for (const zone of zones) {
    // Handle both Polygon and MultiPolygon types
    if (zone.boundary.type === 'MultiPolygon') {
      // MultiPolygon: coordinates is number[][][][]
      const multiCoords = zone.boundary.coordinates as unknown as number[][][][]
      for (const polygon of multiCoords) {
        if (pointInRing(lat, lng, polygon[0])) {
          return zone.id
        }
      }
    } else {
      // Polygon: coordinates is number[][][], first ring is the outer boundary
      if (pointInRing(lat, lng, zone.boundary.coordinates[0])) {
        return zone.id
      }
    }
  }

  return ''
}