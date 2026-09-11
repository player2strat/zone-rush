// =============================================================================
// Foray — Zone map card (post-reveal share image)
//
// Draws the final zone map as a 1080×1920 PNG: every zone outline on brand
// paper, claimed zones filled in their team's color (yours at full strength,
// rivals lighter), locked zones with a heavy outline, a headline like
// "We claimed 6 of 14 zones", and a team legend. No map tiles — the shapes
// alone read as the city, and it keeps the card in the Foray look with no
// image permissions to worry about.
// =============================================================================

import { BRAND } from './brand'

export interface ZoneMapCardZone {
  id: string
  name: string
  boundary: GeoJSON.Geometry | null
}

export interface ZoneMapCardOwner {
  teamId: string
  teamColor: string
  locked: boolean
}

export interface ZoneMapCardTeam {
  id: string
  name: string
  color: string
  zonesClaimed: number
}

export interface ZoneMapCardData {
  gameName: string
  dateLabel: string
  myTeamId: string
  myTeamName: string
  myTeamColor: string
  zones: ZoneMapCardZone[]
  ownership: Map<string, ZoneMapCardOwner>
  teams: ZoneMapCardTeam[]
}

const W = 1080
const H = 1920
const HEAD = "'Martian Mono', ui-monospace, Menlo, monospace"
const BODY = "'Helvetica Neue', Helvetica, Arial, sans-serif"

// Map area on the card
const MAP_X = 60
const MAP_Y = 520
const MAP_W = W - 120
const MAP_H = 900

type Ring = [number, number][]

function ringsOf(g: GeoJSON.Geometry | null): Ring[][] {
  // Returns polygons, each as [outer, ...holes]
  if (!g) return []
  if (g.type === 'Polygon') return [g.coordinates as Ring[]]
  if (g.type === 'MultiPolygon') return g.coordinates as Ring[][]
  return []
}

// Web Mercator latitude, returned in DEGREE-equivalent units so it shares a
// scale with raw longitude degrees (otherwise the map squashes vertically).
function mercY(lat: number): number {
  const phi = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180
  return (Math.log(Math.tan(Math.PI / 4 + phi / 2)) * 180) / Math.PI
}

function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
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
  return lines
}

