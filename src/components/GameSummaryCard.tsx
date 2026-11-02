// =============================================================================
// Foray — GameSummaryCard
//
// A small clickable summary of one of the GM's running games: status, time
// left (or players joined), number of teams, the top of the standings, and
// what's waiting (submissions and side quest photos to review, messages, join
// requests). Clicking it opens that game. Used on the home screen and in the
// dashboard's "other games" menu.
// =============================================================================

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RunningGame, RunningStatus } from '../hooks/useRunningGames'

const STATUS_LABEL: Record<RunningStatus, { label: string; bg: string; color: string }> = {
  active: { label: 'Live', bg: 'rgba(var(--green-rgb), 0.15)', color: 'var(--green)' },
  paused: { label: 'Paused', bg: 'rgba(var(--marigold-rgb), 0.15)', color: 'var(--marigold-deep)' },
  strategy: { label: 'Strategy', bg: 'rgba(var(--pink-rgb), 0.12)', color: 'var(--pink-deep)' },
  lobby: { label: 'Lobby', bg: 'rgba(var(--ink-rgb), 0.06)', color: 'var(--ink-muted)' },
}

// Teams shown in the standings line; the rest are counted as "+N".
const TOP_TEAMS = 3

function toMillis(t: unknown): number | null {
  if (t instanceof Date) return t.getTime()
  const ts = t as { toMillis?: () => number } | null | undefined
  return ts?.toMillis ? ts.toMillis() : null
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// "1:42 left" for live and paused games (a paused clock stops where it paused),
// players joined for games that haven't started.
function gameDetail(g: RunningGame, now: number): string {
  if (g.status === 'active' || g.status === 'paused') {
    const endsAt = toMillis(g.ends_at)
    if (endsAt !== null) {
      const from = g.status === 'paused' ? toMillis(g.paused_at) ?? now : now
      const ms = Math.max(0, endsAt - from)
      const h = Math.floor(ms / 3600000)
      const m = Math.floor((ms % 3600000) / 60000)
      return `${h}:${String(m).padStart(2, '0')} left`
    }
  }
  return `${plural(g.players, 'player')} joined`
}

export default function GameSummaryCard({ game, onOpen }: { game: RunningGame; onOpen?: () => void }) {
  const navigate = useNavigate()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  const status = STATUS_LABEL[game.status]
  const toReview = game.pendingSubmissions + game.pendingSideQuests
  const playing = game.status === 'active' || game.status === 'paused'
  const top = game.teams.slice(0, TOP_TEAMS)
  const more = game.teams.length - top.length

  const open = () => {
    onOpen?.()
    navigate(game.status === 'lobby' ? `/lobby/${game.id}` : `/gm/${game.id}`)
  }

  return (
    <button
      onClick={open}
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
        {gameDetail(game, now)}
        {game.teams.length > 0 && ` · ${plural(game.teams.length, 'team')}`}
      </span>

      {/* Standings: top teams by points, once the game is underway */}
      {playing && top.length > 0 && (
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
      {(toReview > 0 || game.unreadMessages > 0 || game.pendingJoins > 0) && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {toReview > 0 && <span style={{ ...tagStyle, ...waitingTagStyle }}>{toReview} to review</span>}
          {game.unreadMessages > 0 && <span style={{ ...tagStyle, ...waitingTagStyle }}>{plural(game.unreadMessages, 'message')}</span>}
          {game.pendingJoins > 0 && <span style={{ ...tagStyle, ...waitingTagStyle }}>{plural(game.pendingJoins, 'join request')}</span>}
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

const waitingTagStyle: React.CSSProperties = {
  background: 'rgba(var(--marigold-rgb), 0.15)',
  color: 'var(--marigold-deep)',
}
