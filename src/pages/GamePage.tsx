// =============================================================================
// Zone Rush — Game Page
// Player's 4-tab view: Hand, Map, Chat, History
//
// CHANGES:
// - UPDATED: zoneOwnership now passes points + claimed to GameMap for gradient
// - UPDATED: GameMap receives closedZones and claimThreshold props
// =============================================================================

import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, onSnapshot, collection,
  updateDoc, getDocs, query, where,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import SubmitProof from '../components/SubmitProof'
import GameMap from '../components/GameMap'
import type { ZoneOwner } from '../components/GameMap'
import HistoryTab from './HistoryTab'
import { checkZoneLockouts, checkZoneClosures } from '../lib/scoring'
import {
  sendTeamMessage,
  subscribeToPlayerMessages,
  markMessagesRead,
} from '../lib/chat'

// --------------- Types ---------------

interface GameData {
  id: string
  name: string
  status: string
  join_code: string
  zones: string[]
  started_at: any
  ends_at: any
  closed_zones?: string[]
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
  discards_used: number
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

interface SubmissionStatus {
  challenge_id: string
  status: 'pending' | 'approved' | 'rejected'
  gm_notes?: string
  submitted_at: any
}

interface ZoneScoreData {
  team_id: string
  zone_id: string
  points: number
  status: 'none' | 'claimed'
  challenges_completed: string[]
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

const STATUS_BADGE: Record<string, { bg: string; border: string; color: string; label: string; icon: string }> = {
  pending:  { bg: 'rgba(255,209,102,0.10)', border: 'rgba(255,209,102,0.3)', color: '#FFD166', label: 'Pending Review', icon: '⏳' },
  approved: { bg: 'rgba(6,214,160,0.10)',   border: 'rgba(6,214,160,0.3)',   color: '#06D6A0', label: 'Approved',       icon: '✅' },
  rejected: { bg: 'rgba(239,71,111,0.10)',  border: 'rgba(239,71,111,0.3)',  color: '#EF476F', label: 'Rejected',       icon: '❌' },
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

  const [discardMode, setDiscardMode] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [submittingChallenge, setSubmittingChallenge] = useState<number | null>(null)

  const [submissions, setSubmissions] = useState<Map<string, SubmissionStatus>>(new Map())
  const [allTeams, setAllTeams] = useState<TeamData[]>([])
  const [zoneScores, setZoneScores] = useState<ZoneScoreData[]>([])
  const [localZones, setLocalZones] = useState<any[]>([])

  const [chatMessages, setChatMessages] = useState<any[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const chatBottomRef = useRef<HTMLDivElement>(null)

  const [latestBroadcast, setLatestBroadcast] = useState<string | null>(null)
  const [broadcastDismissed, setBroadcastDismissed] = useState<string | null>(null)

  // Load zones from Firestore
  useEffect(() => {
    async function loadZones() {
      const snapshot = await getDocs(collection(db, 'zones'))
      const loaded = snapshot.docs.map((d) => {
        const data = d.data()
        return {
          ...data,
          boundary: typeof data.boundary === 'string' ? JSON.parse(data.boundary) : data.boundary,
        }
      })
      setLocalZones(loaded)
    }
    loadZones()
  }, [])

  // Request GPS permission on mount
  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      () => {},
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          alert(
            '📍 Zone Rush needs your location to verify challenge submissions and show your position on the map. Please enable location access in your browser settings.'
          )
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }, [])

