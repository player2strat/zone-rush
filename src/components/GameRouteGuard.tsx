// =============================================================================
// Zone Rush — GameRouteGuard
//
// Wraps routes that depend on game state. Reads the canonical expected path
// from useGameRoute. If the user is on the wrong URL for the game's current
// state, redirects them once (via <Navigate replace>). If they're on the
// right URL, renders the children.
//
// This is the ONLY component that navigates based on game state. LobbyPage,
// GamePage, and GMDashboard no longer redirect themselves — they just render.
// Eliminates races between multiple components trying to navigate at once.
// =============================================================================

import type { ReactNode } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useGameRoute } from '../hooks/useGameRoute'

interface GameRouteGuardProps {
  /** The path pattern this route handles, e.g. '/lobby' or '/game' */
  expectedPathPrefix: string
  children: ReactNode
}

export default function GameRouteGuard({
  expectedPathPrefix,
  children,
}: GameRouteGuardProps) {
  const { gameId } = useParams<{ gameId: string }>()
  const route = useGameRoute(gameId)

  if (route.loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0a0a0a',
          color: '#555',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        Loading game...
      </div>
    )
  }

  if (route.notFound) {
    return <Navigate to="/" replace />
  }

// If the current URL doesn't match where this user should be, redirect.
  // We check the *prefix* (e.g. '/lobby') because the actual route has the
  // gameId baked in, and expectedPath also has the gameId — so comparing
  // prefixes tells us "is the user on the right type of screen?"
console.log('🔍 Guard:', {
    prefix: expectedPathPrefix,
    expectedPath: route.expectedPath,
    loading: route.loading,
    gameStatus: route.gameStatus,
    isGM: route.isGM,
  })

  if (route.expectedPath && !route.expectedPath.startsWith(expectedPathPrefix)) {
    return <Navigate to={route.expectedPath} replace />
  }

  return <>{children}</>
}