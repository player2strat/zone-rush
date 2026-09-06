// =============================================================================
// Foray — GM Dashboard (v5)
// CHANGES (v5 — media highlights):
// - "Highlight" star toggle on APPROVED asset submissions. Writes a `highlight`
//   boolean to the submission doc; the live listener re-renders the card.
// - Post-game "Pull All Highlights" panel (shown when game ended): bundles every
//   flagged asset into ONE zip, organized into a folder per team. Files named
//   teamname_challengetitle_timestamp. Flagged-only.
// - ZIP_MEDIA_TYPES constant is the single expansion point for including
//   photos/audio later — drives BOTH the star visibility and the zip contents.
//
// CHANGES (v4 — chat / attention queue):
// - New "Needs your attention" queue at the top of the Chat tab: every unread
//   flagged (team_to_gm) message across all teams in THIS game, oldest first,
//   labeled by team. Tapping one jumps to that team's thread.
// - Per-team thread now shows team_internal chatter + flagged team_to_gm +
//   gm_to_team replies, with flagged messages marked so the GM can tell a
//   "Message GM" ping from normal team chatter.
//
// CHANGES (v3):
// - End-game bonuses renamed to Side Quests
// - New point values: Most Zones (+5), Most Transit Modes (+4), Most Challenges (+3)
// - Removed Fastest Return and Hydration bonuses
// - Most Challenges auto-calculated like Most Zones
// =============================================================================

import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, onSnapshot, collection, query, where, orderBy,
  updateDoc, getDocs, serverTimestamp, writeBatch, arrayUnion,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import { loadGameZones } from '../lib/gameZones'
import { isPointInPolygon } from '../lib/geo'
import { approveSubmission, checkZoneLockouts, runZoneSchedules } from '../lib/scoring'
import type { SideQuest, SideQuestSubmission } from '../types/game'
import GameMap from '../components/GameMap'
import { drawReplacementCard } from '../lib/dealChallenges'
import type { ZoneOwner, PlayerLocation } from '../components/GameMap'
import {
  sendGMBroadcast,
  sendGMReply,
  subscribeToGMMessages,
  subscribeToGMAttentionQueue,
  markMessagesRead,
} from '../lib/chat'
import {
  getTeamBonusSummaries,
  autoSelectMostZonesClaimed,
  autoSelectMostZonesWithChallenges,
  applyEndGameBonuses,
  type BonusAwards,
  type TeamBonusSummary,
} from '../lib/endGame'
import {
  logEvent,
  getActivityLog,
  activityLogToCSV,
  type MergedActivityRow,
} from '../lib/activityLog'
import JSZip from 'jszip'
import { formatZoneLabel } from '../utils/formatZoneLabel'

// --------------- Types ---------------

interface GameData {
  id: string
  name: string
  status: string
  join_code: string
  zones: string[]
  started_at: any
  ends_at: any
  paused_at?: any  
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
  highlight?: boolean
  // Sequential ("Choose Your Own Adventure") submissions only — absent otherwise.
  resolved_task?: string
  step_choices?: string[]
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
  status: 'none' | 'claimed' | 'locked' | 'locked_out'
  challenges_completed: string[]
}

// --------------- Constants ---------------

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'var(--green)', medium: 'var(--marigold)', hard: 'var(--red)',
}

// Which media types get included in the post-game highlight zip.
// Expansion point: add 'photo' and/or 'audio' here to include them later.
// This constant drives BOTH the star visibility and the zip contents.
const ZIP_MEDIA_TYPES: Array<'photo' | 'video' | 'audio'> = ['photo', 'video']

// --------------- Component ---------------

