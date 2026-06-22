// =============================================================================
// Zone Rush — Chat System (Sprint 2)
//
// Channel types:
//  - team_internal: Player → their team room. Teammates + GM can see.
//                   GM is NOT pinged. This is normal team chatter.
//  - team_to_gm:    Player → GM (flagged). Appears in the team room AND
//                   in the GM's attention queue. This is the "Message GM" path.
//  - gm_to_team:    GM replies to a specific team (only that team sees it)
//  - gm_broadcast:  GM sends to ALL teams simultaneously
//
// Messages live at: /games/{gameId}/messages/{messageId}
// =============================================================================

import {
  collection, addDoc, query, where, orderBy,
  onSnapshot, updateDoc, doc, serverTimestamp,
  getDocs,
} from 'firebase/firestore'
import { db } from './firebase'
import type { Message } from '../types/game'

// ─── Send Messages ────────────────────────────────────────────────────────────

/**
 * Player sends a message to their team room.
 *
 * @param toGM - When true, the message is flagged for the GM:
 *               channel_type 'team_to_gm', which surfaces in the GM's
 *               attention queue. When false (default), it's 'team_internal'
 *               — normal team chatter the GM can see but isn't pinged about.
 */
export async function sendTeamMessage(
  gameId: string,
  fromUid: string,
  fromName: string,
  teamId: string,
  text: string,
  toGM: boolean = false
): Promise<void> {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  await addDoc(messagesRef, {
    channel_type: toGM ? 'team_to_gm' : 'team_internal',
    from_uid: fromUid,
    from_name: fromName,
    team_id: teamId,
    text: text.trim(),
    sent_at: serverTimestamp(),
    read_by: [fromUid], // sender has "read" their own message
  })
}

/**
 * GM sends a reply to a specific team.
 * Only that team will see it.
 */
export async function sendGMReply(
  gameId: string,
  gmUid: string,
  gmName: string,
  teamId: string,
  text: string
): Promise<void> {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  await addDoc(messagesRef, {
    channel_type: 'gm_to_team',
    from_uid: gmUid,
    from_name: gmName,
    team_id: teamId,
    text: text.trim(),
    sent_at: serverTimestamp(),
    read_by: [gmUid],
  })
}

/**
 * GM sends a broadcast to ALL teams.
 * Every player sees this in their chat feed with a distinct style.
 */
export async function sendGMBroadcast(
  gameId: string,
  gmUid: string,
  gmName: string,
  text: string
): Promise<void> {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  await addDoc(messagesRef, {
    channel_type: 'gm_broadcast',
    from_uid: gmUid,
    from_name: gmName,
    team_id: null, // null = visible to all
    text: text.trim(),
    sent_at: serverTimestamp(),
    read_by: [gmUid],
  })
}

// ─── Subscribe to Messages ────────────────────────────────────────────────────

/**
 * Subscribe to messages for a PLAYER (team member).
 * They see:
 *  - Their team's internal chatter (team_internal, their team_id)
 *  - Messages their team flagged to the GM (team_to_gm, their team_id)
 *  - GM replies to their team (gm_to_team, their team_id)
 *  - All GM broadcasts (gm_broadcast)
 *
 * @returns Unsubscribe function — call on component unmount
 */
export function subscribeToPlayerMessages(
  gameId: string,
  teamId: string,
  onMessages: (messages: Message[]) => void
): () => void {
  const messagesRef = collection(db, 'games', gameId, 'messages')

  // Firestore can't OR across fields, so we fetch ordered and filter client-side.
  const q = query(messagesRef, orderBy('sent_at', 'asc'))

  return onSnapshot(q, (snap) => {
    const messages: Message[] = []
    snap.forEach((d) => {
      const msg = { id: d.id, ...d.data() } as Message
      if (
        msg.channel_type === 'gm_broadcast' ||
        ((msg.channel_type === 'team_internal' ||
          msg.channel_type === 'team_to_gm' ||
          msg.channel_type === 'gm_to_team') &&
          msg.team_id === teamId)
      ) {
        messages.push(msg)
      }
    })
    onMessages(messages)
  })
}

/**
 * Subscribe to messages for the GM.
 * They see ALL messages across all teams.
 *
 * @param teamFilter - Optional team ID to filter to one team's conversation
 * @returns Unsubscribe function
 */
