import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  buildSubmissionsCsv, exportFileName, exportZipStream, mediaPathFor, PARALLEL_DOWNLOADS,
  type ExportGame, type ExportRow, type FetchMedia, type ZipProgress,
} from './exportFiles'

const GAME: ExportGame = {
  id: 'g1', name: 'Beta: Brooklyn #2', status: 'ended',
  startedAt: null, createdAt: null, practice: false,
}

const url = (file: string) =>
  `https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(`submissions/g1/team_1/${file}`)}?alt=media&token=t`

function row(id: string, over: Partial<ExportRow> = {}): ExportRow {
  return {
    id,
    raw: {
      game_id: 'g1', team_id: 'team_1', status: 'approved', gm_notes: '', zz_new_field: 'kept',
      gps_lat: 40.7, gps_lng: -73.9,
    },
    teamName: 'Red Team',
    challengeTitle: 'Find a bodega cat',
    challengeDescription: 'Photo with the cat',
    difficulty: 'easy',
    zoneName: 'Park Slope',
    submittedByName: 'Sam',
    submittedAt: new Date(Date.UTC(2026, 8, 20, 18, 5, 33)),
    mediaUrl: url(`${id}.jpg`),
    mediaType: 'photo',
    ...over,
  }
}

async function unzip(stream: ReadableStream<Uint8Array>) {
  const buf = await new Response(stream).arrayBuffer()
  return JSZip.loadAsync(buf)
}

describe('names', () => {
  it('names the zip after the game and today', () => {
    expect(exportFileName(GAME, 'zip')).toMatch(/^foray-export_Beta-Brooklyn-#2_\d{4}-\d{2}-\d{2}\.zip$/)
  })
  it('puts media under the team with time, title and id', () => {
    expect(mediaPathFor(row('abc'))).toBe('media/Red Team/2026-09-20_14-05-33_Find a bodega cat_abc.jpg')
    expect(mediaPathFor(row('abc', { mediaUrl: '' }))).toBeNull()
  })
})

describe('buildSubmissionsCsv', () => {
  it('has friendly columns, then every raw field, without the zip column when CSV-only', () => {
    const csv = buildSubmissionsCsv(GAME, [row('a')])
    const header = csv.slice(1).split('\r\n')[0]
    expect(header).toBe([
      'Game', 'Team', 'Challenge', 'Challenge description', 'Difficulty', 'Zone', 'Submitted by',
      'Status', 'GM notes', 'Submitted at (New York time)', 'submission_id',
      'game_id', 'team_id', 'gps_lat', 'gps_lng', 'zz_new_field',
    ].map((h) => `"${h}"`).join(','))
    expect(csv).toContain('"2026-09-20 2:05:33 PM"')
    expect(csv).toContain('"kept"')
  })
})

describe('exportZipStream', () => {
  it('zips media, the CSV and an errors list, and keeps going past a failure', async () => {
    const rows = [
      row('a'),
      row('b', { teamName: 'Blue Team', raw: { team_id: 'team_2', status: 'rejected' } }),
      row('c'),
      row('nomedia', { mediaUrl: '' }),
    ]
    let active = 0
    let peak = 0
    const fakeFetch: FetchMedia = async (u) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      if (u.includes('c.jpg')) throw new TypeError('Failed to fetch')
      return new Blob([`bytes of ${u.slice(-30)}`])
    }
    const progress: ZipProgress[] = []
    const { stream, summary } = exportZipStream({
      game: GAME, rows, signal: new AbortController().signal,
      onProgress: (p) => progress.push(p), fetchFile: fakeFetch,
    })
    const zip = await unzip(stream)

    expect(Object.keys(zip.files).sort()).toEqual([
      'errors.txt',
      'media/Blue Team/2026-09-20_14-05-33_Find a bodega cat_b.jpg',
      'media/Red Team/2026-09-20_14-05-33_Find a bodega cat_a.jpg',
      'submissions.csv',
    ])
    const csv = await zip.file('submissions.csv')!.async('string')
    expect(csv).toContain('"media/Red Team/2026-09-20_14-05-33_Find a bodega cat_a.jpg"')
    expect(csv).toContain('"DOWNLOAD FAILED (see errors.txt)"')
    expect(csv).toContain('"(no media)"')
    expect(csv).toContain('"rejected"')

    const errors = await zip.file('errors.txt')!.async('string')
    expect(errors).toContain('1 of 3 media files failed')
    expect(errors).toContain('_c.jpg')

    expect(summary()).toMatchObject({ total: 3, failures: [{ submissionId: 'c' }] })
    expect(progress.at(-1)).toMatchObject({ done: 3, total: 3, failed: 1 })
    expect(peak).toBeLessThanOrEqual(PARALLEL_DOWNLOADS)
  })

  it('downloads at most a few files at once', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`))
    let active = 0
    let peak = 0
    const fakeFetch: FetchMedia = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 3))
      active--
      return new Blob(['x'])
    }
    const { stream, summary } = exportZipStream({
      game: GAME, rows, signal: new AbortController().signal, onProgress: () => {}, fetchFile: fakeFetch,
    })
    const zip = await unzip(stream)
    expect(Object.keys(zip.files).length).toBe(13)   // 12 media + CSV, no errors.txt
    expect(peak).toBe(PARALLEL_DOWNLOADS)
    expect(summary().failures).toEqual([])
  })

  for (const when of ['before downloads start', 'mid-download']) {
    it(`stops when cancelled ${when}`, async () => {
      const controller = new AbortController()
      let started = 0
      const fakeFetch: FetchMedia = (_u, signal) => new Promise((_resolve, reject) => {
        started++
        signal.addEventListener('abort', () => reject(signal.reason))
      })
      const { stream } = exportZipStream({
        game: GAME, rows: [row('a'), row('b')], signal: controller.signal,
        onProgress: () => {}, fetchFile: fakeFetch,
      })
      const reading = new Response(stream).arrayBuffer()
      if (when === 'mid-download') {
        await new Promise((r) => setTimeout(r, 10))
        expect(started).toBe(2)
      }
      controller.abort()
      await expect(reading).rejects.toThrow()
    })
  }
})
