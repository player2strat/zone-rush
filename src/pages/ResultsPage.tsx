// =============================================================================
// Zone Rush — Results Page
// Shown to all players and GM when game.status === 'ended'.
// Features: confetti burst on load, final standings, zone breakdown,
// bonus point attribution, and final zone map state.
// =============================================================================

import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { doc, onSnapshot, collection, getDocs } from 'firebase/firestore'
import { db } from '../lib/firebase'
import GameMap from '../components/GameMap'
import type { ZoneOwner } from '../components/GameMap'

// --------------- Types ---------------

interface GameData {
  id: string
  name: string
  status: string
  zones: string[]
  started_at: any
  ends_at: any
  closed_zones?: string[]
  end_game_bonuses?: Record<string, number>
  bonuses_applied?: boolean
  settings: {
    claim_threshold: number
    zone_bonus_points: number
    [key: string]: any
  }
}

interface TeamData {
  id: string
  name: string
  color: string
  total_points: number
  zones_claimed: number
  member_names: string[]
}

interface ZoneScoreData {
  team_id: string
  zone_id: string
  points: number
  status: 'none' | 'claimed'
  challenges_completed: string[]
}

// --------------- Confetti ---------------

const CONFETTI_COLORS = [
  '#FFD166', '#06D6A0', '#EF476F', '#118AB2',
  '#9B5DE5', '#F77F00', '#FF6B8A', '#2EC4B6',
]

interface ConfettiPiece {
  id: number
  x: number
  color: string
  size: number
  duration: number
  delay: number
  rotation: number
  shape: 'rect' | 'circle' | 'strip'
}

function generateConfetti(count: number): ConfettiPiece[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    size: 6 + Math.random() * 8,
    duration: 2.5 + Math.random() * 2,
    delay: Math.random() * 1.2,
    rotation: Math.random() * 360,
    shape: (['rect', 'circle', 'strip'] as const)[Math.floor(Math.random() * 3)],
  }))
}

