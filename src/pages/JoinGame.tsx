// =============================================================================
// Zone Rush — Join Game Page
// Player enters a 6-character join code to find and enter a game lobby.
// =============================================================================

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'

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
      // Find the game with this join code
      const q = query(
        collection(db, 'games'),
        where('join_code', '==', cleanCode),
        where('status', '==', 'lobby')
      )
      const snapshot = await getDocs(q)

      if (snapshot.empty) {
        setError('No game found with that code. Check the code and try again.')
        setSearching(false)
        return
      }

      // Found the game — navigate to its lobby
      const gameDoc = snapshot.docs[0]
      navigate('/lobby/' + gameDoc.id)
    } catch (err: any) {
      setError('Error finding game: ' + err.message)
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
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
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
            background: 'none', border: 'none', color: '#555',
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
          <p style={{ color: '#666', fontSize: '0.88rem', marginTop: 8 }}>
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
            background: 'rgba(255,255,255,0.05)',
            border: '2px solid ' + (code.length === 6 ? '#06D6A0' : '#333'),
            borderRadius: 12,
            padding: '18px 20px',
            color: '#fff',
            fontSize: '1.8rem',
            fontWeight: 800,
            fontFamily: "'JetBrains Mono', monospace",
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
          color: code.length === 6 ? '#06D6A0' : '#444',
          marginTop: 10,
          marginBottom: 24,
        }}>
          {code.length}/6 characters
        </p>

        {/* Error */}
        {error && (
          <p style={{
            color: '#EF476F',
            fontSize: '0.85rem',
            marginBottom: 16,
            padding: '10px 14px',
            background: 'rgba(239,71,111,0.08)',
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
              ? 'rgba(6,214,160,0.15)'
              : 'rgba(255,255,255,0.03)',
            border: `1px solid ${code.length === 6 ? 'rgba(6,214,160,0.3)' : '#222'}`,
            color: code.length === 6 ? '#06D6A0' : '#444',
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