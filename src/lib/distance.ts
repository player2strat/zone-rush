// =============================================================================
// Foray — Distance covered (pure helpers)
//
// Each phone keeps a running total of meters walked, computed from consecutive
// GPS fixes, and writes ONLY that number to the team doc (member_distances).
// No trail is ever stored — this respects the no-tracking rule. A team's
// distance is the highest member total: teammates move together, and the
// highest is the phone that stayed awake the most.
//
// Displayed in miles (one decimal), or feet under a tenth of a mile.
// =============================================================================

import { distanceMeters } from './geo'

export interface Fix {
  lat: number
  lng: number
  accuracy: number | null   // meters; null = unknown
  timestamp: number         // ms
}

/** Fixes worse than this are ignored entirely (urban GPS drift). */
export const MAX_ACCURACY_M = 60
/** Faster than this between fixes is a GPS glitch, not a taxi (≈100 mph). */
export const MAX_SPEED_MPS = 45
/** A move shorter than this (or than the fix accuracy) is treated as standing still. */
export const MIN_MOVE_M = 15

export const METERS_PER_MILE = 1609.344
export const FEET_PER_METER = 3.28084

/**
 * Applies one fix to a running total. Returns the new total and the fix to
 * compare against next time. Small moves keep the OLD anchor so slow walking
 * still accumulates once it clears the noise floor; a rejected fix (bad
 * accuracy) is dropped; a glitch (impossible speed) re-anchors on the new
 * fix without adding distance.
 */
export function advanceFix(
  totalMeters: number,
  prev: Fix | null,
  next: Fix,
): { totalMeters: number; anchor: Fix | null } {
  if (next.accuracy != null && next.accuracy > MAX_ACCURACY_M) {
    return { totalMeters, anchor: prev }
  }
  if (!prev) return { totalMeters, anchor: next }
  const d = distanceMeters(prev.lat, prev.lng, next.lat, next.lng)
  const noise = Math.max(MIN_MOVE_M, prev.accuracy ?? 0, next.accuracy ?? 0)
  if (d < noise) return { totalMeters, anchor: prev }
  const dtSec = (next.timestamp - prev.timestamp) / 1000
  if (dtSec > 0 && d / dtSec > MAX_SPEED_MPS) return { totalMeters, anchor: next }
  return { totalMeters: totalMeters + d, anchor: next }
}

/** A team's distance: the highest member total (see header). */
export function teamDistanceMeters(memberDistances: Record<string, number> | undefined | null): number {
  if (!memberDistances) return 0
  let max = 0
  for (const v of Object.values(memberDistances)) {
    if (typeof v === 'number' && v > max) max = v
  }
  return max
}

/** "4.3" + "mi", or "850" + "ft" under a tenth of a mile. */
export function formatDistanceParts(meters: number): { value: string; unit: 'mi' | 'ft' } {
  const miles = meters / METERS_PER_MILE
  if (miles < 0.1) {
    const feet = Math.round(meters * FEET_PER_METER / 10) * 10
    return { value: String(feet), unit: 'ft' }
  }
  return { value: miles.toFixed(1), unit: 'mi' }
}

export function formatDistance(meters: number): string {
  const p = formatDistanceParts(meters)
  return `${p.value} ${p.unit}`
}
