// =============================================================================
// Runs the timed events in lib/gameTimers for the given games while this
// screen is open: milestones every few seconds (no reads unless one is due),
// zone schedules and lockouts once a minute, and both whenever the tab comes
// back to the foreground.
// =============================================================================

import { useEffect, useRef } from 'react'
import { runZoneTimers, sendDueMilestone, type TimedGame } from '../lib/gameTimers'

export function useGameTimers(games: TimedGame[], uid: string | undefined) {
  // The latest game data (milestones sent, ends_at after a resume) without
  // restarting the timers on every snapshot.
  const latest = useRef(games)
  useEffect(() => {
    latest.current = games
  }, [games])

  const activeIds = games
    .filter((g) => g.status === 'active')
    .map((g) => g.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!activeIds || !uid) return
    const active = () => latest.current.filter((g) => g.status === 'active')
    const zones = () => active().forEach((g) => runZoneTimers(g.id))
    const milestones = () => active().forEach((g) => sendDueMilestone(g, uid))

    zones()
    milestones()
    const zoneTimer = setInterval(zones, 60_000)
    const milestoneTimer = setInterval(milestones, 5_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        zones()
        milestones()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(zoneTimer)
      clearInterval(milestoneTimer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [activeIds, uid])
}
