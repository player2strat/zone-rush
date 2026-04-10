// =============================================================================
// Zone Rush — Scoring Engine (Sprint 1)
//
// Handles all point calculation and zone ownership logic:
//  - approveSubmission()   Points calc + zone claim/steal on GM approval
//  - rejectSubmission()    Mark rejected, no points change
//  - checkZoneLockouts()   Time-based zone lockdown (Zone Lock #2)
//  - validateSubmissionZone() GPS zone check at submission time
//  - getZoneOwnershipMap() Returns zoneId → team color/name for the map
//
// All thresholds come from game.settings — nothing is hardcoded here.
//
// FIX NOTES:
//  - ZoneScore docs are always read as { id: d.id, ...d.data() } so id is never undefined
//  - currentHolder typed as ZoneScore (not null) inside the steal block via local var
//  - Removed duplicate winnerTeamRef variable names in lockZone
// =============================================================================

import {
  collection, doc, getDoc, getDocs,
  updateDoc, query, where, serverTimestamp, writeBatch,
} from 'firebase/firestore'
import { db } from './firebase'
import { isPointInPolygon } from './geo'
import type { GameSettings, ZoneScore, Submission, Zone, Team } from '../types/game'

// ─── Point Values ─────────────────────────────────────────────────────────────

const DIFFICULTY_POINTS: Record<string, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
}

const PHONE_FREE_BONUS = 1        // No phones used
const PHONE_FREE_SILENT_BONUS = 2 // No phones AND no talking (replaces, not stacks)

// ─── Helper: read a ZoneScore doc with its id included ───────────────────────

function toZoneScore(docSnap: { id: string; data: () => any }): ZoneScore {
  return { id: docSnap.id, ...docSnap.data() } as ZoneScore
}

// ─── Approve Submission ───────────────────────────────────────────────────────

/**
 * Called when a GM approves a submission.
 *
 * What it does:
 *  1. Calculates points (difficulty + tier2 bonus + phone-free bonus)
 *  2. Gets or creates the zone_score record for this team/zone
 *  3. Checks for zone claim (team reaches claim_threshold)
 *  4. Checks for zone steal (team overtakes current holder)
 *  5. Awards zone_bonus_points on first-ever claim of a zone
 *  6. Updates team.total_points and team.zones_claimed
 *  7. Marks submission approved with points_awarded set
 *
 * @param submissionId      - Firestore submission document ID
 * @param reviewedByUid     - UID of the GM approving
 * @param tier2Approved     - Whether the GM approved the tier 2 bonus
 * @param phoneFreeApproved - Whether the GM confirms phone-free bonus
 */
