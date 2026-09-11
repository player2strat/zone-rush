import { describe, it, expect } from 'vitest'
import { computeBadges, crewStreak } from './badges'
import { aggregateLeaderboard, placeOf, placementPoints } from './gameResults'
import type { GameResult } from '../types/game'

const mk = (over: Partial<GameResult>): GameResult => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  game_id: 'g', game_name: 'Game', city: 'nyc', played_at: { seconds: 1 },
  team_id: 't', team_name: 'Team', team_color: '#000',
  place: 2, tied: false, team_count: 4, points: 10, placement_points: 7,
  zones_claimed: 1, challenges: 3, distance_m: 1000,
  member_uids: ['me', 'a'], member_names: ['Me', 'Ann'],
  ...over,
})

const earned = (rs: GameResult[]) => computeBadges(rs).filter((b) => b.earned).map((b) => b.key)

describe('badges', () => {
  it('nothing before the first game', () => {
    expect(earned([])).toEqual([])
  })

  it('first game earns First Foray, and Podium when top three', () => {
    expect(earned([mk({ place: 2 })])).toEqual(['first_foray', 'podium'])
  })

  it('winning earns Champion; three wins earns Serial Winner', () => {
    const w = () => mk({ place: 1, member_uids: ['me'], member_names: ['Me'] })
    expect(earned([w()])).toContain('champion')
    expect(earned([w()])).not.toContain('serial_winner')
    expect(earned([w(), w(), w()])).toContain('serial_winner')
  })

  it('single-game feats: marathoner, zone baron, challenge machine', () => {
    const r = mk({ distance_m: 9000, zones_claimed: 5, challenges: 10, member_uids: ['me'] })
    expect(earned([r])).toEqual(expect.arrayContaining(['marathoner', 'zone_baron', 'challenge_machine']))
  })

  it('crew badges need the same roster of two or more', () => {
    const crew = () => mk({ member_uids: ['b', 'me', 'a'], member_names: ['Bo', 'Me', 'Ann'] })
    const other = mk({ member_uids: ['me', 'c'], member_names: ['Me', 'Cy'] })
    expect(earned([crew(), other])).not.toContain('reunited')
    expect(earned([crew(), crew()])).toContain('reunited')
    expect(earned([crew(), crew()])).not.toContain('dynasty')
    expect(earned([crew(), other, crew(), crew()])).toContain('dynasty')
    // solo games never count as a crew
    const solo = () => mk({ member_uids: ['me'], member_names: ['Me'] })
    expect(earned([solo(), solo(), solo()])).not.toContain('reunited')
    expect(crewStreak([crew(), crew()]).games).toBe(2)
  })

  it('unearned badges show progress', () => {
    const b = computeBadges([mk({})]).find((x) => x.key === 'regular')!
    expect(b.earned).toBe(false)
    expect(b.progress).toBe('1 / 3 games')
  })
})

describe('placement', () => {
  it('scores 10 / 7 / 5 / 3', () => {
    expect([1, 2, 3, 4, 9].map(placementPoints)).toEqual([10, 7, 5, 3, 3])
  })
  it('ties share the higher rank', () => {
    expect(placeOf(20, [20, 20, 15])).toEqual({ place: 1, tied: true })
    expect(placeOf(15, [20, 20, 15])).toEqual({ place: 3, tied: false })
  })
})

describe('leaderboard aggregation', () => {
  it('sums placement points per player and keeps the latest name', () => {
    const rows = aggregateLeaderboard([
      mk({ place: 1, placement_points: 10, member_uids: ['me', 'a'], member_names: ['Old Me', 'Ann'], played_at: { seconds: 1 } }),
      mk({ place: 3, placement_points: 5, member_uids: ['me'], member_names: ['New Me'], played_at: { seconds: 2 } }),
      mk({ place: 2, placement_points: 7, member_uids: ['a'], member_names: ['Ann'], played_at: { seconds: 3 } }),
    ])
    expect(rows[0]).toMatchObject({ uid: 'a', name: 'Ann', placementPoints: 17, games: 2, wins: 1 })
    expect(rows[1]).toMatchObject({ uid: 'me', name: 'New Me', placementPoints: 15, games: 2, wins: 1, podiums: 2 })
  })
})
