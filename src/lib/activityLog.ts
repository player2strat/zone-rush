// =============================================================================
// Zone Rush — Activity Log (NEW FILE)
//
// Purpose:
//   Captures game events that aren't already preserved elsewhere in Firestore.
//   The full activity log view MERGES these events with submissions and
//   messages at read time — see getActivityLog().
//
// What we log here (these have no other history):
//   - card_discarded / card_drawn   (hand mutations overwrite previous state)
//   - zone_claimed / zone_stolen    (zone_scores has current state only)
//   - game_paused / game_resumed
//   - zone_closed / zone_reopened
//   - side_quests_applied
//
// What we DON'T log here (captured elsewhere — read directly):
//   - submission_created  → submissions.submitted_at
//   - submission_approved → submissions.status + reviewed_at
//   - submission_rejected → submissions.status + reviewed_at + gm_notes
//   - gm_broadcast        → messages collection
//   - game_started        → games.started_at
//   - game_ended          → games.status change to 'ended'
//
// Design note:
//   logEvent fails silently. Activity logging should NEVER break a game action.
//   If a write fails, we log to console and move on.
// =============================================================================

import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
  doc,
  getDoc,
} from 'firebase/firestore'
import { db } from './firebase'

// --------------- Event type definitions ---------------

export type EventType =
  | 'card_discarded'
  | 'card_drawn'
  | 'zone_claimed'
  | 'zone_stolen'
  | 'game_paused'
  | 'game_resumed'
  | 'zone_closed'
  | 'zone_reopened'
  | 'side_quests_applied'

export interface ActivityEvent {
  team_id: string | null
  event_type: EventType
  actor_id: string | null
  challenge_id?: string | null
  zone_id?: string | null
  points_delta?: number | null
  metadata?: Record<string, any>
}

// --------------- Writer ---------------

/**
 * Append a single event to games/{gameId}/events.
 * Fails silently so it can never break the game action that triggered it.
 */
export async function logEvent(
  gameId: string,
  event: ActivityEvent
): Promise<void> {
  try {
    await addDoc(collection(db, 'games', gameId, 'events'), {
      ...event,
      timestamp: serverTimestamp(),
    })
  } catch (err) {
    // Logging must never break gameplay — swallow and surface to console only
    console.error('[activityLog] Write failed:', err, event)
  }
}

// --------------- Reader / Merger ---------------

export interface MergedActivityRow {
  timestamp: Date
  team_id: string | null
  team_name: string | null
  team_color: string | null
  event_type: string
  actor_name: string | null
  challenge_id: string | null
  challenge_title: string | null
  zone_id: string | null
  zone_name: string | null
  points_delta: number | null
  details: string  // Human-readable description
  gm_notes: string | null
  metadata: Record<string, any> | null
}

interface BuildContext {
  teams: Map<string, { name: string; color: string }>
  challenges: Map<string, { title: string; description: string }>
  zones: Map<string, { name: string }>
  users: Map<string, { name: string }>
}

/**
 * Builds the merged activity log by combining:
 *   1. games/{id}/events       (explicit events we logged)
 *   2. submissions collection  (create/approve/reject implied by status + timestamps)
 *   3. messages collection     (gm broadcasts + replies)
 *   4. games/{id} doc          (game_started from started_at)
 *
 * Returns rows sorted newest → oldest.
 */
