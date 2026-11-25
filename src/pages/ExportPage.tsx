// =============================================================================
// Foray — Game Reports (admin only; route /admin/export, file name kept)
//
// Download every submission from a game, to archive it (e.g. in Google
// Drive). Each game has two buttons:
//   - "Spreadsheet only"   → one CSV, one row per submission (any status).
//   - "Spreadsheet + media" → one zip: the CSV, every photo/video/audio file
//                             under media/<team>/, and errors.txt for any file
//                             that couldn't be downloaded.
// Plus "Stats by tag": how each challenge tag did in that game (tags come
// from the challenges as they are now, so tags added later still count), and
// "Challenge results": one row per challenge per team with its outcome and
// tags, for one game or all of them (lib/cardAnalytics.ts).
//
// READ-ONLY: nothing on this page writes to Firestore or Storage.
// Built for Chrome on a laptop, where the zip is written straight to disk as
// it downloads (see lib/exportFiles.ts). Media downloads need the bucket's
// CORS setting (storage-cors.json) to allow this site.
// =============================================================================

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { auth } from '../lib/firebase'
import { useUserRole } from '../hooks/useUserRole'
import { isPermissionDenied } from '../lib/gameMembership'
import { countGame, listExportGames, loadCardRows, loadExportRows, loadTagStats, mapLimit, newCardCache } from '../lib/gameExport'
import { buildCardsCsv, type CardRow } from '../lib/cardAnalytics'
import { completionRate, type TagStatRow } from '../lib/tagStats'
import {
  buildSubmissionsCsv, canStreamToDisk, exportFileName, exportZipStream, pickZipFile, saveBlob,
  type ExportGame, type ZipProgress,
} from '../lib/exportFiles'
import { EXPORT_TIME_ZONE, formatBytes, nyDate, safeFileName } from '../lib/exportFormat'

type Counts = { teams: number; submissions: number } | 'error'
type TagStatsState = TagStatRow[] | 'loading' | { error: string }
type Tone = 'ok' | 'warn' | 'error'

interface Job {
  gameId: string
  kind: 'csv' | 'zip' | 'cards'
  message: string
}

const STATUS_LABEL: Record<string, string> = {
  lobby: 'Lobby', strategy: 'Strategy', active: 'Live', paused: 'Paused', ended: 'Finished',
}

const TONE_COLOR: Record<Tone, string> = {
  ok: 'var(--green-deep)', warn: 'var(--marigold-deep)', error: 'var(--red-deep)',
}

const ALL_GMS = '*'
const ALL_GAMES = '*all'   // job/result key for the all-games cards download

