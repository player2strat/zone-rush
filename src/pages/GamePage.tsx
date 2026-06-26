// =============================================================================
// Zone Rush — Game Page
// Player's 5-tab view: Home, Hand, Map, Chat, History
//
// CHANGES (sequential cards):
// - Hand tab now routes sequential ("Choose Your Own Adventure") cards to the
//   dedicated <SequentialCard/> component (when NOT in discard mode). Standard
//   cards render exactly as before. In discard mode, sequential cards fall
//   through to the standard render so the existing tap-to-discard UI applies.
//
// CHANGES (Sprint 2 — chat):
// - Players can now message their TEAM (team_internal) as well as flag a
//   message for the GM ("Message GM" button → team_to_gm).
// - Chat rendering distinguishes four cases: you, a teammate (shows their
//   name), the GM, and broadcasts. Previously every non-GM message showed
//   as "You", which broke once teammates can talk to each other.
// - Chat messages now use the player's TEAM display name (from member_names),
//   not their auth profile name.
// - Fixed: messages sort/label by sent_at (was reading a non-existent
//   created_at field).
//
// CHANGES (prior):
// - Discard logic tracks discarded_challenges on team doc
// - Player profile badge removed from hand cards
// - Home tab rules updated with new copy + Side Quests info
// =============================================================================

import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, onSnapshot, collection,
  updateDoc, getDocs, query, where,
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { db, auth } from '../lib/firebase'
import SubmitProof from '../components/SubmitProof'
import SequentialCard from '../components/SequentialCard'
import GameMap from '../components/GameMap'
import type { ZoneOwner } from '../components/GameMap'
import HistoryTab from './HistoryTab'
import { checkZoneLockouts, checkZoneClosures } from '../lib/scoring'
import {
  sendTeamMessage,
  subscribeToPlayerMessages,
  markMessagesRead,
} from '../lib/chat'
import { logEvent } from '../lib/activityLog'
import { useLocation } from '../hooks/useLocation'
import LocationStatusPill from '../components/LocationStatusPill'

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
  discard_used: number
  discarded_challenges?: string[]
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
  // sequential ("Choose Your Own Adventure") fields — absent on standard cards
  challenge_type?: 'standard' | 'sequential'
  steps?: string[]
  final_task?: string
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
  status: 'none' | 'claimed' | 'locked' | 'locked_out'
  challenges_completed: string[]
}

// --------------- Helpers ---------------

