// =============================================================================
// NEW FILE: src/components/SequentialCard.tsx
//
// Renders a sequential ("Choose Your Own Adventure") card inside the Hand tab.
// Owns the step-by-step reveal + lock flow, persists each locked choice to
// Firestore via lib/sequential (so locked = locked survives a refresh), then
// reveals the resolved final task and hands off to the EXISTING SubmitProof
// component for the photo/video/audio.
//
// Visually distinct from standard cards (purple CYOA accent + step rail) so
// players immediately know they're committing blind.
//
// This component does NOT do any scoring or submission writing itself beyond
// passing resolved_task + step_choices into SubmitProof. Standard cards never
// reach this component — GamePage routes by challenge_type.
// =============================================================================

import { useState, useEffect } from 'react'
import SubmitProof from './SubmitProof'
import {
  subscribeProgress, lockStep, markCompleted, interpolateFinalTask,
} from '../lib/sequential'
import type { SequentialProgress } from '../types/game'

const CYOA = '#9B5DE5' // purple accent, reused from the app palette

interface SequentialChallenge {
  id: string
  description: string
  difficulty: string
  points: number
  verification_type: string
  tier2: { description: string; bonus_points: number } | null
  phone_free_eligible: boolean
  is_time_based: boolean
  // sequential-specific
  challenge_type?: string
  steps?: string[]
  final_task?: string
}

interface Props {
  gameId: string
  teamId: string
  challenge: SequentialChallenge
  closedZones: string[]
  activeZoneIds: string[]   // game.zones — forwarded to SubmitProof for in-game zone detection
  gameEnded: boolean
  // submission status for THIS card, lifted from GamePage's submissions map
  submissionStatus?: 'pending' | 'approved' | 'rejected'
  gmNotes?: string
}

