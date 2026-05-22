// =============================================================================
// Zone Rush — useLocation Hook
// Single source of truth for player GPS state.
//
// Why this exists:
// Previously, SubmitProof, GamePage, and useCurrentZone each independently
// called watchPosition/getCurrentPosition. On mobile, multiple concurrent
// geolocation subscribers can starve each other and cause silent failures.
// This hook consolidates GPS into one watcher that any component can read.
//
// What it exposes:
// - status:      one of unavailable/prompt/denied/acquiring/good/low_accuracy/stale/error
// - lat/lng:     latest coordinates (or null if no fix yet)
// - accuracy:    horizontal accuracy in meters (smaller = better)
// - timestamp:   when the last fix arrived
// - refresh():   force a fresh getCurrentPosition (use at submission time)
//
// Key behaviors:
// - Starts in high-accuracy mode. If that times out, falls back to low-accuracy
//   automatically so the player still sees their general location.
// - Uses the Permissions API when available, so we can tell "denied" apart
//   from "still trying" instead of treating both as failure.
// - Marks the fix "stale" if it's older than max_age_seconds (default 120).
// =============================================================================

import { useEffect, useState, useRef, useCallback } from 'react'

export type LocationStatus =
  | 'unavailable'   // device has no geolocation API at all
  | 'prompt'        // permission not yet asked
  | 'denied'        // user denied — must re-enable in OS settings
  | 'acquiring'     // permission granted, waiting for first fix
  | 'good'          // fresh position with good accuracy
  | 'low_accuracy'  // fresh position but accuracy is poor
  | 'stale'         // had a fix but it's too old now
  | 'error'         // some other error (cold GPS, blocked signal, etc.)

export interface LocationState {
  status: LocationStatus
  lat: number | null
  lng: number | null
  accuracy: number | null
  timestamp: number | null
  errorMessage: string | null
}

export interface LocationConfig {
  max_age_seconds: number
  max_accuracy_meters: number      // accuracy worse than this = unusable
  warn_accuracy_meters: number     // accuracy worse than this = warning
  high_accuracy_timeout_ms: number
  low_accuracy_timeout_ms: number
}

// Defaults — these can be overridden per game by passing config from
// game.settings.gps. We don't require a Firestore migration to use this.
export const DEFAULT_LOCATION_CONFIG: LocationConfig = {
  max_age_seconds: 120,
  max_accuracy_meters: 200,
  warn_accuracy_meters: 50,
  high_accuracy_timeout_ms: 12000,
  low_accuracy_timeout_ms: 15000,
}

const STALE_CHECK_INTERVAL_MS = 5000

