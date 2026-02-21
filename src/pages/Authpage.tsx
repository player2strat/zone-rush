import { useState } from 'react'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
} from 'firebase/auth'
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'

const googleProvider = new GoogleAuthProvider()

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Create or update the user's Firestore document after login/signup
  async function createUserDoc(uid: string, name: string, email: string) {
    const userRef = doc(db, 'users', uid)
    const existing = await getDoc(userRef)

    if (!existing.exists()) {
      // First time — create full user document
      await setDoc(userRef, {
        id: uid,
        display_name: name,
        email: email,
        role: 'player', // Default role — GMs get updated manually for now
        player_profile: null, // Set during onboarding (adventurer/academic/gamer/ride_along)
        games_played: 0,
        games_won: 0,
        home_city: 'nyc',
        created_at: serverTimestamp(),
      })
    }
    // If user already exists, we don't overwrite — just let them in
  }

  async function handleEmailAuth() {
    setError('')
    setLoading(true)

    try {
      if (mode === 'signup') {
        if (!displayName.trim()) {
          setError('Please enter your name.')
          setLoading(false)
          return
        }
        const result = await createUserWithEmailAndPassword(auth, email, password)
        await updateProfile(result.user, { displayName })
        await createUserDoc(result.user.uid, displayName, email)
      } else {
        const result = await signInWithEmailAndPassword(auth, email, password)
        await createUserDoc(result.user.uid, result.user.displayName || email, email)
      }
      // Auth state change in App.tsx will handle the redirect
    } catch (err: any) {
      // Make Firebase error messages human-readable
      const msg = err.code
        ?.replace('auth/', '')
        ?.replace(/-/g, ' ')
      setError(msg || 'Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setError('')
    setLoading(true)
    try {
      const result = await signInWithPopup(auth, googleProvider)
      const user = result.user
      await createUserDoc(user.uid, user.displayName || 'Player', user.email || '')
    } catch (err: any) {
      setError('Google sign-in failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Logo / Header */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ fontSize: '3rem', marginBottom: 12 }}>🏙️</div>
          <h1 style={{ color: '#FFD166', fontWeight: 800, fontSize: '2rem', margin: 0, letterSpacing: -1 }}>
            Zone Rush
          </h1>
          <p style={{ color: '#555', marginTop: 8, fontSize: '0.9rem' }}>
            Urban Scavenger Hunt
          </p>
        </div>

        {/* Mode toggle */}
        <div style={{
          display: 'flex',
          background: '#111',
          borderRadius: 10,
          padding: 4,
          marginBottom: 24,
          border: '1px solid #1a1a1a',
        }}>
          {(['login', 'signup'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError('') }}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: 8,
                border: 'none',
                background: mode === m ? '#FFD166' : 'transparent',
                color: mode === m ? '#0a0a0a' : '#555',
                fontWeight: 700,
                fontSize: '0.88rem',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
            >
              {m === 'login' ? 'Log In' : 'Sign Up'}
            </button>
          ))}
        </div>

        {/* Form */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'signup' && (
            <input
              placeholder="Your name (shown to teammates)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={inputStyle}
            />
          )}
          <input
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleEmailAuth()}
            style={inputStyle}
          />

          {error && (
            <p style={{ color: '#EF476F', fontSize: '0.85rem', margin: 0, textAlign: 'center' }}>
              {error}
            </p>
          )}

          <button
            onClick={handleEmailAuth}
            disabled={loading}
            style={{
              ...buttonStyle,
              background: '#FFD166',
              color: '#0a0a0a',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Loading...' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
            <div style={{ flex: 1, height: 1, background: '#1a1a1a' }} />
            <span style={{ color: '#333', fontSize: '0.78rem' }}>or</span>
            <div style={{ flex: 1, height: 1, background: '#1a1a1a' }} />
          </div>

          <button
            onClick={handleGoogle}
            disabled={loading}
            style={{
              ...buttonStyle,
              background: '#111',
              color: '#e0e0e0',
              border: '1px solid #222',
              opacity: loading ? 0.6 : 1,
            }}
          >
            <span style={{ marginRight: 8 }}>G</span>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  background: '#111',
  border: '1px solid #222',
  borderRadius: 10,
  padding: '14px 16px',
  color: '#fff',
  fontSize: '1rem',
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const buttonStyle: React.CSSProperties = {
  padding: '14px',
  borderRadius: 10,
  border: 'none',
  fontWeight: 700,
  fontSize: '1rem',
  cursor: 'pointer',
  fontFamily: 'inherit',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
