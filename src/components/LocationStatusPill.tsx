// =============================================================================
// Zone Rush — Location Status Pill
// Always-visible indicator showing whether GPS is working for the player.
// Tap it to see details and platform-specific troubleshooting steps.
// =============================================================================

import { useState } from 'react'
import type { LocationState } from '../hooks/useLocation'
import { locationStatusLabel } from '../hooks/useLocation'

interface Props {
  location: LocationState
  onRefresh?: () => void
}

const STATUS_COLORS: Record<LocationState['status'], string> = {
  good:         '#06D6A0',
  low_accuracy: '#FFD166',
  stale:        '#FFD166',
  acquiring:    '#888',
  prompt:       '#FFD166',
  denied:       '#EF476F',
  unavailable:  '#EF476F',
  error:        '#EF476F',
}

function detectPlatform(): 'ios' | 'android' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  return 'other'
}

export default function LocationStatusPill({ location, onRefresh }: Props) {
  const [showDetails, setShowDetails] = useState(false)
  const color = STATUS_COLORS[location.status]
  const label = locationStatusLabel(location.status)
  const platform = detectPlatform()

  return (
    <>
      <button
        onClick={() => setShowDetails(true)}
        style={{
          background: `${color}15`,
          border: `1px solid ${color}40`,
          borderRadius: 20,
          padding: '4px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: color,
            animation:
              location.status === 'acquiring'
                ? 'pulseDot 1.4s ease-in-out infinite'
                : 'none',
          }}
        />
        <span style={{ fontSize: '0.7rem', color, fontWeight: 600 }}>
          {label}
        </span>
      </button>

      <style>{`
        @keyframes pulseDot { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>

      {showDetails && (
        <div
          onClick={() => setShowDetails(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 250,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 500,
              background: '#0d0d0d',
              borderTop: `2px solid ${color}`,
              borderRadius: '14px 14px 0 0',
              padding: '20px 20px 32px',
              fontFamily: 'inherit',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 14,
              }}
            >
              <h3 style={{ color, fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {label}
              </h3>
              <button
                onClick={() => setShowDetails(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#555',
                  fontSize: '1.2rem',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>

            <DetailsBody location={location} platform={platform} />

            {onRefresh && (
              <button
                onClick={() => {
                  onRefresh()
                  setShowDetails(false)
                }}
                style={{
                  marginTop: 16,
                  width: '100%',
                  background: 'rgba(255,209,102,0.15)',
                  border: '1px solid rgba(255,209,102,0.3)',
                  color: '#FFD166',
                  padding: '12px',
                  borderRadius: 10,
                  fontSize: '0.88rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                🔄 Try again
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function DetailsBody({
  location,
  platform,
}: {
  location: LocationState
  platform: 'ios' | 'android' | 'other'
}) {
  const ageSeconds =
    location.timestamp != null
      ? Math.round((Date.now() - location.timestamp) / 1000)
      : null

  const Para = ({ children }: { children: React.ReactNode }) => (
    <p style={{ color: '#bbb', fontSize: '0.85rem', lineHeight: 1.6, marginBottom: 10 }}>
      {children}
    </p>
  )

  if (location.status === 'good' || location.status === 'low_accuracy') {
    return (
      <>
        <Para>
          {location.status === 'good'
            ? 'GPS is working. Submissions will record your location automatically.'
            : 'Your location is being picked up but accuracy is low. Walk a few steps or move away from tall buildings for a better fix.'}
        </Para>
        {ageSeconds != null && (
          <p style={{ color: '#555', fontSize: '0.75rem' }}>
            Last update: {ageSeconds}s ago
          </p>
        )}
      </>
    )
  }

  if (location.status === 'denied') {
    return (
      <>
        <Para>You denied location access. To submit challenges, you need to re-enable it.</Para>
        {platform === 'ios' && (
          <Para>
            <strong style={{ color: '#fff' }}>On iPhone:</strong> open Settings → Safari → Location →
            choose "Ask" or "Allow." If you installed Zone Rush to your home screen, also check
            Settings → Zone Rush → Location.
          </Para>
        )}
        {platform === 'android' && (
          <Para>
            <strong style={{ color: '#fff' }}>On Android:</strong> tap the lock icon in your browser's
            address bar → Permissions → Location → Allow. Then reload the page.
          </Para>
        )}
        {platform === 'other' && (
          <Para>Open your browser's site settings, allow location for this page, and reload.</Para>
        )}
      </>
    )
  }

  if (location.status === 'stale') {
    return (
      <Para>
        Your last location is over {Math.round((ageSeconds ?? 0) / 60)} minute(s) old. This usually
        means your phone went to sleep or the browser tab was backgrounded. Tap "Try again" to get a
        fresh fix.
      </Para>
    )
  }

  if (location.status === 'acquiring' || location.status === 'prompt') {
    return (
      <Para>
        Waiting for your first GPS fix. If you just opened the app, this can take 10–30 seconds the
        first time, especially indoors or near tall buildings.
      </Para>
    )
  }

  if (location.status === 'unavailable') {
    return <Para>This device doesn't expose a GPS API to the browser. You may be on desktop or in a restricted browser.</Para>
  }

  // error
  return (
    <>
      <Para>
        Couldn't get a location fix. This usually means the GPS chip is cold, the signal is blocked
        (subway, indoors), or another app is using GPS exclusively.
      </Para>
      <Para>Try walking outside, away from tall buildings, then tap "Try again."</Para>
      {location.errorMessage && (
        <p style={{ color: '#555', fontSize: '0.72rem', fontFamily: "'JetBrains Mono', monospace" }}>
          {location.errorMessage}
        </p>
      )}
    </>
  )
}