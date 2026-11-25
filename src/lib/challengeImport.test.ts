import { describe, it, expect } from 'vitest'
import {
  buildWrites, challengesToCsv, idColumnText, newChallengeDoc, nextChallengeId, parseChallengeSheet, parseCsv, planImport, tagKeyForHeader, tagLabel,
  type AppChallenge,
} from './challengeImport'

const HEADER = 'v1 Challenges,Difficulty - viewed by player,Response Type -- viewed by player,Purchase of something,"Interact with a public space/institution, e.g. park or library",Animals'

const csv = (...lines: string[]) => [HEADER, ...lines].join('\r\n')

const app: AppChallenge[] = [
  { id: 'ch_001', title: 'Support libraries!', description: 'Support libraries! Give a thumbs up', difficulty: 'easy', verification_type: 'photo', challenge_type: 'standard', is_active: true },
  { id: 'ch_002', title: 'Old text', description: 'Leave your mark. Old text', difficulty: 'easy', verification_type: 'photo', challenge_type: 'standard', is_active: true },
  { id: 'ch_003', description: 'Not in the sheet', difficulty: 'medium', verification_type: 'photo', challenge_type: 'standard', is_active: true },
  { id: 'ch_004', description: 'Already off', difficulty: 'medium', verification_type: 'photo', is_active: false },
  { id: 'seq_005', title: 'Choose Your Own Adventure (List Edition)', description: 'Choose Your Own Adventure (List Edition)', difficulty: 'medium', verification_type: 'video', challenge_type: 'sequential', is_active: true },
]

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside quotes', () => {
    expect(parseCsv('a,"b, c","say ""hi""",\r\n"two\nlines",x\n\n')).toEqual([
      ['a', 'b, c', 'say "hi"', ''],
      ['two\nlines', 'x'],
    ])
  })
})

describe('tags', () => {
  it('maps the sheet headers to short keys and labels', () => {
    expect(tagKeyForHeader('Interact with a public space/institution, e.g. park or library')).toBe('public_space')
    expect(tagKeyForHeader('Trivia of the City (history, e.g. who is this park named after)')).toBe('city_trivia')
    expect(tagLabel('public_space')).toBe('Public space')
    expect(tagKeyForHeader('Night time (after dark)')).toBe('night_time')
    expect(tagLabel('night_time')).toBe('Night time')
  })
})

describe('parseChallengeSheet', () => {
  it('reads difficulty, response type and the tag columns', () => {
    const s = parseChallengeSheet(parseCsv(csv('Support libraries! Give a thumbs up,Easy,Photo,FALSE,TRUE,FALSE')))
    expect(s.problems).toEqual([])
    expect(s.hasIdColumn).toBe(false)
    expect(s.tagKeys).toEqual(['purchase', 'public_space', 'animals'])
    expect(s.rows[0]).toMatchObject({ rowNumber: 2, id: '', difficulty: 'easy', verification: 'photo', tags: ['public_space'] })
  })

  it('accepts 1/0 tag cells and an ID column', () => {
    const s = parseChallengeSheet([['ID', 'v1 Challenges', 'Difficulty', 'Response Type', 'Food'], ['ch_009', 'Eat', 'Hard', 'Video', '1']])
    expect(s.hasIdColumn).toBe(true)
    expect(s.rows[0]).toMatchObject({ id: 'ch_009', text: 'Eat', tags: ['food'] })
  })
})

describe('planImport', () => {
  const sheet = parseChallengeSheet(parseCsv(csv(
    'Support libraries! Give a thumbs up,Easy,Photo,FALSE,TRUE,FALSE',
    'Leave your mark. New text,Easy,Photo,FALSE,FALSE,FALSE',
    'Choose Your Own Adventure (List Edition): Part 1 - pick a food,Medium,Video,FALSE,FALSE,FALSE',
    'Woof. Take a picture with at least 3 dogs,Easy,Photo,FALSE,FALSE,TRUE',
    'Choose Your Own Adventure (Brand New): Part 1,Medium,Video,FALSE,FALSE,FALSE',
  ))).rows

  it('without IDs: matches by wording, finds new ones, switches off the missing', () => {
    const plan = planImport(sheet, app)
    expect(plan.rows.map((r) => [r.id, r.kind])).toEqual([
      ['ch_001', 'update'],       // gains a tag
      ['ch_002', 'update'],       // reworded, matched by its opening words
      ['seq_005', 'unchanged'],   // CYOA matched by title; no tags in the sheet, none in the app
      ['ch_006', 'new'],
      ['', 'skip'],               // new CYOA cards need steps set up by hand
    ])
    expect(plan.rows[1].note).toMatch(/opening words/)
    expect(plan.switchOff.map((c) => c.id)).toEqual(['ch_003'])
  })

  it('does not match by opening words when two leftovers share them', () => {
    const twins: AppChallenge[] = [
      { id: 'ch_001', description: 'Stay hydrated! Take a picture', difficulty: 'easy', verification_type: 'photo', is_active: true },
      { id: 'ch_002', description: 'Stay hydrated! Fill a bottle', difficulty: 'easy', verification_type: 'photo', is_active: true },
    ]
    const rows = parseChallengeSheet(parseCsv(csv('Stay hydrated! Something new,Easy,Photo,FALSE,FALSE,FALSE'))).rows
    expect(planImport(rows, twins).rows[0]).toMatchObject({ id: 'ch_003', kind: 'new' })
  })

  it('with IDs: a reworded challenge stays the same challenge', () => {
    const withIds = sheet.map((r, i) => ({ ...r, id: ['ch_001', 'ch_002', 'seq_005', '', ''][i] }))
    const plan = planImport(withIds, app)
    expect(plan.rows[1]).toMatchObject({ id: 'ch_002', kind: 'update', matchedBy: 'id' })
    expect(plan.rows[1].changes).toEqual([{ field: 'wording', from: 'Leave your mark. Old text', to: 'Leave your mark. New text' }])
    expect(plan.rows[3]).toMatchObject({ id: 'ch_006', kind: 'new' })
    expect(plan.switchOff.map((c) => c.id)).toEqual(['ch_003'])
    expect(idColumnText(plan)).toBe('ID\nch_001\nch_002\nseq_005\nch_006\n')
  })

  it('skips bad or repeated IDs, and new IDs never collide with ones typed in the sheet', () => {
    const rows = sheet.slice(0, 4).map((r, i) => ({ ...r, id: ['bad id', 'ch_001', 'ch_001', ''][i] }))
    rows.push({ ...sheet[3], rowNumber: 9, id: 'ch_050' })
    const plan = planImport(rows, app)
    expect(plan.rows.map((r) => [r.id, r.kind])).toEqual([
      ['', 'skip'], ['ch_001', 'update'], ['', 'skip'], ['ch_051', 'new'], ['ch_050', 'new'],
    ])
  })

  it('flags difficulty and photo/video changes, and switches a listed challenge back on', () => {
    const rows = parseChallengeSheet(parseCsv(csv('Already off,Hard,Video,TRUE,FALSE,FALSE'))).rows
    const plan = planImport(rows, app)
    expect(plan.rows[0].changes.map((c) => c.field)).toEqual(['tags', 'difficulty', 'type', 'switch_on'])
  })
})

