// =============================================================================
// Zone Rush — Chat System (Sprint 1)
//
// Three channel types:
//  - team_to_gm:   Player sends a message to the GM
//  - gm_to_team:   GM replies to a specific team (only that team sees it)
//  - gm_broadcast: GM sends to ALL teams simultaneously
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
 * Player sends a message to the GM.
 */
export async function sendTeamMessage(
  gameId: string,
  fromUid: string,
  fromName: string,
  teamId: string,
  text: string
): Promise<void> {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  await addDoc(messagesRef, {
    channel_type: 'team_to_gm',
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
 *  - Messages their team sent to the GM (team_to_gm, their team_id)
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

  // Query for messages relevant to this team
  // (Firestore doesn't support OR queries directly, so we fetch all and filter client-side)
  const q = query(
    messagesRef,
    orderBy('sent_at', 'asc')
  )

  return onSnapshot(q, (snap) => {
    const messages: Message[] = []
    snap.forEach((d) => {
      const msg = { id: d.id, ...d.data() } as Message
      // Include if: broadcast, OR this team's conversation with GM
      if (
        msg.channel_type === 'gm_broadcast' ||
        (msg.channel_type === 'team_to_gm' && msg.team_id === teamId) ||
        (msg.channel_type === 'gm_to_team' && msg.team_id === teamId)
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
        // Filtered view: show this team's messages + broadcasts
        if (
          msg.channel_type === 'gm_broadcast' ||
          msg.team_id === teamFilter
        ) {
          messages.push(msg)
        }
      } else {
        // All messages view (GM overview)
        messages.push(msg)
      }
    })
    onMessages(messages)
  })
}

// ─── Mark Messages as Read ────────────────────────────────────────────────────

/**
 * Mark all unread messages in a conversation as read by this user.
 * Updates the read_by array on each unread message.
 */
export async function markMessagesRead(
  gameId: string,
  uid: string,
  teamId?: string
): Promise<void> {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const q = query(messagesRef, orderBy('sent_at', 'asc'))
  const snap = await getDocs(q)

  const updatePromises: Promise<void>[] = []

  snap.forEach((d) => {
    const msg = { id: d.id, ...d.data() } as Message

    // Only mark messages relevant to this user
    const isRelevant =
      msg.channel_type === 'gm_broadcast' ||
      (teamId && msg.team_id === teamId)

    if (isRelevant && !msg.read_by?.includes(uid)) {
      const msgRef = doc(db, 'games', gameId, 'messages', d.id)
      updatePromises.push(
        updateDoc(msgRef, {
          read_by: [...(msg.read_by ?? []), uid],
        })
      )
    }
  })

  await Promise.all(updatePromises)
}

// ─── Unread Count ─────────────────────────────────────────────────────────────

/**
 * Count unread messages for a player — used for the Chat tab badge.
 * Returns a real-time subscription (returns unsubscribe function).
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
        (msg.channel_type === 'gm_to_team' && msg.team_id === teamId)

      if (isRelevant && !msg.read_by?.includes(uid)) {
        count++
      }
    })
    onCount(count)
  })
}

/**
 * Count unread messages for the GM — total unread from all teams.
 */
export function subscribeToGMUnreadCount(
  gameId: string,
  gmUid: string,
  onCount: (count: number) => void
): () => void {
  const messagesRef = collection(db, 'games', gameId, 'messages')
  const q = query(
    messagesRef,
    where('channel_type', '==', 'team_to_gm')
  )

  return onSnapshot(q, (snap) => {
    let count = 0
    snap.forEach((d) => {
      const msg = d.data() as Message
      if (!msg.read_by?.includes(gmUid)) count++
    })
    onCount(count)
  })
}