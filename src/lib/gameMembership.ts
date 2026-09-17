// =============================================================================
// Foray — game membership roster (games/{id}.player_uids)
//
// A flat list of every player account in a game, kept alongside the team
// rosters. Security rules use it to answer "is this user in this game?" —
// which team docs alone can't answer for a cross-team read like the side
// quest leaderboard. Players may only ever add THEMSELVES (enforced by the
// rules); the GM can add anyone. Idempotent, and never blocks gameplay.
// =============================================================================

import { doc, updateDoc, arrayUnion } from 'firebase/firestore'
import { db } from './firebase'

export async function registerInGame(gameId: string, uid: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'games', gameId), { player_uids: arrayUnion(uid) })
  } catch (err) {
    // Non-critical: the GM path or the next page load will retry.
    console.warn('Could not register player in game roster:', err)
  }
}
