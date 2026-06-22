// =============================================================================
// Zone Rush — Game Lobby
// GM can start the game. On start, GM routes to /gm-dashboard/:gameId, players route to /game/:gameId.
// Real-time updates via Firestore listeners.
//
// CHANGES (Sprint 2 — name pick, v2):
//   - Players pick a display name BEFORE being placed on a team. Both
//     "Join [team]" and "Auto-Join" open the same name prompt at the top of
//     the screen (not an easy-to-miss inline input on a card).
//   - Within-team duplicate names are blocked (case-insensitive).
//   - Switch-team and GM move-player paths re-check for name collisions
//     defensively so a duplicate can't sneak in the back door.
//
// CHANGES (prior version):
//   - handleStartGame writes dealt_challenges (immutable record of initial
//     hand) and logs a card_drawn event per dealt card with
//     reason: 'initial_deal' so the full card history is preserved.
// =============================================================================

import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, onSnapshot, updateDoc, collection,
  getDocs, setDoc, arrayUnion,
} from 'firebase/firestore'
import { onAuthStateChanged } from 'firebase/auth'
import { db, auth } from '../lib/firebase'
import { dealChallenges } from '../lib/dealChallenges'
import { logEvent } from '../lib/activityLog'

interface GameData {
  id: string
  name: string
  status: string
  join_code: string
  max_teams: number
  created_by: string
  zones: string[]
  settings: {
    team_size: number
    duration_minutes: number
    hand_size: number
    hand_min_easy?: number
    hand_min_hard?: number
    hand_max_hard?: number
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
  zones_locked: number
  taxi_used: boolean
  hand: string[]
}

// Team colors — visually distinct for the map
const TEAM_COLORS = [
  { name: 'Red', hex: '#EF476F' },
  { name: 'Blue', hex: '#118AB2' },
  { name: 'Green', hex: '#06D6A0' },
  { name: 'Purple', hex: '#9B5DE5' },
  { name: 'Orange', hex: '#F77F00' },
  { name: 'Yellow', hex: '#FFD166' },
  { name: 'Pink', hex: '#FF6B8A' },
  { name: 'Teal', hex: '#2EC4B6' },
]

// Fun auto-generated team names
const TEAM_NAMES = [
  'The Bodega Cats',
  'Subway Surfers',
  'Pigeon Squad',
  'The Jaywalkers',
  'Borough Bosses',
  'Street Legends',
  'The Wanderers',
  'Zone Runners',
]

export default function LobbyPage() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const [user, setUser] = useState<typeof auth.currentUser>(auth.currentUser)

  useEffect(() => {
    return onAuthStateChanged(auth, setUser)
  }, [])

