// =============================================================================
// Foray — loading data for the admin Export page
//
// READ-ONLY. Everything here is a Firestore read (getDocs / getDoc / count);
// nothing writes to Firestore or Storage. It gathers a game's submissions
// plus the team, challenge, zone and player names that make them readable.
// Building the CSV and zip is in lib/exportFiles.ts.
//
// What the security rules allow: admins can list every game; a GM can list
// only the games they created. Submissions must be queried by game_id.
// =============================================================================

import {
  collection, doc, getCountFromServer, getDoc, getDocs, query, where,
} from 'firebase/firestore'
import { db } from './firebase'
import { loadGameZoneMap, type GameZone } from './gameZones'
import { formatZoneLabel } from '../utils/formatZoneLabel'
import { toDate } from './exportFormat'
import type { ExportGame, ExportRow } from './exportFiles'

/** Run `fn` over `items`, at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Games this account can export, newest first (by start, else creation). */
export async function listExportGames(uid: string, isAdmin: boolean): Promise<ExportGame[]> {
  const games = collection(db, 'games')
  const snap = await getDocs(isAdmin ? games : query(games, where('created_by', '==', uid)))
  const list = snap.docs.map((d): ExportGame => {
    const data = d.data()
    return {
      id: d.id,
      name: (data.name as string) || d.id,
      status: (data.status as string) || 'unknown',
      startedAt: toDate(data.started_at),
      createdAt: toDate(data.created_at),
      practice: data.practice === true,
    }
  })
  const when = (g: ExportGame) => (g.startedAt ?? g.createdAt)?.getTime() ?? 0
  return list.sort((a, b) => when(b) - when(a))
}

/**
 * Teams with at least one player (games are created with empty pre-named
 * teams, which shouldn't count) and the number of submissions.
 */
export async function countGame(gameId: string): Promise<{ teams: number; submissions: number }> {
  const [teamsSnap, subs] = await Promise.all([
    getDocs(collection(db, 'games', gameId, 'teams')),
    getCountFromServer(query(collection(db, 'submissions'), where('game_id', '==', gameId))),
  ])
  const teams = teamsSnap.docs.filter((d) => ((d.data().members as unknown[] | undefined) ?? []).length > 0).length
  return { teams, submissions: subs.data().count }
}

// One doc per id, a few at a time. Missing or unreadable docs come back null.
async function getDocsById(path: string, ids: string[]): Promise<Map<string, Record<string, unknown> | null>> {
  const found = await mapLimit(ids, 8, async (id) => {
    try {
      const snap = await getDoc(doc(db, path, id))
      return snap.exists() ? snap.data() : null
    } catch {
      return null
    }
  })
  return new Map(ids.map((id, i) => [id, found[i]]))
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** Every submission in the game (any status), oldest first, with readable names. */
export async function loadExportRows(game: ExportGame): Promise<ExportRow[]> {
  const [subsSnap, teamsSnap, zones] = await Promise.all([
    getDocs(query(collection(db, 'submissions'), where('game_id', '==', game.id))),
    getDocs(collection(db, 'games', game.id, 'teams')),
    loadGameZoneMap(game.id).catch(() => new Map<string, GameZone>()),
  ])

  // Team names, and each member's name as the team knew it (fallback for players).
  const teamNames = new Map<string, string>()
  const memberNames = new Map<string, string>()
  teamsSnap.forEach((d) => {
    const t = d.data()
    teamNames.set(d.id, text(t.name) || d.id)
    const members = (t.members as string[] | undefined) ?? []
    const names = (t.member_names as string[] | undefined) ?? []
    members.forEach((uid, i) => { if (names[i]) memberNames.set(uid, names[i]) })
  })

  const subs = subsSnap.docs.map((d) => ({ id: d.id, raw: d.data() as Record<string, unknown> }))
  const unique = (key: string) =>
    [...new Set(subs.map((s) => s.raw[key]).filter((v): v is string => typeof v === 'string' && v !== ''))]
  const [challenges, users] = await Promise.all([
    getDocsById('challenges', unique('challenge_id')),
    getDocsById('users', unique('submitted_by')),
  ])

  const rows = subs.map(({ id, raw }): ExportRow => {
    const teamId = text(raw.team_id)
    const challengeId = text(raw.challenge_id)
    const zoneId = text(raw.zone_id)
    const uid = text(raw.submitted_by)
    const challenge = challenges.get(challengeId)
    return {
      id,
      raw,
      teamName: teamNames.get(teamId) ?? teamId,
      challengeTitle: text(challenge?.title) || challengeId,
      challengeDescription: text(challenge?.description) || text(raw.challenge_description),
      difficulty: text(challenge?.difficulty) || text(raw.challenge_difficulty),
      zoneName: (zoneId && text(zones.get(zoneId)?.name)) || formatZoneLabel(zoneId),
      submittedByName: text(users.get(uid)?.display_name) || memberNames.get(uid) || uid,
      submittedAt: toDate(raw.submitted_at),
      mediaUrl: text(raw.media_url),
      mediaType: text(raw.media_type),
    }
  })
  return rows.sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0))
}
