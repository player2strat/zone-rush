// =============================================================================
// Foray — End-game reveal step math (pure; no Firebase imports)
//
// Shared by the player results page and the GM dashboard preview so both
// always agree on what a given `reveal_step` shows. See lib/endGame.ts for
// the step layout and how awards are written.
// =============================================================================

import type { EndGameAward } from '../types/game'

export type RevealStage =
  | { kind: 'waiting' }                                   // step 0
  | { kind: 'standings' }                                 // pre-bonus standings
  | { kind: 'award'; index: number; award: EndGameAward } // one bonus card
  | { kind: 'place'; place: number }                      // countdown; 1 = champion

/** "1st", "2nd", "3rd", "11th", … */
export function ordinal(n: number): string {
  const mod100 = n % 100
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/** Short description of what the NEXT tap will show — for the GM's button. */
export function revealNextLabel(step: number, awards: EndGameAward[], teamCount: number): string | null {
  if (step >= revealTotalSteps(awards.length, teamCount)) return null
  const next = revealStageAt(step + 1, awards, teamCount)
  if (next.kind === 'standings') return 'Show standings before bonuses'
  if (next.kind === 'award') return `Reveal: ${next.award.label}`
  if (next.kind === 'place') return next.place === 1 ? 'Reveal the champion' : `Reveal ${ordinal(next.place)} place`
  return null
}

/** Total number of taps the GM makes to finish the reveal. */
export function revealTotalSteps(awardCount: number, teamCount: number): number {
  return 1 + awardCount + teamCount
}

/** Which stage a given reveal_step value shows. Out-of-range steps clamp. */
export function revealStageAt(
  step: number,
  awards: EndGameAward[],
  teamCount: number,
): RevealStage {
  const s = Math.max(0, Math.min(step, revealTotalSteps(awards.length, teamCount)))
  if (s === 0) return { kind: 'waiting' }
  if (s === 1) return { kind: 'standings' }
  const awardIndex = s - 2
  if (awardIndex < awards.length) return { kind: 'award', index: awardIndex, award: awards[awardIndex] }
  // Countdown: first countdown step reveals last place (teamCount), the last
  // step reveals 1st.
  const countdownIndex = s - 2 - awards.length   // 0-based
  return { kind: 'place', place: Math.max(1, teamCount - countdownIndex) }
}

/** How many awards have been shown at this step (0 … awards.length). */
export function revealedAwardCount(step: number, awardCount: number): number {
  return Math.max(0, Math.min(step - 1, awardCount))
}

/**
 * A team's score as the audience has seen it so far: their final total minus
 * every bonus that hasn't been revealed yet. At step 0 this is the pre-bonus
 * score; once all awards are out it equals total_points.
 */
export function revealedPoints(
  team: { id: string; total_points: number },
  awards: EndGameAward[],
  step: number,
): number {
  const shown = revealedAwardCount(step, awards.length)
  let hidden = 0
  for (let i = shown; i < awards.length; i++) {
    if (awards[i].team_id === team.id) hidden += awards[i].points
  }
  return team.total_points - hidden
}
