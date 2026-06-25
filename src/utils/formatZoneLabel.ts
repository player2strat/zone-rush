// src/utils/formatZoneLabel.ts
//
// Safely format a zone ID for display. Handles null/undefined — out-of-zone
// submissions (approved when a player is outside any zone) can produce
// zone_scores with no zone_id — plus both the Brooklyn (zone_district_NN) and
// Manhattan (zone_mn_*) ID formats. Previously this lived inline as
// `zone_id.replace('zone_district_', 'D')`, which threw on a null zone_id and
// blanked whichever page rendered it.
export function formatZoneLabel(zoneId: string | null | undefined): string {
  if (!zoneId) return 'No zone'
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