const gamesLabel = (n: number) => `${n} game${n === 1 ? '' : 's'}`

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
  const [gmFilter, setGmFilter] = useState(ALL_GMS)
  const [tagStats, setTagStats] = useState<Record<string, TagStatsState>>({})
  const [statsOpen, setStatsOpen] = useState<string | null>(null)
  const [includePractice, setIncludePractice] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // One option per GM, A to Z. Keyed by uid, since two GMs could share a name.
  const gmOptions = useMemo(() => {
    const byId = new Map<string, { name: string; count: number }>()
    games?.forEach((g) => {
      const prev = byId.get(g.gmId)
      byId.set(g.gmId, { name: g.gmName, count: (prev?.count ?? 0) + 1 })
    })
    return [...byId].map(([id, o]) => ({ id, ...o })).sort((a, b) => a.name.localeCompare(b.name))
  }, [games])

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

  const cardsFileName = (label: string) => `foray-challenge-results_${safeFileName(label, 60, 'game').replace(/ /g, '-')}_${nyDate(new Date())}.csv`
  const cardsSummary = (rows: CardRow[]) => {
    const done = rows.filter((r) => r.outcome === 'Completed').length
    return `${rows.length} row${rows.length === 1 ? '' : 's'}, ${done} completed`
  }

  const exportCards = async (game: ExportGame) => {
    const fileName = cardsFileName(game.name)
    setJob({ gameId: game.id, kind: 'cards', message: 'Reading challenges…' })
    try {
      const rows = await loadCardRows(game)
      saveBlob(new Blob([buildCardsCsv(rows)], { type: 'text/csv;charset=utf-8' }), fileName)
      setResult(game.id, 'ok', `Done. Downloaded ${fileName} (${cardsSummary(rows)}).`)
    } catch (err) {
      console.error('Cards export failed:', err)
      setResult(game.id, 'error', `Export failed. ${errorText(err)}`)
    } finally {
      setJob(null)
    }
  }

  // Every started game in the current GM filter (practice games only when ticked), oldest first.
  const allGamesForCards = (games ?? [])
    .filter((g) => gmFilter === ALL_GMS || g.gmId === gmFilter)
    .filter((g) => g.startedAt && (includePractice || !g.practice))
    .slice()
    .reverse()

  const exportAllCards = async () => {
    const list = allGamesForCards
    if (!list.length) return
    const fileName = cardsFileName('all-games')
    const cache = newCardCache()
    const rows: CardRow[] = []
    const failed: string[] = []
    try {
      for (let i = 0; i < list.length; i++) {
        setJob({ gameId: ALL_GAMES, kind: 'cards', message: `Reading game ${i + 1} of ${list.length}…` })
        try {
          rows.push(...await loadCardRows(list[i], cache))
        } catch (err) {
          console.warn('Cards export: skipped', list[i].id, err)
          failed.push(list[i].name)
        }
      }
      saveBlob(new Blob([buildCardsCsv(rows)], { type: 'text/csv;charset=utf-8' }), fileName)
      const games = `${list.length - failed.length} game${list.length - failed.length === 1 ? '' : 's'}`
      if (failed.length) setResult(ALL_GAMES, 'warn', `Downloaded ${fileName} (${games}, ${cardsSummary(rows)}), but couldn't read: ${failed.join(', ')}.`)
      else setResult(ALL_GAMES, 'ok', `Done. Downloaded ${fileName} (${games}, ${cardsSummary(rows)}).`)
    } catch (err) {
      setResult(ALL_GAMES, 'error', `Export failed. ${errorText(err)}`)
    } finally {
      setJob(null)
    }
  }

  const toggleTagStats = (game: ExportGame) => {
    if (statsOpen === game.id) { setStatsOpen(null); return }
    setStatsOpen(game.id)
    const have = tagStats[game.id]
    if (have && have !== 'loading' && !('error' in have)) return
    setTagStats((prev) => ({ ...prev, [game.id]: 'loading' }))
    loadTagStats(game.id)
      .then((rows) => setTagStats((prev) => ({ ...prev, [game.id]: rows })))
      .catch((err) => setTagStats((prev) => ({ ...prev, [game.id]: { error: errorText(err) } })))
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
          Game Reports
        </h1>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem', margin: '0 0 6px', lineHeight: 1.5 }}>
          See how each game went and download its data. "Stats by tag" shows how each kind of challenge did.
          "Challenge results" is a spreadsheet of every challenge each team had and what they did with it.
          "Spreadsheet only" lists every submission; "Spreadsheet + media" adds every photo, video and
          audio file, sorted into a folder per team.
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
            {gmOptions.length > 1 && (
              <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-muted)', marginBottom: 4 }}>
                Filter by GM
                <select
                  value={gmFilter}
                  disabled={!!job}
                  onChange={(e) => setGmFilter(e.target.value)}
                  style={{
                    background: 'var(--surface)', border: '1px solid var(--line-strong)', color: 'var(--ink)',
                    padding: '8px 10px', borderRadius: 8, fontSize: '0.85rem', fontFamily: 'inherit', maxWidth: '100%',
                    cursor: job ? 'not-allowed' : 'pointer',
                  }}
                >
                  <option value={ALL_GMS}>All GMs ({gamesLabel(games.length)})</option>
                  {gmOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name} ({gamesLabel(o.count)})</option>
                  ))}
                </select>
              </label>
            )}
            <div style={{
              background: 'rgba(var(--blue-rgb), 0.07)', border: '1px solid rgba(var(--blue-rgb), 0.3)', borderRadius: 12,
              padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 4,
            }}>
              <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>Challenge results: all games</div>
                <div style={{ color: 'var(--ink-muted)', fontSize: '0.8rem', marginTop: 4, lineHeight: 1.5 }}>
                  A spreadsheet of every challenge each team had and what they did with it: completed, skipped,
                  discarded or rejected, with its tags. Handy for seeing which kinds of challenges teams go for
                  or avoid. {gamesLabel(allGamesForCards.length)}
                  {gmFilter === ALL_GMS ? '' : ' for this GM'}{includePractice ? ', practice games included' : ', not counting practice games'}.
                </div>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', color: 'var(--ink-muted)', marginTop: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={includePractice} disabled={!!job} onChange={(e) => setIncludePractice(e.target.checked)} />
                  Include practice games
                </label>
              </div>
              <button
                disabled={!!job || allGamesForCards.length === 0}
                onClick={exportAllCards}
                style={buttonStyle(true, !job && allGamesForCards.length > 0)}
              >
                Download all games
              </button>
              {(job?.gameId === ALL_GAMES || results[ALL_GAMES]) && (
                <div style={{ flexBasis: '100%', fontSize: '0.82rem', lineHeight: 1.5, fontWeight: 600, color: job?.gameId === ALL_GAMES ? 'var(--ink-soft)' : TONE_COLOR[results[ALL_GAMES].tone] }}>
                  {job?.gameId === ALL_GAMES ? job.message : results[ALL_GAMES].text}
                </div>
              )}
            </div>

            {games.filter((g) => gmFilter === ALL_GMS || g.gmId === gmFilter).map((g) => {
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
                      GM: <strong style={{ color: 'var(--ink-soft)', fontWeight: 600 }}>{g.gmName}</strong>
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
                    <button
                      disabled={!!job || !g.startedAt}
                      onClick={() => exportCards(g)}
                      title="Every challenge each team had in this game and what they did with it"
                      style={buttonStyle(false, !job && !!g.startedAt)}
                    >
                      Challenge results
                    </button>
                    <button onClick={() => toggleTagStats(g)} style={buttonStyle(false, true)}>
                      {statsOpen === g.id ? 'Hide stats' : 'Stats by tag'}
                    </button>
                  </div>
                  {statsOpen === g.id && <TagStatsTable state={tagStats[g.id]} />}

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

const TH: CSSProperties = { textAlign: 'right', padding: '6px 8px', fontWeight: 700, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }
const TD: CSSProperties = { textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }

/** One row per challenge tag: cards held, attempts, completions, rejections, discards, points. */
function TagStatsTable({ state }: { state: TagStatsState | undefined }) {
  const box: CSSProperties = { flexBasis: '100%', fontSize: '0.82rem', lineHeight: 1.5 }
  if (!state || state === 'loading') return <div style={{ ...box, color: 'var(--ink-faint)' }}>Counting…</div>
  if ('error' in state) return <div style={{ ...box, color: 'var(--red-deep)' }}>Couldn't load stats. {state.error}</div>
  if (state.length === 0) return <div style={{ ...box, color: 'var(--ink-faint)' }}>No cards were dealt in this game.</div>
  return (
    <div style={box}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 560 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line-strong)' }}>
              <th style={{ ...TH, textAlign: 'left' }}>Tag</th>
              <th style={TH}>Cards held</th>
              <th style={TH}>Attempted</th>
              <th style={TH}>Completed</th>
              <th style={TH}>Completion</th>
              <th style={TH}>Rejected</th>
              <th style={TH}>Discarded</th>
              <th style={TH}>Points</th>
            </tr>
          </thead>
          <tbody>
            {state.map((r) => (
              <tr key={r.key || 'none'} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 600, color: r.key ? 'var(--ink)' : 'var(--ink-muted)' }}>{r.label}</td>
                <td style={TD}>{r.held}</td>
                <td style={TD}>{r.attempted}</td>
                <td style={TD}>{r.completed}</td>
                <td style={TD}>{completionRate(r)}</td>
                <td style={TD}>{r.rejected}</td>
                <td style={TD}>{r.discarded}</td>
                <td style={TD}>{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: 'var(--ink-faint)', fontSize: '0.76rem', margin: '8px 0 0' }}>
        Counted per team: a card two teams held counts twice. A card with several tags counts in each of them,
        so the rows don't add up to the game total. Completion is completed cards out of cards held.
      </p>
    </div>
  )
}
