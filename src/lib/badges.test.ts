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

  it('single-game feats: marathoner, zone ladder, challenge machine', () => {
    const r = mk({ distance_m: 26.2 * 1609.344 + 1, zones_claimed: 8, zones_locked: 3, challenges: 25, member_uids: ['me'] })
    expect(earned([r])).toEqual(expect.arrayContaining(['marathoner', 'zone_baron', 'lockdown', 'challenge_machine']))
    expect(earned([r])).not.toContain('landlord')
    expect(earned([r])).not.toContain('fortress')
    const big = mk({ zones_claimed: 12, zones_locked: 6, member_uids: ['me'] })
    expect(earned([big])).toEqual(expect.arrayContaining(['zone_baron', 'landlord', 'lockdown', 'fortress']))
  })

  it('mogul adds zones across games; old records without zones_locked still work', () => {
    const rs = Array(10).fill(0).map(() => mk({ zones_claimed: 5, member_uids: ['me'] }))
    expect(earned(rs)).toContain('mogul')
    expect(earned(rs.slice(0, 9))).not.toContain('mogul')
    expect(earned(rs)).not.toContain('lockdown')
  })

  it('crew badges need the same roster of two or more', () => {
    const crew = () => mk({ member_uids: ['b', 'me', 'a'], member_names: ['Bo', 'Me', 'Ann'] })
    const other = mk({ member_uids: ['me', 'c'], member_names: ['Me', 'Cy'] })
    expect(earned([crew(), other])).not.toContain('reunited')
    expect(earned([crew(), crew()])).toContain('reunited')
    expect(earned([crew(), crew()])).not.toContain('dynasty')
    expect(earned([...Array(9).fill(0).map(crew), other])).not.toContain('dynasty')
    expect(earned([...Array(10).fill(0).map(crew), other])).toContain('dynasty')
    // solo games never count as a crew
    const solo = () => mk({ member_uids: ['me'], member_names: ['Me'] })
    expect(earned([solo(), solo(), solo()])).not.toContain('reunited')
    expect(crewStreak([crew(), crew()]).games).toBe(2)
  })

  it('crew wins and podiums need the same roster, not just the same player', () => {
    const crewWin = () => mk({ place: 1, member_uids: ['me', 'a'], member_names: ['Me', 'Ann'] })
    const otherWin = () => mk({ place: 1, member_uids: ['me', 'c'], member_names: ['Me', 'Cy'] })
    expect(earned([crewWin(), otherWin()])).not.toContain('crew_wins')
    expect(earned([crewWin(), crewWin()])).toContain('crew_wins')
    const crewThird = () => mk({ place: 3, member_uids: ['me', 'a'], member_names: ['Me', 'Ann'] })
    expect(earned([crewThird(), crewThird()])).not.toContain('crew_podiums')
    expect(earned([crewThird(), crewWin(), crewThird()])).toContain('crew_podiums')
    // a 4th-place game with the crew counts toward Dynasty but not podiums
    const crewFourth = () => mk({ place: 4, member_uids: ['me', 'a'], member_names: ['Me', 'Ann'] })
    expect(earned([crewFourth(), crewFourth(), crewFourth()])).not.toContain('crew_podiums')
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
