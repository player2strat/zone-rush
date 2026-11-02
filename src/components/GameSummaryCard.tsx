// =============================================================================
// Foray — GameSummaryCard
//
// A clickable summary of one of the GM's running games for the home screen's
// list: status, time left (or players joined), number of teams, the top of the
// standings, and what's waiting (submissions and side quest photos to review,
// messages, join requests). Clicking it opens that game.
// =============================================================================

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RunningGame } from '../hooks/useRunningGames'
import { STATUS_LABEL, isUnderway, plural, timeLeft, waitingParts } from '../lib/runningGameFormat'

// Teams shown in the standings line; the rest are counted as "+N".
const TOP_TEAMS = 3

export default function GameSummaryCard({ game }: { game: RunningGame }) {
  const navigate = useNavigate()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  const status = STATUS_LABEL[game.status]
  const top = game.teams.slice(0, TOP_TEAMS)
  const more = game.teams.length - top.length
  const waiting = waitingParts(game)

  return (
    <button
      onClick={() => navigate(game.status === 'lobby' ? `/lobby/${game.id}` : `/gm/${game.id}`)}
      style={{
        width: '100%',
        background: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '12px 14px',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--ink)', fontWeight: 700, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {game.name}
        </span>
        <span style={{ ...tagStyle, background: status.bg, color: status.color, flexShrink: 0 }}>{status.label}</span>
      </span>

      <span style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>
        {timeLeft(game, now) ?? `${plural(game.players, 'player')} joined`}
        {game.teams.length > 0 && ` · ${plural(game.teams.length, 'team')}`}
      </span>

      {/* Standings: top teams by points, once the game is underway */}
      {isUnderway(game) && top.length > 0 && (
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', fontSize: '0.78rem', color: 'var(--ink-soft)' }}>
          {top.map((t) => (
            <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{t.name}</span>
              <strong style={{ color: 'var(--ink)' }}>{t.points}</strong>
            </span>
          ))}
          {more > 0 && <span style={{ color: 'var(--ink-faint)' }}>+{more}</span>}
        </span>
      )}

      {/* What's waiting for the GM in this game */}
      {waiting.length > 0 && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {waiting.map((w) => (
            <span key={w} style={{ ...tagStyle, background: 'rgba(var(--marigold-rgb), 0.15)', color: 'var(--marigold-deep)' }}>{w}</span>
          ))}
        </span>
      )}
    </button>
  )
}

const tagStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  padding: '2px 8px',
  borderRadius: 4,
}
