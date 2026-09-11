// =============================================================================
// Foray — All-time leaderboard
// Route: /leaderboard (signed-in). Ranks PLAYERS by placement points across
// every recorded game, sliced Overall / Region / City. Regions come from an
// optional `region` field on city docs — until one is set, every city sits
// under "Unassigned" and the Region tab is mostly a preview of what's coming.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import { aggregateLeaderboard, loadAllResults, type LeaderboardRow } from '../lib/gameResults'
import type { GameResult } from '../types/game'

const MONO = "'Martian Mono', monospace"

type Scope = 'overall' | 'region' | 'city'

interface CityInfo { id: string; name: string; region: string }

const MEDALS = ['🥇', '🥈', '🥉']

export default function LeaderboardPage() {
  const navigate = useNavigate()
  const me = auth.currentUser
  const [results, setResults] = useState<GameResult[] | null>(null)
  const [cities, setCities] = useState<Map<string, CityInfo>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('overall')
  const [pick, setPick] = useState<string | null>(null)   // selected city or region

  useEffect(() => {
    let cancelled = false
    Promise.all([loadAllResults(), getDocs(collection(db, 'cities'))])
      .then(([rs, citySnap]) => {
        if (cancelled) return
        const m = new Map<string, CityInfo>()
        citySnap.forEach((d) => {
          const c = d.data()
          m.set(d.id, { id: d.id, name: (c.name as string) ?? d.id, region: (c.region as string) ?? 'Unassigned' })
        })
        setCities(m)
        setResults(rs)
      })
      .catch((err) => { if (!cancelled) setError((err as Error).message) })
    return () => { cancelled = true }
  }, [])

  const cityOf = (id: string): CityInfo => cities.get(id) ?? { id, name: id.toUpperCase(), region: 'Unassigned' }

  // Options for the active scope, drawn from results so empty cities don't show.
  const options = useMemo(() => {
    const rs = results ?? []
    if (scope === 'city') {
      const ids = [...new Set(rs.map((r) => r.city))]
      return ids.map((id) => ({ id, label: cityOf(id).name })).sort((a, b) => a.label.localeCompare(b.label))
    }
    if (scope === 'region') {
      const regions = [...new Set(rs.map((r) => cityOf(r.city).region))]
      return regions.map((id) => ({ id, label: id })).sort((a, b) => a.label.localeCompare(b.label))
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, cities, scope])

  const activePick = pick && options.some((o) => o.id === pick) ? pick : options[0]?.id ?? null

  const rows: LeaderboardRow[] = useMemo(() => {
    const rs = results ?? []
    const filtered = scope === 'overall' ? rs
      : scope === 'city' ? rs.filter((r) => r.city === activePick)
      : rs.filter((r) => cityOf(r.city).region === activePick)
    return aggregateLeaderboard(filtered).slice(0, 100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, cities, scope, activePick])

  const myRank = me ? rows.findIndex((r) => r.uid === me.uid) : -1

  const tab = (s: Scope, label: string) => (
    <button
      key={s}
      onClick={() => { setScope(s); setPick(null) }}
      style={{
        flex: 1, padding: '9px 0', borderRadius: 10, fontFamily: 'inherit', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer',
        background: scope === s ? 'var(--marigold)' : 'transparent',
        border: `1px solid ${scope === s ? 'var(--marigold-deep)' : 'var(--line)'}`,
        color: scope === s ? 'var(--ink)' : 'var(--ink-muted)',
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", paddingBottom: 48,
    }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '20px 20px 0' }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--ink-muted)', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 18 }}
        >
          ← Home
        </button>

        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <p style={{ fontFamily: MONO, fontSize: '0.68rem', color: 'var(--marigold-deep)', textTransform: 'uppercase', letterSpacing: 2, margin: '0 0 6px' }}>
            All-time
          </p>
          <h1 style={{ fontSize: '1.7rem', fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>Leaderboard</h1>
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.78rem', margin: '8px 0 0', lineHeight: 1.5 }}>
            Placement points per game: 1st 10 · 2nd 7 · 3rd 5 · others 3
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {tab('overall', 'Overall')}
          {tab('region', 'Region')}
          {tab('city', 'City')}
        </div>

        {scope !== 'overall' && options.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => setPick(o.id)}
                style={{
                  padding: '6px 12px', borderRadius: 999, fontFamily: 'inherit', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer',
                  background: activePick === o.id ? 'rgba(var(--marigold-rgb), 0.18)' : 'var(--surface)',
                  border: `1px solid ${activePick === o.id ? 'var(--marigold-deep)' : 'var(--line)'}`,
                  color: activePick === o.id ? 'var(--marigold-deep)' : 'var(--ink-muted)',
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {error && <p style={{ color: 'var(--red)', fontSize: '0.85rem', textAlign: 'center' }}>Couldn't load the leaderboard: {error}</p>}
        {results === null && !error && <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem', textAlign: 'center' }}>Loading…</p>}

        {results !== null && rows.length === 0 && (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem', textAlign: 'center', padding: '24px 0' }}>
            No recorded games here yet. Finish a Foray and run the reveal to get on the board.
          </p>
        )}

        {rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map((r, i) => {
              const mine = me?.uid === r.uid
              return (
                <button
                  key={r.uid}
                  onClick={() => navigate(`/profile/${r.uid}`)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%',
                    background: mine ? 'rgba(var(--marigold-rgb), 0.14)' : 'var(--surface)',
                    border: `1px solid ${mine ? 'var(--marigold-deep)' : 'var(--line)'}`,
                    borderRadius: 12, padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)',
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: '0.78rem', fontWeight: 700, color: 'var(--ink-muted)', width: 28 }}>
                    {i < 3 ? MEDALS[i] : i + 1}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: mine ? 800 : 600, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}{mine ? ' (you)' : ''}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}>
                    {r.games} {r.games === 1 ? 'game' : 'games'} · {r.wins} {r.wins === 1 ? 'win' : 'wins'}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: '1rem', fontWeight: 800, color: 'var(--marigold-deep)', minWidth: 36, textAlign: 'right' }}>
                    {r.placementPoints}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {results !== null && me && myRank === -1 && rows.length > 0 && (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.78rem', textAlign: 'center', margin: '16px 0 0' }}>
            You're not on this board yet. Finish a Foray to get ranked.
          </p>
        )}
      </div>
    </div>
  )
}
