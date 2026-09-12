// =============================================================================
// Foray — highlight reel building blocks (server only)
//
// pickHighlights   which of a team's submissions go in the reel
// buildReelSource  a Creatomate composition (9:16, 30fps) built in code, so a
//                  reel renders with no template designed up front. When
//                  CREATOMATE_TEMPLATE_ID is set, buildTemplateModifications
//                  is used instead and the designer's template wins.
// createRender     POST to Creatomate; returns the render id
// sendReelEmail    "Your reel is ready" via Resend (skipped without a key)
// =============================================================================

export interface ReelMedia {
  url: string
  type: 'photo' | 'video'
  caption: string          // "Challenge title · Zone"
  at: number               // submitted_at ms, for ordering
}

export interface ReelTeam {
  id: string
  name: string
  color: string
  place: number | null
  points: number
  memberUids: string[]
}

export interface ReelGame {
  id: string
  name: string
  dateLabel: string
}

export const PHOTO_SECONDS = 3.5
export const VIDEO_MAX_SECONDS = 6
export const INTRO_SECONDS = 2.5
export const OUTRO_SECONDS = 3.5
export const MAX_HIGHLIGHTS = 12

const BRAND = { paper: '#FDFFF1', ink: '#202122', marigold: '#FFD626', marigoldDeep: '#7A6400' }

interface SubmissionLike {
  status?: string
  highlight?: boolean
  media_url?: string
  media_type?: string
  submitted_at?: { toMillis?: () => number; seconds?: number } | null
  challengeTitle?: string
  zoneLabel?: string
}

function ms(t: SubmissionLike['submitted_at']): number {
  return t?.toMillis?.() ?? (t?.seconds ? t.seconds * 1000 : 0)
}

/** GM-starred approved photos/videos; if none starred, every approved one. Oldest first. */
export function pickHighlights(subs: SubmissionLike[]): ReelMedia[] {
  const usable = subs.filter((s) =>
    s.status === 'approved' && s.media_url && (s.media_type === 'photo' || s.media_type === 'video'))
  const starred = usable.filter((s) => s.highlight === true)
  const chosen = (starred.length > 0 ? starred : usable)
    .sort((a, b) => ms(a.submitted_at) - ms(b.submitted_at))
    .slice(0, MAX_HIGHLIGHTS)
  return chosen.map((s) => ({
    url: s.media_url as string,
    type: s.media_type as 'photo' | 'video',
    caption: [s.challengeTitle, s.zoneLabel].filter(Boolean).join(' · '),
    at: ms(s.submitted_at),
  }))
}