export async function approveSubmission(
  submissionId: string,
  reviewedByUid: string,
  tier2Approved: boolean = false,
  phoneFreeApproved: boolean = false
): Promise<{ pointsAwarded: number; zoneClaimed: boolean; zoneStolen: boolean }> {

  // 1. Load the submission
  const subRef = doc(db, 'submissions', submissionId)
  const subSnap = await getDoc(subRef)
  if (!subSnap.exists()) throw new Error('Submission not found')
  const submission = { id: submissionId, ...subSnap.data() } as Submission

  if (submission.status !== 'pending') {
    throw new Error(`Submission is already ${submission.status}`)
  }

  const { game_id, team_id, zone_id, challenge_id } = submission

  // 2. Load game settings
  const gameSnap = await getDoc(doc(db, 'games', game_id))
  if (!gameSnap.exists()) throw new Error('Game not found')
  const settings = gameSnap.data().settings as GameSettings
  const claimThreshold = settings.claim_threshold ?? 6
  const lockThreshold = settings.lock_threshold ?? 10 
  const zoneBonusPoints = settings.zone_bonus_points ?? 3

  // 3. Load the challenge to get difficulty + tier2 info
  const challengeSnap = await getDoc(doc(db, 'challenges', challenge_id))
  if (!challengeSnap.exists()) throw new Error('Challenge not found')
  const challenge = challengeSnap.data()

  // 4. Calculate points earned
  const difficultyKey = (challenge.difficulty ?? 'easy').toLowerCase()
  let points = DIFFICULTY_POINTS[difficultyKey] ?? 1

  if (tier2Approved && challenge.tier2?.bonus_points) {
    points += challenge.tier2.bonus_points
  }

  if (phoneFreeApproved) {
    points += PHONE_FREE_SILENT_BONUS
  } else if (submission.phone_free_claimed) {
    points += PHONE_FREE_BONUS
  }

  // 5. Get or create this team's zone_score record
  // IMPORTANT: always construct id as composite key — never rely on Firestore auto-id
  const zoneScoreId = `${team_id}__${zone_id}`
  const zoneScoreRef = doc(db, 'games', game_id, 'zone_scores', zoneScoreId)
  const zoneScoreSnap = await getDoc(zoneScoreRef)

  const prevScore: ZoneScore = zoneScoreSnap.exists()
    ? toZoneScore(zoneScoreSnap)
    : {
        id: zoneScoreId,
        team_id,
        zone_id,
        points: 0,
        status: 'none',
        challenges_completed: [],
      }

  const newPoints = prevScore.points + points
  const alreadyClaimed = prevScore.status === 'claimed'

  // 6. Find who currently holds this zone (other teams)
  const allZoneScoresSnap = await getDocs(
    query(
      collection(db, 'games', game_id, 'zone_scores'),
      where('zone_id', '==', zone_id)
    )
  )

  let currentHolderScore: ZoneScore | null = null
  let zoneBonusAlreadyAwarded = false

  allZoneScoresSnap.forEach((d) => {
    const zs = toZoneScore(d)
    if (zs.status === 'claimed' && zs.team_id !== team_id) {
      currentHolderScore = zs
    }
    if (zs.status === 'claimed') {
      zoneBonusAlreadyAwarded = true
    }
  })

  // 7. Determine claim / steal
  let zoneClaimed = false
  let zoneStolen = false
  let bonusPoints = 0

  const alreadyLocked = prevScore.status === 'locked'
  if (newPoints >= claimThreshold && !alreadyClaimed && !alreadyLocked) {
    zoneClaimed = true

    // Use a local non-null variable so TypeScript is happy
    if (currentHolderScore !== null) {
      const holder: ZoneScore = currentHolderScore
      zoneStolen = true

      // Remove claim from previous holder
      await updateDoc(
        doc(db, 'games', game_id, 'zone_scores', holder.id),
        { status: 'none' }
      )

      // Decrement previous holder's zones_claimed
      const holderTeamRef = doc(db, 'games', game_id, 'teams', holder.team_id)
      const holderTeamSnap = await getDoc(holderTeamRef)
      if (holderTeamSnap.exists()) {
        const prev = holderTeamSnap.data().zones_claimed ?? 0
        await updateDoc(holderTeamRef, { zones_claimed: Math.max(0, prev - 1) })
      }
    }

    // First-ever claim on this zone gets the zone bonus
    if (!zoneBonusAlreadyAwarded) {
      bonusPoints = zoneBonusPoints
      points += bonusPoints
    }
  }

  // 8. Write everything atomically
  const batch = writeBatch(db)

  // Update zone_score
  batch.set(zoneScoreRef, {
    ...prevScore,
    points: newPoints + bonusPoints,
    status: newPoints >= lockThreshold ? 'locked' : zoneClaimed ? 'claimed' : prevScore.status,
    challenges_completed: [
      ...prevScore.challenges_completed,
      challenge_id,
    ],
  })

  // Mark submission approved
  batch.update(subRef, {
    status: 'approved',
    tier2_approved: tier2Approved,
    phone_free_approved: phoneFreeApproved,
    points_awarded: points,
    reviewed_by: reviewedByUid,
    reviewed_at: serverTimestamp(),
  })

  // Update team totals
  const teamRef = doc(db, 'games', game_id, 'teams', team_id)
  const teamSnap = await getDoc(teamRef)
  if (teamSnap.exists()) {
    const teamData = teamSnap.data() as Team
    batch.update(teamRef, {
      total_points: (teamData.total_points ?? 0) + points,
      zones_claimed: zoneClaimed
        ? (teamData.zones_claimed ?? 0) + 1
        : (teamData.zones_claimed ?? 0),
    })
  }

  await batch.commit()

  return { pointsAwarded: points, zoneClaimed, zoneStolen }
}

// ─── Reject Submission ────────────────────────────────────────────────────────

/**
 * GM rejects a submission. No points are awarded or changed.
 * Rejected submissions do NOT count toward the discard unlock threshold.
 */
