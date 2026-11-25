import { describe, it, expect } from 'vitest'
import { parseCsv } from './challengeImport'
import { buildCardRows, buildCardsCsv, type CardChallenge, type CardSubmission } from './cardAnalytics'

const game = { id: 'g1', name: 'Test Foray', date: new Date(Date.UTC(2026, 10, 14, 17, 0)), practice: false }
const at = (min: number) => new Date(Date.UTC(2026, 10, 14, 18, min))
const sub = (over: Partial<CardSubmission>): CardSubmission => ({
  teamId: 'red', challengeId: 'ch_001', status: 'approved', points: 1, submittedAt: at(0), reviewedAt: at(3),
  tier2Attempted: false, tier2Approved: false, zoneName: 'Park Slope', submittedByName: 'Sam', ...over,
})
const challenges = new Map<string, CardChallenge | null>([
  ['ch_001', { text: 'Pet a dog', difficulty: 'easy', verification: 'photo', sequential: false, tags: ['animals', 'strangers'] }],
  ['ch_002', { text: 'Eat a bagel', difficulty: 'medium', verification: 'video', sequential: false, tags: ['food'] }],
  ['ch_003', { text: 'Sing', difficulty: 'hard', verification: 'video', sequential: false, tags: [] }],
  ['ch_004', { text: 'Run', difficulty: 'easy', verification: 'video', sequential: false, tags: ['physical'] }],
  ['ch_005', { text: 'Wave', difficulty: 'easy', verification: 'photo', sequential: false, tags: [] }],
])

describe('buildCardRows', () => {
  const teams = [{ id: 'red', name: 'Red', dealt: ['ch_001', 'ch_002', 'ch_003'], hand: ['ch_003', 'ch_005'], discarded: ['ch_002'] }]
  const rows = buildCardRows(game, teams, [
    sub({ status: 'rejected', points: 0, submittedAt: at(0), reviewedAt: at(2), submittedByName: 'Ana' }),
    sub({ status: 'approved', points: 1, submittedAt: at(10), reviewedAt: at(14), tier2Attempted: true }),
    sub({ challengeId: 'ch_004', status: 'pending', points: 0, submittedAt: at(20), reviewedAt: null }),
  ], challenges)

  it('one row per card the team held, starting hand first', () => {
    expect(rows.map((r) => [r.challengeId, r.startingHand, r.outcome])).toEqual([
      ['ch_001', true, 'Completed'],
      ['ch_002', true, 'Discarded'],
      ['ch_003', true, 'Not attempted'],
      ['ch_004', false, 'Pending review'],      // drawn later, only known from its submission
      ['ch_005', false, 'Not attempted'],
    ])
  })

  it('counts attempts and uses the approved submission for timing, zone and player', () => {
    expect(rows[0]).toMatchObject({
      attempts: 2, rejections: 1, pointsEarned: 1, tier2Attempted: true, tier2Approved: false,
      firstSubmittedAt: at(0), completedAt: at(10), minutesToReview: 4, submittedByName: 'Sam',
    })
  })

  it('a rejected-only card is Rejected, even if it was later discarded', () => {
    const r = buildCardRows(game, [{ id: 'red', name: 'Red', dealt: ['ch_001'], hand: [], discarded: ['ch_001'] }],
      [sub({ status: 'rejected', points: 0 })], challenges)
    expect(r[0].outcome).toBe('Rejected')
  })
})

describe('buildCardsCsv', () => {
  it('puts the readable columns first and marks tags with Yes', () => {
    const rows = buildCardRows(game, [{ id: 'red', name: 'Red', dealt: ['ch_001', 'gone'], hand: [], discarded: [] }], [sub({})], challenges)
    const [header, first, second] = parseCsv(buildCardsCsv(rows))
    const col = (name: string) => header.indexOf(name)
    expect(header.slice(0, 6)).toEqual(['Game', 'Game date', 'Team', 'Challenge', 'Outcome', 'Points earned'])
    expect(first[col('Game date')]).toBe('2026-11-14')
    expect(first[col('Animals')]).toBe('Yes')
    expect(first[col('Food')]).toBe('')
    expect(first[col('In starting hand')]).toBe('Yes')
    expect(first[col('Outcome')]).toBe('Completed')
    expect(first[col('Minutes to review')]).toBe('3')
    expect(second[col('Challenge')]).toBe('(challenge no longer exists)')
    expect(header).not.toContain('gps_lat')
  })
})
