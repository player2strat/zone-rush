// =============================================================================
// Foray — ZonePickerMap
//
// The small map on Create Game's "Map & Zones" step. It shows every zone of
// the chosen map as an outline and fills in the ones the GM has selected.
// Tapping a zone on the map selects or unselects it, same as its row in the
// list below, so the two always match.
//
// Kept apart from GameMap on purpose: that one carries game-only layers (team
// colors, locks, players, subway) that would only get in the way here.
// =============================================================================

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { BRAND } from '../lib/brand'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
const HAS_MAPBOX_TOKEN = Boolean(import.meta.env.VITE_MAPBOX_TOKEN)

export interface PickerZone {
  id: string
  name: string
  boundary: GeoJSON.Polygon | GeoJSON.MultiPolygon | null
}

interface Props {
  zones: PickerZone[]
  selected: string[]
  onToggle: (zoneId: string) => void
  height?: number
}

const SOURCE = 'picker-zones'

function toCollection(zones: PickerZone[], selected: string[]): GeoJSON.FeatureCollection {
  const on = new Set(selected)
  return {
    type: 'FeatureCollection',
    features: zones
      .filter((z) => z.boundary)
      .map((z) => ({
        type: 'Feature',
        geometry: z.boundary!,
        properties: { id: z.id, name: z.name, selected: on.has(z.id) },
      })),
  }
}

/** Every [lng, lat] pair in a Polygon or MultiPolygon. */
function points(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): GeoJSON.Position[] {
  return g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates.flat(2)
}

export default function ZonePickerMap({ zones, selected, onToggle, height = 380 }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const loaded = useRef(false)
  // Latest values for the map's own event handlers, which are set up once.
  const latest = useRef({ zones, selected, onToggle })
  useEffect(() => {
    latest.current = { zones, selected, onToggle }
  })

  // Create the map once.
  useEffect(() => {
    if (!container.current || !HAS_MAPBOX_TOKEN) return
    const m = new mapboxgl.Map({
      container: container.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-73.95, 40.7],
      zoom: 11,
      attributionControl: false,
    })
    map.current = m
    m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')

    m.on('load', () => {
      m.addSource(SOURCE, { type: 'geojson', data: toCollection(latest.current.zones, latest.current.selected) })
      m.addLayer({
        id: 'picker-fill',
        type: 'fill',
        source: SOURCE,
        paint: {
          'fill-color': ['case', ['get', 'selected'], BRAND.green, BRAND.ink],
          'fill-opacity': ['case', ['get', 'selected'], 0.35, 0.04],
        },
      })
      m.addLayer({
        id: 'picker-line',
        type: 'line',
        source: SOURCE,
        paint: {
          'line-color': ['case', ['get', 'selected'], BRAND.greenDeep, BRAND.ink],
          'line-opacity': ['case', ['get', 'selected'], 0.9, 0.35],
          'line-width': ['case', ['get', 'selected'], 2, 1],
        },
      })
      m.addLayer({
        id: 'picker-label',
        type: 'symbol',
        source: SOURCE,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': 11,
          'text-max-width': 8,
        },
        paint: {
          'text-color': ['case', ['get', 'selected'], BRAND.greenDeep, BRAND.ink],
          'text-opacity': ['case', ['get', 'selected'], 1, 0.5],
          'text-halo-color': BRAND.paper,
          'text-halo-width': 1.5,
        },
      })

      m.on('click', 'picker-fill', (e) => {
        const id = e.features?.[0]?.properties?.id
        if (typeof id === 'string') latest.current.onToggle(id)
      })
      m.on('mouseenter', 'picker-fill', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'picker-fill', () => { m.getCanvas().style.cursor = '' })

      loaded.current = true
      fit(m, latest.current.zones)
    })

    // Keep the drawing matched to its box (phone rotated, window resized).
    const sizeWatch = new ResizeObserver(() => m.resize())
    sizeWatch.observe(container.current)

    return () => {
      sizeWatch.disconnect()
      loaded.current = false
      m.remove()
      map.current = null
    }
  }, [])

  // Fill in / fade out as the selection changes.
  useEffect(() => {
    const m = map.current
    if (!m || !loaded.current) return
    ;(m.getSource(SOURCE) as mapboxgl.GeoJSONSource | undefined)?.setData(toCollection(zones, selected))
  }, [zones, selected])

  // A different map (a new set of zones): zoom to fit it.
  const zonesKey = zones.map((z) => z.id).join(',')
  useEffect(() => {
    if (map.current && loaded.current) fit(map.current, latest.current.zones)
  }, [zonesKey])

  if (!HAS_MAPBOX_TOKEN) return null
  return (
    <div
      ref={container}
      style={{ width: '100%', height, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', marginBottom: 14 }}
    />
  )
}

function fit(m: mapboxgl.Map, zones: PickerZone[]) {
  const bounds = new mapboxgl.LngLatBounds()
  for (const z of zones) {
    if (!z.boundary) continue
    for (const [lng, lat] of points(z.boundary)) bounds.extend([lng, lat])
  }
  if (!bounds.isEmpty()) m.fitBounds(bounds, { padding: 16, duration: 0, maxZoom: 15 })
}
