// =============================================================================
// Zone Rush — Challenge Dealing Logic
//
// Two exported functions:
//   dealChallenges()       — deals initial hands to all teams at game start
//   drawReplacementCard()  — draws one replacement card after a challenge is
//                            completed or approved. Respects hand composition
//                            rules and avoids re-dealing used/discarded cards.
//
// Both functions read composition rules from game.settings (passed in by the
// caller). Never hardcoded here.
// =============================================================================

import {
  collection, getDocs, query, where,
  doc, updateDoc, getDoc,
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

// --------------- Composition Rules ---------------

export interface HandCompositionRules {
  minEasy: number  // minimum Easy cards required in hand
  minHard: number  // minimum Hard cards required in hand
  maxHard: number  // maximum Hard cards allowed in hand
}

const DEFAULT_RULES: HandCompositionRules = {
  minEasy: 1,
  minHard: 1,
  maxHard: 2,
}

// --------------- Helpers ---------------

// Fisher-Yates shuffle — fair random ordering
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// A hand is valid if it satisfies all composition rules
function isValidHand(hand: Challenge[], rules: HandCompositionRules): boolean {
  const easyCount = hand.filter((c) => c.difficulty.toLowerCase() === 'easy').length
  const hardCount = hand.filter((c) => c.difficulty.toLowerCase() === 'hard').length
  return (
    easyCount >= rules.minEasy &&
    hardCount >= rules.minHard &&
    hardCount <= rules.maxHard
  )
}

// --------------- Initial Deal ---------------

/**
 * Deal challenge cards to all teams in a game.
 * Each team gets handSize cards. Teams CAN receive the same challenge
 * as another team (no global dedup by design).
 *
 * @param gameId           - Firestore game document ID
 * @param city             - City string (e.g. "nyc") for filtering
 * @param zoneIds          - Active zone IDs for this game
 * @param handSize         - Cards per team (from game.settings.hand_size)
 * @param teamIds          - Team document IDs to deal to
 * @param compositionRules - Optional hand composition rules (falls back to defaults)
 */
export async function dealChallenges(
  gameId: string,
  city: string,
  zoneIds: string[],
  handSize: number,
  teamIds: string[],
  compositionRules?: HandCompositionRules
): Promise<void> {
  const rules: HandCompositionRules = compositionRules ?? DEFAULT_RULES

  // 1. Fetch all active challenges
  const challengesRef = collection(db, 'challenges')
  const q = query(challengesRef, where('is_active', '==', true))
  const snapshot = await getDocs(q)

  const allChallenges: Challenge[] = []
  snapshot.forEach((d) => {
    allChallenges.push({ id: d.id, ...d.data() } as Challenge)
  })

  if (allChallenges.length === 0) {
    throw new Error('No active challenges found in the database')
  }

  // 2. Filter by city
  const cityFiltered = allChallenges.filter((c) => {
    if (!c.city_tags || c.city_tags.length === 0) return true
    return c.city_tags.includes(city) || c.city_tags.includes('*')
  })

  // 3. Filter by zones
  const eligible = cityFiltered.filter((c) => {
    if (!c.zone_tags || c.zone_tags.length === 0) return true
    return c.zone_tags.some((zt) => zoneIds.includes(zt))
  })

  if (eligible.length < handSize) {
    throw new Error(
      `Only ${eligible.length} eligible challenges found, need at least ${handSize}.`
    )
  }

  // 4. Validate pool has enough cards for composition rules
  const easyInPool = eligible.filter((c) => c.difficulty.toLowerCase() === 'easy').length
  const hardInPool = eligible.filter((c) => c.difficulty.toLowerCase() === 'hard').length

  if (rules.minEasy > 0 && easyInPool < rules.minEasy) {
    throw new Error(
      `Hand requires ≥${rules.minEasy} Easy card(s) but only ${easyInPool} Easy challenge(s) exist in the pool.`
    )
  }
  if (rules.minHard > 0 && hardInPool < rules.minHard) {
    throw new Error(
      `Hand requires ≥${rules.minHard} Hard card(s) but only ${hardInPool} Hard challenge(s) exist in the pool.`
    )
  }

  // 5. Deal to each team independently
  const dealPromises = teamIds.map(async (teamId) => {
    let hand: Challenge[] = []
    let attempts = 0
    const maxAttempts = 50

    while (attempts < maxAttempts) {
      const shuffled = shuffle(eligible)
      const candidate = shuffled.slice(0, handSize)
      if (isValidHand(candidate, rules)) {
        hand = candidate
        break
      }
      attempts++
    }

    // Last resort: build manually
    if (!isValidHand(hand, rules)) {
      const easyCards = shuffle(eligible.filter((c) => c.difficulty.toLowerCase() === 'easy'))
      const hardCards = shuffle(eligible.filter((c) => c.difficulty.toLowerCase() === 'hard'))
      const mediumCards = shuffle(eligible.filter((c) => c.difficulty.toLowerCase() === 'medium'))

      const built: Challenge[] = []
      for (let i = 0; i < rules.minEasy && easyCards[i]; i++) built.push(easyCards[i])
      for (let i = 0; i < rules.minHard && hardCards[i]; i++) built.push(hardCards[i])

      const currentHardCount = built.filter((c) => c.difficulty.toLowerCase() === 'hard').length
      const fillers = shuffle([
        ...easyCards.slice(rules.minEasy),
        ...mediumCards,
        ...hardCards.slice(rules.minHard, rules.maxHard - currentHardCount + rules.minHard),
      ])
      built.push(...fillers.slice(0, handSize - built.length))
      hand = built.slice(0, handSize)
    }

    const handIds = hand.map((c) => c.id)
    const teamRef = doc(db, 'games', gameId, 'teams', teamId)
    await updateDoc(teamRef, { hand: handIds, discard_used: 0 })
  })

  await Promise.all(dealPromises)
}

// --------------- Replacement Card Draw ---------------

/**
 * After a challenge is approved, remove it from the team's hand and draw
 * a replacement card. Respects hand composition rules and avoids cards
 * the team has already used, discarded, or currently holds.
 *
 * Returns the drawn card ID (or null if no eligible cards remain).
 * Also updates the team's hand in Firestore.
 *
 * @param gameId            - Firestore game document ID
 * @param teamId            - Team document ID
 * @param completedCardId   - Challenge ID that was just completed
 * @param compositionRules  - Hand composition rules from game.settings
 */
export async function drawReplacementCard(
  gameId: string,
  teamId: string,
  completedCardId: string,
  compositionRules?: HandCompositionRules
): Promise<string | null> {
  const rules = compositionRules ?? DEFAULT_RULES

  // 1. Read team's current hand
  const teamRef = doc(db, 'games', gameId, 'teams', teamId)
  const teamSnap = await getDoc(teamRef)
  if (!teamSnap.exists()) return null

  const teamData = teamSnap.data()
  const currentHand: string[] = teamData.hand || []
  const discardedChallenges: string[] = teamData.discarded_challenges || []

  // Remove the completed challenge from hand
  const updatedHand = currentHand.filter((id) => id !== completedCardId)

  // 2. Gather all challenge IDs this team has already used
  const usedIds = new Set<string>()

  // From submissions (completed/attempted challenges)
  const subsSnap = await getDocs(
    query(
      collection(db, 'submissions'),
      where('game_id', '==', gameId),
      where('team_id', '==', teamId)
    )
  )
  subsSnap.forEach((d) => usedIds.add(d.data().challenge_id))

  // Cards still in hand
  updatedHand.forEach((id) => usedIds.add(id))

  // Discarded cards (never recycled back)
  discardedChallenges.forEach((id) => usedIds.add(id))

  // 3. Fetch all active challenges and filter to eligible ones
  const challengesSnap = await getDocs(
    query(collection(db, 'challenges'), where('is_active', '==', true))
  )

  const allChallenges = new Map<string, Challenge>()
  challengesSnap.forEach((d) => {
    allChallenges.set(d.id, { id: d.id, ...d.data() } as Challenge)
  })

  // Read game doc for city
  const gameSnap = await getDoc(doc(db, 'games', gameId))
  const gameCity = gameSnap.exists() ? gameSnap.data().city || 'nyc' : 'nyc'

  const eligible: string[] = []
  allChallenges.forEach((ch, chId) => {
    if (usedIds.has(chId)) return
    if (!ch.points) return
    const cityTags = ch.city_tags || ['*']
    if (!cityTags.includes('*') && !cityTags.includes(gameCity)) return
    eligible.push(chId)
  })

  // 4. If no eligible cards remain, just update the hand without a replacement
  if (eligible.length === 0) {
    await updateDoc(teamRef, { hand: updatedHand })
    return null
  }

  // 5. Apply composition rules to prefer the right difficulty
  const remainingEasy = updatedHand.filter(
    (id) => allChallenges.get(id)?.difficulty === 'easy'
  ).length
  const remainingHard = updatedHand.filter(
    (id) => allChallenges.get(id)?.difficulty === 'hard'
  ).length

  let preferredDiff: 'easy' | 'hard' | 'not_hard' | null = null
  if (remainingEasy < rules.minEasy) preferredDiff = 'easy'
  else if (remainingHard < rules.minHard) preferredDiff = 'hard'
  else if (remainingHard >= rules.maxHard) preferredDiff = 'not_hard'

  const preferred = eligible.filter((id) => {
    const diff = allChallenges.get(id)?.difficulty
    if (preferredDiff === 'easy') return diff === 'easy'
    if (preferredDiff === 'hard') return diff === 'hard'
    if (preferredDiff === 'not_hard') return diff !== 'hard'
    return true
  })

  const drawPool = preferred.length > 0 ? preferred : eligible
  const drawnCardId = drawPool[Math.floor(Math.random() * drawPool.length)]

  // 6. Update hand in Firestore
  updatedHand.push(drawnCardId)
  await updateDoc(teamRef, { hand: updatedHand })

  return drawnCardId
}