export default function GMDashboard() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const user = auth.currentUser

  const [game, setGame] = useState<GameData | null>(null)
  const [teams, setTeams] = useState<TeamData[]>([])
  // Late joiners waiting for approval (games/{id}/join_requests, status pending).
  const [joinRequests, setJoinRequests] = useState<{ uid: string; name: string }[]>([])
  const [joinTeamPick, setJoinTeamPick] = useState<Record<string, string>>({})
  const [joinBusy, setJoinBusy] = useState<string | null>(null)
  // Side quest submissions for this game (live) + which one is being reviewed.
  const [sideQuestSubs, setSideQuestSubs] = useState<SideQuestSubmission[]>([])
  const [sideQuestSubsLoaded, setSideQuestSubsLoaded] = useState(false)
  const [sqProcessing, setSqProcessing] = useState<string | null>(null)
  const [submissions, setSubmissions] = useState<SubmissionData[]>([])
  const [challenges, setChallenges] = useState<Map<string, ChallengeData>>(new Map())
  const [zoneScores, setZoneScores] = useState<ZoneScoreData[]>([])
  const [loading, setLoading] = useState(true)
  const [allZoneData, setAllZoneData] = useState<any[]>([])

  interface ReviewState { tier2Approved: boolean; phoneFreeBonus: number; notes: string }
  const [reviewState, setReviewState] = useState<Map<string, ReviewState>>(new Map())
  const [processing, setProcessing] = useState<string | null>(null)

  // Deferred verdicts. Approve/Reject doesn't fire immediately: the card
  // shows "Approving in 15s… Undo" and the real write happens when the
  // countdown ends (or on "Apply now"). Undo just cancels the timer, so a
  // mistaken tap never touches Firestore — which matters because an approval
  // can claim/lock a zone and deal a new card, none of which is reversible.
  const UNDO_WINDOW_MS = 15000
  interface PendingVerdict {
    kind: 'approve' | 'reject'
    sub: SubmissionData
    review: ReviewState
    deadline: number
    timer: ReturnType<typeof setTimeout>
  }
  const [pendingVerdicts, setPendingVerdicts] = useState<Map<string, PendingVerdict>>(new Map())
  const pendingVerdictsRef = useRef(pendingVerdicts)
  pendingVerdictsRef.current = pendingVerdicts
  // Latest commit functions, so a timer set 15s ago runs against fresh state.
  const commitRef = useRef<{ approve: (sub: SubmissionData, review: ReviewState) => Promise<void>; reject: (sub: SubmissionData, review: ReviewState) => Promise<void> } | null>(null)
  // Commits run one at a time: two approvals in the same zone must not
  // compute from the same pre-state.
  const commitChainRef = useRef<Promise<void>>(Promise.resolve())
  // Re-render every 500ms while a countdown is showing.
  const [, setCountdownTick] = useState(0)
  useEffect(() => {
    if (pendingVerdicts.size === 0) return
    const id = setInterval(() => setCountdownTick((t) => t + 1), 500)
    return () => clearInterval(id)
  }, [pendingVerdicts.size])
  // Leaving the page with verdicts still counting down: fire them now rather
  // than silently dropping them, and warn on tab close.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingVerdictsRef.current.size === 0) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      for (const pv of pendingVerdictsRef.current.values()) {
        clearTimeout(pv.timer)
        const run = pv.kind === 'approve' ? commitRef.current?.approve : commitRef.current?.reject
        if (run) commitChainRef.current = commitChainRef.current.then(() => run(pv.sub, pv.review)).catch(() => {})
      }
    }
  }, [])

  const [activeTab, setActiveTab] = useState<'submissions' | 'map' | 'chat' | 'activity'>('submissions')

  // Subscribe to pending join requests
  useEffect(() => {
    if (!gameId) return
    const q = query(collection(db, 'games', gameId, 'join_requests'), where('status', '==', 'pending'))
    const unsub = onSnapshot(q, (snap) => {
      setJoinRequests(snap.docs.map((d) => ({ uid: d.id, name: (d.data().name as string) || 'Player' })))
    })
    return unsub
  }, [gameId])

  // Subscribe to side quest submissions (only when the game has side quests)
  useEffect(() => {
    if (!gameId || (game?.settings?.side_quests?.length ?? 0) === 0) return
    const q = query(collection(db, 'side_quest_submissions'), where('game_id', '==', gameId))
    const unsub = onSnapshot(q, (snap) => {
      const subs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as SideQuestSubmission))
      const secs = (v: unknown) => (v as { seconds?: number } | null)?.seconds ?? 0
      subs.sort((a, b) => secs(b.submitted_at) - secs(a.submitted_at))
      setSideQuestSubs(subs)
      setSideQuestSubsLoaded(true)
    })
    return unsub
  }, [gameId, game?.settings?.side_quests?.length])

  const handleReviewSideQuest = async (subId: string, status: 'approved' | 'rejected') => {
    if (!gameId || sqProcessing) return
    setSqProcessing(subId)
    try {
      await updateDoc(doc(db, 'side_quest_submissions', subId), {
        status,
        reviewed_by: user?.uid ?? null,
        reviewed_at: serverTimestamp(),
      })
    } catch (err) {
      console.error('Side quest review failed:', err)
    }
    setSqProcessing(null)
  }

  // Approved side quest counts: quest id → team id → count. Drives both the
  // player-facing fairness (GM sees the same tally) and the bonus auto-pick.
  const sideQuestTallies = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const s of sideQuestSubs) {
      if (s.status !== 'approved') continue
      const byTeam = m.get(s.quest_id) ?? new Map<string, number>()
      byTeam.set(s.team_id, (byTeam.get(s.team_id) ?? 0) + 1)
      m.set(s.quest_id, byTeam)
    }
    return m
  }, [sideQuestSubs])

  // CSV for external partners: every submission with photo URL, submitter, GPS.
  const exportSideQuestCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = [
      ['quest', 'status', 'team', 'submitter', 'gps_lat', 'gps_lng', 'photo_url', 'submitted_at'].join(','),
      ...sideQuestSubs.map((s) => [
        esc((s as unknown as { quest_title?: string }).quest_title ?? s.quest_id),
        esc(s.status),
        esc(teams.find((t) => t.id === s.team_id)?.name ?? s.team_id),
        esc(s.submitter_name),
        esc(s.gps_lat ?? ''),
        esc(s.gps_lng ?? ''),
        esc(s.media_url),
        esc((() => { const t = (s.submitted_at as { seconds?: number } | null)?.seconds; return t ? new Date(t * 1000).toISOString() : '' })()),
      ].join(',')),
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `foray-side-quests-${game?.name?.replace(/\s+/g, '-') ?? gameId}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Approve: add to the chosen team + mark the request. One atomic batch.
  const handleApproveJoin = async (uid: string, name: string) => {
    if (!gameId) return
    const teamId = joinTeamPick[uid] || defaultTeamFor()
    if (!teamId) return
    setJoinBusy(uid)
    try {
      const batch = writeBatch(db)
      batch.update(doc(db, 'games', gameId, 'teams', teamId), {
        members: arrayUnion(uid),
        member_names: arrayUnion(name),
      })
      batch.update(doc(db, 'games', gameId, 'join_requests', uid), {
        status: 'approved',
        team_id: teamId,
        decided_at: serverTimestamp(),
      })
      await batch.commit()
    } catch (err) {
      console.error('Approve join failed:', err)
    }
    setJoinBusy(null)
  }

  const handleDenyJoin = async (uid: string) => {
    if (!gameId) return
    setJoinBusy(uid)
    try {
      await updateDoc(doc(db, 'games', gameId, 'join_requests', uid), {
        status: 'denied',
        decided_at: serverTimestamp(),
      })
    } catch (err) {
      console.error('Deny join failed:', err)
    }
    setJoinBusy(null)
  }

  // Zone open/close schedules also run from the GM's screen — it's the one
  // most likely to stay awake all game, so schedules fire even when every
  // player's phone is asleep. Immediate + foreground + once a minute.
  // Timed zone LOCKOUTS run only here: they award points, and security rules
  // restrict score writes to the GM/admin.
  useEffect(() => {
    if (game?.status !== 'active' || !gameId) return
    const run = () => {
      checkZoneLockouts(gameId).catch((err) => console.error('Zone lockout check failed:', err))
      runZoneSchedules(gameId)
    }
    run()
    const interval = setInterval(run, 60000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [game?.status, gameId])

  // Smallest team with room (or just the smallest if all are full).
  const defaultTeamFor = (): string => {
    if (teams.length === 0) return ''
    const size = game?.settings?.team_size ?? Infinity
    const sorted = [...teams].sort((a, b) => a.members.length - b.members.length)
    return (sorted.find((t) => t.members.length < size) || sorted[0]).id
  }
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const [showFullMap, setShowFullMap] = useState(false)
  const [timeLeft, setTimeLeft] = useState('')

  const [chatMessages, setChatMessages] = useState<any[]>([])
  const [attentionQueue, setAttentionQueue] = useState<any[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [broadcastInput, setBroadcastInput] = useState('')
  const [broadcasting, setBroadcasting] = useState(false)
  const chatBottomRef = useRef<HTMLDivElement>(null)

  // Side Quests state
  const [bonusSummaries, setBonusSummaries] = useState<TeamBonusSummary[]>([])
  const [bonusAwards, setBonusAwards] = useState<BonusAwards>({
    mostZonesClaimed: null,
    mostZonesWithChallenges: null,
  })
  const [applyingBonuses, setApplyingBonuses] = useState(false)
  const [bonusesApplied, setBonusesApplied] = useState(false)

  // Activity log state
  const [activityRows, setActivityRows] = useState<MergedActivityRow[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityTeamFilter, setActivityTeamFilter] = useState<string | 'all'>('all')

  // Highlight zip-pull state
  const [zipBusy, setZipBusy] = useState(false)
  const [zipProgress, setZipProgress] = useState('')

  // Load this game's zone snapshot (falls back to the library for old games)
  useEffect(() => {
    if (!gameId) return
    loadGameZones(gameId).then(setAllZoneData)
  }, [gameId])

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
  // Don't tick when paused
  if (game.status === 'paused') return

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
            await sendGMBroadcast(gameId, user.uid, 'Foray', milestone.message)
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

  // Attention queue: unread flagged (team_to_gm) messages for THIS game,
  // oldest first. Scoped per-game so two concurrent games don't mix.
  useEffect(() => {
    if (!gameId || !user) return
    const unsub = subscribeToGMAttentionQueue(gameId, user.uid, (msgs) => {
      setAttentionQueue(msgs)
    })
    return () => unsub()
  }, [gameId, user?.uid])

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
      const autoZones = autoSelectMostZonesClaimed(summaries)
      const autoZonesWithChallenges = autoSelectMostZonesWithChallenges(summaries)
      setBonusAwards((prev) => ({
        ...prev,
        mostZonesClaimed: autoZones,
        mostZonesWithChallenges: autoZonesWithChallenges,
      }))
    })
  }, [game?.status, game?.bonuses_applied, gameId])

  // Side quest bonus auto-pick: track the leader per quest as approvals come
  // in, but never override a pick the GM has made by hand.
  const manualSqPicks = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (game?.status !== 'ended' || game?.bonuses_applied) return
    const quests: SideQuest[] = game?.settings?.side_quests ?? []
    if (quests.length === 0) return
    setBonusAwards((prev) => {
      const sq = { ...(prev.sideQuests ?? {}) }
      let changed = false
      for (const quest of quests) {
        if (manualSqPicks.current.has(quest.id)) continue
        const byTeam = sideQuestTallies.get(quest.id)
        let auto: string | null = null
        if (byTeam && byTeam.size > 0) {
          const sorted = [...byTeam.entries()].sort((a, b) => b[1] - a[1])
          auto = sorted.length > 1 && sorted[0][1] === sorted[1][1] ? null : sorted[0][0]
        }
        if (sq[quest.id] !== auto) { sq[quest.id] = auto; changed = true }
      }
      return changed ? { ...prev, sideQuests: sq } : prev
    })
  }, [game?.status, game?.bonuses_applied, game?.settings?.side_quests, sideQuestTallies])

  // Load activity log when the Activity tab is opened
  const refreshActivityLog = async () => {
    if (!gameId) return
    setActivityLoading(true)
    try {
      const rows = await getActivityLog(gameId)
      setActivityRows(rows)
    } catch (err) {
      console.error('Failed to load activity log:', err)
    } finally {
      setActivityLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'activity' && gameId) {
      refreshActivityLog()
    }
  }, [activeTab, gameId])

  const handleDownloadActivityCSV = () => {
    if (activityRows.length === 0) return
    const csv = activityLogToCSV(activityRows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `foray-activity-${game?.name?.replace(/\s+/g, '-') ?? gameId}-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Toggle the highlight star. Allowed on pending OR approved submissions —
  // a star set during review rides along through approval. Rejecting clears it
  // (see handleReject), and the zip pull filters on status === 'approved', so a
  // rejected submission can never end up in the highlight reel.
  const handleToggleHighlight = async (sub: SubmissionData) => {
    if (sub.status === 'rejected') return
    try {
      await updateDoc(doc(db, 'submissions', sub.id), {
        highlight: !sub.highlight,
      })
    } catch (err) {
      alert('Could not update highlight: ' + ((err as Error).message || 'Unknown error'))
    }
  }

  // Build one zip containing every flagged highlight, organized into a
  // folder per team. Files named teamname_challengetitle_timestamp.
  const handlePullHighlights = async () => {
    if (zipBusy) return

    // Gather flagged + approved submissions of an includable media type.
    const flagged = submissions.filter(
      (s) =>
        s.highlight === true &&
        s.status === 'approved' &&
        ZIP_MEDIA_TYPES.includes(s.media_type)
    )

    if (flagged.length === 0) {
      alert('No flagged assets to pull. Star some approved assets first.')
      return
    }

    setZipBusy(true)
    setZipProgress(`Starting… (0/${flagged.length})`)

    try {
      const zip = new JSZip()
      const usedNames = new Set<string>()
      let done = 0
      let failed = 0

      for (const sub of flagged) {
        const team = getTeam(sub.team_id)
        const challenge = challenges.get(sub.challenge_id)

        // Build safe, readable names.
        const teamFolder = safeName(team?.name || sub.team_id)
        const challengeName = safeName(challenge?.title || sub.challenge_id)
        const stamp = sub.submitted_at?.toDate
          ? sub.submitted_at.toDate().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
          : String(done)
        const ext = extensionFor(sub.media_type)

        let fileName = `${teamFolder}_${challengeName}_${stamp}.${ext}`
        // Guard against two files resolving to the same name.
        let dedupe = 2
        while (usedNames.has(`${teamFolder}/${fileName}`)) {
          fileName = `${teamFolder}_${challengeName}_${stamp}-${dedupe}.${ext}`
          dedupe++
        }
        usedNames.add(`${teamFolder}/${fileName}`)

        setZipProgress(`Downloading ${done + 1}/${flagged.length}…`)

        try {
          const res = await fetch(sub.media_url)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const blob = await res.blob()
          zip.folder(teamFolder)!.file(fileName, blob)
        } catch (fetchErr) {
          console.error('Failed to fetch a video for zip:', sub.id, fetchErr)
          failed++
        }
        done++
      }

      if (Object.keys(zip.files).length === 0) {
        // Everything failed to fetch — almost always a CORS issue on Storage.
        alert(
          'Could not download any assets. This is usually a Firebase Storage CORS setting. ' +
          'Tell me if you see this and I will walk you through the one-time fix.'
        )
        return
      }

      setZipProgress('Building zip…')
      const content = await zip.generateAsync({ type: 'blob' }, (meta) => {
        setZipProgress(`Building zip… ${Math.round(meta.percent)}%`)
      })

      const url = URL.createObjectURL(content)
      const a = document.createElement('a')
      a.href = url
      const gameSlug = safeName(game?.name || gameId || 'game')
      const dateSlug = new Date().toISOString().split('T')[0]
      a.download = `${gameSlug}_highlights_${dateSlug}.zip`
      a.click()
      URL.revokeObjectURL(url)

      if (failed > 0) {
        alert(`Done — but ${failed} video(s) could not be downloaded and were skipped. The rest are in the zip.`)
      }
    } catch (err) {
      console.error('Highlight zip failed:', err)
      alert('Failed to build highlights zip: ' + ((err as Error).message || 'Unknown error'))
    } finally {
      setZipBusy(false)
      setZipProgress('')
    }
  }

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
    await logEvent(gameId, {
      team_id: null,
      event_type: isAlreadyClosed ? 'zone_reopened' : 'zone_closed',
      actor_id: user?.uid ?? null,
      zone_id: zoneId,
    })
  }

  const handleApplyBonuses = async () => {
    if (!gameId || applyingBonuses) return
    setApplyingBonuses(true)
    try {
      await applyEndGameBonuses(gameId, bonusAwards)
      setBonusesApplied(true)
      await logEvent(gameId, {
        team_id: null,
        event_type: 'side_quests_applied',
        actor_id: user?.uid ?? null,
        metadata: { awards: bonusAwards },
      })
    } catch (err) { alert('Failed to apply bonuses: ' + (err as Error).message) }
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
  // ---- Scheduling (what the buttons call) ----

  const finalizeVerdict = (subId: string) => {
    const pv = pendingVerdictsRef.current.get(subId)
    if (!pv) return
    clearTimeout(pv.timer)
    setPendingVerdicts((prev) => { const next = new Map(prev); next.delete(subId); return next })
    const run = pv.kind === 'approve' ? commitRef.current?.approve : commitRef.current?.reject
    if (!run) return
    commitChainRef.current = commitChainRef.current.then(() => run(pv.sub, pv.review)).catch(() => {})
  }

  const undoVerdict = (subId: string) => {
    const pv = pendingVerdictsRef.current.get(subId)
    if (!pv) return
    clearTimeout(pv.timer)
    setPendingVerdicts((prev) => { const next = new Map(prev); next.delete(subId); return next })
  }

  const scheduleVerdict = (kind: 'approve' | 'reject', sub: SubmissionData) => {
    if (pendingVerdictsRef.current.has(sub.id)) return
    const review = getReviewState(sub.id)
    const timer = setTimeout(() => finalizeVerdict(sub.id), UNDO_WINDOW_MS)
    setPendingVerdicts((prev) => {
      const next = new Map(prev)
      next.set(sub.id, { kind, sub, review, deadline: Date.now() + UNDO_WINDOW_MS, timer })
      return next
    })
  }

  const handleApprove = (sub: SubmissionData) => {
    if (!gameId || !game) return

    // HARD BLOCK: a submission in a LOCKED zone can never be approved.
    // Reads lock status from zone_scores (same source as the map).
    const lockedZoneIds = zoneScores.filter((zs) => zs.status === 'locked').map((zs) => zs.zone_id)
    if (sub.zone_id && lockedZoneIds.includes(sub.zone_id)) {
      alert(
        `${sub.zone_id.replace('zone_district_', 'District ').replace('zone_mn_', '')} is LOCKED. ` +
        `Submissions in a locked zone can't be approved — reject this one instead.`
      )
      return
    }

    const closedZones = game.closed_zones ?? []
    if (closedZones.includes(sub.zone_id)) {
      const confirmed = window.confirm(`⚠️ ${sub.zone_id.replace('zone_district_', 'District ')} is closed — approve anyway?`)
      if (!confirmed) return
    }
    scheduleVerdict('approve', sub)
  }

  const handleReject = (sub: SubmissionData) => {
    if (!gameId) return
    const review = getReviewState(sub.id)
    if (!review.notes.trim()) { alert('Please add a note explaining why you are rejecting this.'); return }
    scheduleVerdict('reject', sub)
  }

  // ---- Commits (run when the undo window closes) ----

  const commitApprove = async (sub: SubmissionData, review: ReviewState) => {
    if (!gameId || !game) return
    setProcessing(sub.id)
    try {
      // Snapshot who owns this zone BEFORE approval (for steal detection)
      const previousOwner = zoneOwnership.get(sub.zone_id)

      // Single scoring path — all point math lives in scoring.ts
      const result = await approveSubmission(
        sub.id,
        user?.uid ?? '',
        review.tier2Approved,
        review.phoneFreeBonus > 0
      )

    // Auto-broadcasts for zone events
      const approvedTeam = getTeam(sub.team_id)
      const zoneName = allZoneData.find((z: any) => z.id === sub.zone_id)?.name ?? sub.zone_id

      if (result.zoneLocked) {
        // Zone locked — broadcast to all teams
        await sendGMBroadcast(gameId, user?.uid ?? '', 'Foray',
          `🔒 ${zoneName || 'A zone'} has been LOCKED by ${approvedTeam?.name ?? 'a team'}!`)
        await logEvent(gameId, {
          team_id: sub.team_id,
          event_type: 'zone_locked',
          actor_id: user?.uid ?? null,
          zone_id: sub.zone_id,
          points_delta: game.settings.zone_bonus_points ?? 3,
          metadata: { points_awarded: result.pointsAwarded },
        })
      } else if (result.zoneStolen && previousOwner && previousOwner.teamId !== sub.team_id) {
        // Zone stolen — broadcast to all teams
        await sendGMBroadcast(gameId, user?.uid ?? '', 'Foray',
          `🔁 ${zoneName} was just stolen by ${approvedTeam?.name ?? 'a team'}!`)
        await logEvent(gameId, {
          team_id: sub.team_id,
          event_type: 'zone_stolen',
          actor_id: user?.uid ?? null,
          zone_id: sub.zone_id,
          metadata: {
            previous_owner_team_id: previousOwner.teamId,
            previous_owner_name: previousOwner.teamName,
            points_awarded: result.pointsAwarded,
          },
        })
      } else if (result.zoneClaimed) {
        // Zone claimed — broadcast to all teams
        await sendGMBroadcast(gameId, user?.uid ?? '', 'Foray',
          `🏴 ${zoneName} has been CLAIMED by ${approvedTeam?.name ?? 'a team'}!`)
        await logEvent(gameId, {
          team_id: sub.team_id,
          event_type: 'zone_claimed',
          actor_id: user?.uid ?? null,
          zone_id: sub.zone_id,
          metadata: { points_awarded: result.pointsAwarded },
        })
      }

 // Card replacement — draw a new card using shared utility
      try {
        const compositionRules = {
          minEasy: game.settings.hand_min_easy ?? 1,
          minHard: game.settings.hand_min_hard ?? 1,
          maxHard: game.settings.hand_max_hard ?? 2,
        }
        const drawnCardId = await drawReplacementCard(gameId, sub.team_id, sub.challenge_id, compositionRules)

        if (drawnCardId) {
          await logEvent(gameId, {
            team_id: sub.team_id,
            event_type: 'card_drawn',
            actor_id: user?.uid ?? null,
            challenge_id: drawnCardId,
            metadata: { reason: 'replacement', completed_challenge_id: sub.challenge_id },
          })
        }
      } catch (dealErr) { console.error('Replacement card dealing failed:', dealErr) }

      setReviewState((prev) => { const next = new Map(prev); next.delete(sub.id); return next })
    } catch (err) {
      console.error('Approve failed:', err)
      alert('Error approving: ' + ((err as Error).message || 'Unknown error'))
    } finally { setProcessing(null) }
  }

  const commitReject = async (sub: SubmissionData, review: ReviewState) => {
    if (!gameId) return
    setProcessing(sub.id)
    try {
      await updateDoc(doc(db, 'submissions', sub.id), {
        status: 'rejected', gm_notes: review.notes.trim(),
        reviewed_by: user?.uid || null, reviewed_at: serverTimestamp(),
        highlight: false, // a rejected submission can't be a highlight
      })
      setReviewState((prev) => { const next = new Map(prev); next.delete(sub.id); return next })
    } catch (err) { alert('Error rejecting: ' + ((err as Error).message || 'Unknown error')) }
    finally { setProcessing(null) }
  }
  commitRef.current = { approve: commitApprove, reject: commitReject }

  const handleEndGame = async () => {
  if (!gameId || !window.confirm('End this game? Side quest bonus points will be awarded automatically. This cannot be undone.')) return
  try {
    await updateDoc(doc(db, 'games', gameId), { status: 'ended', ended_at: serverTimestamp() })
  } catch (err) {
    alert('Failed to end the game: ' + (err as Error).message)
  }
  // Bonuses are applied by the "game ended" effect below, which also covers
  // the clock running out and a GM opening the dashboard after the fact.
  }

  // Apply side quest points automatically once the game is over. Winners are
  // auto-picked (most zones claimed, most zones with a challenge, and each
  // photo side quest by approved count); an exact tie awards nothing for that
  // category. Runs once per dashboard session and is guarded server-side by
  // the bonuses_applied flag, so a second dashboard can't double-award.
  const autoApplyStartedRef = useRef(false)
  const sideQuestTalliesRef = useRef(sideQuestTallies)
  sideQuestTalliesRef.current = sideQuestTallies
  useEffect(() => {
    if (!gameId || !user || game?.status !== 'ended' || game.bonuses_applied) return
    const questCount = game.settings?.side_quests?.length ?? 0
    if (questCount > 0 && !sideQuestSubsLoaded) return   // wait for the tally before picking photo winners
    if (autoApplyStartedRef.current) return
    autoApplyStartedRef.current = true

    ;(async () => {
      try {
        const summaries = await getTeamBonusSummaries(gameId)
        const awards: BonusAwards = {
          mostZonesClaimed: autoSelectMostZonesClaimed(summaries),
          mostZonesWithChallenges: autoSelectMostZonesWithChallenges(summaries),
          sideQuests: {},
        }
        for (const quest of (game.settings?.side_quests ?? []) as SideQuest[]) {
          const byTeam = sideQuestTalliesRef.current.get(quest.id)
          let winner: string | null = null
          if (byTeam && byTeam.size > 0) {
            const sorted = [...byTeam.entries()].sort((a, b) => b[1] - a[1])
            winner = sorted.length > 1 && sorted[0][1] === sorted[1][1] ? null : sorted[0][0]
          }
          awards.sideQuests![quest.id] = winner
        }
        await applyEndGameBonuses(gameId, awards)
        setBonusAwards(awards)
        setBonusesApplied(true)
        await logEvent(gameId, {
          team_id: null,
          event_type: 'side_quests_applied',
          actor_id: user.uid,
          metadata: { awards, auto: true },
        })
      } catch (err) {
        const msg = (err as Error).message || ''
        if (/already applied/i.test(msg)) { setBonusesApplied(true); return }
        console.error('Auto side quest application failed:', err)
        alert('Side quest points could not be applied automatically. Use "Apply Side Quest Points" in the Side Quests panel.')
        autoApplyStartedRef.current = false
      }
    })()
  }, [gameId, user, game?.status, game?.bonuses_applied, game?.settings?.side_quests, sideQuestSubsLoaded])

  const handlePauseResume = async () => {
  if (!gameId || !game) return

  if (game.status === 'paused') {
    // Resuming — extend ends_at by how long we were paused
    const pausedAt = game.paused_at?.toDate
      ? game.paused_at.toDate()
      : new Date(game.paused_at)
    const pausedMs = Date.now() - pausedAt.getTime()
    const currentEndsAt = game.ends_at?.toDate
      ? game.ends_at.toDate()
      : new Date(game.ends_at)
    const newEndsAt = new Date(currentEndsAt.getTime() + pausedMs)

    await updateDoc(doc(db, 'games', gameId), {
      status: 'active',
      ends_at: newEndsAt,
      paused_at: null,
    })
    await logEvent(gameId, {
      team_id: null,
      event_type: 'game_resumed',
      actor_id: user?.uid ?? null,
      metadata: { paused_ms: pausedMs, new_ends_at: newEndsAt.toISOString() },
    })
  } else {
    // Pausing — record when we paused
    await updateDoc(doc(db, 'games', gameId), {
      status: 'paused',
      paused_at: new Date(),
    })
    await logEvent(gameId, {
      team_id: null,
      event_type: 'game_paused',
      actor_id: user?.uid ?? null,
    })
  }
}

  const getTeam = (teamId: string) => teams.find((t) => t.id === teamId)
  const filteredSubmissions = filter === 'all' ? submissions : submissions.filter((s) => s.status === filter)
  const pendingCount = submissions.filter((s) => s.status === 'pending').length
  // Chat badge = unread flagged messages (the attention queue size).
  const totalUnread = attentionQueue.length

  const zoneOwnership = new Map<string, { teamId: string; teamColor: string; teamName: string; points: number; status: ZoneScoreData['status'] }>()
  // Track ALL zone scores (not just claimed) so the map can show partial progress shading
  for (const zs of zoneScores) {
    if (zs.points > 0) {
      const team = getTeam(zs.team_id)
      if (!team) continue
      // If multiple teams have points in the same zone, show the leading team
      const existing = zoneOwnership.get(zs.zone_id)
      if (!existing || zs.points > existing.points) {
        zoneOwnership.set(zs.zone_id, { teamId: zs.team_id, teamColor: team.color, teamName: team.name, points: zs.points, status: zs.status })
      }
    }
  }
  const mapZoneOwnership = useMemo(() => {
    const m = new Map<string, ZoneOwner>()
    for (const [zoneId, owner] of zoneOwnership) {
      // Read the resolved status scoring.ts wrote, not a points recompute.
      m.set(zoneId, {
        teamColor: owner.teamColor,
        teamName: owner.teamName,
        points: owner.points,
        claimed: owner.status === 'claimed' || owner.status === 'locked',
        locked: owner.status === 'locked',
      })
    }
    return m
  }, [zoneScores, teams])

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
      <div style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink-faint)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 32, height: 32, border: '3px solid var(--line)', borderTopColor: 'var(--marigold)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <p>Loading GM Dashboard...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", display: 'flex', flexDirection: 'column' }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* TOP BAR */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', background: 'var(--paper)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, flexShrink: 0 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
            <span style={{ fontFamily: "'Martian Mono', monospace", fontSize: '0.68rem', color: 'var(--marigold)', textTransform: 'uppercase', letterSpacing: 2 }}>GM Dashboard</span>
            <span style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 4, background: game.status === 'active' ? 'rgba(var(--green-rgb), 0.15)' : game.status === 'paused' ? 'rgba(var(--marigold-rgb), 0.15)' : 'rgba(var(--red-rgb), 0.15)', color: game.status === 'active' ? 'var(--green)' : game.status === 'paused' ? 'var(--marigold)' : 'var(--red)', fontWeight: 700 }}>
              {game.status.toUpperCase()}
            </span>
          </div>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>{game.name}</h1>
          <p style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: 2 }}>
            Code: <span style={{ color: 'var(--ink-muted)', fontFamily: "'Martian Mono', monospace" }}>{game.join_code}</span>
            {' · '}{teams.length} team{teams.length !== 1 ? 's' : ''}
            {' · '}{submissions.length} submissions
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: "'Martian Mono', monospace", fontSize: '1.2rem', fontWeight: 700, color: timeLeft === 'GAME OVER' ? 'var(--red)' : 'var(--marigold)' }}>
            {timeLeft || '—'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {game.status !== 'ended' && (
              <button onClick={handlePauseResume} style={{ background: 'rgba(var(--ink-rgb), 0.05)', border: '1px solid var(--line)', color: 'var(--ink-muted)', padding: '7px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                {game.status === 'paused' ? '▶ Resume' : '⏸ Pause'}
              </button>
            )}
            {game.status !== 'ended' && (
              <button onClick={handleEndGame} style={{ background: 'rgba(var(--red-rgb), 0.08)', border: '1px solid rgba(var(--red-rgb), 0.2)', color: 'var(--red)', padding: '7px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                End Game
              </button>
            )}
            {game.status === 'ended' && (
              <button onClick={() => navigate('/results/' + gameId)} style={{ background: 'rgba(var(--marigold-rgb), 0.12)', border: '1px solid rgba(var(--marigold-rgb), 0.3)', color: 'var(--marigold)', padding: '7px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                🏆 View Results
              </button>
            )}
          </div>
        </div>
      </div>

      {/* TAB BAR */}
      <div style={{ borderBottom: '1px solid var(--line)', background: 'var(--paper)', display: 'flex', padding: '0 20px', flexShrink: 0 }}>
        {([
          { id: 'submissions' as const, label: '📋 Submissions', badge: pendingCount > 0 ? pendingCount : null, badgeColor: 'var(--marigold)' },
          { id: 'map' as const, label: '🗺️ Map & Zones', badge: null, badgeColor: '' },
          { id: 'chat' as const, label: '💬 Chat', badge: totalUnread > 0 ? totalUnread : null, badgeColor: 'var(--red)' },
          { id: 'activity' as const, label: '📜 Activity Log', badge: null, badgeColor: '' },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--marigold)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--marigold)' : 'var(--ink-faint)',
              padding: '12px 18px', fontSize: '0.85rem', fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 7,
            }}
          >
            {tab.label}
            {tab.badge !== null && (
              <span style={{ background: tab.badgeColor, color: 'var(--paper)', fontSize: '0.65rem', fontWeight: 800, padding: '1px 6px', borderRadius: 10, lineHeight: '16px' }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* SIDE QUESTS PANEL (shown when game ended) */}
     {game.status === 'ended' && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', background: bonusesApplied ? 'rgba(var(--green-rgb), 0.03)' : 'rgba(var(--marigold-rgb), 0.03)', flexShrink: 0 }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <p style={{ fontSize: '0.7rem', color: bonusesApplied ? 'var(--green)' : 'var(--marigold)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: bonusesApplied ? 6 : 16 }}>
              {bonusesApplied ? '✅ Side Quests Applied' : '🏁 Award Side Quest Points'}
            </p>

            {bonusesApplied ? (
              <p style={{ color: 'var(--ink-muted)', fontSize: '0.82rem' }}>
                Side Quest points have been added to team totals. Check results to see final scores.
              </p>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 16 }}>

                  {/* Most Zones Claimed */}
                  <div style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', fontWeight: 600, marginBottom: 4 }}>
                      🗺️ Most Zones Claimed
                      <span style={{ color: 'var(--marigold)', marginLeft: 6 }}>+{game.settings.most_zones_claimed_bonus ?? 8} pts</span>
                    </p>
                    <p style={{ fontSize: '0.68rem', color: 'var(--ink-ghost)', marginBottom: 8 }}>Auto-calculated — confirm below</p>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setBonusAwards((p) => ({ ...p, mostZonesClaimed: null }))}
                        style={{ ...smallBtnStyle, background: bonusAwards.mostZonesClaimed === null ? 'rgba(var(--red-rgb), 0.12)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${bonusAwards.mostZonesClaimed === null ? 'rgba(var(--red-rgb), 0.3)' : 'var(--line)'}`, color: bonusAwards.mostZonesClaimed === null ? 'var(--red)' : 'var(--ink-faint)' }}
                      >
                        None
                      </button>
                      {bonusSummaries.map((s) => (
                        <button
                          key={s.teamId}
                          onClick={() => setBonusAwards((p) => ({ ...p, mostZonesClaimed: s.teamId }))}
                          style={{ ...smallBtnStyle, background: bonusAwards.mostZonesClaimed === s.teamId ? `${s.teamColor}20` : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${bonusAwards.mostZonesClaimed === s.teamId ? s.teamColor + '50' : 'var(--line)'}`, color: bonusAwards.mostZonesClaimed === s.teamId ? s.teamColor : 'var(--ink-muted)' }}
                        >
                          {s.teamName} ({s.zonesClaimedCount})
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Photo side quests — most approved submissions each */}
                  {(game.settings?.side_quests ?? []).map((quest: SideQuest) => {
                    const byTeam = sideQuestTallies.get(quest.id)
                    const picked = bonusAwards.sideQuests?.[quest.id] ?? null
                    const pick = (teamId: string | null) => {
                      manualSqPicks.current.add(quest.id)
                      setBonusAwards((p) => ({ ...p, sideQuests: { ...(p.sideQuests ?? {}), [quest.id]: teamId } }))
                    }
                    return (
                      <div key={quest.id} style={{ background: 'rgba(var(--pink-rgb), 0.04)', border: '1px solid rgba(var(--pink-rgb), 0.25)', borderRadius: 10, padding: '12px 14px' }}>
                        <p style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', fontWeight: 600, marginBottom: 4 }}>
                          🧩 {quest.title}
                          <span style={{ color: 'var(--marigold)', marginLeft: 6 }}>+{quest.bonus_points} pts</span>
                        </p>
                        <p style={{ fontSize: '0.68rem', color: 'var(--ink-ghost)', marginBottom: 8 }}>Most approved photo submissions — confirm below</p>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          <button
                            onClick={() => pick(null)}
                            style={{ ...smallBtnStyle, background: picked === null ? 'rgba(var(--red-rgb), 0.12)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${picked === null ? 'rgba(var(--red-rgb), 0.3)' : 'var(--line)'}`, color: picked === null ? 'var(--red)' : 'var(--ink-faint)' }}
                          >
                            None
                          </button>
                          {teams.map((t) => (
                            <button
                              key={t.id}
                              onClick={() => pick(t.id)}
                              style={{ ...smallBtnStyle, background: picked === t.id ? `${t.color}20` : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${picked === t.id ? t.color + '50' : 'var(--line)'}`, color: picked === t.id ? t.color : 'var(--ink-muted)' }}
                            >
                              {t.name} ({byTeam?.get(t.id) ?? 0})
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}

                  {/* Most Zones With Challenges */}
                  <div style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px' }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', fontWeight: 600, marginBottom: 4 }}>
                      🏆 Most Zones Explored
                      <span style={{ color: 'var(--marigold)', marginLeft: 6 }}>+{game.settings.most_zones_with_challenges_bonus ?? 8} pts</span>
                    </p>
                    <p style={{ fontSize: '0.68rem', color: 'var(--ink-ghost)', marginBottom: 8 }}>Zones with at least 1 challenge completed</p>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => setBonusAwards((p) => ({ ...p, mostZonesWithChallenges: null }))}
                        style={{ ...smallBtnStyle, background: bonusAwards.mostZonesWithChallenges === null ? 'rgba(var(--red-rgb), 0.12)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${bonusAwards.mostZonesWithChallenges === null ? 'rgba(var(--red-rgb), 0.3)' : 'var(--line)'}`, color: bonusAwards.mostZonesWithChallenges === null ? 'var(--red)' : 'var(--ink-faint)' }}
                      >
                        None
                      </button>
                      {bonusSummaries.map((s) => (
                        <button
                          key={s.teamId}
                          onClick={() => setBonusAwards((p) => ({ ...p, mostZonesWithChallenges: s.teamId }))}
                          style={{ ...smallBtnStyle, background: bonusAwards.mostZonesWithChallenges === s.teamId ? `${s.teamColor}20` : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${bonusAwards.mostZonesWithChallenges === s.teamId ? s.teamColor + '50' : 'var(--line)'}`, color: bonusAwards.mostZonesWithChallenges === s.teamId ? s.teamColor : 'var(--ink-muted)' }}
                        >
                          {s.teamName} ({s.zonesWithChallengesCount})
                        </button>
                      ))}
                    </div>
                  </div>

                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <button
                    onClick={handleApplyBonuses}
                    disabled={applyingBonuses}
                    style={{ background: applyingBonuses ? 'var(--line)' : 'rgba(var(--marigold-rgb), 0.15)', border: '1px solid rgba(var(--marigold-rgb), 0.3)', color: applyingBonuses ? 'var(--ink-ghost)' : 'var(--marigold)', padding: '10px 20px', borderRadius: 10, fontSize: '0.88rem', fontWeight: 700, cursor: applyingBonuses ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                  >
                    {applyingBonuses ? 'Applying...' : 'Apply Side Quest Points'}
                  </button>
                  <p style={{ fontSize: '0.72rem', color: 'var(--ink-faint)' }}>One-time. Points are permanent.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HIGHLIGHTS PULL PANEL (shown when game ended) */}
      {game.status === 'ended' && (() => {
        const flaggedCount = submissions.filter(
          (s) => s.highlight === true && s.status === 'approved' && ZIP_MEDIA_TYPES.includes(s.media_type)
        ).length
        return (
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', background: 'rgba(var(--ink-rgb), 0.01)', flexShrink: 0 }}>
            <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <p style={{ fontSize: '0.7rem', color: 'var(--marigold)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: 4 }}>
                  ⭐ Highlight Reel
                </p>
                <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', margin: 0 }}>
                  {flaggedCount > 0
                    ? `${flaggedCount} flagged assets${flaggedCount !== 1 ? 's' : ''} ready — one zip, one folder per team.`
                    : 'No assets flagged yet. Star approved assets to include them.'}
                </p>
                {zipProgress && (
                  <p style={{ fontSize: '0.74rem', color: 'var(--green)', marginTop: 6, fontFamily: "'Martian Mono', monospace" }}>
                    {zipProgress}
                  </p>
                )}
              </div>
              <button
                onClick={handlePullHighlights}
                disabled={zipBusy || flaggedCount === 0}
                style={{ background: zipBusy || flaggedCount === 0 ? 'var(--line)' : 'rgba(var(--marigold-rgb), 0.15)', border: '1px solid rgba(var(--marigold-rgb), 0.3)', color: zipBusy || flaggedCount === 0 ? 'var(--ink-ghost)' : 'var(--marigold)', padding: '10px 20px', borderRadius: 10, fontSize: '0.88rem', fontWeight: 700, cursor: zipBusy ? 'wait' : flaggedCount === 0 ? 'default' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
              >
                {zipBusy ? 'Working…' : '⬇ Pull All Highlights'}
              </button>
            </div>
          </div>
        )
      })()}

      {/* LATE-JOIN REQUESTS — shown on every tab so they're never missed */}
      {joinRequests.length > 0 && (
        <div style={{ background: 'rgba(var(--marigold-rgb), 0.08)', borderBottom: '1px solid rgba(var(--marigold-rgb), 0.3)', padding: '12px 20px', flexShrink: 0 }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <p style={{ color: 'var(--marigold)', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, margin: '0 0 10px' }}>
              🙋 {joinRequests.length} player{joinRequests.length === 1 ? '' : 's'} asking to join
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {joinRequests.map((r) => {
                const pick = joinTeamPick[r.uid] || defaultTeamFor()
                const busy = joinBusy === r.uid
                const size = game?.settings?.team_size
                return (
                  <div key={r.uid} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.95rem', minWidth: 100 }}>{r.name}</span>
                    <select
                      value={pick}
                      onChange={(e) => setJoinTeamPick((prev) => ({ ...prev, [r.uid]: e.target.value }))}
                      disabled={busy}
                      style={{ flex: 1, minWidth: 160, background: 'var(--surface)', color: 'var(--ink-soft)', border: '1px solid var(--line-strong)', borderRadius: 8, padding: '8px 10px', fontFamily: 'inherit', fontSize: '0.85rem' }}
                    >
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.members.length}{size ? `/${size}` : ''})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleApproveJoin(r.uid, r.name)}
                      disabled={busy || !pick}
                      style={{ background: 'var(--green)', color: 'var(--paper)', border: 'none', borderRadius: 8, padding: '8px 14px', fontWeight: 700, fontSize: '0.85rem', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                    >
                      {busy ? '…' : 'Approve'}
                    </button>
                    <button
                      onClick={() => handleDenyJoin(r.uid)}
                      disabled={busy}
                      style={{ background: 'none', color: 'var(--red)', border: '1px solid rgba(var(--red-rgb), 0.4)', borderRadius: 8, padding: '8px 14px', fontWeight: 700, fontSize: '0.85rem', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                    >
                      Deny
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTENT */}
      <div style={{ flex: 1, overflow: 'auto' }}>

        {/* SUBMISSIONS TAB */}
        {activeTab === 'submissions' && (
          <div style={{ maxWidth: 720, margin: '0 auto', padding: '20px 20px 40px' }}>

            {/* SIDE QUEST REVIEW — separate from challenge submissions */}
            {(game.settings?.side_quests?.length ?? 0) > 0 && (
              <div style={{
                background: 'rgba(var(--pink-rgb), 0.04)',
                border: '1px solid rgba(var(--pink-rgb), 0.25)',
                borderRadius: 12, padding: 16, marginBottom: 24,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <p style={{ fontSize: '0.72rem', color: 'var(--pink)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: 0 }}>
                    🧩 Side Quests
                    {sideQuestSubs.filter((s) => s.status === 'pending').length > 0 && (
                      <span style={{ background: 'var(--pink)', color: 'var(--ink)', fontSize: '0.65rem', fontWeight: 800, padding: '1px 7px', borderRadius: 10, marginLeft: 8 }}>
                        {sideQuestSubs.filter((s) => s.status === 'pending').length} pending
                      </span>
                    )}
                  </p>
                  {sideQuestSubs.length > 0 && (
                    <button
                      onClick={exportSideQuestCsv}
                      style={{ background: 'none', border: '1px solid rgba(var(--pink-rgb), 0.35)', color: 'var(--pink)', borderRadius: 8, padding: '5px 12px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      ⬇ Export CSV
                    </button>
                  )}
                </div>
                <p style={{ color: 'var(--ink-muted)', fontSize: '0.75rem', margin: '0 0 12px' }}>
                  Approvals count toward the running tally only — points come from the post-game bonus.
                </p>

                {/* Approved tallies per quest */}
                {(game.settings?.side_quests ?? []).map((quest: SideQuest) => {
                  const byTeam = sideQuestTallies.get(quest.id)
                  return (
                    <p key={quest.id} style={{ margin: '0 0 6px', fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                      <strong style={{ color: 'var(--ink-soft)' }}>{quest.title}</strong>
                      {' — '}
                      {byTeam && byTeam.size > 0
                        ? teams
                            .filter((t) => byTeam.has(t.id))
                            .map((t) => `${t.name}: ${byTeam.get(t.id)}`)
                            .join(' · ')
                        : 'no approvals yet'}
                    </p>
                  )
                })}

                {/* Pending queue */}
                {sideQuestSubs.filter((s) => s.status === 'pending').length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginTop: 12 }}>
                    {sideQuestSubs.filter((s) => s.status === 'pending').map((s) => {
                      const team = teams.find((t) => t.id === s.team_id)
                      const busy = sqProcessing === s.id
                      return (
                        <div key={s.id} style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
                          <a href={s.media_url} target="_blank" rel="noreferrer">
                            <img src={s.media_url} alt="" loading="lazy" style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block', background: 'var(--surface)' }} />
                          </a>
                          <div style={{ padding: '8px 10px' }}>
                            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--ink-soft)', fontWeight: 600 }}>
                              {(s as unknown as { quest_title?: string }).quest_title ?? s.quest_id}
                            </p>
                            <p style={{ margin: '2px 0 8px', fontSize: '0.7rem', color: 'var(--ink-muted)' }}>
                              <span style={{ color: team?.color ?? 'var(--ink-muted)' }}>{team?.name ?? s.team_id}</span>
                              {' · '}{s.submitter_name}
                              {s.gps_lat != null && s.gps_lng != null && (
                                <>
                                  {' · '}
                                  <a
                                    href={`https://www.google.com/maps?q=${s.gps_lat},${s.gps_lng}`}
                                    target="_blank" rel="noreferrer"
                                    style={{ color: 'var(--blue)', textDecoration: 'none' }}
                                  >
                                    📍 GPS
                                  </a>
                                </>
                              )}
                            </p>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                onClick={() => handleReviewSideQuest(s.id, 'approved')}
                                disabled={busy}
                                style={{ flex: 1, background: 'rgba(var(--green-rgb), 0.15)', border: '1px solid rgba(var(--green-rgb), 0.3)', color: 'var(--green)', borderRadius: 6, padding: '6px 0', fontSize: '0.72rem', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                              >
                                ✓ Approve
                              </button>
                              <button
                                onClick={() => handleReviewSideQuest(s.id, 'rejected')}
                                disabled={busy}
                                style={{ flex: 1, background: 'rgba(var(--red-rgb), 0.1)', border: '1px solid rgba(var(--red-rgb), 0.3)', color: 'var(--red)', borderRadius: 6, padding: '6px 0', fontSize: '0.72rem', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                              >
                                ✕ Reject
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {([
                { id: 'pending', label: `Pending (${pendingCount})`, color: 'var(--marigold)' },
                { id: 'approved', label: 'Approved', color: 'var(--green)' },
                { id: 'rejected', label: 'Rejected', color: 'var(--red)' },
                { id: 'all', label: 'All', color: 'var(--ink-muted)' },
              ] as const).map((f) => (
                <button key={f.id} onClick={() => setFilter(f.id)} style={{ background: filter === f.id ? `${f.color}15` : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${filter === f.id ? `${f.color}40` : 'var(--line)'}`, color: filter === f.id ? f.color : 'var(--ink-faint)', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {f.label}
                </button>
              ))}
            </div>

            {filteredSubmissions.length === 0 ? (
              <div style={{ textAlign: 'center', marginTop: 80, color: 'var(--ink-ghost)' }}>
                <p style={{ fontSize: '2rem', marginBottom: 12 }}>{filter === 'pending' ? '✅' : '📋'}</p>
                <p style={{ color: 'var(--ink-faint)', fontWeight: 600 }}>{filter === 'pending' ? 'No pending submissions' : `No ${filter} submissions`}</p>
                <p style={{ color: 'var(--ink-ghost)', fontSize: '0.82rem', marginTop: 6 }}>{filter === 'pending' ? "You're all caught up!" : 'Try switching the filter.'}</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 16 }}>
                {filteredSubmissions.map((sub) => {
                  const challenge = challenges.get(sub.challenge_id)
                  const team = getTeam(sub.team_id)
                  const review = getReviewState(sub.id)
                  const isProcessing = processing === sub.id
                  const diffColor = DIFFICULTY_COLORS[challenge?.difficulty || 'medium'] || 'var(--marigold)'
                  const basePts = (game?.settings as any)?.[`points_${challenge?.difficulty || 'medium'}`] ?? ({ easy: 1, medium: 2, hard: 3 }[challenge?.difficulty || 'medium'] ?? 2)
                  const gpsCheck = checkGpsProximity(sub)

                  return (
                    <div key={sub.id} style={{ background: sub.status === 'pending' ? 'rgba(var(--marigold-rgb), 0.02)' : 'rgba(var(--ink-rgb), 0.02)', border: `1px solid ${sub.status === 'pending' ? 'rgba(var(--marigold-rgb), 0.15)' : 'var(--line)'}`, borderRadius: 14, padding: 20, opacity: isProcessing ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: team?.color || 'var(--ink-faint)' }} />
                          <span style={{ fontWeight: 700, fontSize: '0.88rem' }}>{team?.name || sub.team_id}</span>
                          <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${diffColor}15`, color: diffColor }}>
                            {challenge?.difficulty?.toUpperCase() || '?'} · {basePts}pt
                          </span>
                        </div>
                        {sub.status !== 'pending' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {sub.status === 'approved' && ZIP_MEDIA_TYPES.includes(sub.media_type) && (
                              <button
                                onClick={() => handleToggleHighlight(sub)}
                                title={sub.highlight ? 'Unstar this highlight' : 'Star as a highlight (included in the post-game pull)'}
                                style={{ background: sub.highlight ? 'rgba(var(--marigold-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${sub.highlight ? 'rgba(var(--marigold-rgb), 0.4)' : 'var(--line)'}`, color: sub.highlight ? 'var(--marigold)' : 'var(--ink-faint)', padding: '3px 10px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
                              >
                                {sub.highlight ? '★ Highlight' : '☆ Highlight'}
                              </button>
                            )}
                            <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '3px 10px', borderRadius: 4, background: sub.status === 'approved' ? 'rgba(var(--green-rgb), 0.12)' : 'rgba(var(--red-rgb), 0.12)', color: sub.status === 'approved' ? 'var(--green)' : 'var(--red)' }}>
                              {sub.status === 'approved' ? '✅ Approved' : '❌ Rejected'}
                            </span>
                          </div>
                        )}
                      </div>

                                          {/* Challenge text — resolved task for CYOA cards, else description */}
                      {sub.resolved_task ? (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.62rem', fontWeight: 800, padding: '2px 8px', borderRadius: 20, background: 'rgba(var(--pink-rgb), 0.2)', color: 'var(--pink)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                              🎲 CYOA
                            </span>
                            {sub.step_choices && sub.step_choices.length > 0 && (
                              <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)' }}>
                                locked: {sub.step_choices.join(' · ')}
                              </span>
                            )}
                          </div>
                          <p style={{ color: 'var(--ink)', fontSize: '0.9rem', lineHeight: 1.6, fontWeight: 600, background: 'rgba(var(--pink-rgb), 0.06)', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(var(--pink-rgb), 0.2)' }}>
                            {sub.resolved_task}
                          </p>
                        </div>
                      ) : (
                        <p style={{ color: 'var(--ink-soft)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: 14, background: 'rgba(var(--ink-rgb), 0.02)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--surface)' }}>
                          {challenge?.description || `Challenge: ${sub.challenge_id}`}
                        </p>
                      )}

                      <div style={{ marginBottom: 14 }}>
                        {sub.media_type === 'video' ? (
                          <video src={sub.media_url} controls style={{ width: '100%', maxHeight: 280, borderRadius: 10, background: 'var(--surface)', objectFit: 'contain' }} />
                        ) : sub.media_type === 'audio' ? (
                          <div style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, textAlign: 'center' }}>
                            <span style={{ fontSize: '1.5rem' }}>🎙️</span>
                            <audio src={sub.media_url} controls style={{ width: '100%', marginTop: 8 }} />
                          </div>
                        ) : (
                          <img src={sub.media_url} alt="Submission" style={{ width: '100%', maxHeight: 280, borderRadius: 10, background: 'var(--surface)', objectFit: 'contain' }} />
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--ink-faint)', marginBottom: sub.status === 'pending' ? 14 : 0 }}>
                        {sub.zone_id && <span>📍 {sub.zone_id.replace('zone_district_', 'D')}</span>}
                        {!sub.zone_id && sub.gps_lat && sub.gps_lng && <span style={{ color: 'var(--marigold)' }}>⚠ No zone · GPS: {sub.gps_lat.toFixed(4)}, {sub.gps_lng.toFixed(4)}</span>}
                        {!sub.zone_id && !sub.gps_lat && <span style={{ color: 'var(--red)' }}>⚠ No zone · No GPS</span>}
                        {sub.submitted_at && <span>{sub.submitted_at.toDate ? sub.submitted_at.toDate().toLocaleTimeString() : ''}</span>}
                        {gpsCheck === 'inside' && <span style={{ color: 'var(--green)', fontWeight: 600 }}>✓ GPS in zone</span>}
                        {gpsCheck === 'outside' && <span style={{ color: 'var(--red)', fontWeight: 700 }}>⚠ GPS OUTSIDE zone</span>}
                      </div>

                      {gpsCheck === 'outside' && sub.status === 'pending' && (
                        <div style={{ background: 'rgba(var(--red-rgb), 0.06)', border: '1px solid rgba(var(--red-rgb), 0.2)', borderRadius: 8, padding: '8px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>🚩</span>
                          <p style={{ color: 'var(--red)', fontSize: '0.78rem', fontWeight: 700, margin: 0 }}>GPS outside {sub.zone_id?.replace('zone_district_', 'District ')}</p>
                        </div>
                      )}

                      {sub.status === 'pending' && (
                        <div>
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                            {sub.attempted_tier2 && challenge?.tier2 && (
                              <button onClick={() => updateReviewState(sub.id, { tier2Approved: !review.tier2Approved })} style={{ background: review.tier2Approved ? 'rgba(var(--pink-rgb), 0.12)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${review.tier2Approved ? 'rgba(var(--pink-rgb), 0.3)' : 'var(--line)'}`, color: review.tier2Approved ? 'var(--pink)' : 'var(--ink-muted)', padding: '7px 12px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                                {review.tier2Approved ? '✓' : '○'} Tier 2 (+{challenge.tier2.bonus_points}pt)
                              </button>
                            )}
                            {ZIP_MEDIA_TYPES.includes(sub.media_type) && (
                              <button onClick={() => handleToggleHighlight(sub)} title={sub.highlight ? 'Unstar — won\'t be included in the post-game pull' : 'Star as a highlight (included in the post-game pull)'} style={{ background: sub.highlight ? 'rgba(var(--marigold-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${sub.highlight ? 'rgba(var(--marigold-rgb), 0.4)' : 'var(--line)'}`, color: sub.highlight ? 'var(--marigold)' : 'var(--ink-muted)', padding: '7px 12px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                                {sub.highlight ? '★ Highlight' : '☆ Highlight'}
                              </button>
                            )}
                          </div>

                          {(() => {
                            const tierPts = sub.attempted_tier2 && review.tier2Approved && challenge?.tier2 ? challenge.tier2.bonus_points : 0
                            const total = basePts + tierPts
                            return (
                              <div style={{ background: 'rgba(var(--ink-rgb), 0.03)', borderRadius: 8, padding: '8px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>{basePts}pt base{tierPts > 0 && ` + ${tierPts}pt tier2`}</span>
                                <span style={{ fontFamily: "'Martian Mono', monospace", fontSize: '1rem', fontWeight: 700, color: 'var(--marigold)' }}>= {total}pt</span>
                              </div>
                            )
                          })()}

                          <input type="text" placeholder="Rejection reason (required to reject)" value={review.notes} onChange={(e) => updateReviewState(sub.id, { notes: e.target.value })} style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px', color: 'var(--ink-soft)', fontSize: '0.82rem', fontFamily: 'inherit', marginBottom: 10, boxSizing: 'border-box' }} />
                          {(() => {
                            const pv = pendingVerdicts.get(sub.id)
                            if (pv) {
                              const secsLeft = Math.max(0, Math.ceil((pv.deadline - Date.now()) / 1000))
                              const isApprove = pv.kind === 'approve'
                              const rgb = isApprove ? 'var(--green-rgb)' : 'var(--red-rgb)'
                              const ink = isApprove ? 'var(--green)' : 'var(--red)'
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: `rgba(${rgb}, 0.08)`, border: `1px solid rgba(${rgb}, 0.25)`, borderRadius: 10, padding: '10px 12px' }}>
                                  <span style={{ flex: 1, color: ink, fontSize: '0.85rem', fontWeight: 700 }}>
                                    {isApprove ? '✓ Approving' : '✗ Rejecting'} in {secsLeft}s…
                                  </span>
                                  <button onClick={() => undoVerdict(sub.id)} style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', color: 'var(--ink)', padding: '8px 14px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Undo
                                  </button>
                                  <button onClick={() => finalizeVerdict(sub.id)} style={{ background: `rgba(${rgb}, 0.15)`, border: `1px solid rgba(${rgb}, 0.3)`, color: ink, padding: '8px 14px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Apply now
                                  </button>
                                </div>
                              )
                            }
                            return (
                          <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => handleApprove(sub)} disabled={isProcessing} style={{ flex: 2, background: 'rgba(var(--green-rgb), 0.15)', border: '1px solid rgba(var(--green-rgb), 0.3)', color: 'var(--green)', padding: '12px', borderRadius: 10, fontSize: '0.9rem', fontWeight: 700, cursor: isProcessing ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                              {isProcessing ? 'Processing...' : '✓ Approve'}
                            </button>
                            <button onClick={() => handleReject(sub)} disabled={isProcessing} style={{ flex: 1, background: 'rgba(var(--red-rgb), 0.08)', border: '1px solid rgba(var(--red-rgb), 0.2)', color: 'var(--red)', padding: '12px', borderRadius: 10, fontSize: '0.9rem', fontWeight: 700, cursor: isProcessing ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                              ✗ Reject
                            </button>
                          </div>
                            )
                          })()}
                        </div>
                      )}
                      {sub.status === 'rejected' && sub.gm_notes && (
                        <p style={{ color: 'var(--red)', fontSize: '0.82rem', marginTop: 10, fontStyle: 'italic' }}>GM: {sub.gm_notes}</p>
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
                  <div key={team.id} style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: `1px solid ${rank === 0 && team.total_points > 0 ? `${team.color}40` : 'var(--line)'}`, borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, background: team.color }} />
                        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{team.name}</span>
                      </div>
                      <span style={{ fontFamily: "'Martian Mono', monospace", fontSize: '1.1rem', fontWeight: 700, color: team.total_points > 0 ? 'var(--ink)' : 'var(--ink-ghost)' }}>{team.total_points}</span>
                    </div>
                    {team.zoneBreakdown.length > 0 ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {team.zoneBreakdown.map((zs) => {
                          const owned = zs.status === 'claimed' || zs.status === 'locked'
                          return (
                          <span key={zs.zone_id} style={{ fontSize: '0.68rem', padding: '3px 8px', borderRadius: 4, background: owned ? `${team.color}20` : 'rgba(var(--ink-rgb), 0.04)', border: `1px solid ${owned ? `${team.color}40` : 'var(--line)'}`, color: owned ? team.color : 'var(--ink-faint)', fontWeight: 600, fontFamily: "'Martian Mono', monospace" }}>
                            {formatZoneLabel(zs.zone_id)} · {zs.points}pt{zs.status === 'locked' ? ' 🔒' : zs.status === 'claimed' ? ' ★' : ''}
                          </span>
                          )
                        })}
                      </div>
                    ) : <p style={{ fontSize: '0.75rem', color: 'var(--ink-ghost)', fontStyle: 'italic' }}>No points yet</p>}
                  </div>
                ))}
              </div>

              <p style={sectionLabel}>Live Map</p>
              <div style={{ height: 380, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface)', marginBottom: 28 }}>
                {activeZones.length > 0
                  ? <GameMap zones={activeZones} zoneOwnership={mapZoneOwnership.size > 0 ? mapZoneOwnership : undefined} closedZones={game.closed_zones ?? []} playerLocations={playerLocations} showGeolocate={false} />
                  : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-ghost)', fontSize: '0.78rem' }}>No zone data loaded</div>}
              </div>

              <p style={sectionLabel}>Team Hands</p>
              <div style={{ display: 'grid', gap: 16, marginBottom: 40 }}>
                {teams.map((team) => (
                  <div key={team.id} style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: `1px solid ${team.color}25`, borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: team.color }} />
                      <span style={{ fontWeight: 700, fontSize: '0.88rem', color: team.color }}>{team.name}</span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--ink-ghost)' }}>{team.hand?.length ?? 0} cards</span>
                    </div>
                    {team.hand && team.hand.length > 0 ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {team.hand.map((challengeId) => {
                          const ch = challenges.get(challengeId)
                          if (!ch) return <span key={challengeId} />
                          const diffColor = DIFFICULTY_COLORS[ch.difficulty] || 'var(--ink-muted)'
                          return (
                            <div key={challengeId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', background: 'rgba(var(--ink-rgb), 0.02)', border: '1px solid var(--line)', borderRadius: 8 }}>
                              <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: `${diffColor}15`, color: diffColor, flexShrink: 0, marginTop: 2 }}>
                                {ch.difficulty?.toUpperCase()}
                              </span>
                              <p style={{ color: 'var(--ink-soft)', fontSize: '0.82rem', lineHeight: 1.5, margin: 0 }}>{ch.description}</p>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p style={{ color: 'var(--ink-ghost)', fontSize: '0.78rem', fontStyle: 'italic' }}>No cards in hand</p>
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
                    <div key={zoneId} style={{ background: isClosed ? 'rgba(var(--ink-rgb), 0.01)' : owner ? `${owner.teamColor}08` : 'rgba(var(--ink-rgb), 0.02)', border: `1px solid ${isClosed ? 'var(--line-strong)' : owner ? `${owner.teamColor}30` : 'var(--line)'}`, borderRadius: 10, padding: '10px 12px', opacity: isClosed ? 0.6 : 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: owner || isClosed ? 6 : 0 }}>
                        <span style={{ fontSize: '0.78rem', color: owner ? 'var(--ink-soft)' : 'var(--ink-ghost)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {allZoneData.find((z: any) => z.id === zoneId)?.name ?? formatZoneLabel(zoneId)}
                        </span>
                        {isClosed && (
                          <span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(var(--ink-rgb), 0.05)', border: '1px solid var(--line-strong)', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 1 }}>
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
                          <p style={{ fontSize: '0.72rem', color: 'var(--ink-ghost)', fontStyle: 'italic', margin: 0 }}>
                            {isClosed ? '—' : 'Unclaimed'}
                          </p>
                        )}
                        {game.status === 'active' && (
                          <button
                            onClick={() => handleCloseZone(zoneId)}
                            style={{ background: isClosed ? 'rgba(var(--green-rgb), 0.08)' : 'rgba(var(--red-rgb), 0.08)', border: `1px solid ${isClosed ? 'rgba(var(--green-rgb), 0.2)' : 'rgba(var(--red-rgb), 0.2)'}`, color: isClosed ? 'var(--green)' : 'var(--red)', padding: '4px 8px', borderRadius: 6, fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0 }}
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

            {/* ── NEEDS YOUR ATTENTION queue ── */}
            <div style={{ marginBottom: 28 }}>
              <p style={{ fontSize: '0.72rem', color: attentionQueue.length > 0 ? 'var(--red)' : 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                🔔 Needs Your Attention
                {attentionQueue.length > 0 && (
                  <span style={{ background: 'var(--red)', color: 'var(--paper)', fontSize: '0.68rem', fontWeight: 800, padding: '1px 7px', borderRadius: 10 }}>
                    {attentionQueue.length}
                  </span>
                )}
              </p>

              {attentionQueue.length === 0 ? (
                <div style={{ background: 'rgba(var(--ink-rgb), 0.02)', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 18px', textAlign: 'center' }}>
                  <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem', margin: 0 }}>
                    No messages need your attention. Player “Message GM” pings show up here.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {attentionQueue.map((msg) => {
                    const team = teams.find((t) => t.id === msg.team_id)
                    const teamColor = team?.color || 'var(--ink-muted)'
                    return (
                      <button
                        key={msg.id}
                        onClick={() => setSelectedTeamId(msg.team_id)}
                        style={{
                          textAlign: 'left', width: '100%',
                          background: `${teamColor}0d`,
                          border: `1px solid ${teamColor}40`,
                          borderLeft: `3px solid ${teamColor}`,
                          borderRadius: 10, padding: '12px 14px',
                          cursor: 'pointer', fontFamily: 'inherit',
                          display: 'flex', flexDirection: 'column', gap: 5,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <div style={{ width: 9, height: 9, borderRadius: 2, background: teamColor, flexShrink: 0 }} />
                          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: teamColor }}>
                            {team?.name ?? msg.team_id}
                          </span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)' }}>
                            · {msg.from_name || 'Player'}
                          </span>
                          <span style={{ fontSize: '0.66rem', color: 'var(--ink-ghost)', marginLeft: 'auto', fontFamily: "'Martian Mono', monospace" }}>
                            {msg.sent_at?.toDate ? msg.sent_at.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                          </span>
                        </div>
                        <p style={{ color: 'var(--ink-soft)', fontSize: '0.86rem', lineHeight: 1.45, margin: 0 }}>
                          {msg.text}
                        </p>
                        <span style={{ fontSize: '0.68rem', color: teamColor, fontWeight: 600 }}>
                          Tap to reply →
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <p style={sectionLabel}>Broadcast to All Teams</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
              <input type="text" value={broadcastInput} onChange={(e) => setBroadcastInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleBroadcast() }} placeholder="📢 Message all teams at once..." style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: 10, padding: '12px 14px', color: 'var(--ink)', fontSize: '0.88rem', fontFamily: 'inherit', outline: 'none' }} />
              <button onClick={handleBroadcast} disabled={!broadcastInput.trim() || broadcasting} style={{ background: broadcastInput.trim() ? 'rgba(var(--marigold-rgb), 0.15)' : 'var(--line)', border: '1px solid rgba(var(--marigold-rgb), 0.3)', color: 'var(--marigold)', padding: '12px 18px', borderRadius: 10, fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: broadcasting ? 0.5 : 1 }}>
                {broadcasting ? '...' : 'Send All'}
              </button>
            </div>

      {/* Broadcast history — shows all gm_broadcast messages sent this game */}
      {chatMessages.filter((m) => m.channel_type === 'gm_broadcast').length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <p style={{ fontSize: '0.68rem', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>
            Broadcast History
          </p>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
            {chatMessages
              .filter((m) => m.channel_type === 'gm_broadcast')
              .map((msg) => (
                <div key={msg.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--ink-ghost)', flexShrink: 0, marginTop: 3, fontFamily: "'Martian Mono', monospace" }}>
                    {msg.sent_at?.toDate
                      ? msg.sent_at.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      : ''}
                  </span>
                  <p style={{ color: 'var(--ink-muted)', fontSize: '0.82rem', lineHeight: 1.5, margin: 0 }}>
                    📢 {msg.text}
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}

            <p style={sectionLabel}>Team Messages</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {teams.map((t) => {
                // Per-team unread count = flagged (team_to_gm) messages still in the
                // attention queue for this team.
                const unread = attentionQueue.filter((m) => m.team_id === t.id).length
                return (
                  <button key={t.id} onClick={() => setSelectedTeamId(selectedTeamId === t.id ? null : t.id)} style={{ background: selectedTeamId === t.id ? `${t.color}20` : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${selectedTeamId === t.id ? `${t.color}40` : 'var(--line)'}`, color: selectedTeamId === t.id ? t.color : 'var(--ink-muted)', padding: '8px 16px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', position: 'relative' }}>
                    {t.name}
                    {unread > 0 && <span style={{ position: 'absolute', top: -4, right: -4, width: 8, height: 8, borderRadius: '50%', background: 'var(--red)' }} />}
                  </button>
                )
              })}
            </div>

            {selectedTeamId ? (
              <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ maxHeight: 380, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {chatMessages
                    .filter((m) => m.team_id === selectedTeamId && (m.channel_type === 'team_internal' || m.channel_type === 'team_to_gm' || m.channel_type === 'gm_to_team'))
                    .map((msg) => {
                      const isFromGM = msg.channel_type === 'gm_to_team'
                      const isFlagged = msg.channel_type === 'team_to_gm'
                      return (
                        <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isFromGM ? 'flex-end' : 'flex-start' }}>
                          <p style={{ fontSize: '0.65rem', color: isFlagged ? 'var(--marigold)' : 'var(--ink-ghost)', marginBottom: 4, fontWeight: isFlagged ? 700 : 400 }}>
                            {isFromGM ? '🎮 You (GM)' : isFlagged ? `🔔 ${msg.from_name || 'Player'} → GM` : (msg.from_name || 'Player')}
                          </p>
                          <div style={{ maxWidth: '80%', background: isFromGM ? 'rgba(var(--marigold-rgb), 0.08)' : isFlagged ? 'rgba(var(--marigold-rgb), 0.06)' : 'rgba(var(--ink-rgb), 0.04)', border: `1px solid ${isFromGM ? 'rgba(var(--marigold-rgb), 0.2)' : isFlagged ? 'rgba(var(--marigold-rgb), 0.3)' : 'var(--line)'}`, borderRadius: 10, padding: '10px 14px' }}>
                            <p style={{ color: 'var(--ink-soft)', fontSize: '0.85rem', lineHeight: 1.5, margin: 0 }}>{msg.text}</p>
                          </div>
                        </div>
                      )
                    })}
                  <div ref={chatBottomRef} />
                </div>
                <div style={{ display: 'flex', gap: 8, padding: '12px 14px', borderTop: '1px solid var(--line)', background: 'var(--paper)' }}>
                  <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleGMReply() }} placeholder={`Reply to ${teams.find(t => t.id === selectedTeamId)?.name}...`} style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', color: 'var(--ink)', fontSize: '0.85rem', fontFamily: 'inherit', outline: 'none' }} />
                  <button onClick={handleGMReply} disabled={!chatInput.trim() || chatSending} style={{ background: chatInput.trim() ? 'rgba(var(--marigold-rgb), 0.15)' : 'var(--line)', border: '1px solid rgba(var(--marigold-rgb), 0.3)', color: 'var(--marigold)', padding: '10px 14px', borderRadius: 8, fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: chatSending ? 0.5 : 1 }}>↑</button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--ink-ghost)' }}>
                <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>💬</p>
                <p style={{ fontWeight: 600, color: 'var(--ink-faint)' }}>Select a team above to view their messages</p>
              </div>
            )}
          </div>
        )}

        {/* ACTIVITY LOG TAB */}
        {activeTab === 'activity' && (
          <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 20px 60px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <p style={sectionLabel}>Activity Log</p>
                <p style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginTop: -8 }}>
                  Chronological feed of every event this game · {activityRows.length} entries
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={refreshActivityLog}
                  disabled={activityLoading}
                  style={{ background: 'rgba(var(--ink-rgb), 0.05)', border: '1px solid var(--line)', color: 'var(--ink-muted)', padding: '8px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: activityLoading ? 'wait' : 'pointer', fontFamily: 'inherit' }}
                >
                  {activityLoading ? '⏳ Loading...' : '↻ Refresh'}
                </button>
                <button
                  onClick={handleDownloadActivityCSV}
                  disabled={activityRows.length === 0}
                  style={{ background: activityRows.length > 0 ? 'rgba(var(--green-rgb), 0.12)' : 'var(--line)', border: '1px solid rgba(var(--green-rgb), 0.3)', color: activityRows.length > 0 ? 'var(--green)' : 'var(--ink-ghost)', padding: '8px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 700, cursor: activityRows.length > 0 ? 'pointer' : 'default', fontFamily: 'inherit' }}
                >
                  ⬇ Download CSV
                </button>
              </div>
            </div>

            {/* Team filter chips */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
              <button
                onClick={() => setActivityTeamFilter('all')}
                style={{ background: activityTeamFilter === 'all' ? 'rgba(var(--marigold-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${activityTeamFilter === 'all' ? 'rgba(var(--marigold-rgb), 0.4)' : 'var(--line)'}`, color: activityTeamFilter === 'all' ? 'var(--marigold)' : 'var(--ink-faint)', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                All ({activityRows.length})
              </button>
              {teams.map((t) => {
                const count = activityRows.filter((r) => r.team_id === t.id).length
                return (
                  <button
                    key={t.id}
                    onClick={() => setActivityTeamFilter(t.id)}
                    style={{ background: activityTeamFilter === t.id ? `${t.color}20` : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${activityTeamFilter === t.id ? `${t.color}50` : 'var(--line)'}`, color: activityTeamFilter === t.id ? t.color : 'var(--ink-faint)', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    {t.name} ({count})
                  </button>
                )
              })}
              <button
                onClick={() => setActivityTeamFilter('' as any)}
                style={{ background: (activityTeamFilter as any) === '' ? 'rgba(var(--pink-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)', border: `1px solid ${(activityTeamFilter as any) === '' ? 'rgba(var(--pink-rgb), 0.4)' : 'var(--line)'}`, color: (activityTeamFilter as any) === '' ? 'var(--pink)' : 'var(--ink-faint)', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                System/GM only
              </button>
            </div>

            {activityLoading && activityRows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--ink-ghost)' }}>
                <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>⏳</p>
                <p>Loading activity log...</p>
              </div>
            ) : activityRows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--ink-ghost)' }}>
                <p style={{ fontSize: '1.5rem', marginBottom: 8 }}>📜</p>
                <p style={{ fontWeight: 600, color: 'var(--ink-faint)' }}>No activity yet</p>
                <p style={{ fontSize: '0.82rem', color: 'var(--ink-ghost)', marginTop: 6 }}>Events will appear here once the game starts.</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {activityRows
                  .filter((r) => {
                    if (activityTeamFilter === 'all') return true
                    if ((activityTeamFilter as any) === '') return r.team_id === null
                    return r.team_id === activityTeamFilter
                  })
                  .map((r, i) => (
                    <div
                      key={i}
                      style={{
                        background: 'rgba(var(--ink-rgb), 0.02)',
                        border: `1px solid ${r.team_color ? r.team_color + '20' : 'var(--line)'}`,
                        borderLeft: r.team_color ? `3px solid ${r.team_color}` : '3px solid var(--line-strong)',
                        borderRadius: 8,
                        padding: '10px 14px',
                        display: 'grid',
                        gridTemplateColumns: '90px 110px 1fr 90px',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <span style={{ fontFamily: "'Martian Mono', monospace", fontSize: '0.7rem', color: 'var(--ink-faint)' }}>
                        {r.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: r.team_color ?? 'var(--ink-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.team_name ?? 'System'}
                      </span>
                      <span style={{ fontSize: '0.84rem', color: 'var(--ink-soft)', lineHeight: 1.4 }}>
                        {r.details}
                        {r.gm_notes && <span style={{ color: 'var(--red)', fontStyle: 'italic', marginLeft: 6 }}>— {r.gm_notes}</span>}
                      </span>
                      <span style={{ fontFamily: "'Martian Mono', monospace", fontSize: '0.72rem', color: r.points_delta && r.points_delta > 0 ? 'var(--green)' : 'var(--ink-ghost)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.points_delta !== null && r.points_delta !== 0 ? (r.points_delta > 0 ? `+${r.points_delta}pt` : `${r.points_delta}pt`) : ''}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Full-screen map overlay */}
      {showFullMap && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--paper)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--paper)', flexShrink: 0 }}>
            <p style={{ fontSize: '0.82rem', color: 'var(--marigold)', fontWeight: 700, margin: 0 }}>🗺️ Zone Map — {game.name}</p>
            <button onClick={() => setShowFullMap(false)} style={{ background: 'rgba(var(--ink-rgb), 0.05)', border: '1px solid var(--line)', color: 'var(--ink-soft)', padding: '6px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>✕ Close</button>
          </div>
          <div style={{ flex: 1 }}>
            <GameMap zones={activeZones} zoneOwnership={mapZoneOwnership.size > 0 ? mapZoneOwnership : undefined} closedZones={game.closed_zones ?? []} playerLocations={playerLocations} showGeolocate={false} />
          </div>
        </div>
      )}
    </div>
  )
}

const sectionLabel: React.CSSProperties = {
  fontSize: '0.72rem',
  color: 'var(--marigold)',
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

// Make a string safe for use as a filename / folder name.
function safeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9-_ ]/g, '')  // strip anything not filename-safe
    .trim()
    .replace(/\s+/g, '_')              // spaces → underscores
    .slice(0, 60) || 'untitled'        // cap length, never empty
}

function extensionFor(mediaType: 'photo' | 'video' | 'audio'): string {
  if (mediaType === 'video') return 'mp4'
  if (mediaType === 'audio') return 'm4a'
  return 'jpg'
}