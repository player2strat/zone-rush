// =============================================================================
// Foray — Late Join Page
//
// A player entered the code for a game that has already started and isn't on
// a team. They pick a name and ask to join; the request lands in
// games/{gameId}/join_requests/{uid} and the Game Master approves or denies it
// from the GM Dashboard. This page watches the request and forwards the player
// into the game the moment it's approved.
// =============================================================================

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  doc, getDoc, onSnapshot, setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'

interface JoinRequest {
  status: 'pending' | 'approved' | 'denied'
  name: string
  team_id?: string
}

export default function LateJoinPage() {
  const { gameId } = useParams<{ gameId: string }>()
  const navigate = useNavigate()
  const user = auth.currentUser

  const [gameName, setGameName] = useState('')
  const [gameStatus, setGameStatus] = useState<string | null>(null)
  const [request, setRequest] = useState<JoinRequest | null | undefined>(undefined) // undefined = loading
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Watch the game — if it ends (or is somehow back in lobby) route accordingly.
  useEffect(() => {
    if (!gameId) return
    const unsub = onSnapshot(doc(db, 'games', gameId), (snap) => {
      if (!snap.exists()) {
        navigate('/', { replace: true })
        return
      }
      const data = snap.data()
      setGameName(data.name || '')
      setGameStatus(data.status || null)
      if (data.status === 'lobby') navigate('/lobby/' + gameId, { replace: true })
      if (data.status === 'ended') navigate('/results/' + gameId, { replace: true })
    })
    return unsub
  }, [gameId, navigate])

  // Watch my request. Approved → into the game (GameRouteGuard does the rest).
  useEffect(() => {
    if (!gameId || !user) return
    const unsub = onSnapshot(doc(db, 'games', gameId, 'join_requests', user.uid), (snap) => {
      if (!snap.exists()) {
        setRequest(null)
        return
      }
      const data = snap.data() as JoinRequest
      setRequest(data)
      if (data.status === 'approved') navigate('/game/' + gameId, { replace: true })
    })
    return unsub
  }, [gameId, user, navigate])

  // Suggest a name from the user's profile, same as the lobby does.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    getDoc(doc(db, 'users', user.uid)).then((snap) => {
      if (cancelled) return
      const saved = snap.exists() ? snap.data().display_name : null
      setName(saved || user.displayName || '')
    })
    return () => { cancelled = true }
  }, [user])

  const handleRequest = async () => {
    if (!gameId || !user) return
    const clean = name.trim()
    if (!clean) {
      setError('Enter a name so the Game Master knows who you are.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await setDoc(doc(db, 'games', gameId, 'join_requests', user.uid), {
        uid: user.uid,
        name: clean,
        status: 'pending',
        requested_at: serverTimestamp(),
      })
      await setDoc(doc(db, 'users', user.uid), { display_name: clean }, { merge: true })
    } catch (err) {
      setError('Could not send request: ' + (err as Error).message)
    }
    setBusy(false)
  }

  const handleCancel = async () => {
    if (!gameId || !user) return
    setBusy(true)
    try {
      await deleteDoc(doc(db, 'games', gameId, 'join_requests', user.uid))
    } catch {
      /* ignore — leaving anyway */
    }
    navigate('/')
  }

  const shell = (children: React.ReactNode) => (
    <div style={{
      minHeight: '100vh',
      background: '#FDFFF1',
      color: '#202122',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>{children}</div>
    </div>
  )

  if (request === undefined || gameStatus === null) {
    return shell(<p style={{ color: '#6F6E66', textAlign: 'center' }}>Loading…</p>)
  }

  // ---- Waiting / denied ----
  if (request && request.status === 'pending') {
    return shell(
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '0.75rem', color: '#FFD626', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>
          {gameName}
        </p>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 12px' }}>
          Waiting for the Game Master
        </h1>
        <p style={{ color: '#55544E', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 32 }}>
          Your request to join as <strong style={{ color: '#2A2B2C' }}>{request.name}</strong> has been sent.
          Keep this screen open — you'll be dropped into the game as soon as it's approved.
        </p>
        <div style={{
          width: 36, height: 36, margin: '0 auto 32px',
          border: '3px solid #E6E5DA', borderTopColor: '#FFD626', borderRadius: '50%',
          animation: 'zr-spin 1s linear infinite',
        }} />
        <style>{'@keyframes zr-spin { to { transform: rotate(360deg) } }'}</style>
        <button onClick={handleCancel} disabled={busy} style={quietBtn}>
          Cancel request
        </button>
      </div>
    )
  }

  if (request && request.status === 'denied') {
    return shell(
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0 0 12px' }}>
          Request declined
        </h1>
        <p style={{ color: '#55544E', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 32 }}>
          The Game Master didn't approve your request to join <strong style={{ color: '#2A2B2C' }}>{gameName}</strong>.
        </p>
        <button onClick={handleCancel} disabled={busy} style={quietBtn}>
          ← Back to Home
        </button>
      </div>
    )
  }

  // ---- Ask to join ----
  return shell(
    <>
      <button onClick={() => navigate('/')} style={{ ...quietBtn, padding: 0, marginBottom: 32 }}>
        ← Back
      </button>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <p style={{ fontSize: '0.75rem', color: '#FFD626', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>
          {gameName}
        </p>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>
          This game is in progress
        </h1>
        <p style={{ color: '#5F5E57', fontSize: '0.88rem', marginTop: 8, lineHeight: 1.5 }}>
          You can still join — the Game Master needs to approve you and put you on a team.
        </p>
      </div>

      <label style={{ color: '#55544E', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: 1 }}>
        Your name
      </label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What should your team call you?"
        maxLength={24}
        autoFocus
        style={{
          width: '100%',
          background: 'rgba(32,33,34,0.05)',
          border: '2px solid #D6D5CA',
          borderRadius: 12,
          padding: '14px 16px',
          color: '#202122',
          fontSize: '1.05rem',
          fontWeight: 600,
          fontFamily: 'inherit',
          outline: 'none',
          boxSizing: 'border-box',
          margin: '6px 0 16px',
        }}
      />

      {error && (
        <p style={{
          color: '#FF4443', fontSize: '0.85rem', marginBottom: 16,
          padding: '10px 14px', background: 'rgba(255,68,67,0.08)', borderRadius: 8, textAlign: 'center',
        }}>
          {error}
        </p>
      )}

      <button
        onClick={handleRequest}
        disabled={busy || !name.trim()}
        style={{
          width: '100%',
          background: name.trim() ? 'rgba(255,214,38,0.15)' : 'rgba(32,33,34,0.03)',
          border: `1px solid ${name.trim() ? 'rgba(255,214,38,0.3)' : '#E6E5DA'}`,
          color: name.trim() ? '#FFD626' : '#8F8E85',
          padding: '16px 24px',
          borderRadius: 12,
          fontSize: '1.05rem',
          fontWeight: 700,
          cursor: name.trim() ? 'pointer' : 'not-allowed',
          fontFamily: 'inherit',
        }}
      >
        {busy ? 'Sending…' : 'Ask to join'}
      </button>
    </>
  )
}

const quietBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#6F6E66',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '0.85rem',
}
