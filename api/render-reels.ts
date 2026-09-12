// =============================================================================
// POST /api/render-reels   { gameId }
// Auth: Firebase ID token of a GM/admin in the Authorization header.
//
// Kicks off one highlight-reel render per team. Called by the GM dashboard
// the moment the champion is revealed (and by its "Render reels" button).
// Writes reel_status / reel_render_id on each team doc; the finished video
// arrives later through /api/reel-webhook.
//
// REEL_MOCK=1 skips Creatomate and marks every team ready with a sample
// video, so the whole in-app flow can be tested before any account exists.
// =============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb, requireGm, errorStatus } from './_lib/admin.js'
import {
  pickHighlights, buildReelSource, buildTemplateModifications, createRender,
  type ReelGame, type ReelTeam,
} from './_lib/reel.js'

export const config = { maxDuration: 60 }

const MOCK_VIDEO = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  try {
    await requireGm(req.headers.authorization)
    const gameId = String(req.body?.gameId ?? '')
    if (!gameId) return res.status(400).json({ error: 'gameId required' })

    const db = adminDb()
    const gameSnap = await db.doc(`games/${gameId}`).get()
    if (!gameSnap.exists) return res.status(404).json({ error: 'Game not found' })
    const game = gameSnap.data() as Record<string, unknown>
    if (game.status !== 'ended') return res.status(400).json({ error: 'Game has not ended' })

    const when = (game.ended_at as { toDate?: () => Date } | undefined)?.toDate?.() ?? new Date()
    const reelGame: ReelGame = {
      id: gameId,
      name: (game.name as string) ?? 'Foray',
      dateLabel: when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    }

    const [teamsSnap, subsSnap, resultsSnap] = await Promise.all([
      db.collection(`games/${gameId}/teams`).get(),
      db.collection('submissions').where('game_id', '==', gameId).get(),
      db.collection('game_results').where('game_id', '==', gameId).get(),
    ])
    // Stats from the permanent record (present once results are recorded;
    // practice games fall back to the team doc's totals and zero counts).
    const statsByTeam = new Map<string, { place: number; zones: number; challenges: number; distance: number }>()
    resultsSnap.forEach((d) => {
      const r = d.data()
      statsByTeam.set(r.team_id, {
        place: r.place, zones: r.zones_claimed ?? 0, challenges: r.challenges ?? 0, distance: r.distance_m ?? 0,
      })
    })

    // Challenge titles + zone names for captions (small collections; two reads)
    const challengeIds = [...new Set(subsSnap.docs.map((d) => d.data().challenge_id as string).filter(Boolean))]
    const zoneIds = [...new Set(subsSnap.docs.map((d) => d.data().zone_id as string).filter(Boolean))]
    const [challengeDocs, zoneDocs] = await Promise.all([
      Promise.all(challengeIds.map((id) => db.doc(`challenges/${id}`).get())),
      Promise.all(zoneIds.map((id) => db.doc(`games/${gameId}/zones/${id}`).get())),
    ])
    const titles = new Map(challengeDocs.filter((d) => d.exists).map((d) => [d.id, d.data()?.title as string]))
    const zoneNames = new Map(zoneDocs.filter((d) => d.exists).map((d) => [d.id, d.data()?.name as string]))

    const mock = process.env.REEL_MOCK === '1' || !process.env.CREATOMATE_API_KEY
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
    const assetBase = `${proto}://${host}`
    const secret = process.env.REEL_WEBHOOK_SECRET ?? ''
    const webhookUrl = `${proto}://${host}/api/reel-webhook?secret=${encodeURIComponent(secret)}`

    const outcomes: Record<string, string> = {}
    for (const teamDoc of teamsSnap.docs) {
      const t = teamDoc.data()
      const teamRef = teamDoc.ref
      const mine = subsSnap.docs
        .filter((d) => d.data().team_id === teamDoc.id)
        .map((d) => {
          const s = d.data()
          return {
            ...s,
            challengeTitle: titles.get(s.challenge_id) ?? '',
            zoneLabel: zoneNames.get(s.zone_id) ?? '',
          }
        })
      const media = pickHighlights(mine)
      if (media.length === 0) {
        await teamRef.update({ reel_status: 'skipped', reel_error: 'No approved photos or videos to build a reel from.' })
        outcomes[teamDoc.id] = 'skipped'
        continue
      }

      const st = statsByTeam.get(teamDoc.id)
      const reelTeam: ReelTeam = {
        id: teamDoc.id,
        name: (t.name as string) ?? 'Team',
        color: (t.color as string) ?? '#1EB2F2',
        place: st?.place ?? null,
        points: (t.total_points as number) ?? 0,
        zonesClaimed: st?.zones ?? 0,
        challenges: st?.challenges ?? 0,
        distanceM: st?.distance ?? Math.max(0, ...Object.values((t.member_distances as Record<string, number>) ?? {})),
        memberUids: (t.members as string[]) ?? [],
      }

      if (mock) {
        await teamRef.update({
          reel_status: 'ready',
          reel_url: MOCK_VIDEO,
          reel_error: FieldValue.delete(),
          reel_requested_at: FieldValue.serverTimestamp(),
          reel_ready_at: FieldValue.serverTimestamp(),
          reel_mock: true,
        })
        outcomes[teamDoc.id] = 'ready (mock)'
        continue
      }

      try {
        const templateId = process.env.CREATOMATE_TEMPLATE_ID
        const body: Record<string, unknown> = templateId
          ? { template_id: templateId, modifications: buildTemplateModifications(reelGame, reelTeam, media) }
          : { source: buildReelSource(reelGame, reelTeam, media, process.env.REEL_MUSIC_URL, assetBase) }
        body.webhook_url = webhookUrl
        body.metadata = JSON.stringify({ gameId, teamId: teamDoc.id })
        const render = await createRender(body)
        await teamRef.update({
          reel_status: 'rendering',
          reel_render_id: render.id,
          reel_error: FieldValue.delete(),
          reel_requested_at: FieldValue.serverTimestamp(),
          reel_mock: FieldValue.delete(),
        })
        outcomes[teamDoc.id] = 'rendering'
      } catch (err) {
        await teamRef.update({ reel_status: 'failed', reel_error: (err as Error).message.slice(0, 500) })
        outcomes[teamDoc.id] = 'failed'
      }
    }

    return res.status(200).json({ ok: true, mock, outcomes })
  } catch (err) {
    return res.status(errorStatus(err)).json({ error: (err as Error).message })
  }
}
