// =============================================================================
// Foray — Player profile
// Routes: /profile (yours) and /profile/:uid (anyone's, signed-in only).
//
// Everything here is derived from game_results — name, stats, badge wall,
// crew streak, recent games — so no other player's users/ doc is ever read.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { auth } from '../lib/firebase'
import { loadPlayerResults, playedAtMs } from '../lib/gameResults'
import { computeBadges, crewStreak } from '../lib/badges'
import { formatDistance } from '../lib/distance'
import type { GameResult } from '../types/game'

const MONO = "'Martian Mono', monospace"

function ordinal(n: number): string {
  const m = n % 100
  const s = m >= 11 && m <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${s}`
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const { uid: uidParam } = useParams<{ uid?: string }>()
  const me = auth.currentUser
  const uid = uidParam ?? me?.uid ?? null
  const isMe = !!me && uid === me.uid

  const [results, setResults] = useState<GameResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    loadPlayerResults(uid)
      .then((r) => { if (!cancelled) setResults(r) })
      .catch((err) => { if (!cancelled) setError((err as Error).message) })
    return () => { cancelled = true }
  }, [uid])

  const stats = useMemo(() => {
    const rs = results ?? []
    const idx = (r: GameResult) => r.member_uids.indexOf(uid ?? '')
    const latest = rs[0]
    return {
      name: latest ? (latest.member_names[idx(latest)] ?? 'Player') : (isMe ? (me?.displayName ?? 'You') : 'Player'),
      games: rs.length,
      wins: rs.filter((r) => r.place === 1).length,
      podiums: rs.filter((r) => r.place <= 3).length,
      placementPoints: rs.reduce((s, r) => s + r.placement_points, 0),
      distance: rs.reduce((s, r) => s + (r.distance_m ?? 0), 0),
      zones: rs.reduce((s, r) => s + (r.zones_claimed ?? 0), 0),
      challenges: rs.reduce((s, r) => s + (r.challenges ?? 0), 0),
      badges: computeBadges(rs),
      crew: crewStreak(rs),
    }
  }, [results, uid, isMe, me?.displayName])

  const earnedCount = stats.badges.filter((b) => b.earned).length

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", paddingBottom: 48,
    }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '20px 20px 0' }}>
        <button
          onClick={() => navigate(-1)}
          style={{ background: 'none', border: 'none', color: 'var(--ink-muted)', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 18 }}
        >
          ← Back
        </button>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <p style={{ fontFamily: MONO, fontSize: '0.68rem', color: 'var(--marigold-deep)', textTransform: 'uppercase', letterSpacing: 2, margin: '0 0 6px' }}>
            {isMe ? 'Your profile' : 'Player profile'}
          </p>
          <h1 style={{ fontSize: '1.7rem', fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>{stats.name}</h1>
          {stats.crew.games >= 2 && (
            <p style={{ color: 'var(--ink-muted)', fontSize: '0.82rem', margin: '8px 0 0' }}>
              🤝 {stats.crew.games} games with {stats.crew.names.filter((n) => n !== stats.name).join(' & ') || 'the same crew'}
            </p>
          )}
        </div>

        {error && (
          <p style={{ color: 'var(--red)', fontSize: '0.85rem', textAlign: 'center' }}>Couldn't load this profile: {error}</p>
        )}
        {results === null && !error && (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem', textAlign: 'center' }}>Loading…</p>
        )}

        {results !== null && (
          <>
            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 24 }}>
              {[
                { v: stats.placementPoints, l: 'Season pts' },
                { v: stats.games, l: 'Games played' },
                { v: stats.wins, l: 'Wins' },
                { v: stats.podiums, l: 'Podiums' },
              ].map((s) => (
                <div key={s.l} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 6px', textAlign: 'center' }}>
                  <p style={{ fontFamily: MONO, fontSize: '1.4rem', fontWeight: 800, color: 'var(--marigold-deep)', margin: 0, lineHeight: 1 }}>{s.v}</p>
                  <p style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, margin: '6px 0 0' }}>{s.l}</p>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 18, color: 'var(--ink-muted)', fontSize: '0.8rem', marginBottom: 28, flexWrap: 'wrap' }}>
              <span>🚶 {formatDistance(stats.distance)} covered</span>
              <span>🏴 {stats.zones} zones</span>
              <span>⚡ {stats.challenges} challenges</span>
            </div>

            {/* Badges */}
            <p style={{ fontSize: '0.72rem', color: 'var(--marigold-deep)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '0 0 12px' }}>
              Badges · {earnedCount} / {stats.badges.length}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 28 }}>
              {stats.badges.map((b) => (
                <div key={b.key} title={b.description} style={{
                  background: b.earned ? 'rgba(var(--marigold-rgb), 0.12)' : 'rgba(var(--ink-rgb), 0.02)',
                  border: `1px solid ${b.earned ? 'rgba(var(--marigold-rgb), 0.5)' : 'var(--line)'}`,
                  borderRadius: 12, padding: '12px 8px', textAlign: 'center',
                  opacity: b.earned ? 1 : 0.6,
                }}>
                  <div style={{ fontSize: '1.5rem', lineHeight: 1, filter: b.earned ? 'none' : 'grayscale(1)' }}>{b.emoji}</div>
                  <p style={{ fontSize: '0.74rem', fontWeight: 800, color: 'var(--ink)', margin: '6px 0 2px' }}>{b.label}</p>
                  <p style={{ fontSize: '0.62rem', color: 'var(--ink-faint)', margin: 0, lineHeight: 1.3 }}>
                    {b.earned ? b.description : b.progress}
                  </p>
                </div>
              ))}
            </div>

            {/* Recent games */}
            <p style={{ fontSize: '0.72rem', color: 'var(--marigold-deep)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '0 0 12px' }}>
              Games played
            </p>
            {results.length === 0 ? (
              <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem', textAlign: 'center', padding: '12px 0' }}>
                {isMe ? 'No finished games yet. Your first Foray will show up here.' : 'No finished games yet.'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {results.map((r) => {
                  const when = playedAtMs(r) ? new Date(playedAtMs(r)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
                  return (
                    <div key={r.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px',
                    }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: r.team_color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.team_name} <span style={{ color: 'var(--ink-faint)', fontWeight: 400 }}>· {r.game_name}</span>
                        </p>
                        <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: 'var(--ink-faint)' }}>
                          {when}{r.distance_m ? ` · ${formatDistance(r.distance_m)}` : ''} · {r.zones_claimed} zones
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ margin: 0, fontFamily: MONO, fontWeight: 800, color: r.place === 1 ? 'var(--marigold-deep)' : 'var(--ink-soft)', fontSize: '0.95rem' }}>
                          {r.tied ? 'T-' : ''}{ordinal(r.place)}
                        </p>
                        <p style={{ margin: 0, fontSize: '0.68rem', color: 'var(--ink-faint)' }}>+{r.placement_points} · {r.points} pts</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
