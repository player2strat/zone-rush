// src/utils/formatZoneLabel.ts
//
// Turn a zone ID into something a person can read. Pass the game's zones
// (from loadGameZones) to get the zone's real name, e.g. "Bushwick". Without
// them, or for an ID that isn't in the list, it falls back to a short label
// built from the ID itself (Brooklyn zone_district_NN -> D34, Manhattan
// zone_mn_mn25 -> MN25).
//
// Handles null/undefined: out-of-zone submissions (approved when a player is
// outside any zone) can produce zone_scores with no zone_id. Previously this
// lived inline as `zone_id.replace('zone_district_', 'D')`, which threw on a
// null zone_id and blanked whichever page rendered it.
export function formatZoneLabel(
  zoneId: string | null | undefined,
  zones?: ReadonlyArray<{ id: string; name?: string }>,
): string {
  if (!zoneId) return 'No zone'
  const name = zones?.find((z) => z.id === zoneId)?.name
  if (name) return name
  if (zoneId.startsWith('zone_district_')) {
    return 'D' + zoneId.replace('zone_district_', '')
  }
  if (zoneId.startsWith('zone_mn_')) {
    // zone_mn_mn25 -> MN25 ; zone_mn_centralpark -> Central Park
    const tail = zoneId.replace('zone_mn_', '')
    if (tail === 'centralpark') return 'Central Park'
    return tail.toUpperCase()
  }
  return zoneId
}
