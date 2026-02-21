// src/hooks/useCurrentZone.ts
// Watches the player's GPS position and determines which zone they're in.
// Returns the zone object or null if they're outside all zones.

import { useState, useEffect } from 'react'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point, polygon } from '@turf/helpers'
import type { Zone } from '../lib/zones'
import { zones } from '../lib/zones'

export function useCurrentZone() {
  const [currentZone, setCurrentZone] = useState<Zone | null>(null)
  const [playerPosition, setPlayerPosition] = useState<{ lat: number; lng: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Ask the browser for live GPS updates
    if (!navigator.geolocation) {
      setError('Geolocation not supported')
      return
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude
        const lng = position.coords.longitude
        setPlayerPosition({ lat, lng })

        // Check which zone the player is inside
        const playerPoint = point([lng, lat]) // Turf uses [lng, lat] order

        const found = zones.find((zone) => {
          const poly = polygon(zone.boundary.coordinates)
          return booleanPointInPolygon(playerPoint, poly)
        })

        setCurrentZone(found || null)
      },
      (err) => {
        setError(err.message)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,      // Cache position for 10 seconds
        timeout: 15000,          // Wait up to 15 seconds for a fix
      }
    )

    // Stop watching when component unmounts
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  return { currentZone, playerPosition, error }
}