  const [game, setGame] = useState<GameData | null>(null)
  const [teams, setTeams] = useState<TeamData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)
  const [playerTeamId, setPlayerTeamId] = useState<string | null>(null)

  // Name-pick state. When a player taps "Join [team]" or "Auto-Join", we open
  // a single name prompt at the top of the screen FIRST. They confirm a name,
  // then we place them on the team.
  //   - pendingJoin describes what they're joining: either a specific team,
  //     or 'auto' to let us pick/create the team on confirm.
  //   - nameInput is the name they're typing.
  //   - nameError is the validation / duplicate-block message.
  const [pendingJoin, setPendingJoin] = useState<
    { kind: 'team'; teamId: string } | { kind: 'auto' } | null
  >(null)
  const [nameInput, setNameInput] = useState('')
  const [nameError, setNameError] = useState('')

  // GM roster manager state
  const [rosterOpen, setRosterOpen] = useState(false)
  const [editingTeamName, setEditingTeamName] = useState<Record<string, string>>({})
  const [savingRoster, setSavingRoster] = useState(false)

  // Case-insensitive, trimmed check: is this name already taken by someone
  // ELSE on the target team? (Excludes the current user so re-picking your
  // own name on your own team isn't blocked.) Returns true if taken.
  const isNameTakenOnTeam = (
    name: string,
    targetTeamId: string,
    excludeUid?: string
  ): boolean => {
    const team = teams.find((t) => t.id === targetTeamId)
    if (!team) return false
    const wanted = name.trim().toLowerCase()
    return team.members.some((uid, i) => {
      if (excludeUid && uid === excludeUid) return false
      return (team.member_names[i] || '').trim().toLowerCase() === wanted
    })
  }

  const isGM = game?.created_by === user?.uid

  // Listen to game document in real time
  useEffect(() => {
    if (!gameId) return
    const unsubGame = onSnapshot(doc(db, 'games', gameId), (snapshot) => {
      if (snapshot.exists()) {
        setGame(snapshot.data() as GameData)
      } else {
        setError('Game not found')
      }
      setLoading(false)
    })
    return () => unsubGame()
  }, [gameId])

  // Listen to teams sub-collection in real time
  useEffect(() => {
    if (!gameId) return
    const unsubTeams = onSnapshot(
      collection(db, 'games', gameId, 'teams'),
      (snapshot) => {
        const teamDocs: TeamData[] = []
        snapshot.forEach((doc) => {
          teamDocs.push({ id: doc.id, ...doc.data() } as TeamData)
        })
        teamDocs.sort((a, b) => a.name.localeCompare(b.name))
        setTeams(teamDocs)

        if (user) {
          const myTeam = teamDocs.find((t) => t.members.includes(user.uid))
          setPlayerTeamId(myTeam?.id || null)
        }
      }
    )
    return () => unsubTeams()
  }, [gameId, user])

  // Redirect players to game screen when GM starts the game
  useEffect(() => {
    if (!game || !gameId || !user) return
    if (game.status === 'active' || game.status === 'strategy') {
      if (game.created_by === user.uid) {
        navigate('/gm/' + gameId, { replace: true })
      } else {
        navigate('/game/' + gameId, { replace: true })
      }
    }
  }, [game?.status])

  // -----------------------------------------------------------------------
  // Player: open the name prompt.
  // beginJoin is called by BOTH "Join [team]" (kind: 'team') and "Auto-Join"
  // (kind: 'auto'). It pre-fills the name input with their account name and
  // shows the prompt at the top of the screen. The actual placement happens
  // in confirmJoin.
  // -----------------------------------------------------------------------

  const beginJoin = async (target: { kind: 'team'; teamId: string } | { kind: 'auto' }) => {
    if (!user) return
    let suggested = user.displayName || 'Player'
    try {
      const userDoc = await getDoc(doc(db, 'users', user.uid))
      if (userDoc.exists() && userDoc.data().display_name) {
        suggested = userDoc.data().display_name
      }
    } catch {
      // Non-critical — fall back to auth display name
    }
    setNameInput(suggested)
    setNameError('')
    setPendingJoin(target)
  }

  const cancelJoin = () => {
    setPendingJoin(null)
    setNameInput('')
    setNameError('')
  }

  // Resolve which team an auto-join should land on. Mirrors the old logic:
  // smallest team with space, or create a new team if there's room.
  // Returns the team ID to join, or null if everything is full.
  const resolveAutoJoinTeam = async (): Promise<string | null> => {
    if (!game || !gameId) return null
    const teamsSnapshot = await getDocs(collection(db, 'games', gameId, 'teams'))
    const currentTeams: TeamData[] = []
    teamsSnapshot.forEach((d) => currentTeams.push({ id: d.id, ...d.data() } as TeamData))

    const smallest = currentTeams
      .filter((t) => t.members.length < game.settings.team_size)
      .sort((a, b) => a.members.length - b.members.length)[0]

    if (currentTeams.length < game.max_teams && (!smallest || smallest.members.length > 0)) {
      // Create a fresh team
      const teamIndex = currentTeams.length
      const teamId = 'team_' + (teamIndex + 1)
      const teamRef = doc(db, 'games', gameId, 'teams', teamId)
      await setDoc(teamRef, {
        id: teamId,
        name: TEAM_NAMES[teamIndex] || 'Team ' + (teamIndex + 1),
        members: [],
        member_names: [],
        color: TEAM_COLORS[teamIndex]?.hex || '#888',
        total_points: 0,
        zones_claimed: 0,
        zones_locked: 0,
        taxi_used: false,
        hand: [],
      })
      return teamId
    } else if (smallest) {
      return smallest.id
    }
    return null
  }

  // -----------------------------------------------------------------------
  // Player: confirm the chosen name, then place them on the team.
  // For 'auto', we resolve the destination team here (after the name is set)
  // so the player is never briefly shown on a team under a placeholder name.
  // -----------------------------------------------------------------------

  const confirmJoin = async () => {
    if (!user || !game || !gameId || !pendingJoin) return

    const name = nameInput.trim()
    if (!name) {
      setNameError('Please enter a name.')
      return
    }

    setJoining(true)
    setNameError('')

    try {
      // Figure out the destination team.
      let targetTeamId: string | null
      if (pendingJoin.kind === 'team') {
        targetTeamId = pendingJoin.teamId
      } else {
        targetTeamId = await resolveAutoJoinTeam()
        if (!targetTeamId) {
          setNameError('All teams are full.')
          setJoining(false)
          return
        }
      }

      // Duplicate-name block (case-insensitive, within the destination team).
      // For a freshly created auto-join team this is always clear.
      if (isNameTakenOnTeam(name, targetTeamId)) {
        setNameError('That name is taken on this team. Pick another.')
        setJoining(false)
        return
      }

      const teamRef = doc(db, 'games', gameId, 'teams', targetTeamId)
      await updateDoc(teamRef, {
        members: arrayUnion(user.uid),
        member_names: arrayUnion(name),
      })

      // Persist their chosen name back to their account so it pre-fills
      // next time too. Non-critical if it fails.
      try {
        await updateDoc(doc(db, 'users', user.uid), { display_name: name })
      } catch { /* ignore */ }

      cancelJoin()
    } catch (err: any) {
      setNameError('Failed to join: ' + err.message)
    } finally {
      setJoining(false)
    }
  }

  // Switch from current team to a different one
  const handleSwitchTeam = async (toTeamId: string) => {
    if (!user || !gameId || !playerTeamId) return
    setJoining(true)
    setError('')

    try {
      const userDoc = await getDoc(doc(db, 'users', user.uid))
      const displayName = userDoc.exists()
        ? userDoc.data().display_name || user.displayName || 'Player'
        : user.displayName || 'Player'

      // Defensive: block the switch if the player's name collides with
      // someone already on the destination team.
      if (isNameTakenOnTeam(displayName, toTeamId, user.uid)) {
        setError(`Your name "${displayName}" is taken on that team. Change it before switching.`)
        setJoining(false)
        return
      }

      // Remove from current team
      const currentTeam = teams.find((t) => t.id === playerTeamId)
      if (currentTeam) {
        const memberIndex = currentTeam.members.indexOf(user.uid)
        const updatedMembers = currentTeam.members.filter((m) => m !== user.uid)
        // Remove the corresponding name at the same index to keep arrays in sync
        const updatedNames = currentTeam.member_names.filter((_, i) => i !== memberIndex)
        await updateDoc(doc(db, 'games', gameId, 'teams', playerTeamId), {
          members: updatedMembers,
          member_names: updatedNames,
        })
      }

      // Add to new team
      await updateDoc(doc(db, 'games', gameId, 'teams', toTeamId), {
        members: arrayUnion(user.uid),
        member_names: arrayUnion(displayName),
      })
    } catch (err: any) {
      setError('Failed to switch: ' + err.message)
    }

    setJoining(false)
  }

  // -----------------------------------------------------------------------
  // GM: rename a team
  // -----------------------------------------------------------------------

  const handleRenameTeam = async (teamId: string) => {
    const newName = editingTeamName[teamId]?.trim()
    if (!newName || !gameId) return
    setSavingRoster(true)
    try {
      await updateDoc(doc(db, 'games', gameId, 'teams', teamId), { name: newName })
      setEditingTeamName((prev) => {
        const next = { ...prev }
        delete next[teamId]
        return next
      })
    } catch (err: any) {
      setError('Failed to rename: ' + err.message)
    }
    setSavingRoster(false)
  }

  // -----------------------------------------------------------------------
  // GM: move a player from one team to another
  // members[] and member_names[] are parallel arrays — we remove by index
  // to keep them in sync, then arrayUnion onto the destination team.
  // -----------------------------------------------------------------------

  const handleMovePlayer = async (
    userId: string,
    fromTeamId: string,
    toTeamId: string
  ) => {
    if (!gameId) return
    setSavingRoster(true)
    setError('')

    try {
      const fromTeam = teams.find((t) => t.id === fromTeamId)
      if (!fromTeam) throw new Error('Source team not found')

      const memberIndex = fromTeam.members.indexOf(userId)
      if (memberIndex === -1) throw new Error('Player not found in source team')

      const playerName = fromTeam.member_names[memberIndex] || 'Player'

      // Defensive: don't move a player onto a team where their name already
      // exists. The GM gets a clear message and can rename first.
      if (isNameTakenOnTeam(playerName, toTeamId)) {
        setError(`"${playerName}" already exists on ${teams.find(t => t.id === toTeamId)?.name ?? 'that team'}. Rename one first.`)
        setSavingRoster(false)
        return
      }

      // Remove from source team (filter by index to keep names array in sync)
      const updatedMembers = fromTeam.members.filter((_, i) => i !== memberIndex)
      const updatedNames = fromTeam.member_names.filter((_, i) => i !== memberIndex)
      await updateDoc(doc(db, 'games', gameId, 'teams', fromTeamId), {
        members: updatedMembers,
        member_names: updatedNames,
      })

      // Add to destination team
      await updateDoc(doc(db, 'games', gameId, 'teams', toTeamId), {
        members: arrayUnion(userId),
        member_names: arrayUnion(playerName),
      })
    } catch (err: any) {
      setError('Failed to move player: ' + err.message)
    }

    setSavingRoster(false)
  }

  // -----------------------------------------------------------------------
  // GM: remove a player from a team entirely (back to "unassigned")
  // -----------------------------------------------------------------------

  const handleRemovePlayer = async (userId: string, fromTeamId: string) => {
    if (!gameId) return
    const confirmed = window.confirm('Remove this player from their team? They can rejoin.')
    if (!confirmed) return

    setSavingRoster(true)
    setError('')

    try {
      const fromTeam = teams.find((t) => t.id === fromTeamId)
      if (!fromTeam) throw new Error('Team not found')

      const memberIndex = fromTeam.members.indexOf(userId)
      if (memberIndex === -1) throw new Error('Player not found in team')

      const updatedMembers = fromTeam.members.filter((_, i) => i !== memberIndex)
      const updatedNames = fromTeam.member_names.filter((_, i) => i !== memberIndex)

      await updateDoc(doc(db, 'games', gameId, 'teams', fromTeamId), {
        members: updatedMembers,
        member_names: updatedNames,
      })
    } catch (err: any) {
      setError('Failed to remove player: ' + err.message)
    }

    setSavingRoster(false)
  }

  // -----------------------------------------------------------------------
  // GM: start game
  //
  // After dealChallenges runs, we read each team's freshly-dealt hand back
  // and save it permanently as `dealt_challenges` (immutable record of the
  // initial hand) AND log a `card_drawn` event per card so the activity log
  // captures every card a team ever held — from the opening deal through
  // every replacement and discard.
  // -----------------------------------------------------------------------

  const handleStartGame = async () => {
    if (!gameId || !game) return

    const activeTeams = teams.filter((t) => t.members.length > 0)
    if (activeTeams.length < 1) {
      setError('Need at least 1 team with players to start')
      return
    }

    try {
      const teamIds = activeTeams.map((t) => t.id)
      const handSize = game.settings.hand_size || 6
      const city = 'nyc'

      const compositionRules = {
        minEasy: game.settings.hand_min_easy ?? 1,
        minHard: game.settings.hand_min_hard ?? 1,
        maxHard: game.settings.hand_max_hard ?? 2,
      }

      await dealChallenges(gameId, city, game.zones, handSize, teamIds, compositionRules)

      // Activity log: record the initial deal for each team.
      // We re-read each team doc to see exactly what dealChallenges wrote.
      for (const teamId of teamIds) {
        try {
          const teamSnap = await getDoc(doc(db, 'games', gameId, 'teams', teamId))
          if (!teamSnap.exists()) continue
          const dealtHand: string[] = teamSnap.data().hand ?? []

          // Save the immutable record of the starting hand. Same pattern as
          // `discarded_challenges` — write-once, never modified.
          await updateDoc(doc(db, 'games', gameId, 'teams', teamId), {
            dealt_challenges: dealtHand,
          })

          // Log one card_drawn event per dealt card
          for (const cardId of dealtHand) {
            await logEvent(gameId, {
              team_id: teamId,
              event_type: 'card_drawn',
              actor_id: user?.uid ?? null,
              challenge_id: cardId,
              metadata: { reason: 'initial_deal' },
            })
          }
        } catch (logErr) {
          // Logging must never block game start
          console.error('Initial deal logging failed for team', teamId, logErr)
        }
      }

      const now = new Date()
      const endTime = new Date(now.getTime() + game.settings.duration_minutes * 60 * 1000)

      await updateDoc(doc(db, 'games', gameId), {
        status: 'active',
        started_at: now,
        ends_at: endTime,
      })
    } catch (err: any) {
      setError('Failed to start: ' + err.message)
    }
  }

  const copyCode = () => {
    if (game?.join_code) navigator.clipboard.writeText(game.join_code)
  }

  // -----------------------------------------------------------------------
  // Loading / error states
  // -----------------------------------------------------------------------

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

  if (!game) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0a', color: '#EF476F',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', fontFamily: "'DM Sans', sans-serif", gap: 16,
      }}>
        <p>Game not found</p>
        <button onClick={() => navigate('/')} style={{
          background: 'none', border: '1px solid #333', color: '#888',
          padding: '10px 20px', borderRadius: 8, cursor: 'pointer',
          fontFamily: 'inherit',
        }}>
          Go Home
        </button>
      </div>
    )
  }

  const totalPlayers = teams.reduce((sum, t) => sum + t.members.length, 0)
  const myTeam = teams.find((t) => t.id === playerTeamId)

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      padding: 24,
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: 24 }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none', border: 'none', color: '#555',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem',
              padding: 0, marginBottom: 12,
            }}
          >
            ← Leave Lobby
          </button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>
                {game.name}
              </h1>
              <p style={{ color: '#666', fontSize: '0.85rem', marginTop: 4 }}>
                {game.settings.duration_minutes} min · {game.zones.length} zones · {game.settings.team_size} per team
              </p>
            </div>
            <span style={{
              background: 'rgba(6,214,160,0.12)',
              color: '#06D6A0',
              padding: '4px 12px',
              borderRadius: 20,
              fontSize: '0.75rem',
              fontWeight: 700,
              textTransform: 'uppercase',
            }}>
              {game.status}
            </span>
          </div>
        </div>

        {/* ── Join Code ── */}
        <div
          onClick={copyCode}
          style={{
            background: 'rgba(255,209,102,0.08)',
            border: '1px solid rgba(255,209,102,0.2)',
            borderRadius: 12,
            padding: '20px 24px',
            textAlign: 'center',
            marginBottom: 24,
            cursor: 'pointer',
          }}
        >
          <p style={{
            fontSize: '0.72rem', color: '#997a3d',
            textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
          }}>
            Join Code (tap to copy)
          </p>
          <p style={{
            fontSize: '2.2rem', fontWeight: 800, color: '#FFD166',
            letterSpacing: 6, fontFamily: "'JetBrains Mono', monospace", margin: 0,
          }}>
            {game.join_code}
          </p>
          <p style={{ fontSize: '0.78rem', color: '#666', marginTop: 8 }}>
            Share this code with your players
          </p>
        </div>

        {/* ── NAME PROMPT (shown at top once a player taps Join / Auto-Join) ── */}
        {!isGM && !playerTeamId && pendingJoin && (
          <div style={{
            background: 'rgba(6,214,160,0.06)',
            border: '1px solid rgba(6,214,160,0.25)',
            borderRadius: 12,
            padding: '18px 18px',
            marginBottom: 20,
          }}>
            <p style={{
              fontSize: '0.72rem', color: '#06D6A0',
              textTransform: 'uppercase', letterSpacing: 1,
              fontWeight: 700, marginBottom: 4,
            }}>
              {pendingJoin.kind === 'team'
                ? `Joining ${teams.find(t => t.id === (pendingJoin as any).teamId)?.name ?? 'team'}`
                : 'Joining a team'}
            </p>
            <p style={{ color: '#888', fontSize: '0.8rem', marginBottom: 12 }}>
              Pick the name your teammates and the GM will see in chat.
            </p>
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => { setNameInput(e.target.value); setNameError('') }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmJoin()
                if (e.key === 'Escape') cancelJoin()
              }}
              placeholder="Your name (shown in chat)"
              maxLength={20}
              style={{
                width: '100%', background: '#111',
                border: `1px solid ${nameError ? '#EF476F' : 'rgba(6,214,160,0.4)'}`,
                borderRadius: 8, padding: '11px 14px', color: '#fff',
                fontSize: '0.95rem', fontFamily: 'inherit', outline: 'none',
                boxSizing: 'border-box', marginBottom: nameError ? 6 : 12,
              }}
            />
            {nameError && (
              <p style={{ color: '#EF476F', fontSize: '0.78rem', margin: '0 0 12px' }}>
                {nameError}
              </p>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={confirmJoin}
                disabled={joining}
                style={{
                  flex: 2, background: 'rgba(6,214,160,0.15)',
                  border: '1px solid rgba(6,214,160,0.4)', color: '#06D6A0',
                  padding: '12px 16px', borderRadius: 8,
                  fontSize: '0.9rem', fontWeight: 700,
                  cursor: joining ? 'wait' : 'pointer', fontFamily: 'inherit',
                  opacity: joining ? 0.6 : 1,
                }}
              >
                {joining ? 'Joining...' : 'Confirm & Join'}
              </button>
              <button
                onClick={cancelJoin}
                disabled={joining}
                style={{
                  flex: 1, background: 'transparent',
                  border: '1px solid #333', color: '#666',
                  padding: '12px 16px', borderRadius: 8,
                  fontSize: '0.9rem', fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── "You're on a team" confirmation banner (player only) ── */}
        {!isGM && myTeam && (
          <div style={{
            background: `${myTeam.color}12`,
            border: `1px solid ${myTeam.color}40`,
            borderRadius: 10,
            padding: '12px 16px',
            marginBottom: 20,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: 3,
              background: myTeam.color, flexShrink: 0,
            }} />
            <div>
              <p style={{ color: myTeam.color, fontWeight: 700, fontSize: '0.9rem', margin: 0 }}>
                You're on {myTeam.name}
              </p>
              <p style={{ color: '#666', fontSize: '0.75rem', marginTop: 2 }}>
                Switch anytime before the game starts
              </p>
            </div>
          </div>
        )}

        {/* ── "Pick a team" prompt banner (player only, not yet on a team, no name prompt open) ── */}
        {!isGM && !playerTeamId && !pendingJoin && teams.length > 0 && (
          <div style={{
            background: 'rgba(6,214,160,0.06)',
            border: '1px solid rgba(6,214,160,0.2)',
            borderRadius: 10,
            padding: '12px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{ fontSize: '1.1rem' }}>👇</span>
            <p style={{ color: '#06D6A0', fontWeight: 600, fontSize: '0.88rem', margin: 0 }}>
              Pick a team below, or tap Auto-Join
            </p>
          </div>
        )}

        {/* ── Player count ── */}
        <p style={{ color: '#888', fontSize: '0.88rem', marginBottom: 16 }}>
          {totalPlayers} player{totalPlayers !== 1 ? 's' : ''} joined · {teams.length}/{game.max_teams} teams
        </p>

        {/* ── Team cards ── */}
        <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
          {teams.map((team) => {
            const isMyTeam = team.id === playerTeamId
            const isFull = team.members.length >= game.settings.team_size
            // Only allow opening a join prompt when no prompt is already open.
            const canJoin = !isGM && !playerTeamId && !isFull && !pendingJoin
            const canSwitch = !isGM && playerTeamId && playerTeamId !== team.id && !isFull

            return (
              <div
                key={team.id}
                style={{
                  background: isMyTeam ? `${team.color}12` : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${isMyTeam ? team.color + '40' : '#1a1a1a'}`,
                  borderRadius: 10,
                  padding: '14px 16px',
                  transition: 'border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 12, height: 12, borderRadius: 3, background: team.color }} />
                    <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.95rem' }}>
                      {team.name}
                    </span>
                    {isMyTeam && (
                      <span style={{ fontSize: '0.7rem', color: team.color, fontWeight: 600 }}>
                        (you)
                      </span>
                    )}
                  </div>
                  <span style={{
                    fontSize: '0.78rem',
                    color: isFull ? '#EF476F' : '#555',
                    fontWeight: isFull ? 700 : 400,
                  }}>
                    {team.members.length}/{game.settings.team_size}
                    {isFull ? ' · Full' : ''}
                  </span>
                </div>

                {/* Player name pills */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: (canJoin || canSwitch) ? 10 : 0 }}>
                  {team.member_names.map((name, i) => (
                    <span key={i} style={{
                      background: 'rgba(255,255,255,0.05)',
                      padding: '3px 10px', borderRadius: 12,
                      fontSize: '0.78rem', color: '#aaa',
                    }}>
                      {name}
                    </span>
                  ))}
                  {!isFull && (
                    <span style={{
                      padding: '3px 10px', borderRadius: 12,
                      fontSize: '0.78rem', color: '#333',
                      border: '1px dashed #333',
                    }}>
                      waiting...
                    </span>
                  )}
                </div>

                {/* Join this team — opens the name prompt at the top */}
                {canJoin && (
                  <button
                    onClick={() => beginJoin({ kind: 'team', teamId: team.id })}
                    disabled={joining}
                    style={{
                      width: '100%',
                      background: `${team.color}18`,
                      border: `1px solid ${team.color}50`,
                      color: team.color,
                      padding: '8px 14px', borderRadius: 7,
                      fontSize: '0.82rem', fontWeight: 700,
                      cursor: joining ? 'wait' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {`Join ${team.name}`}
                  </button>
                )}

                {/* Switch to this team */}
                {canSwitch && (
                  <button
                    onClick={() => handleSwitchTeam(team.id)}
                    disabled={joining}
                    style={{
                      width: '100%',
                      background: 'rgba(255,209,102,0.08)',
                      border: '1px solid rgba(255,209,102,0.25)',
                      color: '#FFD166',
                      padding: '8px 14px', borderRadius: 7,
                      fontSize: '0.82rem', fontWeight: 700,
                      cursor: joining ? 'wait' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {joining ? 'Switching...' : `Switch to ${team.name}`}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* ── Auto-join button (player not yet on a team, no name prompt open) ── */}
        {!isGM && !playerTeamId && !pendingJoin && (
          <button
            onClick={() => beginJoin({ kind: 'auto' })}
            disabled={joining}
            style={{
              width: '100%',
              background: 'rgba(6,214,160,0.12)',
              border: '1px solid rgba(6,214,160,0.3)',
              color: '#06D6A0',
              padding: '14px 24px', borderRadius: 10,
              fontSize: '0.95rem', fontWeight: 700,
              cursor: joining ? 'wait' : 'pointer',
              fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {joining ? 'Joining...' : '⚡ Auto-Join a Team'}
          </button>
        )}

        {/* ── Error ── */}
        {error && (
          <p style={{
            color: '#EF476F', fontSize: '0.85rem', marginBottom: 16,
            padding: '10px 14px', background: 'rgba(239,71,111,0.08)',
            borderRadius: 8, textAlign: 'center',
          }}>
            {error}
          </p>
        )}

        {/* ──────────────────────────────────────────────────────── */}
        {/* GM CONTROLS                                              */}
        {/* ──────────────────────────────────────────────────────── */}
        {isGM && (
          <div style={{
            marginTop: 16,
            background: 'rgba(255,209,102,0.05)',
            border: '1px solid rgba(255,209,102,0.15)',
            borderRadius: 12,
            overflow: 'hidden',
          }}>
            <div style={{ padding: '16px 20px 0' }}>
              <p style={{
                fontSize: '0.72rem', color: '#FFD166',
                textTransform: 'uppercase', letterSpacing: 1,
                fontWeight: 700, marginBottom: 12,
              }}>
                Game Master Controls
              </p>

              {/* Start Game */}
              <button
                onClick={handleStartGame}
                style={{
                  width: '100%',
                  background: 'rgba(255,209,102,0.15)',
                  border: '1px solid rgba(255,209,102,0.3)',
                  color: '#FFD166',
                  padding: '14px 24px', borderRadius: 10,
                  fontSize: '1rem', fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit',
                  marginBottom: 8,
                }}
              >
                Start Game
              </button>
              <p style={{
                fontSize: '0.78rem', color: '#666',
                marginBottom: 16, textAlign: 'center',
              }}>
                Need at least 1 team with players
              </p>
            </div>

            {/* ── Roster Manager toggle ── */}
            <button
              onClick={() => setRosterOpen((v) => !v)}
              style={{
                width: '100%',
                background: rosterOpen ? 'rgba(255,255,255,0.04)' : 'transparent',
                border: 'none',
                borderTop: '1px solid rgba(255,209,102,0.1)',
                color: rosterOpen ? '#ccc' : '#666',
                padding: '12px 20px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '0.82rem',
                fontWeight: 600,
                transition: 'background 0.15s',
              }}
            >
              <span>✏️ Adjust Teams / Roster</span>
              <span style={{
                color: '#444', fontSize: '0.75rem',
                transform: rosterOpen ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
              }}>▼</span>
            </button>

            {/* ── Roster Manager panel ── */}
            {rosterOpen && (
              <div style={{ padding: '16px 20px 20px' }}>
                <p style={{ fontSize: '0.75rem', color: '#555', marginBottom: 16, lineHeight: 1.6 }}>
                  Move players between teams, rename teams, or remove players.
                  Changes apply instantly — all players see updates in real time.
                </p>

                {teams.length === 0 && (
                  <p style={{ color: '#444', fontSize: '0.82rem', fontStyle: 'italic', textAlign: 'center', padding: '12px 0' }}>
                    No teams yet. Players will appear here once they join.
                  </p>
                )}

                <div style={{ display: 'grid', gap: 14 }}>
                  {teams.map((team) => (
                    <div
                      key={team.id}
                      style={{
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid #1a1a1a',
                        borderRadius: 10,
                        overflow: 'hidden',
                      }}
                    >
                      {/* Team header with rename */}
                      <div style={{
                        padding: '10px 14px',
                        borderBottom: '1px solid #111',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        background: `${team.color}08`,
                      }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: team.color, flexShrink: 0 }} />

                        {editingTeamName[team.id] !== undefined ? (
                          // Inline rename input
                          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                            <input
                              autoFocus
                              value={editingTeamName[team.id]}
                              onChange={(e) => setEditingTeamName((prev) => ({ ...prev, [team.id]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRenameTeam(team.id)
                                if (e.key === 'Escape') setEditingTeamName((prev) => {
                                  const next = { ...prev }; delete next[team.id]; return next
                                })
                              }}
                              style={{
                                flex: 1, background: '#111', border: `1px solid ${team.color}40`,
                                borderRadius: 6, padding: '4px 10px', color: '#fff',
                                fontSize: '0.82rem', fontFamily: 'inherit', outline: 'none',
                              }}
                            />
                            <button
                              onClick={() => handleRenameTeam(team.id)}
                              disabled={savingRoster}
                              style={{
                                background: `${team.color}20`, border: `1px solid ${team.color}40`,
                                color: team.color, padding: '4px 10px', borderRadius: 6,
                                fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingTeamName((prev) => {
                                const next = { ...prev }; delete next[team.id]; return next
                              })}
                              style={{
                                background: 'transparent', border: '1px solid #333',
                                color: '#555', padding: '4px 10px', borderRadius: 6,
                                fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'inherit',
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <>
                            <span style={{ color: '#ccc', fontWeight: 700, fontSize: '0.88rem', flex: 1 }}>
                              {team.name}
                            </span>
                            <button
                              onClick={() => setEditingTeamName((prev) => ({ ...prev, [team.id]: team.name }))}
                              style={{
                                background: 'transparent', border: '1px solid #222',
                                color: '#555', padding: '3px 9px', borderRadius: 5,
                                fontSize: '0.7rem', cursor: 'pointer', fontFamily: 'inherit',
                              }}
                            >
                              Rename
                            </button>
                            <span style={{ fontSize: '0.72rem', color: '#444' }}>
                              {team.members.length}/{game.settings.team_size}
                            </span>
                          </>
                        )}
                      </div>

                      {/* Player rows */}
                      {team.members.length === 0 ? (
                        <p style={{ padding: '10px 14px', color: '#333', fontSize: '0.78rem', fontStyle: 'italic' }}>
                          No players yet
                        </p>
                      ) : (
                        <div>
                          {team.members.map((uid, idx) => {
                            const playerName = team.member_names[idx] || 'Player'
                            const otherTeams = teams.filter((t) => t.id !== team.id)

                            return (
                              <div
                                key={uid}
                                style={{
                                  padding: '10px 14px',
                                  borderBottom: idx < team.members.length - 1 ? '1px solid #0f0f0f' : 'none',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  flexWrap: 'wrap',
                                }}
                              >
                                {/* Player name */}
                                <span style={{
                                  fontSize: '0.82rem', color: '#bbb',
                                  fontWeight: 600, flex: 1, minWidth: 80,
                                }}>
                                  {playerName}
                                </span>

                                {/* Move to other team buttons */}
                                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                                  {otherTeams.map((other) => (
                                    <button
                                      key={other.id}
                                      onClick={() => handleMovePlayer(uid, team.id, other.id)}
                                      disabled={savingRoster || other.members.length >= game.settings.team_size}
                                      title={other.members.length >= game.settings.team_size ? `${other.name} is full` : `Move to ${other.name}`}
                                      style={{
                                        background: other.members.length >= game.settings.team_size
                                          ? 'rgba(255,255,255,0.02)'
                                          : `${other.color}15`,
                                        border: `1px solid ${other.members.length >= game.settings.team_size ? '#222' : other.color + '40'}`,
                                        color: other.members.length >= game.settings.team_size ? '#333' : other.color,
                                        padding: '4px 9px', borderRadius: 5,
                                        fontSize: '0.7rem', fontWeight: 600,
                                        cursor: other.members.length >= game.settings.team_size || savingRoster
                                          ? 'not-allowed' : 'pointer',
                                        fontFamily: 'inherit',
                                        opacity: other.members.length >= game.settings.team_size ? 0.5 : 1,
                                      }}
                                    >
                                      → {other.name.split(' ')[0]}
                                    </button>
                                  ))}

                                  {/* Remove player */}
                                  <button
                                    onClick={() => handleRemovePlayer(uid, team.id)}
                                    disabled={savingRoster}
                                    title="Remove from team"
                                    style={{
                                      background: 'rgba(239,71,111,0.06)',
                                      border: '1px solid rgba(239,71,111,0.2)',
                                      color: '#EF476F',
                                      padding: '4px 9px', borderRadius: 5,
                                      fontSize: '0.7rem', fontWeight: 600,
                                      cursor: savingRoster ? 'wait' : 'pointer',
                                      fontFamily: 'inherit',
                                    }}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Saving indicator */}
                {savingRoster && (
                  <p style={{
                    color: '#FFD166', fontSize: '0.75rem',
                    textAlign: 'center', marginTop: 12,
                  }}>
                    Saving...
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}