  // Listen to game document
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (snap.exists()) setGame(snap.data() as GameData)
    })
    return () => unsub()
  }, [gameId])

  // Zone lockout timer — checks every 60 seconds while game is active
  useEffect(() => {
    if (game?.status !== 'active') return
    const interval = setInterval(() => {
      checkZoneLockouts(gameId!)
      checkZoneClosures(gameId!)
    }, 60000)
    return () => clearInterval(interval)
  }, [game?.status, gameId])

  // Find player's team and listen for updates; also captures allTeams
  useEffect(() => {
    if (!gameId || !user) return

    const unsub = onSnapshot(
      collection(db, 'games', gameId, 'teams'),
      async (snapshot) => {
        let foundTeam: TeamData | null = null
        const teamsArr: TeamData[] = []

        snapshot.forEach((d) => {
          const team = { id: d.id, ...d.data() } as TeamData
          teamsArr.push(team)
          if (team.members.includes(user.uid)) foundTeam = team
        })

        setMyTeam(foundTeam)
        setAllTeams(teamsArr)

        if (foundTeam) {
          const teamHand = (foundTeam as TeamData).hand
          if (teamHand && teamHand.length > 0) {
            const challengeDocs: Challenge[] = []
            for (const chId of teamHand) {
              const chDoc = await getDoc(doc(db, 'challenges', chId))
              if (chDoc.exists()) {
                challengeDocs.push({ id: chDoc.id, ...chDoc.data() } as Challenge)
              }
            }
            setChallenges(challengeDocs)
          }
        }

        setLoading(false)
      }
    )

    return () => unsub()
  }, [gameId, user])

  // Listen to zone_scores for real-time zone ownership
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

  // Listen to submissions for this team to show status badges
  useEffect(() => {
    if (!gameId || !myTeam) return

    const q = query(
      collection(db, 'submissions'),
      where('game_id', '==', gameId),
      where('team_id', '==', myTeam.id),
    )

    const unsub = onSnapshot(q, (snapshot) => {
      const statusMap = new Map<string, SubmissionStatus>()
      snapshot.forEach((d) => {
        const data = d.data()
        const existing = statusMap.get(data.challenge_id)
        if (
          !existing ||
          data.status === 'approved' ||
          (data.status === 'pending' && existing.status === 'rejected')
        ) {
          statusMap.set(data.challenge_id, {
            challenge_id: data.challenge_id,
            status: data.status,
            gm_notes: data.gm_notes,
            submitted_at: data.submitted_at,
          })
        }
      })
      setSubmissions(statusMap)
    })

    return () => unsub()
  }, [gameId, myTeam?.id])

  // Subscribe to chat messages for this team