export default function SequentialCard({
  gameId, teamId, challenge, closedZones, activeZoneIds, gameEnded, submissionStatus, gmNotes,
}: Props) {
  const steps = challenge.steps ?? []
  const finalTask = challenge.final_task ?? ''

  const [progress, setProgress] = useState<SequentialProgress | null>(null)
  const [loadingProgress, setLoadingProgress] = useState(true)
  const [progressError, setProgressError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')          // current step's text input
  const [locking, setLocking] = useState(false)
  const [lockError, setLockError] = useState<string | null>(null)
  const [showSubmit, setShowSubmit] = useState(false)

  // Live progress — survives refresh, and stays in sync if a teammate locks a
  // step on their own device.
  useEffect(() => {
    const unsub = subscribeProgress(
      gameId, teamId, challenge.id,
      (p) => {
        setProgress(p)
        setLoadingProgress(false)
        setDraft('')
      },
      (err) => {
        setProgressError(err.message || 'Could not load progress.')
        setLoadingProgress(false)
      },
    )
    return () => unsub()
  }, [gameId, teamId, challenge.id])

  const lockedCount = progress?.locked_count ?? 0
  const choices = progress?.step_choices ?? []
  const allLocked = lockedCount >= steps.length
  const resolvedTask =
    progress?.resolved_task ?? (allLocked ? interpolateFinalTask(finalTask, choices) : null)

  const isApproved = submissionStatus === 'approved'
  const isPending = submissionStatus === 'pending'
  const isRejected = submissionStatus === 'rejected'

  const handleLock = async () => {
    if (!draft.trim() || locking) return
    setLocking(true)
    setLockError(null)
    try {
      await lockStep(gameId, teamId, challenge.id, lockedCount, draft, steps.length, finalTask)
      // progress updates via the listener; no local mutation needed
    } catch (err: any) {
      setLockError(err.message || 'Could not lock that choice.')
    } finally {
      setLocking(false)
    }
  }

  // Difficulty pill colour, matching the app's standard card styling
  const diffColor =
    challenge.difficulty === 'easy' ? '#06D6A0'
    : challenge.difficulty === 'hard' ? '#EF476F'
    : '#FFD166'
  const diffPts = challenge.points

  return (
    <div
      style={{
        background: isApproved ? 'rgba(6,214,160,0.03)' : `${CYOA}08`,
        border: `1px solid ${isApproved ? 'rgba(6,214,160,0.2)' : `${CYOA}40`}`,
        borderRadius: 12,
        padding: '16px 18px',
        opacity: isApproved ? 0.7 : 1,
      }}
    >
      {/* Header: CYOA badge + difficulty + status */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.66rem', fontWeight: 800, padding: '3px 10px', borderRadius: 20, background: `${CYOA}20`, color: CYOA, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            🎲 Choose Your Own Adventure
          </span>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: `${diffColor}22`, color: diffColor }}>
            {challenge.difficulty?.toUpperCase()} · {diffPts}pt{diffPts !== 1 ? 's' : ''}
          </span>
        </div>
        {submissionStatus && (
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: isApproved ? '#06D6A0' : isPending ? '#FFD166' : '#EF476F' }}>
            {isApproved ? '✅ Approved' : isPending ? '⏳ Pending' : '❌ Rejected'}
          </span>
        )}
      </div>

      {/* Card title / flavour */}
      <p style={{ color: '#e0e0e0', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 14 }}>
        {challenge.description || 'Lock in each choice below — you won\u2019t see how it\u2019s used until everything is locked.'}
      </p>

      {loadingProgress ? (
        <p style={{ color: '#555', fontSize: '0.82rem' }}>Loading your progress…</p>
      ) : progressError ? (
        <p style={{ color: '#EF476F', fontSize: '0.82rem' }}>⚠️ {progressError}</p>
      ) : (
        <>
          {/* Step rail — one row per step */}
          <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
            {steps.map((prompt, i) => {
              const locked = i < lockedCount
              const isCurrent = i === lockedCount && !allLocked
              const future = i > lockedCount

              return (
                <div
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 8,
                    background: locked ? 'rgba(6,214,160,0.06)' : isCurrent ? `${CYOA}12` : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${locked ? 'rgba(6,214,160,0.25)' : isCurrent ? `${CYOA}40` : '#1a1a1a'}`,
                    opacity: future ? 0.4 : 1,
                  }}
                >
                  <span style={{
                    width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 800,
                    background: locked ? '#06D6A0' : isCurrent ? CYOA : '#222',
                    color: locked || isCurrent ? '#0a0a0a' : '#555',
                  }}>
                    {locked ? '✓' : i + 1}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: '0.7rem', color: '#777', marginBottom: locked ? 2 : 0 }}>
                      Part {i + 1}: {prompt}
                    </p>
                    {locked && (
                      <p style={{ fontSize: '0.88rem', color: '#06D6A0', fontWeight: 700 }}>
                        {choices[i]} <span style={{ color: '#555', fontWeight: 400, fontSize: '0.7rem' }}>· locked</span>
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Current step input — only when not all locked and not already completed */}
          {!allLocked && !isApproved && (
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleLock() }}
                placeholder={steps[lockedCount]}
                disabled={locking}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: '#141414', border: `1px solid ${CYOA}40`,
                  borderRadius: 8, padding: '11px 14px', color: '#fff',
                  fontSize: '0.9rem', fontFamily: 'inherit', outline: 'none', marginBottom: 8,
                }}
              />
              <button
                onClick={handleLock}
                disabled={!draft.trim() || locking}
                style={{
                  width: '100%',
                  background: draft.trim() ? `${CYOA}20` : '#1a1a1a',
                  border: `1px solid ${draft.trim() ? `${CYOA}50` : '#222'}`,
                  color: draft.trim() ? CYOA : '#444',
                  padding: '11px', borderRadius: 8, fontSize: '0.88rem', fontWeight: 700,
                  cursor: draft.trim() && !locking ? 'pointer' : 'default', fontFamily: 'inherit',
                }}
              >
                {locking ? 'Locking…' : `🔒 Lock Part ${lockedCount + 1} (can\u2019t be changed)`}
              </button>
              <p style={{ fontSize: '0.68rem', color: '#666', textAlign: 'center', marginTop: 6, lineHeight: 1.4 }}>
                Once locked, this choice is final. You won\u2019t see the full challenge until every part is locked.
              </p>
              {lockError && (
                <p style={{ fontSize: '0.74rem', color: '#EF476F', textAlign: 'center', marginTop: 6 }}>{lockError}</p>
              )}
            </div>
          )}

          {/* Revealed final task + submit handoff */}
          {allLocked && resolvedTask && (
            <div style={{
              background: `${CYOA}10`, border: `1px solid ${CYOA}35`,
              borderRadius: 10, padding: '14px 16px', marginBottom: isApproved ? 0 : 12,
            }}>
              <p style={{ fontSize: '0.66rem', color: CYOA, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                🎯 Your Challenge
              </p>
              <p style={{ color: '#fff', fontSize: '0.95rem', lineHeight: 1.5, fontWeight: 600 }}>
                {resolvedTask}
              </p>
            </div>
          )}

          {/* GM rejection feedback */}
          {isRejected && gmNotes && (
            <div style={{ background: 'rgba(239,71,111,0.06)', border: '1px solid rgba(239,71,111,0.15)', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
              <p style={{ fontSize: '0.7rem', color: '#EF476F', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>GM Feedback</p>
              <p style={{ color: '#ccc', fontSize: '0.82rem', lineHeight: 1.5 }}>{gmNotes}</p>
            </div>
          )}

          {/* Submit / status button */}
          {allLocked && resolvedTask && !isApproved && (
            isPending ? (
              <div style={{ width: '100%', background: 'rgba(255,209,102,0.08)', border: '1px solid rgba(255,209,102,0.2)', padding: '12px', borderRadius: 8, textAlign: 'center', color: '#FFD166', fontSize: '0.88rem', fontWeight: 600 }}>
                ⏳ Waiting for GM review…
              </div>
            ) : gameEnded ? (
              <div style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid #222', padding: '12px', borderRadius: 8, textAlign: 'center', color: '#555', fontSize: '0.88rem' }}>
                🏁 Game Over — submissions closed
              </div>
            ) : (
              <button
                onClick={() => setShowSubmit(true)}
                style={{
                  width: '100%', background: `${diffColor}20`, border: `1px solid ${diffColor}40`,
                  color: diffColor, padding: '12px', borderRadius: 8, fontSize: '0.9rem', fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {isRejected ? '🔄 Resubmit Proof' : '📸 Submit Proof'}
              </button>
            )
          )}
        </>
      )}

      {/* Submission overlay — reuse the existing SubmitProof unchanged in spirit;
          we pass the RESOLVED task as the description so the proof screen,
          submission doc, and GM all see the real challenge, plus the locked
          choices to stamp onto the submission. */}
      {showSubmit && resolvedTask && (
        <SubmitProof
          gameId={gameId}
          teamId={teamId}
          challenge={{
            id: challenge.id,
            description: resolvedTask,           // ← resolved task, not the template
            difficulty: challenge.difficulty,
            points: challenge.points,
            verification_type: challenge.verification_type,
            tier2: challenge.tier2,
            phone_free_eligible: challenge.phone_free_eligible,
            is_time_based: challenge.is_time_based,
          }}
          closedZones={closedZones}
          activeZoneIds={activeZoneIds}
          // NEW passthrough props (see SubmitProof additions):
          resolvedTask={resolvedTask}
          stepChoices={choices}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => { markCompleted(gameId, teamId, challenge.id).catch(() => {}) }}
        />
      )}
    </div>
  )
}