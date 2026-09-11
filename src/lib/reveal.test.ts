import { describe, it, expect } from 'vitest'
import {
  revealTotalSteps, revealStageAt, revealedAwardCount, revealedPoints,
  revealNextLabel, ordinal,
} from './reveal'
import type { EndGameAward } from '../types/game'

// Three teams, two bonuses: A wins the side quest (+3), C wins most zones (+8),
// the "most explored" bonus is a tie (nobody). Final totals already include
// the bonuses, exactly as Firestore holds them after applyEndGameBonuses.
const awards: EndGameAward[] = [
  { key: 'sq_potholes', label: 'Pothole Reporting', emoji: '🧩', team_id: 'A', points: 3 },
  { key: 'most_zones_with_challenges', label: 'Most Zones Explored', emoji: '🏆', team_id: null, points: 8 },
  { key: 'most_zones_claimed', label: 'Most Zones Claimed', emoji: '🗺️', team_id: 'C', points: 8 },
]
const A = { id: 'A', total_points: 20 + 3 }
const B = { id: 'B', total_points: 22 }
const C = { id: 'C', total_points: 15 + 8 }
const N = 3

describe('reveal step layout', () => {
  it('has 1 standings + one per award + one per team', () => {
    expect(revealTotalSteps(awards.length, N)).toBe(1 + 3 + 3)
  })

  it('walks standings → awards in order → countdown last-to-first', () => {
    expect(revealStageAt(0, awards, N)).toEqual({ kind: 'waiting' })
    expect(revealStageAt(1, awards, N)).toEqual({ kind: 'standings' })
    expect(revealStageAt(2, awards, N)).toMatchObject({ kind: 'award', index: 0 })
    expect(revealStageAt(4, awards, N)).toMatchObject({ kind: 'award', index: 2 })
    expect(revealStageAt(5, awards, N)).toEqual({ kind: 'place', place: 3 })
    expect(revealStageAt(6, awards, N)).toEqual({ kind: 'place', place: 2 })
    expect(revealStageAt(7, awards, N)).toEqual({ kind: 'place', place: 1 })
  })

  it('clamps steps past the end to the champion', () => {
    expect(revealStageAt(99, awards, N)).toEqual({ kind: 'place', place: 1 })
    expect(revealStageAt(-5, awards, N)).toEqual({ kind: 'waiting' })
  })

  it('with no awards goes straight from standings to the countdown', () => {
    expect(revealTotalSteps(0, 2)).toBe(3)
    expect(revealStageAt(2, [], 2)).toEqual({ kind: 'place', place: 2 })
    expect(revealStageAt(3, [], 2)).toEqual({ kind: 'place', place: 1 })
  })
})

describe('revealed points hide bonuses until their card is shown', () => {
  it('counts revealed awards', () => {
    expect(revealedAwardCount(0, 3)).toBe(0)
    expect(revealedAwardCount(1, 3)).toBe(0)   // standings stage: none yet
    expect(revealedAwardCount(2, 3)).toBe(1)
    expect(revealedAwardCount(4, 3)).toBe(3)
    expect(revealedAwardCount(9, 3)).toBe(3)
  })

  it('shows pre-bonus totals before the reveal and at the standings stage', () => {
    expect(revealedPoints(A, awards, 0)).toBe(20)
    expect(revealedPoints(C, awards, 1)).toBe(15)
    expect(revealedPoints(B, awards, 0)).toBe(22)
  })

  it('folds each bonus in only once its card is up', () => {
    expect(revealedPoints(A, awards, 2)).toBe(23)   // side quest revealed
    expect(revealedPoints(C, awards, 2)).toBe(15)   // most zones not yet
    expect(revealedPoints(C, awards, 3)).toBe(15)   // tie card, still not
    expect(revealedPoints(C, awards, 4)).toBe(23)
    expect(revealedPoints(C, awards, 7)).toBe(23)
  })
})

describe('GM button labels', () => {
  it('describes the next stage', () => {
    expect(revealNextLabel(0, awards, N)).toBe('Show standings before bonuses')
    expect(revealNextLabel(1, awards, N)).toBe('Reveal: Pothole Reporting')
    expect(revealNextLabel(4, awards, N)).toBe('Reveal 3rd place')
    expect(revealNextLabel(6, awards, N)).toBe('Reveal the champion')
    expect(revealNextLabel(7, awards, N)).toBeNull()
  })

  it('formats ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd'])
  })
})
