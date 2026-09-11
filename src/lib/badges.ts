// =============================================================================
// Foray — Badges (pure; derived from a player's game_results)
//
// Nothing is stored: a profile computes its badge wall from the results list
// every time, so a new badge added here shows up for past games too.
//
// "Crew" badges reward playing with the same people again. A crew is a team
// roster of two or more players; Reunited = the exact same roster played a
// second game, Dynasty = a third.
// =============================================================================

import type { GameResult } from '../types/game'
import { METERS_PER_MILE } from './distance'

export interface BadgeDef {
  key: string
  label: string
  emoji: string
  description: string
}

export interface BadgeStatus extends BadgeDef {
  earned: boolean
  progress: string       // e.g. "2 / 3 games" — shown on unearned badges
}

export const MARATHONER_METERS = 5 * METERS_PER_MILE
export const ZONE_BARON_ZONES = 5
export const CHALLENGE_MACHINE = 10

export const BADGES: BadgeDef[] = [
  { key: 'first_foray',   label: 'First Foray',      emoji: '🧭', description: 'Played your first game' },
  { key: 'regular',       label: 'Regular',          emoji: '🗓️', description: 'Played three games' },
  { key: 'veteran',       label: 'Veteran',          emoji: '🎖️', description: 'Played ten games' },
  { key: 'podium',        label: 'Podium',           emoji: '🥉', description: 'Finished in the top three' },
  { key: 'champion',      label: 'Champion',         emoji: '🏆', description: 'Won a game' },
  { key: 'serial_winner', label: 'Serial Winner',    emoji: '👑', description: 'Won three games' },
  { key: 'marathoner',    label: 'Marathoner',       emoji: '🏃', description: 'Covered five miles in one game' },
  { key: 'zone_baron',    label: 'Zone Baron',       emoji: '🏴', description: `Claimed ${ZONE_BARON_ZONES} zones in one game` },
  { key: 'challenge_machine', label: 'Challenge Machine', emoji: '⚡', description: `${CHALLENGE_MACHINE} challenges in one game` },
  { key: 'reunited',      label: 'Reunited',         emoji: '🤝', description: 'Played a second game with the same crew' },
  { key: 'dynasty',       label: 'Dynasty',          emoji: '🏛️', description: 'Three games with the same crew' },
]

/** Roster key: sorted member uids, only for teams of two or more. */
function rosterKey(r: GameResult): string | null {
  if (r.member_uids.length < 2) return null
  return [...r.member_uids].sort().join('|')
}

export interface CrewStreak {
  games: number          // most games played with one identical roster
  names: string[]        // that roster's names (from the latest result)
}

export function crewStreak(results: GameResult[]): CrewStreak {
  const counts = new Map<string, { games: number; names: string[] }>()
  for (const r of results) {
    const key = rosterKey(r)
    if (!key) continue
    const cur = counts.get(key) ?? { games: 0, names: r.member_names }
    cur.games += 1
    counts.set(key, cur)
  }
  let best: CrewStreak = { games: 0, names: [] }
  for (const v of counts.values()) if (v.games > best.games) best = v
  return best
}

export function computeBadges(results: GameResult[]): BadgeStatus[] {
  const games = results.length
  const wins = results.filter((r) => r.place === 1).length
  const podiums = results.filter((r) => r.place <= 3).length
  const bestDistance = Math.max(0, ...results.map((r) => r.distance_m ?? 0))
  const bestZones = Math.max(0, ...results.map((r) => r.zones_claimed ?? 0))
  const bestChallenges = Math.max(0, ...results.map((r) => r.challenges ?? 0))
  const crew = crewStreak(results)

  const miles = (m: number) => (m / METERS_PER_MILE).toFixed(1)
  const status: Record<string, { earned: boolean; progress: string }> = {
    first_foray:   { earned: games >= 1,  progress: `${Math.min(games, 1)} / 1 game` },
    regular:       { earned: games >= 3,  progress: `${Math.min(games, 3)} / 3 games` },
    veteran:       { earned: games >= 10, progress: `${Math.min(games, 10)} / 10 games` },
    podium:        { earned: podiums >= 1, progress: podiums > 0 ? `${podiums} podiums` : 'No top-three finish yet' },
    champion:      { earned: wins >= 1,   progress: wins > 0 ? `${wins} wins` : 'No wins yet' },
    serial_winner: { earned: wins >= 3,   progress: `${Math.min(wins, 3)} / 3 wins` },
    marathoner:    { earned: bestDistance >= MARATHONER_METERS, progress: `Best ${miles(bestDistance)} / 5.0 mi` },
    zone_baron:    { earned: bestZones >= ZONE_BARON_ZONES, progress: `Best ${bestZones} / ${ZONE_BARON_ZONES} zones` },
    challenge_machine: { earned: bestChallenges >= CHALLENGE_MACHINE, progress: `Best ${bestChallenges} / ${CHALLENGE_MACHINE}` },
    reunited:      { earned: crew.games >= 2, progress: `${Math.min(crew.games, 2)} / 2 games with one crew` },
    dynasty:       { earned: crew.games >= 3, progress: `${Math.min(crew.games, 3)} / 3 games with one crew` },
  }

  return BADGES.map((b) => ({ ...b, ...status[b.key] }))
}
