// =============================================================================
// Foray — End-game reveal (shared by players and the GM preview)
//
// Renders ONE stage of the post-game reveal, driven entirely by the game
// doc's `reveal_step` (see lib/endGame.ts for the step layout). Because the
// step lives in Firestore, every phone — in the room or remote — shows the
// same screen the moment the GM taps Next, and anyone who opens late sees
// everything revealed so far.
//
// Stages:
//   standings  → every team's score before bonuses
//   award      → one bonus card (who won it, or "tie — nobody"), then the
//                running standings with that bonus folded in
//   place      → countdown from last place up to the champion
// =============================================================================

import { useMemo } from 'react'
import type { EndGameAward } from '../types/game'
import {
  revealStageAt, revealTotalSteps, revealedAwardCount, revealedPoints, ordinal,
} from '../lib/reveal'

export interface RevealTeam {
  id: string
  name: string
  color: string
  total_points: number
  member_names?: string[]
}

interface EndGameRevealProps {
  awards: EndGameAward[]
  teams: RevealTeam[]
  step: number
  myTeamId?: string | null
  compact?: boolean            // GM dashboard preview: tighter spacing
}

const MONO = "'Martian Mono', monospace"

// Ordinal label with shared ranks for ties ("T-2nd").
function placeLabel(place: number, tied: boolean): string {
  return `${tied ? 'T-' : ''}${ordinal(place)}`
}

function medalFor(place: number): string {
  return place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : ''
}

