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
  { path: '/admin/side-quests', label: 'Side Quest Explorer', desc: 'All-time submissions & partner export' },
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
      background: '#FDFFF1',
      color: '#202122',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      {/* Logo / Title */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <img
          src="/brand/logo.svg"
          alt="Foray"
          style={{ width: '100%', maxWidth: 280, height: 'auto', display: 'block', margin: '0 auto 20px' }}
        />
        <h1 style={{
          fontSize: '1.5rem',
          fontWeight: 700,
          margin: 0,
        }}>
          {isGM ? 'Game Master' : 'Ready to explore?'}
        </h1>
        <p style={{
          color: '#5F5E57',
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
            background: 'rgba(255,214,38,0.12)',
            border: '1px solid rgba(255,214,38,0.3)',
            color: '#FFD626',
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
            color: '#7A6400',
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
            background: 'rgba(230,125,209,0.12)',
            border: '1px solid rgba(230,125,209,0.3)',
            color: '#E67DD1',
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
            color: '#9B4F8C',
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
            background: '#FFD626',
            border: 'none',
            color: '#202122',
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
            color: '#202122',
            opacity: 0.75,
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
          border: '1px solid #E6E5DA',
          borderRadius: 12,
          padding: 16,
        }}>
          <p style={{
            fontSize: '0.7rem',
            color: '#5F5E57',
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
                  background: 'rgba(32,33,34,0.02)',
                  border: '1px solid #E6E5DA',
                  borderRadius: 8,
                  padding: '10px 12px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ color: '#2A2B2C', fontWeight: 600, fontSize: '0.9rem' }}>
                  {link.label}
                </span>
                <span style={{
                  display: 'block',
                  color: '#5F5E57',
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

      {/* Bottom actions — secondary outlined buttons */}
      <div style={{
        marginTop: 32,
        display: 'flex',
        gap: 12,
        width: '100%',
        maxWidth: 320,
      }}>
        <button
          onClick={() => navigate('/forays')}
          style={secondaryButtonStyle}
        >
          Past Forays
        </button>
        <button
          onClick={handleSignOut}
          style={secondaryButtonStyle}
        >
          Sign Out
        </button>
      </div>
    </div>
  )
}
const secondaryButtonStyle: React.CSSProperties = {
  flex: 1,
  background: 'none',
  border: 'none',
  color: '#5F5E57',
  padding: '12px 8px',
  fontSize: '0.9rem',
  fontWeight: 500,
  textDecoration: 'underline',
  textDecorationThickness: 1,
  textUnderlineOffset: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
}
