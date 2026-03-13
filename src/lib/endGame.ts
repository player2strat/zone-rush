// =============================================================================
// Zone Rush — End-Game Bonus Logic
// Calculates and applies the 4 end-of-game bonus points.
// Called by the GM after the game ends.
//
// Bonus rules (all stored in game settings, never hardcoded):
//   +1  Most zones claimed  (auto-calculated from zone_scores)
//   +1  Fastest return to start  (GM selects team)
//   +1  Hydration bonus  (GM selects one or more teams)
//   +1  Most unique transport modes  (GM selects team)
//
// Bonuses are stored on the game doc:
//   end_game_bonuses: { [teamId]: number }
//   bonuses_applied: boolean
//
// The results screen reads end_game_bonuses and adds to each team's total.
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
  mostZones: string | null        // team_id — auto-calculated, GM confirms
  fastestReturn: string | null    // team_id — GM selects
  hydration: string[]             // team_ids — GM selects, can be multiple
  mostTransitModes: string | null // team_id — GM selects
}

export interface TeamBonusSummary {
  teamId: string
  teamName: string
  teamColor: string
  zonesClaimedCount: number       // used to auto-calculate mostZones
}

// ---------------------------------------------------------------------------
// getTeamBonusSummaries
// Returns the data the GM needs to award bonuses: zones claimed per team.
// Call this when the game ends to populate the bonus panel.
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

  // Count claimed zones per team
  const claimedCounts = new Map<string, number>()
  zoneScoresSnap.forEach((d) => {
    const data = d.data()
    if (data.status === 'claimed') {
      claimedCounts.set(
        data.team_id,
        (claimedCounts.get(data.team_id) ?? 0) + 1
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
    })
  })

  return summaries.sort((a, b) => b.zonesClaimedCount - a.zonesClaimedCount)
}

// ---------------------------------------------------------------------------
// autoSelectMostZones
// Returns the team_id of the team with the most claimed zones.
// Ties: returns null (GM must break the tie manually).
// ---------------------------------------------------------------------------
export function autoSelectMostZones(
  summaries: TeamBonusSummary[]
): string | null {
  if (summaries.length === 0) return null
  const top = summaries[0]
  const second = summaries[1]
  // Tie — GM must decide
  if (second && top.zonesClaimedCount === second.zonesClaimedCount) return null
  if (top.zonesClaimedCount === 0) return null
  return top.teamId
}

// ---------------------------------------------------------------------------
// applyEndGameBonuses
// Writes bonus points to the game doc and updates each team's total_points.
// Safe to call once — guarded by bonuses_applied flag.
// ---------------------------------------------------------------------------
export async function applyEndGameBonuses(
  gameId: string,
  awards: BonusAwards
): Promise<void> {
  // Guard: don't apply twice
  const gameSnap = await getDoc(doc(db, 'games', gameId))
  if (!gameSnap.exists()) throw new Error('Game not found')
  if (gameSnap.data().bonuses_applied) {
    throw new Error('Bonuses already applied for this game')
  }

  // Tally bonus points per team
  const bonusMap = new Map<string, number>()

  const addBonus = (teamId: string | null, pts: number) => {
    if (!teamId) return
    bonusMap.set(teamId, (bonusMap.get(teamId) ?? 0) + pts)
  }

  addBonus(awards.mostZones, 1)
  addBonus(awards.fastestReturn, 1)
  awards.hydration.forEach((teamId) => addBonus(teamId, 1))
  addBonus(awards.mostTransitModes, 1)

  // Convert map to plain object for Firestore
  const bonusRecord: Record<string, number> = {}
  bonusMap.forEach((pts, teamId) => {
    bonusRecord[teamId] = pts
  })

  // Write to game doc
  await updateDoc(doc(db, 'games', gameId), {
    end_game_bonuses: bonusRecord,
    bonuses_applied: true,
  })

  // Update each team's total_points
  for (const [teamId, pts] of bonusMap) {
    const teamRef = doc(db, 'games', gameId, 'teams', teamId)
    const teamSnap = await getDoc(teamRef)
    if (teamSnap.exists()) {
      const current = teamSnap.data().total_points ?? 0
      await updateDoc(teamRef, { total_points: current + pts })
    }
  }
}