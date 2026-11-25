import { describe, it, expect } from 'vitest'
import { summarizeChallenges } from './challengeSummary'

describe('summarizeChallenges', () => {
  const s = summarizeChallenges([
    { id: 'a', difficulty: 'easy', verification_type: 'photo', is_active: true, tags: ['food', 'animals'] },
    { id: 'b', difficulty: 'hard', verification_type: 'video', is_active: false, tags: ['food'] },
    { id: 'c', difficulty: 'medium', verification_type: 'video', tags: [] },
    { id: 'd', verification_type: 'video', tags: ['night_time'] },
  ])

  it('counts difficulty, status and proof, each adding up to the total', () => {
    expect(s.total).toBe(4)
    expect(s.difficulty.map((c) => [c.label, c.count])).toEqual([['Easy', 1], ['Medium', 1], ['Hard', 1], ['Other', 1]])
    expect(s.status.map((c) => c.count)).toEqual([3, 1])
    expect(s.proof.map((c) => [c.label, c.count])).toEqual([['Photo', 1], ['Video', 3]])
  })

  it('lists every standard tag, extra tags in use, then No tags', () => {
    const tags = Object.fromEntries(s.tags.map((c) => [c.label, c.count]))
    expect(s.tags).toHaveLength(13 + 1 + 1)
    expect(tags).toMatchObject({ Food: 2, Animals: 1, Purchase: 0, 'Night time': 1, 'No tags': 1 })
    expect(s.tags[s.tags.length - 1].label).toBe('No tags')
  })
})
