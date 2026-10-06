// =============================================================================
// Foray — Export (admin/GM)
//
// Download every submission from a game, to archive it (e.g. in Google
// Drive). Each game has two buttons:
//   - "Spreadsheet only"   → one CSV, one row per submission (any status).
//   - "Spreadsheet + media" → one zip: the CSV, every photo/video/audio file
//                             under media/<team>/, and errors.txt for any file
//                             that couldn't be downloaded.
//
// READ-ONLY: nothing on this page writes to Firestore or Storage.
// Built for Chrome on a laptop, where the zip is written straight to disk as
// it downloads (see lib/exportFiles.ts). Media downloads need the bucket's
// CORS setting (storage-cors.json) to allow this site.
// =============================================================================

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../lib/firebase'
import { useUserRole } from '../hooks/useUserRole'
import { isPermissionDenied } from '../lib/gameMembership'
import { countGame, listExportGames, loadExportRows, mapLimit } from '../lib/gameExport'
import {
  buildSubmissionsCsv, canStreamToDisk, exportFileName, exportZipStream, pickZipFile, saveBlob,
  type ExportGame, type ZipProgress,
} from '../lib/exportFiles'
import { EXPORT_TIME_ZONE, formatBytes } from '../lib/exportFormat'

type Counts = { teams: number; submissions: number } | 'error'
type Tone = 'ok' | 'warn' | 'error'

interface Job {
  gameId: string
  kind: 'csv' | 'zip'
  message: string
}

const STATUS_LABEL: Record<string, string> = {
  lobby: 'Lobby', strategy: 'Strategy', active: 'Live', paused: 'Paused', ended: 'Finished',
}

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--green-deep)', warn: 'var(--marigold-deep)', error: 'var(--red-deep)',
}

function startLabel(game: ExportGame): string {
  if (!game.startedAt) return 'Not started'
  return 'Started ' + game.startedAt.toLocaleDateString('en-US', {
    timeZone: EXPORT_TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric',
  })
}

function progressText(p: ZipProgress): string {
  if (p.total === 0) return 'No media files. Writing the spreadsheet…'
  if (p.done >= p.total) return 'Finishing the zip…'
  return `Downloading ${p.done} of ${p.total} files… (${formatBytes(p.bytes)} so far)`
}

function errorText(err: unknown): string {
  if (isPermissionDenied(err)) return 'Firestore refused the read. This account may not have access to this game.'
  return (err as Error)?.message || String(err)
}