export async function renderZoneMapCard(data: ZoneMapCardData): Promise<Blob> {
  try { await document.fonts.load(`700 100px "Martian Mono"`) } catch { /* fallback stack */ }
  const logo = await loadLogo()

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas not supported')

  // ---- background + logo
  ctx.fillStyle = BRAND.paper
  ctx.fillRect(0, 0, W, H)
  if (logo) {
    const lw = 460
    const lh = lw * (logo.naturalHeight / Math.max(1, logo.naturalWidth))
    ctx.drawImage(logo, (W - lw) / 2, 80, lw, lh)
  }
  ctx.textAlign = 'center'
  ctx.fillStyle = BRAND.marigoldDeep
  ctx.font = `600 24px ${HEAD}`
  ctx.fillText('C L A I M   T H E   C I T Y', W / 2, 232)

  // ---- headline
  const mine = data.zones.filter((z) => data.ownership.get(z.id)?.teamId === data.myTeamId).length
  ctx.fillStyle = BRAND.ink
  ctx.font = `800 76px ${BODY}`
  const headline = mine === 0
    ? `We fought for ${data.zones.length} zones`
    : `We claimed ${mine} of ${data.zones.length} zones`
  ctx.fillText(headline, W / 2, 340)
  ctx.fillStyle = data.myTeamColor
  ctx.font = `800 40px ${BODY}`
  ctx.fillText(wrap(ctx, data.myTeamName, W - 160, 1)[0] ?? data.myTeamName, W / 2, 400)
  ctx.fillStyle = BRAND.inkFaint
  ctx.font = `600 24px ${HEAD}`
  ctx.fillText(wrap(ctx, data.gameName.toUpperCase(), W - 160, 1)[0] ?? '', W / 2, 452)

  // ---- project zones into the map box
  const polys = data.zones.map((z) => ({ zone: z, polys: ringsOf(z.boundary) }))
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of polys) for (const poly of p.polys) for (const ring of poly) for (const [lng, lat] of ring) {
    const y = mercY(lat)
    if (lng < minX) minX = lng
    if (lng > maxX) maxX = lng
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const hasShapes = Number.isFinite(minX) && maxX > minX && maxY > minY
  const pad = 24
  const scale = hasShapes
    ? Math.min((MAP_W - pad * 2) / (maxX - minX), (MAP_H - pad * 2) / (maxY - minY))
    : 1
  const drawnW = (maxX - minX) * scale
  const drawnH = (maxY - minY) * scale
  const ox = MAP_X + (MAP_W - drawnW) / 2
  const oy = MAP_Y + (MAP_H - drawnH) / 2
  const px = (lng: number) => ox + (lng - minX) * scale
  const py = (lat: number) => oy + (maxY - mercY(lat)) * scale

  const tracePoly = (poly: Ring[]) => {
    ctx.beginPath()
    for (const ring of poly) {
      ring.forEach(([lng, lat], i) => {
        if (i === 0) ctx.moveTo(px(lng), py(lat))
        else ctx.lineTo(px(lng), py(lat))
      })
      ctx.closePath()
    }
  }

  if (!hasShapes) {
    ctx.fillStyle = BRAND.inkGhost
    ctx.font = `500 28px ${HEAD}`
    ctx.fillText('MAP UNAVAILABLE', W / 2, MAP_Y + MAP_H / 2)
  } else {
    // Unclaimed first, then rivals, then mine on top so my borders win.
    const order = [...polys].sort((a, b) => {
      const rank = (z: ZoneMapCardZone) => {
        const o = data.ownership.get(z.id)
        if (!o) return 0
        return o.teamId === data.myTeamId ? 2 : 1
      }
      return rank(a.zone) - rank(b.zone)
    })
    for (const { zone, polys: zp } of order) {
      const o = data.ownership.get(zone.id)
      for (const poly of zp) {
        tracePoly(poly)
        if (!o) {
          ctx.fillStyle = BRAND.surface
          ctx.fill('evenodd')
          ctx.strokeStyle = BRAND.lineStrong
          ctx.lineWidth = 2
          ctx.stroke()
        } else {
          const isMine = o.teamId === data.myTeamId
          ctx.fillStyle = hexAlpha(o.teamColor, isMine ? 0.9 : 0.45)
          ctx.fill('evenodd')
          ctx.strokeStyle = isMine ? o.teamColor : hexAlpha(o.teamColor, 0.8)
          ctx.lineWidth = o.locked ? 8 : 3
          ctx.stroke()
        }
      }
    }
  }

  // ---- legend
  const legendY = MAP_Y + MAP_H + 60
  const teams = [...data.teams].sort((a, b) => b.zonesClaimed - a.zonesClaimed || a.name.localeCompare(b.name))
  const rowH = 54
  const maxRows = Math.min(teams.length, 5)
  ctx.textAlign = 'left'
  ctx.font = `600 30px ${BODY}`
  for (let i = 0; i < maxRows; i++) {
    const t = teams[i]
    const y = legendY + i * rowH
    ctx.fillStyle = t.color
    ctx.beginPath()
    ctx.roundRect(MAP_X + 8, y - 16, 32, 32, 8)
    ctx.fill()
    ctx.fillStyle = t.id === data.myTeamId ? BRAND.ink : BRAND.inkMuted
    ctx.font = `${t.id === data.myTeamId ? 800 : 600} 30px ${BODY}`
    const label = wrap(ctx, t.name, MAP_W - 260, 1)[0] ?? t.name
    ctx.fillText(label, MAP_X + 60, y + 10)
    ctx.textAlign = 'right'
    ctx.fillStyle = t.color
    ctx.font = `800 32px ${HEAD}`
    ctx.fillText(`${t.zonesClaimed}`, MAP_X + MAP_W - 12, y + 10)
    ctx.textAlign = 'left'
  }

  // ---- footer
  ctx.textAlign = 'center'
  ctx.fillStyle = BRAND.inkGhost
  ctx.font = `500 26px ${HEAD}`
  ctx.fillText(data.dateLabel.toUpperCase(), W / 2, H - 120)
  ctx.fillStyle = data.myTeamColor
  ctx.fillRect(0, H - 40, W, 40)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render image'))), 'image/png')
  })
}
