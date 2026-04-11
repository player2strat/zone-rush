// =============================================================================
// Zone Rush — GM Dashboard (v3)
// CHANGES:
// - End-game bonuses renamed to Side Quests
// - New point values: Most Zones (+5), Most Transit Modes (+4), Most Challenges (+3)
// - Removed Fastest Return and Hydration bonuses
// - Most Challenges auto-calculated like Most Zones
// =============================================================================

import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, onSnapshot, collection, query, where, orderBy,
  updateDoc, setDoc, getDoc, getDocs, serverTimestamp,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import { isPointInPolygon } from '../lib/geo'
import GameMap from '../components/GameMap'
import type { ZoneOwner, PlayerLocation } from '../components/GameMap'
import {
  sendGMBroadcast,
  sendGMReply,
  subscribeToGMMessages,
  markMessagesRead,
} from '../lib/chat'
import {
  getTeamBonusSummaries,
  autoSelectMostZones,
  autoSelectMostChallenges,
  applyEndGameBonuses,
  type BonusAwards,
  type TeamBonusSummary,
} from '../lib/endGame'

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
    closed_zones?: string[]
    bonuses_applied?: boolean
    milestone_broadcasts_sent?: string[]
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
  const navigate = useNavigate()
  const user = auth.currentUser

  const [game, setGame] = useState<GameData | null>(null)
  const [teams, setTeams] = useState<TeamData[]>([])
  const [submissions, setSubmissions] = useState<SubmissionData[]>([])
  const [challenges, setChallenges] = useState<Map<string, ChallengeData>>(new Map())
  const [zoneScores, setZoneScores] = useState<ZoneScoreData[]>([])
  const [loading, setLoading] = useState(true)
  const [allZoneData, setAllZoneData] = useState<any[]>([])

  const [reviewState, setReviewState] = useState<
    Map<string, { tier2Approved: boolean; phoneFreeBonus: number; notes: string }>
  >(new Map())
  const [processing, setProcessing] = useState<string | null>(null)

  const [activeTab, setActiveTab] = useState<'submissions' | 'map' | 'chat'>('submissions')
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const [showFullMap, setShowFullMap] = useState(false)
  const [timeLeft, setTimeLeft] = useState('')

  const [chatMessages, setChatMessages] = useState<any[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [broadcastInput, setBroadcastInput] = useState('')
  const [broadcasting, setBroadcasting] = useState(false)
  const chatBottomRef = useRef<HTMLDivElement>(null)

  // Side Quests state
  const [bonusSummaries, setBonusSummaries] = useState<TeamBonusSummary[]>([])
  const [bonusAwards, setBonusAwards] = useState<BonusAwards>({
    mostZones: null,
    mostTransitModes: null,
    mostChallenges: null,
  })
  const [applyingBonuses, setApplyingBonuses] = useState(false)
  const [bonusesApplied, setBonusesApplied] = useState(false)

  // Load zones
  useEffect(() => {
    async function loadZones() {
      const snapshot = await getDocs(collection(db, 'zones'))
      const loaded = snapshot.docs.map((d) => {
        const data = d.data()
        return { ...data, boundary: typeof data.boundary === 'string' ? JSON.parse(data.boundary) : data.boundary }
      })
      setAllZoneData(loaded)
    }
    loadZones()
  }, [])

  const zoneDataMap = useMemo(() => new Map(allZoneData.map((z: any) => [z.id, z])), [allZoneData])

  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (snap.exists()) setGame({ id: snap.id, ...snap.data() } as GameData)
    })
    return () => unsub()
  }, [gameId])

  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(collection(db, 'games', gameId, 'teams'), (snap) => {
      const t: TeamData[] = []
      snap.forEach((d) => t.push({ id: d.id, ...d.data() } as TeamData))
      setTeams(t)
    })
    return () => unsub()
  }, [gameId])

  useEffect(() => {
    if (!gameId) return
    const q = query(collection(db, 'submissions'), where('game_id', '==', gameId), orderBy('submitted_at', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const subs: SubmissionData[] = []
      snap.forEach((d) => subs.push({ id: d.id, ...d.data() } as SubmissionData))
      setSubmissions(subs)
      setLoading(false)
    })
    return () => unsub()
  }, [gameId])

  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(collection(db, 'games', gameId, 'zone_scores'), (snap) => {
      const scores: ZoneScoreData[] = []
      snap.forEach((d) => scores.push({ ...d.data() } as ZoneScoreData))
      setZoneScores(scores)
    })
    return () => unsub()
  }, [gameId])

  useEffect(() => {
    const loadChallenges = async () => {
      const snap = await getDocs(collection(db, 'challenges'))
      const map = new Map<string, ChallengeData>()
      snap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() } as ChallengeData))
      setChallenges(map)
    }
    loadChallenges()
  }, [])

  useEffect(() => {
    if (!game?.ends_at) return
    if (game.status === 'ended') { setTimeLeft('GAME OVER'); return }

    const interval = setInterval(async () => {
      const end = game.ends_at.toDate ? game.ends_at.toDate() : new Date(game.ends_at)
      const diff = end.getTime() - Date.now()
      if (diff <= 0) {
        setTimeLeft('GAME OVER')
        clearInterval(interval)
        // Write ended status to Firestore so players and redirect logic see it
        if (gameId) {
          await updateDoc(doc(db, 'games', gameId), { status: 'ended' })
        }
        return
      }

      const hrs = Math.floor(diff / 3600000)
      const mins = Math.floor((diff % 3600000) / 60000)
      const secs = Math.floor((diff % 60000) / 1000)
      setTimeLeft(hrs > 0 ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${mins}:${String(secs).padStart(2, '0')}`)

      // ---- Automated milestone broadcasts ----
      // Only fires once per milestone, persisted on the game doc so it
      // survives GM browser refreshes and doesn't double-send.
      if (!gameId || !user || game.status !== 'active') return

      const totalMins = game.settings.duration_minutes ?? 180
      const minsRemaining = Math.floor(diff / 60000)
      const halfwayMins = Math.floor(totalMins / 2)

      const milestones: { key: string; minsRemaining: number; message: string }[] = [
        {
          key: 'halfway',
          minsRemaining: halfwayMins,
          message: `⏱ Halfway point! You have ${halfwayMins} minutes left. Check the map — now's a good time to make your move.`,
        },
        {
          key: '30min',
          minsRemaining: 30,
          message: `⚠️ 30 minutes remaining! Start thinking about your return route and final zone pushes.`,
        },
        {
          key: '5min',
          minsRemaining: 5,
          message: `🚨 5 minutes left! Head back to the start now. Don't forget Side Quests — most zones, most transport modes, most challenges.`,
        },
      ]

      const alreadySent: string[] = game.milestone_broadcasts_sent ?? []

      for (const milestone of milestones) {
        // Fire when the countdown ticks to exactly that minute (within the same tick)
        if (
          minsRemaining === milestone.minsRemaining &&
          secs === 0 &&
          !alreadySent.includes(milestone.key)
        ) {
          try {
            await sendGMBroadcast(gameId, user.uid, 'Zone Rush', milestone.message)
            await updateDoc(doc(db, 'games', gameId), {
              milestone_broadcasts_sent: [...alreadySent, milestone.key],
            })
          } catch (err) {
            console.error('Milestone broadcast failed:', err, milestone.key)
          }
          break // Only one milestone per tick
        }
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [game?.ends_at, game?.status, game?.milestone_broadcasts_sent])

  useEffect(() => {
    if (!gameId) return
    const unsub = subscribeToGMMessages(gameId, (msgs) => {
      setChatMessages(msgs)
      setTimeout(() => chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    })
    return () => unsub()
  }, [gameId])

  useEffect(() => {
    if (!gameId || !user || !selectedTeamId) return
    markMessagesRead(gameId, user.uid, selectedTeamId)
  }, [selectedTeamId, gameId, user?.uid])

  // Auto-calculate Side Quests when game ends
  useEffect(() => {
    if (game?.status !== 'ended' || !gameId) return
    if (game.bonuses_applied) { setBonusesApplied(true); return }
    getTeamBonusSummaries(gameId).then((summaries) => {
      setBonusSummaries(summaries)
      const autoZones = autoSelectMostZones(summaries)
      const autoChallenges = autoSelectMostChallenges(summaries)
      setBonusAwards((prev) => ({
        ...prev,
        mostZones: autoZones,
        mostChallenges: autoChallenges,
      }))
    })
  }, [game?.status, game?.bonuses_applied, gameId])

  // Chat handlers
  const handleGMReply = async () => {
    if (!chatInput.trim() || !gameId || !user || !selectedTeamId || chatSending) return
    setChatSending(true)
    try {
      await sendGMReply(gameId, user.uid, user.displayName || 'GM', selectedTeamId, chatInput.trim())
      setChatInput('')
    } catch { alert('Failed to send. Try again.') }
    finally { setChatSending(false) }
  }

  const handleBroadcast = async () => {
    if (!broadcastInput.trim() || !gameId || !user || broadcasting) return
    setBroadcasting(true)
    try {
      await sendGMBroadcast(gameId, user.uid, user.displayName || 'GM', broadcastInput.trim())
      setBroadcastInput('')
    } catch { alert('Failed to broadcast. Try again.') }
    finally { setBroadcasting(false) }
  }

  const handleCloseZone = async (zoneId: string) => {
    if (!gameId || !game) return
    const current = game.closed_zones ?? []
    const isAlreadyClosed = current.includes(zoneId)
    const confirmed = window.confirm(
      isAlreadyClosed
        ? `Reopen ${zoneId.replace('zone_district_', 'District ')}?`
        : `Close ${zoneId.replace('zone_district_', 'District ')} now?`
    )
    if (!confirmed) return
    const updated = isAlreadyClosed ? current.filter((z) => z !== zoneId) : [...current, zoneId]
    await updateDoc(doc(db, 'games', gameId), { closed_zones: updated })
  }

  const handleApplyBonuses = async () => {
    if (!gameId || applyingBonuses) return
    setApplyingBonuses(true)
    try {
      await applyEndGameBonuses(gameId, bonusAwards)
      setBonusesApplied(true)
    } catch (err: any) { alert('Failed to apply bonuses: ' + err.message) }
    finally { setApplyingBonuses(false) }
  }

  const getReviewState = (subId: string) =>
    reviewState.get(subId) || { tier2Approved: false, phoneFreeBonus: 0, notes: '' }

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

  const checkGpsProximity = (sub: SubmissionData): 'inside' | 'outside' | 'unknown' => {
    if (!sub.gps_lat || !sub.gps_lng || !sub.zone_id) return 'unknown'
    const zone = zoneDataMap.get(sub.zone_id)
    if (!zone?.boundary?.coordinates) return 'unknown'
    return isPointInPolygon(sub.gps_lat, sub.gps_lng, zone.boundary.coordinates) ? 'inside' : 'outside'
  }

  const handleApprove = async (sub: SubmissionData) => {
    if (!gameId || !game || processing) return
    const closedZones = game.closed_zones ?? []
    if (closedZones.includes(sub.zone_id)) {
      const confirmed = window.confirm(`⚠️ ${sub.zone_id.replace('zone_district_', 'District ')} is closed — approve anyway?`)
      if (!confirmed) return
    }
    setProcessing(sub.id)
    try {
      const challenge = challenges.get(sub.challenge_id)
      if (!challenge) throw new Error('Challenge not found')
      const review = getReviewState(sub.id)
      const claimThreshold = game.settings.claim_threshold ?? 6
      const basePoints = DIFFICULTY_PTS[challenge.difficulty] || 3
      const tier2Points = sub.attempted_tier2 && review.tier2Approved && challenge.tier2 ? challenge.tier2.bonus_points : 0
      const phoneFreePoints = sub.phone_free_claimed ? review.phoneFreeBonus : 0
      const totalPointsEarned = basePoints + tier2Points + phoneFreePoints

      await updateDoc(doc(db, 'submissions', sub.id), {
        status: 'approved', tier2_approved: review.tier2Approved,
        reviewed_by: user?.uid || null, reviewed_at: serverTimestamp(), gm_notes: '',
        points_awarded: totalPointsEarned,
      })

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

      const zoneBonusPts = game.settings.zone_bonus_points ?? 3
      const crossingThreshold = currentPoints < claimThreshold && (currentPoints + totalPointsEarned) >= claimThreshold
      const bonusPoints = crossingThreshold ? zoneBonusPts : 0
      const newPoints = currentPoints + totalPointsEarned + bonusPoints
      completedChallenges.push(sub.challenge_id)
      const newStatus: 'none' | 'claimed' = newPoints >= claimThreshold ? 'claimed' : 'none'

      await setDoc(scoreRef, {
        team_id: sub.team_id, zone_id: zoneId, points: newPoints,
        status: newStatus, challenges_completed: completedChallenges,
      })

      if (newStatus === 'claimed') {
        const allScoresSnap = await getDocs(collection(db, 'games', gameId, 'zone_scores'))
        let highestPoints = 0; let highestTeam = ''
        allScoresSnap.forEach((d) => {
          const data = d.data() as ZoneScoreData
          if (data.zone_id === zoneId && data.points > highestPoints) {
            highestPoints = data.points; highestTeam = data.team_id
          }
        })
        for (const d of allScoresSnap.docs) {
          const data = d.data() as ZoneScoreData
          if (data.zone_id === zoneId) {
            const shouldBeClaimed = data.team_id === highestTeam && data.points >= claimThreshold
            if ((shouldBeClaimed && data.status !== 'claimed') || (!shouldBeClaimed && data.status === 'claimed')) {
              await updateDoc(d.ref, { status: shouldBeClaimed ? 'claimed' : 'none' })
            }
          }
        }
        const previousOwner = zoneOwnership.get(zoneId)
        if (previousOwner && previousOwner.teamId !== sub.team_id && highestTeam === sub.team_id) {
          const stolenByTeam = getTeam(highestTeam)
          await sendGMBroadcast(gameId, user?.uid ?? '', 'Game Master',
            `🔁 Zone ${zoneId.replace('zone_district_', 'District ')} was just stolen by ${stolenByTeam?.name ?? 'a team'}!`)
        }
      }

      const teamScoresSnap = await getDocs(collection(db, 'games', gameId, 'zone_scores'))
      const teamTotals = new Map<string, { points: number; claimed: number }>()
      teamScoresSnap.forEach((d) => {
        const data = d.data() as ZoneScoreData
        const existing = teamTotals.get(data.team_id) || { points: 0, claimed: 0 }
        existing.points += data.points
        if (data.status === 'claimed') existing.claimed += 1
        teamTotals.set(data.team_id, existing)
      })
      for (const [teamId, totals] of teamTotals) {
        await updateDoc(doc(db, 'games', gameId, 'teams', teamId), {
          total_points: totals.points, zones_claimed: totals.claimed,
        })
      }

      try {
        const teamRef = doc(db, 'games', gameId, 'teams', sub.team_id)
        const teamSnap = await getDoc(teamRef)
        if (teamSnap.exists()) {
          const teamData = teamSnap.data() as TeamData
          const currentHand = teamData.hand || []
          const updatedHand = currentHand.filter((id: string) => id !== sub.challenge_id)

          const teamSubsSnap = await getDocs(query(collection(db, 'submissions'), where('game_id', '==', gameId), where('team_id', '==', sub.team_id)))
          const usedChallengeIds = new Set<string>()
          teamSubsSnap.forEach((d) => usedChallengeIds.add(d.data().challenge_id))
          updatedHand.forEach((id: string) => usedChallengeIds.add(id))

          const gameCity = 'nyc'
          const eligible: string[] = []
          challenges.forEach((ch, chId) => {
            if (usedChallengeIds.has(chId) || !ch.points) return
            const cityTags = (ch as any).city_tags || ['*']
            if (!cityTags.includes('*') && !cityTags.includes(gameCity)) return
            eligible.push(chId)
          })

          if (eligible.length > 0) {
            const handMinEasy = game.settings.hand_min_easy ?? 1
            const handMinHard = game.settings.hand_min_hard ?? 1
            const handMaxHard = game.settings.hand_max_hard ?? 2

            const remainingEasy = updatedHand.filter((id: string) => challenges.get(id)?.difficulty === 'easy').length
            const remainingHard = updatedHand.filter((id: string) => challenges.get(id)?.difficulty === 'hard').length

            let preferredDiff: 'easy' | 'hard' | 'not_hard' | null = null
            if (remainingEasy < handMinEasy) preferredDiff = 'easy'
            else if (remainingHard < handMinHard) preferredDiff = 'hard'
            else if (remainingHard >= handMaxHard) preferredDiff = 'not_hard'

            const preferred = eligible.filter((id) => {
              const diff = challenges.get(id)?.difficulty
              if (preferredDiff === 'easy') return diff === 'easy'
              if (preferredDiff === 'hard') return diff === 'hard'
              if (preferredDiff === 'not_hard') return diff !== 'hard'
              return true
            })

            const drawPool = preferred.length > 0 ? preferred : eligible
            updatedHand.push(drawPool[Math.floor(Math.random() * drawPool.length)])
          }

          await updateDoc(teamRef, { hand: updatedHand })
        }
      } catch (dealErr) { console.error('Replacement card dealing failed:', dealErr) }

      setReviewState((prev) => { const next = new Map(prev); next.delete(sub.id); return next })
    } catch (err: any) {
      console.error('Approve failed:', err)
      alert('Error approving: ' + (err.message || 'Unknown error'))
    } finally { setProcessing(null) }
  }

  const handleReject = async (sub: SubmissionData) => {
    if (!gameId || processing) return
    const review = getReviewState(sub.id)
    if (!review.notes.trim()) { alert('Please add a note explaining why you are rejecting this.'); return }
    setProcessing(sub.id)
    try {
      await updateDoc(doc(db, 'submissions', sub.id), {
        status: 'rejected', gm_notes: review.notes.trim(),
        reviewed_by: user?.uid || null, reviewed_at: serverTimestamp(),
      })
      setReviewState((prev) => { const next = new Map(prev); next.delete(sub.id); return next })
    } catch (err: any) { alert('Error rejecting: ' + (err.message || 'Unknown error')) }
    finally { setProcessing(null) }
  }

  const handleEndGame = async () => {
    if (!gameId || !window.confirm('End this game? This cannot be undone.')) return
    await updateDoc(doc(db, 'games', gameId), { status: 'ended' })
    window.location.href = '/'
  }

  const handlePauseResume = async () => {
    if (!gameId || !game) return
    await updateDoc(doc(db, 'games', gameId), { status: game.status === 'paused' ? 'active' : 'paused' })
  }

  const getTeam = (teamId: string) => teams.find((t) => t.id === teamId)
  const filteredSubmissions = filter === 'all' ? submissions : submissions.filter((s) => s.status === filter)
  const pendingCount = submissions.filter((s) => s.status === 'pending').length
  const totalUnread = chatMessages.filter((m) => m.channel_type === 'team_to_gm' && !m.read_by?.includes(user?.uid)).length

  const zoneOwnership = new Map<string, { teamId: string; teamColor: string; teamName: string; points: number }>()
  // Track ALL zone scores (not just claimed) so the map can show partial progress shading
  for (const zs of zoneScores) {
    if (zs.points > 0) {
      const team = getTeam(zs.team_id)
      if (!team) continue
      // If multiple teams have points in the same zone, show the leading team
      const existing = zoneOwnership.get(zs.zone_id)
      if (!existing || zs.points > existing.points) {
        zoneOwnership.set(zs.zone_id, { teamId: zs.team_id, teamColor: team.color, teamName: team.name, points: zs.points })
      }
    }
  }
  const mapZoneOwnership = useMemo(() => {
    const m = new Map<string, ZoneOwner>()
    const claimThreshold = game?.settings.claim_threshold ?? 6
    for (const [zoneId, owner] of zoneOwnership) {
      m.set(zoneId, { teamColor: owner.teamColor, teamName: owner.teamName, points: owner.points, claimed: owner.points >= claimThreshold })
    }
    return m
  }, [zoneScores, teams, game?.settings.claim_threshold])

  // Build player location list from team member_locations for the GM map
    const playerLocations = useMemo<PlayerLocation[]>(() => {
      const locations: PlayerLocation[] = []
      teams.forEach((team) => {
        const memberLocs = (team as any).member_locations
        if (!memberLocs) return
        Object.entries(memberLocs).forEach(([uid, loc]: [string, any]) => {
          // Only show locations updated in the last 2 minutes
          if (!loc.lat || !loc.lng) return
          if (Date.now() - (loc.updated_at ?? 0) > 300000) return
          locations.push({
            uid,
            lat: loc.lat,
            lng: loc.lng,
            name: loc.name || 'Player',
            teamColor: team.color,
          })
        })
      })
      return locations
    }, [teams])

  const activeZones = useMemo(() => allZoneData.filter((z: any) => game?.zones?.includes(z.id)), [game?.zones, allZoneData])

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

  if (loading || !game) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif" }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 32, height: 32, border: '3px solid #222', borderTopColor: '#FFD166', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <p>Loading GM Dashboard...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif", display: 'flex', flexDirection: 'column' }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* TOP BAR */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #1a1a1a', background: '#0d0d0d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, flexShrink: 0 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.68rem', color: '#FFD166', textTransform: 'uppercase', letterSpacing: 2 }}>GM Dashboard</span>
            <span style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 4, background: game.status === 'active' ? 'rgba(6,214,160,0.15)' : game.status === 'paused' ? 'rgba(255,209,102,0.15)' : 'rgba(239,71,111,0.15)', color: game.status === 'active' ? '#06D6A0' : game.status === 'paused' ? '#FFD166' : '#EF476F', fontWeight: 700 }}>
              {game.status.toUpperCase()}
            </span>
          </div>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>{game.name}</h1>
          <p style={{ fontSize: '0.75rem', color: '#555', marginTop: 2 }}>
            Code: <span style={{ color: '#888', fontFamily: "'JetBrains Mono', monospace" }}>{game.join_code}</span>
            {' · '}{teams.length} team{teams.length !== 1 ? 's' : ''}
            {' · '}{submissions.length} submissions
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1.2rem', fontWeight: 700, color: timeLeft === 'GAME OVER' ? '#EF476F' : '#FFD166' }}>
            {timeLeft || '—'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {game.status !== 'ended' && (
              <button onClick={handlePauseResume} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #222', color: '#888', padding: '7px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                {game.status === 'paused' ? '▶ Resume' : '⏸ Pause'}
              </button>
            )}
            {game.status !== 'ended' && (
              <button onClick={handleEndGame} style={{ background: 'rgba(239,71,111,0.08)', border: '1px solid rgba(239,71,111,0.2)', color: '#EF476F', padding: '7px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                End Game
              </button>
            )}
            {game.status === 'ended' && (
              <button onClick={() => navigate('/results/' + gameId)} style={{ background: 'rgba(255,209,102,0.12)', border: '1px solid rgba(255,209,102,0.3)', color: '#FFD166', padding: '7px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                🏆 View Results
              </button>
            )}
          </div>
        </div>
      </div>

      {/* TAB BAR */}
      <div style={{ borderBottom: '1px solid #1a1a1a', background: '#0d0d0d', display: 'flex', padding: '0 20px', flexShrink: 0 }}>
        {([
          { id: 'submissions' as const, label: '📋 Submissions', badge: pendingCount > 0 ? pendingCount : null, badgeColor: '#FFD166' },
          { id: 'map' as const, label: '🗺️ Map & Zones', badge: null, badgeColor: '' },
          { id: 'chat' as const, label: '💬 Chat', badge: totalUnread > 0 ? totalUnread : null, badgeColor: '#EF476F' },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #FFD166' : '2px solid transparent',
              color: activeTab === tab.id ? '#FFD166' : '#555',
              padding: '12px 18px', fontSize: '0.85rem', fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 7,
            }}
          >
            {tab.label}
            {tab.badge !== null && (
              <span style={{ background: tab.badgeColor, color: '#000', fontSize: '0.65rem', fontWeight: 800, padding: '1px 6px', borderRadius: 10, lineHeight: '16px' }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* SIDE QUESTS PANEL (shown when game ended) */}
      {game.status === 'ended' && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #1a1a1a', background: bonusesApplied ? 'rgba(6,214,160,0.03)' : 'rgba(255,209,102,0.03)', flexShrink: 0 }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <p style={{ fontSize: '0.7rem', color: bonusesApplied ? '#06D6A0' : '#FFD166', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: bonusesApplied ? 6 : 16 }}>
              {bonusesApplied ? '✅ Side Quests Applied' : '🏁 Award Side Quest Points'}
            </p>

            {bonusesApplied ? (
              <p style={{ color: '#666', fontSize: '0.82rem' }}>
                Side Quest points have been added to team totals. Check results to see final scores.
              </p>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>

                  {/* Most Zones — auto-calculated */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #1a1a1a', borderRadius: 10, padding: '12px 14px' }}>
                    <p style={{ fontSize: '0.75rem', color: '#aaa', fontWeight: 600, marginBottom: 4 }}>
                      🗺️ Most Zones Claimed
                      <span style={{ color: '#FFD166', marginLeft: 6 }}>+5 pts</span>
                    </p>
                    <p style={{ fontSize: '0.68rem', color: '#444', marginBottom: 8 }}>Auto-calculated — confirm below</p>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setBonusAwards((p) => ({ ...p, mostZones: null }))}
                        style={{ ...smallBtnStyle, background: bonusAwards.mostZones === null ? 'rgba(239,71,111,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${bonusAwards.mostZones === null ? 'rgba(239,71,111,0.3)' : '#222'}`, color: bonusAwards.mostZones === null ? '#EF476F' : '#555' }}
                      >
                        None
                      </button>
                      {bonusSummaries.map((s) => (
                        <button
                          key={s.teamId}
                          onClick={() => setBonusAwards((p) => ({ ...p, mostZones: s.teamId }))}
                          style={{ ...smallBtnStyle, background: bonusAwards.mostZones === s.teamId ? `${s.teamColor}20` : 'rgba(255,255,255,0.03)', border: `1px solid ${bonusAwards.mostZones === s.teamId ? s.teamColor + '50' : '#222'}`, color: bonusAwards.mostZones === s.teamId ? s.teamColor : '#666' }}
                        >
                          {s.teamName} ({s.zonesClaimedCount})
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Most Transit Modes — GM selects */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #1a1a1a', borderRadius: 10, padding: '12px 14px' }}>
                    <p style={{ fontSize: '0.75rem', color: '#aaa', fontWeight: 600, marginBottom: 4 }}>
                      🚇 Most Transit Modes
                      <span style={{ color: '#FFD166', marginLeft: 6 }}>+4 pts</span>
                    </p>
                    <p style={{ fontSize: '0.68rem', color: '#444', marginBottom: 8 }}>Subway, bus, ferry, bike, etc.</p>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setBonusAwards((p) => ({ ...p, mostTransitModes: null }))}
                        style={{ ...smallBtnStyle, background: bonusAwards.mostTransitModes === null ? 'rgba(239,71,111,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${bonusAwards.mostTransitModes === null ? 'rgba(239,71,111,0.3)' : '#222'}`, color: bonusAwards.mostTransitModes === null ? '#EF476F' : '#555' }}
                      >
                        None
                      </button>
                      {bonusSummaries.map((s) => (
                        <button
                          key={s.teamId}
                          onClick={() => setBonusAwards((p) => ({ ...p, mostTransitModes: s.teamId }))}
                          style={{ ...smallBtnStyle, background: bonusAwards.mostTransitModes === s.teamId ? `${s.teamColor}20` : 'rgba(255,255,255,0.03)', border: `1px solid ${bonusAwards.mostTransitModes === s.teamId ? s.teamColor + '50' : '#222'}`, color: bonusAwards.mostTransitModes === s.teamId ? s.teamColor : '#666' }}
                        >
                          {s.teamName}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Most Challenges — auto-calculated */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid #1a1a1a', borderRadius: 10, padding: '12px 14px' }}>
                    <p style={{ fontSize: '0.75rem', color: '#aaa', fontWeight: 600, marginBottom: 4 }}>
                      🏆 Most Challenges Completed
                      <span style={{ color: '#FFD166', marginLeft: 6 }}>+3 pts</span>
                    </p>
                    <p style={{ fontSize: '0.68rem', color: '#444', marginBottom: 8 }}>Auto-calculated — confirm below</p>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setBonusAwards((p) => ({ ...p, mostChallenges: null }))}
                        style={{ ...smallBtnStyle, background: bonusAwards.mostChallenges === null ? 'rgba(239,71,111,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${bonusAwards.mostChallenges === null ? 'rgba(239,71,111,0.3)' : '#222'}`, color: bonusAwards.mostChallenges === null ? '#EF476F' : '#555' }}
                      >
                        None
                      </button>
                      {bonusSummaries.map((s) => (
                        <button
                          key={s.teamId}
                          onClick={() => setBonusAwards((p) => ({ ...p, mostChallenges: s.teamId }))}
                          style={{ ...smallBtnStyle, background: bonusAwards.mostChallenges === s.teamId ? `${s.teamColor}20` : 'rgba(255,255,255,0.03)', border: `1px solid ${bonusAwards.mostChallenges === s.teamId ? s.teamColor + '50' : '#222'}`, color: bonusAwards.mostChallenges === s.teamId ? s.teamColor : '#666' }}
                        >
                          {s.teamName} ({s.challengesCompletedCount})
                        </button>
                      ))}
                    </div>
                  </div>

                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <button
                    onClick={handleApplyBonuses}
                    disabled={applyingBonuses}
                    style={{ background: applyingBonuses ? '#1a1a1a' : 'rgba(255,209,102,0.15)', border: '1px solid rgba(255,209,102,0.3)', color: applyingBonuses ? '#444' : '#FFD166', padding: '10px 20px', borderRadius: 10, fontSize: '0.88rem', fontWeight: 700, cursor: applyingBonuses ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                  >
                    {applyingBonuses ? 'Applying...' : 'Apply Side Quest Points'}
                  </button>
                  <p style={{ fontSize: '0.72rem', color: '#555' }}>One-time. Points are permanent.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB CONTENT */}
      <div style={{ flex: 1, overflow: 'auto' }}>

        {/* SUBMISSIONS TAB */}
        {activeTab === 'submissions' && (
          <div style={{ maxWidth: 720, margin: '0 auto', padding: '20px 20px 40px' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {([
                { id: 'pending', label: `Pending (${pendingCount})`, color: '#FFD166' },
                { id: 'approved', label: 'Approved', color: '#06D6A0' },
                { id: 'rejected', label: 'Rejected', color: '#EF476F' },
                { id: 'all', label: 'All', color: '#888' },
              ] as const).map((f) => (
                <button key={f.id} onClick={() => setFilter(f.id)} style={{ background: filter === f.id ? `${f.color}15` : 'rgba(255,255,255,0.03)', border: `1px solid ${filter === f.id ? `${f.color}40` : '#1a1a1a'}`, color: filter === f.id ? f.color : '#555', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {f.label}
                </button>
              ))}
            </div>

            {filteredSubmissions.length === 0 ? (
              <div style={{ textAlign: 'center', marginTop: 80, color: '#333' }}>
                <p style={{ fontSize: '2rem', marginBottom: 12 }}>{filter === 'pending' ? '✅' : '📋'}</p>
                <p style={{ color: '#555', fontWeight: 600 }}>{filter === 'pending' ? 'No pending submissions' : `No ${filter} submissions`}</p>
                <p style={{ color: '#333', fontSize: '0.82rem', marginTop: 6 }}>{filter === 'pending' ? "You're all caught up!" : 'Try switching the filter.'}</p>
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
                  const gpsCheck = checkGpsProximity(sub)

                  return (
                    <div key={sub.id} style={{ background: sub.status === 'pending' ? 'rgba(255,209,102,0.02)' : 'rgba(255,255,255,0.02)', border: `1px solid ${sub.status === 'pending' ? 'rgba(255,209,102,0.15)' : '#1a1a1a'}`, borderRadius: 14, padding: 20, opacity: isProcessing ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: team?.color || '#555' }} />
                          <span style={{ fontWeight: 700, fontSize: '0.88rem' }}>{team?.name || sub.team_id}</span>
                          <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${diffColor}15`, color: diffColor }}>
                            {challenge?.difficulty?.toUpperCase() || '?'} · {basePts}pt
                          </span>
                        </div>
                        {sub.status !== 'pending' && (
                          <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '3px 10px', borderRadius: 4, background: sub.status === 'approved' ? 'rgba(6,214,160,0.12)' : 'rgba(239,71,111,0.12)', color: sub.status === 'approved' ? '#06D6A0' : '#EF476F' }}>
                            {sub.status === 'approved' ? '✅ Approved' : '❌ Rejected'}
                          </span>
                        )}
                      </div>

                      <p style={{ color: '#ccc', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: 14, background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 8, border: '1px solid #111' }}>
                        {challenge?.description || `Challenge: ${sub.challenge_id}`}
                      </p>

                      <div style={{ marginBottom: 14 }}>
                        {sub.media_type === 'video' ? (
                          <video src={sub.media_url} controls style={{ width: '100%', maxHeight: 280, borderRadius: 10, background: '#111', objectFit: 'contain' }} />
                        ) : sub.media_type === 'audio' ? (
                          <div style={{ background: '#111', borderRadius: 10, padding: 16, textAlign: 'center' }}>
                            <span style={{ fontSize: '1.5rem' }}>🎙️</span>
                            <audio src={sub.media_url} controls style={{ width: '100%', marginTop: 8 }} />
                          </div>
                        ) : (
                          <img src={sub.media_url} alt="Submission" style={{ width: '100%', maxHeight: 280, borderRadius: 10, background: '#111', objectFit: 'contain' }} />
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.75rem', color: '#555', marginBottom: sub.status === 'pending' ? 14 : 0 }}>
                        {sub.zone_id && <span>📍 {sub.zone_id.replace('zone_district_', 'D')}</span>}
                        {!sub.zone_id && sub.gps_lat && sub.gps_lng && <span style={{ color: '#FFD166' }}>⚠ No zone · GPS: {sub.gps_lat.toFixed(4)}, {sub.gps_lng.toFixed(4)}</span>}
                        {!sub.zone_id && !sub.gps_lat && <span style={{ color: '#EF476F' }}>⚠ No zone · No GPS</span>}
                        {sub.submitted_at && <span>{sub.submitted_at.toDate ? sub.submitted_at.toDate().toLocaleTimeString() : ''}</span>}
                        {gpsCheck === 'inside' && <span style={{ color: '#06D6A0', fontWeight: 600 }}>✓ GPS in zone</span>}
                        {gpsCheck === 'outside' && <span style={{ color: '#EF476F', fontWeight: 700 }}>⚠ GPS OUTSIDE zone</span>}
                      </div>

                      {gpsCheck === 'outside' && sub.status === 'pending' && (
                        <div style={{ background: 'rgba(239,71,111,0.06)', border: '1px solid rgba(239,71,111,0.2)', borderRadius: 8, padding: '8px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>🚩</span>
                          <p style={{ color: '#EF476F', fontSize: '0.78rem', fontWeight: 700, margin: 0 }}>GPS outside {sub.zone_id?.replace('zone_district_', 'District ')}</p>
                        </div>
                      )}

                      {sub.status === 'pending' && (
                        <div>
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                            {sub.attempted_tier2 && challenge?.tier2 && (
                              <button onClick={() => updateReviewState(sub.id, { tier2Approved: !review.tier2Approved })} style={{ background: review.tier2Approved ? 'rgba(155,93,229,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${review.tier2Approved ? 'rgba(155,93,229,0.3)' : '#222'}`, color: review.tier2Approved ? '#9B5DE5' : '#666', padding: '7px 12px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                                {review.tier2Approved ? '✓' : '○'} Tier 2 (+{challenge.tier2.bonus_points}pt)
                              </button>
                            )}
                          </div>

                          {(() => {
                            const tierPts = sub.attempted_tier2 && review.tier2Approved && challenge?.tier2 ? challenge.tier2.bonus_points : 0
                            const total = basePts + tierPts
                            return (
                              <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '8px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '0.78rem', color: '#888' }}>{basePts}pt base{tierPts > 0 && ` + ${tierPts}pt tier2`}</span>
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1rem', fontWeight: 700, color: '#FFD166' }}>= {total}pt</span>
                              </div>
                            )
                          })()}

                          <input type="text" placeholder="Rejection reason (required to reject)" value={review.notes} onChange={(e) => updateReviewState(sub.id, { notes: e.target.value })} style={{ width: '100%', background: '#111', border: '1px solid #222', borderRadius: 8, padding: '10px 14px', color: '#ccc', fontSize: '0.82rem', fontFamily: 'inherit', marginBottom: 10, boxSizing: 'border-box' }} />
                          <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => handleApprove(sub)} disabled={isProcessing} style={{ flex: 2, background: 'rgba(6,214,160,0.15)', border: '1px solid rgba(6,214,160,0.3)', color: '#06D6A0', padding: '12px', borderRadius: 10, fontSize: '0.9rem', fontWeight: 700, cursor: isProcessing ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                              {isProcessing ? 'Processing...' : '✓ Approve'}
                            </button>
                            <button onClick={() => handleReject(sub)} disabled={isProcessing} style={{ flex: 1, background: 'rgba(239,71,111,0.08)', border: '1px solid rgba(239,71,111,0.2)', color: '#EF476F', padding: '12px', borderRadius: 10, fontSize: '0.9rem', fontWeight: 700, cursor: isProcessing ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                              ✗ Reject
                            </button>
                          </div>
                        </div>
                      )}
                      {sub.status === 'rejected' && sub.gm_notes && (
                        <p style={{ color: '#EF476F', fontSize: '0.82rem', marginTop: 10, fontStyle: 'italic' }}>GM: {sub.gm_notes}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* MAP & ZONES TAB */}
        {activeTab === 'map' && (
          <div style={{ display: 'flex', gap: 20, padding: '20px', alignItems: 'flex-start', maxWidth: 1200, margin: '0 auto' }}>

            {/* LEFT COLUMN — Scoreboard, Map, Team Hands */}
            <div style={{ flex: 1, minWidth: 0 }}>

              <p style={sectionLabel}>Scoreboard</p>
              <div style={{ display: 'grid', gap: 10, marginBottom: 28 }}>
                {scoreboard.map((team, rank) => (
                  <div key={team.id} style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${rank === 0 && team.total_points > 0 ? `${team.color}40` : '#1a1a1a'}`, borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, background: team.color }} />
                        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{team.name}</span>
                      </div>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1.1rem', fontWeight: 700, color: team.total_points > 0 ? '#fff' : '#333' }}>{team.total_points}</span>
                    </div>
                    {team.zoneBreakdown.length > 0 ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {team.zoneBreakdown.map((zs) => (
                          <span key={zs.zone_id} style={{ fontSize: '0.68rem', padding: '3px 8px', borderRadius: 4, background: zs.status === 'claimed' ? `${team.color}20` : 'rgba(255,255,255,0.04)', border: `1px solid ${zs.status === 'claimed' ? `${team.color}40` : '#1a1a1a'}`, color: zs.status === 'claimed' ? team.color : '#555', fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
                            {zs.zone_id.replace('zone_district_', 'D')} · {zs.points}pt{zs.status === 'claimed' ? ' ★' : ''}
                          </span>
                        ))}
                      </div>
                    ) : <p style={{ fontSize: '0.75rem', color: '#333', fontStyle: 'italic' }}>No points yet</p>}
                  </div>
                ))}
              </div>

              <p style={sectionLabel}>Live Map</p>
              <div style={{ height: 380, borderRadius: 12, overflow: 'hidden', border: '1px solid #1a1a1a', background: '#111', marginBottom: 28 }}>
                {activeZones.length > 0
                  ? <GameMap zones={activeZones} zoneOwnership={mapZoneOwnership.size > 0 ? mapZoneOwnership : undefined} playerLocations={playerLocations} showGeolocate={false} />
                  : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333', fontSize: '0.78rem' }}>No zone data loaded</div>}
              </div>

              <p style={sectionLabel}>Team Hands</p>
              <div style={{ display: 'grid', gap: 16, marginBottom: 40 }}>
                {teams.map((team) => (
                  <div key={team.id} style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${team.color}25`, borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: team.color }} />
                      <span style={{ fontWeight: 700, fontSize: '0.88rem', color: team.color }}>{team.name}</span>
                      <span style={{ fontSize: '0.72rem', color: '#444' }}>{team.hand?.length ?? 0} cards</span>
                    </div>
                    {team.hand && team.hand.length > 0 ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {team.hand.map((challengeId) => {
                          const ch = challenges.get(challengeId)
                          if (!ch) return <span key={challengeId} />
                          const diffColor = DIFFICULTY_COLORS[ch.difficulty] || '#888'
                          return (
                            <div key={challengeId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', background: 'rgba(255,255,255,0.02)', border: '1px solid #1a1a1a', borderRadius: 8 }}>
                              <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: `${diffColor}15`, color: diffColor, flexShrink: 0, marginTop: 2 }}>
                                {ch.difficulty?.toUpperCase()}
                              </span>
                              <p style={{ color: '#bbb', fontSize: '0.82rem', lineHeight: 1.5, margin: 0 }}>{ch.description}</p>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p style={{ color: '#333', fontSize: '0.78rem', fontStyle: 'italic' }}>No cards in hand</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* RIGHT COLUMN — Zone Control (sticky) */}
            <div style={{ width: '28%', minWidth: 200, flexShrink: 0, position: 'sticky', top: 20 }}>
              <p style={sectionLabel}>Zone Control</p>
              <div style={{ display: 'grid', gap: 8 }}>
                {game.zones.map((zoneId) => {
                  const owner = zoneOwnership.get(zoneId)
                  const isClosed = (game.closed_zones ?? []).includes(zoneId)
                  return (
                    <div key={zoneId} style={{ background: isClosed ? 'rgba(255,255,255,0.01)' : owner ? `${owner.teamColor}08` : 'rgba(255,255,255,0.02)', border: `1px solid ${isClosed ? '#2a2a2a' : owner ? `${owner.teamColor}30` : '#1a1a1a'}`, borderRadius: 10, padding: '10px 12px', opacity: isClosed ? 0.6 : 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: owner || isClosed ? 6 : 0 }}>
                        <span style={{ fontSize: '0.78rem', color: owner ? '#ccc' : '#444', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {allZoneData.find((z: any) => z.id === zoneId)?.name ?? zoneId.replace('zone_district_', 'D')}
                        </span>
                        {isClosed && (
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>
                            Closed
                          </span>
                        )}
                      </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        {owner ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 7, height: 7, borderRadius: 2, background: owner.teamColor, flexShrink: 0 }} />
                            <span style={{ fontSize: '0.75rem', color: owner.teamColor, fontWeight: 600 }}>{owner.teamName}</span>
                          </div>
                        ) : (
                          <p style={{ fontSize: '0.72rem', color: '#333', fontStyle: 'italic', margin: 0 }}>
                            {isClosed ? '—' : 'Unclaimed'}
                          </p>
                        )}
                        {game.status === 'active' && (
                          <button
                            onClick={() => handleCloseZone(zoneId)}
                            style={{ background: isClosed ? 'rgba(6,214,160,0.08)' : 'rgba(239,71,111,0.08)', border: `1px solid ${isClosed ? 'rgba(6,214,160,0.2)' : 'rgba(239,71,111,0.2)'}`, color: isClosed ? '#06D6A0' : '#EF476F', padding: '4px 8px', borderRadius: 6, fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0 }}
                          >
                            {isClosed ? '↺ Reopen' : '✕ Close'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

          </div>
        )}

        {/* CHAT TAB */}
        {activeTab === 'chat' && (
          <div style={{ maxWidth: 720, margin: '0 auto', padding: '20px 20px 40px' }}>
            <p style={sectionLabel}>Broadcast to All Teams</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
              <input type="text" value={broadcastInput} onChange={(e) => setBroadcastInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleBroadcast() }} placeholder="📢 Message all teams at once..." style={{ flex: 1, background: '#111', border: '1px solid #2a2a2a', borderRadius: 10, padding: '12px 14px', color: '#fff', fontSize: '0.88rem', fontFamily: 'inherit', outline: 'none' }} />
              <button onClick={handleBroadcast} disabled={!broadcastInput.trim() || broadcasting} style={{ background: broadcastInput.trim() ? 'rgba(255,209,102,0.15)' : '#1a1a1a', border: '1px solid rgba(255,209,102,0.3)', color: '#FFD166', padding: '12px 18px', borderRadius: 10, fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: broadcasting ? 0.5 : 1 }}>
                {broadcasting ? '...' : 'Send All'}
              </button>
            </div>

            <p style={sectionLabel}>Team Messages</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {teams.map((t) => {
                const unread = chatMessages.filter((m) => m.channel_type === 'team_to_gm' && m.team_id === t.id && !m.read_by?.includes(user?.uid)).length
                return (
                  <button key={t.id} onClick={() => setSelectedTeamId(selectedTeamId === t.id ? null : t.id)} style={{ background: selectedTeamId === t.id ? `${t.color}20` : 'rgba(255,255,255,0.03)', border: `1px solid ${selectedTeamId === t.id ? `${t.color}40` : '#222'}`, color: selectedTeamId === t.id ? t.color : '#666', padding: '8px 16px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', position: 'relative' }}>
                    {t.name}
                    {unread > 0 && <span style={{ position: 'absolute', top: -4, right: -4, width: 8, height: 8, borderRadius: '50%', background: '#EF476F' }} />}
                  </button>
                )
              })}
            </div>

            {selectedTeamId ? (
              <div style={{ background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ maxHeight: 380, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {chatMessages
                    .filter((m) => m.team_id === selectedTeamId && (m.channel_type === 'team_to_gm' || m.channel_type === 'gm_to_team'))
                    .map((msg) => {
                      const isFromGM = msg.channel_type === 'gm_to_team'
                      return (
                        <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isFromGM ? 'flex-end' : 'flex-start' }}>
                          <p style={{ fontSize: '0.65rem', color: '#444', marginBottom: 4 }}>{isFromGM ? '🎮 You (GM)' : msg.from_name || 'Player'}</p>
                          <div style={{ maxWidth: '80%', background: isFromGM ? 'rgba(255,209,102,0.08)' : 'rgba(255,255,255,0.04)', border: `1px solid ${isFromGM ? 'rgba(255,209,102,0.2)' : '#222'}`, borderRadius: 10, padding: '10px 14px' }}>
                            <p style={{ color: '#ddd', fontSize: '0.85rem', lineHeight: 1.5, margin: 0 }}>{msg.text}</p>
                          </div>
                        </div>
                      )
                    })}
                  <div ref={chatBottomRef} />
                </div>
                <div style={{ display: 'flex', gap: 8, padding: '12px 14px', borderTop: '1px solid #1a1a1a', background: '#0a0a0a' }}>
                  <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleGMReply() }} placeholder={`Reply to ${teams.find(t => t.id === selectedTeamId)?.name}...`} style={{ flex: 1, background: '#141414', border: '1px solid #222', borderRadius: 8, padding: '10px 12px', color: '#fff', fontSize: '0.85rem', fontFamily: 'inherit', outline: 'none' }} />
                  <button onClick={handleGMReply} disabled={!chatInput.trim() || chatSending} style={{ background: chatInput.trim() ? 'rgba(255,209,102,0.15)' : '#1a1a1a', border: '1px solid rgba(255,209,102,0.3)', color: '#FFD166', padding: '10px 14px', borderRadius: 8, fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: chatSending ? 0.5 : 1 }}>↑</button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: '#444' }}>
                <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>💬</p>
                <p style={{ fontWeight: 600, color: '#555' }}>Select a team above to view their messages</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Full-screen map overlay */}
      {showFullMap && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#0a0a0a', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #1a1a1a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0d0d0d', flexShrink: 0 }}>
            <p style={{ fontSize: '0.82rem', color: '#FFD166', fontWeight: 700, margin: 0 }}>🗺️ Zone Map — {game.name}</p>
            <button onClick={() => setShowFullMap(false)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #222', color: '#ccc', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>✕ Close</button>
          </div>
          <div style={{ flex: 1 }}>
            <GameMap zones={activeZones} zoneOwnership={mapZoneOwnership.size > 0 ? mapZoneOwnership : undefined} playerLocations={playerLocations} showGeolocate={false} />
          </div>
        </div>
      )}
    </div>
  )
}

const sectionLabel: React.CSSProperties = {
  fontSize: '0.72rem',
  color: '#FFD166',
  textTransform: 'uppercase',
  letterSpacing: 1.5,
  fontWeight: 700,
  marginBottom: 14,
}

const smallBtnStyle: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: 6,
  fontSize: '0.72rem',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
}