export async function getActivityLog(
  gameId: string
): Promise<MergedActivityRow[]> {
  // --- Load lookup maps so we can show names instead of IDs ---
  const teamsSnap = await getDocs(collection(db, 'games', gameId, 'teams'))
  const teams = new Map<string, { name: string; color: string }>()
  teamsSnap.forEach((d) => {
    const data = d.data()
    teams.set(d.id, { name: data.name, color: data.color })
  })

  const challengesSnap = await getDocs(collection(db, 'challenges'))
  const challenges = new Map<string, { title: string; description: string }>()
  challengesSnap.forEach((d) => {
    const data = d.data()
    challenges.set(d.id, {
      title: data.title ?? '',
      description: data.description ?? '',
    })
  })

  const zonesSnap = await getDocs(collection(db, 'zones'))
  const zones = new Map<string, { name: string }>()
  zonesSnap.forEach((d) => {
    zones.set(d.id, { name: d.data().name ?? d.id })
  })

  // Build a user lookup from team member_names where available
  const users = new Map<string, { name: string }>()
  teamsSnap.forEach((d) => {
    const data = d.data()
    const members: string[] = data.members ?? []
    const names: string[] = data.member_names ?? []
    members.forEach((uid, i) => {
      if (names[i]) users.set(uid, { name: names[i] })
    })
  })

  const ctx: BuildContext = { teams, challenges, zones, users }
  const rows: MergedActivityRow[] = []

  // --- Source 1: explicit events ---
  try {
    const eventsSnap = await getDocs(
      query(collection(db, 'games', gameId, 'events'), orderBy('timestamp', 'desc'))
    )
    eventsSnap.forEach((d) => {
      const e = d.data()
      if (!e.timestamp) return
      const ts = e.timestamp.toDate ? e.timestamp.toDate() : new Date(e.timestamp)
      rows.push(buildRowFromEvent(ts, e, ctx))
    })
  } catch (err) {
    console.error('[activityLog] Source 1 (events) failed:', err)
  }

  // --- Source 2: submissions (create / approve / reject) ---
  try {
    const subsSnap = await getDocs(
      query(collection(db, 'submissions'), where('game_id', '==', gameId))
    )
    subsSnap.forEach((d) => {
    const sub = d.data()

    // Submission created
    if (sub.submitted_at) {
      const ts = sub.submitted_at.toDate
        ? sub.submitted_at.toDate()
        : new Date(sub.submitted_at)
      const ch = challenges.get(sub.challenge_id)
      const team = teams.get(sub.team_id)
      const submitter = users.get(sub.submitted_by)
      const chLabel = bestChallengeLabel(ch, sub.challenge_id)
      rows.push({
        timestamp: ts,
        team_id: sub.team_id,
        team_name: team?.name ?? sub.team_id,
        team_color: team?.color ?? null,
        event_type: 'submission_created',
        actor_name: submitter?.name ?? null,
        challenge_id: sub.challenge_id,
        challenge_title: chLabel,
        zone_id: sub.zone_id,
        zone_name: zones.get(sub.zone_id)?.name ?? sub.zone_id ?? null,
        points_delta: null,
        details: `Submitted "${chLabel}" (${sub.media_type})`,
        gm_notes: null,
        metadata: { media_type: sub.media_type, attempted_tier2: sub.attempted_tier2, phone_free_claimed: sub.phone_free_claimed },
      })
    }

    // Submission approved/rejected (only if reviewed)
    if (sub.reviewed_at && (sub.status === 'approved' || sub.status === 'rejected')) {
      const ts = sub.reviewed_at.toDate
        ? sub.reviewed_at.toDate()
        : new Date(sub.reviewed_at)
      const ch = challenges.get(sub.challenge_id)
      const team = teams.get(sub.team_id)
      const chLabel = bestChallengeLabel(ch, sub.challenge_id)
      rows.push({
        timestamp: ts,
        team_id: sub.team_id,
        team_name: team?.name ?? sub.team_id,
        team_color: team?.color ?? null,
        event_type: sub.status === 'approved' ? 'submission_approved' : 'submission_rejected',
        actor_name: 'GM',
        challenge_id: sub.challenge_id,
        challenge_title: chLabel,
        zone_id: sub.zone_id,
        zone_name: zones.get(sub.zone_id)?.name ?? sub.zone_id ?? null,
        points_delta: sub.status === 'approved' ? (sub.points_awarded ?? null) : 0,
        details:
          sub.status === 'approved'
            ? `Approved "${chLabel}" — +${sub.points_awarded ?? '?'}pt`
            : `Rejected "${chLabel}"`,
        gm_notes: sub.gm_notes ?? null,
        metadata: { tier2_approved: sub.tier2_approved },
      })
    }
  })
  } catch (err) {
    console.error('[activityLog] Source 2 (submissions) failed:', err)
  }

  // --- Source 3: messages (broadcasts and replies) ---
  // Messages are stored as a sub-collection at games/{gameId}/messages
  try {
    const messagesSnap = await getDocs(
      collection(db, 'games', gameId, 'messages')
    )
    messagesSnap.forEach((d) => {
    const m = d.data()
    const ts =
      m.sent_at?.toDate?.() ??
      m.created_at?.toDate?.() ??
      new Date()

    if (m.channel_type === 'gm_broadcast') {
      rows.push({
        timestamp: ts,
        team_id: null,
        team_name: null,
        team_color: null,
        event_type: 'gm_broadcast',
        actor_name: m.from_name ?? 'GM',
        challenge_id: null,
        challenge_title: null,
        zone_id: null,
        zone_name: null,
        points_delta: null,
        details: `📢 Broadcast: ${m.text ?? ''}`,
        gm_notes: null,
        metadata: null,
      })
    } else if (m.channel_type === 'team_to_gm' || m.channel_type === 'gm_to_team') {
      const team = teams.get(m.team_id)
      rows.push({
        timestamp: ts,
        team_id: m.team_id ?? null,
        team_name: team?.name ?? m.team_id ?? null,
        team_color: team?.color ?? null,
        event_type: m.channel_type,
        actor_name: m.from_name ?? null,
        challenge_id: null,
        challenge_title: null,
        zone_id: null,
        zone_name: null,
        points_delta: null,
        details:
          m.channel_type === 'team_to_gm'
            ? `💬 ${m.from_name ?? 'Player'}: ${m.text ?? ''}`
            : `💬 GM → ${team?.name ?? 'team'}: ${m.text ?? ''}`,
        gm_notes: null,
        metadata: null,
      })
    }
  })
  } catch (err) {
    console.error('[activityLog] Source 3 (messages) failed:', err)
  }

  // --- Source 4: game lifecycle (started, ended from game doc) ---
  try {
    const gameSnap = await getDoc(doc(db, 'games', gameId))
    if (gameSnap.exists()) {
      const g = gameSnap.data()
      if (g.started_at) {
        const ts = g.started_at.toDate ? g.started_at.toDate() : new Date(g.started_at)
        rows.push({
          timestamp: ts,
          team_id: null,
          team_name: null,
          team_color: null,
          event_type: 'game_started',
          actor_name: 'GM',
          challenge_id: null,
          challenge_title: null,
          zone_id: null,
          zone_name: null,
          points_delta: null,
          details: `🎬 Game started — ${g.name ?? gameId}`,
          gm_notes: null,
          metadata: { settings: g.settings },
        })
      }
    }
  } catch (err) {
    console.error('[activityLog] Source 4 (game doc) failed:', err)
  }

  // Sort newest first
  rows.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  return rows
}

