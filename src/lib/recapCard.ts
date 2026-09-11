// =============================================================================
// Foray — Team recap card (post-reveal share image)
//
// Draws a 1080×1920 (9:16) PNG on a canvas in the browser: team name and
// color, final place, points, zones, challenges, members, game name and date.
// Stats only — no photos — so it can never fail on image permissions.
// Shared through the phone's share sheet when available, otherwise saved as
// a download.
// =============================================================================

import { BRAND } from './brand'

export interface RecapCardData {
  gameName: string
  dateLabel: string
  teamName: string
  teamColor: string
  place: number          // 1 = champion
  tiedPlace: boolean
  teamCount: number
  points: number
  zonesClaimed: number
  challenges: number
  members: string[]
}

const W = 1080
const H = 1920
const HEAD = "'Martian Mono', ui-monospace, Menlo, monospace"
const BODY = "'Helvetica Neue', Helvetica, Arial, sans-serif"

function ordinal(n: number): string {
  const m = n % 100
  const s = m >= 11 && m <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${s}`
}

// Black or white text, whichever reads better on the team color.
function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return BRAND.ink
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.4 ? BRAND.ink : '#FFFFFF'
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w
    if (ctx.measureText(test).width <= maxWidth || !cur) cur = test
    else { lines.push(cur); cur = w }
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    let last = lines[maxLines - 1]
    while (ctx.measureText(last + '…').width > maxWidth && last.length > 1) last = last.slice(0, -1)
    lines[maxLines - 1] = last + '…'
  }
  return lines
}

async function loadLogo(): Promise<HTMLImageElement | null> {
  try {
    const img = new Image()
    img.src = '/brand/logo.svg'
    await img.decode()
    return img
  } catch {
    return null
  }
}

export async function renderRecapCard(data: RecapCardData): Promise<Blob> {
  // Make sure the brand font is available to the canvas before measuring.
  try { await document.fonts.load(`700 100px "Martian Mono"`) } catch { /* fall back to stack */ }
  const logo = await loadLogo()

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')

  const onColor = inkOn(data.teamColor)

  // ---- background
  ctx.fillStyle = BRAND.paper
  ctx.fillRect(0, 0, W, H)

  // ---- logo (or wordmark fallback)
  if (logo) {
    const lw = 520
    const lh = lw * (logo.naturalHeight / Math.max(1, logo.naturalWidth))
    ctx.drawImage(logo, (W - lw) / 2, 96, lw, lh)
  } else {
    ctx.fillStyle = BRAND.ink
    ctx.font = `800 96px ${HEAD}`
    ctx.textAlign = 'center'
    ctx.fillText('FORAY', W / 2, 190)
  }
  ctx.textAlign = 'center'
  ctx.fillStyle = BRAND.marigoldDeep
  ctx.font = `600 26px ${HEAD}`
  ctx.fillText('C L A I M   T H E   C I T Y', W / 2, 262)

  // ---- team color panel
  const panelY = 330
  const panelH = 760
  ctx.fillStyle = data.teamColor
  ctx.fillRect(0, panelY, W, panelH)

  ctx.fillStyle = onColor
  ctx.globalAlpha = 0.8
  ctx.font = `600 28px ${HEAD}`
  const gameLine = wrap(ctx, data.gameName.toUpperCase(), W - 160, 1)[0] ?? ''
  ctx.fillText(gameLine, W / 2, panelY + 90)
  ctx.globalAlpha = 1

  ctx.font = `800 92px ${BODY}`
  const nameLines = wrap(ctx, data.teamName, W - 140, 2)
  nameLines.forEach((line, i) => ctx.fillText(line, W / 2, panelY + 210 + i * 104))
  const afterName = panelY + 210 + (nameLines.length - 1) * 104

  ctx.font = `800 220px ${HEAD}`
  ctx.fillText(ordinal(data.place).toUpperCase(), W / 2, afterName + 300)
  ctx.font = `600 34px ${HEAD}`
  ctx.globalAlpha = 0.85
  ctx.fillText(
    `${data.tiedPlace ? 'TIED · ' : ''}OF ${data.teamCount} TEAM${data.teamCount === 1 ? '' : 'S'}`,
    W / 2, afterName + 370,
  )
  ctx.globalAlpha = 1

  // ---- stat tiles
  const tiles: { label: string; value: number }[] = [
    { label: 'POINTS', value: data.points },
    { label: 'ZONES', value: data.zonesClaimed },
    { label: 'CHALLENGES', value: data.challenges },
  ]
  const tileY = panelY + panelH + 70
  const gap = 28
  const tileW = (W - 120 - gap * 2) / 3
  const tileH = 250
  tiles.forEach((t, i) => {
    const x = 60 + i * (tileW + gap)
    ctx.fillStyle = BRAND.surface
    roundRect(ctx, x, tileY, tileW, tileH, 28)
    ctx.fill()
    ctx.strokeStyle = BRAND.line
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.fillStyle = data.teamColor === BRAND.paper ? BRAND.ink : data.teamColor
    ctx.font = `800 96px ${HEAD}`
    ctx.fillText(String(t.value), x + tileW / 2, tileY + 140)
    ctx.fillStyle = BRAND.inkFaint
    ctx.font = `600 24px ${HEAD}`
    ctx.fillText(t.label, x + tileW / 2, tileY + 200)
  })

  // ---- members
  const memY = tileY + tileH + 110
  ctx.fillStyle = BRAND.marigoldDeep
  ctx.font = `600 24px ${HEAD}`
  ctx.fillText('T H E   T E A M', W / 2, memY)
  ctx.fillStyle = BRAND.inkSoft
  ctx.font = `600 40px ${BODY}`
  const memberLines = wrap(ctx, data.members.join('  ·  '), W - 160, 3)
  memberLines.forEach((line, i) => ctx.fillText(line, W / 2, memY + 66 + i * 54))

  // ---- footer
  ctx.fillStyle = BRAND.inkGhost
  ctx.font = `500 26px ${HEAD}`
  ctx.fillText(data.dateLabel.toUpperCase(), W / 2, H - 120)
  ctx.fillStyle = data.teamColor
  ctx.fillRect(0, H - 40, W, 40)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not render image'))), 'image/png')
  })
}

/**
 * Renders the card and hands it to the phone's share sheet. Falls back to a
 * download on desktop browsers without file sharing. Resolves with which
 * path was taken, or 'cancelled' if the user dismissed the share sheet.
 */
export async function shareRecapCard(
  data: RecapCardData,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = await renderRecapCard(data)
  const safeName = data.teamName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'team'
  const file = new File([blob], `foray-${safeName}-recap.png`, { type: 'image/png' })

  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: `${data.teamName} — Foray recap` })
      return 'shared'
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'cancelled'
      // Some browsers advertise file sharing then refuse — fall through to download.
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
