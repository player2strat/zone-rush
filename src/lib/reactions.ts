// =============================================================================
// Foray — Live reactions during the results reveal
//
// Players tap one of a few reactions on the results page; every screen
// watching the reveal (players and the GM dashboard) sees it float up in the
// sender's team color. Docs live in games/{gameId}/reactions and are tiny.
//
// Swapping in the designer's icons: add the SVG/PNG under src/assets/
// reactions/, import it, and set `icon` on the matching entry below. Anything
// without an icon falls back to its emoji. Keep it to 4–6 entries so the
// picker fits a phone.
// =============================================================================

import {
  addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase'

export interface ReactionDef {
  key: string
  label: string        // accessible name / tooltip
  emoji: string        // placeholder until an icon is supplied
  icon?: string        // image URL (imported asset) — used instead of emoji when set
}

export const REACTIONS: ReactionDef[] = [
  { key: 'fire',  label: 'Hype',     emoji: '🔥' },
  { key: 'clap',  label: 'Applause', emoji: '👏' },
  { key: 'laugh', label: 'LOL',      emoji: '😂' },
  { key: 'shock', label: 'Whoa',     emoji: '😱' },
  { key: 'love',  label: 'Love',     emoji: '❤️' },
]

export function reactionByKey(key: string): ReactionDef | undefined {
  return REACTIONS.find((r) => r.key === key)
}

export interface Reaction {
  id: string
  key: string
  team_id: string
  team_name: string
  team_color: string
  uid: string
  created_at: { toMillis?: () => number } | null
}

/** Minimum gap between two reactions from one phone. Enforced client-side. */
export const REACTION_COOLDOWN_MS = 1200

/** Reactions older than this on first load are not replayed. */
const REPLAY_WINDOW_MS = 4000

export async function sendReaction(
  gameId: string,
  key: string,
  team: { id: string; name: string; color: string },
  uid: string,
): Promise<void> {
  await addDoc(collection(db, 'games', gameId, 'reactions'), {
    key,
    team_id: team.id,
    team_name: team.name,
    team_color: team.color,
    uid,
    created_at: serverTimestamp(),
  })
}

/**
 * Calls onNew once for every reaction that arrives after subscribing (plus
 * any from the last few seconds, so a late opener catches the tail of a
 * burst). Never replays the full history.
 */
export function subscribeToReactions(
  gameId: string,
  onNew: (r: Reaction) => void,
): () => void {
  const q = query(
    collection(db, 'games', gameId, 'reactions'),
    orderBy('created_at', 'desc'),
    limit(40),
  )
  let first = true
  return onSnapshot(q, (snap) => {
    const now = Date.now()
    for (const change of snap.docChanges()) {
      if (change.type !== 'added') continue
      const r = { id: change.doc.id, ...change.doc.data() } as Reaction
      // Local writes arrive first with a null server timestamp — those are
      // this phone's own taps and should float immediately.
      const ts = r.created_at?.toMillis?.() ?? now
      if (first && now - ts > REPLAY_WINDOW_MS) continue
      onNew(r)
    }
    first = false
  })
}
