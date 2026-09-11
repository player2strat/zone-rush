// =============================================================================
// Foray — Side Quest panel (player view)
//
// Shown on the game home tab when the game has side quests. Each quest shows
// the team's running tally of APPROVED submissions (plus pending count), a
// live leaderboard of every team's approved count (side quests are the one
// place teams can see each other's progress mid-game), and a photo submit
// button. Submissions are unlimited, reviewed by the GM like challenge proof,
// and worth 0 points — the payoff is the post-game bonus for the team with
// the most approvals. Other teams' PENDING counts stay private: they're
// unverified, and showing them would just invite spam.
//
// Docs go to the top-level `side_quest_submissions` collection (separate from
// challenge submissions) so photo/submitter/GPS can be exported for partners.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import {
  collection, addDoc, onSnapshot, query, where, serverTimestamp,
} from 'firebase/firestore'
import { ref, uploadBytes, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { compressImage } from '../lib/imageCompress'
import { db, storage } from '../lib/firebase'
import type { SideQuest } from '../types/game'

interface SideQuestPanelProps {
  gameId: string
  teamId: string
  uid: string
  submitterName: string
  quests: SideQuest[]
  teams: { id: string; name: string; color: string }[]   // every team, for the leaderboard
  gameActive: boolean            // submissions allowed only while the game runs
  location: { lat: number | null; lng: number | null }
}

interface QuestTally {
  approved: number               // this team's approved count
  pending: number                // this team's pending count
  approvedByTeam: Map<string, number>   // every team's approved count
}

const emptyTally = (): QuestTally => ({ approved: 0, pending: 0, approvedByTeam: new Map() })

// Storage path for one submission (module scope: Date.now stays out of render).
function uploadPath(gameId: string, teamId: string, questId: string, ext: string): string {
  // Lives under submissions/ (same prefix as challenge proof) so the Storage
  // rules that already allow player uploads there cover side quests too — a
  // separate side_quests/ prefix needed its own rule and was rejected.
  return `submissions/${gameId}/${teamId}/sidequest_${questId}_${Date.now()}.${ext}`
}

/**
 * Upload a file and return its download URL. Small files go up in a single
 * request (uploadBytes) — the resumable protocol costs an extra session
 * handshake plus one round trip per 256 KB chunk, which is most of the
 * "stuck at 0%" wait on a weak signal. Larger files keep resumable uploads
 * so a dropped connection can pick up where it left off, with progress.
 */
export const SINGLE_REQUEST_MAX_BYTES = 2 * 1024 * 1024

export async function uploadWithProgress(
  storageRef: ReturnType<typeof ref>,
  file: Blob,
  onProgress: (pct: number) => void,
): Promise<string> {
  if (file.size <= SINGLE_REQUEST_MAX_BYTES) {
    const snap = await uploadBytes(storageRef, file)
    onProgress(100)
    return getDownloadURL(snap.ref)
  }
  const task = uploadBytesResumable(storageRef, file)
  await new Promise<void>((resolve, reject) => {
    task.on(
      'state_changed',
      (snap) => onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      () => resolve(),
    )
  })
  return getDownloadURL(task.snapshot.ref)
}

export default function SideQuestPanel({
  gameId, teamId, uid, submitterName, quests, teams, gameActive, location,
}: SideQuestPanelProps) {
  const [tallies, setTallies] = useState<Map<string, QuestTally>>(new Map())
  const [uploadingQuest, setUploadingQuest] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState('')
  const fileInputs = useRef<Map<string, HTMLInputElement | null>>(new Map())

  // Live tally of the whole game's submissions per quest. Approved counts are
  // kept for every team (leaderboard); pending only for our own team.
  useEffect(() => {
    const q = query(
      collection(db, 'side_quest_submissions'),
      where('game_id', '==', gameId),
    )
    const unsub = onSnapshot(q, (snap) => {
      const next = new Map<string, QuestTally>()
      snap.forEach((d) => {
        const data = d.data()
        const t = next.get(data.quest_id) ?? emptyTally()
        if (data.status === 'approved') {
          t.approvedByTeam.set(data.team_id, (t.approvedByTeam.get(data.team_id) ?? 0) + 1)
          if (data.team_id === teamId) t.approved++
        } else if (data.status === 'pending' && data.team_id === teamId) {
          t.pending++
        }
        next.set(data.quest_id, t)
      })
      setTallies(next)
    })
    return unsub
  }, [gameId, teamId])

  const handleFile = async (quest: SideQuest, file: File | null) => {
    if (!file || uploadingQuest) return
    if (!file.type.startsWith('image/')) {
      setError('Side quests are photo-only.')
      return
    }
    setUploadingQuest(quest.id)
    setUploadProgress(0)
    setError('')
    let step = 'preparing the photo'
    try {
      const upload = await compressImage(file)
      const ext = upload.name.split('.').pop() || 'jpg'
      const storageRef = ref(storage, uploadPath(gameId, teamId, quest.id, ext))
      step = 'uploading the photo'
      const url = await uploadWithProgress(storageRef, upload, setUploadProgress)
      step = 'saving the submission'
      await addDoc(collection(db, 'side_quest_submissions'), {
        game_id: gameId,
        quest_id: quest.id,
        quest_title: quest.title,
        team_id: teamId,
        submitted_by: uid,
        submitter_name: submitterName,
        media_url: url,
        gps_lat: location.lat,
        gps_lng: location.lng,
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        submitted_at: serverTimestamp(),
      })
    } catch (err) {
      console.error('Side quest submission failed while ' + step + ':', err)
      setError(`Couldn't submit — failed while ${step}. ${(err as Error).message}`)
    }
    setUploadingQuest(null)
  }

  if (quests.length === 0) return null

  return (
    <div style={{
      background: 'rgba(var(--pink-rgb), 0.05)',
      border: '1px solid rgba(var(--pink-rgb), 0.25)',
      borderRadius: 14,
      padding: '18px 18px 14px',
      marginBottom: 20,
    }}>
      <p style={{
        fontSize: '0.72rem', color: 'var(--pink)', textTransform: 'uppercase',
        letterSpacing: 1.5, fontWeight: 700, margin: '0 0 4px',
      }}>
        🧩 Side Quests
      </p>
      <p style={{ color: 'var(--ink-muted)', fontSize: '0.78rem', margin: '0 0 14px', lineHeight: 1.5 }}>
        Submit as many as you spot — the team with the most approved wins a
        bonus at the end. How much? That's revealed after the game.
      </p>

      {quests.map((quest) => {
        const tally = tallies.get(quest.id) ?? emptyTally()
        const uploading = uploadingQuest === quest.id
        // Leaderboard: every team, most approved first, ties by name. The
        // leader(s) get a crown; our own row is highlighted.
        const board = teams
          .map((t) => ({ ...t, approved: tally.approvedByTeam.get(t.id) ?? 0 }))
          .sort((a, b) => b.approved - a.approved || a.name.localeCompare(b.name))
        const topCount = board[0]?.approved ?? 0
        return (
          <div key={quest.id} style={{
            borderTop: '1px solid rgba(var(--pink-rgb), 0.15)',
            padding: '12px 0',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, color: 'var(--ink-soft)', fontWeight: 700, fontSize: '0.9rem' }}>
                  {quest.title}
                </p>
                <p style={{ margin: '3px 0 0', color: 'var(--ink-muted)', fontSize: '0.8rem', lineHeight: 1.45 }}>
                  {quest.description}
                </p>
                <p style={{ margin: '6px 0 0', fontSize: '0.78rem' }}>
                  <span style={{ color: 'var(--green)', fontWeight: 700 }}>
                    {tally.approved} approved
                  </span>
                  {tally.pending > 0 && (
                    <span style={{ color: 'var(--marigold-deep)' }}> · {tally.pending} pending</span>
                  )}
                </p>
              </div>

              <div style={{ flexShrink: 0 }}>
                <input
                  ref={(el) => { fileInputs.current.set(quest.id, el) }}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    handleFile(quest, e.target.files?.[0] ?? null)
                    e.target.value = ''
                  }}
                />
                <button
                  onClick={() => fileInputs.current.get(quest.id)?.click()}
                  disabled={uploading || !gameActive}
                  style={{
                    background: gameActive ? 'rgba(var(--pink-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.03)',
                    border: `1px solid ${gameActive ? 'rgba(var(--pink-rgb), 0.4)' : 'var(--line)'}`,
                    color: gameActive ? 'var(--pink)' : 'var(--ink-ghost)',
                    borderRadius: 8,
                    padding: '9px 14px',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: uploading || !gameActive ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {uploading ? (uploadProgress > 0 ? `${uploadProgress}%…` : 'Uploading…') : '📸 Submit'}
                </button>
              </div>
            </div>

            {/* All-team leaderboard — approved counts only */}
            {board.length > 1 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {board.map((t) => {
                  const mine = t.id === teamId
                  const leading = topCount > 0 && t.approved === topCount
                  return (
                    <div key={t.id} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '4px 9px', borderRadius: 999,
                      background: mine ? `${t.color}20` : 'rgba(var(--ink-rgb), 0.03)',
                      border: `1px solid ${mine ? t.color + '70' : 'var(--line)'}`,
                      fontSize: '0.74rem',
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }} />
                      <span style={{ color: 'var(--ink-soft)', fontWeight: mine ? 800 : 600, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.name}
                      </span>
                      <span style={{ fontFamily: "'Martian Mono', monospace", fontWeight: 800, color: t.color }}>
                        {t.approved}
                      </span>
                      {leading && <span style={{ fontSize: '0.7rem' }}>👑</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {error && (
        <p style={{
          color: 'var(--red)', fontSize: '0.8rem', margin: '10px 0 0',
          padding: '8px 12px', background: 'rgba(var(--red-rgb), 0.08)', borderRadius: 8,
        }}>
          {error}
        </p>
      )}
    </div>
  )
}
