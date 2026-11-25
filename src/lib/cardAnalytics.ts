// =============================================================================
// Foray — "Cards for analysis" download (admin Export page)
//
// One row per card per team: every challenge a team held in a game (dealt,
// drawn later, discarded or submitted) with its tags as TRUE/FALSE columns
// and what the team did with it. Unlike the submissions spreadsheet, it
// includes the cards teams skipped, which is where most of the behavior is.
// Made for pivot tables in Google Sheets; one game or many in one file.
//
// The app doesn't record when a card was drawn, so there's no "time held".
// No GPS or locations here.
//
// No Firebase imports here; lib/gameExport.ts loads the data.
// =============================================================================

import { CHALLENGE_TAGS, sortTags, tagLabel } from './challengeImport'
import { buildCsv, nyReadable } from './exportFormat'

export interface CardGame {
  id: string
  name: string
  date: Date | null          // when it started
  practice: boolean
}

export interface CardTeam {
  id: string
  name: string
  dealt: string[]            // starting hand
  hand: string[]             // in hand at the end
  discarded: string[]
}

export interface CardSubmission {
  teamId: string
  challengeId: string
  status: string             // approved | rejected | pending
  points: number
  submittedAt: Date | null
  reviewedAt: Date | null
  tier2Attempted: boolean
  tier2Approved: boolean
  zoneName: string
  submittedByName: string
}

export interface CardChallenge {
  text: string
  difficulty: string
  verification: string
  sequential: boolean
  tags: string[]
}

export type Outcome = 'Completed' | 'Pending review' | 'Rejected' | 'Discarded' | 'Held, not attempted'

export interface CardRow {
  game: CardGame
  teamName: string
  challengeId: string
  challenge: CardChallenge | null      // null if the challenge doc is gone
  startingHand: boolean
  outcome: Outcome
  attempts: number
  rejections: number
  pointsEarned: number
  tier2Attempted: boolean
  tier2Approved: boolean
  firstSubmittedAt: Date | null
  completedAt: Date | null             // when the approved submission was submitted
  minutesToReview: number | null       // for the approved submission, else the last reviewed one
  zoneName: string
  submittedByName: string
}

const time = (d: Date | null) => d?.getTime() ?? 0

/** Every card each team held in one game, with what happened to it. */
export function buildCardRows(
  game: CardGame,
  teams: CardTeam[],
  submissions: CardSubmission[],
  challenges: Map<string, CardChallenge | null>,
): CardRow[] {
  const rows: CardRow[] = []
  for (const team of [...teams].sort((a, b) => a.name.localeCompare(b.name))) {
    const subsHere = submissions.filter((s) => s.teamId === team.id && s.challengeId)
    const dealt = new Set(team.dealt)
    const discarded = new Set(team.discarded)
    const ids = [...new Set([...team.dealt, ...team.hand, ...team.discarded, ...subsHere.map((s) => s.challengeId)])]
      .sort((a, b) => Number(dealt.has(b)) - Number(dealt.has(a)) || a.localeCompare(b, undefined, { numeric: true }))

    for (const id of ids) {
      const subs = subsHere.filter((s) => s.challengeId === id).sort((a, b) => time(a.submittedAt) - time(b.submittedAt))
      const approved = subs.filter((s) => s.status === 'approved')
      const reviewed = subs.filter((s) => s.reviewedAt && s.submittedAt)
      const key = approved[0] ?? subs[subs.length - 1]
      const forReview = approved[0]?.reviewedAt ? approved[0] : reviewed[reviewed.length - 1]
      const outcome: Outcome = approved.length ? 'Completed'
        : subs.some((s) => s.status === 'pending') ? 'Pending review'
          : subs.some((s) => s.status === 'rejected') ? 'Rejected'
            : discarded.has(id) ? 'Discarded'
              : 'Held, not attempted'
      rows.push({
        game,
        teamName: team.name,
        challengeId: id,
        challenge: challenges.get(id) ?? null,
        startingHand: dealt.has(id),
        outcome,
        attempts: subs.length,
        rejections: subs.filter((s) => s.status === 'rejected').length,
        pointsEarned: approved.reduce((n, s) => n + s.points, 0),
        tier2Attempted: subs.some((s) => s.tier2Attempted),
        tier2Approved: subs.some((s) => s.tier2Approved),
        firstSubmittedAt: subs[0]?.submittedAt ?? null,
        completedAt: approved[0]?.submittedAt ?? null,
        minutesToReview: forReview?.reviewedAt && forReview.submittedAt
          ? Math.round(((forReview.reviewedAt.getTime() - forReview.submittedAt.getTime()) / 60000) * 10) / 10
          : null,
        zoneName: key?.zoneName ?? '',
        submittedByName: key?.submittedByName ?? '',
      })
    }
  }
  return rows
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const yes = (b: boolean) => (b ? 'TRUE' : 'FALSE')

/** The CSV: game and card details, one TRUE/FALSE column per tag, then what happened. */
export function buildCardsCsv(rows: CardRow[]): string {
  const extra = sortTags(rows.flatMap((r) => r.challenge?.tags ?? [])).filter((k) => !CHALLENGE_TAGS.some((t) => t.key === k))
  const tagKeys = [...CHALLENGE_TAGS.map((t) => t.key), ...extra]
  const header = [
    'Game', 'Game date', 'Practice game', 'Team',
    'Challenge ID', 'Challenge', 'Difficulty', 'Proof', 'Choose Your Own Adventure', 'Tag count',
    ...tagKeys.map(tagLabel),
    'Starting hand', 'Outcome', 'Completed', 'Attempts', 'Rejections', 'Points earned',
    'Tier 2 attempted', 'Tier 2 approved',
    'First submitted (New York time)', 'Completed at (New York time)', 'Minutes to review',
    'Zone', 'Submitted by', 'Game ID',
  ]
  const body = rows.map((r) => {
    const tags = r.challenge?.tags ?? []
    return [
      r.game.name, r.game.date ? nyReadable(r.game.date) : '', yes(r.game.practice), r.teamName,
      r.challengeId, r.challenge?.text ?? '(challenge no longer exists)', cap(r.challenge?.difficulty ?? ''),
      cap(r.challenge?.verification ?? ''), yes(r.challenge?.sequential ?? false), tags.length,
      ...tagKeys.map((k) => yes(tags.includes(k))),
      yes(r.startingHand), r.outcome, yes(r.outcome === 'Completed'), r.attempts, r.rejections, r.pointsEarned,
      yes(r.tier2Attempted), yes(r.tier2Approved),
      r.firstSubmittedAt ? nyReadable(r.firstSubmittedAt) : '', r.completedAt ? nyReadable(r.completedAt) : '',
      r.minutesToReview ?? '',
      r.zoneName, r.submittedByName, r.game.id,
    ]
  })
  return buildCsv(header, body)
}
