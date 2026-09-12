// =============================================================================
// Foray — highlight reels (client side)
//
// The rendering happens in a Vercel function (api/render-reels.ts) that the
// GM dashboard calls once the champion is revealed. Each team doc then
// carries reel_status / reel_url, which the results page and Past Forays
// read live. This file is the thin client for that.
// =============================================================================

import { auth } from './firebase'

export type ReelStatus = 'rendering' | 'ready' | 'failed' | 'skipped'

export interface ReelFields {
  reel_status?: ReelStatus
  reel_url?: string
  reel_error?: string
  reel_mock?: boolean
}

/** Local dev has no /api; set VITE_REEL_MOCK=1 to fake a successful kick-off. */
const CLIENT_MOCK = import.meta.env.VITE_REEL_MOCK === '1'

export async function requestReelRender(gameId: string): Promise<{ mock: boolean; outcomes: Record<string, string> }> {
  if (CLIENT_MOCK) return { mock: true, outcomes: {} }
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in')
  const token = await user.getIdToken()
  const res = await fetch('/api/render-reels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ gameId }),
  })
  const text = await res.text()
  let parsed: { error?: string; mock?: boolean; outcomes?: Record<string, string> } = {}
  try { parsed = JSON.parse(text) } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(parsed.error ?? `Reel service returned ${res.status}`)
  return { mock: !!parsed.mock, outcomes: parsed.outcomes ?? {} }
}

/**
 * Share the MP4 through the phone's share sheet (file share), else open it.
 * Fetching the file needs the host to allow cross-origin reads; when it
 * doesn't, we fall back to opening the link so the player can save it.
 */
export async function shareReel(url: string, teamName: string): Promise<'shared' | 'opened' | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  try {
    const res = await fetch(url)
    if (res.ok) {
      const blob = await res.blob()
      const file = new File([blob], `foray-${teamName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-reel.mp4`, { type: 'video/mp4' })
      if (nav.share && nav.canShare?.({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: `${teamName} — Foray highlight reel` })
          return 'shared'
        } catch (err) {
          if ((err as Error).name === 'AbortError') return 'cancelled'
        }
      }
    }
  } catch {
    // cross-origin fetch blocked — fall through
  }
  window.open(url, '_blank', 'noopener')
  return 'opened'
}