// --------------- Internal helpers ---------------

/**
 * Returns the best human-readable label for a challenge:
 *   challenge.title if non-empty,
 *   else first 60 chars of description if non-empty,
 *   else the raw challenge ID,
 *   else empty string.
 *
 * Why this exists: `??` only falls back on null/undefined, NOT empty strings,
 * so `ch.title ?? ch.description` returns an empty string when title is "".
 * We use `||` here, which falls back on any falsy value (including "").
 */
function bestChallengeLabel(
  ch: { title?: string; description?: string } | undefined | null,
  fallbackId?: string | null
): string {
  const title = ch?.title?.trim()
  const desc = ch?.description?.trim().slice(0, 60)
  return title || desc || fallbackId || ''
}

function buildRowFromEvent(
  timestamp: Date,
  e: any,
  ctx: BuildContext
): MergedActivityRow {
  const team = e.team_id ? ctx.teams.get(e.team_id) : null
  const ch = e.challenge_id ? ctx.challenges.get(e.challenge_id) : null
  const zone = e.zone_id ? ctx.zones.get(e.zone_id) : null
  const actor = e.actor_id ? ctx.users.get(e.actor_id) : null

  const challengeTitle = bestChallengeLabel(ch, e.challenge_id)
  const zoneName = zone?.name ?? e.zone_id ?? null
  const actorName = actor?.name ?? (e.actor_id === 'gm' ? 'GM' : null)

  return {
    timestamp,
    team_id: e.team_id,
    team_name: team?.name ?? e.team_id ?? null,
    team_color: team?.color ?? null,
    event_type: e.event_type,
    actor_name: actorName,
    challenge_id: e.challenge_id ?? null,
    challenge_title: challengeTitle,
    zone_id: e.zone_id ?? null,
    zone_name: zoneName,
    points_delta: e.points_delta ?? null,
    details: describeEvent(e, team?.name, challengeTitle, zoneName),
    gm_notes: null,
    metadata: e.metadata ?? null,
  }
}

