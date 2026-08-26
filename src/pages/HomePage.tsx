// =============================================================================
// Foray — Home Page
// First screen after login. Navigate to create or join a game.
// =============================================================================

import { useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { useUserRole } from '../hooks/useUserRole'

// Admin/GM-only tools. These routes are gated by AdminGuard; this list just
// surfaces them so admins don't have to type URLs.
const ADMIN_LINKS = [
  { path: '/admin/zones', label: 'Zone Manager', desc: 'Import & edit zone metadata' },
  { path: '/admin/seed-maps', label: 'Seed Maps', desc: 'Seed starter maps' },
  { path: '/admin/seed', label: 'Seed Challenges', desc: 'Seed challenge cards' },
]

export default function HomePage() {
  const navigate = useNavigate()
  const user = auth.currentUser
  const { role, loading: roleLoading } = useUserRole()
  // GM/admin see the Game Master view (Create + Join + admin tools).
  // Everyone else sees the Player view (Join only).
  const isGM = role === 'admin' || role === 'gm'

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
          Foray
        </p>
        <h1 style={{
          fontSize: '2rem',
          fontWeight: 800,
          margin: 0,
          letterSpacing: -1,
        }}>
          {isGM ? 'Game Master' : 'Ready to explore?'}
        </h1>
        <p style={{
          color: '#666',
          fontSize: '0.9rem',
          marginTop: 8,
        }}>
          Welcome back, {user?.displayName || user?.email || 'Player'}
        </p>
      </div>

      {/* Action Buttons — wait for the role so the view doesn't flash */}
      {!roleLoading && (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        width: '100%',
        maxWidth: 320,
      }}>
        {/* Create Game — GM only. Players only ever see Join Game. */}
        {isGM && (
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
        )}

        {/* Zone Builder — GM only. Primary action so admins don't have to
            dig through the Admin Tools list. */}
        {isGM && (
        <button
          onClick={() => navigate('/admin/zone-builder')}
          style={{
            background: 'rgba(155,93,229,0.12)',
            border: '1px solid rgba(155,93,229,0.3)',
            color: '#9B5DE5',
            padding: '18px 24px',
            borderRadius: 12,
            fontSize: '1.05rem',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
        >
          Zone Builder
          <span style={{
            display: 'block',
            fontSize: '0.78rem',
            fontWeight: 400,
            color: '#6e4a9e',
            marginTop: 4,
          }}>
            Draw maps & zones
          </span>
        </button>
        )}

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
            {isGM ? 'Enter a game code' : 'Enter the code from your Game Master'}
          </span>
        </button>
      </div>
      )}

      {/* Admin tools — only for admin/GM roles */}
      {isGM && (
        <div style={{
          marginTop: 32,
          width: '100%',
          maxWidth: 320,
          border: '1px solid #1a1a1a',
          borderRadius: 12,
          padding: 16,
        }}>
          <p style={{
            fontSize: '0.7rem',
            color: '#666',
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            fontWeight: 700,
            margin: '0 0 12px',
          }}>
            More Admin Tools
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ADMIN_LINKS.map((link) => (
              <button
                key={link.path}
                onClick={() => navigate(link.path)}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid #222',
                  borderRadius: 8,
                  padding: '10px 12px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ color: '#ddd', fontWeight: 600, fontSize: '0.9rem' }}>
                  {link.label}
                </span>
                <span style={{
                  display: 'block',
                  color: '#666',
                  fontSize: '0.75rem',
                  marginTop: 2,
                }}>
                  {link.desc}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom links */}
      <div style={{
        marginTop: 48,
        display: 'flex',
        gap: 24,
        fontSize: '0.82rem',
      }}>
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