const DIFFICULTY_STYLES: Record<string, { bg: string; color: string; label: string; pts: number }> = {
  easy:   { bg: 'rgba(6,214,160,0.15)',  color: '#06D6A0', label: 'Easy',   pts: 1 },
  medium: { bg: 'rgba(255,209,102,0.15)', color: '#FFD166', label: 'Medium', pts: 3 },
  hard:   { bg: 'rgba(239,71,111,0.15)',  color: '#EF476F', label: 'Hard',   pts: 5 },
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
  const [user, setUser] = useState<typeof auth.currentUser>(auth.currentUser)

  useEffect(() => {
    return onAuthStateChanged(auth, setUser)
  }, [])

  const [activeTab, setActiveTab] = useState<'home' | 'hand' | 'map' | 'chat' | 'history'>('home')
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

  // The player's display name for THIS game comes from their team's
  // member_names (the name they picked at join), not the auth profile.
  const myDisplayName = (() => {
    if (!myTeam || !user) return user?.displayName || 'Player'
    const idx = myTeam.members.indexOf(user.uid)
    return (idx !== -1 && myTeam.member_names[idx]) || user.displayName || 'Player'
  })()

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

 // Unified location — single source of truth for the whole app.
  // Optionally driven by game.settings.gps if present (no Firestore migration
  // required; defaults apply when the field is absent).
  const location = useLocation(game?.settings.gps ?? {})

  // Write player location to Firestore for the GM map.
  // Driven by hook state changes, throttled to 1 write per 15s.
  const lastLocationWriteRef = useRef(0)
  useEffect(() => {
    if (!gameId || !user || !myTeam) return
    if (location.lat == null || location.lng == null) return
    const now = Date.now()
    if (now - lastLocationWriteRef.current < 15000) return
    lastLocationWriteRef.current = now

    const teamRef = doc(db, 'games', gameId, 'teams', myTeam.id)
    updateDoc(teamRef, {
      [`member_locations.${user.uid}`]: {
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy,
        name: myDisplayName.split(' ')[0] || 'Player',
        updated_at: now,
      },
    }).catch(() => {
      // Silent fail — location write is non-critical
    })
  }, [gameId, user?.uid, myTeam?.id, location.lat, location.lng, location.accuracy, myDisplayName])

  // Listen to game document
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (snap.exists()) setGame(snap.data() as GameData)
    })
    return () => unsub()
  }, [gameId])

  // Zone lockout timer
  useEffect(() => {
  if (game?.status !== 'active') return
  const interval = setInterval(() => {
    checkZoneLockouts(gameId!)
    checkZoneClosures(gameId!)
  }, 60000)
  return () => clearInterval(interval)
}, [game?.status, gameId])

  // Find player's team and listen for updates
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
            // Fetch all challenges in parallel instead of sequentially.
            // 6 sequential reads on mobile = 1.5-3s. Parallel = ~300ms.
            const challengeDocs = await Promise.all(
              teamHand.map((chId) => getDoc(doc(db, 'challenges', chId)))
            )
            const loaded: Challenge[] = challengeDocs
              .filter((d) => d.exists())
              .map((d) => ({ id: d.id, ...d.data() } as Challenge))
            setChallenges(loaded)
          }
        }

        setLoading(false)
      }
    )

    return () => unsub()
  }, [gameId, user])

  // Listen to zone_scores
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

  // Listen to submissions for this team
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

  // Subscribe to chat messages
  useEffect(() => {
    if (!gameId || !myTeam) return
    const unsub = subscribeToPlayerMessages(gameId, myTeam.id, (msgs) => {
      setChatMessages(msgs)

      const latestUnreadBroadcast = msgs
        .filter(
          (m: any) =>
            m.channel_type === 'gm_broadcast' &&
            !m.read_by?.includes(user?.uid)
        )
        .sort((a: any, b: any) =>
          (b.sent_at?.toMillis?.() ?? 0) - (a.sent_at?.toMillis?.() ?? 0)
        )[0]

      if (latestUnreadBroadcast) {
        setLatestBroadcast(latestUnreadBroadcast.text)
        setBroadcastDismissed(null)
      }

      setTimeout(() => {
        chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 50)
    })
    return () => unsub()
  }, [gameId, myTeam?.id])

  // Navigate to results when game ends
  useEffect(() => {
    if (game?.status === 'ended' && gameId) {
      navigate('/results/' + gameId)
    }
  }, [game?.status, gameId, navigate])

  // Mark messages as read when chat tab is active
  useEffect(() => {
    if (activeTab === 'chat' && gameId && user && myTeam) {
      markMessagesRead(gameId, user.uid, myTeam.id)
    }
  }, [activeTab, gameId, user?.uid, myTeam?.id])

  // Chat send handler.
  // toGM=false → team_internal (teammates see it, GM not pinged)
  // toGM=true  → team_to_gm   (flagged; lands in GM attention queue)
  const handleSendMessage = async (toGM: boolean = false) => {
    if (!chatInput.trim() || !gameId || !user || !myTeam || chatSending) return
    setChatSending(true)
    try {
      await sendTeamMessage(gameId, user.uid, myDisplayName, myTeam.id, chatInput.trim(), toGM)
      setChatInput('')
    } catch (err) {
      console.error('Failed to send message:', err)
      alert('Failed to send. Try again.')
    } finally {
      setChatSending(false)
    }
  }

  // Discard handler — tracks discarded challenges so they never recycle back
  const handleDiscard = async (cardIndex: number) => {
    if (!gameId || !myTeam || !game || discarding) return

    const discardLimit = game.settings.discard_limit ?? 1
    const discardsUsed = myTeam.discard_used ?? 0

    if (discardsUsed >= discardLimit) {
      alert(`You've already used your ${discardLimit === 1 ? 'discard' : `${discardLimit} discards`}.`)
      return
    }

    const challengeToRemove = challenges[cardIndex]
    if (!challengeToRemove) return

    setDiscarding(true)

    try {
      // Build a full exclusion list:
      // 1. Current hand
      // 2. Previously discarded cards
      // 3. Approved challenges (don't re-deal completed ones)
      const previouslyDiscarded: string[] = myTeam.discarded_challenges ?? []
      const approvedIds = Array.from(submissions.entries())
        .filter(([, s]) => s.status === 'approved')
        .map(([id]) => id)

      const excluded = new Set([
        ...myTeam.hand,
        ...previouslyDiscarded,
        ...approvedIds,
      ])

      const challengeSnap = await getDocs(collection(db, 'challenges'))
      const available: string[] = []
      challengeSnap.forEach((d) => {
        const data = d.data()
        if (data.is_active !== false && !excluded.has(d.id)) {
          available.push(d.id)
        }
      })

      if (available.length === 0) {
        alert('No replacement challenges available.')
        setDiscarding(false)
        return
      }

      const replacement = available[Math.floor(Math.random() * available.length)]
      const newHand = [...myTeam.hand]
      const handIndex = newHand.indexOf(challengeToRemove.id)
      if (handIndex !== -1) newHand[handIndex] = replacement

      const teamRef = doc(db, 'games', gameId, 'teams', myTeam.id)
      await updateDoc(teamRef, {
        hand: newHand,
        discard_used: discardsUsed + 1,
        discarded_challenges: [...previouslyDiscarded, challengeToRemove.id],
      })

      // Activity log: card discarded + replacement card drawn
      await logEvent(gameId, {
        team_id: myTeam.id,
        event_type: 'card_discarded',
        actor_id: user?.uid ?? null,
        challenge_id: challengeToRemove.id,
      })
      await logEvent(gameId, {
        team_id: myTeam.id,
        event_type: 'card_drawn',
        actor_id: user?.uid ?? null,
        challenge_id: replacement,
        metadata: {
          reason: 'discard_swap',
          discarded_challenge_id: challengeToRemove.id,
        },
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
    if (game?.status === 'paused') return    // ← ONLY NEW LINE
    const end = game.ends_at.toDate ? game.ends_at.toDate() : new Date(game.ends_at)
    const diff = end.getTime() - Date.now()
    if (diff <= 0) {
      setTimeLeft('GAME OVER')
      clearInterval(interval)
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

  const gameEnded = game?.status === 'ended'
  const discardLimit = game?.settings.discard_limit ?? 1
  const discardsUsed = myTeam?.discard_used ?? 0
  const canDiscard = discardsUsed < discardLimit && game?.status === 'active'

  const pendingCount = Array.from(submissions.values()).filter(s => s.status === 'pending').length
  const approvedCount = Array.from(submissions.values()).filter(s => s.status === 'approved').length

  const activeZones = localZones.filter((z: any) => game?.zones?.includes(z.id))

  // Compute zone ownership for GameMap
  const claimThreshold = game?.settings.claim_threshold ?? 6
  const zoneOwnership = new Map<string, ZoneOwner>()

  for (const zone of (game?.zones ?? [])) {
    const scoresForZone = zoneScores.filter(zs => zs.zone_id === zone)
    if (scoresForZone.length === 0) continue

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
      // Read the resolved status that scoring.ts wrote — don't recompute from
      // points. A locked zone is also "claimed" (owned); lock is its stronger
      // form. Reading status keeps the map in lockstep with the GM broadcast.
      claimed: leading.status === 'claimed' || leading.status === 'locked',
      locked: leading.status === 'locked',
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
            animation: 'spin 0.8s linear infinite', margin: '0 auto 12px',
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
      minHeight: '100vh', background: '#0a0a0a', color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        padding: '12px 20px', borderBottom: '1px solid #1a1a1a',
        background: '#0d0d0d', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: myTeam.color, flexShrink: 0 }} />
            <span style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{myTeam.name}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <LocationStatusPill location={location} onRefresh={() => location.refresh()} />
            <div style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.85rem',
              color: timeLeft === 'GAME OVER' ? '#EF476F' : '#FFD166',
              fontWeight: 600,
            }}>
              {game?.status === 'paused' ? 'PAUSED' : timeLeft || (game?.status === 'active' ? '—' : game?.status?.toUpperCase())}
            </div>
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

      {/* GM broadcast banner */}
      {latestBroadcast && broadcastDismissed !== latestBroadcast && activeTab !== 'chat' && (
        <div style={{
          marginTop: 10,
          background: 'rgba(255,209,102,0.10)', border: '1px solid rgba(255,209,102,0.3)',
          borderRadius: 8, padding: '8px 12px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
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
              style={{ background: 'none', border: 'none', color: '#555', fontSize: '0.9rem', cursor: 'pointer', padding: '4px 6px', lineHeight: 1 }}
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

        {/* ==================== HOME TAB ==================== */}
        {activeTab === 'home' && (
          <div style={{ paddingBottom: 100 }}>
            {/* Team score card */}
            <div style={{
              background: `${myTeam.color}10`, border: `1px solid ${myTeam.color}35`,
              borderRadius: 14, padding: '24px 20px', marginBottom: 20, textAlign: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: myTeam.color }} />
                <span style={{ fontWeight: 700, fontSize: '1rem', color: '#fff' }}>{myTeam.name}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                <div>
                  <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '2.2rem', fontWeight: 800, color: myTeam.color, lineHeight: 1, marginBottom: 6 }}>
                    {myTeam.total_points}
                  </p>
                  <p style={{ fontSize: '0.72rem', color: '#555', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Total Points</p>
                </div>
                <div style={{ width: 1, background: '#1a1a1a' }} />
                <div>
                  <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '2.2rem', fontWeight: 800, color: '#FFD166', lineHeight: 1, marginBottom: 6 }}>
                    {Array.from(zoneOwnership.values()).filter(z => z.claimed && allTeams.find(t => t.color === z.teamColor)?.id === myTeam.id).length}
                  </p>
                  <p style={{ fontSize: '0.72rem', color: '#555', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Zones Claimed</p>
                </div>
                <div style={{ width: 1, background: '#1a1a1a' }} />
                <div>
                  <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '2.2rem', fontWeight: 800, color: '#9B5DE5', lineHeight: 1, marginBottom: 6 }}>
                    {approvedCount}
                  </p>
                  <p style={{ fontSize: '0.72rem', color: '#555', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Challenges</p>
                </div>
              </div>
            </div>

            {/* Game Rules */}
            <div style={{
              background: 'rgba(255,255,255,0.02)', border: '1px solid #1a1a1a',
              borderRadius: 14, padding: '20px 18px', marginBottom: 16,
            }}>
              <p style={{
                fontSize: '0.72rem', color: '#FFD166',
                textTransform: 'uppercase', letterSpacing: 1.5,
                fontWeight: 700, marginBottom: 14,
              }}>
                Game Rules
              </p>
              <div style={{ display: 'grid', gap: 14 }}>
                {[
                  {
                    icon: '👋',
                    text: `Welcome explorers! Over the next ${Math.round((game?.settings.duration_minutes ?? 180) / 60)} hour(s) you'll compete against another team in a series of challenges across Manhattan that will test your resolve, your quick thinking, and spirit of adventuring into new places.`,
                  },
                  {
                    icon: '🃏',
                    text: 'Each team will have 5 challenges in their hand at a given time.',
                  },
                  {
                    icon: '⭐',
                    text: 'Challenges are worth 1 (easy), 2 (medium) or 3 (hard) points. The game map is broken up into zones, which you can access on your map tab. Complete a challenge and those points count in the zone you\'re currently located.',
                  },
                  {
                    icon: '📍',
                    text: `Once you've reached ${game?.settings.claim_threshold ?? 4} points in a zone, you have claimed that zone! If at any point a team gains more points in that zone, they steal the claim and the initial team loses those points.`,
                  },
                  {
                    icon: '📸',
                    text: 'The challenges will require taking pictures or videos, then submitting them to the GM. The GM will then approve or deny the challenge and award the points.',
                  },
                  {
                    icon: '🚇',
                    text: 'You may only use public modes of transportation: subway, buses, and your feet.',
                  },
                  {
                    icon: '🏆',
                    text: 'Side Quests: At the end of the game, bonus points are awarded: most zones claimed (+8 pts) most zones with a challenge completed (+8 pts).',
                  },
                ].map((rule, i) => (
                  <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '1.1rem', flexShrink: 0, marginTop: 1 }}>{rule.icon}</span>
                    <p style={{ color: '#bbb', fontSize: '0.88rem', lineHeight: 1.65, margin: 0 }}>
                      {rule.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ==================== HAND TAB ==================== */}
        {activeTab === 'hand' && (
          <div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: 16,
            }}>
              <p style={{ fontSize: '0.75rem', color: '#555', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, margin: 0 }}>
                Your Challenges ({challenges.length})
              </p>

              {canDiscard ? (
                <button
                  onClick={() => { setDiscardMode(!discardMode); setSelectedCard(null) }}
                  style={{
                    background: discardMode ? 'rgba(239,71,111,0.15)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${discardMode ? '#EF476F40' : '#222'}`,
                    color: discardMode ? '#EF476F' : '#888',
                    padding: '6px 14px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                  }}
                >
                  {discardMode ? '✕ Cancel' : `🔄 Discard (${discardLimit - discardsUsed} left)`}
                </button>
              ) : (
                <span style={{ fontSize: '0.72rem', color: '#333', fontStyle: 'italic' }}>No discards left</span>
              )}
            </div>

            {discardMode && (
              <div style={{
                background: 'rgba(239,71,111,0.06)', border: '1px solid rgba(239,71,111,0.15)',
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

                // --- Sequential ("Choose Your Own Adventure") card branch ---
                // Renders the dedicated step-by-step component. In discard mode
                // we skip this so the card falls through to the standard render
                // and the existing tap-to-discard UI applies uniformly.
                if (ch.challenge_type === 'sequential' && !discardMode) {
                  const seqSub = submissions.get(ch.id)
                  return (
                    <SequentialCard
                      key={ch.id}
                      gameId={gameId!}
                      teamId={myTeam.id}
                      challenge={ch as any}
                      closedZones={game?.closed_zones ?? []}
                      activeZoneIds={game?.zones ?? []}
                      gameEnded={game?.status === 'ended'}
                      submissionStatus={seqSub?.status}
                      gmNotes={seqSub?.gm_notes}
                    />
                  )
                }
                // --- otherwise: standard card (unchanged) ---

                const diff = DIFFICULTY_STYLES[ch.difficulty] || DIFFICULTY_STYLES.medium
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
                      borderRadius: 12, padding: '16px 18px',
                      cursor: 'pointer', transition: 'all 0.15s',
                      opacity: isCompleted && !isExpanded ? 0.65 : 1,
                    }}
                  >
                    {/* Card header — difficulty badge + status badge only (no profile badge) */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px',
                          borderRadius: 20, background: diff.bg, color: diff.color,
                        }}>
                          {diff.label}
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
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem', fontWeight: 700, color: diff.color }}>
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
                        background: 'rgba(239,71,111,0.06)', border: '1px solid rgba(239,71,111,0.15)',
                        borderRadius: 8, padding: '8px 12px', marginBottom: 10,
                      }}>
                        <p style={{ fontSize: '0.7rem', color: '#EF476F', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                          GM Feedback
                        </p>
                        <p style={{ color: '#ccc', fontSize: '0.82rem', lineHeight: 1.5 }}>{sub.gm_notes}</p>
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
                          width: '100%', background: 'rgba(239,71,111,0.12)',
                          border: '1px solid rgba(239,71,111,0.3)', color: '#EF476F',
                          padding: '10px 16px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700,
                          cursor: discarding ? 'wait' : 'pointer', fontFamily: 'inherit',
                          opacity: discarding ? 0.5 : 1,
                        }}
                      >
                        {discarding ? 'Swapping...' : '🗑 Discard This Card'}
                      </button>
                    )}

                    {/* Expanded details */}
                    {isExpanded && (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: '0.78rem', color: '#666', flexWrap: 'wrap' }}>
                          <span>Time: {TIME_LABELS[ch.time_estimate] || ch.time_estimate}</span>
                          {ch.is_time_based && <span style={{ color: '#FFD166' }}>⏱ Timed challenge</span>}
                        </div>

                        {ch.tier2 && (
                          <div style={{
                            background: 'rgba(155,93,229,0.08)', border: '1px solid rgba(155,93,229,0.2)',
                            borderRadius: 8, padding: '10px 14px', marginBottom: 10,
                          }}>
                            <p style={{ fontSize: '0.7rem', color: '#9B5DE5', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                              Tier 2 Bonus (+{ch.tier2.bonus_points}pt)
                            </p>
                            <p style={{ color: '#aaa', fontSize: '0.85rem', lineHeight: 1.5 }}>
                              {ch.tier2.description}
                            </p>
                          </div>
                        )}

                        {sub?.status === 'approved' ? (
                          <div style={{
                            width: '100%', boxSizing: 'border-box', background: 'rgba(6,214,160,0.08)',
                            border: '1px solid rgba(6,214,160,0.2)',
                            padding: '12px 20px', borderRadius: 8,
                            textAlign: 'center', color: '#06D6A0', fontSize: '0.88rem', fontWeight: 600,
                          }}>
                            ✅ Challenge Complete — {diff.pts} point{diff.pts !== 1 ? 's' : ''} earned
                          </div>
                        ) : sub?.status === 'pending' ? (
                          <div style={{
                            width: '100%', boxSizing: 'border-box', background: 'rgba(255,209,102,0.08)',
                            border: '1px solid rgba(255,209,102,0.2)',
                            padding: '12px 20px', borderRadius: 8,
                            textAlign: 'center', color: '#FFD166', fontSize: '0.88rem', fontWeight: 600,
                            animation: 'pendingPulse 2s ease-in-out infinite',
                          }}>
                            ⏳ Waiting for GM review...
                          </div>
                        ) : game?.status === 'ended' ? (
                          <div style={{
                            width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.03)',
                            border: '1px solid #222', padding: '12px 20px', borderRadius: 8,
                            textAlign: 'center', color: '#555', fontSize: '0.88rem',
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
                              width: '100%', background: `${diff.color}20`,
                              border: `1px solid ${diff.color}40`, color: diff.color,
                              padding: '12px 20px', borderRadius: 8,
                              fontSize: '0.9rem', fontWeight: 700,
                              cursor: 'pointer', fontFamily: 'inherit',
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
                <p style={{ fontSize: '0.82rem', color: '#333', marginTop: 4 }}>Waiting for GM to start the game.</p>
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
                background: 'rgba(10,10,10,0.85)', backdropFilter: 'blur(8px)',
                border: '1px solid #222', borderRadius: 10, padding: '10px 14px', zIndex: 10,
              }}>
                <p style={{ fontSize: '0.65rem', color: '#666', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 6 }}>
                  Zone Control
                </p>
                {Array.from(zoneOwnership.entries()).map(([zoneId, owner]) => (
                  <div key={zoneId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: owner.teamColor, opacity: owner.claimed ? 1 : 0.4 }} />
                    <span style={{ fontSize: '0.72rem', color: '#aaa' }}>
                      {zoneId.replace('zone_district_', 'D')} — {owner.teamName}
                      {owner.locked ? ' (locked)' : !owner.claimed ? ' (contesting)' : ''}
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
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chatMessages.length === 0 ? (
                <div style={{ textAlign: 'center', marginTop: 60, color: '#555' }}>
                  <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>💬</p>
                  <p style={{ fontWeight: 600, color: '#666' }}>No messages yet</p>
                  <p style={{ fontSize: '0.82rem', color: '#444', marginTop: 6, lineHeight: 1.6 }}>
                    Chat with your team here. Use “Message GM” to send the GM a question.
                  </p>
                </div>
              ) : (
                chatMessages.map((msg: any) => {
                  // Four cases: broadcast, GM-to-team, your own message, teammate's message.
                  const isBroadcast = msg.channel_type === 'gm_broadcast'
                  const isFromGM = msg.channel_type === 'gm_to_team' || isBroadcast
                  const isMine = !isFromGM && msg.from_uid === user?.uid
                  const isFlaggedToGM = msg.channel_type === 'team_to_gm'

                  // Layout: GM messages on the left, your own on the right,
                  // teammates' on the left (with their name shown).
                  const alignRight = isMine

                  // Label above the bubble
                  const label = isBroadcast
                    ? '📢 GM → All Teams'
                    : isFromGM
                      ? '🎮 GM'
                      : isMine
                        ? (isFlaggedToGM ? 'You → GM' : 'You')
                        : (msg.from_name || 'Teammate')

                  return (
                    <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: alignRight ? 'flex-end' : 'flex-start' }}>
                      <p style={{ fontSize: '0.68rem', color: isFlaggedToGM ? '#FFD166' : '#444', marginBottom: 3, paddingLeft: alignRight ? 0 : 4, paddingRight: alignRight ? 4 : 0, fontWeight: isFlaggedToGM ? 700 : 400 }}>
                        {label}
                      </p>
                      <div style={{
                        maxWidth: '80%',
                        background: isBroadcast
                          ? 'rgba(255,209,102,0.1)'
                          : isFromGM
                            ? 'rgba(255,255,255,0.05)'
                            : isFlaggedToGM
                              ? 'rgba(255,209,102,0.08)'
                              : `${myTeam.color}18`,
                        border: `1px solid ${
                          isBroadcast
                            ? 'rgba(255,209,102,0.25)'
                            : isFromGM
                              ? '#222'
                              : isFlaggedToGM
                                ? 'rgba(255,209,102,0.35)'
                                : myTeam.color + '35'
                        }`,
                        borderRadius: alignRight ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                        padding: '10px 14px',
                      }}>
                        <p style={{ color: isBroadcast ? '#FFD166' : '#e0e0e0', fontSize: '0.88rem', lineHeight: 1.55, margin: 0 }}>
                          {msg.text}
                        </p>
                      </div>
                      <p style={{ fontSize: '0.65rem', color: '#333', marginTop: 3, paddingLeft: alignRight ? 0 : 4, paddingRight: alignRight ? 4 : 0 }}>
                        {msg.sent_at?.toDate ? msg.sent_at.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </p>
                    </div>
                  )
                })
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Composer: team message (default) + Message GM (flagged) */}
            <div style={{ padding: '12px 16px 100px', borderTop: '1px solid #1a1a1a', background: '#0d0d0d' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 8 }}>
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(false) } }}
                  placeholder="Message ..."
                  rows={1}
                  style={{
                    flex: 1, background: '#141414', border: '1px solid #222',
                    borderRadius: 10, padding: '10px 14px', color: '#fff',
                    fontSize: '0.88rem', fontFamily: 'inherit', resize: 'none', outline: 'none', lineHeight: 1.5,
                  }}
                />
                <button
                  onClick={() => handleSendMessage(false)}
                  disabled={!chatInput.trim() || chatSending}
                  title="Send to your team"
                  style={{
                    background: chatInput.trim() ? '#FFD166' : '#1a1a1a',
                    color: chatInput.trim() ? '#0a0a0a' : '#444',
                    border: 'none', borderRadius: 10, width: 42, height: 42,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: chatInput.trim() ? 'pointer' : 'default',
                    fontSize: '1.1rem', fontWeight: 800, flexShrink: 0, transition: 'background 0.15s',
                    opacity: chatSending ? 0.5 : 1,
                  }}
                >
                  {chatSending ? '⏳' : '↑'}
                </button>
              </div>

              {/* Message GM — flags the typed message for the GM's attention queue */}
              <button
                onClick={() => handleSendMessage(true)}
                disabled={!chatInput.trim() || chatSending}
                title="Send this message directly to the GM"
                style={{
                  width: '100%',
                  background: chatInput.trim() ? 'rgba(255,209,102,0.12)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${chatInput.trim() ? 'rgba(255,209,102,0.35)' : '#1a1a1a'}`,
                  color: chatInput.trim() ? '#FFD166' : '#444',
                  padding: '9px 14px', borderRadius: 10,
                  fontSize: '0.82rem', fontWeight: 700,
                  cursor: chatInput.trim() && !chatSending ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                  opacity: chatSending ? 0.5 : 1,
                }}
              >
                🎮 Message GM
              </button>
              <p style={{ fontSize: '0.66rem', color: '#444', textAlign: 'center', marginTop: 6, lineHeight: 1.4 }}>
                Normal messages go to your team (the GM can see them). “Message GM” pings the GM directly.
              </p>
            </div>
          </div>
        )}

        {/* ==================== HISTORY TAB ==================== */}
        {activeTab === 'history' && (
          <HistoryTab gameId={gameId!} teamId={myTeam.id} totalPoints={myTeam.total_points} />
        )}
      </div>

      {/* Submission overlay */}
      {submittingChallenge !== null && challenges[submittingChallenge] && gameId && myTeam && (
        <SubmitProof
          gameId={gameId}
          teamId={myTeam.id}
          challenge={challenges[submittingChallenge]}
          closedZones={game?.closed_zones ?? []}
          activeZoneIds={game?.zones ?? []}
          onClose={() => setSubmittingChallenge(null)}
          onSubmitted={() => {}}
        />
      )}

      {/* Game ended overlay */}
      {gameEnded && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(10,10,10,0.92)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 16, padding: '0 32px', fontFamily: "'DM Sans', sans-serif",
        }}>
          <span style={{ fontSize: '2.5rem' }}>🏁</span>
          <h2 style={{ color: '#FFD166', fontWeight: 800, fontSize: '1.5rem', textAlign: 'center', margin: 0 }}>Game Over</h2>
          <p style={{ color: '#888', fontSize: '0.9rem', textAlign: 'center', lineHeight: 1.6, margin: 0 }}>
            The GM has ended the game. Time to see how you did!
          </p>
          <button
            onClick={() => navigate('/results/' + gameId)}
            style={{
              marginTop: 8, background: '#FFD166', border: 'none', borderRadius: 12,
              color: '#0a0a0a', fontFamily: 'inherit', fontSize: '1rem', fontWeight: 800,
              padding: '14px 32px', cursor: 'pointer',
            }}
          >
            View Results →
          </button>
        </div>
      )}

      {/* Bottom tab bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: '#0d0d0d', borderTop: '1px solid #1a1a1a',
        display: 'flex', justifyContent: 'space-around',
        padding: '10px 0 24px', zIndex: 100,
      }}>
        {([
          { id: 'home' as const, icon: '🏠', label: 'Home' },
          { id: 'hand' as const, icon: '🃏', label: 'Hand' },
          { id: 'map' as const, icon: '🗺️', label: 'Map' },
          { id: 'chat' as const, icon: '💬', label: 'Chat' },
          { id: 'history' as const, icon: '📋', label: 'History' },
        ]).map((tab) => {
          // Unread chat badge: GM replies, broadcasts, and unseen teammate
          // messages all count (not your own messages).
          const unreadChatCount = chatMessages.filter(
            (m: any) =>
              (m.channel_type === 'gm_to_team' ||
                m.channel_type === 'gm_broadcast' ||
                (m.channel_type === 'team_internal' && m.from_uid !== user?.uid)) &&
              !m.read_by?.includes(user?.uid)
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
                  <span style={{ position: 'absolute', top: -2, right: -6, width: 8, height: 8, borderRadius: '50%', background: '#FFD166' }} />
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