// =============================================================================
// Foray — zoneGeometry tests
//
// Pure polygon math that live games depend on (splits, merges, gap detection,
// overlap tolerance). Run with `npm test`.
// =============================================================================

import { describe, it, expect } from 'vitest'
import area from '@turf/area'
import {
  splitPolygonByLine,
  touches,
  computeGap,
  computeOverlaps,
  parseGeometry,
  toPolyFeature,
  extractBoundaryGeometry,
} from './zoneGeometry'
import type { Zone } from '../types/game'

// ~0.1° square near the origin (≈ 123 km² — huge, so slivers are negligible)
const square = (x0: number, y0: number, size = 0.1): GeoJSON.Polygon => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]],
})

const zone = (id: string, geom: GeoJSON.Geometry): Zone => ({
  id,
  name: id,
  city: 'test',
  map_id: 'map_test',
  boundary: JSON.stringify(geom),
  center_lat: 0,
  center_lng: 0,
  culture_tags: [],
  transit_lines: [],
  landmarks: [],
} as unknown as Zone)

const pct = (part: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>, whole: GeoJSON.Polygon) =>
  area(part) / area({ type: 'Feature', properties: {}, geometry: whole })

describe('splitPolygonByLine', () => {
  const sq = square(0, 0)

  it('splits a square in half with a vertical line', () => {
    const r = splitPolygonByLine(sq, {
      type: 'LineString',
      coordinates: [[0.05, -0.02], [0.05, 0.12]],
    })
    expect(r).not.toBeNull()
    expect(pct(r!.a, sq)).toBeCloseTo(0.5, 2)
    expect(pct(r!.b, sq)).toBeCloseTo(0.5, 2)
  })

  it('extends a short interior line to a full cut', () => {
    const r = splitPolygonByLine(sq, {
      type: 'LineString',
      coordinates: [[0.03, 0.04], [0.03, 0.06]],
    })
    expect(r).not.toBeNull()
    expect(pct(r!.a, sq)).toBeCloseTo(0.3, 2)
    expect(pct(r!.b, sq)).toBeCloseTo(0.7, 2)
  })

  it('handles a multi-point zigzag cut', () => {
    const r = splitPolygonByLine(sq, {
      type: 'LineString',
      coordinates: [[0.02, -0.02], [0.04, 0.05], [0.06, 0.02], [0.08, 0.12]],
    })
    expect(r).not.toBeNull()
    expect(pct(r!.a, sq) + pct(r!.b, sq)).toBeCloseTo(1, 2)
  })

  it('handles a U-shaped cut (carves the notch)', () => {
    const r = splitPolygonByLine(sq, {
      type: 'LineString',
      coordinates: [[0.03, -0.02], [0.03, 0.05], [0.07, 0.05], [0.07, -0.02]],
    })
    expect(r).not.toBeNull()
    expect(pct(r!.a, sq)).toBeCloseTo(0.2, 2)
    expect(pct(r!.b, sq)).toBeCloseTo(0.8, 2)
  })

  it('returns null when the line misses the zone', () => {
    expect(splitPolygonByLine(sq, {
      type: 'LineString',
      coordinates: [[0.2, -0.1], [0.2, 0.3]],
    })).toBeNull()
  })

  it('returns null for a degenerate one-point line', () => {
    expect(splitPolygonByLine(sq, {
      type: 'LineString',
      coordinates: [[0.05, 0.05]],
    })).toBeNull()
  })
})

describe('touches', () => {
  it('true for squares sharing an edge', () => {
    expect(touches(square(0, 0), square(0.1, 0))).toBe(true)
  })
  it('true for overlapping squares', () => {
    expect(touches(square(0, 0), square(0.05, 0))).toBe(true)
  })
  it('false for separated squares', () => {
    expect(touches(square(0, 0), square(0.3, 0))).toBe(false)
  })
  it('false for non-polygon input', () => {
    expect(touches({ type: 'Point', coordinates: [0, 0] }, square(0, 0))).toBe(false)
  })
})

describe('computeGap', () => {
  const boundary = square(0, 0, 0.2)

  it('whole boundary when there are no zones', () => {
    const gap = computeGap(boundary, [])
    expect(gap).not.toBeNull()
    expect(pct(gap!, boundary)).toBeCloseTo(1, 3)
  })

  it('half the boundary when one half is covered', () => {
    const gap = computeGap(boundary, [zone('a', {
      type: 'Polygon',
      coordinates: [[[0, 0], [0.1, 0], [0.1, 0.2], [0, 0.2], [0, 0]]],
    })])
    expect(gap).not.toBeNull()
    expect(pct(gap!, boundary)).toBeCloseTo(0.5, 2)
  })

  it('null when zones fully cover the boundary', () => {
    const gap = computeGap(boundary, [
      zone('a', { type: 'Polygon', coordinates: [[[0, 0], [0.1, 0], [0.1, 0.2], [0, 0.2], [0, 0]]] }),
      zone('b', { type: 'Polygon', coordinates: [[[0.1, 0], [0.2, 0], [0.2, 0.2], [0.1, 0.2], [0.1, 0]]] }),
    ])
    expect(gap).toBeNull()
  })
})

describe('computeOverlaps', () => {
  it('reports a genuine overlap with its area', () => {
    const overlaps = computeOverlaps(square(0, 0), [zone('b', square(0.05, 0))])
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0].id).toBe('b')
    expect(overlaps[0].areaSqM).toBeGreaterThan(1000)
  })

  it('ignores a shared border (zero-area intersection)', () => {
    expect(computeOverlaps(square(0, 0), [zone('b', square(0.1, 0))])).toHaveLength(0)
  })

  it('ignores non-overlapping zones', () => {
    expect(computeOverlaps(square(0, 0), [zone('b', square(0.5, 0))])).toHaveLength(0)
  })
})

describe('parseGeometry', () => {
  it('parses a JSON string boundary', () => {
    expect(parseGeometry(JSON.stringify(square(0, 0)))?.type).toBe('Polygon')
  })
  it('passes through an already-parsed object', () => {
    expect(parseGeometry(square(0, 0))?.type).toBe('Polygon')
  })
  it('null for junk', () => {
    expect(parseGeometry('not json')).toBeNull()
    expect(parseGeometry({ type: 'Point', coordinates: [0, 0] })).toBeNull()
    expect(parseGeometry(null)).toBeNull()
  })
})

describe('toPolyFeature / extractBoundaryGeometry', () => {
  it('wraps polygons and rejects other geometry', () => {
    expect(toPolyFeature(square(0, 0))?.type).toBe('Feature')
    expect(toPolyFeature({ type: 'Point', coordinates: [0, 0] })).toBeNull()
  })

  it('unions a FeatureCollection into one outline', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: square(0, 0) },
        { type: 'Feature', properties: {}, geometry: square(0.1, 0) },
      ],
    }
    const out = extractBoundaryGeometry(fc)
    expect(out).not.toBeNull()
    // Two adjacent squares union into a single polygon outline
    expect(out!.type).toBe('Polygon')
  })
})
