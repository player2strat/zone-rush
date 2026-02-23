// =============================================================================
// Zone Rush — Home Page
// First screen after login. Navigate to create or join a game.
// =============================================================================

import { useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../lib/firebase'

export default function HomePage() {
  const navigate = useNavigate()
  const user = auth.currentUser

  const handleSignOut = async () => {
    await signOut(auth)
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
      {/* Logo / Title */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <p style={{
          fontSize: '0.75rem',
          color: '#FFD166',
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 8,
        }}>
          Zone Rush
        </p>
        <h1 style={{
          fontSize: '2rem',
          fontWeight: 800,
          margin: 0,
          letterSpacing: -1,
        }}>
          Ready to explore?
        </h1>
        <p style={{
          color: '#666',
          fontSize: '0.9rem',
          marginTop: 8,
        }}>
          Welcome back, {user?.displayName || user?.email || 'Player'}
        </p>
      </div>

      {/* Action Buttons */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        maxWidth: 320,
      }}>
        {/* Create Game — GM only */}
        <button
          onClick={() => navigate('/create')}
          style={{
            background: 'rgba(255,209,102,0.12)',
            border: '1px solid rgba(255,209,102,0.3)',
            color: '#FFD166',
            padding: '18px 24px',
            borderRadius: 12,
            fontSize: '1.05rem',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          Create Game
          <span style={{
            display: 'block',
            fontSize: '0.78rem',
            fontWeight: 400,
            color: '#997a3d',
            marginTop: 4,
          }}>
            Set up zones, invite players
          </span>
        </button>

        {/* Join Game — All players */}
        <button
          onClick={() => navigate('/join')}
          style={{
            background: 'rgba(6,214,160,0.12)',
            border: '1px solid rgba(6,214,160,0.3)',
            color: '#06D6A0',
            padding: '18px 24px',
            borderRadius: 12,
            fontSize: '1.05rem',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          Join Game
          <span style={{
            display: 'block',
            fontSize: '0.78rem',
            fontWeight: 400,
            color: '#3d8a6e',
            marginTop: 4,
          }}>
            Enter a game code
          </span>
        </button>
      </div>

      {/* Bottom links */}
      <div style={{
        marginTop: 48,
        display: 'flex',
        gap: 24,
        fontSize: '0.82rem',
      }}>
        <button
          onClick={() => navigate('/map')}
          style={{
            background: 'none',
            border: 'none',
            color: '#555',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        >
          View Map
        </button>
        <button
          onClick={handleSignOut}
          style={{
            background: 'none',
            border: 'none',
            color: '#555',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        >
          Sign Out
        </button>
      </div>
    </div>
  )
}