// =============================================================================
// Zone Rush — Game Page
// 4-tab layout: Hand, Map, Chat, History
// Loads team data + challenge cards from Firestore
// =============================================================================

import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, onSnapshot, collection, query, where, getDocs,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'

// --------------- Types ---------------

interface GameData {
  id: string
  name: string
  status: string
  join_code: string
  zones: string[]
  started_at: any
  ends_at: any
  settings: {
    team_size: number
    duration_minutes: number
    hand_size: number
    discard_limit: number
    claim_threshold: number
    [key: string]: any
  }
}

interface TeamData {
  id: string
  name: string
  members: string[]
  member_names: string[]
  color: string
  total_points: number
  zones_claimed: number
  hand: string[]
  taxi_used: boolean
}

interface Challenge {
  id: string
  title: string
  description: string
  difficulty: string
  points: number
  time_estimate: string
  player_profile: string
  verification_type: string
  tier2: { description: string; bonus_points: number } | null
  phone_free_eligible: boolean
  is_time_based: boolean
  category: string
}

// --------------- Helpers ---------------

const DIFFICULTY_STYLES: Record<string, { bg: string; color: string; label: string; pts: number }> = {
  easy:   { bg: 'rgba(6,214,160,0.15)',  color: '#06D6A0', label: 'Easy',   pts: 1 },
  medium: { bg: 'rgba(255,209,102,0.15)', color: '#FFD166', label: 'Medium', pts: 3 },
  hard:   { bg: 'rgba(239,71,111,0.15)',  color: '#EF476F', label: 'Hard',   pts: 5 },
}

const PROFILE_STYLES: Record<string, { color: string; label: string }> = {
  adventurer: { color: '#F77F00', label: 'Adventurer' },
  academic:   { color: '#118AB2', label: 'Academic' },
  gamer:      { color: '#9B5DE5', label: 'Gamer' },
  ride_along: { color: '#EF476F', label: 'Ride Along' },
}

const VERIFICATION_ICONS: Record<string, string> = {
  photo: '📷',
  video: '🎥',
  audio: '🎙️',
  gps_checkin: '📍',
}

const TIME_LABELS: Record<string, string> = {
  short: '~5 min',
  medium: '~15 min',
  long: '~30 min',
}

// --------------- Component ---------------

