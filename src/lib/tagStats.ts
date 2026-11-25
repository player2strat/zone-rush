// =============================================================================
// Foray — how each challenge tag did in a game (admin Export page)
//
// A challenge can have several tags, so it counts once in each of its tag
// rows; the rows don't add up to the game total. Challenges with no tags get
// a "No tags" row. Counts are per team: a card two teams held counts twice.
//
// No Firebase imports here; lib/gameExport.ts loads the data.
// =============================================================================

import { sortTags, tagLabel } from './challengeImport'

export interface TagStatsInput {
  tagsById: Map<string, string[]>       // challenge id → tag keys
  teams: { id: string; held: string[]; discarded: string[] }[]
  submissions: { teamId: string; challengeId: string; status: string; points: number }[]
}

export interface TagStatRow {
  key: string            // tag key, or '' for "No tags"
  label: string
  held: number           // cards teams held (dealt, drawn, discarded or submitted)
  attempted: number      // cards a team submitted proof for at least once
  completed: number      // cards with an approved submission
  rejected: number       // rejected submissions
  discarded: number      // cards teams discarded
  points: number         // points from approved submissions
}

export const NO_TAGS = ''

export function computeTagStats({ tagsById, teams, submissions }: TagStatsInput): TagStatRow[] {
  const rows = aggregate(teams, submissions, (id) => {
    const tags = tagsById.get(id) ?? []
    return tags.length ? tags : [NO_TAGS]
  }, (key) => (key === NO_TAGS ? 'No tags' : tagLabel(key)))
  const order = sortTags([...rows.keys()].filter((k) => k !== NO_TAGS))
  return [...order, ...(rows.has(NO_TAGS) ? [NO_TAGS] : [])].map((k) => rows.get(k)!)
}

/**
 * The same counts per challenge, across any number of games (team ids must
 * be unique across them, e.g. "gameId/teamId"). Keyed by challenge id.
 */
export function computeChallengeStats(teams: TagStatsInput['teams'], submissions: TagStatsInput['submissions']): Map<string, TagStatRow> {
  return aggregate(teams, submissions, (id) => [id], (id) => id)
}

function aggregate(
  teams: TagStatsInput['teams'],
  submissions: TagStatsInput['submissions'],
  tagsOf: (challengeId: string) => string[],
  labelOf: (key: string) => string,
): Map<string, TagStatRow> {
  const rows = new Map<string, TagStatRow>()
  const rowFor = (key: string) => {
    let r = rows.get(key)
    if (!r) {
      r = { key, label: labelOf(key), held: 0, attempted: 0, completed: 0, rejected: 0, discarded: 0, points: 0 }
      rows.set(key, r)
    }
    return r
  }

  // Cards each team held: anything dealt, drawn, discarded or submitted.
  const held = new Map<string, Set<string>>()
  const heldBy = (teamId: string) => {
    let s = held.get(teamId)
    if (!s) { s = new Set(); held.set(teamId, s) }
    return s
  }
  teams.forEach((t) => {
    t.held.forEach((id) => heldBy(t.id).add(id))
    new Set(t.discarded).forEach((id) => tagsOf(id).forEach((k) => { rowFor(k).discarded++ }))
  })
  submissions.forEach((s) => { if (s.challengeId) heldBy(s.teamId).add(s.challengeId) })
  held.forEach((ids) => ids.forEach((id) => tagsOf(id).forEach((k) => { rowFor(k).held++ })))

  // Attempts and completions per team and card; rejections and points per submission.
  const attempted = new Set<string>()
  const completed = new Set<string>()
  submissions.forEach((s) => {
    if (!s.challengeId) return
    const pair = `${s.teamId}|${s.challengeId}`
    const firstAttempt = !attempted.has(pair)
    attempted.add(pair)
    const firstApproval = s.status === 'approved' && !completed.has(pair)
    if (s.status === 'approved') completed.add(pair)
    tagsOf(s.challengeId).forEach((k) => {
      const r = rowFor(k)
      if (firstAttempt) r.attempted++
      if (firstApproval) r.completed++
      if (s.status === 'rejected') r.rejected++
      if (s.status === 'approved') r.points += s.points
    })
  })

  return rows
}

/** Share of held cards that were completed, as a whole percent ("–" when none were held). */
export function completionRate(r: TagStatRow): string {
  return r.held ? `${Math.round((r.completed / r.held) * 100)}%` : '–'
}
