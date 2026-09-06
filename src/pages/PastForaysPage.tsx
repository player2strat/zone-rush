// =============================================================================
// Foray — Past Forays
//
// The player's game history: every finished game they played (or ran as GM),
// newest first, with the team they were on and the date. Tapping a row opens
// that game's results page (score, submissions gallery, final map).
// =============================================================================

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  collection, collectionGroup, query, where, getDocs, getDoc,
} from 'firebase/firestore'
import { db, auth } from '../lib/firebase'

interface PastForay {
  id: string
  name: string
  teamName: string | null   // null when the user was the GM
  teamColor: string | null
  created_at?: { seconds?: number }
}

// Finished games this user was part of, as player or GM, newest first.
// Player games come from the teams collection-group index (same one the
// active-game redirect uses); the team doc also gives us name and color.
async function loadPastForays(uid: string): Promise<PastForay[]> {
  const out = new Map<string, PastForay>()
  try {
    const gmSnap = await getDocs(query(
      collection(db, 'games'),
      where('created_by', '==', uid),
      where('status', '==', 'ended'),
    ))
    gmSnap.forEach((g) => {
      out.set(g.id, {
        id: g.id,
        name: g.data().name || 'Untitled game',
        teamName: null,
        teamColor: null,
        created_at: g.data().created_at,
      })
    })

    const teamsSnap = await getDocs(query(
      collectionGroup(db, 'teams'),
      where('members', 'array-contains', uid),
    ))
    const rows = teamsSnap.docs
      .map((t) => ({ ref: t.ref.parent.parent, team: t.data() }))
      .filter((r): r is typeof r & { ref: NonNullable<typeof r.ref> } => !!r.ref)
      .filter((r) => !out.has(r.ref.id))
    const games = await Promise.all(rows.map((r) => getDoc(r.ref)))
    games.forEach((g, i) => {
      if (g.exists() && g.data().status === 'ended') {
        out.set(g.id, {
          id: g.id,
          name: g.data().name || 'Untitled game',
          teamName: (rows[i].team.name as string) || 'Team',
          teamColor: (rows[i].team.color as string) || 'var(--ink-muted)',
          created_at: g.data().created_at,
        })
      }
    })
  } catch (err) {
    console.warn('Past forays lookup failed:', err)
  }
  return Array.from(out.values())
    .sort((a, b) => (b.created_at?.seconds ?? 0) - (a.created_at?.seconds ?? 0))
}

export default function PastForaysPage() {
  const navigate = useNavigate()
  const user = auth.currentUser
  const [forays, setForays] = useState<PastForay[] | null>(null) // null = loading

  useEffect(() => {
    const uid = user?.uid
    if (!uid) return
    let cancelled = false
    loadPastForays(uid).then((games) => {
      if (!cancelled) setForays(games)
    })
    return () => { cancelled = true }
  }, [user?.uid])

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--paper)',
      color: 'var(--ink)',
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      padding: 24,
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none', border: 'none', color: 'var(--ink-faint)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem',
            padding: 0, marginBottom: 24,
          }}
        >
          ← Home
        </button>

        <p style={{
          fontSize: '0.75rem', color: 'var(--marigold)', textTransform: 'uppercase',
          letterSpacing: 2, margin: '0 0 4px',
        }}>
          Foray
        </p>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 6px' }}>
          Past Forays
        </h1>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.88rem', margin: '0 0 28px' }}>
          Every game you've played — tap one to revisit the score, your team's
          submissions, and the final map.
        </p>

        {forays === null ? (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>Loading…</p>
        ) : forays.length === 0 ? (
          <div style={{
            border: '1px solid var(--line)', borderRadius: 12,
            padding: '32px 24px', textAlign: 'center', color: 'var(--ink-faint)',
          }}>
            <p style={{ fontSize: '1.5rem', margin: '0 0 8px' }}>🧭</p>
            <p style={{ margin: 0, fontSize: '0.9rem' }}>
              No finished forays yet — your completed games will show up here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {forays.map((g) => (
              <button
                key={g.id}
                onClick={() => navigate('/results/' + g.id)}
                style={{
                  background: 'rgba(var(--ink-rgb), 0.02)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '14px 16px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'baseline', gap: 10,
                }}>
                  <span style={{
                    color: 'var(--ink-soft)', fontWeight: 700, fontSize: '0.95rem',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {g.name}
                  </span>
                  {g.created_at?.seconds && (
                    <span style={{ color: 'var(--ink-faint)', fontSize: '0.75rem', flexShrink: 0 }}>
                      {new Date(g.created_at.seconds * 1000).toLocaleDateString(undefined, {
                        month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </span>
                  )}
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
                }}>
                  {g.teamName ? (
                    <>
                      <span style={{
                        width: 9, height: 9, borderRadius: 2, flexShrink: 0,
                        background: g.teamColor ?? 'var(--ink-muted)',
                      }} />
                      <span style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>
                        {g.teamName}
                      </span>
                    </>
                  ) : (
                    <span style={{
                      color: 'var(--marigold)', fontSize: '0.7rem', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: 1,
                    }}>
                      Game Master
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
