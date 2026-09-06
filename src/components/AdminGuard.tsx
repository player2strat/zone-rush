// =============================================================================
// Wraps admin-only routes. Checks user role from Firestore.
// Allows "admin" and "gm" roles through. Everyone else gets sent home.
// =============================================================================

import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useUserRole } from '../hooks/useUserRole'

export default function AdminGuard({ children }: { children: ReactNode }) {
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

  // Only admin and gm roles can access these pages
  if (role !== 'admin' && role !== 'gm') {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}