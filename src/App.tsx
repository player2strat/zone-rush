import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from './lib/firebase'
import AuthPage from './pages/AuthPage'
import MapPage from './pages/MapPage'

// Temporary home screen — we'll build the real one on Day 6
function HomeScreen({ user, onViewMap }: { user: User; onViewMap: () => void }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: 16,
      fontFamily: 'sans-serif',
      padding: 24,
    }}>
      <div style={{ fontSize: '3rem' }}>🏙️</div>
      <h1 style={{ color: '#FFD166', margin: 0 }}>You're in!</h1>
      <p style={{ color: '#888', margin: 0 }}>
        Logged in as <strong style={{ color: '#fff' }}>{user.displayName || user.email}</strong>
      </p>
      <p style={{ color: '#444', fontSize: '0.85rem' }}>
        Firebase is connected ✓ • More coming on Day 3+
      </p>
      <button
        onClick={() => auth.signOut()}
        style={{
          marginTop: 16,
          padding: '10px 20px',
          background: '#111',
          border: '1px solid #222',
          borderRadius: 8,
          color: '#888',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
              <button
        onClick={onViewMap}
        style={{
          marginTop: 16,
          padding: '12px 24px',
          background: '#FFD166',
          border: 'none',
          borderRadius: 8,
          color: '#000',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontWeight: 700,
          fontSize: '0.95rem',
        }}
      >
        🗺️ View Map
      </button>
        Sign out
      </button>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [screen, setScreen] = useState<'home' | 'map'>('home')

  useEffect(() => {
    // Firebase listener — fires whenever auth state changes (login, logout, page refresh)
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })
    return unsubscribe // Cleanup on unmount
  }, [])

  // Show nothing while Firebase checks if user is already logged in
  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{ color: '#333', fontSize: '0.85rem' }}>Loading...</div>
      </div>
    )
  }

  // Route: show auth screen if not logged in, home screen if logged in
  if (!user) return <AuthPage />
if (screen === 'map') return <MapPage />
return <HomeScreen user={user} onViewMap={() => setScreen('map')} />
}