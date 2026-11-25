import { describe, it, expect } from 'vitest'
import { completionRate, computeTagStats } from './tagStats'

describe('computeTagStats', () => {
  const tagsById = new Map([
    ['ch_1', ['food', 'purchase']],
    ['ch_2', ['park']],
    ['ch_3', []],
  ])

  it('counts per team and per card, once in each of a card\'s tags', () => {
    const rows = computeTagStats({
      tagsById,
      teams: [
        { id: 'red', held: ['ch_1', 'ch_2'], discarded: ['ch_2'] },
        { id: 'blue', held: ['ch_1'], discarded: [] },
      ],
      submissions: [
        { teamId: 'red', challengeId: 'ch_1', status: 'rejected', points: 0 },
        { teamId: 'red', challengeId: 'ch_1', status: 'approved', points: 3 },
        { teamId: 'blue', challengeId: 'ch_1', status: 'pending', points: 0 },
        { teamId: 'blue', challengeId: 'ch_3', status: 'approved', points: 1 },   // drawn later: counts as held
      ],
    })
    expect(rows.map((r) => r.label)).toEqual(['Purchase', 'Food', 'Park', 'No tags'])
    const food = rows.find((r) => r.key === 'food')!
    expect(food).toMatchObject({ held: 2, attempted: 2, completed: 1, rejected: 1, discarded: 0, points: 3 })
    expect(completionRate(food)).toBe('50%')
    expect(rows.find((r) => r.key === 'park')).toMatchObject({ held: 1, attempted: 0, discarded: 1 })
    expect(rows.find((r) => r.key === '')).toMatchObject({ held: 1, completed: 1, points: 1 })
  })

  it('challenges missing from the map count as untagged', () => {
    const rows = computeTagStats({ tagsById: new Map(), teams: [{ id: 't', held: ['gone'], discarded: [] }], submissions: [] })
    expect(rows).toEqual([{ key: '', label: 'No tags', held: 1, attempted: 0, completed: 0, rejected: 0, discarded: 0, points: 0 }])
  })
})
