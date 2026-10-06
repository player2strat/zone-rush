// =============================================================================
// Foray — building the admin Export page's files
//
// Turns a game's submissions (already loaded by lib/gameExport.ts) into:
//   - submissions.csv — one row per submission, friendly columns first, then
//     every raw field on the submission doc so nothing is lost;
//   - a zip: the CSV, every media file under media/<team>/, and errors.txt
//     listing any file that couldn't be downloaded.
//
// The zip is STREAMED with client-zip: each file is added and written out as
// soon as it has downloaded, so a game full of videos never has to fit in the
// laptop's memory at once (JSZip would build the whole zip in memory first).
// Downloads run a few at a time.
//
// No Firebase imports here, so it can be tested with fake downloads.
// =============================================================================

import { makeZip } from 'client-zip'
import {
  buildCsv, mediaExtension, nyDate, nyFileStamp, nyReadable, rawCellText, safeFileName,
} from './exportFormat'

// How many media files download at the same time.
export const PARALLEL_DOWNLOADS = 4

export interface ExportGame {
  id: string
  name: string
  status: string
  startedAt: Date | null
  createdAt: Date | null
  practice: boolean
}

/** One submission with the names needed to make it readable. */
export interface ExportRow {
  id: string
  raw: Record<string, unknown>      // the submission doc exactly as stored
  teamName: string
  challengeTitle: string
  challengeDescription: string
  difficulty: string
  zoneName: string
  submittedByName: string
  submittedAt: Date | null
  mediaUrl: string                  // '' when the submission has no media
  mediaType: string
}

// ─── File names ──────────────────────────────────────────────────────────────

/** foray-export_<game name>_<today's date>.<ext> */
export function exportFileName(game: ExportGame, ext: 'csv' | 'zip'): string {
  const name = safeFileName(game.name, 60, game.id).replace(/ /g, '-')
  return `foray-export_${name}_${nyDate(new Date())}.${ext}`
}

/** media/<team name>/<submitted time>_<challenge title>_<submission id>.<ext> */
export function mediaPathFor(row: ExportRow): string | null {
  if (!row.mediaUrl) return null
  const team = safeFileName(row.teamName, 60, safeFileName(String(row.raw.team_id ?? ''), 60, 'no-team'))
  const stamp = row.submittedAt ? nyFileStamp(row.submittedAt) : 'unknown-time'
  const title = safeFileName(row.challengeTitle, 50, 'challenge')
  return `media/${team}/${stamp}_${title}_${safeFileName(row.id)}.${mediaExtension(row.mediaUrl, row.mediaType)}`
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

const FRIENDLY_HEADER = [
  'Game', 'Team', 'Challenge', 'Challenge description', 'Difficulty', 'Zone',
  'Submitted by', 'Status', 'GM notes', 'Submitted at (New York time)',
]

// Raw fields already shown unchanged in a friendly column above.
const SHOWN_AS_IS = new Set(['status', 'gm_notes'])

// Raw columns come in this order when present; any other field follows, A–Z.
const RAW_ORDER = [
  'game_id', 'team_id', 'challenge_id', 'zone_id', 'submitted_by', 'submitted_at',
  'media_type', 'media_url', 'in_zone', 'gps_lat', 'gps_lng', 'gps_accuracy', 'gps_captured_at',
  'attempted_tier2', 'tier2_approved', 'points_awarded', 'reviewed_by', 'reviewed_at',
  'highlight', 'challenge_description', 'challenge_difficulty', 'resolved_task', 'step_choices',
]

/**
 * submissions.csv. `mediaColumn` (zip only) maps submission id → what to put
 * in the "Media file in zip" column; leave it out for the spreadsheet-only
 * download, which has no zip to point at.
 */
export function buildSubmissionsCsv(
  game: ExportGame,
  rows: ExportRow[],
  mediaColumn?: Map<string, string>,
): string {
  const keys = new Set(rows.flatMap((r) => Object.keys(r.raw)))
  SHOWN_AS_IS.forEach((k) => keys.delete(k))
  const rawKeys = [
    ...RAW_ORDER.filter((k) => keys.has(k)),
    ...[...keys].filter((k) => !RAW_ORDER.includes(k)).sort(),
  ]

  const header = [
    ...FRIENDLY_HEADER,
    ...(mediaColumn ? ['Media file in zip'] : []),
    'submission_id',
    ...rawKeys,
  ]
  const body = rows.map((r) => [
    game.name,
    r.teamName,
    r.challengeTitle,
    r.challengeDescription,
    r.difficulty,
    r.zoneName,
    r.submittedByName,
    rawCellText(r.raw.status),
    rawCellText(r.raw.gm_notes),
    r.submittedAt ? nyReadable(r.submittedAt) : '',
    ...(mediaColumn ? [mediaColumn.get(r.id) ?? ''] : []),
    r.id,
    ...rawKeys.map((k) => r.raw[k]),
  ])
  return buildCsv(header, body)
}

// ─── Media downloads ─────────────────────────────────────────────────────────

class HttpError extends Error {
  status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

export type FetchMedia = (url: string, signal: AbortSignal) => Promise<Blob>

/** Download one file from its Storage download URL, retrying once on a dropped connection. */
export const fetchMedia: FetchMedia = async (url, signal) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal })
      if (!res.ok) throw new HttpError(res.status)
      return await res.blob()
    } catch (err) {
      const retryable = !signal.aborted
        && (err instanceof TypeError || (err instanceof HttpError && err.status >= 500))
      if (attempt >= 2 || !retryable) throw err
    }
  }
}

function failureReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 404) return 'File not found in Storage (404). It may have been deleted.'
    if (err.status === 403) return 'Storage refused the download (403). The link may have been revoked.'
    return `Storage returned an error (HTTP ${err.status}).`
  }
  if (err instanceof TypeError) {
    return 'The browser blocked or lost the download (network problem, or the Storage CORS setting is missing).'
  }
  return (err as Error)?.message || String(err)
}

export interface ZipProgress {
  done: number        // files finished (downloaded or failed)
  total: number       // submissions with a media file
  failed: number
  bytes: number       // downloaded so far
}

export interface ZipFailure {
  path: string
  submissionId: string
  url: string
  reason: string
}

export interface ZipSummary {
  total: number
  failures: ZipFailure[]
}

function errorsText(game: ExportGame, total: number, failures: ZipFailure[]): string {
  const lines = [
    'Foray export: media files that could not be downloaded',
    `Game: ${game.name}`,
    `Exported: ${nyReadable(new Date())} (New York time)`,
    '',
    `${failures.length} of ${total} media files failed. Every other file is in this zip,`,
    'and every submission (including these) is listed in submissions.csv.',
    '',
  ]
  failures.forEach((f, i) => {
    lines.push(
      `${i + 1}. ${f.path}`,
      `   Submission: ${f.submissionId}`,
      `   Link: ${f.url}`,
      `   Problem: ${f.reason}`,
      '',
    )
  })
  return lines.join('\r\n')
}

/**
 * The export zip as a stream of bytes. Pipe it into a file (Chrome's save
 * dialog) or collect it into a Blob. Media files download PARALLEL_DOWNLOADS
 * at a time and go into the zip as they finish; submissions.csv is written
 * last so its "Media file in zip" column can mark any failed download.
 * `summary()` is complete once the stream has finished.
 */
export function exportZipStream(opts: {
  game: ExportGame
  rows: ExportRow[]
  signal: AbortSignal
  onProgress: (p: ZipProgress) => void
  fetchFile?: FetchMedia
}): { stream: ReadableStream<Uint8Array>; summary: () => ZipSummary } {
  const { game, rows, signal, onProgress, fetchFile = fetchMedia } = opts
  const jobs = rows.flatMap((row) => {
    const path = mediaPathFor(row)
    return path ? [{ row, path }] : []
  })
  const failures: ZipFailure[] = []

  async function* entries() {
    const mediaColumn = new Map<string, string>()
    rows.forEach((r) => { if (!r.mediaUrl) mediaColumn.set(r.id, '(no media)') })

    type Settled = { i: number; blob?: Blob; error?: unknown }
    const inFlight = new Map<number, Promise<Settled>>()
    let next = 0
    let done = 0
    let bytes = 0
    const report = () => onProgress({ done, total: jobs.length, failed: failures.length, bytes })
    report()

    while (next < jobs.length || inFlight.size > 0) {
      signal.throwIfAborted()
      while (inFlight.size < PARALLEL_DOWNLOADS && next < jobs.length) {
        const i = next++
        inFlight.set(i, fetchFile(jobs[i].row.mediaUrl, signal).then(
          (blob) => ({ i, blob }),
          (error) => ({ i, error }),
        ))
      }
      const settled = await Promise.race(inFlight.values())
      inFlight.delete(settled.i)
      signal.throwIfAborted()

      const { row, path } = jobs[settled.i]
      done++
      if (settled.blob) {
        bytes += settled.blob.size
        mediaColumn.set(row.id, path)
        report()
        yield { name: path, input: settled.blob, lastModified: row.submittedAt ?? new Date() }
      } else {
        failures.push({ path, submissionId: row.id, url: row.mediaUrl, reason: failureReason(settled.error) })
        mediaColumn.set(row.id, 'DOWNLOAD FAILED (see errors.txt)')
        report()
      }
    }

    yield { name: 'submissions.csv', input: buildSubmissionsCsv(game, rows, mediaColumn), lastModified: new Date() }
    if (failures.length > 0) {
      yield { name: 'errors.txt', input: errorsText(game, jobs.length, failures), lastModified: new Date() }
    }
  }

  return {
    stream: makeZip(entries()),
    summary: () => ({ total: jobs.length, failures: [...failures] }),
  }
}

// ─── Saving ──────────────────────────────────────────────────────────────────

type SaveFilePicker = (options: {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>

function savePicker(): SaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
}

/**
 * True in Chrome/Edge on a computer: the zip can be written straight into a
 * file as it's built. Other browsers (Safari, Firefox, phones) build the
 * whole zip in memory first, which can fail for very large video exports.
 */
export function canStreamToDisk(): boolean {
  return typeof savePicker() === 'function'
}

/**
 * Chrome's "Save as" dialog. Must be called straight from a click, before any
 * other waiting. Returns null if the user cancels.
 */
export async function pickZipFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  try {
    return await savePicker()!.call(window, {
      suggestedName,
      types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return null
    throw err
  }
}

/** Hand a finished file to the browser's normal download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser time to start reading a large file before letting go of it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
