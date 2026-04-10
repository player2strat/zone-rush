import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { collectionGroup, query, where, getDocs, getDoc, doc } from 'firebase/firestore'
import { auth, db } from './lib/firebase'
import AuthPage from './pages/AuthPage'
import HomePage from './pages/HomePage'
import MapPage from './pages/MapPage'
import CreateGame from './pages/CreateGame'
import JoinGame from './pages/JoinGame'
import LobbyPage from './pages/LobbyPage'
import AdminSeed from './pages/AdminSeed'
import GamePage from './pages/GamePage'
import GMDashboard from './pages/GMDashboard'
import ZoneManager from './pages/ZoneManager'
import ResultsPage from './pages/ResultsPage.tsx'

// ---------------------------------------------------------------------------
// Checks Firestore for an active game this user is part of (player or GM).
// Returns the redirect path if found, null otherwise.
// ---------------------------------------------------------------------------
async function findActiveGameForUser(uid: string): Promise<string | null> {
  try {
    // Check if user is a GM of an active game
    // (games where created_by == uid and status == 'active' or 'strategy')
    const { collection, query: q, where: w, getDocs: gd } = await import('firebase/firestore')
    const gamesRef = collection(db, 'games')
    const gmQuery = q(gamesRef, w('created_by', '==', uid), w('status', 'in', ['active', 'strategy', 'paused']))
    const gmSnap = await gd(gmQuery)
    if (!gmSnap.empty) {
      return `/gm/${gmSnap.docs[0].id}`
    }

    // Check if user is a player on a team in an active game
    // collectionGroup lets us query ALL 'teams' subcollections across all games
    const teamsQuery = query(
      collectionGroup(db, 'teams'),
      where('members', 'array-contains', uid)
    )
    const teamsSnap = await getDocs(teamsQuery)

    for (const teamDoc of teamsSnap.docs) {
      // teamDoc.ref.parent.parent is the game document
      const gameRef = teamDoc.ref.parent.parent
      if (!gameRef) continue

      const gameSnap = await getDoc(gameRef)
      if (!gameSnap.exists()) continue

      const status = gameSnap.data().status
      if (status === 'active' || status === 'strategy' || status === 'paused') {
        return `/game/${gameRef.id}`
      }
      if (status === 'lobby') {
        return `/lobby/${gameRef.id}`
      }
    }

    return null
  } catch (err) {
    // If the query fails (e.g. missing index), just send them home
    console.warn('Active game lookup failed:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Runs once on mount — if user has an active game, redirects them there.
// Shown on the home route only so it doesn't interrupt mid-game navigation.
// ---------------------------------------------------------------------------
function ActiveGameRedirect({ uid }: { uid: string }) {
  const navigate = useNavigate()

  useEffect(() => {
    findActiveGameForUser(uid).then((path) => {
      if (path) navigate(path, { replace: true })
    })
  }, [uid])

  return null
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })
    return unsubscribe
  }, [])

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

  if (!user) return <AuthPage />

  return (
    <BrowserRouter>
      {/*
        ActiveGameRedirect only runs on the home route ("/").
        It checks Firestore once and silently redirects if an active game is found.
        Players who closed the browser mid-game land back where they left off.
      */}
      <Routes>
        <Route path="/" element={
          <>
            <ActiveGameRedirect uid={user.uid} />
            <HomePage />
          </>
        } />
        <Route path="/map" element={<MapPage />} />
        <Route path="/create" element={<CreateGame />} />
        <Route path="/join" element={<JoinGame />} />
        <Route path="/lobby/:gameId" element={<LobbyPage />} />
        <Route path="/game/:gameId" element={<GamePage />} />
        <Route path="/gm/:gameId" element={<GMDashboard />} />
        <Route path="/admin/seed" element={<AdminSeed />} />
        <Route path="/admin/zones" element={<ZoneManager />} />
        <Route path="/results/:gameId" element={<ResultsPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  )
}