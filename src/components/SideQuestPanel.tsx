// =============================================================================
// Foray — Side Quest panel (player view)
//
// Shown on the game home tab when the game has side quests. Each quest shows
// the team's running tally of APPROVED submissions (plus pending count) and a
// photo submit button. Submissions are unlimited, reviewed by the GM like
// challenge proof, and worth 0 points — the payoff is the post-game bonus for
// the team with the most approvals.
//
// Docs go to the top-level `side_quest_submissions` collection (separate from
// challenge submissions) so photo/submitter/GPS can be exported for partners.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import {
  collection, addDoc, onSnapshot, query, where, serverTimestamp,
} from 'firebase/firestore'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { compressImage } from '../lib/imageCompress'
import { db, storage } from '../lib/firebase'
import type { SideQuest } from '../types/game'

interface SideQuestPanelProps {
  gameId: string
  teamId: string
  uid: string
  submitterName: string
  quests: SideQuest[]
  gameActive: boolean            // submissions allowed only while the game runs
  location: { lat: number | null; lng: number | null }
}

interface QuestTally {
  approved: number
  pending: number
}

// Storage path for one submission (module scope: Date.now stays out of render).
function uploadPath(gameId: string, teamId: string, questId: string, ext: string): string {
  return `side_quests/${gameId}/${teamId}/${questId}_${Date.now()}.${ext}`
}

export default function SideQuestPanel({
  gameId, teamId, uid, submitterName, quests, gameActive, location,
}: SideQuestPanelProps) {
  const [tallies, setTallies] = useState<Map<string, QuestTally>>(new Map())
  const [uploadingQuest, setUploadingQuest] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState('')
  const fileInputs = useRef<Map<string, HTMLInputElement | null>>(new Map())

  // Live tally of this team's submissions per quest.
  useEffect(() => {
    const q = query(
      collection(db, 'side_quest_submissions'),
      where('game_id', '==', gameId),
      where('team_id', '==', teamId),
    )
    const unsub = onSnapshot(q, (snap) => {
      const next = new Map<string, QuestTally>()
      snap.forEach((d) => {
        const data = d.data()
        const t = next.get(data.quest_id) ?? { approved: 0, pending: 0 }
        if (data.status === 'approved') t.approved++
        else if (data.status === 'pending') t.pending++
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
    try {
      const upload = await compressImage(file)
      const ext = upload.name.split('.').pop() || 'jpg'
      const task = uploadBytesResumable(ref(storage, uploadPath(gameId, teamId, quest.id, ext)), upload)
      const url: string = await new Promise((resolve, reject) => {
        task.on(
          'state_changed',
          (snap) => setUploadProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
          reject,
          async () => resolve(await getDownloadURL(task.snapshot.ref)),
        )
      })
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
      setError('Upload failed: ' + (err as Error).message)
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
        Submit as many as you spot — the team with the most approved wins bonus
        points at the end. No points during the game.
      </p>

      {quests.map((quest) => {
        const tally = tallies.get(quest.id) ?? { approved: 0, pending: 0 }
        const uploading = uploadingQuest === quest.id
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
                    <span style={{ color: 'var(--marigold)' }}> · {tally.pending} pending</span>
                  )}
                  <span style={{ color: 'var(--ink-faint)' }}> · +{quest.bonus_points}pt bonus for most</span>
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
                  {uploading ? `${uploadProgress}%…` : '📸 Submit'}
                </button>
              </div>
            </div>
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