export function subscribeToGMMessages(
  gameId: string,
  onMessages: (messages: Message[]) => void,
  teamFilter?: string | null
): () => void {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const q = query(messagesRef, orderBy('sent_at', 'asc'))

  return onSnapshot(q, (snap) => {
    const messages: Message[] = []
    snap.forEach((d) => {
      const msg = { id: d.id, ...d.data() } as Message
      if (teamFilter) {
        if (msg.channel_type === 'gm_broadcast' || msg.team_id === teamFilter) {
          messages.push(msg)
        }
      } else {
        messages.push(msg)
      }
    })
    onMessages(messages)
  })
}

/**
 * Subscribe to the GM's ATTENTION QUEUE for this game.
 * Returns only flagged player messages (team_to_gm) that the GM
 * hasn't read yet, oldest first — the running list of "someone needs me."
 *
 * Note: we intentionally do NOT use orderBy in the Firestore query, so this
 * needs no composite index. We sort by sent_at in code instead.
 *
 * @returns Unsubscribe function
 */
export function subscribeToGMAttentionQueue(
  gameId: string,
  gmUid: string,
  onQueue: (messages: Message[]) => void
): () => void {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const q = query(
    messagesRef,
    where('channel_type', '==', 'team_to_gm')
  )

  return onSnapshot(q, (snap) => {
    const queue: Message[] = []
    snap.forEach((d) => {
      const msg = { id: d.id, ...d.data() } as Message
      if (!msg.read_by?.includes(gmUid)) queue.push(msg)
    })
    // Sort oldest-first in code (no Firestore index needed).
    queue.sort((a, b) => {
      const ta = (a.sent_at as any)?.toMillis?.() ?? 0
      const tb = (b.sent_at as any)?.toMillis?.() ?? 0
      return ta - tb
    })
    onQueue(queue)
  })
}

// ─── Mark Messages as Read ────────────────────────────────────────────────────

/**
 * Mark all messages relevant to this user in a team's conversation as read.
 */
export async function markMessagesRead(
  gameId: string,
  uid: string,
  teamId?: string
): Promise<void> {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const snap = await getDocs(query(messagesRef, orderBy('sent_at', 'asc')))

  const updatePromises: Promise<void>[] = []

  snap.forEach((d) => {
    const msg = { id: d.id, ...d.data() } as Message

    const isRelevant =
      msg.channel_type === 'gm_broadcast' ||
      (!!teamId && msg.team_id === teamId)

    if (isRelevant && !msg.read_by?.includes(uid)) {
      const msgRef = doc(db, 'games', gameId, 'messages', d.id)
      updatePromises.push(
        updateDoc(msgRef, { read_by: [...(msg.read_by ?? []), uid] })
      )
    }
  })

  await Promise.all(updatePromises)
}

// ─── Unread Count ─────────────────────────────────────────────────────────────

/**
 * Count unread messages for a player — used for the Chat tab badge.
 * Counts GM replies to their team, broadcasts, and unseen teammate chatter
 * (not their own messages).
 */
export function subscribeToUnreadCount(
  gameId: string,
  uid: string,
  teamId: string,
  onCount: (count: number) => void
): () => void {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const q = query(messagesRef, orderBy('sent_at', 'asc'))

  return onSnapshot(q, (snap) => {
    let count = 0
    snap.forEach((d) => {
      const msg = { id: d.id, ...d.data() } as Message
      const isRelevant =
        msg.channel_type === 'gm_broadcast' ||
        (msg.channel_type === 'gm_to_team' && msg.team_id === teamId) ||
        // a teammate's message the player hasn't seen
        (msg.channel_type === 'team_internal' && msg.team_id === teamId)
      if (isRelevant && !msg.read_by?.includes(uid)) count++
    })
    onCount(count)
  })
}

/**
 * Count unread FLAGGED messages for the GM — the attention-queue badge.
 * Only counts team_to_gm (flagged), never normal team_internal chatter.
 */
export function subscribeToGMUnreadCount(
  gameId: string,
  gmUid: string,
  onCount: (count: number) => void
): () => void {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const q = query(messagesRef, where('channel_type', '==', 'team_to_gm'))

  return onSnapshot(q, (snap) => {
    let count = 0
    snap.forEach((d) => {
      const msg = d.data() as Message
      if (!msg.read_by?.includes(gmUid)) count++
    })
    onCount(count)
  })
}