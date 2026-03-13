// =============================================================================
// Zone Rush — History Tab
// Shows a team's completed (approved) challenges in reverse chronological order.
// Query: submissions where team_id == teamId && status == 'approved'
// =============================================================================

import { useState, useEffect } from 'react'
import {
  collection,
  query,
  where,
  onSnapshot,
  getDoc,
  doc,
} from 'firebase/firestore'
import { db } from '../lib/firebase'

// Difficulty badge colors — must match the rest of the app
const DIFF_COLORS: Record<string, { bg: string; text: string }> = {
  easy:   { bg: 'rgba(6,214,160,0.12)',   text: '#06D6A0' },
  medium: { bg: 'rgba(255,209,102,0.12)', text: '#FFD166' },
  hard:   { bg: 'rgba(239,71,111,0.12)',  text: '#EF476F' },
}

interface Submission {
  id: string
  challenge_id: string
  zone_id: string
  points_awarded: number
  attempted_tier2: boolean
  tier2_approved: boolean
  phone_free_claimed: boolean
  phone_free_approved: boolean
  media_type: 'photo' | 'video' | 'audio'
  media_url: string
  submitted_at: { toDate: () => Date } | null
  // Joined from challenges collection (fetched separately below)
  challenge_title?: string
  challenge_description?: string
  challenge_difficulty?: string
}

interface HistoryTabProps {
  gameId: string
  teamId: string
  /** Total approved points this team has earned — displayed in the header summary */
  totalPoints: number
}