export function useLocation(config: Partial<LocationConfig> = {}) {
  const cfg: LocationConfig = { ...DEFAULT_LOCATION_CONFIG, ...config }

  const [state, setState] = useState<LocationState>({
    status: 'acquiring',
    lat: null,
    lng: null,
    accuracy: null,
    timestamp: null,
    errorMessage: null,
  })

  // Refs used by callbacks that shouldn't re-trigger effects on every render
  const watchIdRef = useRef<number | null>(null)
  const usingLowAccuracyRef = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  // Map an accuracy value (meters) to the right status
  const statusForAccuracy = useCallback((accuracy: number): LocationStatus => {
    if (accuracy > cfg.warn_accuracy_meters) return 'low_accuracy'
    return 'good'
  }, [cfg.warn_accuracy_meters])

  const handleSuccess = useCallback((pos: GeolocationPosition) => {
    setState({
      status: statusForAccuracy(pos.coords.accuracy),
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      timestamp: Date.now(),
      errorMessage: null,
    })
  }, [statusForAccuracy])

  const startWatch = useCallback((highAccuracy: boolean) => {
    if (!('geolocation' in navigator)) return

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    usingLowAccuracyRef.current = !highAccuracy

    const timeout = highAccuracy
      ? cfg.high_accuracy_timeout_ms
      : cfg.low_accuracy_timeout_ms

    watchIdRef.current = navigator.geolocation.watchPosition(
      handleSuccess,
      (err) => {
        // If high-accuracy timed out or signal unavailable,
        // fall back to low-accuracy rather than giving up entirely.
        if (
          highAccuracy &&
          (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE)
        ) {
          startWatch(false)
          return
        }

        let status: LocationStatus = 'error'
        if (err.code === err.PERMISSION_DENIED) status = 'denied'

        setState((prev) => ({ ...prev, status, errorMessage: err.message }))
      },
      { enableHighAccuracy: highAccuracy, timeout, maximumAge: 0 }
    )
  }, [cfg.high_accuracy_timeout_ms, cfg.low_accuracy_timeout_ms, handleSuccess])

  // Set up the watcher on mount, tear it down on unmount
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setState((s) => ({ ...s, status: 'unavailable' }))
      return
    }

    let cancelled = false

    async function setup() {
      // Check permission state up front using the Permissions API.
      // This is what lets us distinguish "denied" from "still trying."
      try {
        if ('permissions' in navigator) {
          const result = await navigator.permissions.query({
            name: 'geolocation' as PermissionName,
          })
          if (cancelled) return

          if (result.state === 'denied') {
            setState((s) => ({
              ...s,
              status: 'denied',
              errorMessage: 'Location permission denied',
            }))
            return
          }
          if (result.state === 'prompt') {
            setState((s) => ({ ...s, status: 'prompt' }))
          }

          // React to runtime permission changes (rare but possible).
          result.addEventListener('change', () => {
            if (result.state === 'denied') {
              setState((s) => ({ ...s, status: 'denied' }))
              if (watchIdRef.current !== null) {
                navigator.geolocation.clearWatch(watchIdRef.current)
                watchIdRef.current = null
              }
            } else if (result.state === 'granted') {
              startWatch(true)
            }
          })
        }
      } catch {
        // Permissions API not supported (older Safari) — just try anyway.
      }

      if (cancelled) return
      startWatch(true)
    }

    setup()

    return () => {
      cancelled = true
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current)
        watchIdRef.current = null
      }
    }
  }, [startWatch])

  // Mark the fix stale if no updates come in for a while
  useEffect(() => {
    const interval = setInterval(() => {
      const s = stateRef.current
      if (!s.timestamp) return
      const ageSeconds = (Date.now() - s.timestamp) / 1000
      if (ageSeconds > cfg.max_age_seconds) {
        setState((prev) =>
          prev.status === 'good' || prev.status === 'low_accuracy'
            ? { ...prev, status: 'stale' }
            : prev
        )
      }
    }, STALE_CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [cfg.max_age_seconds])

  // refresh() — force a fresh fix on demand. Use this at submission time
  // so the GPS we record is from the moment of submit, not from 90s ago
  // when the user opened the modal.
  const refresh = useCallback((): Promise<LocationState> => {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) {
        const s: LocationState = { ...stateRef.current, status: 'unavailable' }
        setState(s)
        resolve(s)
        return
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const s: LocationState = {
            status: statusForAccuracy(pos.coords.accuracy),
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: Date.now(),
            errorMessage: null,
          }
          setState(s)
          resolve(s)
        },
        (err) => {
          let status: LocationStatus = 'error'
          if (err.code === err.PERMISSION_DENIED) status = 'denied'
          const s: LocationState = {
            ...stateRef.current,
            status,
            errorMessage: err.message,
          }
          setState(s)
          resolve(s)
        },
        {
          enableHighAccuracy: !usingLowAccuracyRef.current,
          timeout: cfg.high_accuracy_timeout_ms,
          maximumAge: 0,
        }
      )
    })
  }, [cfg.high_accuracy_timeout_ms, statusForAccuracy])

  return { ...state, refresh, config: cfg }
}

// Convenience: is the current state OK to submit with?
// Submissions are blocked unless GPS is good or merely low-accuracy.
export function isLocationSubmittable(state: LocationState): boolean {
  return state.status === 'good' || state.status === 'low_accuracy'
}

// Convenience: human-readable label for a given status.
export function locationStatusLabel(status: LocationStatus): string {
  switch (status) {
    case 'good':         return 'Location on'
    case 'low_accuracy': return 'Low accuracy'
    case 'stale':        return 'Location stale'
    case 'acquiring':    return 'Getting location…'
    case 'prompt':       return 'Tap to enable'
    case 'denied':       return 'Location off'
    case 'unavailable':  return 'GPS unavailable'
    case 'error':        return 'Location error'
  }
}