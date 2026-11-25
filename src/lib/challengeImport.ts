// =============================================================================
// Foray — challenge tags and the spreadsheet import (admin Import Challenges page)
//
// The challenge spreadsheet (Google Sheets, "Gamma v1" tab) is downloaded as a
// CSV and dropped on /admin/import-challenges. This file turns that CSV into a
// plan: which challenges get new tags or wording, which are new, and which
// active challenges are missing from the sheet (they get switched off, never
// deleted, so past games still link to them).
//
// Matching: every challenge has a permanent id (ch_001, seq_097, …) that games
// use to point at it, so a row with an ID column value matches by id. A row
// with no id falls back to matching by its wording. New rows get the next free
// id, and the page shows the id column to paste back into the sheet.
//
// No Firebase imports here, so it can be tested on its own.
// =============================================================================

import { buildCsv } from './exportFormat'

// ─── Tags ────────────────────────────────────────────────────────────────────

export interface TagDef {
  key: string      // stored in challenges/{id}.tags
  label: string    // shown on screen and in the export
  header: string   // the sheet column it comes from (matched loosely)
}

/** The 13 tags in the sheet, in the sheet's column order. */
export const CHALLENGE_TAGS: TagDef[] = [
  { key: 'purchase', label: 'Purchase', header: 'Purchase of something' },
  { key: 'universal', label: 'Universal', header: 'Universal' },
  { key: 'strangers', label: 'Strangers', header: 'Interacting with Strangers' },
  { key: 'public_space', label: 'Public space', header: 'Interact with a public space/institution, e.g. park or library' },
  { key: 'food', label: 'Food', header: 'Food' },
  { key: 'teamwork', label: 'Teamwork', header: 'Teammates work together' },
  { key: 'park', label: 'Park', header: 'Park/green space' },
  { key: 'landmark_trivia', label: 'Landmark trivia', header: 'Trivia of landmarks (locations/buildings)' },
  { key: 'city_trivia', label: 'City trivia', header: 'Trivia of the City (history, e.g. who is this park named after)' },
  { key: 'physical', label: 'Physical', header: 'Physical activity' },
  { key: 'performance', label: 'Performance', header: 'Performance' },
  { key: 'transit', label: 'Public transport', header: 'Public transport' },
  { key: 'animals', label: 'Animals', header: 'Animals' },
]

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** A key for a column header: a known tag's key, or a new one made from the header. */
export function tagKeyForHeader(header: string): string {
  const h = squash(header)
  const known = CHALLENGE_TAGS.find((t) => squash(t.header) === h || squash(t.label) === h || t.key.replace(/_/g, '') === h)
  if (known) return known.key
  return header.toLowerCase().replace(/\(.*?\)/g, '').trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
}

