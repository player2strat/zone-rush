// =============================================================================
// Foray — counts for the Challenge Manager's Overview tab
//
// Total, by difficulty, on/off, photo/video and by tag. A challenge with
// several tags counts in each of them, so the tag cards don't add up to the
// total; "No tags" counts the ones with none.
//
// No Firebase imports here.
// =============================================================================

import { CHALLENGE_TAGS, sortTags, tagLabel, type AppChallenge } from './challengeImport'

export interface SummaryCard {
  key: string        // filter value: difficulty, 'on'/'off', 'photo'/'video', tag key, or '-' for no tags
  label: string
  count: number
}

export interface ChallengeSummary {
  total: number
  difficulty: SummaryCard[]   // easy, medium, hard (+ "Other" when some have none)
  status: SummaryCard[]       // on, off
  proof: SummaryCard[]        // photo, video (+ audio when used)
  tags: SummaryCard[]         // every standard tag (even at 0), any others in use, then "No tags"
}

export const NO_TAGS_KEY = '-'

export function summarizeChallenges(challenges: AppChallenge[]): ChallengeSummary {
  const count = (test: (c: AppChallenge) => boolean) => challenges.filter(test).length
  const difficulty: SummaryCard[] = (['easy', 'medium', 'hard'] as const).map((d) => ({ key: d, label: cap(d), count: count((c) => c.difficulty === d) }))
  const other = challenges.length - difficulty.reduce((n, c) => n + c.count, 0)
  if (other > 0) difficulty.push({ key: 'other', label: 'Other', count: other })

  const proof: SummaryCard[] = [
    { key: 'photo', label: 'Photo', count: count((c) => c.verification_type === 'photo') },
    { key: 'video', label: 'Video', count: count((c) => c.verification_type === 'video') },
  ]
  const audio = count((c) => c.verification_type === 'audio')
  if (audio > 0) proof.push({ key: 'audio', label: 'Audio', count: audio })

  const tagKeys = sortTags([...CHALLENGE_TAGS.map((t) => t.key), ...challenges.flatMap((c) => c.tags ?? [])])
  return {
    total: challenges.length,
    difficulty,
    status: [
      { key: 'on', label: 'On', count: count((c) => c.is_active !== false) },
      { key: 'off', label: 'Off', count: count((c) => c.is_active === false) },
    ],
    proof,
    tags: [
      ...tagKeys.map((k) => ({ key: k, label: tagLabel(k), count: count((c) => (c.tags ?? []).includes(k)) })),
      { key: NO_TAGS_KEY, label: 'No tags', count: count((c) => (c.tags ?? []).length === 0) },
    ],
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
