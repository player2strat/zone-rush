// =============================================================================
// Fetches the current user's role from the Firestore users collection.
// Returns { role, loading } — role is "player" | "gm" | "admin" | null
// =============================================================================

import { useState, useEffect } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db, auth } from '../lib/firebase'

export function useUserRole() {
  const [role, setRole] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = auth.currentUser
    if (!user) {
      setRole(null)
      setLoading(false)
      return
    }

    getDoc(doc(db, 'users', user.uid))
      .then((snap) => {
        if (snap.exists()) {
          setRole(snap.data().role || 'player')
        } else {
          setRole('player')
        }
      })
      .catch(() => setRole('player'))
      .finally(() => setLoading(false))
  }, [])

  return { role, loading }
}