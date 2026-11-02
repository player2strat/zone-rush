// =============================================================================
// Wraps admin-only routes (Zone Builder, Zone Manager, seeding, exports).
// Checks the user's role from Firestore and lets only "admin" through; with
// `allowGm` (Create Game) "gm" gets in too. Everyone else gets sent home.
// =============================================================================

import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useUserRole } from '../hooks/useUserRole'

export default function AdminGuard({ children, allowGm = false }: { children: ReactNode; allowGm?: boolean }) {
  const { role, loading } = useUserRole()

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        color: 'var(--ink-faint)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      }}>
        Checking access...
      </div>
    )
  }

  if (role !== 'admin' && !(allowGm && role === 'gm')) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