function describeEvent(
  e: any,
  teamName?: string | null,
  challengeTitle?: string | null,
  zoneName?: string | null
): string {
  const t = teamName ?? 'A team'
  const c = challengeTitle ?? 'a challenge'
  const z = zoneName ?? 'a zone'

  switch (e.event_type as EventType) {
    case 'card_discarded':
      return `🗑 ${t} discarded "${c}"`
    case 'card_drawn':
      const reason = e.metadata?.reason ?? ''
      return reason === 'replacement'
        ? `🃏 ${t} drew "${c}" (replacement after completion)`
        : reason === 'discard_swap'
        ? `🃏 ${t} drew "${c}" (after discard)`
        : `🃏 ${t} drew "${c}"`
    case 'zone_claimed':
      return `🏆 ${t} claimed ${z} (+${e.points_delta ?? '?'}pt zone bonus)`
    case 'zone_stolen':
      const from = e.metadata?.previous_owner_name ?? 'previous team'
      return `🔁 ${t} stole ${z} from ${from}`
    case 'game_paused':
      return `⏸ Game paused`
    case 'game_resumed':
      return `▶ Game resumed`
    case 'zone_closed':
      return `🚫 ${z} closed by GM`
    case 'zone_reopened':
      return `✅ ${z} reopened by GM`
    case 'side_quests_applied':
      const awards = e.metadata?.awards ?? {}
      return `🏁 Side Quests applied: ${JSON.stringify(awards)}`
    default:
      return `${e.event_type} (no description)`
  }
}

// --------------- CSV export ---------------

/**
 * Convert merged activity rows to a CSV string.
 * Headers: Timestamp, Team, Event, Actor, Challenge, Zone, Points, Details, GM Notes
 */
export function activityLogToCSV(rows: MergedActivityRow[]): string {
  const headers = [
    'Timestamp',
    'Team',
    'Team ID',
    'Event',
    'Actor',
    'Challenge',
    'Challenge ID',
    'Zone',
    'Zone ID',
    'Points',
    'Details',
    'GM Notes',
    'Metadata',
  ]

  const escape = (val: any): string => {
    if (val === null || val === undefined) return ''
    const s = String(val)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }

  const lines = [headers.join(',')]
  // Reverse so CSV is chronological (oldest first), more natural for analysis
  const chronological = [...rows].reverse()
  for (const r of chronological) {
    lines.push(
      [
        r.timestamp.toISOString(),
        r.team_name,
        r.team_id,
        r.event_type,
        r.actor_name,
        r.challenge_title,
        r.challenge_id,
        r.zone_name,
        r.zone_id,
        r.points_delta,
        r.details,
        r.gm_notes,
        r.metadata ? JSON.stringify(r.metadata) : '',
      ]
        .map(escape)
        .join(',')
    )
  }
  return lines.join('\n')
}