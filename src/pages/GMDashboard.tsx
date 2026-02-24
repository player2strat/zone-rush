// =============================================================================
// Zone Rush — GM Dashboard (Day 11)
// Real-time submission review, scoring engine, zone claim logic,
// mini zone map, and GPS proximity warnings
//
// CHANGES FROM DAY 10:
// - NEW: Mini map in right sidebar showing claimed zones in team colors
// - NEW: GPS proximity warning — flags submissions outside the claimed zone
// - NEW: Import zones data + GameMap + geo utilities
// - CHANGED: zoneOwnership now also feeds into the mini GameMap component
// =============================================================================

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import {
  doc, onSnapshot, collection, query, where, orderBy,
  updateDoc, setDoc, getDoc, getDocs, serverTimestamp,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import { zones as allZoneData } from '../lib/zones'
import { isPointInPolygon } from '../lib/geo'
import GameMap from '../components/GameMap'
import type { ZoneOwner } from '../components/GameMap'

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
    zone_bonus_points: number
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
}

interface SubmissionData {
  id: string
  game_id: string
  team_id: string
  challenge_id: string
  zone_id: string
  submitted_by: string
  media_url: string
  media_type: 'photo' | 'video' | 'audio'
  gps_lat: number | null
  gps_lng: number | null
  status: 'pending' | 'approved' | 'rejected'
  gm_notes: string
  reviewed_by: string | null
  reviewed_at: any
  attempted_tier2: boolean
  tier2_approved: boolean
  phone_free_claimed: boolean
  submitted_at: any
}

interface ChallengeData {
  id: string
  title: string
  description: string
  difficulty: string
  points: number
  tier2: { description: string; bonus_points: number } | null
  phone_free_eligible: boolean
  is_time_based: boolean
  player_profile: string
}

interface ZoneScoreData {
  team_id: string
  zone_id: string
  points: number
  status: 'none' | 'claimed'
  challenges_completed: string[]
}

// --------------- Constants ---------------

const DIFFICULTY_PTS: Record<string, number> = { easy: 1, medium: 3, hard: 5 }
const DIFFICULTY_COLORS: Record<string, string> = {
  easy: '#06D6A0', medium: '#FFD166', hard: '#EF476F',
}

// --------------- Component ---------------

