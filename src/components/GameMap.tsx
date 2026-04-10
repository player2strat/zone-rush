// =============================================================================
// Zone Rush — Game Map
//
// CHANGES:
// - Zone coloring: dashed border for "in progress" zones (visually distinct
//   from claimed). Claimed = solid heavy fill + thick border + ★ label.
// - Removed emoji from labels (unreliable in Mapbox fonts) — uses ★ instead
// - Subway stations: full NYC file (Manhattan + Brooklyn), MTA colors
// - Geolocate button: works across both Safari and Chrome on mobile
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

// Official MTA line colors
const MTA_LINE_COLORS: Record<string, string> = {
  A: '#0039A6', C: '#0039A6', E: '#0039A6',
  B: '#FF6319', D: '#FF6319', F: '#FF6319', M: '#FF6319',
  G: '#6CBE45',
  J: '#996633', Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A', Q: '#FCCC0A', R: '#FCCC0A', W: '#FCCC0A',
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
  '4': '#00933C', '5': '#00933C', '6': '#00933C',
  '7': '#B933AD',
  S: '#808183',
}

// Yellow lines need dark text
const MTA_LABEL_COLOR: Record<string, string> = {
  N: '#000000', Q: '#000000', R: '#000000', W: '#000000',
}

// --------------- Helpers ---------------

function parseLineField(raw: string): {
  label: string
  color: string
  textColor: string
} {
  const parts = raw
    .split('-')
    .map((p) => p.trim().replace(/\s+(Express|Shuttle|Local|Ltd\.?)$/i, '').trim())
    .filter((p) => p.length > 0)

  const seen = new Set<string>()
  const unique: string[] = []
  for (const p of parts) {
    if (!seen.has(p)) { seen.add(p); unique.push(p) }
  }

  const firstLine = unique[0] ?? 'S'
  const label = unique.join(' ')
  const color = MTA_LINE_COLORS[firstLine] ?? '#888888'
  const textColor = MTA_LABEL_COLOR[firstLine] ?? '#ffffff'
  return { label, color, textColor }
}

