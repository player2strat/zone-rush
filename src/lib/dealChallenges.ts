// =============================================================================
// Zone Rush — Challenge Dealing Logic
// Queries the challenge library, filters by game context, shuffles,
// enforces difficulty mix, and deals a hand to each team.
// =============================================================================

import {
  collection, getDocs, query, where, doc, updateDoc,
} from 'firebase/firestore'
import { db } from './firebase'

interface Challenge {
  id: string
  difficulty: string
  points: number
  city_tags: string[]
  zone_tags: string[]
  is_active: boolean
  [key: string]: any
}

// Fisher-Yates shuffle — fair random ordering
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Check that a hand has at least 2 different difficulty levels
function hasDifficultyMix(hand: Challenge[]): boolean {
  const difficulties = new Set(hand.map((c) => c.difficulty))
  return difficulties.size >= 2
}

/**
 * Deal challenge cards to all teams in a game.
 *
 * @param gameId - Firestore game document ID
 * @param city - City string (e.g. "nyc") for filtering challenges
 * @param zoneIds - Array of active zone IDs for this game
 * @param handSize - Number of cards per team (from game.settings.hand_size)
 * @param teamIds - Array of team document IDs to deal to
 */
export async function dealChallenges(
  gameId: string,
  city: string,
  zoneIds: string[],
  handSize: number,
  teamIds: string[]
): Promise<void> {
  // 1. Fetch all active challenges
  const challengesRef = collection(db, 'challenges')
  const q = query(challengesRef, where('is_active', '==', true))
  const snapshot = await getDocs(q)

  const allChallenges: Challenge[] = []
  snapshot.forEach((doc) => {
    allChallenges.push({ id: doc.id, ...doc.data() } as Challenge)
  })

  if (allChallenges.length === 0) {
    throw new Error('No active challenges found in the database')
  }

  // 2. Filter by city — challenge must include this city OR "*" (universal)
  const cityFiltered = allChallenges.filter((c) => {
    if (!c.city_tags || c.city_tags.length === 0) return true // no tags = works anywhere
    return c.city_tags.includes(city) || c.city_tags.includes('*')
  })

  // 3. Filter by zones — if challenge has zone_tags, at least one must be in the game's active zones
  //    Empty zone_tags = works in any zone
  const eligible = cityFiltered.filter((c) => {
    if (!c.zone_tags || c.zone_tags.length === 0) return true
    return c.zone_tags.some((zt) => zoneIds.includes(zt))
  })

  if (eligible.length < handSize) {
    throw new Error(
      `Only ${eligible.length} eligible challenges found, need at least ${handSize}. Check city_tags and zone_tags on your challenges.`
    )
  }

  // 4. Deal to each team independently (teams CAN get the same challenge)
  const dealPromises = teamIds.map(async (teamId) => {
    let hand: Challenge[] = []
    let attempts = 0
    const maxAttempts = 20

    // Keep shuffling until we get a hand with difficulty mix
    while (attempts < maxAttempts) {
      const shuffled = shuffle(eligible)
      hand = shuffled.slice(0, handSize)

      if (hasDifficultyMix(hand)) break
      attempts++
    }

    // If we couldn't get a mix after 20 tries (unlikely with 41 challenges),
    // just use whatever we have — better than failing
    const handIds = hand.map((c) => c.id)

    // Write to Firestore
    const teamRef = doc(db, 'games', gameId, 'teams', teamId)
    await updateDoc(teamRef, { hand: handIds })
  })

  await Promise.all(dealPromises)
}