export async function rejectSubmission(
  submissionId: string,
  gmNotes: string,
  reviewedByUid: string
): Promise<void> {
  const subRef = doc(db, 'submissions', submissionId)
  await updateDoc(subRef, {
    status: 'rejected',
    gm_notes: gmNotes,
    reviewed_by: reviewedByUid,
    reviewed_at: serverTimestamp(),
    points_awarded: 0,
  })
}

// ─── Zone Lockout (Zone Lock #2 — time-based shrinking map) ──────────────────

/**
 * Check whether any zones should lock based on the game's zone_schedule.
 * Call this on a timer (every 60s) and on game state changes.
 *
 * Lockout rules (decided Mar 9):
 *  - Single leader → that team wins the zone
 *  - Tied          → zone closes unclaimed
 *  - Untouched     → zone closes unclaimed
 *
 * @returns Array of zone IDs locked in this call (empty if none)
 */
export async function checkZoneLockouts(gameId: string): Promise<string[]> {
  const gameSnap = await getDoc(doc(db, 'games', gameId))
  if (!gameSnap.exists()) return []

  const gameData = gameSnap.data()
  const settings = gameData.settings as GameSettings
  const schedule = settings?.zone_schedule ?? []
  if (schedule.length === 0) return []

  const startedAt: number | null = gameData.started_at?.toMillis?.() ?? null
  const endsAt: number | null = gameData.ends_at?.toMillis?.() ?? null
  if (!startedAt || !endsAt) return []

  const elapsedPct = Math.min(100, ((Date.now() - startedAt) / (endsAt - startedAt)) * 100)
  const alreadyLocked: string[] = gameData.locked_zones ?? []
  const newlyLocked: string[] = []

  for (const entry of schedule) {
    if (alreadyLocked.includes(entry.zone_id)) continue
    if (elapsedPct < entry.lock_at_pct) continue

    await lockZone(gameId, entry.zone_id, settings)
    newlyLocked.push(entry.zone_id)
  }

  if (newlyLocked.length > 0) {
    await updateDoc(doc(db, 'games', gameId), {
      locked_zones: [...alreadyLocked, ...newlyLocked],
    })
  }

  return newlyLocked
}

// ─── Zone Closures (time-based, minutes remaining) ───────────────────────────

/**
 * Check whether any zones should close based on minutes remaining in the game.
 * Closed zones accept no new submissions — existing points and claims are kept.
 *
 * Reads zone_close_schedule from game.settings:
 *   [{ zone_id: 'zone_district_33', closes_at_minutes_remaining: 90 }, ...]
 *
 * Writes closed zone IDs to game.closed_zones array.
 *
 * @returns Array of zone IDs closed in this call (empty if none)
 */
export async function checkZoneClosures(gameId: string): Promise<string[]> {
  const gameSnap = await getDoc(doc(db, 'games', gameId))
  if (!gameSnap.exists()) return []

  const gameData = gameSnap.data()
  const settings = gameData.settings as GameSettings

  // Reads close_at_minutes — minutes ELAPSED since game start
  const schedule: { zone_id: string; close_at_minutes: number }[] =
    settings?.zone_close_schedule ?? []

  if (schedule.length === 0) return []

  const startedAt: number | null = gameData.started_at?.toMillis?.() ?? null
  if (!startedAt) return []

  const minutesElapsed = (Date.now() - startedAt) / 60000
  const alreadyClosed: string[] = gameData.closed_zones ?? []
  const newlyClosed: string[] = []

  for (const entry of schedule) {
    if (alreadyClosed.includes(entry.zone_id)) continue
    // Close the zone once enough time has elapsed
    if (minutesElapsed < entry.close_at_minutes) continue
    newlyClosed.push(entry.zone_id)
  }

  if (newlyClosed.length > 0) {
    await updateDoc(doc(db, 'games', gameId), {
      closed_zones: [...alreadyClosed, ...newlyClosed],
    })
  }

  return newlyClosed
}

/**
 * Lock a single zone and award it to the leading team (if unambiguous).
 * Internal helper — called by checkZoneLockouts.
 */
