// =============================================================================
// Zone Rush — End-Game Bonus Logic (Side Quests)
//
// Side Quest rules (stored in game settings, never hardcoded):
//   +8  Most zones claimed               (auto-calculated from zone_scores)
//   +8  Most zones with ≥1 challenge     (auto-calculated from zone_scores)
//
// Bonuses stored on the game doc:
//   end_game_bonuses: { [teamId]: number }
//   bonuses_applied: boolean
// =============================================================================

import {
  doc,
  getDoc,
  updateDoc,
  collection,
  getDocs,
} from 'firebase/firestore'
import { db } from './firebase'

export interface BonusAwards {
  mostZonesClaimed: string | null        // team with most claimed zones
  mostZonesWithChallenges: string | null // team with most zones where ≥1 challenge completed
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

    // Count claimed zones
    if (data.status === 'claimed') {
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

  const bonusMap = new Map<string, number>()

  const addBonus = (teamId: string | null, pts: number) => {
    if (!teamId) return
    bonusMap.set(teamId, (bonusMap.get(teamId) ?? 0) + pts)
  }

  addBonus(awards.mostZonesClaimed, mostZonesClaimedBonus)
  addBonus(awards.mostZonesWithChallenges, mostZonesWithChallengesBonus)

  const bonusRecord: Record<string, number> = {}
  bonusMap.forEach((pts, teamId) => {
    bonusRecord[teamId] = pts
  })

  await updateDoc(doc(db, 'games', gameId), {
    end_game_bonuses: bonusRecord,
    bonuses_applied: true,
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