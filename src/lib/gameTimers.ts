// =============================================================================
// Foray — timed events for running games
//
// Milestone broadcasts, zone open/close schedules and timed zone lockouts.
// Security rules let only the GM write these, so they run from the GM's
// browser (hooks/useGameTimers), for every game the GM is running and on any
// screen, not just the dashboard that's open. Every step is claim-first or
// atomic, so two tabs (or an admin covering the same game) never double-send
// a message or double-award a lockout.
// =============================================================================

import { doc, runTransaction, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore'
import { db } from './firebase'
import { sendGMBroadcast } from './chat'
import { checkZoneLockouts, runZoneSchedules } from './scoring'
import { dueMilestone } from './milestones'

export interface TimedGame {
  id: string
  status: string
  ends_at?: unknown
  settings?: { duration_minutes?: number }
  milestone_broadcasts_sent?: string[]
}

function toMillis(t: unknown): number | null {
  if (t instanceof Date) return t.getTime()
  const ts = t as { toMillis?: () => number } | null | undefined
  return ts?.toMillis ? ts.toMillis() : null
}

// Milestones being claimed or sent from this tab right now.
const inFlight = new Set<string>()

/** Broadcast the game's due milestone, if any. Safe to call every few seconds. */
export async function sendDueMilestone(game: TimedGame, uid: string): Promise<void> {
  if (game.status !== 'active') return
  const endsAt = toMillis(game.ends_at)
  if (endsAt === null) return
  const milestone = dueMilestone(
    game.settings?.duration_minutes ?? 180,
    endsAt - Date.now(),
    game.milestone_broadcasts_sent ?? []
  )
  if (!milestone) return

  const flightKey = `${game.id}:${milestone.key}`
  if (inFlight.has(flightKey)) return
  inFlight.add(flightKey)
  const ref = doc(db, 'games', game.id)
  try {
    // Claim it first: only the screen whose transaction marks it sent posts it.
    const claimed = await runTransaction(db, async (tx) => {
      const data = (await tx.get(ref)).data()
      const sent: string[] = data?.milestone_broadcasts_sent ?? []
      if (!data || data.status !== 'active' || sent.includes(milestone.key)) return false
      tx.update(ref, { milestone_broadcasts_sent: arrayUnion(milestone.key) })
      return true
    })
    if (!claimed) return
    try {
      await sendGMBroadcast(game.id, uid, 'Foray', milestone.message)
    } catch (err) {
      // Give the claim back so the next check (inside the grace window) retries.
      console.error('Milestone broadcast failed:', milestone.key, err)
      await updateDoc(ref, { milestone_broadcasts_sent: arrayRemove(milestone.key) }).catch(() => {})
    }
  } catch (err) {
    console.error('Milestone check failed:', err)
  } finally {
    inFlight.delete(flightKey)
  }
}

/** Timed zone lockouts, then zone open/close schedules. */
export async function runZoneTimers(gameId: string): Promise<void> {
  await checkZoneLockouts(gameId).catch((err) => console.error('Zone lockout check failed:', err))
  await runZoneSchedules(gameId)
}