async function lockZone(
  gameId: string,
  zoneId: string,
  settings: GameSettings
): Promise<void> {
  const zoneScoresSnap = await getDocs(
    query(
      collection(db, 'games', gameId, 'zone_scores'),
      where('zone_id', '==', zoneId)
    )
  )

  const scores: ZoneScore[] = []
  zoneScoresSnap.forEach((d) => scores.push(toZoneScore(d)))

  // Untouched or all-zero — close unclaimed, nothing to write
  if (scores.length === 0) return
  const topScore = Math.max(...scores.map((s) => s.points))
  if (topScore === 0) return

  const leaders = scores.filter((s) => s.points === topScore)
  const batch = writeBatch(db)

  if (leaders.length > 1) {
    // Tied — all locked_out, nobody wins
    for (const score of scores) {
      batch.update(
        doc(db, 'games', gameId, 'zone_scores', score.id),
        { status: 'locked_out' }
      )
    }
    await batch.commit()
    return
  }

  // Single winner
  const winner = leaders[0]
  const alreadyClaimed = winner.status === 'claimed'

  // Mark winner as claimed, everyone else locked_out
  batch.update(
    doc(db, 'games', gameId, 'zone_scores', winner.id),
    { status: 'claimed' }
  )
  for (const score of scores) {
    if (score.team_id !== winner.team_id) {
      batch.update(
        doc(db, 'games', gameId, 'zone_scores', score.id),
        { status: 'locked_out' }
      )
    }
  }

  if (!alreadyClaimed) {
    // Increment winner's zones_claimed
    const winnerTeamRef = doc(db, 'games', gameId, 'teams', winner.team_id)
    const winnerTeamSnap = await getDoc(winnerTeamRef)

    if (winnerTeamSnap.exists()) {
      const teamData = winnerTeamSnap.data()
      batch.update(winnerTeamRef, {
        zones_claimed: (teamData.zones_claimed ?? 0) + 1,
      })

      // Award zone_bonus_points if nobody had previously claimed this zone
      const anyPreviousClaim = scores.some(
        (s) => s.status === 'claimed' && s.team_id !== winner.team_id
      )
      if (!anyPreviousClaim) {
        const bonus = settings.zone_bonus_points ?? 3
        batch.update(
          doc(db, 'games', gameId, 'zone_scores', winner.id),
          { points: winner.points + bonus }
        )
        batch.update(winnerTeamRef, {
          total_points: (teamData.total_points ?? 0) + bonus,
        })
      }
    }
  }

  await batch.commit()
}

// ─── GPS Zone Validation ──────────────────────────────────────────────────────

/**
 * Check whether a GPS coordinate is inside a zone boundary.
 * Used at submission time — result stored as submission.in_zone.
 * GM sees a warning on the review card if in_zone is false.
 */
export function validateSubmissionZone(
  lat: number | null,
  lng: number | null,
  zone: Zone
): { inZone: boolean } {
  if (!lat || !lng) return { inZone: false }
  return { inZone: isPointInPolygon(lat, lng, zone.boundary.coordinates) }
}

// ─── Zone Ownership Map ───────────────────────────────────────────────────────

/**
 * Returns a Map of zoneId → { teamColor, teamName } for all currently claimed zones.
 * Passed to <GameMap zoneOwnership={...} /> to color zones with team colors.
 */
export async function getZoneOwnershipMap(
  gameId: string
): Promise<Map<string, { teamColor: string; teamName: string }>> {
  const ownershipMap = new Map<string, { teamColor: string; teamName: string }>()

  const claimedSnap = await getDocs(
    query(
      collection(db, 'games', gameId, 'zone_scores'),
      where('status', '==', 'claimed')
    )
  )

  if (claimedSnap.empty) return ownershipMap

  // Collect unique team IDs
  const teamIds = new Set<string>()
  claimedSnap.forEach((d) => teamIds.add(d.data().team_id as string))

  // Fetch team colors + names in parallel
  const teamData = new Map<string, { color: string; name: string }>()
  await Promise.all(
    Array.from(teamIds).map(async (teamId) => {
      const teamSnap = await getDoc(doc(db, 'games', gameId, 'teams', teamId))
      if (teamSnap.exists()) {
        const data = teamSnap.data()
        teamData.set(teamId, {
          color: data.color ?? '#ffffff',
          name: data.name ?? 'Unknown Team',
        })
      }
    })
  )

  claimedSnap.forEach((d) => {
    const score = toZoneScore(d)
    const team = teamData.get(score.team_id)
    if (team) {
      ownershipMap.set(score.zone_id, {
        teamColor: team.color,
        teamName: team.name,
      })
    }
  })

  return ownershipMap
}