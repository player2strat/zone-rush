// =============================================================================
// Foray — how a running game reads at a glance
//
// Shared by the home screen's summary cards (components/GameSummaryCard) and
// the scoreboard strip across the top of a GM's game (components/GameStrip).
// =============================================================================

import type { CardStatus, RunningGame } from '../hooks/useRunningGames'

export const STATUS_LABEL: Record<CardStatus, { label: string; bg: string; color: string }> = {
  active: { label: 'Live', bg: 'rgba(var(--green-rgb), 0.15)', color: 'var(--green)' },
  paused: { label: 'Paused', bg: 'rgba(var(--marigold-rgb), 0.15)', color: 'var(--marigold-deep)' },
  strategy: { label: 'Strategy', bg: 'rgba(var(--pink-rgb), 0.12)', color: 'var(--pink-deep)' },
  lobby: { label: 'Lobby', bg: 'rgba(var(--ink-rgb), 0.06)', color: 'var(--ink-muted)' },
  ended: { label: 'Ended', bg: 'rgba(var(--ink-rgb), 0.08)', color: 'var(--ink-soft)' },
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function toMillis(t: unknown): number | null {
  if (t instanceof Date) return t.getTime()
  const ts = t as { toMillis?: () => number } | null | undefined
  return ts?.toMillis ? ts.toMillis() : null
}

/** Live or paused: the clock applies. */
export const isUnderway = (g: RunningGame) => g.status === 'active' || g.status === 'paused'

/** Teams have points worth showing: live, paused, or ended. */
export const showsStandings = (g: RunningGame) => isUnderway(g) || g.status === 'ended'

/**
 * "1:42 left" for a live or paused game (a paused clock stops where it
 * paused); null when there's no clock to show.
 */
export function timeLeft(g: RunningGame, now: number): string | null {
  if (!isUnderway(g)) return null
  const endsAt = toMillis(g.ends_at)
  if (endsAt === null) return null
  const from = g.status === 'paused' ? toMillis(g.paused_at) ?? now : now
  const ms = Math.max(0, endsAt - from)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `${h}:${String(m).padStart(2, '0')} left`
}

/** An ended game's next wrap-up step on its dashboard, or null if not ended. */
export function wrapUpStep(g: RunningGame): string | null {
  if (g.status !== 'ended') return null
  return g.bonuses_applied ? 'Run the reveal' : 'Award side quest points'
}

/** When an ended game's clock ran out (or it was ended), in ms; null if unknown. */
export const endedAt = (g: { ends_at?: unknown }) => toMillis(g.ends_at)

/** "Ended 40 min ago" / "Ended 3 hr ago" for an ended game; null otherwise. */
export function endedAgo(g: RunningGame, now: number): string | null {
  if (g.status !== 'ended') return null
  const at = endedAt(g)
  if (at === null) return 'Ended'
  const mins = Math.max(0, Math.round((now - at) / 60000))
  return mins < 60 ? `Ended ${mins} min ago` : `Ended ${Math.floor(mins / 60)} hr ago`
}

/** What's waiting for the GM, e.g. "2 to review, 1 message". */
export function waitingParts(g: RunningGame): string[] {
  const toReview = g.pendingSubmissions + g.pendingSideQuests
  return [
    toReview > 0 ? `${toReview} to review` : '',
    g.unreadMessages > 0 ? plural(g.unreadMessages, 'message') : '',
    g.pendingJoins > 0 ? plural(g.pendingJoins, 'join request') : '',
  ].filter(Boolean)
}
