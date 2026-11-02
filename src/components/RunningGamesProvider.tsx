// =============================================================================
// Foray — RunningGamesProvider
//
// One live feed of the signed-in GM's running games (hooks/useRunningGames),
// with what each one is waiting on. Mounted once in App, for GMs and admins
// only. From here:
//  - the home screen lists these games, and each dashboard shows what's
//    waiting in the others;
//  - anything new (a submission, side quest photo, join request or "Message
//    GM" ping) plays a chime and shows a desktop pop-up (lib/gmAlerts), unless
//    the GM is already looking at that game;
//  - the browser tab title shows the total waiting, e.g. "(4) Foray";
//  - every game's timed events run, on whatever screen the GM has open.
// =============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  collection, doc, getDoc, onSnapshot, query, where,
  type DocumentData, type Query,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useUserRole } from '../hooks/useUserRole'
import { useGameTimers } from '../hooks/useGameTimers'
import { playChime, primeChime, showPopup } from '../lib/gmAlerts'
import {
  RunningGamesContext, RUNNING_STATUSES, waitingCount,
  type RunningGame, type RunningStatus,
} from '../hooks/useRunningGames'

type Counts = {
  subs: number
  sideQuests: number
  joins: number
  messages: number
  players: number
}
type GameDoc = Omit<RunningGame, 'pendingSubmissions' | 'pendingSideQuests' | 'pendingJoins' | 'unreadMessages' | 'players'>

const NO_COUNTS: Counts = { subs: 0, sideQuests: 0, joins: 0, messages: 0, players: 0 }
const APP_TITLE = 'Foray'

// Live games first, then the ones still being set up.
const STATUS_ORDER: Record<RunningStatus, number> = { active: 0, paused: 1, strategy: 2, lobby: 3 }

// Team names for alert text, looked up once per team.
const teamNames = new Map<string, Promise<string>>()
function teamName(gameId: string, teamId: string): Promise<string> {
  const key = `${gameId}/${teamId}`
  if (!teamNames.has(key)) {
    teamNames.set(key, getDoc(doc(db, 'games', gameId, 'teams', teamId))
      .then((snap) => (snap.data()?.name as string) || 'A team')
      .catch(() => 'A team'))
  }
  return teamNames.get(key)!
}

const clip = (text: unknown) => {
  const s = String(text ?? '').trim()
  return s.length > 100 ? s.slice(0, 99) + '…' : s
}

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

  // What the alerts need without restarting the listeners: game names, the
  // screen the GM is on, and navigation for a clicked pop-up.
  const location = useLocation()
  const navigate = useNavigate()
  const names = useRef<Record<string, string>>({})
  const path = useRef(location.pathname)
  const go = useRef(navigate)
  useEffect(() => {
    names.current = Object.fromEntries(docs.map((d) => [d.id, d.name]))
  }, [docs])
  useEffect(() => {
    path.current = location.pathname
    go.current = navigate
  }, [location.pathname, navigate])

  // Browsers only play sound after a click on the page; unlock it on the first.
  useEffect(() => {
    if (!isGM) return
    window.addEventListener('pointerdown', primeChime, { once: true })
    return () => window.removeEventListener('pointerdown', primeChime)
  }, [isGM])

  // Per game: live counts of everything waiting, and an alert for anything
  // that arrives after the first load.
  const idsKey = docs.map((d) => d.id).sort().join(',')
  useEffect(() => {
    if (!idsKey) return
    const unsubs: (() => void)[] = []
    for (const id of idsKey.split(',')) {
      const alert = (itemId: string, text: string) => {
        playChime()
        const watching = path.current === `/gm/${id}` && document.visibilityState === 'visible'
        if (!watching) {
          showPopup(names.current[id] || APP_TITLE, text, `${id}:${itemId}`, () => go.current(`/gm/${id}`))
        }
      }
      const watch = (
        q: Query,
        field: keyof Counts,
        describe: ((data: DocumentData) => string | Promise<string>) | null,
        keep: (data: DocumentData) => boolean = () => true
      ) => {
        let loaded = false
        unsubs.push(onSnapshot(
          q,
          (snap) => {
            const n = snap.docs.filter((d) => keep(d.data())).length
            setCounts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? NO_COUNTS), [field]: n } }))
            if (loaded && describe) {
              for (const change of snap.docChanges()) {
                if (change.type !== 'added' || !keep(change.doc.data())) continue
                Promise.resolve(describe(change.doc.data())).then((text) => alert(change.doc.id, text))
              }
            }
            loaded = true
          },
          (err) => console.warn('Running game counts failed:', id, field, err)
        ))
      }

      watch(
        query(collection(db, 'submissions'), where('game_id', '==', id), where('status', '==', 'pending')),
        'subs',
        async (d) => `${await teamName(id, d.team_id)} sent a challenge to review`
      )
      watch(
        query(collection(db, 'side_quest_submissions'), where('game_id', '==', id), where('status', '==', 'pending')),
        'sideQuests',
        (d) => `${d.submitter_name || 'A player'} sent a side quest photo to review`
      )
      watch(
        query(collection(db, 'games', id, 'join_requests'), where('status', '==', 'pending')),
        'joins',
        (d) => `${d.name || 'A player'} asked to join`
      )
      watch(
        query(collection(db, 'games', id, 'messages'), where('channel_type', '==', 'team_to_gm')),
        'messages',
        (d) => `${d.from_name || 'A player'}: ${clip(d.text)}`,
        (d) => !(d.read_by ?? []).includes(uid)
      )
      watch(collection(db, 'games', id, 'players'), 'players', null)
    }
    return () => unsubs.forEach((u) => u())
  }, [idsKey, uid])

  const games = useMemo(
    () =>
      (isGM ? docs : [])
        .map((d) => {
          const c = counts[d.id] ?? NO_COUNTS
          return {
            ...d,
            pendingSubmissions: c.subs,
            pendingSideQuests: c.sideQuests,
            pendingJoins: c.joins,
            unreadMessages: c.messages,
            players: c.players,
          }
        })
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)),
    [isGM, docs, counts]
  )

  // "(4) Foray" in the browser tab while anything is waiting, in any game.
  const totalWaiting = games.reduce((n, g) => n + waitingCount(g), 0)
  useEffect(() => {
    document.title = totalWaiting > 0 ? `(${totalWaiting}) ${APP_TITLE}` : APP_TITLE
  }, [totalWaiting])
  useEffect(() => () => { document.title = APP_TITLE }, [])

  // Timed events (milestone messages, zone schedules, lockouts) for every one
  // of these games, from whatever screen is open.
  useGameTimers(games, isGM ? uid : undefined)

  return <RunningGamesContext.Provider value={games}>{children}</RunningGamesContext.Provider>
}
