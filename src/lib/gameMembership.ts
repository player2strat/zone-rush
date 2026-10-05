// =============================================================================
// Foray — game roster and join codes
//
// games/{gameId}/players/{uid} — one doc per player account in a game. It is
// the ticket the security rules check before letting anyone see a game (its
// teams, scores, chat and photos). A player gets one by entering the game's
// join code while the game is in the lobby; the GM adds late joiners when
// approving them. Leaving the lobby, or being removed by the GM, deletes it.
//
// join_codes/{code} — maps a 6-character code to its game id. Anyone signed in
// may look up ONE code, but nobody can list them, so knowing the code is what
// proves you were invited.
// =============================================================================

import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, serverTimestamp, writeBatch,
  type WriteBatch,
} from 'firebase/firestore'
import { db } from './firebase'

export function rosterRef(gameId: string, uid: string) {
  return doc(db, 'games', gameId, 'players', uid)
}

export function joinCodeRef(code: string) {
  return doc(db, 'join_codes', code)
}

/** True when Firestore refused a read or write because of the security rules. */
export function isPermissionDenied(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'permission-denied'
}

/** The game id a join code points at, or null if no game uses it. */
export async function findGameByCode(code: string): Promise<string | null> {
  const snap = await getDoc(joinCodeRef(code))
  return snap.exists() ? (snap.data().game_id as string) : null
}

/**
 * Put yourself on a lobby game's roster by proving you know its join code.
 * Returns false when the rules refuse — the game has already started or ended.
 */
export async function joinWithCode(gameId: string, uid: string, code: string): Promise<boolean> {
  try {
    await setDoc(rosterRef(gameId, uid), {
      uid,
      via: 'code',
      join_code: code,
      joined_at: serverTimestamp(),
    })
    return true
  } catch (err) {
    if (isPermissionDenied(err)) return false
    throw err
  }
}

/** GM: add a player to the roster on the caller's batch (late-join approval). */
export function addToRosterInBatch(batch: WriteBatch, gameId: string, uid: string): void {
  batch.set(rosterRef(gameId, uid), { uid, via: 'gm', joined_at: serverTimestamp() })
}

/** Remove a roster entry (player left the lobby, or the GM removed them). */
export async function removeFromRoster(gameId: string, uid: string): Promise<void> {
  try {
    await deleteDoc(rosterRef(gameId, uid))
  } catch (err) {
    console.warn('Could not remove player from game roster:', err)
  }
}

/**
 * One-time migration (admin, from /admin/seed-maps): put every existing team
 * member on their game's roster, and give every game that isn't over a
 * join_codes entry. Games created before the roster existed need this, or
 * their players can't open them. Safe to run more than once.
 */
export async function backfillRostersAndCodes(
  log: (msg: string) => void,
): Promise<void> {
  const games = await getDocs(collection(db, 'games'))
  let players = 0
  let codes = 0
  for (const g of games.docs) {
    const game = g.data()
    const teams = await getDocs(collection(db, 'games', g.id, 'teams'))
    const uids = new Set<string>()
    teams.forEach((t) => {
      for (const uid of (t.data().members ?? []) as string[]) {
        if (!uid.startsWith('test_')) uids.add(uid)   // test-mode fake players
      }
    })
    const batch = writeBatch(db)
    uids.forEach((uid) => {
      batch.set(rosterRef(g.id, uid), { uid, via: 'backfill', joined_at: serverTimestamp() }, { merge: true })
    })
    let newCode = false
    if (game.status !== 'ended' && game.join_code) {
      const existing = await getDoc(joinCodeRef(game.join_code))
      if (!existing.exists()) {
        batch.set(joinCodeRef(game.join_code), { game_id: g.id, created_at: serverTimestamp() })
        newCode = true
      } else if (existing.data().game_id !== g.id) {
        log(`  \u26a0 ${game.name || g.id}: code ${game.join_code} is already used by another game`)
      }
    }
    try {
      await batch.commit()
      players += uids.size
      if (newCode) codes++
      log(`  \u2713 ${game.name || g.id}: ${uids.size} player(s)${newCode ? ', join code saved' : ''}`)
    } catch (err) {
      log(`  \u2717 ${game.name || g.id} \u2014 ${(err as Error).message}`)
    }
  }
  log(`Rosters: ${players} player entries across ${games.size} games; ${codes} join code(s) saved.`)
}
