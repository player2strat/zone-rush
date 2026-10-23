import { describe, it, expect } from 'vitest'
import { formatZoneLabel } from './formatZoneLabel'

const zones = [
  { id: 'zone_mn_mn33', name: 'East Harlem' },
  { id: 'zone_district_34', name: 'Bushwick' },
]

describe('formatZoneLabel', () => {
  it('uses the zone name when the zone is in the list', () => {
    expect(formatZoneLabel('zone_mn_mn33', zones)).toBe('East Harlem')
    expect(formatZoneLabel('zone_district_34', zones)).toBe('Bushwick')
  })

  it('falls back to a short label when zones are missing or not loaded yet', () => {
    expect(formatZoneLabel('zone_mn_mn33')).toBe('MN33')
    expect(formatZoneLabel('zone_district_35', zones)).toBe('D35')
    expect(formatZoneLabel('zone_mn_centralpark', [])).toBe('Central Park')
  })

  it('handles submissions with no zone', () => {
    expect(formatZoneLabel(null, zones)).toBe('No zone')
    expect(formatZoneLabel(undefined)).toBe('No zone')
  })
})