export default function GMDashboard() {
  const { gameId } = useParams<{ gameId: string }>()
  const user = auth.currentUser

  // Core state
  const [game, setGame] = useState<GameData | null>(null)
  const [teams, setTeams] = useState<TeamData[]>([])
  const [submissions, setSubmissions] = useState<SubmissionData[]>([])
  const [challenges, setChallenges] = useState<Map<string, ChallengeData>>(new Map())
  const [zoneScores, setZoneScores] = useState<ZoneScoreData[]>([])
  const [loading, setLoading] = useState(true)

  // Review state — tracks GM's choices per submission
  const [reviewState, setReviewState] = useState<
    Map<string, { tier2Approved: boolean; phoneFreeBonus: number; notes: string }>
  >(new Map())

  // Processing state
  const [processing, setProcessing] = useState<string | null>(null)

  // Filter: show pending, approved, rejected, or all
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')

  // Timer
  const [timeLeft, setTimeLeft] = useState('')

  // ✅ NEW: Zone data lookup for GPS proximity checks
  const zoneDataMap = useMemo(
    () => new Map(allZoneData.map((z) => [z.id, z])),
    []
  )

  // ---------- Listeners ----------

  // Game doc
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (snap.exists()) setGame({ id: snap.id, ...snap.data() } as GameData)
    })
    return () => unsub()
  }, [gameId])

  // Teams
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(collection(db, 'games', gameId, 'teams'), (snap) => {
      const t: TeamData[] = []
      snap.forEach((d) => t.push({ id: d.id, ...d.data() } as TeamData))
      setTeams(t)
    })
    return () => unsub()
  }, [gameId])

  // Submissions — all for this game, ordered by submission time
  useEffect(() => {
    if (!gameId) return
    const q = query(
      collection(db, 'submissions'),
      where('game_id', '==', gameId),
      orderBy('submitted_at', 'desc')
    )
    const unsub = onSnapshot(q, (snap) => {
      const subs: SubmissionData[] = []
      snap.forEach((d) => subs.push({ id: d.id, ...d.data() } as SubmissionData))
      setSubmissions(subs)
      setLoading(false)
    })
    return () => unsub()
  }, [gameId])

  // Zone scores
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(collection(db, 'games', gameId, 'zone_scores'), (snap) => {
      const scores: ZoneScoreData[] = []
      snap.forEach((d) => scores.push({ ...d.data() } as ZoneScoreData))
      setZoneScores(scores)
    })
    return () => unsub()
  }, [gameId])

  // Load all challenges once (they don't change during a game)
  useEffect(() => {
    const loadChallenges = async () => {
      const snap = await getDocs(collection(db, 'challenges'))
      const map = new Map<string, ChallengeData>()
      snap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() } as ChallengeData))
      setChallenges(map)
    }
    loadChallenges()
  }, [])

  // Timer
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
      setTimeLeft(
        hrs > 0
          ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
          : `${mins}:${String(secs).padStart(2, '0')}`
      )
    }, 1000)
    return () => clearInterval(interval)
  }, [game?.ends_at])

  // ---------- Review state helpers ----------

  const getReviewState = (subId: string) => {
    return reviewState.get(subId) || { tier2Approved: false, phoneFreeBonus: 0, notes: '' }
  }

  const updateReviewState = (
    subId: string,
    updates: Partial<{ tier2Approved: boolean; phoneFreeBonus: number; notes: string }>
  ) => {
    setReviewState((prev) => {
      const next = new Map(prev)
      next.set(subId, { ...getReviewState(subId), ...updates })
      return next
    })
  }

  // ---------- GPS Proximity Check ----------

  /**
   * ✅ NEW: Check if a submission's GPS falls inside its claimed zone.
   * Returns: 'inside' | 'outside' | 'unknown' (no GPS or no zone data)
   */
  const checkGpsProximity = (sub: SubmissionData): 'inside' | 'outside' | 'unknown' => {
    if (!sub.gps_lat || !sub.gps_lng || !sub.zone_id) return 'unknown'
    const zone = zoneDataMap.get(sub.zone_id)
    if (!zone?.boundary?.coordinates) return 'unknown'
    return isPointInPolygon(sub.gps_lat, sub.gps_lng, zone.boundary.coordinates)
      ? 'inside'
      : 'outside'
  }

  // ---------- Scoring + Approve ----------

  const handleApprove = async (sub: SubmissionData) => {
    if (!gameId || !game || processing) return
    setProcessing(sub.id)

    try {
      const challenge = challenges.get(sub.challenge_id)
      if (!challenge) throw new Error('Challenge not found')

      const review = getReviewState(sub.id)
      const claimThreshold = game.settings.claim_threshold ?? 6

      // --- Calculate points ---
      const basePoints = DIFFICULTY_PTS[challenge.difficulty] || 3
      const tier2Points =
        sub.attempted_tier2 && review.tier2Approved && challenge.tier2
          ? challenge.tier2.bonus_points
          : 0
      const phoneFreePoints = sub.phone_free_claimed ? review.phoneFreeBonus : 0
      const totalPointsEarned = basePoints + tier2Points + phoneFreePoints

      // --- 1. Update submission status ---
      await updateDoc(doc(db, 'submissions', sub.id), {
        status: 'approved',
        tier2_approved: review.tier2Approved,
        reviewed_by: user?.uid || null,
        reviewed_at: serverTimestamp(),
        gm_notes: '',
      })

      // --- 2. Update zone_scores ---
      const zoneId = sub.zone_id || 'unknown'
      const scoreDocId = `${sub.team_id}__${zoneId}`
      const scoreRef = doc(db, 'games', gameId, 'zone_scores', scoreDocId)
      const scoreSnap = await getDoc(scoreRef)

      let currentPoints = 0
      let completedChallenges: string[] = []

      if (scoreSnap.exists()) {
        const data = scoreSnap.data() as ZoneScoreData
        currentPoints = data.points
        completedChallenges = data.challenges_completed || []
      }

      const newPoints = currentPoints + totalPointsEarned
      completedChallenges.push(sub.challenge_id)

      let newStatus: 'none' | 'claimed' = newPoints >= claimThreshold ? 'claimed' : 'none'

      await setDoc(scoreRef, {
        team_id: sub.team_id,
        zone_id: zoneId,
        points: newPoints,
        status: newStatus,
        challenges_completed: completedChallenges,
      })

      // --- 3. Check zone ownership across all teams ---
      if (newStatus === 'claimed') {
        const allScoresSnap = await getDocs(
          collection(db, 'games', gameId, 'zone_scores')
        )

        let highestPoints = 0
        let highestTeam = ''

        allScoresSnap.forEach((d) => {
          const data = d.data() as ZoneScoreData
          if (data.zone_id === zoneId && data.points > highestPoints) {
            highestPoints = data.points
            highestTeam = data.team_id
          }
        })

        for (const d of allScoresSnap.docs) {
          const data = d.data() as ZoneScoreData
          if (data.zone_id === zoneId) {
            const shouldBeClaimed =
              data.team_id === highestTeam && data.points >= claimThreshold
            if (
              (shouldBeClaimed && data.status !== 'claimed') ||
              (!shouldBeClaimed && data.status === 'claimed')
            ) {
              await updateDoc(d.ref, {
                status: shouldBeClaimed ? 'claimed' : 'none',
              })
            }
          }
        }
      }

      // --- 4. Recalculate team totals from all zone_scores ---
      const teamScoresSnap = await getDocs(
        collection(db, 'games', gameId, 'zone_scores')
      )

      const teamTotals = new Map<string, { points: number; claimed: number }>()
      teamScoresSnap.forEach((d) => {
        const data = d.data() as ZoneScoreData
        const existing = teamTotals.get(data.team_id) || { points: 0, claimed: 0 }
        existing.points += data.points
        if (data.status === 'claimed') existing.claimed += 1
        teamTotals.set(data.team_id, existing)
      })

      for (const [teamId, totals] of teamTotals) {
        const teamRef = doc(db, 'games', gameId, 'teams', teamId)
        await updateDoc(teamRef, {
          total_points: totals.points,
          zones_claimed: totals.claimed,
        })
      }

      // Clear review state for this submission
      setReviewState((prev) => {
        const next = new Map(prev)
        next.delete(sub.id)
        return next
      })
    } catch (err: any) {
      console.error('Approve failed:', err)
      alert('Error approving: ' + (err.message || 'Unknown error'))
    } finally {
      setProcessing(null)
    }
  }

  // ---------- Reject ----------

  const handleReject = async (sub: SubmissionData) => {
    if (!gameId || processing) return

    const review = getReviewState(sub.id)
    if (!review.notes.trim()) {
      alert('Please add a note explaining why you are rejecting this.')
      return
    }

    setProcessing(sub.id)

    try {
      await updateDoc(doc(db, 'submissions', sub.id), {
        status: 'rejected',
        gm_notes: review.notes.trim(),
        reviewed_by: user?.uid || null,
        reviewed_at: serverTimestamp(),
      })

      setReviewState((prev) => {
        const next = new Map(prev)
        next.delete(sub.id)
        return next
      })
    } catch (err: any) {
      console.error('Reject failed:', err)
      alert('Error rejecting: ' + (err.message || 'Unknown error'))
    } finally {
      setProcessing(null)
    }
  }

  // ---------- Game Controls ----------

  const handleEndGame = async () => {
    if (!gameId || !window.confirm('End this game? This cannot be undone.')) return
    await updateDoc(doc(db, 'games', gameId), { status: 'ended' })
  }

  const handlePauseResume = async () => {
    if (!gameId || !game) return
    const newStatus = game.status === 'paused' ? 'active' : 'paused'
    await updateDoc(doc(db, 'games', gameId), { status: newStatus })
  }

  // ---------- Computed values ----------

  const getTeam = (teamId: string) => teams.find((t) => t.id === teamId)

  const filteredSubmissions =
    filter === 'all'
      ? submissions
      : submissions.filter((s) => s.status === filter)

  const pendingCount = submissions.filter((s) => s.status === 'pending').length

  // Zone ownership map (internal format with extra data)
  const zoneOwnership = new Map<
    string,
    { teamId: string; teamColor: string; teamName: string; points: number }
  >()
  for (const zs of zoneScores) {
    if (zs.status === 'claimed') {
      const team = getTeam(zs.team_id)
      if (team) {
        zoneOwnership.set(zs.zone_id, {
          teamId: zs.team_id,
          teamColor: team.color,
          teamName: team.name,
          points: zs.points,
        })
      }
    }
  }

  // ✅ NEW: Convert to GameMap's ZoneOwner format for the mini map
  const mapZoneOwnership = useMemo(() => {
    const m = new Map<string, ZoneOwner>()
    for (const [zoneId, owner] of zoneOwnership) {
      m.set(zoneId, { teamColor: owner.teamColor, teamName: owner.teamName })
    }
    return m
  }, [zoneScores, teams])

  // ✅ NEW: Filter zones data to ones active in this game
  const activeZones = useMemo(
    () => allZoneData.filter((z) => game?.zones?.includes(z.id)),
    [game?.zones]
  )

  // Team scoreboard data, sorted by points descending
  const scoreboard = teams
    .map((t) => {
      const teamZoneScores = zoneScores.filter((zs) => zs.team_id === t.id)
      return {
        ...t,
        total_points: teamZoneScores.reduce((sum, zs) => sum + zs.points, 0),
        zones_claimed: teamZoneScores.filter((zs) => zs.status === 'claimed').length,
        zoneBreakdown: teamZoneScores,
      }
    })
    .sort((a, b) => b.total_points - a.total_points)

  // ---------- Render ----------

  if (loading || !game) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0a0a0a',
          color: '#555',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: 32,
              height: 32,
              border: '3px solid #222',
              borderTopColor: '#FFD166',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto 12px',
            }}
          />
          <p>Loading GM Dashboard...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        color: '#fff',
        fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
        rel="stylesheet"
      />

      {/* ====== TOP BAR ====== */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: '1px solid #1a1a1a',
          background: '#0d0d0d',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                color: '#FFD166',
                textTransform: 'uppercase',
                letterSpacing: 2,
              }}
            >
              GM Dashboard
            </span>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '2px 8px',
                borderRadius: 4,
                background:
                  game.status === 'active'
                    ? 'rgba(6,214,160,0.15)'
                    : game.status === 'paused'
                    ? 'rgba(255,209,102,0.15)'
                    : 'rgba(239,71,111,0.15)',
                color:
                  game.status === 'active'
                    ? '#06D6A0'
                    : game.status === 'paused'
                    ? '#FFD166'
                    : '#EF476F',
                fontWeight: 700,
              }}
            >
              {game.status.toUpperCase()}
            </span>
          </div>
          <h1 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>{game.name}</h1>
          <p style={{ fontSize: '0.78rem', color: '#555', marginTop: 2 }}>
            Code: <span style={{ color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>{game.join_code}</span>
            {' · '}{teams.length} team{teams.length !== 1 ? 's' : ''}
            {' · '}{submissions.length} submission{submissions.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Timer */}
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '1.3rem',
              fontWeight: 700,
              color: timeLeft === 'GAME OVER' ? '#EF476F' : '#FFD166',
            }}
          >
            {timeLeft || '—'}
          </div>

          {/* Game controls */}
          <div style={{ display: 'flex', gap: 8 }}>
            {game.status !== 'ended' && (
              <button
                onClick={handlePauseResume}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid #222',
                  color: '#888',
                  padding: '8px 14px',
                  borderRadius: 8,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {game.status === 'paused' ? '▶ Resume' : '⏸ Pause'}
              </button>
            )}
            {game.status !== 'ended' && (
              <button
                onClick={handleEndGame}
                style={{
                  background: 'rgba(239,71,111,0.08)',
                  border: '1px solid rgba(239,71,111,0.2)',
                  color: '#EF476F',
                  padding: '8px 14px',
                  borderRadius: 8,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                End Game
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ====== MAIN CONTENT — TWO COLUMNS ====== */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 360px',
          gap: 0,
          minHeight: 'calc(100vh - 100px)',
        }}
      >
        {/* ====== LEFT: SUBMISSION FEED ====== */}
        <div
          style={{
            padding: '20px 24px',
            borderRight: '1px solid #1a1a1a',
            overflow: 'auto',
            maxHeight: 'calc(100vh - 100px)',
          }}
        >
          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {(
              [
                { id: 'pending', label: `Pending (${pendingCount})`, color: '#FFD166' },
                { id: 'approved', label: 'Approved', color: '#06D6A0' },
                { id: 'rejected', label: 'Rejected', color: '#EF476F' },
                { id: 'all', label: 'All', color: '#888' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                style={{
                  background: filter === f.id ? `${f.color}15` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${filter === f.id ? `${f.color}40` : '#1a1a1a'}`,
                  color: filter === f.id ? f.color : '#555',
                  padding: '6px 14px',
                  borderRadius: 8,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Submission cards */}
          {filteredSubmissions.length === 0 ? (
            <div style={{ textAlign: 'center', marginTop: 80, color: '#333' }}>
              <p style={{ fontSize: '2rem', marginBottom: 12 }}>
                {filter === 'pending' ? '✅' : '📋'}
              </p>
              <p style={{ color: '#555', fontWeight: 600 }}>
                {filter === 'pending'
                  ? 'No pending submissions'
                  : `No ${filter} submissions`}
              </p>
              <p style={{ color: '#333', fontSize: '0.82rem', marginTop: 6 }}>
                {filter === 'pending'
                  ? "You're all caught up! Waiting for teams to submit..."
                  : 'Try switching the filter.'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 16 }}>
              {filteredSubmissions.map((sub) => {
                const challenge = challenges.get(sub.challenge_id)
                const team = getTeam(sub.team_id)
                const review = getReviewState(sub.id)
                const isProcessing = processing === sub.id
                const diffColor = DIFFICULTY_COLORS[challenge?.difficulty || 'medium'] || '#FFD166'
                const basePts = DIFFICULTY_PTS[challenge?.difficulty || 'medium'] || 3

                // ✅ NEW: GPS proximity check
                const gpsCheck = checkGpsProximity(sub)

                return (
                  <div
                    key={sub.id}
                    style={{
                      background:
                        sub.status === 'pending'
                          ? 'rgba(255,209,102,0.02)'
                          : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${
                        sub.status === 'pending' ? 'rgba(255,209,102,0.15)' : '#1a1a1a'
                      }`,
                      borderRadius: 14,
                      padding: 20,
                      opacity: isProcessing ? 0.6 : 1,
                      transition: 'opacity 0.2s',
                    }}
                  >
                    {/* Team + difficulty + status header */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 3,
                            background: team?.color || '#555',
                          }}
                        />
                        <span style={{ fontWeight: 700, fontSize: '0.88rem' }}>
                          {team?.name || sub.team_id}
                        </span>
                        <span
                          style={{
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: `${diffColor}15`,
                            color: diffColor,
                          }}
                        >
                          {challenge?.difficulty?.toUpperCase() || '?'} · {basePts}pt
                        </span>
                      </div>
                      {sub.status !== 'pending' && (
                        <span
                          style={{
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            padding: '3px 10px',
                            borderRadius: 4,
                            background:
                              sub.status === 'approved'
                                ? 'rgba(6,214,160,0.12)'
                                : 'rgba(239,71,111,0.12)',
                            color:
                              sub.status === 'approved' ? '#06D6A0' : '#EF476F',
                          }}
                        >
                          {sub.status === 'approved' ? '✅ Approved' : '❌ Rejected'}
                        </span>
                      )}
                    </div>

                    {/* Challenge description */}
                    <p
                      style={{
                        color: '#ccc',
                        fontSize: '0.88rem',
                        lineHeight: 1.6,
                        marginBottom: 14,
                        background: 'rgba(255,255,255,0.02)',
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: '1px solid #111',
                      }}
                    >
                      {challenge?.description || `Challenge: ${sub.challenge_id}`}
                    </p>

                    {/* Media preview */}
                    <div style={{ marginBottom: 14 }}>
                      {sub.media_type === 'video' ? (
                        <video
                          src={sub.media_url}
                          controls
                          style={{
                            width: '100%',
                            maxHeight: 280,
                            borderRadius: 10,
                            background: '#111',
                            objectFit: 'contain',
                          }}
                        />
                      ) : sub.media_type === 'audio' ? (
                        <div
                          style={{
                            background: '#111',
                            borderRadius: 10,
                            padding: 16,
                            textAlign: 'center',
                          }}
                        >
                          <span style={{ fontSize: '1.5rem' }}>🎙️</span>
                          <audio
                            src={sub.media_url}
                            controls
                            style={{ width: '100%', marginTop: 8 }}
                          />
                        </div>
                      ) : (
                        <img
                          src={sub.media_url}
                          alt="Submission"
                          style={{
                            width: '100%',
                            maxHeight: 280,
                            borderRadius: 10,
                            background: '#111',
                            objectFit: 'contain',
                          }}
                        />
                      )}
                    </div>

                    {/* Metadata row: GPS, zone, time + ✅ NEW: proximity indicator */}
                    <div
                      style={{
                        display: 'flex',
                        gap: 16,
                        flexWrap: 'wrap',
                        fontSize: '0.75rem',
                        color: '#555',
                        marginBottom: sub.status === 'pending' ? 16 : 0,
                      }}
                    >
                      {sub.zone_id && (
                        <span>
                          📍 Zone: <span style={{ color: '#888' }}>{sub.zone_id.replace('zone_district_', 'D')}</span>
                        </span>
                      )}
                      {!sub.zone_id && <span style={{ color: '#EF476F' }}>⚠ No zone detected</span>}
                      {sub.gps_lat && sub.gps_lng && (
                        <span>
                          GPS: {sub.gps_lat.toFixed(4)}, {sub.gps_lng.toFixed(4)}
                        </span>
                      )}
                      {sub.submitted_at && (
                        <span>
                          {sub.submitted_at.toDate
                            ? sub.submitted_at.toDate().toLocaleTimeString()
                            : ''}
                        </span>
                      )}

                      {/* ✅ NEW: GPS proximity badge */}
                      {gpsCheck === 'inside' && (
                        <span style={{ color: '#06D6A0', fontWeight: 600 }}>
                          ✓ GPS in zone
                        </span>
                      )}
                      {gpsCheck === 'outside' && (
                        <span style={{ color: '#EF476F', fontWeight: 700 }}>
                          ⚠ GPS OUTSIDE zone
                        </span>
                      )}
                    </div>

                    {/* ✅ NEW: GPS proximity warning banner (pending submissions only) */}
                    {gpsCheck === 'outside' && sub.status === 'pending' && (
                      <div
                        style={{
                          background: 'rgba(239,71,111,0.06)',
                          border: '1px solid rgba(239,71,111,0.2)',
                          borderRadius: 8,
                          padding: '8px 14px',
                          marginBottom: 14,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: '1rem' }}>🚩</span>
                        <div>
                          <p style={{
                            color: '#EF476F',
                            fontSize: '0.78rem',
                            fontWeight: 700,
                            marginBottom: 2,
                          }}>
                            GPS Location Mismatch
                          </p>
                          <p style={{
                            color: '#999',
                            fontSize: '0.72rem',
                            lineHeight: 1.4,
                          }}>
                            Player's GPS was outside {sub.zone_id?.replace('zone_district_', 'District ')} when they submitted.
                            This could be a GPS glitch or they may not have been in the zone.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* ====== PENDING: Review controls ====== */}
                    {sub.status === 'pending' && (
                      <div>
                        {/* Bonus claims from player */}
                        <div
                          style={{
                            display: 'flex',
                            gap: 12,
                            flexWrap: 'wrap',
                            marginBottom: 14,
                          }}
                        >
                          {/* Tier 2 toggle */}
                          {sub.attempted_tier2 && challenge?.tier2 && (
                            <button
                              onClick={() =>
                                updateReviewState(sub.id, {
                                  tier2Approved: !review.tier2Approved,
                                })
                              }
                              style={{
                                background: review.tier2Approved
                                  ? 'rgba(155,93,229,0.12)'
                                  : 'rgba(255,255,255,0.03)',
                                border: `1px solid ${
                                  review.tier2Approved ? 'rgba(155,93,229,0.3)' : '#222'
                                }`,
                                color: review.tier2Approved ? '#9B5DE5' : '#666',
                                padding: '8px 14px',
                                borderRadius: 8,
                                fontSize: '0.78rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              {review.tier2Approved ? '✓' : '○'} Tier 2 (+
                              {challenge.tier2.bonus_points}pt)
                            </button>
                          )}

                          {/* Phone-free bonus selector */}
                          {sub.phone_free_claimed && (
                            <div style={{ display: 'flex', gap: 4 }}>
                              {[
                                { value: 0, label: 'No bonus' },
                                { value: 1, label: '+1 📵' },
                                { value: 2, label: '+2 🤫' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() =>
                                    updateReviewState(sub.id, {
                                      phoneFreeBonus: opt.value,
                                    })
                                  }
                                  style={{
                                    background:
                                      review.phoneFreeBonus === opt.value
                                        ? 'rgba(6,214,160,0.12)'
                                        : 'rgba(255,255,255,0.03)',
                                    border: `1px solid ${
                                      review.phoneFreeBonus === opt.value
                                        ? 'rgba(6,214,160,0.3)'
                                        : '#222'
                                    }`,
                                    color:
                                      review.phoneFreeBonus === opt.value
                                        ? '#06D6A0'
                                        : '#666',
                                    padding: '8px 12px',
                                    borderRadius: 8,
                                    fontSize: '0.75rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Points preview */}
                        {(() => {
                          const tierPts =
                            sub.attempted_tier2 && review.tier2Approved && challenge?.tier2
                              ? challenge.tier2.bonus_points
                              : 0
                          const pfPts = sub.phone_free_claimed ? review.phoneFreeBonus : 0
                          const total = basePts + tierPts + pfPts

                          return (
                            <div
                              style={{
                                background: 'rgba(255,255,255,0.03)',
                                borderRadius: 8,
                                padding: '8px 14px',
                                marginBottom: 14,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                              }}
                            >
                              <span style={{ fontSize: '0.78rem', color: '#888' }}>
                                {basePts}pt base
                                {tierPts > 0 && ` + ${tierPts}pt tier2`}
                                {pfPts > 0 && ` + ${pfPts}pt phone-free`}
                              </span>
                              <span
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontSize: '1rem',
                                  fontWeight: 700,
                                  color: '#FFD166',
                                }}
                              >
                                = {total}pt{total !== 1 ? 's' : ''}
                              </span>
                            </div>
                          )
                        })()}

                        {/* GM notes (for rejection) */}
                        <input
                          type="text"
                          placeholder="Rejection reason (required to reject)"
                          value={review.notes}
                          onChange={(e) =>
                            updateReviewState(sub.id, { notes: e.target.value })
                          }
                          style={{
                            width: '100%',
                            background: '#111',
                            border: '1px solid #222',
                            borderRadius: 8,
                            padding: '10px 14px',
                            color: '#ccc',
                            fontSize: '0.82rem',
                            fontFamily: 'inherit',
                            marginBottom: 12,
                            boxSizing: 'border-box',
                          }}
                        />

                        {/* Approve / Reject buttons */}
                        <div style={{ display: 'flex', gap: 10 }}>
                          <button
                            onClick={() => handleApprove(sub)}
                            disabled={isProcessing}
                            style={{
                              flex: 2,
                              background: 'rgba(6,214,160,0.15)',
                              border: '1px solid rgba(6,214,160,0.3)',
                              color: '#06D6A0',
                              padding: '12px 20px',
                              borderRadius: 10,
                              fontSize: '0.9rem',
                              fontWeight: 700,
                              cursor: isProcessing ? 'wait' : 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            {isProcessing ? 'Processing...' : '✓ Approve'}
                          </button>
                          <button
                            onClick={() => handleReject(sub)}
                            disabled={isProcessing}
                            style={{
                              flex: 1,
                              background: 'rgba(239,71,111,0.08)',
                              border: '1px solid rgba(239,71,111,0.2)',
                              color: '#EF476F',
                              padding: '12px 20px',
                              borderRadius: 10,
                              fontSize: '0.9rem',
                              fontWeight: 700,
                              cursor: isProcessing ? 'wait' : 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            ✗ Reject
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Already-rejected notes */}
                    {sub.status === 'rejected' && sub.gm_notes && (
                      <p
                        style={{
                          color: '#EF476F',
                          fontSize: '0.82rem',
                          marginTop: 10,
                          fontStyle: 'italic',
                        }}
                      >
                        GM: {sub.gm_notes}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ====== RIGHT: SCOREBOARD + MINI MAP ====== */}
        <div
          style={{
            padding: '20px',
            overflow: 'auto',
            maxHeight: 'calc(100vh - 100px)',
            background: '#0d0d0d',
          }}
        >
          {/* Scoreboard header */}
          <p
            style={{
              fontSize: '0.72rem',
              color: '#FFD166',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              fontWeight: 700,
              marginBottom: 16,
            }}
          >
            Scoreboard
          </p>

          {/* Team scores */}
          <div style={{ display: 'grid', gap: 12, marginBottom: 28 }}>
            {scoreboard.map((team, rank) => (
              <div
                key={team.id}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${rank === 0 && team.total_points > 0 ? `${team.color}40` : '#1a1a1a'}`,
                  borderRadius: 12,
                  padding: '14px 16px',
                }}
              >
                {/* Team header */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: team.color,
                      }}
                    />
                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                      {team.name}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '1.1rem',
                      fontWeight: 700,
                      color: team.total_points > 0 ? '#fff' : '#333',
                    }}
                  >
                    {team.total_points}
                  </span>
                </div>

                {/* Zone breakdown */}
                {team.zoneBreakdown.length > 0 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {team.zoneBreakdown.map((zs) => (
                      <span
                        key={zs.zone_id}
                        style={{
                          fontSize: '0.68rem',
                          padding: '3px 8px',
                          borderRadius: 4,
                          background:
                            zs.status === 'claimed'
                              ? `${team.color}20`
                              : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${
                            zs.status === 'claimed' ? `${team.color}40` : '#1a1a1a'
                          }`,
                          color: zs.status === 'claimed' ? team.color : '#555',
                          fontWeight: 600,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                      >
                        {zs.zone_id.replace('zone_district_', 'D')} · {zs.points}pt
                        {zs.status === 'claimed' ? ' ★' : ''}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.75rem', color: '#333', fontStyle: 'italic' }}>
                    No points yet
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Zone ownership summary */}
          <p
            style={{
              fontSize: '0.72rem',
              color: '#FFD166',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            Zone Control
          </p>

          <div style={{ display: 'grid', gap: 8, marginBottom: 24 }}>
            {game.zones.map((zoneId) => {
              const owner = zoneOwnership.get(zoneId)
              return (
                <div
                  key={zoneId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 14px',
                    background: owner
                      ? `${owner.teamColor}08`
                      : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${owner ? `${owner.teamColor}30` : '#1a1a1a'}`,
                    borderRadius: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.82rem',
                      color: owner ? '#ccc' : '#444',
                      fontWeight: 600,
                    }}
                  >
                    {zoneId.replace('zone_district_', 'District ')}
                  </span>
                  {owner ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: owner.teamColor,
                        }}
                      />
                      <span
                        style={{
                          fontSize: '0.78rem',
                          color: owner.teamColor,
                          fontWeight: 600,
                        }}
                      >
                        {owner.teamName}
                      </span>
                    </div>
                  ) : (
                    <span
                      style={{
                        fontSize: '0.75rem',
                        color: '#333',
                        fontStyle: 'italic',
                      }}
                    >
                      Unclaimed
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* ====== ✅ NEW: MINI MAP ====== */}
          <p
            style={{
              fontSize: '0.72rem',
              color: '#FFD166',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            Live Map
          </p>

          <div
            style={{
              height: 240,
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid #1a1a1a',
              background: '#111',
            }}
          >
            {activeZones.length > 0 ? (
              <GameMap
                zones={activeZones}
                zoneOwnership={mapZoneOwnership.size > 0 ? mapZoneOwnership : undefined}
                compact
              />
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#333',
                  fontSize: '0.78rem',
                }}
              >
                No zone data loaded
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}