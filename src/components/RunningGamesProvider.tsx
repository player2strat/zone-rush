// =============================================================================
// Foray — RunningGamesProvider
//
// One live feed of the signed-in GM's running games (hooks/useRunningGames),
// plus ended ones not yet wrapped up, with team standings and what each one is
// waiting on. Mounted once in App, for GMs and admins only. From here:
//  - the home screen shows a summary card for each game, and the scoreboard
//    strip (components/GameStrip) runs across the top of each game's screens;
//  - anything new (a submission, side quest photo, join request or "Message
//    GM" ping) plays a chime and shows a desktop pop-up (lib/gmAlerts), unless
//    the GM is already looking at that game;
//  - the browser tab title shows the total waiting, e.g. "(4) Foray";
//  - every game's timed events run, on whatever screen the GM has open.
// =============================================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  collection, onSnapshot, query, updateDoc, where,
  type DocumentData, type Query,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useUserRole } from '../hooks/useUserRole'
import { useGameTimers } from '../hooks/useGameTimers'
import { playChime, primeChime, showPopup } from '../lib/gmAlerts'
import { endedAt } from '../lib/runningGameFormat'
import {
  RunningGamesContext, RUNNING_STATUSES, waitingCount,
  type CardStatus, type RunningGame, type RunningTeam,
} from '../hooks/useRunningGames'

type Counts = {
  subs: number
  sideQuests: number
  joins: number
  messages: number
  players: number
}
type GameDoc = Omit<RunningGame,
  'pendingSubmissions' | 'pendingSideQuests' | 'pendingJoins' | 'unreadMessages' | 'players' | 'teams'>

const NO_COUNTS: Counts = { subs: 0, sideQuests: 0, joins: 0, messages: 0, players: 0 }
const APP_TITLE = 'Foray'

// Live games first, then ended games still to wrap up, then the ones still
// being set up.
const STATUS_ORDER: Record<CardStatus, number> = { active: 0, paused: 1, ended: 2, strategy: 3, lobby: 4 }

// An ended game that's never wrapped up (an abandoned test, say) leaves the
// list a day after its clock ran out. It's still in Past Forays, which opens
// its dashboard.
const WRAP_UP_WINDOW_MS = 24 * 60 * 60 * 1000

const clip = (text: unknown) => {
  const s = String(text ?? '').trim()
  return s.length > 100 ? s.slice(0, 99) + '…' : s
}

// A game's live listeners (see the provider). stopTimer is set while it's
// off the list and about to stop.
type GameWatch = { stop: () => void; stopTimer?: ReturnType<typeof setTimeout> }
const DROP_DELAY_MS = 5000

/**
 * Start one game's listeners: its teams (standings), and everything waiting
 * for the GM (submissions, side quest photos, join requests, unread "Message
 * GM" pings) plus its player count. onNew fires for items that arrive after
 * the first load. Returns a function that stops them all.
 */