describe('buildWrites', () => {
  it('updates only what changed, creates new ones with defaults, switches off the missing', () => {
    const rows = parseChallengeSheet(parseCsv(csv(
      'Support libraries! Give a thumbs up,Hard,Photo,FALSE,TRUE,FALSE',
      'Woof. Take a picture with at least 3 dogs,Easy,Photo,FALSE,FALSE,TRUE',
    ))).rows
    const writes = buildWrites(planImport(rows, app), 'uid1')
    expect(writes[0]).toEqual({ op: 'update', id: 'ch_001', data: { tags: ['public_space'], difficulty: 'hard', points: 5 } })
    expect(writes[1]).toMatchObject({
      op: 'create', id: 'ch_006',
      data: { title: 'Woof. Take a picture with at least 3 dogs', difficulty: 'easy', points: 1, tags: ['animals'], is_active: true, created_by: 'uid1', challenge_type: 'standard' },
    })
    expect(writes.slice(2)).toEqual([
      { op: 'update', id: 'ch_002', data: { is_active: false } },
      { op: 'update', id: 'ch_003', data: { is_active: false } },
      { op: 'update', id: 'seq_005', data: { is_active: false } },
    ])
  })
})

describe('Active column and downloading as a sheet', () => {
  it('an Active column can switch challenges off, and new inactive rows are created off', () => {
    const rows = parseChallengeSheet([
      ['ID', 'Challenge', 'Difficulty', 'Response Type', 'Active', 'Food'],
      ['ch_001', 'Support libraries! Give a thumbs up', 'Easy', 'Photo', 'FALSE', 'FALSE'],
      ['ch_004', 'Already off', 'Medium', 'Photo', 'FALSE', 'FALSE'],
      ['', 'Brand new', 'Easy', 'Video', 'FALSE', 'TRUE'],
    ]).rows
    expect(rows.map((r) => r.active)).toEqual([false, false, false])
    const plan = planImport(rows, app)
    expect(plan.rows[0].changes.map((c) => c.field)).toEqual(['switch_off'])
    expect(plan.rows[1].kind).toBe('unchanged')          // off, and the sheet says off
    const writes = buildWrites(plan, 'u')
    expect(writes.find((w) => w.id === 'ch_001')?.data).toEqual({ tags: [], is_active: false })
    expect(writes.find((w) => w.op === 'create')?.data).toMatchObject({ description: 'Brand new', is_active: false, tags: ['food'] })
  })

  it('a downloaded sheet imports back with no changes', () => {
    const tagged = app.map((c, i) => ({ ...c, tags: i === 0 ? ['food', 'night_time'] : [] }))
    const csv = challengesToCsv(tagged)
    expect(csv.split('\r\n')[0]).toContain('"ID","Challenge","Difficulty","Response Type","Active","Purchase of something"')
    const plan = planImport(parseChallengeSheet(parseCsv(csv)).rows, tagged)
    expect(plan.counts).toEqual({ update: 0, unchanged: 5, new: 0, skip: 0, switchOff: 0 })
  })

  it('next free id', () => {
    expect(nextChallengeId(['ch_001', 'seq_099', 'ch_100'])).toBe('ch_101')
    expect(newChallengeDoc('ch_101', { text: 'x', difficulty: 'hard', verification: 'video', tags: ['animals', 'food'], active: true }, 'u'))
      .toMatchObject({ points: 5, tags: ['food', 'animals'], is_active: true, challenge_type: 'standard' })
  })
})
