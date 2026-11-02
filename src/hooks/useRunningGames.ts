// =============================================================================
// Foray — the GM's running games
//
// Every game the signed-in GM created that hasn't ended (or has ended but
// isn't wrapped up yet), with its team standings and what it's waiting on: submissions and side quest photos to
// review, join requests, and unread "Message GM" pings. The live feed (and the
// alerts when something new arrives) lives in components/RunningGamesProvider,
// mounted once in App.
// =============================================================================

import { createContext, useContext } from 'react'

export type RunningStatus = 'lobby' | 'strategy' | 'active' | 'paused'
export const RUNNING_STATUSES: RunningStatus[] = ['lobby', 'strategy', 'active', 'paused']

// An ended game stays on the GM's list until it's wrapped up (side quest
// points awarded and the results reveal run to the end), so the GM can get
// back to its dashboard to finish. See RunningGamesProvider.
export type CardStatus = RunningStatus | 'ended'

export interface RunningTeam {
  id: string
  name: string
  color: string
  points: number
}

export interface RunningGame {
  id: string
  name: string
  status: CardStatus
  ends_at?: unknown
  paused_at?: unknown
  settings?: { duration_minutes?: number }
  milestone_broadcasts_sent?: string[]
  bonuses_applied?: boolean       // ended games: side quest points locked in
  wrapped_up?: boolean            // false from creation until the reveal finishes
  pendingSubmissions: number
  pendingSideQuests: number
  pendingJoins: number
  unreadMessages: number
  players: number
  teams: RunningTeam[]            // highest points first
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