function ConfettiOverlay({ onDone }: { onDone: () => void }) {
  const pieces = useMemo(() => generateConfetti(120), [])

  useEffect(() => {
    const timer = setTimeout(onDone, 4000)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      pointerEvents: 'none', overflow: 'hidden',
    }}>
      <style>{`
        @keyframes confettiFall {
          0%   { transform: translateY(-40px) rotate(var(--rot)); opacity: 1; }
          80%  { opacity: 1; }
          100% { transform: translateY(110vh) rotate(calc(var(--rot) + 720deg)); opacity: 0; }
        }
        @keyframes confettiSway {
          0%, 100% { margin-left: 0; }
          25%  { margin-left: 20px; }
          75%  { margin-left: -20px; }
        }
        @keyframes overlayFadeOut {
          0%   { opacity: 1; }
          70%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
      <div style={{
        position: 'absolute', inset: 0,
        animation: 'overlayFadeOut 4s ease forwards',
      }}>
        {pieces.map((p) => (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              left: `${p.x}%`,
              top: 0,
              width: p.shape === 'strip' ? p.size / 3 : p.size,
              height: p.shape === 'strip' ? p.size * 3 : p.size,
              borderRadius: p.shape === 'circle' ? '50%' : p.shape === 'strip' ? 2 : 2,
              background: p.color,
              // @ts-ignore — CSS custom property
              '--rot': `${p.rotation}deg`,
              animation: `
                confettiFall ${p.duration}s ${p.delay}s ease-in forwards,
                confettiSway ${p.duration * 0.6}s ${p.delay}s ease-in-out infinite
              `,
            }}
          />
        ))}
      </div>
    </div>
  )
}

// --------------- Medal colors ---------------

const RANK_STYLES = [
  { label: '1st', bg: 'rgba(255,209,102,0.12)', border: 'rgba(255,209,102,0.35)', color: '#FFD166', medal: '🥇' },
  { label: '2nd', bg: 'rgba(180,180,200,0.08)', border: 'rgba(180,180,200,0.25)', color: '#b0b0c0', medal: '🥈' },
  { label: '3rd', bg: 'rgba(205,127,50,0.08)',  border: 'rgba(205,127,50,0.25)',  color: '#cd7f32', medal: '🥉' },
]

// --------------- Component ---------------

export default function ResultsPage() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()

  const [game, setGame] = useState<GameData | null>(null)
  const [teams, setTeams] = useState<TeamData[]>([])
  const [zoneScores, setZoneScores] = useState<ZoneScoreData[]>([])
  const [allZoneData, setAllZoneData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Confetti
  const [showConfetti, setShowConfetti] = useState(true)

  // Load zones from Firestore
  useEffect(() => {
    async function loadZones() {
      const snap = await getDocs(collection(db, 'zones'))
      const loaded = snap.docs.map((d) => {
        const data = d.data()
        return {
          ...data,
          boundary: typeof data.boundary === 'string'
            ? JSON.parse(data.boundary)
            : data.boundary,
        }
      })
      setAllZoneData(loaded)
    }
    loadZones()
  }, [])

  // Listen to game doc
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (snap.exists()) setGame({ id: snap.id, ...snap.data() } as GameData)
    })
    return () => unsub()
  }, [gameId])

  // Listen to teams
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(
      collection(db, 'games', gameId, 'teams'),
      (snap) => {
        const t: TeamData[] = []
        snap.forEach((d) => t.push({ id: d.id, ...d.data() } as TeamData))
        setTeams(t)
        setLoading(false)
      }
    )
    return () => unsub()
  }, [gameId])

  // Listen to zone scores
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(
      collection(db, 'games', gameId, 'zone_scores'),
      (snap) => {
        const scores: ZoneScoreData[] = []
        snap.forEach((d) => scores.push(d.data() as ZoneScoreData))
        setZoneScores(scores)
      }
    )
    return () => unsub()
  }, [gameId])

  // ---------- Computed ----------

  // Final scoreboard — sort by total_points descending
  const scoreboard = useMemo(() => {
    return teams
      .map((t) => {
        const teamZoneScores = zoneScores.filter((zs) => zs.team_id === t.id)
        const bonusPoints = game?.end_game_bonuses?.[t.id] ?? 0
        return {
          ...t,
          zoneBreakdown: teamZoneScores,
          bonusPoints,
          challengesCompleted: teamZoneScores.reduce(
            (sum, zs) => sum + (zs.challenges_completed?.length ?? 0), 0
          ),
        }
      })
      .sort((a, b) => b.total_points - a.total_points)
  }, [teams, zoneScores, game?.end_game_bonuses])

  // Who won — tied if top two have same points
  const winner = scoreboard[0] ?? null
  const isTie =
    scoreboard.length > 1 &&
    scoreboard[0].total_points === scoreboard[1].total_points

  // Zone ownership map for GameMap
  const claimThreshold = game?.settings.claim_threshold ?? 6
  const zoneOwnership = useMemo(() => {
    const m = new Map<string, ZoneOwner>()
    for (const zs of zoneScores) {
      if (zs.status !== 'claimed') continue
      const team = teams.find((t) => t.id === zs.team_id)
      if (!team) continue
      const existing = m.get(zs.zone_id)
      if (!existing || zs.points > existing.points) {
        m.set(zs.zone_id, {
          teamColor: team.color,
          teamName: team.name,
          points: zs.points,
          claimed: true,
        })
      }
    }
    return m
  }, [zoneScores, teams])

  const activeZones = useMemo(
    () => allZoneData.filter((z) => game?.zones?.includes(z.id)),
    [allZoneData, game?.zones]
  )

  // Bonus attribution — invert end_game_bonuses for display
  // We can't perfectly reconstruct which bonus went to which team
  // without re-running the awards, so we show total bonuses per team.
  const bonusMap = game?.end_game_bonuses ?? {}

  // Game duration
  const duration = useMemo(() => {
    if (!game?.started_at || !game?.ends_at) return null
    const start = game.started_at.toDate?.() ?? new Date(game.started_at)
    const end = game.ends_at.toDate?.() ?? new Date(game.ends_at)
    const diff = Math.floor((end.getTime() - start.getTime()) / 60000)
    return `${Math.floor(diff / 60)}h ${diff % 60}m`
  }, [game?.started_at, game?.ends_at])

  // ---------- Render ----------

  if (loading || !game) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0a', color: '#555',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 32, height: 32, border: '3px solid #222',
            borderTopColor: '#FFD166', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite', margin: '0 auto 12px',
          }} />
          <p>Loading results...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      paddingBottom: 60,
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes winnerPop {
          0%   { opacity: 0; transform: scale(0.85); }
          60%  { transform: scale(1.04); }
          100% { opacity: 1; transform: scale(1); }
        }
        .results-section {
          animation: slideUp 0.5s ease both;
        }
      `}</style>

      {/* Confetti overlay */}
      {showConfetti && (
        <ConfettiOverlay onDone={() => setShowConfetti(false)} />
      )}

      {/* Header */}
      <div style={{
        background: 'linear-gradient(160deg, #0a0a0a 0%, #1a0a2e 60%, #0a1628 100%)',
        padding: '40px 24px 32px',
        borderBottom: '1px solid #1a1a1a',
        textAlign: 'center',
      }}>
        <p style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.72rem', color: '#FFD166',
          textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8,
        }}>
          Zone Rush · Game Over
        </p>
        <h1 style={{
          fontSize: '1.8rem', fontWeight: 800,
          letterSpacing: -0.5, margin: '0 0 6px',
        }}>
          {game.name}
        </h1>
        {duration && (
          <p style={{ color: '#444', fontSize: '0.82rem' }}>
            Duration: {duration}
          </p>
        )}
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '28px 20px 0' }}>

        {/* ====== WINNER BANNER ====== */}
        {winner && (
          <div
            className="results-section"
            style={{
              animationDelay: '0.1s',
              marginBottom: 28,
              background: isTie
                ? 'rgba(255,255,255,0.03)'
                : `linear-gradient(135deg, ${winner.color}18 0%, ${winner.color}08 100%)`,
              border: `1px solid ${isTie ? '#333' : winner.color + '50'}`,
              borderRadius: 16,
              padding: '24px 20px',
              textAlign: 'center',
              animation: 'winnerPop 0.6s 0.3s ease both',
            }}
          >
            <p style={{ fontSize: '2.4rem', marginBottom: 10 }}>
              {isTie ? '🤝' : '🏆'}
            </p>
            <p style={{
              fontSize: '0.72rem', color: isTie ? '#888' : winner.color,
              textTransform: 'uppercase', letterSpacing: 2,
              fontWeight: 700, marginBottom: 6,
            }}>
              {isTie ? 'It\'s a Tie!' : 'Winner'}
            </p>
            <p style={{
              fontSize: '1.6rem', fontWeight: 800, letterSpacing: -0.5,
              color: isTie ? '#fff' : winner.color,
            }}>
              {isTie
                ? `${scoreboard[0].name} & ${scoreboard[1].name}`
                : winner.name}
            </p>
            {!isTie && (
              <p style={{ color: '#666', fontSize: '0.82rem', marginTop: 6 }}>
                {winner.member_names?.join(' · ')}
              </p>
            )}
          </div>
        )}

        {/* ====== FINAL STANDINGS ====== */}
        <div className="results-section" style={{ animationDelay: '0.2s', marginBottom: 28 }}>
          <p style={{
            fontSize: '0.72rem', color: '#FFD166',
            textTransform: 'uppercase', letterSpacing: 1.5,
            fontWeight: 700, marginBottom: 14,
          }}>
            Final Standings
          </p>

          <div style={{ display: 'grid', gap: 10 }}>
            {scoreboard.map((team, rank) => {
              const rankStyle = RANK_STYLES[rank] ?? {
                label: `${rank + 1}th`, bg: 'rgba(255,255,255,0.02)',
                border: '#1a1a1a', color: '#555', medal: '',
              }
              const basePoints = team.total_points - team.bonusPoints
              return (
                <div
                  key={team.id}
                  style={{
                    background: rankStyle.bg,
                    border: `1px solid ${rankStyle.border}`,
                    borderRadius: 12,
                    padding: '16px 18px',
                  }}
                >
                  {/* Team header row */}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginBottom: 10,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: '1.2rem' }}>{rankStyle.medal}</span>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: team.color }} />
                      <div>
                        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>{team.name}</span>
                        {team.member_names?.length > 0 && (
                          <p style={{ fontSize: '0.72rem', color: '#555', marginTop: 2 }}>
                            {team.member_names.join(' · ')}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Points */}
                    <div style={{ textAlign: 'right' }}>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '1.4rem', fontWeight: 700,
                        color: rankStyle.color,
                      }}>
                        {team.total_points}
                      </span>
                      <span style={{ color: '#555', fontSize: '0.78rem', marginLeft: 4 }}>pts</span>
                      {team.bonusPoints > 0 && (
                        <p style={{
                          fontSize: '0.7rem', color: '#FFD166',
                          marginTop: 2, fontFamily: "'JetBrains Mono', monospace",
                        }}>
                          {basePoints} + {team.bonusPoints} bonus
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{
                    display: 'flex', gap: 16, fontSize: '0.75rem', color: '#555',
                    marginBottom: team.zoneBreakdown.length > 0 ? 10 : 0,
                  }}>
                    <span>
                      <span style={{ color: '#888' }}>
                        {team.zoneBreakdown.filter(z => z.status === 'claimed').length}
                      </span> zones claimed
                    </span>
                    <span>
                      <span style={{ color: '#888' }}>{team.challengesCompleted}</span> challenges
                    </span>
                    {team.bonusPoints > 0 && (
                      <span style={{ color: '#FFD166' }}>
                        +{team.bonusPoints} bonus
                      </span>
                    )}
                  </div>

                  {/* Zone breakdown pills */}
                  {team.zoneBreakdown.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {team.zoneBreakdown
                        .sort((a, b) => b.points - a.points)
                        .map((zs) => (
                          <span key={zs.zone_id} style={{
                            fontSize: '0.68rem', padding: '3px 8px', borderRadius: 4,
                            fontFamily: "'JetBrains Mono', monospace",
                            background: zs.status === 'claimed'
                              ? `${team.color}20` : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${zs.status === 'claimed'
                              ? team.color + '40' : '#1a1a1a'}`,
                            color: zs.status === 'claimed' ? team.color : '#444',
                            fontWeight: 600,
                          }}>
                            {zs.zone_id.replace('zone_district_', 'D')} · {zs.points}pt
                            {zs.status === 'claimed' ? ' ★' : ''}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ====== FINAL MAP ====== */}
        {activeZones.length > 0 && (
          <div className="results-section" style={{ animationDelay: '0.3s', marginBottom: 28 }}>
            <p style={{
              fontSize: '0.72rem', color: '#FFD166',
              textTransform: 'uppercase', letterSpacing: 1.5,
              fontWeight: 700, marginBottom: 14,
            }}>
              Final Zone Map
            </p>
            <div style={{
              height: 280, borderRadius: 12, overflow: 'hidden',
              border: '1px solid #1a1a1a',
            }}>
              <GameMap
                zones={activeZones}
                zoneOwnership={zoneOwnership.size > 0 ? zoneOwnership : undefined}
                closedZones={game.closed_zones ?? []}
                claimThreshold={claimThreshold}
              />
            </div>

            {/* Map legend */}
            {zoneOwnership.size > 0 && (
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 10,
                marginTop: 10, padding: '0 4px',
              }}>
                {Array.from(zoneOwnership.entries()).map(([zoneId, owner]) => (
                  <div key={zoneId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: 2,
                      background: owner.teamColor,
                    }} />
                    <span style={{ fontSize: '0.72rem', color: '#666' }}>
                      {zoneId.replace('zone_district_', 'D')} — {owner.teamName}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ====== BONUS BREAKDOWN ====== */}
        {game.bonuses_applied && Object.keys(bonusMap).length > 0 && (
          <div className="results-section" style={{ animationDelay: '0.4s', marginBottom: 28 }}>
            <p style={{
              fontSize: '0.72rem', color: '#FFD166',
              textTransform: 'uppercase', letterSpacing: 1.5,
              fontWeight: 700, marginBottom: 14,
            }}>
              Side Quests
            </p>
            <div style={{
              background: 'rgba(255,209,102,0.04)',
              border: '1px solid rgba(255,209,102,0.15)',
              borderRadius: 12, padding: '16px 18px',
            }}>
                {Object.entries(bonusMap).map(([teamId, pts], idx, arr) => {
                  const team = teams.find(t => t.id === teamId)
                  if (!team) return null
                  return (
                    <div key={teamId} style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingBottom: idx < arr.length - 1 ? 10 : 0,
                      marginBottom: idx < arr.length - 1 ? 10 : 0,
                      borderBottom: idx < arr.length - 1 ? '1px solid #111' : 'none',
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: team.color }} />
                      <span style={{ fontSize: '0.85rem', color: '#ccc', fontWeight: 600 }}>
                        {team.name}
                      </span>
                    </div>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      color: '#FFD166', fontWeight: 700, fontSize: '0.9rem',
                    }}>
                      +{pts}pt{pts !== 1 ? 's' : ''}
                    </span>
                  </div>
                )
              })}
              <p style={{ fontSize: '0.72rem', color: '#444', marginTop: 4 }}>
                Bonuses include: Most zones claimed (+5) · Most transit modes (+4) · Most challenges completed (+3)
              </p>
            </div>
          </div>
        )}

        {/* ====== FOOTER ACTIONS ====== */}
        <div className="results-section" style={{ animationDelay: '0.5s' }}>
          <button
            onClick={() => navigate('/')}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid #222',
              color: '#888',
              padding: '14px 24px', borderRadius: 10,
              fontSize: '0.9rem', fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Back to Home
          </button>
        </div>

      </div>
    </div>
  )
}
