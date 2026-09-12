// =============================================================================
// POST /api/reel-webhook?secret=…
// Creatomate calls this when a render finishes (or fails). Payload carries
// the render id, status, output url, and the metadata we attached
// ({ gameId, teamId }). We:
//   1. mark the team doc ready/failed with the video URL,
//   2. try to copy the MP4 into our own Storage bucket (Creatomate keeps
//      renders for a limited time) and swap the URL if that works,
//   3. email every team member a link to their results page.
// =============================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb, adminAuth, adminStorage } from './_lib/admin.js'
import { sendReelEmail } from './_lib/reel.js'

export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const expected = process.env.REEL_WEBHOOK_SECRET ?? ''
  if (!expected || req.query.secret !== expected) return res.status(401).json({ error: 'Bad secret' })

  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) ?? {}
  let meta: { gameId?: string; teamId?: string } = {}
  try { meta = typeof body.metadata === 'string' ? JSON.parse(body.metadata) : (body.metadata ?? {}) } catch { /* ignore */ }
  const { gameId, teamId } = meta
  if (!gameId || !teamId) return res.status(400).json({ error: 'Missing metadata' })

  const db = adminDb()
  const teamRef = db.doc(`games/${gameId}/teams/${teamId}`)
  const status = String(body.status ?? '')
  let url = typeof body.url === 'string' ? body.url : null

  if (status !== 'succeeded' || !url) {
    await teamRef.update({
      reel_status: 'failed',
      reel_error: `Render ${status || 'failed'}${body.error_message ? ': ' + String(body.error_message).slice(0, 300) : ''}`,
    })
    return res.status(200).json({ ok: true, recorded: 'failed' })
  }

  // 2. Copy into our bucket so the link outlives Creatomate's retention.
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    try {
      const src = await fetch(url)
      if (src.ok) {
        const buf = Buffer.from(await src.arrayBuffer())
        const file = adminStorage().bucket().file(`reels/${gameId}/${teamId}.mp4`)
        await file.save(buf, { contentType: 'video/mp4', resumable: false, metadata: { cacheControl: 'public, max-age=31536000' } })
        await file.makePublic()
        url = `https://storage.googleapis.com/${file.bucket.name}/${file.name}`
      }
    } catch (err) {
      console.warn('Reel copy to Storage failed; keeping Creatomate URL', err)
    }
  }

  await teamRef.update({
    reel_status: 'ready',
    reel_url: url,
    reel_error: FieldValue.delete(),
    reel_ready_at: FieldValue.serverTimestamp(),
  })

  // 3. Email the team.
  let emailed: 'sent' | 'skipped' | 'failed' = 'skipped'
  try {
    const [teamSnap, gameSnap] = await Promise.all([teamRef.get(), db.doc(`games/${gameId}`).get()])
    const members: string[] = (teamSnap.data()?.members as string[]) ?? []
    const users = await Promise.all(members.map((uid) => adminAuth().getUser(uid).catch(() => null)))
    const emails = users.map((u) => u?.email).filter((e): e is string => !!e)
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
    emailed = await sendReelEmail(
      emails,
      (teamSnap.data()?.name as string) ?? 'Your team',
      (gameSnap.data()?.name as string) ?? 'Foray',
      `${proto}://${host}/results/${gameId}`,
    )
  } catch (err) {
    console.warn('Reel email failed', err)
    emailed = 'failed'
  }

  return res.status(200).json({ ok: true, recorded: 'ready', emailed })
}