export default function HistoryTab({ gameId, teamId, totalPoints }: HistoryTabProps) {
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [challengeMap, setChallengeMap] = useState<Map<string, { description: string; difficulty: string }>>(new Map())

  // ------------------------------------------------------------------
  // Real-time listener on approved submissions for this team + game
  // ------------------------------------------------------------------
  useEffect(() => {
    const q = query(
      collection(db, 'submissions'),
      where('game_id', '==', gameId),
      where('team_id', '==', teamId),
      where('status', '==', 'approved'),
    )

      const unsub = onSnapshot(q, (snap) => {
    const docs = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Submission, 'id'>),
    }))
    // Sort client-side so we don't need a composite Firestore index
    docs.sort((a, b) => {
      const aTime = a.submitted_at?.toDate().getTime() ?? 0
      const bTime = b.submitted_at?.toDate().getTime() ?? 0
      return bTime - aTime
    })
    setSubmissions(docs)
    setLoading(false)
  }, (error) => {
    // Query failed (e.g. missing Firestore index) — exit loading state
    // so the empty state renders instead of spinning forever
    console.error('HistoryTab query error:', error)
    setLoading(false)
  })

    return () => unsub()
  }, [gameId, teamId])

    // Fetch challenge details for all submissions so we can show
    // description and difficulty (these aren't stored on submission docs)
    useEffect(() => {
      if (submissions.length === 0) return

      const uniqueIds = [...new Set(submissions.map((s) => s.challenge_id))]

      async function fetchChallenges() {
        const map = new Map<string, { description: string; difficulty: string }>()
        await Promise.all(
          uniqueIds.map(async (id) => {
            const snap = await getDoc(doc(db, 'challenges', id))
            if (snap.exists()) {
              const data = snap.data()
              map.set(id, {
                description: data.description ?? '',
                difficulty: data.difficulty ?? 'medium',
              })
            }
          })
        )
        setChallengeMap(map)
      }

      fetchChallenges()
    }, [submissions])

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const formatTime = (ts: Submission['submitted_at']): string => {
    if (!ts) return '—'
    const d = ts.toDate()
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const zoneName = (zoneId: string) =>
    zoneId.replace('zone_district_', 'District ').replace(/_/g, ' ')

  const mediaIcon = (type: string) =>
    type === 'video' ? '🎥' : type === 'audio' ? '🎙️' : '📷'

  const diffStyle = (diff?: string) =>
    DIFF_COLORS[diff?.toLowerCase() ?? ''] ?? { bg: 'rgba(255,255,255,0.05)', text: '#888' }

  // ------------------------------------------------------------------
  // Empty / loading states
  // ------------------------------------------------------------------
  if (loading) {
    return (
      <div style={outerWrap}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <div style={spinner} />
        </div>
      </div>
    )
  }

  if (submissions.length === 0) {
    return (
      <div style={outerWrap}>
        <div style={emptyState}>
          <span style={{ fontSize: '2.4rem', marginBottom: 14 }}>🗂️</span>
          <p style={{ color: '#e0e0e0', fontWeight: 700, fontSize: '1rem', marginBottom: 8 }}>
            No completed challenges yet
          </p>
          <p style={{ color: '#555', fontSize: '0.85rem', lineHeight: 1.6, textAlign: 'center', maxWidth: 240 }}>
            Get out there and complete your first challenge — it'll show up here once the GM approves it.
          </p>
        </div>
      </div>
    )
  }

  // ------------------------------------------------------------------
  // Main render
  // ------------------------------------------------------------------
  return (
    <div style={outerWrap}>

      {/* ── Summary bar ── */}
      <div style={summaryBar}>
        <div style={summaryItem}>
          <span style={{ ...summaryValue, color: '#06D6A0' }}>{submissions.length}</span>
          <span style={summaryLabel}>Completed</span>
        </div>
        <div style={divider} />
        <div style={summaryItem}>
          <span style={{ ...summaryValue, color: '#FFD166' }}>{totalPoints}</span>
          <span style={summaryLabel}>Total pts</span>
        </div>
        <div style={divider} />
        <div style={summaryItem}>
          <span style={{ ...summaryValue, color: '#9B5DE5' }}>
            {submissions.filter((s) => s.tier2_approved).length}
          </span>
          <span style={summaryLabel}>Tier 2 hits</span>
        </div>
      </div>

      {/* ── Submission list ── */}
      <div style={{ padding: '12px 16px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {submissions.map((sub, idx) => {
          const isExpanded = expandedId === sub.id
          const ch = challengeMap.get(sub.challenge_id)
          const ds = diffStyle(ch?.difficulty)
          const isNewest = idx === 0

          return (
            <div
              key={sub.id}
              onClick={() => setExpandedId(isExpanded ? null : sub.id)}
              style={{
                background: 'rgba(255,255,255,0.025)',
                border: `1px solid ${isNewest ? 'rgba(6,214,160,0.25)' : '#1a1a1a'}`,
                borderRadius: 12,
                overflow: 'hidden',
                cursor: 'pointer',
                transition: 'border-color 0.15s',
              }}
            >
              {/* ── Card header row ── */}
              <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>

                {/* Media type icon */}
                <div style={{
                  width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                  background: 'rgba(255,255,255,0.04)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.2rem',
                }}>
                  {mediaIcon(sub.media_type)}
                </div>

                {/* Challenge text + meta */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    color: '#e0e0e0', fontSize: '0.88rem', lineHeight: 1.5,
                    marginBottom: 8,
                    // Clamp to 2 lines when collapsed
                    display: '-webkit-box',
                    WebkitLineClamp: isExpanded ? 'unset' : 2,
                    WebkitBoxOrient: 'vertical' as any,
                    overflow: isExpanded ? 'visible' : 'hidden',
                  }}>
                    {ch?.description ?? sub.challenge_id}
                  </p>

                  {/* Badges row */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {/* Zone */}
                    <span style={badge('#118AB2', 'rgba(17,138,178,0.12)')}>
                      📍 {zoneName(sub.zone_id)}
                    </span>

                    {/* Difficulty */}
                    {ch?.difficulty && (
                      <span style={badge(ds.text, ds.bg)}>
                        {ch.difficulty}
                      </span>
                    )}

                    {/* Tier 2 */}
                    {sub.tier2_approved && (
                      <span style={badge('#9B5DE5', 'rgba(155,93,229,0.12)')}>
                        ✦ Tier 2
                      </span>
                    )}

                    {/* Phone-free */}
                    {sub.phone_free_approved && (
                      <span style={badge('#06D6A0', 'rgba(6,214,160,0.12)')}>
                        📵 Phone-free
                      </span>
                    )}
                  </div>
                </div>

                {/* Points + time — right side */}
                <div style={{ flexShrink: 0, textAlign: 'right' }}>
                  <p style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: '#06D6A0', fontWeight: 700, fontSize: '1.1rem',
                    lineHeight: 1,
                  }}>
                    +{sub.points_awarded ?? '?'}
                  </p>
                  <p style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    color: '#444', fontSize: '0.7rem', marginTop: 5,
                  }}>
                    {formatTime(sub.submitted_at)}
                  </p>
                  <p style={{
                    color: '#333', fontSize: '0.72rem', marginTop: 6,
                    transform: isExpanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                  }}>
                    ▼
                  </p>
                </div>
              </div>

              {/* ── Expanded: media preview ── */}
              {isExpanded && (
                <div style={{
                  borderTop: '1px solid #1a1a1a',
                  padding: '12px 16px 16px',
                  background: 'rgba(0,0,0,0.2)',
                }}>
                  {sub.media_url ? (
                    sub.media_type === 'video' ? (
                      <video
                        src={sub.media_url}
                        controls
                        playsInline
                        style={{
                          width: '100%', borderRadius: 8, maxHeight: 220,
                          background: '#111', objectFit: 'contain',
                        }}
                      />
                    ) : sub.media_type === 'audio' ? (
                      <audio src={sub.media_url} controls style={{ width: '100%' }} />
                    ) : (
                      <img
                        src={sub.media_url}
                        alt="Submission proof"
                        style={{
                          width: '100%', borderRadius: 8, maxHeight: 220,
                          objectFit: 'contain', background: '#111',
                          display: 'block',
                        }}
                      />
                    )
                  ) : (
                    <p style={{ color: '#444', fontSize: '0.82rem', textAlign: 'center' }}>
                      Media not available
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// Styles
// =============================================================================

const outerWrap: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  background: '#0a0a0a',
  fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
  color: '#fff',
}

const summaryBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-around',
  padding: '16px 20px',
  borderBottom: '1px solid #1a1a1a',
  background: '#0d0d0d',
}

const summaryItem: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
}

const summaryValue: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '1.5rem',
  fontWeight: 700,
  lineHeight: 1,
}

const summaryLabel: React.CSSProperties = {
  fontSize: '0.7rem',
  color: '#555',
  textTransform: 'uppercase',
  letterSpacing: 1,
  fontWeight: 600,
}

const divider: React.CSSProperties = {
  width: 1,
  height: 32,
  background: '#1a1a1a',
}

const emptyState: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '80px 32px',
}

const spinner: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: '2px solid #1a1a1a',
  borderTopColor: '#06D6A0',
  animation: 'spin 0.8s linear infinite',
}

function badge(color: string, bg: string): React.CSSProperties {
  return {
    fontSize: '0.7rem',
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 6,
    background: bg,
    color: color,
    letterSpacing: 0.3,
    whiteSpace: 'nowrap',
  }
}
