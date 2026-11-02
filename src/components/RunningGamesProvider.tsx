// =============================================================================
// Foray — RunningGamesProvider
//
// One live feed of the signed-in GM's running games (hooks/useRunningGames),
// with pending submissions, pending join requests and roster size per game.
// Mounted once in App, for GMs and admins only: the home screen lists these
// games, each dashboard shows what's waiting in the others, and every game's
// timed events run from here on whatever screen the GM has open.
// =============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useUserRole } from '../hooks/useUserRole'
import { useGameTimers } from '../hooks/useGameTimers'
import {
  RunningGamesContext, RUNNING_STATUSES,
  type RunningGame, type RunningStatus,
} from '../hooks/useRunningGames'

type GameDoc = Omit<RunningGame, 'pendingSubmissions' | 'pendingJoins' | 'players'>
type Counts = { subs: number; joins: number; players: number }

// Live games first, then the ones still being set up.
const STATUS_ORDER: Record<RunningStatus, number> = { active: 0, paused: 1, strategy: 2, lobby: 3 }

export default function RunningGamesProvider({ uid, children }: { uid: string; children: ReactNode }) {
  const { role } = useUserRole()
  const isGM = role === 'admin' || role === 'gm'
  const [docs, setDocs] = useState<GameDoc[]>([])
  const [counts, setCounts] = useState<Record<string, Counts>>({})

  useEffect(() => {
    if (!isGM) return
    const q = query(
      collection(db, 'games'),
      where('created_by', '==', uid),
      where('status', 'in', RUNNING_STATUSES)
    )
    return onSnapshot(
      q,
      (snap) => setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() } as GameDoc))),
      (err) => console.warn('Running games feed failed:', err)
    )
  }, [isGM, uid])

  // Per game: pending submissions, pending join requests, roster size.
  const idsKey = docs.map((d) => d.id).sort().join(',')
  useEffect(() => {
    if (!idsKey) return
    const unsubs: (() => void)[] = []
    for (const id of idsKey.split(',')) {
      const set = (field: keyof Counts) => (n: number) =>
        setCounts((prev) => ({
          ...prev,
          [id]: { ...(prev[id] ?? { subs: 0, joins: 0, players: 0 }), [field]: n },
        }))
      const warn = (err: Error) => console.warn('Running game counts failed:', id, err)
      unsubs.push(onSnapshot(
        query(collection(db, 'submissions'), where('game_id', '==', id), where('status', '==', 'pending')),
        (s) => set('subs')(s.size), warn
      ))
      unsubs.push(onSnapshot(
        query(collection(db, 'games', id, 'join_requests'), where('status', '==', 'pending')),
        (s) => set('joins')(s.size), warn
      ))
      unsubs.push(onSnapshot(collection(db, 'games', id, 'players'), (s) => set('players')(s.size), warn))
    }
    return () => unsubs.forEach((u) => u())
  }, [idsKey])

  const games = useMemo(
    () =>
      (isGM ? docs : [])
        .map((d) => ({
          ...d,
          pendingSubmissions: counts[d.id]?.subs ?? 0,
          pendingJoins: counts[d.id]?.joins ?? 0,
          players: counts[d.id]?.players ?? 0,
        }))
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)),
    [isGM, docs, counts]
  )

  // Timed events (milestone messages, zone schedules, lockouts) for every one
  // of these games, from whatever screen is open.
  useGameTimers(games, isGM ? uid : undefined)

  return <RunningGamesContext.Provider value={games}>{children}</RunningGamesContext.Provider>
}
