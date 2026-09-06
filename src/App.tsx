import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { collectionGroup, collection, query, where, getDocs, getDoc } from 'firebase/firestore'
import { auth, db } from './lib/firebase'
import AuthPage from './pages/AuthPage'
import HomePage from './pages/HomePage'
import CreateGame from './pages/CreateGame'
import JoinGame from './pages/JoinGame'
import LateJoinPage from './pages/LateJoinPage'
import PastForaysPage from './pages/PastForaysPage'
import LobbyPage from './pages/LobbyPage'
import AdminSeed from './pages/AdminSeed'
import GamePage from './pages/GamePage'
import GMDashboard from './pages/GMDashboard'
import ZoneManager from './pages/ZoneManager'
import ZoneBuilder from './pages/ZoneBuilder'
import ResultsPage from './pages/ResultsPage.tsx'
import GameRouteGuard from './components/GameRouteGuard'
import AdminGuard from './components/AdminGuard'
import SeedMaps from './pages/SeedMaps'
import SideQuestExplorer from './pages/SideQuestExplorer'

// ---------------------------------------------------------------------------
// Checks Firestore for an active game this user is part of (player or GM).
// Returns the redirect path if found, null otherwise.
// ---------------------------------------------------------------------------
async function findActiveGameForUser(uid: string): Promise<string | null> {
  try {
    // Check if user is a GM of an active game
    // (games where created_by == uid and status == 'active' or 'strategy')
    const gamesRef = collection(db, 'games')
    const gmQuery = query(gamesRef, where('created_by', '==', uid), where('status', 'in', ['lobby', 'active', 'strategy', 'paused']))
    const gmSnap = await getDocs(gmQuery)
    if (!gmSnap.empty) {
      const g = gmSnap.docs[0]
      return g.data().status === 'lobby' ? `/lobby/${g.id}` : `/gm/${g.id}`
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
    let cancelled = false
    findActiveGameForUser(uid).then((path) => {
      if (path && !cancelled) navigate(path, { replace: true })
    })
    return () => { cancelled = true }
  }, [uid, navigate])

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
        background: '#FDFFF1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{ color: '#A3A298', fontSize: '0.85rem' }}>Loading...</div>
      </div>
    )
  }

  // Brand-preview only (dev server + ?preview=player): render the signed-out
  // player Home view so the reskin can be reviewed without logging in.
  // Never active in a production build.
  if (!user && import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === 'player') {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<HomePage />} />
        </Routes>
      </BrowserRouter>
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
        {/* Only GMs/admins can create games; players are sent home. */}
        <Route path="/create" element={<AdminGuard><CreateGame /></AdminGuard>} />
        <Route path="/join" element={<JoinGame />} />
        {/* Player asking to join a game that already started; GM approves from the dashboard. */}
        <Route path="/late-join/:gameId" element={<LateJoinPage />} />
        <Route path="/forays" element={<PastForaysPage />} />
<Route
          path="/lobby/:gameId"
          element={
            <GameRouteGuard expectedPathPrefix="/lobby">
              <LobbyPage />
            </GameRouteGuard>
          }
        />
        <Route
          path="/game/:gameId"
          element={
            <GameRouteGuard expectedPathPrefix="/game">
              <GamePage />
            </GameRouteGuard>
          }
        />
        <Route
          path="/gm/:gameId"
          element={
            <GameRouteGuard expectedPathPrefix="/gm">
              <GMDashboard />
            </GameRouteGuard>
          }
        />
        <Route path="/admin/seed" element={<AdminGuard><AdminSeed /></AdminGuard>} />
        <Route path="/admin/zones" element={<AdminGuard><ZoneManager /></AdminGuard>} />
        <Route path="/admin/zone-builder" element={<AdminGuard><ZoneBuilder /></AdminGuard>} />
        <Route path="/admin/seed-maps" element={<AdminGuard><SeedMaps /></AdminGuard>} />
        <Route path="/admin/side-quests" element={<AdminGuard><SideQuestExplorer /></AdminGuard>} />
        <Route path="/results/:gameId" element={<ResultsPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  )
}