// =============================================================================
// Foray — End-Game Bonus Logic (Side Quests)
//
// Side Quest rules (stored in game settings, never hardcoded):
//   +8  Most zones claimed               (auto-calculated from zone_scores)
//   +8  Most zones with ≥1 challenge     (auto-calculated from zone_scores)
//
// Bonuses stored on the game doc:
//   end_game_bonuses: { [teamId]: number }
//   bonuses_applied: boolean
//   end_game_awards: EndGameAward[]   — every bonus in REVEAL order
//   reveal_step: number               — GM-driven reveal cursor (see below)
//
// The reveal: after the GM locks in bonuses, points are final but players
// don't see them yet. The GM taps "Next" on the dashboard, which increments
// reveal_step on the game doc; every player's results page follows it live.
// Step layout (A = number of awards, N = number of teams):
//   0             not started — players see only their own pre-bonus total
//   1             standings before bonuses (all teams)
//   2 … 1+A       one bonus card per tap, in end_game_awards order
//   2+A … 1+A+N   countdown: last place first, then up to the champion
// =============================================================================

import {
  doc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
} from 'firebase/firestore'
import { db } from './firebase'
import type { EndGameAward } from '../types/game'

export interface BonusAwards {
  mostZonesClaimed: string | null        // team with most claimed zones
  mostZonesWithChallenges: string | null // team with most zones where ≥1 challenge completed
  // Photo side quests: quest id → winning team id (most approved submissions).
  sideQuests?: Record<string, string | null>
}

export interface TeamBonusSummary {
  teamId: string
  teamName: string
  teamColor: string
  zonesClaimedCount: number           // zones at or above claim threshold
  zonesWithChallengesCount: number    // zones with at least 1 completed challenge
}

// ---------------------------------------------------------------------------
// getTeamBonusSummaries
// Returns data the GM needs to award Side Quests.
// ---------------------------------------------------------------------------
export async function getTeamBonusSummaries(
  gameId: string
): Promise<TeamBonusSummary[]> {
  const teamsSnap = await getDocs(
    collection(db, 'games', gameId, 'teams')
  )
  const zoneScoresSnap = await getDocs(
    collection(db, 'games', gameId, 'zone_scores')
  )

  // Count per team: claimed zones AND zones with ≥1 challenge
  const claimedCounts = new Map<string, number>()
  const zonesWithChallengeCounts = new Map<string, number>()

  zoneScoresSnap.forEach((d) => {
    const data = d.data()
    const teamId = data.team_id as string

    // Count claimed zones — a locked zone is still owned, so count both.
    // Must match ResultsPage's standings filter (claimed || locked) so the
    // displayed "zones claimed" and the bonus winner never disagree.
    if (data.status === 'claimed' || data.status === 'locked') {
      claimedCounts.set(teamId, (claimedCounts.get(teamId) ?? 0) + 1)
    }

    // Count zones with at least 1 completed challenge
    const completed = data.challenges_completed as string[] | undefined
    if (completed && completed.length > 0) {
      zonesWithChallengeCounts.set(
        teamId,
        (zonesWithChallengeCounts.get(teamId) ?? 0) + 1
      )
    }
  })

  const summaries: TeamBonusSummary[] = []
  teamsSnap.forEach((d) => {
    const team = d.data()
    summaries.push({
      teamId: d.id,
      teamName: team.name,
      teamColor: team.color,
      zonesClaimedCount: claimedCounts.get(d.id) ?? 0,
      zonesWithChallengesCount: zonesWithChallengeCounts.get(d.id) ?? 0,
    })
  })

  return summaries.sort((a, b) => b.zonesClaimedCount - a.zonesClaimedCount)
}

// ---------------------------------------------------------------------------
// autoSelectMostZonesClaimed
// Returns team_id with most claimed zones. Null if tied at top.
// ---------------------------------------------------------------------------
export function autoSelectMostZonesClaimed(
  summaries: TeamBonusSummary[]
): string | null {
  if (summaries.length === 0) return null
  const sorted = [...summaries].sort(
    (a, b) => b.zonesClaimedCount - a.zonesClaimedCount
  )
  const top = sorted[0]
  const second = sorted[1]
  if (second && top.zonesClaimedCount === second.zonesClaimedCount) return null
  if (top.zonesClaimedCount === 0) return null
  return top.teamId
}