useEffect(() => {
  if (!gameId || !myTeam) return
  const unsub = subscribeToPlayerMessages(gameId, myTeam.id, (msgs) => {
    setChatMessages(msgs)

    // Track latest unread broadcast for cross-tab banner
    const latestUnreadBroadcast = msgs
      .filter(
        (m: any) =>
          m.channel_type === 'gm_broadcast' &&
          !m.read_by?.includes(user?.uid)
      )
      .sort((a: any, b: any) =>
        (b.created_at?.toMillis?.() ?? 0) - (a.created_at?.toMillis?.() ?? 0)
      )[0]

    if (latestUnreadBroadcast) {
      setLatestBroadcast(latestUnreadBroadcast.text)
      setBroadcastDismissed(null) // new broadcast resets dismiss
    }

    setTimeout(() => {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, 50)
  })
  return () => unsub()
}, [gameId, myTeam?.id])

  // Mark messages as read when chat tab is active
  useEffect(() => {
    if (activeTab === 'chat' && gameId && user && myTeam) {
      markMessagesRead(gameId, user.uid, myTeam.id)
    }
  }, [activeTab, gameId, user?.uid, myTeam?.id])

  // Chat send handler
  const handleSendMessage = async () => {
    if (!chatInput.trim() || !gameId || !user || !myTeam || chatSending) return
    setChatSending(true)
    try {
      await sendTeamMessage(
        gameId,
        user.uid,
        user.displayName || 'Player',
        myTeam.id,
        chatInput.trim()
      )
      setChatInput('')
    } catch (err) {
      console.error('Failed to send message:', err)
      alert('Failed to send. Try again.')
    } finally {
      setChatSending(false)
    }
  }

  // Discard handler
  const handleDiscard = async (cardIndex: number) => {
    if (!gameId || !myTeam || !game || discarding) return

    const discardLimit = game.settings.discard_limit ?? 1
    const discardsUsed = myTeam.discards_used ?? 0

    if (discardsUsed >= discardLimit) {
      alert(`You've already used your ${discardLimit === 1 ? 'discard' : `${discardLimit} discards`}.`)
      return
    }

    const challengeToRemove = challenges[cardIndex]
    if (!challengeToRemove) return

    setDiscarding(true)

    try {
      const challengeSnap = await getDocs(collection(db, 'challenges'))
      const allChallenges: string[] = []
      challengeSnap.forEach((d) => {
        const data = d.data()
        if (data.is_active !== false && !myTeam.hand.includes(d.id)) {
          allChallenges.push(d.id)
        }
      })

      if (allChallenges.length === 0) {
        alert('No replacement challenges available.')
        setDiscarding(false)
        return
      }

      const replacement = allChallenges[Math.floor(Math.random() * allChallenges.length)]
      const newHand = [...myTeam.hand]
      const handIndex = newHand.indexOf(challengeToRemove.id)
      if (handIndex !== -1) newHand[handIndex] = replacement

      const teamRef = doc(db, 'games', gameId, 'teams', myTeam.id)
      await updateDoc(teamRef, {
        hand: newHand,
        discards_used: discardsUsed + 1,
      })

      setDiscardMode(false)
      setSelectedCard(null)
    } catch (err) {
      console.error('Discard failed:', err)
      alert('Something went wrong. Try again.')
    } finally {
      setDiscarding(false)
    }
  }

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
        // Auto-end the game when timer expires (idempotent — safe if multiple clients fire)
        if (game?.status === 'active' && gameId) {
          updateDoc(doc(db, 'games', gameId), { status: 'ended' }).catch(() => {})
        }
        return
      }
      const hrs = Math.floor(diff / 3600000)
      const mins = Math.floor((diff % 3600000) / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      setTimeLeft(hrs > 0
        ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${mins}:${String(secs).padStart(2, '0')}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [game?.ends_at])

  // Computed values
  const discardLimit = game?.settings.discard_limit ?? 1
  const discardsUsed = myTeam?.discards_used ?? 0
  const canDiscard = discardsUsed < discardLimit && game?.status === 'active'

  const pendingCount = Array.from(submissions.values()).filter(s => s.status === 'pending').length
  const approvedCount = Array.from(submissions.values()).filter(s => s.status === 'approved').length

  const activeZones = localZones.filter((z: any) => game?.zones?.includes(z.id))

  // ---- Compute zone ownership for GameMap ----
  // For each zone, find the team with the most points.
  // Pass their color, name, total points, and whether they've claimed it.
  const claimThreshold = game?.settings.claim_threshold ?? 6
  const zoneOwnership = new Map<string, ZoneOwner>()

  for (const zone of (game?.zones ?? [])) {
    const scoresForZone = zoneScores.filter(zs => zs.zone_id === zone)
    if (scoresForZone.length === 0) continue

    // Leading team = highest points in this zone
    const leading = scoresForZone.reduce((best, curr) =>
      curr.points > best.points ? curr : best
    )

    if (leading.points === 0) continue

    const team = allTeams.find(t => t.id === leading.team_id)
    if (!team) continue

    zoneOwnership.set(zone, {
      teamColor: team.color,
      teamName: team.name,
      points: leading.points,
      claimed: leading.points >= claimThreshold,
    })
  }

  // ---- Render ----

  if (loading) {
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
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 12px',
          }} />
          <p>Loading game...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
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
        background: '#0d0d0d',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: myTeam.color }} />
            <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{myTeam.name}</span>
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.85rem',
            color: timeLeft === 'GAME OVER' ? '#EF476F' : '#FFD166',
            fontWeight: 600,
          }}>
            {timeLeft || (game?.status === 'active' ? '—' : game?.status?.toUpperCase())}
          </div>
        </div>


        {submissions.size > 0 && (
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: '0.72rem', color: '#555' }}>
            {approvedCount > 0 && <span style={{ color: '#06D6A0' }}>✅ {approvedCount} approved</span>}
            {pendingCount > 0 && <span style={{ color: '#FFD166' }}>⏳ {pendingCount} pending</span>}
            {zoneOwnership.size > 0 && (
              <span style={{ color: '#9B5DE5' }}>
                🗺️ {Array.from(zoneOwnership.values()).filter(z => z.claimed).length} zone{Array.from(zoneOwnership.values()).filter(z => z.claimed).length !== 1 ? 's' : ''} claimed
              </span>
            )}
          </div>
        )}
      </div>