function watchGame(
  id: string,
  uid: string,
  on: {
    onTeams: (list: RunningTeam[]) => void
    onCount: (field: keyof Counts, n: number) => void
    onNew: (itemId: string, text: string) => void
  }
): () => void {
  const unsubs: (() => void)[] = []
  const teamNames = new Map<string, string>()
  unsubs.push(onSnapshot(
    collection(db, 'games', id, 'teams'),
    (snap) => {
      const list = snap.docs
        .map((d) => {
          const t = d.data()
          teamNames.set(d.id, t.name)
          return { id: d.id, name: t.name || 'Team', color: t.color || 'var(--ink-faint)', points: t.total_points ?? 0 }
        })
        .sort((a, b) => b.points - a.points)
      on.onTeams(list)
    },
    (err) => console.warn('Running game teams failed:', id, err)
  ))

  const watch = (
    q: Query,
    field: keyof Counts,
    describe: ((data: DocumentData) => string) | null,
    keep: (data: DocumentData) => boolean = () => true
  ) => {
    let loaded = false
    unsubs.push(onSnapshot(
      q,
      (snap) => {
        on.onCount(field, snap.docs.filter((d) => keep(d.data())).length)
        if (loaded && describe) {
          for (const change of snap.docChanges()) {
            if (change.type !== 'added' || !keep(change.doc.data())) continue
            on.onNew(change.doc.id, describe(change.doc.data()))
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
    (d) => `${teamNames.get(d.team_id) || 'A team'} sent a challenge to review`
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

  return () => unsubs.forEach((u) => u())
}

export default function RunningGamesProvider({ uid, children }: { uid: string; children: ReactNode }) {
  const { role } = useUserRole()
  const isGM = role === 'admin' || role === 'gm'
  const [runningDocs, setRunningDocs] = useState<GameDoc[]>([])
  const [endedDocs, setEndedDocs] = useState<GameDoc[]>([])
  const [counts, setCounts] = useState<Record<string, Counts>>({})
  const [teams, setTeams] = useState<Record<string, RunningTeam[]>>({})
  const docs = useMemo(() => [...runningDocs, ...endedDocs], [runningDocs, endedDocs])

  useEffect(() => {
    if (!isGM) return
    const running = query(
      collection(db, 'games'),
      where('created_by', '==', uid),
      where('status', 'in', RUNNING_STATUSES)
    )
    // Ended but not wrapped up. Equality filters only, so no extra index.
    const ended = query(
      collection(db, 'games'),
      where('created_by', '==', uid),
      where('status', '==', 'ended'),
      where('wrapped_up', '==', false)
    )
    const unsubRunning = onSnapshot(
      running,
      (snap) => {
        setRunningDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() } as GameDoc)))
        // Games created before wrapped_up existed get it now, so they stay
        // listed after they end.
        snap.docs.forEach((d) => {
          if (d.data().wrapped_up === undefined) {
            updateDoc(d.ref, { wrapped_up: false }).catch((err) => console.warn('wrapped_up backfill failed:', err))
          }
        })
      },
      (err) => console.warn('Running games feed failed:', err)
    )
    const unsubEnded = onSnapshot(
      ended,
      (snap) => {
        const cutoff = Date.now() - WRAP_UP_WINDOW_MS
        setEndedDocs(snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as GameDoc))
          .filter((g) => (endedAt(g) ?? 0) >= cutoff))
      },
      (err) => console.warn('Ended games feed failed:', err)
    )
    return () => {
      unsubRunning()
      unsubEnded()
    }
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

  // Per game: team standings, live counts of everything waiting, and an alert
  // for anything that arrives after the first load.
  //
  // Each game's listeners start once and stay running while it's on the
  // list. A new game, or one moving from running to ended, only adds or drops
  // its own listeners; it never restarts every other game's. (Restarting them
  // all at once, the moment a game was created or started, could freeze
  // Firestore's live updates until a refresh.) A game that drops off the list
  // keeps its listeners a few seconds, so one that ends (it leaves the
  // running feed a moment before it joins the ended feed) carries straight on.
  const idsKey = docs.map((d) => d.id).sort().join(',')
  const watches = useRef(new Map<string, GameWatch>())
  useEffect(() => {
    const live = watches.current
    const wanted = new Set(idsKey ? idsKey.split(',') : [])
    for (const [id, w] of live) {
      if (wanted.has(id)) {
        if (w.stopTimer) {
          clearTimeout(w.stopTimer)
          w.stopTimer = undefined
        }
      } else if (!w.stopTimer) {
        w.stopTimer = setTimeout(() => {
          w.stop()
          live.delete(id)
        }, DROP_DELAY_MS)
      }
    }
    for (const id of wanted) {
      if (live.has(id)) continue
      live.set(id, {
        stop: watchGame(id, uid, {
          onTeams: (list) => setTeams((prev) => ({ ...prev, [id]: list })),
          onCount: (field, n) => setCounts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? NO_COUNTS), [field]: n } })),
          onNew: (itemId, text) => {
            playChime()
            const watching = path.current === `/gm/${id}` && document.visibilityState === 'visible'
            if (!watching) {
              showPopup(names.current[id] || APP_TITLE, text, `${id}:${itemId}`, () => go.current(`/gm/${id}`))
            }
          },
        }),
      })
    }
  }, [idsKey, uid])
  // Leaving (sign-out) or switching accounts stops them all; the effect above
  // then starts fresh ones for the new account.
  useEffect(() => {
    const live = watches.current
    return () => {
      live.forEach((w) => {
        clearTimeout(w.stopTimer)
        w.stop()
      })
      live.clear()
    }
  }, [uid])

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
            teams: teams[d.id] ?? [],
          }
        })
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)),
    [isGM, docs, counts, teams]
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
