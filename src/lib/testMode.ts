// =============================================================================
// Foray — Test mode helpers (GM/admin only)
//
// Lets a GM rehearse a game without real players:
//   - createTestTeam()        adds a team with fake members so Start Game will
//                             deal it a hand and it shows on the scoreboard.
//   - createTestSubmissions() files pending proof submissions for teams that
//                             hold a hand, in random live zones, using a
//                             placeholder image, so the review queue, zone
//                             claims, broadcasts and results can be exercised.
//
// Everything written here is tagged `is_test: true` so it can be told apart
// from real play. Security rules allow these writes for admin/GM only.
// =============================================================================

import {
  collection, doc, getDoc, setDoc, addDoc, serverTimestamp,
} from 'firebase/firestore'
import center from '@turf/center'
import { db } from './firebase'
import { defaultTeamName, defaultTeamColor } from './teamDefaults'
import { isPointInPolygon } from './geo'

const TEST_NAMES = ['Ada', 'Blair', 'Cam', 'Dev', 'Eli', 'Fin', 'Gale', 'Hux', 'Ira', 'Jo']

export const TEST_MEDIA_PATH = '/icon-512.png'

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Create a team with `playerCount` fake members. Fake member UIDs are
 * prefixed `test_` and never match a real auth user.
 */
export async function createTestTeam(
  gameId: string,
  existingTeamCount: number,
  playerCount = 2
): Promise<string> {
  const index = existingTeamCount
  const teamId = `team_${index + 1}`
  const stamp = Date.now().toString(36)
  const members = Array.from({ length: playerCount }, (_, i) => `test_${stamp}_${i + 1}`)
  const used = new Set<string>()
  const member_names = members.map(() => {
    let name = pick(TEST_NAMES)
    while (used.has(name)) name = pick(TEST_NAMES)
    used.add(name)
    return `${name} (test)`
  })

  await setDoc(doc(db, 'games', gameId, 'teams', teamId), {
    id: teamId,
    name: `${defaultTeamName(index)} (test)`,
    members,
    member_names,
    color: defaultTeamColor(index),
    total_points: 0,
    zones_claimed: 0,
    zones_locked: 0,
    taxi_used: false,
    hand: [],
    is_test: true,
  })
  return teamId
}

export interface TestSubmissionTeam { id: string; hand?: string[] }
export interface TestSubmissionZone { id: string; boundary: GeoJSON.Geometry | null }

/**
 * File `count` pending submissions spread across teams that hold cards.
 * Each one picks a random card from the team's hand and a random live zone,
 * and places the GPS fix at that zone's centre. Returns how many were made.
 */
export async function createTestSubmissions(
  gameId: string,
  gmUid: string,
  teams: TestSubmissionTeam[],
  zones: TestSubmissionZone[],
  count = 3
): Promise<number> {
  const teamsWithHands = teams.filter((t) => (t.hand?.length ?? 0) > 0)
  const usableZones = zones.filter((z) => z.boundary && 'coordinates' in z.boundary)
  if (teamsWithHands.length === 0 || usableZones.length === 0) return 0

  const mediaUrl = `${window.location.origin}${TEST_MEDIA_PATH}`
  let made = 0

  for (let i = 0; i < count; i++) {
    const team = pick(teamsWithHands)
    const challengeId = pick(team.hand!)
    const zone = pick(usableZones)

    const challengeSnap = await getDoc(doc(db, 'challenges', challengeId))
    const challenge = challengeSnap.exists() ? challengeSnap.data() : null

    let lat: number | null = null
    let lng: number | null = null
    try {
      const c = center({ type: 'Feature', properties: {}, geometry: zone.boundary! })
      ;[lng, lat] = c.geometry.coordinates
    } catch {
      /* leave GPS null */
    }
    const coords = (zone.boundary as { coordinates?: unknown }).coordinates
    const inZone = lat !== null && lng !== null && isPointInPolygon(lat, lng, coords)

    await addDoc(collection(db, 'submissions'), {
      game_id: gameId,
      team_id: team.id,
      challenge_id: challengeId,
      challenge_description: challenge?.description ?? 'Test challenge',
      challenge_difficulty: challenge?.difficulty ?? 'medium',
      zone_id: zone.id,
      submitted_by: gmUid,
      media_url: mediaUrl,
      media_type: 'photo',
      gps_lat: lat,
      gps_lng: lng,
      gps_accuracy: 12,
      gps_captured_at: Date.now(),
      in_zone: inZone,
      status: 'pending',
      gm_notes: '',
      reviewed_by: null,
      reviewed_at: null,
      attempted_tier2: false,
      tier2_approved: false,
      phone_free_claimed: false,
      is_test: true,
      submitted_at: serverTimestamp(),
    })
    made++
  }
  return made
}
