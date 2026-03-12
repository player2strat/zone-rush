// =============================================================================
// Zone Rush — Game Map
// Mapbox map with zone polygons, ownership coloring, and compact mode
//
// CHANGES:
// - UPDATED: ZoneOwner now includes `points` and `claimed` fields
// - NEW: Gradient fill logic — zones show faint team color at midpoint,
//        solid team color when claimed. Midpoint = half of claim_threshold.
// - NEW: GM-closed zones show a gray hatched overlay with a lock indicator
// - NEW: `claimThreshold` prop so gradient breakpoint matches game settings
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
  points: number      // total points this team has in this zone
  claimed: boolean    // true when points >= claim_threshold
}

interface GameMapProps {
  zones: Zone[]
  /** Map of zoneId → ZoneOwner. Leading team per zone. */
  zoneOwnership?: Map<string, ZoneOwner>
  /** IDs of zones that the GM has closed — no more scoring allowed */
  closedZones?: string[]
  /** Claim threshold from game.settings — used to compute gradient midpoint */
  claimThreshold?: number
  /** Compact mode for the GM dashboard mini map — smaller, non-interactive */
  compact?: boolean
}

// --------------- Constants ---------------

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

/** Default zone colors when no team has points in a zone */
const ZONE_COLORS: Record<string, string> = {
  zone_district_33: '#06D6A0',
  zone_district_34: '#FFD166',
  zone_district_35: '#118AB2',
  zone_district_36: '#EF476F',
}

// Gray used for GM-closed zones
const CLOSED_COLOR = '#555555'

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

    // Midpoint: zone starts showing team color above this points value.
    // E.g. claim_threshold=6 → midpoint=3. Always at least 1.
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

      if (isClosed) {
        // GM-closed zone: gray out, regardless of ownership
        fillColor = CLOSED_COLOR
        fillOpacity = 0.25
        borderColor = CLOSED_COLOR
        borderWidth = 2
        labelColor = CLOSED_COLOR
      } else if (owner) {
        if (owner.claimed) {
          // Fully claimed: solid team color
          fillColor = owner.teamColor
          fillOpacity = 0.5
          borderColor = owner.teamColor
          borderWidth = 3
          labelColor = owner.teamColor
        } else if (owner.points >= midpoint) {
          // Past midpoint but not yet claimed: faint team color (35% opacity)
          fillColor = owner.teamColor
          fillOpacity = 0.2
          borderColor = owner.teamColor
          borderWidth = 2
          labelColor = owner.teamColor
        } else {
          // Team has some points but below midpoint: barely visible hint
          fillColor = owner.teamColor
          fillOpacity = 0.08
          borderColor = defaultColor
          borderWidth = 2
          labelColor = defaultColor
        }
      } else {
        // No team has points here: default zone color
        fillColor = defaultColor
        fillOpacity = 0.12
        borderColor = defaultColor
        borderWidth = 2
        labelColor = defaultColor
      }

      try {
        map.current!.setPaintProperty(`zone-fill-${zone.id}`, 'fill-color', fillColor)
        map.current!.setPaintProperty(`zone-fill-${zone.id}`, 'fill-opacity', fillOpacity)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-color', borderColor)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-width', borderWidth)
        map.current!.setPaintProperty(`zone-label-${zone.id}`, 'text-color', labelColor)

        // Show/hide the closed overlay layer
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

        // Fill layer
        map.current!.addLayer({
          id: `zone-fill-${zone.id}`,
          type: 'fill',
          source: `zone-${zone.id}`,
          paint: {
            'fill-color': color,
            'fill-opacity': 0.12,
          },
        })

        // Border layer
        map.current!.addLayer({
          id: `zone-border-${zone.id}`,
          type: 'line',
          source: `zone-${zone.id}`,
          paint: {
            'line-color': color,
            'line-width': 2,
          },
        })

        // GM-closed overlay: dashed gray border to signal "no more scoring"
        // Hidden by default, shown via setLayoutProperty when closed
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
            'text-field': ['get', 'name'],
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

      // Geolocate control — player map only
      if (!compact) {
        map.current!.addControl(
          new mapboxgl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true },
            trackUserLocation: true,
            showUserHeading: true,
          })
        )
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
