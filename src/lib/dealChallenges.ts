// =============================================================================
// Zone Rush — Challenge Dealing Logic
//
// CHANGES:
// - NEW: HandCompositionRules type — minEasy, minHard, maxHard
// - CHANGED: dealChallenges accepts optional compositionRules param
// - CHANGED: isValidHand uses rules instead of hardcoded checks
// - CHANGED: last-resort hand builder respects rules
// - CHANGED: pool validation checks minEasy + minHard against available pool
// =============================================================================

import {
  collection, getDocs, query, where,
  doc, updateDoc,
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

// --------------- Main Deal Function ---------------

/**
 * Deal challenge cards to all teams in a game.
 * Each team gets handSize cards. Teams CAN receive the same challenge
 * as another team (no global dedup by design).
 *
 * Hand rules enforced via compositionRules (defaults if not passed):
 *  - minEasy: minimum Easy cards per hand
 *  - minHard: minimum Hard cards per hand
 *  - maxHard: maximum Hard cards per hand
 *
 * All rules are stored in game.settings and passed in from LobbyPage —
 * never hardcoded here.
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
  // Use provided rules or fall back to defaults
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

  // 2. Filter by city — challenge must include this city OR "*" (universal)
  const cityFiltered = allChallenges.filter((c) => {
    if (!c.city_tags || c.city_tags.length === 0) return true
    return c.city_tags.includes(city) || c.city_tags.includes('*')
  })

  // 3. Filter by zones — empty zone_tags = works anywhere
  const eligible = cityFiltered.filter((c) => {
    if (!c.zone_tags || c.zone_tags.length === 0) return true
    return c.zone_tags.some((zt) => zoneIds.includes(zt))
  })

  if (eligible.length < handSize) {
    throw new Error(
      `Only ${eligible.length} eligible challenges found, need at least ${handSize}.`
    )
  }

  // 4. Validate pool has enough cards to satisfy composition rules
  const easyInPool = eligible.filter((c) => c.difficulty.toLowerCase() === 'easy').length
  const hardInPool = eligible.filter((c) => c.difficulty.toLowerCase() === 'hard').length

  if (rules.minEasy > 0 && easyInPool < rules.minEasy) {
    throw new Error(
      `Hand requires ≥${rules.minEasy} Easy card(s) but only ${easyInPool} Easy challenge(s) exist in the pool. Add more Easy challenges or lower minEasy.`
    )
  }
  if (rules.minHard > 0 && hardInPool < rules.minHard) {
    throw new Error(
      `Hand requires ≥${rules.minHard} Hard card(s) but only ${hardInPool} Hard challenge(s) exist in the pool. Add more Hard challenges or lower minHard.`
    )
  }

  // 5. Deal to each team independently
  const dealPromises = teamIds.map(async (teamId) => {
    let hand: Challenge[] = []
    let attempts = 0
    const maxAttempts = 50

    // Try random shuffles first — usually succeeds quickly
    while (attempts < maxAttempts) {
      const shuffled = shuffle(eligible)
      const candidate = shuffled.slice(0, handSize)

      if (isValidHand(candidate, rules)) {
        hand = candidate
        break
      }
      attempts++
    }

    // Last resort: build a valid hand manually by placing required cards first,
    // then filling remaining slots while respecting maxHard
    if (!isValidHand(hand, rules)) {
      const easyCards = shuffle(eligible.filter((c) => c.difficulty.toLowerCase() === 'easy'))
      const hardCards = shuffle(eligible.filter((c) => c.difficulty.toLowerCase() === 'hard'))
      const mediumCards = shuffle(eligible.filter((c) => c.difficulty.toLowerCase() === 'medium'))

      const built: Challenge[] = []

      // Place required minimums first
      for (let i = 0; i < rules.minEasy && easyCards[i]; i++) {
        built.push(easyCards[i])
      }
      for (let i = 0; i < rules.minHard && hardCards[i]; i++) {
        built.push(hardCards[i])
      }

      // Fill remaining slots — don't exceed maxHard
      const currentHardCount = built.filter((c) => c.difficulty.toLowerCase() === 'hard').length
      const fillers = shuffle([
        ...easyCards.slice(rules.minEasy),
        ...mediumCards,
        // Only include more Hard cards if we haven't hit maxHard yet
        ...hardCards.slice(rules.minHard, rules.maxHard - currentHardCount + rules.minHard),
      ])

      const remaining = handSize - built.length
      built.push(...fillers.slice(0, remaining))
      hand = built.slice(0, handSize)
    }

    const handIds = hand.map((c) => c.id)
    const teamRef = doc(db, 'games', gameId, 'teams', teamId)
    await updateDoc(teamRef, { hand: handIds, discard_used: 0 })
  })

  await Promise.all(dealPromises)
}