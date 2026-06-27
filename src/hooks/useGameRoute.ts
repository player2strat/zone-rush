// =============================================================================
// Zone Rush — useGameRoute Hook
//
// Single source of truth for "where should this user be right now,
// given the state of their game?"
//
// Subscribes to the game document and returns the canonical path the user
// should be on. Used by GameRouteGuard to detect URL/state mismatches and
// redirect once. Eliminates the race between LobbyPage, GamePage, and
// ActiveGameRedirect all trying to navigate independently.
// =============================================================================

import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { auth, db } from '../lib/firebase'

export type GameStatus = 'lobby' | 'strategy' | 'active' | 'paused' | 'ended'

export interface GameRoute {
  loading: boolean
  gameStatus: GameStatus | null
  expectedPath: string | null
  isGM: boolean
  notFound: boolean
}

export function useGameRoute(gameId: string | undefined): GameRoute {
  const [authReady, setAuthReady] = useState(false)
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null)
  const [gameStatus, setGameStatus] = useState<GameStatus | null>(null)
  const [createdBy, setCreatedBy] = useState<string | null>(null)
  const [gmUids, setGmUids] = useState<string[]>([])
  const [gameLoading, setGameLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Track auth state — needed to decide GM vs player route
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUid(u?.uid ?? null)
      setAuthReady(true)
    })
    return unsub
  }, [])

  // Subscribe to the game document
  useEffect(() => {
    if (!gameId) {
      setGameLoading(false)
      return
    }
    const unsub = onSnapshot(
      doc(db, 'games', gameId),
      (snap) => {
        if (!snap.exists()) {
          setNotFound(true)
          setGameStatus(null)
          setCreatedBy(null)
          setGmUids([])
        } else {
          const data = snap.data()
          setGameStatus((data.status ?? null) as GameStatus | null)
          setCreatedBy(data.created_by ?? null)
          setGmUids(Array.isArray(data.gm_uids) ? data.gm_uids : [])
          setNotFound(false)
        }
        setGameLoading(false)
      },
      () => {
        // Permission denied or other error — treat as not found
        setNotFound(true)
        setGameLoading(false)
      }
    )
    return unsub
  }, [gameId])

  const loading = !authReady || gameLoading
  const isGM = !!uid && (uid === createdBy || gmUids.includes(uid))

  let expectedPath: string | null = null
  if (!loading && gameId && gameStatus) {
    switch (gameStatus) {
      case 'lobby':
        expectedPath = `/lobby/${gameId}`
        break
      case 'strategy':
      case 'active':
      case 'paused':
        expectedPath = isGM ? `/gm/${gameId}` : `/game/${gameId}`
        break
      case 'ended':
        expectedPath = isGM ? `/gm/${gameId}` : `/results/${gameId}`
        break
    }
  }

  return { loading, gameStatus, expectedPath, isGM, notFound }
}