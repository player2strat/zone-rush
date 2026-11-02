// =============================================================================
// Foray — GameSummaryCard
//
// A clickable summary of one of the GM's running games for the home screen's
// list: status, time left (or players joined, or when it ended), number of
// teams, the top two teams, and what's waiting (an ended game's next wrap-up
// step, submissions and side quest photos to review, messages, join requests)
// or "All caught up". Every card is the same height. Clicking it opens that game.
// =============================================================================

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RunningGame } from '../hooks/useRunningGames'
import { STATUS_LABEL, endedAgo, plural, showsStandings, timeLeft, waitingParts, wrapUpStep } from '../lib/runningGameFormat'

// Teams shown in the standings line (two fit the home column with readable
// names); the rest are counted as "+N", and hovering lists them all.
const TOP_TEAMS = 2

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
  const wrapUp = wrapUpStep(game)
  const standings = showsStandings(game)
  // Every card has the same four lines at fixed heights, whatever's on them,
  // so the cards in the list are all one size.
  const line = (height: number): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6, height, overflow: 'hidden', whiteSpace: 'nowrap',
  })

  return (
    <button
      onClick={() => navigate(game.status === 'lobby' ? `/lobby/${game.id}` : `/gm/${game.id}`)}
      title={standings && game.teams.length > 0
        // Tied teams share a rank, as on the strip.
        ? game.teams.map((t) => `${1 + game.teams.filter((o) => o.points > t.points).length}. ${t.name}: ${t.points}`).join('\n')
        : undefined}
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
      <span style={{ ...line(22), justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: 'var(--ink)', fontWeight: 700, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {game.name}
        </span>
        <span style={{ ...tagStyle, background: status.bg, color: status.color, flexShrink: 0 }}>{status.label}</span>
      </span>

      <span style={{ ...line(18), display: 'block', textOverflow: 'ellipsis', fontSize: '0.78rem', color: 'var(--ink-muted)' }}>
        {endedAgo(game, now) ?? timeLeft(game, now) ?? `${plural(game.players, 'player')} joined`}
        {game.teams.length > 0 && ` · ${plural(game.teams.length, 'team')}`}
      </span>

      {/* Standings once the game is underway (or final); before that, who's
          playing. Names shrink with "…" to keep it on one line. */}
      <span style={{ ...line(18), gap: 12, fontSize: '0.78rem', color: 'var(--ink-soft)' }}>
        {top.map((t) => (
          <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, flex: '0 1 auto' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
            {standings && <strong style={{ color: 'var(--ink)', flexShrink: 0 }}>{t.points}</strong>}
          </span>
        ))}
        {more > 0 && <span style={{ color: 'var(--ink-faint)', fontWeight: 700, flexShrink: 0 }}>+{more}</span>}
        {top.length === 0 && <span style={{ color: 'var(--ink-faint)' }}>No teams yet</span>}
      </span>

      {/* What's waiting for the GM in this game; an ended game leads with its
          next wrap-up step, so it's never "caught up" */}
      <span style={{ ...line(20) }}>
        {wrapUp && (
          <span style={{ ...tagStyle, flexShrink: 0, background: 'var(--marigold)', color: 'var(--ink)' }}>{wrapUp}</span>
        )}
        {waiting.map((w) => (
          <span key={w} style={{ ...tagStyle, flexShrink: 0, background: 'rgba(var(--marigold-rgb), 0.15)', color: 'var(--marigold-deep)' }}>{w}</span>
        ))}
        {!wrapUp && waiting.length === 0 && (
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--green)' }}>All caught up</span>
        )}
      </span>
    </button>
  )
}

const tagStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  padding: '2px 8px',
  borderRadius: 4,
}
