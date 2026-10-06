// =============================================================================
// Foray — formatting helpers for the admin Export page
//
// Pure functions (no Firebase) so they can be unit-tested: CSV cells, New York
// timestamps, and file/folder names that are safe on Mac, Windows and Google
// Drive. The page and the Firestore loading live in lib/gameExport.ts and
// pages/ExportPage.tsx.
// =============================================================================

// Export timestamps are shown in New York time (where Foray games run).
export const EXPORT_TIME_ZONE = 'America/New_York'

/**
 * Anything timestamp-like → Date. Accepts a Firestore Timestamp (has
 * toDate()), a plain { seconds, nanoseconds } object, or a Date. Returns null
 * for anything else, including plain numbers, which stay raw in the CSV.
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  if (value && typeof value === 'object') {
    const v = value as { toDate?: () => Date; seconds?: unknown; nanoseconds?: unknown }
    if (typeof v.toDate === 'function') return v.toDate()
    if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number') {
      return new Date(v.seconds * 1000 + Math.floor(v.nanoseconds / 1e6))
    }
  }
  return null
}

// Year, month, day, hour (24h), minute, second as New York sees them.
function nyParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: EXPORT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: Number(get('hour')), minute: get('minute'), second: get('second'),
  }
}

/** "2026-09-20" in New York time. */
export function nyDate(d: Date): string {
  const p = nyParts(d)
  return `${p.year}-${p.month}-${p.day}`
}

/** "2026-09-20 2:05:33 PM" in New York time. Google Sheets reads it as a date. */
export function nyReadable(d: Date): string {
  const p = nyParts(d)
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12
  return `${p.year}-${p.month}-${p.day} ${h12}:${p.minute}:${p.second} ${p.hour < 12 ? 'AM' : 'PM'}`
}

/** "2026-09-20_14-05-33" in New York time, for file names (sorts by time). */
export function nyFileStamp(d: Date): string {
  const p = nyParts(d)
  return `${p.year}-${p.month}-${p.day}_${String(p.hour).padStart(2, '0')}-${p.minute}-${p.second}`
}

/**
 * Make a string safe as one file or folder name on Mac, Windows and Google
 * Drive: drops control characters and : * ? " < > |, turns slashes into
 * dashes, collapses spaces,
 * and caps the length (counting emoji as one character, so one is never cut
 * in half). Returns `fallback` if nothing usable is left.
 */
export function safeFileName(raw: string, maxLength = 60, fallback = 'untitled'): string {
  const cleaned = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')   // tabs/newlines become spaces
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')          // a leading dot hides the file on a Mac
  const capped = Array.from(cleaned).slice(0, maxLength).join('')
  return capped.replace(/[. ]+$/, '') || fallback   // Windows rejects a trailing dot/space
}

const DEFAULT_EXTENSION: Record<string, string> = { photo: 'jpg', video: 'mp4', audio: 'm4a' }

/**
 * File extension for a submission's media. Taken from the stored file's name
 * inside the download URL (".../o/submissions%2Fgame%2Fteam%2Fcard_123.mov?..."),
 * so a .mov stays a .mov. Falls back to the usual type for the media type.
 */
export function mediaExtension(url: string, mediaType: string): string {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? ''
    const fileName = decodeURIComponent(last).split('/').pop() ?? ''
    const dot = fileName.lastIndexOf('.')
    const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext
  } catch {
    /* not a URL — use the fallback */
  }
  return DEFAULT_EXTENSION[mediaType] ?? 'bin'
}

/**
 * A raw Firestore value as CSV text: timestamps become ISO 8601 (UTC), lists
 * and maps become JSON, empty values become blank.
 */
export function rawCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const date = toDate(value)
  if (date) return date.toISOString()
  try {
    return JSON.stringify(value, (_key, v) => toDate(v)?.toISOString() ?? v)
  } catch {
    return String(value)
  }
}

/**
 * One quoted CSV field. Text a spreadsheet would run as a formula (starting
 * with = + @ or -, unless it's just a number) gets a leading apostrophe, so a
 * player's display name can't run a formula when the sheet is opened.
 */
export function csvField(value: unknown): string {
  let text = rawCellText(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`
  }
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * A whole CSV file. Starts with a UTF-8 byte-order mark so Excel shows
 * accents and emoji correctly; uses Windows line endings, which every
 * spreadsheet app accepts.
 */
export function buildCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** "1.2 GB", "340 MB", "12 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
