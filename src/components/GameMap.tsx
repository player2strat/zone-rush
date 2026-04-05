// =============================================================================
// Zone Rush — Game Map
// Mapbox map with zone polygons, ownership coloring, and compact mode
//
// CHANGES:
// - Unclaimed zones are fully transparent (no fill) — only border shows
// - Light team color at 50% of claim_threshold
// - Heavy shade + lock emoji when claimed
// - Blacked out when GM-closed with no team owner
// - Subway stations layer added
// - Geolocate button styled larger and more visible
// =============================================================================

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

// --------------- Types ---------------

interface Zone {
  id: string
  district_number: number
  name: string
  city: string
  boundary: { type: string; coordinates: number[][][] }
  center_lat: number
  center_lng: number
  culture_tags: string[]
  transit_lines: string[]
  landmarks: string[]
  difficulty_rating: number
}

export interface ZoneOwner {
  teamColor: string
  teamName: string
  points: number
  claimed: boolean
}

interface GameMapProps {
  zones: Zone[]
  zoneOwnership?: Map<string, ZoneOwner>
  closedZones?: string[]
  claimThreshold?: number
  compact?: boolean
}

// --------------- Constants ---------------

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const ZONE_COLORS: Record<string, string> = {
  zone_district_33: '#06D6A0',
  zone_district_34: '#FFD166',
  zone_district_35: '#118AB2',
  zone_district_36: '#EF476F',
}

// --------------- Component ---------------