// ---------------------------------------------------------------------------
// autoSelectMostZonesWithChallenges
// Returns team_id with most zones where ≥1 challenge was completed. Null if tied.
// ---------------------------------------------------------------------------
export function autoSelectMostZonesWithChallenges(
  summaries: TeamBonusSummary[]
): string | null {
  if (summaries.length === 0) return null
  const sorted = [...summaries].sort(
    (a, b) => b.zonesWithChallengesCount - a.zonesWithChallengesCount
  )
  const top = sorted[0]
  const second = sorted[1]
  if (second && top.zonesWithChallengesCount === second.zonesWithChallengesCount) return null
  if (top.zonesWithChallengesCount === 0) return null
  return top.teamId
}

// ---------------------------------------------------------------------------
// applyEndGameBonuses
// Writes Side Quest points to the game doc and updates each team's total_points.
// Reads point values from game.settings — never hardcoded.
// Safe to call once — guarded by bonuses_applied flag.
// ---------------------------------------------------------------------------
export async function applyEndGameBonuses(
  gameId: string,
  awards: BonusAwards
): Promise<void> {
  const gameSnap = await getDoc(doc(db, 'games', gameId))
  if (!gameSnap.exists()) throw new Error('Game not found')
  const gameData = gameSnap.data()
  if (gameData.bonuses_applied) {
    throw new Error('Bonuses already applied for this game')
  }

  // Read point values from game.settings (with defaults)
  const settings = gameData.settings || {}
  const mostZonesClaimedBonus = settings.most_zones_claimed_bonus ?? 8
  const mostZonesWithChallengesBonus = settings.most_zones_with_challenges_bonus ?? 8

  // Build the award list in REVEAL order: photo side quests first (smaller,
  // more playful), then Most Zones Explored, then Most Zones Claimed as the
  // headline bonus. Ties / no pick are kept as entries with team_id null so
  // the reveal can say "nobody won this one".
  const sideQuestDefs: { id: string; title?: string; bonus_points?: number }[] = settings.side_quests ?? []
  const awardList: EndGameAward[] = []
  for (const quest of sideQuestDefs) {
    awardList.push({
      key: `sq_${quest.id}`,
      label: quest.title ?? quest.id,
      emoji: '🧩',
      team_id: awards.sideQuests?.[quest.id] ?? null,
      points: quest.bonus_points ?? 0,
    })
  }
  awardList.push({
    key: 'most_zones_with_challenges',
    label: 'Most Zones Explored',
    emoji: '🏆',
    team_id: awards.mostZonesWithChallenges,
    points: mostZonesWithChallengesBonus,
  })
  awardList.push({
    key: 'most_zones_claimed',
    label: 'Most Zones Claimed',
    emoji: '🗺️',
    team_id: awards.mostZonesClaimed,
    points: mostZonesClaimedBonus,
  })

  const bonusMap = new Map<string, number>()
  for (const a of awardList) {
    if (!a.team_id) continue
    bonusMap.set(a.team_id, (bonusMap.get(a.team_id) ?? 0) + a.points)
  }

  const bonusRecord: Record<string, number> = {}
  bonusMap.forEach((pts, teamId) => {
    bonusRecord[teamId] = pts
  })

  await updateDoc(doc(db, 'games', gameId), {
    end_game_bonuses: bonusRecord,
    bonuses_applied: true,
    end_game_awards: awardList,
    reveal_step: 0,
  })

  for (const [teamId, pts] of bonusMap) {
    const teamRef = doc(db, 'games', gameId, 'teams', teamId)
    const teamSnap = await getDoc(teamRef)
    if (teamSnap.exists()) {
      const current = teamSnap.data().total_points ?? 0
      await updateDoc(teamRef, { total_points: current + pts })
    }
  }
}
// Reveal step math lives in ./reveal (pure, no Firebase) so it can be unit
// tested; re-exported here for convenience.
export * from './reveal'