async function loadSubwayStations(): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const res = await fetch('/subway-stations.json')
    if (!res.ok) return null
    const raw = await res.json() as GeoJSON.FeatureCollection
    const features = raw.features.map((feature) => {
      const lineRaw: string = (feature.properties as any)?.LINE ?? 'S'
      const { label, color, textColor } = parseLineField(lineRaw)
      return {
        ...feature,
        properties: { ...(feature.properties as any), label, circle_color: color, text_color: textColor },
      }
    })
    return { ...raw, features }
  } catch {
    return null
  }
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

  // ---- Apply ownership + closure colors ----
  const applyOwnership = (
    ownership: Map<string, ZoneOwner> | undefined,
    closed: string[],
    threshold: number
  ) => {
    if (!map.current || !mapLoaded.current) return

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
      // dashed border for "in progress" zones — clearly different from claimed
      let borderDash: number[] | null = null

      if (isClosed && !owner) {
        // Closed, unclaimed → black out
        fillColor = '#000000'
        fillOpacity = 0.75
        borderColor = '#444444'
        borderWidth = 2
        labelColor = '#333333'
      } else if (isClosed && owner) {
        // Closed but owned → muted team color
        fillColor = owner.teamColor
        fillOpacity = 0.35
        borderColor = owner.teamColor
        borderWidth = 2
        labelColor = owner.teamColor
        labelText = `${zone.name}\nCLOSED`
      } else if (owner) {
        if (owner.claimed) {
          // Fully claimed → solid heavy fill + ★ label
          // ★ is a standard Unicode char Mapbox renders reliably
          fillColor = owner.teamColor
          fillOpacity = 0.50
          borderColor = owner.teamColor
          borderWidth = 4
          labelColor = owner.teamColor
          labelText = `★ ${zone.name}\nCLAIMED`
        } else if (owner.points >= midpoint) {
          // Past midpoint but not claimed → dashed border, light fill
          // The dashed border makes this clearly "in progress" vs claimed
          fillColor = owner.teamColor
          fillOpacity = 0.10
          borderColor = owner.teamColor
          borderWidth = 2.5
          borderDash = [4, 3]
          labelColor = owner.teamColor
        } else {
          // Has some points, below midpoint → barely visible tint
          fillColor = owner.teamColor
          fillOpacity = 0.04
          borderColor = owner.teamColor
          borderWidth = 1.5
          borderDash = [2, 4]
          labelColor = defaultColor
        }
      } else {
        // No points — transparent, white outline until a team earns points
        fillColor = defaultColor
        fillOpacity = 0
        borderColor = '#ffffff'
        borderWidth = 1.5
        labelColor = '#ffffff'
      }

      try {
        map.current!.setPaintProperty(`zone-fill-${zone.id}`, 'fill-color', fillColor)
        map.current!.setPaintProperty(`zone-fill-${zone.id}`, 'fill-opacity', fillOpacity)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-color', borderColor)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-width', borderWidth)
        map.current!.setPaintProperty(`zone-border-${zone.id}`, 'line-dasharray',
          borderDash ?? [1, 0] // [1,0] = solid
        )
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
        // Layers not yet added — safe to ignore during init
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

    map.current.on('load', async () => {
      if (!map.current) return
      mapLoaded.current = true

      // ---- Zone layers ----
      zones.forEach((zone) => {
        const color = ZONE_COLORS[zone.id] || '#ffffff'

        map.current!.addSource(`zone-${zone.id}`, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: { name: zone.name },
            geometry: zone.boundary as any,
          },
        })

        // Fill — transparent by default
        map.current!.addLayer({
          id: `zone-fill-${zone.id}`,
          type: 'fill',
          source: `zone-${zone.id}`,
          paint: { 'fill-color': color, 'fill-opacity': 0 },
        })

        // Border — solid by default, dasharray updated dynamically
        map.current!.addLayer({
          id: `zone-border-${zone.id}`,
          type: 'line',
          source: `zone-${zone.id}`,
          paint: {
            'line-color': '#ffffff',
            'line-width': 1.5,
            'line-dasharray': [1, 0],
          },
        })

        // GM-closed overlay (thick dashed gray)
        map.current!.addLayer({
          id: `zone-closed-${zone.id}`,
          type: 'line',
          source: `zone-${zone.id}`,
          layout: { visibility: 'none' },
          paint: { 'line-color': '#888888', 'line-width': 4, 'line-dasharray': [3, 3] },
        })

        // Zone label
        map.current!.addSource(`label-${zone.id}`, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: { name: zone.name },
            geometry: { type: 'Point', coordinates: [zone.center_lng, zone.center_lat] },
          },
        })

        map.current!.addLayer({
          id: `zone-label-${zone.id}`,
          type: 'symbol',
          source: `label-${zone.id}`,
          layout: {
            'text-field': zone.name,
            'text-size': compact ? 11 : 14,
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'text-max-width': 8,
          },
          paint: {
            'text-color': color,
            'text-halo-color': '#000000',
            'text-halo-width': 1,
          },
        })
      })

      // ---- MTA Subway Stations ----
      const stationData = await loadSubwayStations()
      if (stationData && map.current) {
        map.current.addSource('subway-stations', {
          type: 'geojson',
          data: stationData,
        })

        // Colored dot per station
        map.current.addLayer({
          id: 'subway-station-circles',
          type: 'circle',
          source: 'subway-stations',
          minzoom: 11,
          paint: {
            'circle-color': ['get', 'circle_color'],
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              11, 4, 13, 6, 15, 8,
            ],
            'circle-stroke-width': [
              'interpolate', ['linear'], ['zoom'],
              11, 1, 13, 1.5,
            ],
            'circle-stroke-color': '#0a0a0a',
            'circle-opacity': 0.95,
          },
        })

        // Line letter label — zoom 13+ only
        map.current.addLayer({
          id: 'subway-station-labels',
          type: 'symbol',
          source: 'subway-stations',
          minzoom: 13,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': [
              'interpolate', ['linear'], ['zoom'],
              13, 7, 15, 10,
            ],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false,
            'text-anchor': 'center',
          },
          paint: {
            'text-color': ['get', 'text_color'],
            'text-halo-width': 0,
          },
        })
      }

      // ---- Geolocate control ----
      if (!compact) {
        const geolocate = new mapboxgl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserHeading: true,
        })
        map.current!.addControl(geolocate)

        // Inject CSS once — targets both Safari and Chrome on mobile.
        // Safari on iOS renders .mapboxgl-ctrl-geolocate as a button inside
        // .mapboxgl-ctrl-group. Chrome wraps it the same way.
        // We override both the container and the SVG icon inside.
        if (!document.getElementById('zr-geolocate-style')) {
          const style = document.createElement('style')
          style.id = 'zr-geolocate-style'
          style.textContent = `
            /* Works in both Safari and Chrome on mobile */
            .mapboxgl-ctrl-top-right {
              top: 10px !important;
              right: 10px !important;
            }
            .mapboxgl-ctrl-group {
              background: transparent !important;
              box-shadow: none !important;
              border: none !important;
            }
            .mapboxgl-ctrl-geolocate {
              width: 48px !important;
              height: 48px !important;
              background: rgba(15,15,15,0.92) !important;
              border: 2px solid #FFD166 !important;
              border-radius: 12px !important;
              display: flex !important;
              align-items: center !important;
              justify-content: center !important;
              box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
            }
            /* Safari uses background-image on the span; Chrome uses SVG */
            .mapboxgl-ctrl-geolocate .mapboxgl-ctrl-icon {
              width: 26px !important;
              height: 26px !important;
              background-size: 26px 26px !important;
              filter: brightness(0) saturate(100%) invert(85%) sepia(80%)
                      saturate(400%) hue-rotate(5deg) brightness(105%) !important;
            }
            /* Active/tracking state — pulse yellow */
            .mapboxgl-ctrl-geolocate-active .mapboxgl-ctrl-icon,
            .mapboxgl-ctrl-geolocate-background .mapboxgl-ctrl-icon {
              filter: brightness(0) saturate(100%) invert(85%) sepia(80%)
                      saturate(600%) hue-rotate(5deg) brightness(110%) !important;
            }
          `
          document.head.appendChild(style)
        }
      }

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