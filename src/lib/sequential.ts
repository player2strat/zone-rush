// =============================================================================
// NEW FILE: src/lib/sequential.ts
//
// All the pure logic + Firestore plumbing for sequential ("Choose Your Own
// Adventure") cards, kept out of the components so it can be reused by both
// the player card and the GM dashboard, and tested in isolation.
//
//   interpolateFinalTask()  — fills {1},{2}… in a final_task with choices
//   isSequential()          — type guard for a challenge
//   loadProgress()          — read a team's in-progress state for one card
//   subscribeProgress()     — live listener for the same
//   lockStep()              — commit one choice (write-once per step; locked=locked)
//   markCompleted()         — flip completed=true after proof is submitted
// =============================================================================

import {
  doc, getDoc, setDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore'
import { db } from './firebase'
import type { SequentialProgress } from '../types/game'

// Minimal shape we need off a challenge — avoids a hard import cycle and means
// this works whether the caller passes a full Challenge or a dashboard's local
// ChallengeData copy.
interface SequentialChallengeLike {
  challenge_type?: string
  steps?: string[]
  final_task?: string
}

/** True when this challenge is a sequential card with real step data. */
export function isSequential(ch: SequentialChallengeLike | null | undefined): boolean {
  return (
    !!ch &&
    ch.challenge_type === 'sequential' &&
    Array.isArray(ch.steps) &&
    ch.steps.length > 0 &&
    typeof ch.final_task === 'string' &&
    ch.final_task.length > 0
  )
}

/**
 * Fill {1},{2},… placeholders in a final_task template with the locked choices.
 * Placeholder numbers are 1-based and reference `choices` by position, so {2}
 * pulls choices[1]. A placeholder with no matching choice is left untouched
 * (so a half-resolved preview still renders rather than throwing).
 *
 * @param finalTask  template, e.g. "juggle {2} for {1} seconds"
 * @param choices    locked answers in step order, e.g. ["9", "a frisbee"]
 */
export function interpolateFinalTask(finalTask: string, choices: string[]): string {
  return finalTask.replace(/\{(\d+)\}/g, (whole, numStr) => {
    const idx = parseInt(numStr, 10) - 1
    const val = choices[idx]
    return val === undefined || val === '' ? whole : val
  })
}

/**
 * Validate that a final_task's placeholders all have a matching step. Used by
 * the sync script and worth calling in dev. Returns the list of placeholder
 * numbers that have no corresponding step (empty array = valid).
 */
export function missingStepRefs(finalTask: string, stepCount: number): number[] {
  const refs = new Set<number>()
  for (const m of finalTask.matchAll(/\{(\d+)\}/g)) {
    refs.add(parseInt(m[1], 10))
  }
  return [...refs].filter((n) => n < 1 || n > stepCount).sort((a, b) => a - b)
}

// ─── Firestore path helper ───────────────────────────────────────────────────

function progressRef(gameId: string, teamId: string, challengeId: string) {
  return doc(
    db,
    'games', gameId,
    'teams', teamId,
    'sequential_progress', challengeId,
  )
}

// ─── Read once ───────────────────────────────────────────────────────────────

export async function loadProgress(
  gameId: string,
  teamId: string,
  challengeId: string,
): Promise<SequentialProgress | null> {
  const snap = await getDoc(progressRef(gameId, teamId, challengeId))
  return snap.exists() ? (snap.data() as SequentialProgress) : null
}

// ─── Live listener ───────────────────────────────────────────────────────────

export function subscribeProgress(
  gameId: string,
  teamId: string,
  challengeId: string,
  cb: (progress: SequentialProgress | null) => void,
  onError?: (err: Error) => void,
): () => void {
  const path = `games/${gameId}/teams/${teamId}/sequential_progress/${challengeId}`
  return onSnapshot(
    progressRef(gameId, teamId, challengeId),
    (snap) => {
      cb(snap.exists() ? (snap.data() as SequentialProgress) : null)
    },
    (err) => {
      console.error('[sequential] listener denied/failed on path:', path, err)
      onError?.(err)
    },
  )
}

// ─── Lock one step ───────────────────────────────────────────────────────────

/**
 * Commit a single choice. This is the heart of "locked = locked":
 *  - It refuses to overwrite an already-locked step (idempotent + tamper-safe).
 *  - It refuses to skip ahead (you must lock step N before step N+1).
 *  - When the final step locks, it computes and stores resolved_task.
 *
 * Returns the updated progress. Throws if the lock is out of order or the step
 * is already locked with a different value (the UI should never allow either,
 * but the guard protects against double-taps and replays).
 *
 * @param totalSteps  challenge.steps.length — needed to know when we're done
 * @param finalTask   challenge.final_task — needed to resolve on the last lock
 */
export async function lockStep(
  gameId: string,
  teamId: string,
  challengeId: string,
  stepIndex: number,        // 0-based index of the step being locked
  choice: string,
  totalSteps: number,
  finalTask: string,
): Promise<SequentialProgress> {
  const trimmed = choice.trim()
  if (!trimmed) throw new Error('Choice cannot be empty.')

  const ref = progressRef(gameId, teamId, challengeId)
  const snap = await getDoc(ref)

  const prev: SequentialProgress = snap.exists()
    ? (snap.data() as SequentialProgress)
    : {
        challenge_id: challengeId,
        step_choices: [],
        locked_count: 0,
        resolved_task: null,
        completed: false,
      }

  // Guard: already-locked step. If the same value, treat as a no-op (handles
  // double-tap / network retry). If a different value, refuse — locked = locked.
  if (stepIndex < prev.locked_count) {
    if (prev.step_choices[stepIndex] === trimmed) return prev
    throw new Error('That step is already locked and cannot be changed.')
  }

  // Guard: no skipping ahead.
  if (stepIndex !== prev.locked_count) {
    throw new Error('Steps must be locked in order.')
  }

  const step_choices = [...prev.step_choices, trimmed]
  const locked_count = step_choices.length
  const allLocked = locked_count >= totalSteps
  const resolved_task = allLocked
    ? interpolateFinalTask(finalTask, step_choices)
    : null

  const next: SequentialProgress = {
    challenge_id: challengeId,
    step_choices,
    locked_count,
    resolved_task,
    completed: false,
  }

  await setDoc(ref, { ...next, updated_at: serverTimestamp() })
  return next
}

// ─── Mark completed (after proof submitted) ──────────────────────────────────

export async function markCompleted(
  gameId: string,
  teamId: string,
  challengeId: string,
): Promise<void> {
  const ref = progressRef(gameId, teamId, challengeId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return
  await setDoc(ref, { ...(snap.data() as SequentialProgress), completed: true }, { merge: true })
}