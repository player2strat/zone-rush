// =============================================================================
// Foray — milestone broadcasts
//
// The automatic "halfway", "30 minutes" and "5 minutes" messages to players.
// Pure timing logic, no Firestore; lib/gameTimers.ts claims and sends them.
// =============================================================================

export interface Milestone {
  key: string
  message: string
}

// A milestone that comes due while no GM screen is checking still goes out if
// a check happens within this long. Any later and it's skipped: "Halfway
// point!" half an hour late would mislead players.
export const MILESTONE_GRACE_MS = 5 * 60_000

const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`

/**
 * The milestone to broadcast now, or null.
 *
 * Only the most recent milestone that has come due counts: once a later one is
 * due, earlier unsent ones are never sent. The message quotes the real minutes
 * left (rounded up), so one sent a little late is still accurate.
 */
export function dueMilestone(
  totalMins: number,
  msLeft: number,
  sent: readonly string[]
): Milestone | null {
  if (msLeft <= 0) return null
  const halfway = Math.floor(totalMins / 2)
  const due = [
    // In very short games halfway lands after the 5 minute warning; skip it.
    { key: 'halfway', mins: halfway > 5 ? halfway : 0 },
    { key: '30min', mins: 30 },
    { key: '5min', mins: 5 },
  ].filter((m) => m.mins > 0 && m.mins < totalMins && msLeft <= m.mins * 60_000)
  if (due.length === 0) return null

  // Most recent = smallest mark. Ties keep list order, so in a 60 minute game
  // the halfway message wins over the 30 minute one, as it always has.
  const latest = due.reduce((a, b) => (b.mins < a.mins ? b : a))
  if (sent.includes(latest.key)) return null
  if (latest.mins * 60_000 - msLeft > MILESTONE_GRACE_MS) return null

  const left = minutes(Math.ceil(msLeft / 60_000))
  const message =
    latest.key === 'halfway'
      ? `⏱ Halfway point! You have ${left} left. Check the map. Now's a good time to make your move.`
      : latest.key === '30min'
      ? `⚠️ ${left} remaining! Start thinking about your return route and final zone pushes.`
      : `🚨 ${left} left! Head back to the start now. Don't forget Side Quests: most zones, most transport modes, most challenges.`
  return { key: latest.key, message }
}
