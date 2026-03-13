// =============================================================================
// Zone Rush — Game Lobby
// Shows game info, join code, team assignments. GM can start the game.
// Real-time updates via Firestore listeners.
// =============================================================================

import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  doc, getDoc, onSnapshot, updateDoc, collection,
  getDocs, setDoc, arrayUnion,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import { dealChallenges } from '../lib/dealChallenges'

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
    // Hand composition rules — all optional, fall back to defaults in dealChallenges
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
  const user = auth.currentUser

  const [game, setGame] = useState<GameData | null>(null)
  const [teams, setTeams] = useState<TeamData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)
  const [playerTeamId, setPlayerTeamId] = useState<string | null>(null)

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

  // If game starts, navigate to the game screen
  useEffect(() => {
    if (game?.status === 'active') {
      navigate('/game/' + gameId)
    }
  }, [game?.status, gameId, navigate])

  // Join a team (auto-assign to smallest team, or create new one)
  const handleJoinTeam = async (targetTeamId?: string) => {
    if (!user || !game || !gameId) return
    setJoining(true)

    try {
      const userDoc = await getDoc(doc(db, 'users', user.uid))
      const displayName = userDoc.exists()
        ? userDoc.data().display_name || user.displayName || 'Player'
        : user.displayName || 'Player'

      if (targetTeamId) {
        const teamRef = doc(db, 'games', gameId, 'teams', targetTeamId)
        await updateDoc(teamRef, {
          members: arrayUnion(user.uid),
          member_names: arrayUnion(displayName),
        })
      } else {
        const teamsSnapshot = await getDocs(collection(db, 'games', gameId, 'teams'))
        const currentTeams: TeamData[] = []
        teamsSnapshot.forEach((d) => currentTeams.push({ id: d.id, ...d.data() } as TeamData))

        const smallest = currentTeams
          .filter((t) => t.members.length < game.settings.team_size)
          .sort((a, b) => a.members.length - b.members.length)[0]

        if (currentTeams.length < game.max_teams && (!smallest || smallest.members.length > 0)) {
          const teamIndex = currentTeams.length
          const teamId = 'team_' + (teamIndex + 1)
          const teamRef = doc(db, 'games', gameId, 'teams', teamId)
          await setDoc(teamRef, {
            id: teamId,
            name: TEAM_NAMES[teamIndex] || 'Team ' + (teamIndex + 1),
            members: [user.uid],
            member_names: [displayName],
            color: TEAM_COLORS[teamIndex]?.hex || '#888',
            total_points: 0,
            zones_claimed: 0,
            zones_locked: 0,
            taxi_used: false,
            hand: [],
          })
        } else if (smallest) {
          const teamRef = doc(db, 'games', gameId, 'teams', smallest.id)
          await updateDoc(teamRef, {
            members: arrayUnion(user.uid),
            member_names: arrayUnion(displayName),
          })
        } else {
          setError('All teams are full')
        }
      }
    } catch (err: any) {
      setError('Failed to join: ' + err.message)
    }

    setJoining(false)
  }

  // GM starts the game — deal cards using composition rules from game.settings, then set active
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

      // Build composition rules from game.settings — all fall back to defaults
      // if not set (e.g. games created before this feature was added)
      const compositionRules = {
        minEasy: game.settings.hand_min_easy ?? 1,
        minHard: game.settings.hand_min_hard ?? 1,
        maxHard: game.settings.hand_max_hard ?? 2,
      }

      console.log('DEALING:', { gameId, city, zones: game.zones, handSize, teamIds, compositionRules })
      await dealChallenges(gameId, city, game.zones, handSize, teamIds, compositionRules)
      console.log('DEALING COMPLETE — cards should be in Firestore')

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
    if (game?.join_code) {
      navigator.clipboard.writeText(game.join_code)
    }
  }

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

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
      padding: 24,
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        {/* Header */}
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

        {/* Join Code */}
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

        {/* Player count */}
        <p style={{ color: '#888', fontSize: '0.88rem', marginBottom: 16 }}>
          {totalPlayers} player{totalPlayers !== 1 ? 's' : ''} joined · {teams.length}/{game.max_teams} teams
        </p>

        {/* Teams */}
        <div style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
          {teams.map((team) => {
            const isMyTeam = team.id === playerTeamId
            return (
              <div
                key={team.id}
                style={{
                  background: isMyTeam ? `${team.color}12` : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${isMyTeam ? team.color + '40' : '#1a1a1a'}`,
                  borderRadius: 10,
                  padding: '14px 16px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 12, height: 12, borderRadius: 3,
                      background: team.color,
                    }} />
                    <span style={{ color: '#fff', fontWeight: 700, fontSize: '0.95rem' }}>
                      {team.name}
                    </span>
                    {isMyTeam && (
                      <span style={{ fontSize: '0.7rem', color: team.color, fontWeight: 600 }}>
                        (you)
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: '0.78rem', color: '#555' }}>
                    {team.members.length}/{game.settings.team_size}
                  </span>
                </div>

                {/* Player names */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {team.member_names.map((name, i) => (
                    <span key={i} style={{
                      background: 'rgba(255,255,255,0.05)',
                      padding: '3px 10px', borderRadius: 12,
                      fontSize: '0.78rem', color: '#aaa',
                    }}>
                      {name}
                    </span>
                  ))}
                  {team.members.length < game.settings.team_size && (
                    <span style={{
                      padding: '3px 10px', borderRadius: 12,
                      fontSize: '0.78rem', color: '#333',
                      border: '1px dashed #333',
                    }}>
                      waiting...
                    </span>
                  )}
                </div>

                {/* Join this team button (if not on a team yet) */}
                {!playerTeamId && team.members.length < game.settings.team_size && (
                  <button
                    onClick={() => handleJoinTeam(team.id)}
                    disabled={joining}
                    style={{
                      marginTop: 10,
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid #333', color: '#aaa',
                      padding: '6px 14px', borderRadius: 6,
                      fontSize: '0.78rem', cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Join this team
                  </button>
                )}

                {/* Switch to this team (if on a different team) */}
                {playerTeamId && playerTeamId !== team.id && team.members.length < game.settings.team_size && (
                  <button
                    onClick={async () => {
                      if (!user || !gameId) return
                      setJoining(true)
                      try {
                        const userDoc = await getDoc(doc(db, 'users', user.uid))
                        const displayName = userDoc.exists()
                          ? userDoc.data().display_name || user.displayName || 'Player'
                          : user.displayName || 'Player'

                        // Remove from current team
                        const currentTeam = teams.find((t) => t.id === playerTeamId)
                        if (currentTeam) {
                          const oldRef = doc(db, 'games', gameId, 'teams', playerTeamId)
                          await updateDoc(oldRef, {
                            members: currentTeam.members.filter((m) => m !== user.uid),
                            member_names: currentTeam.member_names.filter((n) => n !== displayName),
                          })
                        }

                        // Add to new team
                        const newRef = doc(db, 'games', gameId, 'teams', team.id)
                        await updateDoc(newRef, {
                          members: arrayUnion(user.uid),
                          member_names: arrayUnion(displayName),
                        })
                      } catch (err: any) {
                        setError('Failed to switch: ' + err.message)
                      }
                      setJoining(false)
                    }}
                    disabled={joining}
                    style={{
                      marginTop: 10,
                      background: 'rgba(255,209,102,0.08)',
                      border: '1px solid rgba(255,209,102,0.2)',
                      color: '#FFD166',
                      padding: '6px 14px', borderRadius: 6,
                      fontSize: '0.78rem', cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Switch to this team
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* Join button (if not on a team yet) */}
        {!playerTeamId && (
          <button
            onClick={() => handleJoinTeam()}
            disabled={joining}
            style={{
              width: '100%',
              background: 'rgba(6,214,160,0.12)',
              border: '1px solid rgba(6,214,160,0.3)',
              color: '#06D6A0',
              padding: '14px 24px', borderRadius: 10,
              fontSize: '0.95rem', fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
              marginBottom: 16,
            }}
          >
            {joining ? 'Joining...' : 'Auto-Join a Team'}
          </button>
        )}

        {/* Error */}
        {error && (
          <p style={{
            color: '#EF476F', fontSize: '0.85rem', marginBottom: 16,
            padding: '10px 14px', background: 'rgba(239,71,111,0.08)',
            borderRadius: 8, textAlign: 'center',
          }}>
            {error}
          </p>
        )}

        {/* GM Controls */}
        {isGM && (
          <div style={{
            marginTop: 16, padding: 20,
            background: 'rgba(255,209,102,0.05)',
            border: '1px solid rgba(255,209,102,0.15)',
            borderRadius: 12,
          }}>
            <p style={{
              fontSize: '0.72rem', color: '#FFD166',
              textTransform: 'uppercase', letterSpacing: 1,
              fontWeight: 700, marginBottom: 12,
            }}>
              Game Master Controls
            </p>
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
              }}
            >
              Start Game
            </button>
            <p style={{
              fontSize: '0.78rem', color: '#666',
              marginTop: 8, textAlign: 'center',
            }}>
              Need at least 1 team with players
            </p>
          </div>
        )}
      </div>
    </div>
  )
}