export default function EndGameReveal({
  awards, teams, step, myTeamId = null, compact = false,
}: EndGameRevealProps) {
  const totalSteps = revealTotalSteps(awards.length, teams.length)
  const stage = revealStageAt(step, awards, teams.length)
  const shownAwards = revealedAwardCount(step, awards.length)

  // Standings as the audience currently sees them (bonuses folded in one at
  // a time). Ties broken by name so the order is stable between renders.
  const standings = useMemo(() => {
    return teams
      .map((t) => ({ ...t, shown: revealedPoints(t, awards, step) }))
      .sort((a, b) => b.shown - a.shown || a.name.localeCompare(b.name))
  }, [teams, awards, step])

  // Final order (every bonus counted) — used by the countdown.
  const finalOrder = useMemo(() => {
    return [...teams].sort((a, b) => b.total_points - a.total_points || a.name.localeCompare(b.name))
  }, [teams])
  const finalRank = (idx: number) =>
    1 + finalOrder.filter((t) => t.total_points > finalOrder[idx].total_points).length
  const finalTied = (idx: number) =>
    finalOrder.filter((t) => t.total_points === finalOrder[idx].total_points).length > 1

  const pad = compact ? '14px 14px' : '22px 20px'
  const titleSize = compact ? '0.66rem' : '0.72rem'

  const sectionLabel = (text: string) => (
    <p style={{
      fontSize: titleSize, color: 'var(--marigold-deep)', textTransform: 'uppercase',
      letterSpacing: 1.5, fontWeight: 700, margin: '0 0 12px',
    }}>
      {text}
    </p>
  )

  const keyframes = (
    <style>{`
      @keyframes revealPop {
        0%   { opacity: 0; transform: scale(0.85); }
        60%  { transform: scale(1.04); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes revealSlide {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `}</style>
  )

  const progress = (
    <p style={{
      fontFamily: MONO, fontSize: '0.66rem', color: 'var(--ink-ghost)',
      margin: compact ? '0 0 10px' : '0 0 16px', textAlign: 'center', letterSpacing: 1,
    }}>
      REVEAL · {Math.min(step, totalSteps)} / {totalSteps}
    </p>
  )

  const teamRow = (t: RevealTeam & { shown: number }, opts: { dim?: boolean; delta?: number } = {}) => {
    const mine = t.id === myTeamId
    return (
      <div key={t.id} style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: compact ? '7px 10px' : '10px 12px', borderRadius: 10,
        background: mine ? `${t.color}18` : 'rgba(var(--ink-rgb), 0.02)',
        border: `1px solid ${mine ? t.color + '60' : 'var(--line)'}`,
        opacity: opts.dim ? 0.55 : 1,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: 3, background: t.color, flexShrink: 0 }} />
        <span style={{
          fontWeight: mine ? 800 : 600, fontSize: compact ? '0.8rem' : '0.9rem', color: 'var(--ink)',
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {t.name}{mine ? ' (you)' : ''}
        </span>
        {opts.delta ? (
          <span style={{ fontFamily: MONO, fontSize: '0.72rem', color: 'var(--green)', fontWeight: 700 }}>
            +{opts.delta}
          </span>
        ) : null}
        <span style={{ fontFamily: MONO, fontSize: compact ? '0.9rem' : '1.05rem', fontWeight: 800, color: t.color }}>
          {t.shown}
        </span>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  if (stage.kind === 'waiting') {
    return (
      <div style={{ textAlign: 'center', color: 'var(--ink-faint)', fontSize: '0.85rem', padding: pad }}>
        Reveal hasn't started yet.
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  if (stage.kind === 'standings') {
    return (
      <div key={`stage-${step}`} className="reveal-stage" style={{ padding: pad }}>
        {keyframes}
        {progress}
        {sectionLabel('Standings before bonuses')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {standings.map((t) => teamRow(t))}
        </div>
        <p style={{ color: 'var(--ink-faint)', fontSize: '0.78rem', textAlign: 'center', margin: '14px 0 0', lineHeight: 1.5 }}>
          {awards.length > 0
            ? `${awards.length} bonus${awards.length === 1 ? '' : 'es'} still to come — anything can happen.`
            : 'No bonuses this game. On to the final standings…'}
        </p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  if (stage.kind === 'award') {
    const { award, index } = stage
    const winner = award.team_id ? teams.find((t) => t.id === award.team_id) ?? null : null
    const winnerIsMe = !!winner && winner.id === myTeamId
    return (
      <div key={`stage-${step}`} className="reveal-stage" style={{ padding: pad }}>
        {keyframes}
        {progress}
        {sectionLabel(`Bonus ${index + 1} of ${awards.length}`)}

        <div style={{
          textAlign: 'center', borderRadius: 16, padding: compact ? '18px 14px' : '28px 20px',
          background: winner
            ? `linear-gradient(135deg, ${winner.color}22 0%, ${winner.color}0a 100%)`
            : 'rgba(var(--ink-rgb), 0.03)',
          border: `1px solid ${winner ? winner.color + '60' : 'var(--line)'}`,
          animation: 'revealPop 0.6s ease both',
        }}>
          <div style={{ fontSize: compact ? '1.6rem' : '2.4rem', lineHeight: 1, marginBottom: 8 }}>{award.emoji}</div>
          <p style={{ fontWeight: 800, fontSize: compact ? '0.95rem' : '1.15rem', color: 'var(--ink)', margin: '0 0 4px' }}>
            {award.label}
          </p>
          <p style={{ fontFamily: MONO, fontSize: '0.72rem', color: 'var(--marigold-deep)', margin: '0 0 16px', letterSpacing: 1 }}>
            +{award.points} PTS
          </p>

          {winner ? (
            <div style={{ animation: 'revealSlide 0.5s 0.35s ease both' }}>
              <p style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, margin: '0 0 6px' }}>
                Goes to
              </p>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 14, height: 14, borderRadius: 4, background: winner.color }} />
                <span style={{ fontWeight: 800, fontSize: compact ? '1.1rem' : '1.5rem', color: winner.color }}>
                  {winner.name}
                </span>
              </div>
              {winnerIsMe && (
                <p style={{ color: 'var(--green)', fontWeight: 700, fontSize: '0.85rem', margin: '10px 0 0' }}>
                  That's you! 🎉
                </p>
              )}
            </div>
          ) : (
            <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem', fontWeight: 600, margin: 0, animation: 'revealSlide 0.5s 0.35s ease both' }}>
              It's a tie — nobody takes this one.
            </p>
          )}
        </div>

        {!compact && (
          <>
            <p style={{
              fontSize: titleSize, color: 'var(--ink-muted)', textTransform: 'uppercase',
              letterSpacing: 1.5, fontWeight: 700, margin: '22px 0 10px',
            }}>
              Running standings
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {standings.map((t) => teamRow(t, { delta: winner && t.id === winner.id ? award.points : 0 }))}
            </div>
          </>
        )}
        {compact && shownAwards < awards.length && (
          <p style={{ color: 'var(--ink-faint)', fontSize: '0.74rem', textAlign: 'center', margin: '10px 0 0' }}>
            {awards.length - shownAwards} more to reveal
          </p>
        )}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Countdown: last place first, up to the champion.
  const revealedFromIdx = stage.place - 1     // rows at index ≥ this are revealed
  const champion = stage.place === 1 ? finalOrder[0] : null
  return (
    <div key={`stage-${step}`} className="reveal-stage" style={{ padding: pad }}>
      {keyframes}
      {progress}
      {sectionLabel(stage.place === 1 ? 'Final standings' : `Revealing ${placeLabel(stage.place, false)} place`)}

      {champion && (
        <div style={{
          textAlign: 'center', borderRadius: 16, padding: compact ? '18px 14px' : '30px 20px', marginBottom: 16,
          background: `linear-gradient(135deg, ${champion.color}26 0%, ${champion.color}0a 100%)`,
          border: `1px solid ${champion.color}70`,
          animation: 'revealPop 0.7s ease both',
        }}>
          <div style={{ fontSize: compact ? '1.8rem' : '2.8rem', lineHeight: 1, marginBottom: 8 }}>🏆</div>
          <p style={{ fontSize: '0.7rem', color: 'var(--marigold-deep)', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700, margin: '0 0 8px' }}>
            {finalTied(0) ? 'Tied champions' : 'Champions'}
          </p>
          <p style={{ fontWeight: 800, fontSize: compact ? '1.2rem' : '1.7rem', color: champion.color, margin: 0 }}>
            {finalTied(0)
              ? finalOrder.filter((t) => t.total_points === champion.total_points).map((t) => t.name).join(' & ')
              : champion.name}
          </p>
          <p style={{ fontFamily: MONO, fontSize: compact ? '1.4rem' : '2.2rem', fontWeight: 800, color: champion.color, margin: '8px 0 0', lineHeight: 1 }}>
            {champion.total_points}
          </p>
          {champion.id === myTeamId && (
            <p style={{ color: 'var(--green)', fontWeight: 700, fontSize: '0.9rem', margin: '12px 0 0' }}>
              You won! 🎉
            </p>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {finalOrder.map((t, idx) => {
          const revealed = idx >= revealedFromIdx
          const place = finalRank(idx)
          const mine = t.id === myTeamId
          if (!revealed) {
            return (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: compact ? '7px 10px' : '10px 12px', borderRadius: 10,
                background: 'rgba(var(--ink-rgb), 0.02)', border: '1px dashed var(--line)',
              }}>
                <span style={{ fontFamily: MONO, fontSize: '0.72rem', color: 'var(--ink-ghost)', width: 44 }}>
                  {placeLabel(idx + 1, false)}
                </span>
                <span style={{ color: 'var(--ink-ghost)', fontSize: compact ? '0.8rem' : '0.9rem', letterSpacing: 2 }}>? ? ?</span>
              </div>
            )
          }
          const justRevealed = idx === revealedFromIdx
          return (
            <div key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: compact ? '7px 10px' : '10px 12px', borderRadius: 10,
              background: mine ? `${t.color}18` : 'rgba(var(--ink-rgb), 0.02)',
              border: `1px solid ${mine ? t.color + '60' : 'var(--line)'}`,
              animation: justRevealed ? 'revealSlide 0.5s ease both' : undefined,
            }}>
              <span style={{ fontFamily: MONO, fontSize: '0.72rem', color: 'var(--ink-muted)', width: 44, fontWeight: 700 }}>
                {placeLabel(place, finalTied(idx))}
              </span>
              <span style={{ fontSize: '0.9rem', width: 18 }}>{medalFor(place)}</span>
              <div style={{ width: 10, height: 10, borderRadius: 3, background: t.color, flexShrink: 0 }} />
              <span style={{
                fontWeight: mine ? 800 : 600, fontSize: compact ? '0.8rem' : '0.9rem', color: 'var(--ink)',
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {t.name}{mine ? ' (you)' : ''}
              </span>
              <span style={{ fontFamily: MONO, fontSize: compact ? '0.9rem' : '1.05rem', fontWeight: 800, color: t.color }}>
                {t.total_points}
              </span>
            </div>
          )
        })}
      </div>

    </div>
  )
}