function ordinal(n: number): string {
  const m = n % 100
  const s = m >= 11 && m <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${s}`
}

// A caption pill at the bottom of the frame.
function captionElement(text: string, time: number, duration: number) {
  return {
    type: 'text',
    text,
    time,
    duration,
    x: '50%',
    y: '88%',
    width: '86%',
    x_alignment: '50%',
    y_alignment: '50%',
    font_family: 'Helvetica',
    font_weight: '700',
    font_size: '3.6 vmin',
    fill_color: '#FFFFFF',
    background_color: 'rgba(32, 33, 34, 0.72)',
    // Creatomate wants these as percentages (of the font size), not screen units.
    background_x_padding: '40%',
    background_y_padding: '25%',
    background_border_radius: '30%',
    animations: [{ type: 'fade', duration: 0.4, transition: true }],
  }
}

/**
 * Creatomate "source" composition. Every element carries an explicit `time`,
 * so the timeline is fully determined here. Fields follow Creatomate's
 * element schema; if their API rejects a property the render fails with a
 * message that lands in the team's reel_error for tuning.
 */
export function buildReelSource(game: ReelGame, team: ReelTeam, media: ReelMedia[], musicUrl?: string) {
  const elements: Record<string, unknown>[] = []
  let t = 0

  // Intro card
  elements.push({
    type: 'shape', time: t, duration: INTRO_SECONDS, width: '100%', height: '100%',
    x: '50%', y: '50%', fill_color: team.color, path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
  })
  elements.push({
    type: 'text', text: team.name.toUpperCase(), time: t, duration: INTRO_SECONDS,
    x: '50%', y: '46%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    font_family: 'Helvetica', font_weight: '800', font_size: '9 vmin', fill_color: '#FFFFFF',
    animations: [{ type: 'scale', start_scale: '80%', end_scale: '100%', duration: 0.6, easing: 'quadratic-out' }],
  })
  elements.push({
    type: 'text', text: `FORAY · ${game.name.toUpperCase()}`, time: t, duration: INTRO_SECONDS,
    x: '50%', y: '58%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    font_family: 'Helvetica', font_weight: '600', font_size: '3.4 vmin', fill_color: 'rgba(255,255,255,0.85)',
  })
  t += INTRO_SECONDS

  // Highlights. Clip audio plays in full when there's no music bed, and is
  // ducked under the music when there is one.
  const clipVolume = musicUrl ? '25%' : '100%'
  for (const m of media) {
    const dur = m.type === 'video' ? VIDEO_MAX_SECONDS : PHOTO_SECONDS
    if (m.type === 'video') {
      elements.push({
        type: 'video', source: m.url, time: t, duration: dur, fit: 'cover', trim_start: 0, volume: clipVolume,
        x: '50%', y: '50%', width: '100%', height: '100%',
        animations: [{ type: 'fade', duration: 0.5, transition: true }],
      })
    } else {
      elements.push({
        type: 'image', source: m.url, time: t, duration: dur, fit: 'cover',
        x: '50%', y: '50%', width: '100%', height: '100%',
        animations: [
          { type: 'fade', duration: 0.5, transition: true },
          { type: 'scale', start_scale: '100%', end_scale: '112%', duration: dur, easing: 'linear' },
        ],
      })
    }
    if (m.caption) elements.push(captionElement(m.caption, t, dur))
    t += dur
  }

  // Outro card
  const placeLine = team.place ? `${ordinal(team.place).toUpperCase()} PLACE · ${team.points} PTS` : `${team.points} PTS`
  elements.push({
    type: 'shape', time: t, duration: OUTRO_SECONDS, width: '100%', height: '100%',
    x: '50%', y: '50%', fill_color: BRAND.paper, path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
  })
  elements.push({
    type: 'text', text: 'FORAY', time: t, duration: OUTRO_SECONDS,
    x: '50%', y: '38%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    font_family: 'Helvetica', font_weight: '800', font_size: '10 vmin', fill_color: BRAND.ink,
  })
  elements.push({
    type: 'text', text: team.name, time: t, duration: OUTRO_SECONDS,
    x: '50%', y: '50%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    font_family: 'Helvetica', font_weight: '800', font_size: '6 vmin', fill_color: team.color,
  })
  elements.push({
    type: 'text', text: placeLine, time: t, duration: OUTRO_SECONDS,
    x: '50%', y: '58%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    font_family: 'Helvetica', font_weight: '700', font_size: '3.6 vmin', fill_color: BRAND.marigoldDeep,
  })
  elements.push({
    type: 'text', text: `${game.dateLabel.toUpperCase()} · CLAIM THE CITY`, time: t, duration: OUTRO_SECONDS,
    x: '50%', y: '70%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    font_family: 'Helvetica', font_weight: '600', font_size: '2.8 vmin', fill_color: 'rgba(32,33,34,0.6)',
  })
  t += OUTRO_SECONDS

  if (musicUrl) {
    elements.push({ type: 'audio', source: musicUrl, time: 0, duration: t, volume: '70%', audio_fade_out: 2 })
  }

  return {
    output_format: 'mp4',
    width: 1080,
    height: 1920,
    frame_rate: 30,
    duration: t,
    elements,
  }
}

/** For a designer-made template: fill named layers (Highlight1…, TeamName, …). */
export function buildTemplateModifications(game: ReelGame, team: ReelTeam, media: ReelMedia[]) {
  const mods: Record<string, string> = {
    'TeamName.text': team.name,
    'GameName.text': game.name,
    'Date.text': game.dateLabel,
    'Place.text': team.place ? `${ordinal(team.place)} place` : '',
    'Points.text': `${team.points} pts`,
  }
  media.forEach((m, i) => {
    mods[`Highlight${i + 1}.source`] = m.url
    mods[`Caption${i + 1}.text`] = m.caption
  })
  return mods
}

export interface CreatomateRender { id: string; status: string; url?: string }

export async function createRender(
  body: Record<string, unknown>,
): Promise<CreatomateRender> {
  const key = process.env.CREATOMATE_API_KEY
  if (!key) throw new Error('CREATOMATE_API_KEY is not set')
  const res = await fetch('https://api.creatomate.com/v1/renders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Creatomate ${res.status}: ${text.slice(0, 300)}`)
  const parsed = JSON.parse(text)
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  return { id: first.id, status: first.status, url: first.url }
}

export async function sendReelEmail(
  to: string[],
  teamName: string,
  gameName: string,
  resultsUrl: string,
): Promise<'sent' | 'skipped'> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.REEL_FROM_EMAIL
  if (!key || !from || to.length === 0) return 'skipped'
  const html = `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#202122">
      <p style="font-size:12px;letter-spacing:2px;color:#7A6400;margin:0 0 8px">FORAY · CLAIM THE CITY</p>
      <h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(teamName)}, your highlight reel is ready 🎬</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px">
        Relive ${escapeHtml(gameName)} and post it — the reel is vertical and ready for Stories, Reels, and TikTok.
      </p>
      <a href="${resultsUrl}" style="display:inline-block;background:#FFD626;color:#202122;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none">
        Watch and share your reel
      </a>
      <p style="font-size:12px;color:#8F8E85;margin:24px 0 0">You're getting this because you played in this Foray.</p>
    </div>`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: `${teamName} — your Foray highlight reel is ready`, html }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return 'sent'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
