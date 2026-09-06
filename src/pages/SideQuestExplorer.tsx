// =============================================================================
// Foray — Side Quest Explorer (admin)
//
// All-time view of side quest submissions ACROSS games, aggregated by
// quest_id. Recurring presets (e.g. Pothole Reporting) share a fixed id in
// every game, so one filter shows every pothole ever submitted — with photo,
// game, team, submitter, GPS, and a CSV export for external partners.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { SIDE_QUEST_PRESETS } from '../lib/sideQuestPresets'

interface ExplorerSub {
  id: string
  game_id: string
  quest_id: string
  quest_title?: string
  team_id: string
  submitter_name: string
  media_url: string
  gps_lat: number | null
  gps_lng: number | null
  status: string
  submitted_at?: { seconds?: number }
}

type StatusFilter = 'approved' | 'pending' | 'rejected' | 'all'

export default function SideQuestExplorer() {
  const navigate = useNavigate()
  const [questId, setQuestId] = useState(SIDE_QUEST_PRESETS[0]?.id ?? '')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('approved')
  const [subs, setSubs] = useState<ExplorerSub[]>([])
  // Which quest the loaded rows belong to — mismatch with questId means loading.
  const [loadedQuestId, setLoadedQuestId] = useState<string | null>(null)
  const [gameNames, setGameNames] = useState<Map<string, string>>(new Map())
  const [knownQuests, setKnownQuests] = useState<{ id: string; title: string }[]>([])
  const [deadMedia, setDeadMedia] = useState<Set<string>>(new Set())

  // Discover every quest id that has ever received a submission, so one-off
  // custom quests are browsable too (presets are always listed).
  useEffect(() => {
    getDocs(collection(db, 'side_quest_submissions')).then((snap) => {
      const found = new Map<string, string>()
      SIDE_QUEST_PRESETS.forEach((p) => found.set(p.id, p.title))
      snap.forEach((d) => {
        const data = d.data()
        if (!found.has(data.quest_id)) {
          found.set(data.quest_id, data.quest_title || data.quest_id)
        }
      })
      setKnownQuests(Array.from(found.entries()).map(([id, title]) => ({ id, title })))
    }).catch((err) => console.warn('Quest discovery failed:', err))
  }, [])

  // Load all submissions for the chosen quest, across every game.
  useEffect(() => {
    if (!questId) return
    let cancelled = false
    async function load() {
      const snap = await getDocs(query(
        collection(db, 'side_quest_submissions'),
        where('quest_id', '==', questId),
      ))
      if (cancelled) return
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ExplorerSub))
      rows.sort((a, b) => (b.submitted_at?.seconds ?? 0) - (a.submitted_at?.seconds ?? 0))
      setSubs(rows)
      setLoadedQuestId(questId)

      // Resolve game names for the header line on each card.
      const ids = Array.from(new Set(rows.map((r) => r.game_id)))
      const names = new Map<string, string>()
      await Promise.all(ids.map(async (gid) => {
        try {
          const g = await getDoc(doc(db, 'games', gid))
          if (g.exists()) names.set(gid, g.data().name || gid)
        } catch {
          /* leave id as fallback */
        }
      }))
      if (!cancelled) setGameNames(names)
    }
    load().catch((err) => console.warn('Load failed:', err))
    return () => { cancelled = true }
  }, [questId])

  const visible = useMemo(
    () => subs.filter((s) => statusFilter === 'all' || s.status === statusFilter),
    [subs, statusFilter],
  )

  const questTitle = knownQuests.find((q) => q.id === questId)?.title ?? questId

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['quest', 'game', 'status', 'submitter', 'gps_lat', 'gps_lng', 'photo_url', 'submitted_at'].join(','),
      ...visible.map((s) => [
        esc(questTitle),
        esc(gameNames.get(s.game_id) ?? s.game_id),
        esc(s.status),
        esc(s.submitter_name),
        esc(s.gps_lat ?? ''),
        esc(s.gps_lng ?? ''),
        esc(s.media_url),
        esc(s.submitted_at?.seconds ? new Date(s.submitted_at.seconds * 1000).toISOString() : ''),
      ].join(',')),
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `foray-${questId}-all-time.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", padding: 24,
    }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 4px' }}>
          🧩 Side Quest Explorer
        </h1>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem', margin: '0 0 20px' }}>
          Every submission across all games — for reviewing history and sharing
          with external partners.
        </p>

        {/* Quest picker + status filter + export */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
          <select
            value={questId}
            onChange={(e) => setQuestId(e.target.value)}
            style={{ background: 'var(--surface)', border: '1px solid rgba(var(--pink-rgb), 0.35)', color: 'var(--pink)', borderRadius: 8, padding: '9px 12px', fontSize: '0.88rem', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', outline: 'none' }}
          >
            {knownQuests.map((q) => (
              <option key={q.id} value={q.id}>{q.title}</option>
            ))}
          </select>
          {(['approved', 'pending', 'rejected', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              style={{
                background: statusFilter === f ? 'rgba(var(--pink-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)',
                border: `1px solid ${statusFilter === f ? 'rgba(var(--pink-rgb), 0.4)' : 'var(--line)'}`,
                color: statusFilter === f ? 'var(--pink)' : 'var(--ink-faint)',
                padding: '7px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize',
              }}
            >
              {f}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button
            onClick={exportCsv}
            disabled={visible.length === 0}
            style={{
              background: visible.length ? 'rgba(var(--pink-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)',
              border: `1px solid ${visible.length ? 'rgba(var(--pink-rgb), 0.4)' : 'var(--line)'}`,
              color: visible.length ? 'var(--pink)' : 'var(--ink-ghost)',
              padding: '9px 16px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700,
              cursor: visible.length ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
            }}
          >
            ⬇ Export CSV ({visible.length})
          </button>
        </div>

        {/* Results */}
        {loadedQuestId !== questId ? (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>Loading…</p>
        ) : visible.length === 0 ? (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>
            No {statusFilter === 'all' ? '' : statusFilter + ' '}submissions for this quest yet.
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {visible.map((s) => (
              <div key={s.id} style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
                {deadMedia.has(s.id) ? (
                  <div style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-ghost)', fontSize: '0.75rem', background: 'var(--surface)' }}>
                    🖼️ Media no longer available
                  </div>
                ) : (
                  <a href={s.media_url} target="_blank" rel="noreferrer">
                    <img
                      src={s.media_url} alt="" loading="lazy"
                      onError={() => setDeadMedia((prev) => new Set(prev).add(s.id))}
                      style={{ width: '100%', height: 150, objectFit: 'cover', display: 'block', background: 'var(--surface)' }}
                    />
                  </a>
                )}
                <div style={{ padding: '9px 12px' }}>
                  <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--ink-soft)', fontWeight: 600 }}>
                    {s.submitter_name}
                    <span style={{
                      float: 'right', fontWeight: 700, fontSize: '0.68rem',
                      color: s.status === 'approved' ? 'var(--green)' : s.status === 'rejected' ? 'var(--red)' : 'var(--marigold)',
                    }}>
                      {s.status}
                    </span>
                  </p>
                  <p style={{ margin: '3px 0 0', fontSize: '0.7rem', color: 'var(--ink-muted)' }}>
                    {gameNames.get(s.game_id) ?? s.game_id}
                    {s.submitted_at?.seconds && (
                      <> · {new Date(s.submitted_at.seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</>
                    )}
                  </p>
                  {s.gps_lat != null && s.gps_lng != null && (
                    <a
                      href={`https://www.google.com/maps?q=${s.gps_lat},${s.gps_lng}`}
                      target="_blank" rel="noreferrer"
                      style={{ fontSize: '0.7rem', color: 'var(--blue)', textDecoration: 'none' }}
                    >
                      📍 {s.gps_lat.toFixed(5)}, {s.gps_lng.toFixed(5)}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