export default function GameMap({
  zones,
  zoneOwnership,
  closedZones = [],
  claimThreshold = 6,
  compact = false,
}: GameMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const mapLoaded = useRef(false)

  // ---- Apply ownership + closure colors to map layers ----
  const applyOwnership = (
    ownership: Map<string, ZoneOwner> | undefined,
    closed: string[],
    threshold: number
  ) => {
    if (!map.current || !mapLoaded.current) return

    // Midpoint: zone starts showing team color above this points value
    const midpoint = Math.max(1, Math.floor(threshold / 2))

    zones.forEach((zone) => {
      const isClosed = closed.includes(zone.id)
      const owner = ownership?.get(zone.id)
      const defaultColor = ZONE_COLORS[zone.id] || '#ffffff'

      let fillColor: string
      let fillOpacity: number
      let borderColor: string
      let borderWidth: number
      let labelColor: string
      let labelText: string = zone.name

      if (isClosed && !owner) {
        // GM-closed with no owner → black out completely
        fillColor = '#000000'
        fillOpacity = 0.75
        borderColor = '#444444'
        borderWidth = 2
        labelColor = '#333333'
        labelText = zone.name
      } else if (isClosed && owner) {
        // GM-closed but a team owns it — keep their color, slightly muted
        fillColor = owner.teamColor
        fillOpacity = 0.35
        borderColor = owner.teamColor
        borderWidth = 2
        labelColor = owner.teamColor
        labelText = `🔒 ${zone.name}`
      } else if (owner) {
        if (owner.claimed) {
          // Fully claimed: solid team color + lock emoji
          fillColor = owner.teamColor
          fillOpacity = 0.45
          borderColor = owner.teamColor
          borderWidth = 3
          labelColor = owner.teamColor
          labelText = `🔒 ${zone.name}`
        } else if (owner.points >= midpoint) {
          // Past midpoint: light team color tint
          fillColor = owner.teamColor
          fillOpacity = 0.18
          borderColor = owner.teamColor
          borderWidth = 2
          labelColor = owner.teamColor
          labelText = zone.name
        } else {
          // Below midpoint: barely visible hint
          fillColor = owner.teamColor
          fillOpacity = 0.06
          borderColor = owner.teamColor
          borderWidth = 1.5
          labelColor = defaultColor
          labelText = zone.name
        }
      } else {
        // No team has any points — fully transparent fill, just show border
        fillColor = defaultColor
        fillOpacity = 0
        borderColor = defaultColor
        borderWidth = 1.5
        labelColor = defaultColor
        labelText = zone.name
      }

      try {
        map.current!.setPaintProperty(`zone-fill-${zone.id}`, 'fill-color', fillColor)
        map.current!.setPaintProperty(`zone-fill-${zone.id}`, 'fill-opacity', fillOpacity)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-color', borderColor)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-width', borderWidth)
        map.current!.setPaintProperty(`zone-label-${zone.id}`, 'text-color', labelColor)
        map.current!.setLayoutProperty(`zone-label-${zone.id}`, 'text-field', labelText)

        if (map.current!.getLayer(`zone-closed-${zone.id}`)) {
          map.current!.setLayoutProperty(
            `zone-closed-${zone.id}`,
            'visibility',
            isClosed ? 'visible' : 'none'
          )
        }
      } catch {
        // Layers may not exist yet during initial load
      }
    })
  }

  // ---- Initialize Mapbox ----
  useEffect(() => {
    if (map.current || !mapContainer.current) return

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [-73.95, 40.7],
      zoom: compact ? 11.5 : 12,
      interactive: !compact,
      attributionControl: !compact,
    })

    map.current.on('load', () => {
      if (!map.current) return
      mapLoaded.current = true

      zones.forEach((zone) => {
        const color = ZONE_COLORS[zone.id] || '#ffffff'

        // Zone polygon source
        map.current!.addSource(`zone-${zone.id}`, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: { name: zone.name },
            geometry: zone.boundary as any,
          },
        })

        // Fill layer — transparent by default
        map.current!.addLayer({
          id: `zone-fill-${zone.id}`,
          type: 'fill',
          source: `zone-${zone.id}`,
          paint: {
            'fill-color': color,
            'fill-opacity': 0,
          },
        })

        // Border layer
        map.current!.addLayer({
          id: `zone-border-${zone.id}`,
          type: 'line',
          source: `zone-${zone.id}`,
          paint: {
            'line-color': color,
            'line-width': 1.5,
          },
        })

        // GM-closed overlay: dashed gray border
        map.current!.addLayer({
          id: `zone-closed-${zone.id}`,
          type: 'line',
          source: `zone-${zone.id}`,
          layout: { visibility: 'none' },
          paint: {
            'line-color': '#888888',
            'line-width': 4,
            'line-dasharray': [3, 3],
          },
        })

        // Zone label source (point at center)
        map.current!.addSource(`label-${zone.id}`, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: { name: zone.name },
            geometry: {
              type: 'Point',
              coordinates: [zone.center_lng, zone.center_lat],
            },
          },
        })

        // Label layer
        map.current!.addLayer({
          id: `zone-label-${zone.id}`,
          type: 'symbol',
          source: `label-${zone.id}`,
          layout: {
            'text-field': zone.name,
            'text-size': compact ? 11 : 14,
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          },
          paint: {
            'text-color': color,
            'text-halo-color': '#000000',
            'text-halo-width': 1,
          },
        })
      })

      // Subway stations — from Mapbox Streets composite source
      try {
        map.current!.addLayer({
          id: 'subway-stations',
          type: 'circle',
          source: 'composite',
          'source-layer': 'transit_stop',
          paint: {
            'circle-radius': 4,
            'circle-color': '#b0b0b0',
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#111111',
            'circle-opacity': 0.85,
          },
        })
      } catch {
        // Transit layer unavailable in this style — not a blocker
      }

      // Geolocate control — player map only
      if (!compact) {
        const geolocate = new mapboxgl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserHeading: true,
        })
        map.current!.addControl(geolocate)

        // Make the locate button more visible
        if (!document.getElementById('zr-geolocate-style')) {
          const style = document.createElement('style')
          style.id = 'zr-geolocate-style'
          style.textContent = `
            .mapboxgl-ctrl-geolocate {
              width: 44px !important;
              height: 44px !important;
              background: rgba(20,20,20,0.92) !important;
              border: 1.5px solid #FFD166 !important;
              border-radius: 10px !important;
            }
            .mapboxgl-ctrl-geolocate .mapboxgl-ctrl-icon {
              width: 44px !important;
              height: 44px !important;
              filter: invert(1) brightness(1.5) sepia(1) hue-rotate(10deg) saturate(5) !important;
            }
            .mapboxgl-ctrl-group {
              background: transparent !important;
              box-shadow: none !important;
            }
          `
          document.head.appendChild(style)
        }
      }

      // Apply initial state
      applyOwnership(zoneOwnership, closedZones, claimThreshold)
    })

    return () => {
      map.current?.remove()
      map.current = null
      mapLoaded.current = false
    }
  }, [])

  // ---- React to ownership / closure changes ----
  useEffect(() => {
    applyOwnership(zoneOwnership, closedZones, claimThreshold)
  }, [zoneOwnership, closedZones, claimThreshold])

  // ---- Render ----
  return (
    <div
      ref={mapContainer}
      style={{
        width: '100%',
        height: compact ? '100%' : '100vh',
        borderRadius: compact ? 10 : 0,
      }}
    />
  )
}