export default function GamePage() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const user = auth.currentUser

  const [activeTab, setActiveTab] = useState<'hand' | 'map' | 'chat' | 'history'>('hand')
  const [game, setGame] = useState<GameData | null>(null)
  const [myTeam, setMyTeam] = useState<TeamData | null>(null)
  const [challenges, setChallenges] = useState<Challenge[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCard, setSelectedCard] = useState<number | null>(null)

  // Listen to game document
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (snap.exists()) {
        setGame(snap.data() as GameData)
      }
    })
    return () => unsub()
  }, [gameId])

  // Find player's team and listen for updates
  useEffect(() => {
    if (!gameId || !user) return

    const unsub = onSnapshot(
      collection(db, 'games', gameId, 'teams'),
      async (snapshot) => {
        let foundTeam: TeamData | null = null
        snapshot.forEach((d) => {
          const team = { id: d.id, ...d.data() } as TeamData
          if (team.members.includes(user.uid)) {
            foundTeam = team
          }
        })

        setMyTeam(foundTeam)

        // Fetch challenge details for the hand
        if (foundTeam && foundTeam.hand.length > 0) {
          const challengeDocs: Challenge[] = []
          for (const chId of foundTeam.hand) {
            const chDoc = await getDoc(doc(db, 'challenges', chId))
            if (chDoc.exists()) {
              challengeDocs.push({ id: chDoc.id, ...chDoc.data() } as Challenge)
            }
          }
          setChallenges(challengeDocs)
        }

        setLoading(false)
      }
    )

    return () => unsub()
  }, [gameId, user])

  // Timer
  const [timeLeft, setTimeLeft] = useState('')
  useEffect(() => {
    if (!game?.ends_at) return
    const interval = setInterval(() => {
      const end = game.ends_at.toDate ? game.ends_at.toDate() : new Date(game.ends_at)
      const diff = end.getTime() - Date.now()
      if (diff <= 0) {
        setTimeLeft('GAME OVER')
        clearInterval(interval)
        return
      }
      const hrs = Math.floor(diff / 3600000)
      const mins = Math.floor((diff % 3600000) / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      setTimeLeft(hrs > 0 ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${mins}:${String(secs).padStart(2, '0')}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [game?.ends_at])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0a', color: '#555',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        Loading game...
      </div>
    )
  }

  if (!myTeam) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0a', color: '#EF476F',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', fontFamily: "'DM Sans', sans-serif", gap: 16,
      }}>
        <p>You're not on a team in this game</p>
        <button onClick={() => navigate('/')} style={{
          background: 'none', border: '1px solid #333', color: '#888',
          padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
        }}>
          Go Home
        </button>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        padding: '12px 20px',
        borderBottom: '1px solid #1a1a1a',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 10, height: 10, borderRadius: 3,
            background: myTeam.color,
          }} />
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{myTeam.name}</span>
        </div>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.85rem',
          color: timeLeft === 'GAME OVER' ? '#EF476F' : '#FFD166',
          fontWeight: 600,
        }}>
          {timeLeft}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px 100px' }}>
        {/* HAND TAB */}
        {activeTab === 'hand' && (
          <div>
            <p style={{
              fontSize: '0.75rem', color: '#555', textTransform: 'uppercase',
              letterSpacing: 1, marginBottom: 16, fontWeight: 600,
            }}>
              Your Challenges ({challenges.length} cards)
            </p>

            <div style={{ display: 'grid', gap: 12 }}>
              {challenges.map((ch, index) => {
                const diff = DIFFICULTY_STYLES[ch.difficulty] || DIFFICULTY_STYLES.medium
                const profile = PROFILE_STYLES[ch.player_profile] || { color: '#888', label: ch.player_profile }
                const isExpanded = selectedCard === index

                return (
                  <div
                    key={ch.id}
                    onClick={() => setSelectedCard(isExpanded ? null : index)}
                    style={{
                      background: isExpanded ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isExpanded ? diff.color + '40' : '#1a1a1a'}`,
                      borderRadius: 12,
                      padding: '16px 18px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {/* Card header — difficulty + points + verification */}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 10,
                    }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px',
                          borderRadius: 20, background: diff.bg, color: diff.color,
                        }}>
                          {diff.label}
                        </span>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px',
                          borderRadius: 20, background: `${profile.color}15`,
                          color: profile.color,
                        }}>
                          {profile.label}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: '0.9rem' }}>
                          {VERIFICATION_ICONS[ch.verification_type] || '📷'}
                        </span>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.85rem', fontWeight: 700, color: diff.color,
                        }}>
                          {diff.pts}pt{diff.pts !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>

                    {/* Challenge description */}
                    <p style={{
                      color: '#e0e0e0', fontSize: '0.92rem', lineHeight: 1.6,
                      marginBottom: isExpanded ? 12 : 0,
                    }}>
                      {ch.description}
                    </p>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div style={{ marginTop: 4 }}>
                        {/* Time estimate */}
                        <div style={{
                          display: 'flex', gap: 16, marginBottom: 10,
                          fontSize: '0.78rem', color: '#666',
                        }}>
                          <span>Time: {TIME_LABELS[ch.time_estimate] || ch.time_estimate}</span>
                          {ch.is_time_based && (
                            <span style={{ color: '#FFD166' }}>Timed challenge</span>
                          )}
                          {ch.phone_free_eligible && (
                            <span style={{ color: '#06D6A0' }}>Phone-free eligible</span>
                          )}
                        </div>

                        {/* Tier 2 */}
                        {ch.tier2 && (
                          <div style={{
                            background: 'rgba(155,93,229,0.08)',
                            border: '1px solid rgba(155,93,229,0.2)',
                            borderRadius: 8, padding: '10px 14px', marginBottom: 10,
                          }}>
                            <p style={{
                              fontSize: '0.7rem', color: '#9B5DE5', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4,
                            }}>
                              Tier 2 Bonus (+{ch.tier2.bonus_points}pt)
                            </p>
                            <p style={{ color: '#aaa', fontSize: '0.85rem', lineHeight: 1.5 }}>
                              {ch.tier2.description}
                            </p>
                          </div>
                        )}

                        {/* Submit button (placeholder for now) */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            // TODO: Navigate to submission screen
                            alert('Submission screen coming next!')
                          }}
                          style={{
                            width: '100%',
                            background: `${diff.color}20`,
                            border: `1px solid ${diff.color}40`,
                            color: diff.color,
                            padding: '12px 20px',
                            borderRadius: 8,
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Submit Proof
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {challenges.length === 0 && (
              <p style={{ color: '#555', textAlign: 'center', marginTop: 40 }}>
                No challenges dealt yet. Waiting for GM to start the game.
              </p>
            )}
          </div>
        )}

        {/* MAP TAB — placeholder */}
        {activeTab === 'map' && (
          <div style={{ textAlign: 'center', marginTop: 60, color: '#555' }}>
            <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>🗺️</p>
            <p>Zone map coming soon</p>
          </div>
        )}

        {/* CHAT TAB — placeholder */}
        {activeTab === 'chat' && (
          <div style={{ textAlign: 'center', marginTop: 60, color: '#555' }}>
            <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>💬</p>
            <p>Team chat coming soon</p>
          </div>
        )}

        {/* HISTORY TAB — placeholder */}
        {activeTab === 'history' && (
          <div style={{ textAlign: 'center', marginTop: 60, color: '#555' }}>
            <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>📋</p>
            <p>Challenge history coming soon</p>
          </div>
        )}
      </div>

      {/* Bottom tab bar */}
      <div style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: '#0d0d0d',
        borderTop: '1px solid #1a1a1a',
        display: 'flex',
        justifyContent: 'space-around',
        padding: '10px 0 24px',
        zIndex: 100,
      }}>
        {[
          { id: 'hand' as const, icon: '🃏', label: 'Hand' },
          { id: 'map' as const, icon: '🗺️', label: 'Map' },
          { id: 'chat' as const, icon: '💬', label: 'Chat' },
          { id: 'history' as const, icon: '📋', label: 'History' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              color: activeTab === tab.id ? '#FFD166' : '#555',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: '0.72rem',
              fontWeight: activeTab === tab.id ? 700 : 400,
              padding: '4px 16px',
            }}
          >
            <span style={{ fontSize: '1.2rem' }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}