{/* GM broadcast banner — shows on all tabs except chat */}
        {latestBroadcast && broadcastDismissed !== latestBroadcast && activeTab !== 'chat' && (
          <div style={{
            marginTop: 10,
            background: 'rgba(255,209,102,0.10)',
            border: '1px solid rgba(255,209,102,0.3)',
            borderRadius: 8,
            padding: '8px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: '0.85rem', flexShrink: 0 }}>📢</span>
              <p style={{
                color: '#FFD166', fontSize: '0.78rem', fontWeight: 600,
                lineHeight: 1.4, margin: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {latestBroadcast}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                onClick={() => setActiveTab('chat')}
                style={{
                  background: 'rgba(255,209,102,0.15)', border: '1px solid rgba(255,209,102,0.3)',
                  color: '#FFD166', padding: '4px 10px', borderRadius: 6,
                  fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                View
              </button>
              <button
                onClick={() => setBroadcastDismissed(latestBroadcast)}
                style={{
                  background: 'none', border: 'none', color: '#555',
                  fontSize: '0.9rem', cursor: 'pointer', padding: '4px 6px', lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
          </div>
        )}

      {/* Main content */}
      <div style={{
        flex: 1, overflow: 'auto',
        padding: activeTab === 'map' || activeTab === 'history' ? '0' : '16px 20px 100px',
      }}>

        {/* ==================== HAND TAB ==================== */}
        {activeTab === 'hand' && (
          <div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: 16,
            }}>
              <p style={{
                fontSize: '0.75rem', color: '#555', textTransform: 'uppercase',
                letterSpacing: 1, fontWeight: 600, margin: 0,
              }}>
                Your Challenges ({challenges.length})
              </p>

              {canDiscard ? (
                <button
                  onClick={() => { setDiscardMode(!discardMode); setSelectedCard(null) }}
                  style={{
                    background: discardMode ? 'rgba(239,71,111,0.15)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${discardMode ? '#EF476F40' : '#222'}`,
                    color: discardMode ? '#EF476F' : '#888',
                    padding: '6px 14px',
                    borderRadius: 8,
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'all 0.15s',
                  }}
                >
                  {discardMode ? '✕ Cancel' : `🔄 Discard (${discardLimit - discardsUsed} left)`}
                </button>
              ) : (
                <span style={{ fontSize: '0.72rem', color: '#333', fontStyle: 'italic' }}>
                  No discards left
                </span>
              )}
            </div>

            {discardMode && (
              <div style={{
                background: 'rgba(239,71,111,0.06)',
                border: '1px solid rgba(239,71,111,0.15)',
                borderRadius: 8, padding: '10px 14px', marginBottom: 12,
                fontSize: '0.82rem', color: '#EF476F',
              }}>
                Tap the card you want to discard. You'll get a random replacement.
              </div>
            )}

            <style>{`
              @keyframes pendingPulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
              }
            `}</style>

            <div style={{ display: 'grid', gap: 12 }}>
              {challenges.map((ch, index) => {
                const diff = DIFFICULTY_STYLES[ch.difficulty] || DIFFICULTY_STYLES.medium
                const profile = PROFILE_STYLES[ch.player_profile] || { color: '#888', label: ch.player_profile }
                const isExpanded = selectedCard === index && !discardMode
                const sub = submissions.get(ch.id)
                const badge = sub ? STATUS_BADGE[sub.status] : null
                const isCompleted = sub?.status === 'approved'

                return (
                  <div
                    key={ch.id}
                    onClick={() => {
                      if (discardMode) return
                      setSelectedCard(isExpanded ? null : index)
                    }}
                    style={{
                      background: discardMode
                        ? 'rgba(239,71,111,0.03)'
                        : isCompleted ? 'rgba(6,214,160,0.03)'
                        : isExpanded ? 'rgba(255,255,255,0.04)'
                        : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${
                        discardMode ? 'rgba(239,71,111,0.2)'
                        : isCompleted ? 'rgba(6,214,160,0.2)'
                        : isExpanded ? diff.color + '40'
                        : '#1a1a1a'
                      }`,
                      borderRadius: 12,
                      padding: '16px 18px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      opacity: isCompleted && !isExpanded ? 0.65 : 1,
                    }}
                  >
                    {/* Card header */}
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 10,
                    }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px',
                          borderRadius: 20, background: diff.bg, color: diff.color,
                        }}>
                          {diff.label}
                        </span>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px',
                          borderRadius: 20, background: `${profile.color}15`, color: profile.color,
                        }}>
                          {profile.label}
                        </span>
                        {badge && (
                          <span style={{
                            fontSize: '0.68rem', fontWeight: 700, padding: '3px 10px',
                            borderRadius: 20, background: badge.bg,
                            border: `1px solid ${badge.border}`, color: badge.color,
                            display: 'flex', alignItems: 'center', gap: 4,
                            animation: sub?.status === 'pending' ? 'pendingPulse 2s ease-in-out infinite' : 'none',
                          }}>
                            {badge.icon} {badge.label}
                          </span>
                        )}
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
                      color: isCompleted ? '#888' : '#e0e0e0',
                      fontSize: '0.92rem', lineHeight: 1.6,
                      marginBottom: (isExpanded || discardMode) ? 12 : 0,
                      textDecoration: isCompleted ? 'line-through' : 'none',
                    }}>
                      {ch.description}
                    </p>

                    {/* GM rejection notes */}
                    {sub?.status === 'rejected' && sub.gm_notes && (
                      <div style={{
                        background: 'rgba(239,71,111,0.06)',
                        border: '1px solid rgba(239,71,111,0.15)',
                        borderRadius: 8, padding: '8px 12px', marginBottom: 10,
                      }}>
                        <p style={{
                          fontSize: '0.7rem', color: '#EF476F', fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4,
                        }}>
                          GM Feedback
                        </p>
                        <p style={{ color: '#ccc', fontSize: '0.82rem', lineHeight: 1.5 }}>
                          {sub.gm_notes}
                        </p>
                      </div>
                    )}

                    {/* Discard button */}
                    {discardMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (window.confirm(`Discard this challenge?\n\n"${ch.description}"\n\nYou'll get a random replacement.`)) {
                            handleDiscard(index)
                          }
                        }}
                        disabled={discarding}
                        style={{
                          width: '100%',
                          background: 'rgba(239,71,111,0.12)',
                          border: '1px solid rgba(239,71,111,0.3)',
                          color: '#EF476F',
                          padding: '10px 16px',
                          borderRadius: 8,
                          fontSize: '0.82rem',
                          fontWeight: 700,
                          cursor: discarding ? 'wait' : 'pointer',
                          fontFamily: 'inherit',
                          opacity: discarding ? 0.5 : 1,
                        }}
                      >
                        {discarding ? 'Swapping...' : '🗑 Discard This Card'}
                      </button>
                    )}

                    {/* Expanded details */}
                    {isExpanded && (
                      <div style={{ marginTop: 4 }}>
                        <div style={{
                          display: 'flex', gap: 16, marginBottom: 10,
                          fontSize: '0.78rem', color: '#666', flexWrap: 'wrap',
                        }}>
                          <span>Time: {TIME_LABELS[ch.time_estimate] || ch.time_estimate}</span>
                          {ch.is_time_based && <span style={{ color: '#FFD166' }}>⏱ Timed challenge</span>}
                          {ch.phone_free_eligible && <span style={{ color: '#06D6A0' }}>📵 Phone-free eligible</span>}
                        </div>

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

                        {sub?.status === 'approved' ? (
                          <div style={{
                            width: '100%', background: 'rgba(6,214,160,0.08)',
                            border: '1px solid rgba(6,214,160,0.2)',
                            padding: '12px 20px', borderRadius: 8,
                            textAlign: 'center', color: '#06D6A0',
                            fontSize: '0.88rem', fontWeight: 600,
                          }}>
                            ✅ Challenge Complete — {diff.pts} point{diff.pts !== 1 ? 's' : ''} earned
                          </div>
                        ) : sub?.status === 'pending' ? (
                          <div style={{
                            width: '100%', background: 'rgba(255,209,102,0.08)',
                            border: '1px solid rgba(255,209,102,0.2)',
                            padding: '12px 20px', borderRadius: 8,
                            textAlign: 'center', color: '#FFD166',
                            fontSize: '0.88rem', fontWeight: 600,
                            animation: 'pendingPulse 2s ease-in-out infinite',
                          }}>
                            ⏳ Waiting for GM review...
                          </div>
                        ) : game?.status === 'ended' ? (
                          <div style={{
                            width: '100%', background: 'rgba(255,255,255,0.03)',
                            border: '1px solid #222',
                            padding: '12px 20px', borderRadius: 8,
                            textAlign: 'center', color: '#555',
                            fontSize: '0.88rem',
                          }}>
                            🏁 Game Over — submissions closed
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setSubmittingChallenge(index)
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
                            {sub?.status === 'rejected' ? '🔄 Resubmit Proof' : '📸 Submit Proof'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {challenges.length === 0 && (
              <div style={{ textAlign: 'center', marginTop: 60, color: '#555' }}>
                <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>🃏</p>
                <p>No challenges dealt yet.</p>
                <p style={{ fontSize: '0.82rem', color: '#333', marginTop: 4 }}>
                  Waiting for GM to start the game.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ==================== MAP TAB ==================== */}
        {activeTab === 'map' && (
          <div style={{ position: 'relative', width: '100%', height: 'calc(100vh - 130px)' }}>
            {activeZones.length > 0 ? (
              <GameMap
                zones={activeZones}
                zoneOwnership={zoneOwnership.size > 0 ? zoneOwnership : undefined}
                closedZones={game?.closed_zones ?? []}
                claimThreshold={claimThreshold}
              />
            ) : (
              <div style={{ textAlign: 'center', marginTop: 60, color: '#555', padding: '0 20px' }}>
                <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>🗺️</p>
                <p>No zones loaded for this game.</p>
              </div>
            )}

            {/* Zone legend overlay */}
            {zoneOwnership.size > 0 && (
              <div style={{
                position: 'absolute', bottom: 20, left: 12,
                background: 'rgba(10,10,10,0.85)',
                backdropFilter: 'blur(8px)',
                border: '1px solid #222',
                borderRadius: 10,
                padding: '10px 14px',
                zIndex: 10,
              }}>
                <p style={{
                  fontSize: '0.65rem', color: '#666', textTransform: 'uppercase',
                  letterSpacing: 1, fontWeight: 700, marginBottom: 6,
                }}>
                  Zone Control
                </p>
                {Array.from(zoneOwnership.entries()).map(([zoneId, owner]) => (
                  <div key={zoneId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: 2,
                      background: owner.teamColor,
                      opacity: owner.claimed ? 1 : 0.4,
                    }} />
                    <span style={{ fontSize: '0.72rem', color: '#aaa' }}>
                      {zoneId.replace('zone_district_', 'D')} — {owner.teamName}
                      {!owner.claimed && ' (contesting)'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ==================== CHAT TAB ==================== */}
        {activeTab === 'chat' && (
          <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)' }}>
            <div style={{
              flex: 1, overflowY: 'auto', padding: '16px 20px',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              {chatMessages.length === 0 ? (
                <div style={{ textAlign: 'center', marginTop: 60, color: '#555' }}>
                  <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>💬</p>
                  <p style={{ fontWeight: 600, color: '#666' }}>No messages yet</p>
                  <p style={{ fontSize: '0.82rem', color: '#444', marginTop: 6, lineHeight: 1.6 }}>
                    Message the GM with questions or disputes.
                  </p>
                </div>
              ) : (
                chatMessages.map((msg: any) => {
                  const isFromGM = msg.channel_type === 'gm_to_team' || msg.channel_type === 'gm_broadcast'
                  const isBroadcast = msg.channel_type === 'gm_broadcast'

                  return (
                    <div key={msg.id} style={{
                      display: 'flex', flexDirection: 'column',
                      alignItems: isFromGM ? 'flex-start' : 'flex-end',
                    }}>
                      <p style={{
                        fontSize: '0.68rem', color: '#444', marginBottom: 3,
                        paddingLeft: isFromGM ? 4 : 0, paddingRight: isFromGM ? 0 : 4,
                      }}>
                        {isBroadcast ? '📢 GM → All Teams' : isFromGM ? '🎮 GM' : msg.from_name || 'You'}
                      </p>
                      <div style={{
                        maxWidth: '80%',
                        background: isBroadcast
                          ? 'rgba(255,209,102,0.1)'
                          : isFromGM ? 'rgba(255,255,255,0.05)'
                          : `${myTeam.color}18`,
                        border: `1px solid ${
                          isBroadcast ? 'rgba(255,209,102,0.25)'
                          : isFromGM ? '#222'
                          : myTeam.color + '35'
                        }`,
                        borderRadius: isFromGM ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
                        padding: '10px 14px',
                      }}>
                        <p style={{
                          color: isBroadcast ? '#FFD166' : '#e0e0e0',
                          fontSize: '0.88rem', lineHeight: 1.55, margin: 0,
                        }}>
                          {msg.text}
                        </p>
                      </div>
                      <p style={{
                        fontSize: '0.65rem', color: '#333', marginTop: 3,
                        paddingLeft: isFromGM ? 4 : 0, paddingRight: isFromGM ? 0 : 4,
                      }}>
                        {msg.created_at?.toDate
                          ? msg.created_at.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                          : ''}
                      </p>
                    </div>
                  )
                })
              )}
              <div ref={chatBottomRef} />
            </div>

            <div style={{
              padding: '12px 16px 100px', borderTop: '1px solid #1a1a1a',
              background: '#0d0d0d', display: 'flex', gap: 10, alignItems: 'flex-end',
            }}>
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendMessage()
                  }
                }}
                placeholder="Message the GM..."
                rows={1}
                style={{
                  flex: 1, background: '#141414', border: '1px solid #222',
                  borderRadius: 10, padding: '10px 14px', color: '#fff',
                  fontSize: '0.88rem', fontFamily: 'inherit', resize: 'none',
                  outline: 'none', lineHeight: 1.5,
                }}
              />
              <button
                onClick={handleSendMessage}
                disabled={!chatInput.trim() || chatSending}
                style={{
                  background: chatInput.trim() ? myTeam.color : '#1a1a1a',
                  border: 'none', borderRadius: 10, width: 42, height: 42,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: chatInput.trim() ? 'pointer' : 'default',
                  fontSize: '1rem', flexShrink: 0,
                  transition: 'background 0.15s',
                  opacity: chatSending ? 0.5 : 1,
                }}
              >
                {chatSending ? '⏳' : '↑'}
              </button>
            </div>
          </div>
        )}

        {/* ==================== HISTORY TAB ==================== */}
        {activeTab === 'history' && (
          <HistoryTab
            gameId={gameId!}
            teamId={myTeam.id}
            totalPoints={myTeam.total_points}
          />
        )}
      </div>

      {/* Submission overlay */}
      {submittingChallenge !== null && challenges[submittingChallenge] && gameId && myTeam && (
        <SubmitProof
          gameId={gameId}
          teamId={myTeam.id}
          challenge={challenges[submittingChallenge]}
          closedZones={game?.closed_zones ?? []}
          onClose={() => setSubmittingChallenge(null)}
          onSubmitted={() => {}}
        />
      )}

      {/* Bottom tab bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: '#0d0d0d', borderTop: '1px solid #1a1a1a',
        display: 'flex', justifyContent: 'space-around',
        padding: '10px 0 24px', zIndex: 100,
      }}>
        {([
          { id: 'hand' as const, icon: '🃏', label: 'Hand' },
          { id: 'map' as const, icon: '🗺️', label: 'Map' },
          { id: 'chat' as const, icon: '💬', label: 'Chat' },
          { id: 'history' as const, icon: '📋', label: 'History' },
        ]).map((tab) => {
          const unreadChatCount = chatMessages.filter(
            (m: any) => (m.channel_type === 'gm_to_team' || m.channel_type === 'gm_broadcast') && !m.read_by?.includes(user?.uid)
          ).length
          const showDot =
            (tab.id === 'history' && pendingCount > 0 && activeTab !== 'history') ||
            (tab.id === 'chat' && unreadChatCount > 0 && activeTab !== 'chat')

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: 'none', border: 'none',
                color: activeTab === tab.id ? '#FFD166' : '#555',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 4, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: '0.72rem',
                fontWeight: activeTab === tab.id ? 700 : 400,
                padding: '4px 16px', position: 'relative',
              }}
            >
              <span style={{ fontSize: '1.2rem', position: 'relative' }}>
                {tab.icon}
                {showDot && (
                  <span style={{
                    position: 'absolute', top: -2, right: -6,
                    width: 8, height: 8, borderRadius: '50%',
                    background: '#FFD166',
                  }} />
                )}
              </span>
              {tab.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}