import { describe, it, expect } from 'vitest'
import {
  toDate, nyDate, nyReadable, nyFileStamp, safeFileName, mediaExtension,
  rawCellText, csvField, buildCsv, formatBytes,
} from './exportFormat'

// 2026-09-20 18:05:33 UTC = 2:05:33 PM in New York (EDT, UTC-4).
const SEPT = new Date(Date.UTC(2026, 8, 20, 18, 5, 33))
// 2026-12-01 04:30:00 UTC = 11:30 PM the night before in New York (EST, UTC-5).
const DEC = new Date(Date.UTC(2026, 11, 1, 4, 30, 0))

describe('toDate', () => {
  it('reads Firestore Timestamps and {seconds, nanoseconds}', () => {
    expect(toDate({ toDate: () => SEPT })).toBe(SEPT)
    expect(toDate({ seconds: SEPT.getTime() / 1000, nanoseconds: 0 })?.getTime()).toBe(SEPT.getTime())
  })
  it('leaves plain numbers and strings alone', () => {
    expect(toDate(1700000000000)).toBeNull()
    expect(toDate('2026-09-20')).toBeNull()
    expect(toDate(null)).toBeNull()
  })
})

describe('New York times', () => {
  it('formats in Eastern time across daylight saving', () => {
    expect(nyReadable(SEPT)).toBe('2026-09-20 2:05:33 PM')
    expect(nyReadable(DEC)).toBe('2026-11-30 11:30:00 PM')
    expect(nyDate(DEC)).toBe('2026-11-30')
    expect(nyFileStamp(SEPT)).toBe('2026-09-20_14-05-33')
  })
  it('shows midnight and noon as 12', () => {
    expect(nyReadable(new Date(Date.UTC(2026, 8, 20, 4, 0, 0)))).toBe('2026-09-20 12:00:00 AM')
    expect(nyReadable(new Date(Date.UTC(2026, 8, 20, 16, 0, 0)))).toBe('2026-09-20 12:00:00 PM')
  })
})

describe('safeFileName', () => {
  it('removes characters Mac/Windows/Drive reject', () => {
    expect(safeFileName('Pizza/Bagel: "Best?" <NYC>|*')).toBe('Pizza-Bagel Best NYC')
    expect(safeFileName('  lots   of\tspace  ')).toBe('lots of space')
    expect(safeFileName('...hidden')).toBe('hidden')
    expect(safeFileName('ends with dot.')).toBe('ends with dot')
  })
  it('falls back when nothing is left', () => {
    expect(safeFileName('???')).toBe('untitled')
    expect(safeFileName('', 60, 'team_1')).toBe('team_1')
  })
  it('caps length without splitting an emoji', () => {
    expect(safeFileName('🍕🍕🍕🍕', 3)).toBe('🍕🍕🍕')
    expect(safeFileName('a'.repeat(100)).length).toBe(60)
  })
})

describe('mediaExtension', () => {
  const url = (path: string) =>
    `https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(path)}?alt=media&token=abc`
  it('uses the stored file name from the download URL', () => {
    expect(mediaExtension(url('submissions/g1/team_1/ch_1_1700000000000.MOV'), 'video')).toBe('mov')
    expect(mediaExtension(url('submissions/g1/team_1/ch_1_1700000000000.jpg'), 'photo')).toBe('jpg')
  })
  it('falls back to the media type', () => {
    expect(mediaExtension(url('submissions/g1/team_1/noext'), 'video')).toBe('mp4')
    expect(mediaExtension('not a url', 'audio')).toBe('m4a')
    expect(mediaExtension('', 'other')).toBe('bin')
  })
})

describe('CSV', () => {
  it('formats raw values', () => {
    expect(rawCellText(null)).toBe('')
    expect(rawCellText(false)).toBe('false')
    expect(rawCellText(-73.98)).toBe('-73.98')
    expect(rawCellText({ toDate: () => SEPT })).toBe('2026-09-20T18:05:33.000Z')
    expect(rawCellText(['pizza', '3'])).toBe('["pizza","3"]')
  })
  it('quotes and escapes fields', () => {
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
  })
  it('defuses spreadsheet formulas in text but not numbers', () => {
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvField('@sum')).toBe('"\'@sum"')
    expect(csvField('-5')).toBe('"-5"')
    expect(csvField(-73.98)).toBe('"-73.98"')
  })
  it('starts with a BOM and uses CRLF', () => {
    const csv = buildCsv(['a', 'b'], [[1, 'x']])
    expect(csv).toBe('﻿"a","b"\r\n"1","x"\r\n')
  })
})

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(1_234_000_000)).toBe('1.2 GB')
    expect(formatBytes(340_000_000)).toBe('340 MB')
    expect(formatBytes(12_000)).toBe('12 KB')
  })
})