/** On-screen name for a stored tag key (unknown keys are shown tidied up). */
export function tagLabel(key: string): string {
  const known = CHALLENGE_TAGS.find((t) => t.key === key)
  if (known) return known.label
  const words = key.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Tags in the sheet's order (known ones first), so lists always read the same. */
export function sortTags(keys: Iterable<string>): string[] {
  const order = (k: string) => {
    const i = CHALLENGE_TAGS.findIndex((t) => t.key === k)
    return i === -1 ? CHALLENGE_TAGS.length : i
  }
  return [...new Set(keys)].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** Rows of cells from CSV text (quotes, doubled quotes, commas and line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// ─── Reading the sheet ───────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard'
export type Verification = 'photo' | 'video' | 'audio'

export interface SheetRow {
  rowNumber: number            // the row number in the sheet (header is row 1)
  id: string                   // '' when the ID column is empty or missing
  text: string
  difficulty: Difficulty | null
  verification: Verification | null
  tags: string[]
  active: boolean | null       // the Active column (null when the sheet has none: listed = on)
}

export interface ParsedSheet {
  rows: SheetRow[]
  tagKeys: string[]            // every tag column found, in order
  hasIdColumn: boolean
  problems: string[]           // things that stop the import (missing columns)
}

const TRUE_CELLS = new Set(['true', '1', 'yes', 'y', 'x', '✓'])
const TAG_CELLS = new Set([...TRUE_CELLS, 'false', '0', 'no', 'n', ''])

function readDifficulty(v: string): Difficulty | null {
  const s = v.trim().toLowerCase()
  return s === 'easy' || s === 'medium' || s === 'hard' ? s : null
}

function readVerification(v: string): Verification | null {
  const s = v.trim().toLowerCase()
  return s === 'photo' || s === 'video' || s === 'audio' ? s : null
}

/** Finds the columns by their headers and reads every row that has challenge text. */
export function parseChallengeSheet(cells: string[][]): ParsedSheet {
  const problems: string[] = []
  const [header = [], ...body] = cells
  const h = header.map((c) => c.trim())
  const find = (test: (s: string) => boolean) => h.findIndex((c) => test(c.toLowerCase()))

  const idCol = find((s) => s === 'id' || s === 'challenge id')
  let textCol = find((s) => s.includes('challenge') && s !== 'challenge id')
  if (textCol === -1) textCol = idCol === 0 ? 1 : 0
  const diffCol = find((s) => s.startsWith('difficulty'))
  const typeCol = find((s) => s.startsWith('response'))
  const activeCol = find((s) => s === 'active' || s === 'is active')
  if (diffCol === -1) problems.push('No "Difficulty" column found.')
  if (typeCol === -1) problems.push('No "Response Type" column found.')

  // Tag columns: every other named column whose cells are all TRUE/FALSE-style.
  const used = new Set([idCol, textCol, diffCol, typeCol, activeCol])
  const tagCols = h
    .map((name, i) => ({ name, i }))
    .filter(({ name, i }) => name !== '' && !used.has(i))
    .filter(({ i }) => body.every((r) => TAG_CELLS.has((r[i] ?? '').trim().toLowerCase())))
    .map(({ name, i }) => ({ i, key: tagKeyForHeader(name) }))
  if (tagCols.length === 0) problems.push('No tag columns (TRUE/FALSE) found.')

  const rows: SheetRow[] = []
  body.forEach((r, n) => {
    const text = (r[textCol] ?? '').trim()
    if (!text) return
    rows.push({
      rowNumber: n + 2,
      id: idCol === -1 ? '' : (r[idCol] ?? '').trim(),
      text,
      difficulty: diffCol === -1 ? null : readDifficulty(r[diffCol] ?? ''),
      verification: typeCol === -1 ? null : readVerification(r[typeCol] ?? ''),
      tags: sortTags(tagCols.filter(({ i }) => TRUE_CELLS.has((r[i] ?? '').trim().toLowerCase())).map((c) => c.key)),
      active: activeCol === -1 || (r[activeCol] ?? '').trim() === '' ? null : TRUE_CELLS.has((r[activeCol] ?? '').trim().toLowerCase()),
    })
  })
  return { rows, tagKeys: sortTags(tagCols.map((c) => c.key)), hasIdColumn: idCol !== -1, problems }
}

// ─── Planning the import ─────────────────────────────────────────────────────

/** A challenge doc as stored in Firestore (only the fields the import looks at). */
export interface AppChallenge {
  id: string
  title?: string
  description?: string
  difficulty?: string
  verification_type?: string
  challenge_type?: string
  is_active?: boolean
  tags?: string[]
}

export const POINTS: Record<Difficulty, number> = { easy: 1, medium: 3, hard: 5 }
export const ID_PATTERN = /^(ch|seq)_\d{3,}$/

/** Titles are the first 80 characters of the description, as for the existing challenges. */
export const titleFor = (description: string) => description.slice(0, 80).trimEnd()

export type Change =
  | { field: 'tags'; from: string[]; to: string[] }
  | { field: 'wording'; from: string; to: string }
  | { field: 'difficulty'; from: string; to: Difficulty }
  | { field: 'type'; from: string; to: Verification }
  | { field: 'switch_on' }
  | { field: 'switch_off' }

export interface PlanRow {
  row: SheetRow
  id: string                    // the challenge id this row is (or will be); '' when skipped
  kind: 'update' | 'unchanged' | 'new' | 'skip'
  matchedBy?: 'id' | 'wording'
  changes: Change[]             // update only
  note?: string                 // why a row is skipped, or a heads-up
}

export interface ImportPlan {
  rows: PlanRow[]
  switchOff: AppChallenge[]     // active challenges that aren't in the sheet
  counts: { update: number; unchanged: number; new: number; skip: number; switchOff: number }
}

/** Everything but letters and digits, lowercased: tells "same wording" apart from small typing noise. */
const wordingKey = (s: string) => squash(s)
const isCyoaText = (s: string) => /^choose your own adventure/i.test(s.trim())

function sameTags(a: string[] = [], b: string[] = []): boolean {
  const x = sortTags(a), y = sortTags(b)
  return x.length === y.length && x.every((k, i) => k === y[i])
}

/** Next free number after every ch_/seq_ id in use, e.g. 100 after seq_099. */
export function nextIdNumber(ids: Iterable<string>): number {
  let max = 0
  for (const id of ids) {
    const m = /^(?:ch|seq)_(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

const pad = (n: number) => String(n).padStart(3, '0')

/** The next free regular challenge id, e.g. ch_120. */
export const nextChallengeId = (ids: Iterable<string>) => `ch_${pad(nextIdNumber(ids))}`

/** The opening phrase, up to the first . ! ? or : ("Leave your mark."), when it's a real phrase. */
function opener(s: string): string {
  const m = /^(.{6,60}?)[.!?:]/.exec(s.trim())
  return m ? wordingKey(m[1]) : ''
}

/** What importing `sheet` would do to the challenges in the app. Writes nothing. */
export function planImport(sheet: SheetRow[], app: AppChallenge[]): ImportPlan {
  const byId = new Map(app.map((c) => [c.id, c]))
  const claimed = new Set<string>()
  const sheetIds = new Set(sheet.map((r) => r.id).filter(Boolean))
  const free = (c: AppChallenge) => !claimed.has(c.id) && !sheetIds.has(c.id)
  let next = nextIdNumber([...byId.keys(), ...sheetIds])

  // Pass 1: by id, then by exact wording (or a Choose Your Own Adventure card
  // whose sheet text starts with its title). Bad or repeated ids are skipped.
  type Found = { match?: AppChallenge; matchedBy?: PlanRow['matchedBy']; skip?: string; note?: string }
  const found: Found[] = sheet.map((row): Found => {
    if (row.id) {
      if (!ID_PATTERN.test(row.id)) return { skip: `"${row.id}" isn't a challenge ID (they look like ch_001).` }
      if (claimed.has(row.id)) return { skip: `ID ${row.id} is used by an earlier row too.` }
      claimed.add(row.id)
      const match = byId.get(row.id)
      return match ? { match, matchedBy: 'id' } : {}
    }
    const key = wordingKey(row.text)
    const match = app.find((c) => free(c) && wordingKey(c.description ?? '') === key)
      ?? app.find((c) => free(c) && c.challenge_type === 'sequential' && !!c.title && key.startsWith(wordingKey(c.title)))
    if (match) claimed.add(match.id)
    return match ? { match, matchedBy: 'wording' } : {}
  })

  // Pass 2: a row with no id whose wording changed still matches a leftover
  // challenge when they open with the same phrase ("Leave your mark.") and
  // nothing else left over on either side shares it.
  const leftRows = sheet.map((row, i) => ({ row, i })).filter(({ row, i }) => !row.id && !found[i].match && !found[i].skip)
  const leftApp = app.filter((c) => free(c) && c.challenge_type !== 'sequential')
  for (const { row, i } of leftRows) {
    const o = opener(row.text)
    if (!o) continue
    const apps = leftApp.filter((c) => !claimed.has(c.id) && opener(c.description ?? '') === o)
    const rowsSame = leftRows.filter((r) => opener(r.row.text) === o)
    if (apps.length === 1 && rowsSame.length === 1) {
      claimed.add(apps[0].id)
      found[i] = { match: apps[0], matchedBy: 'wording', note: 'Matched by its opening words because the wording changed. Check this is the same challenge.' }
    }
  }

  const rows: PlanRow[] = sheet.map((row, i): PlanRow => {
    const skip = (note: string): PlanRow => ({ row, id: '', kind: 'skip', changes: [], note })
    const { match, matchedBy, note } = found[i]
    if (found[i].skip) return skip(found[i].skip!)
    if (!row.difficulty) return skip('Difficulty must be Easy, Medium or Hard.')
    if (!row.verification) return skip('Response type must be Photo or Video.')

    if (!match) {
      if (isCyoaText(row.text)) return skip('New Choose Your Own Adventure cards need their steps set up by hand.')
      const id = row.id || `ch_${pad(next++)}`
      claimed.add(id)
      return { row, id, kind: 'new', changes: [] }
    }

    const changes: Change[] = []
    if (!sameTags(match.tags, row.tags)) changes.push({ field: 'tags', from: sortTags(match.tags ?? []), to: row.tags })
    // Sequential cards keep their wording (the app splits it into steps); the sheet's text is a summary.
    if (match.challenge_type !== 'sequential' && wordingKey(match.description ?? '') !== wordingKey(row.text)) {
      changes.push({ field: 'wording', from: match.description ?? '', to: row.text })
    }
    if (match.difficulty !== row.difficulty) changes.push({ field: 'difficulty', from: match.difficulty ?? '', to: row.difficulty })
    if (match.verification_type !== row.verification) changes.push({ field: 'type', from: match.verification_type ?? '', to: row.verification })
    // Listed in the sheet means on, unless its Active column says FALSE.
    if (row.active === false) { if (match.is_active !== false) changes.push({ field: 'switch_off' }) }
    else if (match.is_active === false) changes.push({ field: 'switch_on' })
    return { row, id: match.id, kind: changes.length ? 'update' : 'unchanged', matchedBy, changes, note }
  })

  const switchOff = app.filter((c) => c.is_active !== false && !claimed.has(c.id))
  const count = (k: PlanRow['kind']) => rows.filter((r) => r.kind === k).length
  return {
    rows,
    switchOff,
    counts: { update: count('update'), unchanged: count('unchanged'), new: count('new'), skip: count('skip'), switchOff: switchOff.length },
  }
}

// ─── Turning the plan into Firestore writes ──────────────────────────────────

export interface ChallengeFields {
  text: string
  difficulty: Difficulty
  verification: Verification
  tags: string[]
  active: boolean
}

/** A new challenge doc, with the same defaults every existing challenge has. */
export function newChallengeDoc(id: string, f: ChallengeFields, uid: string): Record<string, unknown> {
  return {
    id,
    title: titleFor(f.text),
    description: f.text,
    difficulty: f.difficulty,
    points: POINTS[f.difficulty],
    verification_type: f.verification,
    tags: sortTags(f.tags),
    challenge_type: 'standard',
    time_estimate: 'medium',
    player_profile: 'adventurer',
    tier2: null,
    city_tags: ['nyc'],
    zone_tags: [],
    source: 'official',
    is_active: f.active,
    created_by: uid,
  }
}

export type Write =
  | { op: 'update'; id: string; data: Record<string, unknown> }
  | { op: 'create'; id: string; data: Record<string, unknown> }

/**
 * The writes for a plan. Updates only touch the fields that changed (plus the
 * tags, always written so every challenge has the list). New challenges get
 * the same defaults every existing challenge has.
 */
export function buildWrites(plan: ImportPlan, uid: string): Write[] {
  const writes: Write[] = []
  for (const p of plan.rows) {
    if (p.kind === 'update') {
      const data: Record<string, unknown> = { tags: p.row.tags }
      for (const c of p.changes) {
        if (c.field === 'wording') { data.description = c.to; data.title = titleFor(c.to) }
        if (c.field === 'difficulty') { data.difficulty = c.to; data.points = POINTS[c.to] }
        if (c.field === 'type') data.verification_type = c.to
        if (c.field === 'switch_on') data.is_active = true
        if (c.field === 'switch_off') data.is_active = false
      }
      writes.push({ op: 'update', id: p.id, data })
    } else if (p.kind === 'new' && p.row.difficulty && p.row.verification) {
      writes.push({
        op: 'create',
        id: p.id,
        data: newChallengeDoc(p.id, {
          text: p.row.text, difficulty: p.row.difficulty, verification: p.row.verification,
          tags: p.row.tags, active: p.row.active !== false,
        }, uid),
      })
    }
  }
  for (const c of plan.switchOff) writes.push({ op: 'update', id: c.id, data: { is_active: false } })
  return writes
}

/**
 * The ID column to paste into the sheet: an "ID" header, then one line per
 * challenge row in row order (blank for a skipped row). Rows with no
 * challenge text are left out of the plan, so this lines up as long as the
 * sheet has no blank rows in the middle (the page warns when it does).
 */
export function idColumnText(plan: ImportPlan): string {
  return ['ID', ...plan.rows.map((p) => p.id)].join('\n')
}

/** True when every row's number follows the one before it (no blank rows in between). */
export function rowsAreContiguous(rows: SheetRow[]): boolean {
  return rows.every((r, i) => r.rowNumber === i + 2)
}

// ─── Downloading the challenges as a sheet ───────────────────────────────────

/**
 * Every challenge as a CSV in the sheet's own layout (ID, text, Difficulty,
 * Response Type, Active, one TRUE/FALSE column per tag), so it opens in
 * Google Sheets and can be imported back unchanged.
 */
export function challengesToCsv(challenges: AppChallenge[]): string {
  const extra = sortTags(challenges.flatMap((c) => c.tags ?? [])).filter((k) => !CHALLENGE_TAGS.some((t) => t.key === k))
  const tagCols = [...CHALLENGE_TAGS.map((t) => ({ key: t.key, header: t.header })), ...extra.map((k) => ({ key: k, header: tagLabel(k) }))]
  const header = ['ID', 'Challenge', 'Difficulty', 'Response Type', 'Active', ...tagCols.map((t) => t.header)]
  const sorted = [...challenges].sort((a, b) => (idNumber(a.id) - idNumber(b.id)) || a.id.localeCompare(b.id))
  const body = sorted.map((c) => [
    c.id,
    c.description ?? c.title ?? '',
    cap(c.difficulty ?? ''),
    cap(c.verification_type ?? ''),
    c.is_active === false ? 'FALSE' : 'TRUE',
    ...tagCols.map((t) => ((c.tags ?? []).includes(t.key) ? 'TRUE' : 'FALSE')),
  ])
  return buildCsv(header, body)
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const idNumber = (id: string) => Number(/_(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER)
