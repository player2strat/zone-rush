// =============================================================================
// Foray — Game results (the record behind profiles and the leaderboard)
//
// One doc per team per game in the top-level `game_results` collection,
// written ONCE by the GM dashboard the moment the champion is revealed (after
// bonus totals land). Everything profiles, badges and the leaderboard show is
// derived from these docs, so a past game never needs re-reading.
//
// Placement points (season/all-time standing): 1st 10 · 2nd 7 · 3rd 5 ·
// everyone else 3. Tied teams share the higher rank's points.
// =============================================================================

import {
  collection, doc, getDoc, getDocs, query, where, writeBatch, increment, serverTimestamp, limit,
} from 'firebase/firestore'
import { db } from './firebase'
import { teamDistanceMeters } from './distance'
import type { GameResult } from '../types/game'

export const PLACEMENT_POINTS: Record<number, number> = { 1: 10, 2: 7, 3: 5 }
export const PLACEMENT_POINTS_DEFAULT = 3

export function placementPoints(place: number): number {
  return PLACEMENT_POINTS[place] ?? PLACEMENT_POINTS_DEFAULT
}

/** Competition ranking: 1 + number of teams with strictly more points. */
export function placeOf(points: number, all: number[]): { place: number; tied: boolean } {
  const place = 1 + all.filter((p) => p > points).length
  const tied = all.filter((p) => p === points).length > 1
  return { place, tied }
}

/**
 * Writes game_results docs for every team in the game, bumps each member's
 * games_played / games_won, and flags the game as recorded — all in one
 * batch so it can never half-apply. No-op if already recorded.
 */
export async function recordGameResults(gameId: string): Promise<{ recorded: number; skipped: boolean }> {
  const gameRef = doc(db, 'games', gameId)
  const gameSnap = await getDoc(gameRef)
  if (!gameSnap.exists()) throw new Error('Game not found')
  const game = gameSnap.data()
  if (game.results_recorded) return { recorded: 0, skipped: true }
  if (game.status !== 'ended') throw new Error('Game has not ended')

  const [teamsSnap, zoneScoresSnap] = await Promise.all([
    getDocs(collection(db, 'games', gameId, 'teams')),
    getDocs(collection(db, 'games', gameId, 'zone_scores')),
  ])

  const zonesByTeam = new Map<string, number>()
  const lockedByTeam = new Map<string, number>()
  const challengesByTeam = new Map<string, number>()
  zoneScoresSnap.forEach((d) => {
    const zs = d.data()
    if (zs.status === 'claimed' || zs.status === 'locked') {
      zonesByTeam.set(zs.team_id, (zonesByTeam.get(zs.team_id) ?? 0) + 1)
    }
    if (zs.status === 'locked') {
      lockedByTeam.set(zs.team_id, (lockedByTeam.get(zs.team_id) ?? 0) + 1)
    }
    const n = (zs.challenges_completed as string[] | undefined)?.length ?? 0
    challengesByTeam.set(zs.team_id, (challengesByTeam.get(zs.team_id) ?? 0) + n)
  })

  const teams = teamsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }))
  if (teams.length === 0) throw new Error('No teams in this game')
  const allPoints = teams.map((t) => (t.total_points as number) ?? 0)

  const batch = writeBatch(db)
  const playedAt = game.ended_at ?? game.ends_at ?? serverTimestamp()
  let recorded = 0

  for (const t of teams) {
    const points = (t.total_points as number) ?? 0
    const { place, tied } = placeOf(points, allPoints)
    const members = (t.members as string[]) ?? []
    const result: Omit<GameResult, 'id'> = {
      game_id: gameId,
      game_name: (game.name as string) ?? 'Foray',
      city: (game.city as string) ?? 'nyc',
      played_at: playedAt,
      team_id: t.id,
      team_name: (t.name as string) ?? 'Team',
      team_color: (t.color as string) ?? '#888888',
      place,
      tied,
      team_count: teams.length,
      points,
      placement_points: placementPoints(place),
      zones_claimed: zonesByTeam.get(t.id) ?? 0,
      zones_locked: lockedByTeam.get(t.id) ?? 0,
      challenges: challengesByTeam.get(t.id) ?? 0,
      distance_m: Math.round(teamDistanceMeters(t.member_distances as Record<string, number> | undefined)),
      member_uids: members,
      member_names: (t.member_names as string[]) ?? [],
    }
    batch.set(doc(db, 'game_results', `${gameId}_${t.id}`), result)
    recorded++

    for (const uid of members) {
      batch.set(
        doc(db, 'users', uid),
        { games_played: increment(1), games_won: increment(place === 1 ? 1 : 0) },
        { merge: true },
      )
    }
  }

  batch.update(gameRef, { results_recorded: true })
  await batch.commit()
  return { recorded, skipped: false }
}

/** Every result a player was part of, newest first. */
export async function loadPlayerResults(uid: string): Promise<GameResult[]> {
  const snap = await getDocs(query(
    collection(db, 'game_results'),
    where('member_uids', 'array-contains', uid),
  ))
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as GameResult))
    .sort((a, b) => playedAtMs(b) - playedAtMs(a))
}

/** Every result, for the leaderboard. Capped; fine until there are thousands. */
export async function loadAllResults(max = 2000): Promise<GameResult[]> {
  const snap = await getDocs(query(collection(db, 'game_results'), limit(max)))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as GameResult))
}

export function playedAtMs(r: GameResult): number {
  const p = r.played_at as { toMillis?: () => number; seconds?: number } | null
  return p?.toMillis?.() ?? (p?.seconds ? p.seconds * 1000 : 0)
}

// ---------------------------------------------------------------------------
// Leaderboard aggregation (pure)
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  uid: string
  name: string
  placementPoints: number
  games: number
  wins: number
  podiums: number
  lastPlayedMs: number
}

export function aggregateLeaderboard(results: GameResult[]): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>()
  for (const r of results) {
    r.member_uids.forEach((uid, i) => {
      const row = rows.get(uid) ?? {
        uid, name: r.member_names[i] ?? 'Player', placementPoints: 0, games: 0, wins: 0, podiums: 0, lastPlayedMs: 0,
      }
      row.placementPoints += r.placement_points
      row.games += 1
      if (r.place === 1) row.wins += 1
      if (r.place <= 3) row.podiums += 1
      const ms = playedAtMs(r)
      if (ms >= row.lastPlayedMs) {
        row.lastPlayedMs = ms
        row.name = r.member_names[i] ?? row.name   // most recent display name wins
      }
      rows.set(uid, row)
    })
  }
  return [...rows.values()].sort((a, b) =>
    b.placementPoints - a.placementPoints || b.wins - a.wins || b.podiums - a.podiums || a.name.localeCompare(b.name))
}
