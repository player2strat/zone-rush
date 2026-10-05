// =============================================================================
// Foray — Join Game Page
// Player enters a 6-character join code to find and enter a game lobby.
// =============================================================================

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { db, auth } from '../lib/firebase'
import { findGameByCode, joinWithCode, isPermissionDenied } from '../lib/gameMembership'

export default function JoinGame() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  const handleJoin = async () => {
    const cleanCode = code.trim().toUpperCase()

    if (cleanCode.length !== 6) {
      setError('Code must be 6 characters')
      return
    }

    setSearching(true)
    setError('')

    try {
      const uid = auth.currentUser?.uid
      if (!uid) throw new Error('Not signed in')

      // Codes are looked up one at a time — games can't be browsed.
      const gameId = await findGameByCode(cleanCode)
      if (!gameId) {
        setError('No game found with that code. Check the code and try again.')
        setSearching(false)
        return
      }

      // Already in this game (or its GM)? Then we can read it and route by
      // state. Otherwise the read is refused and we join below.
      let gameData: Record<string, any> | null = null
      try {
        const snap = await getDoc(doc(db, 'games', gameId))
        gameData = snap.exists() ? snap.data() : null
      } catch (err) {
        if (!isPermissionDenied(err)) throw err
      }

      if (!gameData) {
        // New to this game: entering the code puts you on the roster while
        // it's in the lobby. Once it has started, ask the GM instead.
        if (await joinWithCode(gameId, uid, cleanCode)) {
          navigate('/lobby/' + gameId)
        } else {
          navigate('/late-join/' + gameId, { state: { code: cleanCode } })
        }
        return
      }

      const status = gameData.status
      if (status === 'lobby') {
        navigate('/lobby/' + gameId)
        return
      }
      if (status === 'ended') {
        navigate('/results/' + gameId)
        return
      }
      // In progress — only existing team members (or the GM) can enter.
      // GameRouteGuard sends GMs to /gm and players to /game from here.
      const isGM = gameData.created_by === uid || (gameData.gm_uids || []).includes(uid)
      if (isGM) {
        navigate('/gm/' + gameId)
        return
      }
      // (A late joiner still waiting for approval can see the game but not
      // its teams — the read is refused, which also means "not on a team".)
      const teamsSnap = await getDocs(collection(db, 'games', gameId, 'teams')).catch((err) => {
        if (isPermissionDenied(err)) return null
        throw err
      })
      const onTeam = !!teamsSnap?.docs.some((t) => (t.data().members || []).includes(uid))
      if (onTeam) {
        navigate('/game/' + gameId)
        return
      }
      // Not on a team — ask the Game Master to let them in.
      navigate('/late-join/' + gameId, { state: { code: cleanCode } })
    } catch (err) {
      setError('Error finding game: ' + (err as Error).message)
      setSearching(false)
    }
  }

  // Auto-submit when 6 characters are entered
  const handleCodeChange = (val: string) => {
    // Only allow letters and numbers, max 6 chars
    const clean = val.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)
    setCode(clean)
    setError('')
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--paper)',
      color: 'var(--ink)',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        {/* Back button */}
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none', border: 'none', color: 'var(--ink-faint)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem',
            padding: 0, marginBottom: 32,
          }}
        >
          ← Back
        </button>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>
            Join Game
          </h1>
          <p style={{ color: 'var(--ink-muted)', fontSize: '0.88rem', marginTop: 8 }}>
            Enter the 6-character code from your Game Master
          </p>
        </div>

        {/* Code Input */}
        <input
          type="text"
          value={code}
          onChange={(e) => handleCodeChange(e.target.value)}
          placeholder="RUSH42"
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          style={{
            width: '100%',
            background: 'rgba(var(--ink-rgb), 0.05)',
            border: '2px solid ' + (code.length === 6 ? 'var(--green)' : 'var(--line-strong)'),
            borderRadius: 12,
            padding: '18px 20px',
            color: 'var(--ink)',
            fontSize: '1.8rem',
            fontWeight: 800,
            fontFamily: "'Martian Mono', monospace",
            textAlign: 'center',
            letterSpacing: 8,
            outline: 'none',
            boxSizing: 'border-box',
            transition: 'border-color 0.2s',
          }}
        />

        {/* Character count hint */}
        <p style={{
          textAlign: 'center',
          fontSize: '0.78rem',
          color: code.length === 6 ? 'var(--green)' : 'var(--ink-ghost)',
          marginTop: 10,
          marginBottom: 24,
        }}>
          {code.length}/6 characters
        </p>

        {/* Error */}
        {error && (
          <p style={{
            color: 'var(--red)',
            fontSize: '0.85rem',
            marginBottom: 16,
            padding: '10px 14px',
            background: 'rgba(var(--red-rgb), 0.08)',
            borderRadius: 8,
            textAlign: 'center',
          }}>
            {error}
          </p>
        )}

        {/* Join Button */}
        <button
          onClick={handleJoin}
          disabled={code.length !== 6 || searching}
          style={{
            width: '100%',
            background: code.length === 6
              ? 'rgba(var(--green-rgb), 0.15)'
              : 'rgba(var(--ink-rgb), 0.03)',
            border: `1px solid ${code.length === 6 ? 'rgba(var(--green-rgb), 0.3)' : 'var(--line)'}`,
            color: code.length === 6 ? 'var(--green)' : 'var(--ink-ghost)',
            padding: '16px 24px',
            borderRadius: 12,
            fontSize: '1.05rem',
            fontWeight: 700,
            cursor: code.length === 6 ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            transition: 'all 0.2s',
          }}
        >
          {searching ? 'Finding game...' : 'Join Game'}
        </button>
      </div>
    </div>
  )
}