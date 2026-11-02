// =============================================================================
// Foray — the GM's running games
//
// Every game the signed-in GM created that hasn't ended, with how many
// submissions and join requests each one is waiting on. The live feed lives in
// components/RunningGamesProvider (mounted once in App); read it here.
// =============================================================================

import { createContext, useContext } from 'react'

export type RunningStatus = 'lobby' | 'strategy' | 'active' | 'paused'
export const RUNNING_STATUSES: RunningStatus[] = ['lobby', 'strategy', 'active', 'paused']

export interface RunningGame {
  id: string
  name: string
  status: RunningStatus
  ends_at?: unknown
  paused_at?: unknown
  settings?: { duration_minutes?: number }
  milestone_broadcasts_sent?: string[]
  pendingSubmissions: number
  pendingJoins: number
  players: number
}

export const RunningGamesContext = createContext<RunningGame[]>([])

/** The signed-in GM's running games (empty for players). */
export function useRunningGames(): RunningGame[] {
  return useContext(RunningGamesContext)
}
