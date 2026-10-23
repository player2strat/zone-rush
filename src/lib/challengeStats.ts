// =============================================================================
// Foray — counting the challenges in Firestore (admin Seed Challenges page)
//
// The cards on /admin/seed count every doc in `challenges`, not just the ones
// in the seed file: challenges added other ways (e.g. in the console) are
// dealt in games too. Each row of cards must add up to the total, so a
// challenge with no known difficulty or category lands in an extra bucket
// instead of being left out.
// =============================================================================

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export const CATEGORIES = ['humor', 'culture', 'exploration', 'food', 'fitness', 'civic', 'art'] as const

export interface Bucket {
  key: string
  label: string
  count: number
}

export interface ChallengeCounts {
  total: number
  active: number                // is_active === true, the only ones dealt in games
  byDifficulty: Bucket[]        // easy, medium, hard, then "Other" if any
  byCategory: Bucket[]          // the known categories, any others found, then "No category" if any
  withTier2: number
  timeBased: number
  requiresMoney: number
  requiresInteraction: number
  needsTeammate: number
}

const normalize = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Counts for a list of challenge docs (as stored in Firestore). */
export function countChallenges(docs: Record<string, unknown>[]): ChallengeCounts {
  const difficulties = new Map<string, number>()
  const categories = new Map<string, number>()
  docs.forEach((c) => {
    const d = normalize(c.difficulty)
    const cat = normalize(c.category)
    difficulties.set(d, (difficulties.get(d) ?? 0) + 1)
    categories.set(cat, (categories.get(cat) ?? 0) + 1)
  })

  const known = (keys: readonly string[], counts: Map<string, number>): Bucket[] =>
    keys.map((key) => ({ key, label: titleCase(key), count: counts.get(key) ?? 0 }))

  const otherDifficulty = docs.length - DIFFICULTIES.reduce((n, k) => n + (difficulties.get(k) ?? 0), 0)
  const byDifficulty = known(DIFFICULTIES, difficulties)
  if (otherDifficulty > 0) byDifficulty.push({ key: 'other', label: 'Other', count: otherDifficulty })

  const byCategory = known(CATEGORIES, categories)
  const extraCategories = [...categories]
    .filter(([key]) => key !== '' && !(CATEGORIES as readonly string[]).includes(key))
    .sort((a, b) => b[1] - a[1])
  extraCategories.forEach(([key, count]) => byCategory.push({ key, label: titleCase(key), count }))
  const uncategorized = categories.get('') ?? 0
  if (uncategorized > 0) byCategory.push({ key: 'none', label: 'No category', count: uncategorized })

  return {
    total: docs.length,
    active: docs.filter((c) => c.is_active === true).length,
    byDifficulty,
    byCategory,
    withTier2: docs.filter((c) => c.tier2 != null).length,
    timeBased: docs.filter((c) => c.is_time_based === true).length,
    requiresMoney: docs.filter((c) => c.requires_money === true).length,
    requiresInteraction: docs.filter((c) => c.requires_interaction === true).length,
    needsTeammate: docs.filter((c) => typeof c.min_players === 'number' && c.min_players >= 2).length,
  }
}
