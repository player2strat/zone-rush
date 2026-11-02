// =============================================================================
// Foray — the GM's running games
//
// Every game the signed-in GM created that hasn't ended, with what each one is
// waiting on: submissions and side quest photos to review, join requests, and
// unread "Message GM" pings. The live feed (and the alerts when something new
// arrives) lives in components/RunningGamesProvider, mounted once in App.
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
  pendingSideQuests: number
  pendingJoins: number
  unreadMessages: number
  players: number
}

/** Everything in this game that's waiting for the GM. */
export function waitingCount(g: RunningGame): number {
  return g.pendingSubmissions + g.pendingSideQuests + g.pendingJoins + g.unreadMessages
}

export const RunningGamesContext = createContext<RunningGame[]>([])

/** The signed-in GM's running games (empty for players). */
export function useRunningGames(): RunningGame[] {
  return useContext(RunningGamesContext)
}