export default function ExportPage() {
  const navigate = useNavigate()
  const uid = auth.currentUser?.uid ?? ''
  const { role, loading: roleLoading } = useUserRole()
  const isAdmin = role === 'admin'
  const streamToDisk = canStreamToDisk()

  const [games, setGames] = useState<ExportGame[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, Counts>>({})
  const [job, setJob] = useState<Job | null>(null)
  const [results, setResults] = useState<Record<string, { tone: Tone; text: string }>>({})
  const abortRef = useRef<AbortController | null>(null)

  const setResult = (gameId: string, tone: Tone, text: string) =>
    setResults((prev) => ({ ...prev, [gameId]: { tone, text } }))

  // Games this account can export (admins: all; GMs: their own).
  useEffect(() => {
    if (roleLoading || !uid) return
    let cancelled = false
    listExportGames(uid, isAdmin)
      .then((list) => { if (!cancelled) setGames(list) })
      .catch((err) => { if (!cancelled) setLoadError(errorText(err)) })
    return () => { cancelled = true }
  }, [roleLoading, uid, isAdmin])

  // Team and submission counts, a few games at a time, filling in as they arrive.
  useEffect(() => {
    if (!games) return
    let cancelled = false
    mapLimit(games, 6, async (g) => {
      const c: Counts = await countGame(g.id).catch((err) => {
        console.warn('Export: counts failed for', g.id, err)
        return 'error' as const
      })
      if (!cancelled) setCounts((prev) => ({ ...prev, [g.id]: c }))
    })
    return () => { cancelled = true }
  }, [games])

  // Leaving the page mid-export would cut the download off — ask first.
  useEffect(() => {
    if (!job) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [job])

  const exportCsv = async (game: ExportGame) => {
    const fileName = exportFileName(game, 'csv')
    setJob({ gameId: game.id, kind: 'csv', message: 'Reading submissions…' })
    try {
      const rows = await loadExportRows(game)
      const csv = buildSubmissionsCsv(game, rows)
      saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), fileName)
      setResult(game.id, 'ok', `Done. Downloaded ${fileName} (${rows.length} submission${rows.length === 1 ? '' : 's'}).`)
    } catch (err) {
      console.error('CSV export failed:', err)
      setResult(game.id, 'error', `Export failed. ${errorText(err)}`)
    } finally {
      setJob(null)
    }
  }

  const exportZip = async (game: ExportGame) => {
    const suggested = exportFileName(game, 'zip')

    // Chrome: ask where to save FIRST (it must happen right on the click),
    // then write the zip straight into that file as it downloads.
    let handle: FileSystemFileHandle | null = null
    if (streamToDisk) {
      try {
        handle = await pickZipFile(suggested)
        if (!handle) return   // closed the dialog
      } catch (err) {
        // Dialog refused (rare): fall back to building the zip in memory.
        console.warn('Save dialog unavailable, using a normal download instead:', err)
      }
    }
    const fileName = handle?.name ?? suggested

    const controller = new AbortController()
    abortRef.current = controller
    setJob({ gameId: game.id, kind: 'zip', message: 'Reading submissions…' })
    try {
      const rows = await loadExportRows(game)
      controller.signal.throwIfAborted()
      const { stream, summary } = exportZipStream({
        game,
        rows,
        signal: controller.signal,
        onProgress: (p) => setJob({ gameId: game.id, kind: 'zip', message: progressText(p) }),
      })
      if (handle) {
        await stream.pipeTo(await handle.createWritable(), { signal: controller.signal })
      } else {
        saveBlob(await new Response(stream).blob(), fileName)
      }

      const { total, failures } = summary()
      if (total === 0) {
        setResult(game.id, 'ok', `Done. Saved ${fileName}: the spreadsheet only, since none of the ${rows.length} submissions has a media file.`)
      } else if (failures.length === 0) {
        setResult(game.id, 'ok', `Done. Saved ${fileName}: the spreadsheet and all ${total} media files.`)
      } else if (failures.length < total) {
        setResult(game.id, 'warn', `Done, with problems. Saved ${fileName}, but ${failures.length} of ${total} media files couldn't be downloaded. They're listed in errors.txt inside the zip; everything else is there.`)
      } else {
        setResult(game.id, 'error', `Media download failed. Saved ${fileName} with the spreadsheet only: none of the ${total} media files could be downloaded. This usually means the one-time Storage CORS setting hasn't been applied yet. errors.txt in the zip has details.`)
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setResult(game.id, 'warn', 'Cancelled. If Chrome left an empty or partial .zip where you chose to save it, delete it.')
      } else {
        console.error('Zip export failed:', err)
        setResult(game.id, 'error', `Export failed. ${errorText(err)}${handle ? ' If Chrome left an empty .zip where you chose to save it, delete it.' : ''}`)
      }
    } finally {
      abortRef.current = null
      controller.abort()   // stop any download still running after an error
      setJob(null)
    }
  }

  const buttonStyle = (primary: boolean, enabled: boolean): CSSProperties => ({
    background: !enabled ? 'rgba(var(--ink-rgb), 0.03)' : primary ? 'rgba(var(--pink-rgb), 0.15)' : 'var(--surface)',
    border: `1px solid ${!enabled ? 'var(--line)' : primary ? 'rgba(var(--pink-rgb), 0.45)' : 'var(--line-strong)'}`,
    color: !enabled ? 'var(--ink-ghost)' : primary ? 'var(--pink-deep)' : 'var(--ink-soft)',
    padding: '9px 14px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700,
    cursor: enabled ? 'pointer' : 'not-allowed', fontFamily: 'inherit', whiteSpace: 'nowrap',
  })

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", padding: '24px 16px',
    }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 4px' }}>
          ⬇ Export Submissions
        </h1>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem', margin: '0 0 6px', lineHeight: 1.5 }}>
          Download every submission from a game (approved, pending and rejected) to archive it.
          "Spreadsheet only" is a CSV; "Spreadsheet + media" is a zip with the CSV and every
          photo, video and audio file, sorted into a folder per team.
        </p>
        <p style={{ color: 'var(--ink-faint)', fontSize: '0.8rem', margin: '0 0 20px', lineHeight: 1.5 }}>
          {streamToDisk
            ? 'Chrome will ask where to save the zip, then fill it in as files download. Keep this tab open until it says Done.'
            : 'This browser builds the whole zip in memory before saving, so a game with lots of video may fail. Use Chrome on a laptop for big exports.'}
        </p>

        {loadError ? (
          <p style={{ color: 'var(--red-deep)', fontSize: '0.85rem' }}>Couldn't load games: {loadError}</p>
        ) : !games ? (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>Loading games…</p>
        ) : games.length === 0 ? (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>
            {isAdmin ? 'No games yet.' : 'No games yet. GMs can export the games they created.'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {games.map((g) => {
              const c = counts[g.id]
              const hasSubs = !c || c === 'error' || c.submissions > 0
              const enabled = !job && hasSubs
              const running = job?.gameId === g.id ? job : null
              const result = results[g.id]
              return (
                <div key={g.id} style={{
                  background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
                  padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
                }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: '0.98rem', overflowWrap: 'anywhere' }}>{g.name}</span>
                      <span style={{
                        fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                        background: g.status === 'ended' ? 'rgba(var(--green-rgb), 0.14)' : 'rgba(var(--ink-rgb), 0.06)',
                        color: g.status === 'ended' ? 'var(--green-deep)' : 'var(--ink-muted)',
                      }}>
                        {STATUS_LABEL[g.status] ?? g.status}
                      </span>
                      {g.practice && (
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: 'rgba(var(--marigold-rgb), 0.25)', color: 'var(--marigold-deep)' }}>
                          Practice
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--ink-muted)', fontSize: '0.8rem', marginTop: 4 }}>
                      {startLabel(g)}
                      {' · '}
                      {c === undefined
                        ? 'counting…'
                        : c === 'error'
                          ? "couldn't count"
                          : `${c.teams} team${c.teams === 1 ? '' : 's'} · ${c.submissions} submission${c.submissions === 1 ? '' : 's'}`}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <button disabled={!enabled} onClick={() => exportCsv(g)} style={buttonStyle(false, enabled)}>
                      Spreadsheet only
                    </button>
                    <button disabled={!enabled} onClick={() => exportZip(g)} style={buttonStyle(true, enabled)}>
                      Spreadsheet + media
                    </button>
                  </div>

                  {(running || result) && (
                    <div style={{ flexBasis: '100%', fontSize: '0.82rem', lineHeight: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                      {running ? (
                        <>
                          <span style={{ color: 'var(--ink-soft)', fontWeight: 600 }}>{running.message}</span>
                          {running.kind === 'zip' && (
                            <button
                              onClick={() => abortRef.current?.abort()}
                              style={{ background: 'none', border: '1px solid var(--line-strong)', color: 'var(--ink-muted)', borderRadius: 6, padding: '3px 10px', fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'inherit' }}
                            >
                              Cancel
                            </button>
                          )}
                        </>
                      ) : result && (
                        <span style={{ color: TONE_COLOR[result.tone], fontWeight: 600 }}>
                          {result.text}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
