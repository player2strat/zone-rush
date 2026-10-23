import { describe, it, expect } from 'vitest'
import { countChallenges, type Bucket } from './challengeStats'
import { challengeSeedData } from '../data/challengeSeedData'

const sum = (buckets: Bucket[]) => buckets.reduce((n, b) => n + b.count, 0)

describe('countChallenges', () => {
  it('every row adds up to the total for the seed file', () => {
    const c = countChallenges(challengeSeedData as unknown as Record<string, unknown>[])
    expect(c.total).toBe(challengeSeedData.length)
    expect(sum(c.byDifficulty)).toBe(c.total)
    expect(sum(c.byCategory)).toBe(c.total)
    expect(c.byCategory.map((b) => b.key)).toEqual(['humor', 'culture', 'exploration', 'food', 'fitness', 'civic', 'art'])
  })

  it('challenges added outside the seed file still count, in extra buckets', () => {
    const c = countChallenges([
      { difficulty: 'Easy', category: 'food', is_active: true, tier2: null },
      { difficulty: 'medium', category: 'Music', is_active: false, tier2: { description: 'x', bonus_points: 1 } },
      { difficulty: 'expert', challenge_type: 'sequential', is_active: true },
      { title: 'no fields at all' },
    ])
    expect(c.total).toBe(4)
    expect(c.active).toBe(2)
    expect(c.withTier2).toBe(1)
    expect(c.byDifficulty.map((b) => [b.label, b.count])).toEqual([['Easy', 1], ['Medium', 1], ['Hard', 0], ['Other', 2]])
    expect(sum(c.byCategory)).toBe(4)
    expect(c.byCategory.slice(-2).map((b) => [b.label, b.count])).toEqual([['Music', 1], ['No category', 2]])
  })
})
