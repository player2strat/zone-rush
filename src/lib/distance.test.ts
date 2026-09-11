import { describe, it, expect } from 'vitest'
import {
  advanceFix, teamDistanceMeters, formatDistance, formatDistanceParts, METERS_PER_MILE, type Fix,
} from './distance'

// ~111 m per 0.001° of latitude.
const fix = (lat: number, lng: number, accuracy: number | null, t: number): Fix =>
  ({ lat, lng, accuracy, timestamp: t })

describe('advanceFix', () => {
  it('anchors on the first good fix without adding distance', () => {
    const r = advanceFix(0, null, fix(40.7, -73.99, 10, 0))
    expect(r.totalMeters).toBe(0)
    expect(r.anchor?.lat).toBe(40.7)
  })

  it('adds a real walk', () => {
    const a = fix(40.7000, -73.99, 10, 0)
    const b = fix(40.7010, -73.99, 10, 60_000)   // ~111 m in a minute
    const r = advanceFix(0, a, b)
    expect(r.totalMeters).toBeGreaterThan(105)
    expect(r.totalMeters).toBeLessThan(118)
    expect(r.anchor).toBe(b)
  })

  it('ignores drift smaller than the noise floor but keeps the old anchor', () => {
    const a = fix(40.7000, -73.99, 10, 0)
    const b = fix(40.70005, -73.99, 10, 15_000)  // ~5.5 m
    const r = advanceFix(0, a, b)
    expect(r.totalMeters).toBe(0)
    expect(r.anchor).toBe(a)
  })

  it('slow walking accumulates once it clears the floor', () => {
    let total = 0
    let anchor: Fix | null = fix(40.7000, -73.99, 10, 0)
    for (let i = 1; i <= 10; i++) {
      const r = advanceFix(total, anchor, fix(40.7 + i * 0.00005, -73.99, 10, i * 15_000))
      total = r.totalMeters; anchor = r.anchor
    }
    // 10 × 5.5 m ≈ 55 m walked; counted in ~16 m hops → close to 55
    expect(total).toBeGreaterThan(40)
    expect(total).toBeLessThan(60)
  })

  it('drops fixes with poor accuracy and keeps the anchor', () => {
    const a = fix(40.7000, -73.99, 10, 0)
    const bad = fix(40.7100, -73.99, 250, 30_000)
    const r = advanceFix(100, a, bad)
    expect(r.totalMeters).toBe(100)
    expect(r.anchor).toBe(a)
  })

  it('treats an impossible jump as a glitch: no distance, re-anchor', () => {
    const a = fix(40.7000, -73.99, 10, 0)
    const teleport = fix(40.7500, -73.99, 10, 10_000)   // ~5.5 km in 10 s
    const r = advanceFix(100, a, teleport)
    expect(r.totalMeters).toBe(100)
    expect(r.anchor).toBe(teleport)
  })

  it('counts a subway hop as a straight line when the speed is plausible', () => {
    const a = fix(40.7000, -73.99, 10, 0)
    const b = fix(40.7500, -73.99, 10, 8 * 60_000)      // ~5.5 km in 8 min ≈ 11.6 m/s
    const r = advanceFix(0, a, b)
    expect(r.totalMeters).toBeGreaterThan(5000)
  })
})

describe('teamDistanceMeters', () => {
  it('takes the highest member total', () => {
    expect(teamDistanceMeters({ a: 1200, b: 4300, c: 0 })).toBe(4300)
    expect(teamDistanceMeters(undefined)).toBe(0)
    expect(teamDistanceMeters({})).toBe(0)
  })
})

describe('formatting', () => {
  it('uses miles with one decimal', () => {
    expect(formatDistance(4.3 * METERS_PER_MILE)).toBe('4.3 mi')
    expect(formatDistanceParts(2 * METERS_PER_MILE)).toEqual({ value: '2.0', unit: 'mi' })
  })
  it('switches to feet under a tenth of a mile, rounded to 10 ft', () => {
    expect(formatDistance(0.05 * METERS_PER_MILE)).toBe('260 ft')
    expect(formatDistance(0)).toBe('0 ft')
    expect(formatDistance(0.1 * METERS_PER_MILE)).toBe('0.1 mi')
  })
})
