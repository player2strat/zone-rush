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
    } catch (err) {
      // Make Firebase error messages human-readable
      const msg = (err as { code?: string }).code
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
    } catch {
      setError('Google sign-in failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#FDFFF1',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Logo / Header */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <img
            src="/brand/logo.svg"
            alt="Foray"
            style={{ width: '100%', maxWidth: 320, height: 'auto', display: 'block', margin: '0 auto 16px' }}
          />
          <p style={{
            color: '#202122', margin: 0, fontSize: '0.78rem', fontWeight: 700,
            fontFamily: "'Martian Mono', monospace", textTransform: 'uppercase', letterSpacing: 2,
          }}>
            Claim the city
          </p>
        </div>

        {/* Mode toggle */}
        <div style={{
          display: 'flex',
          background: '#FFFFFF',
          borderRadius: 10,
          padding: 4,
          marginBottom: 24,
          border: '1px solid #E6E5DA',
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
                background: mode === m ? '#FFD626' : 'transparent',
                color: mode === m ? '#202122' : '#6F6E66',
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
            <p style={{ color: '#FF4443', fontSize: '0.85rem', margin: 0, textAlign: 'center' }}>
              {error}
            </p>
          )}

          <button
            onClick={handleEmailAuth}
            disabled={loading}
            style={{
              ...buttonStyle,
              background: '#FFD626',
              color: '#202122',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Loading...' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
            <div style={{ flex: 1, height: 1, background: '#E6E5DA' }} />
            <span style={{ color: '#A3A298', fontSize: '0.78rem' }}>or</span>
            <div style={{ flex: 1, height: 1, background: '#E6E5DA' }} />
          </div>

          <button
            onClick={handleGoogle}
            disabled={loading}
            style={{
              ...buttonStyle,
              background: '#FFFFFF',
              color: '#2A2B2C',
              border: '1px solid #E6E5DA',
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
  background: '#FFFFFF',
  border: '1px solid #E6E5DA',
  borderRadius: 10,
  padding: '14px 16px',
  color: '#202122',
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
