// =============================================================================
// Foray — GameStrip
//
// A scoreboard strip across the top of a GM's game (dashboard or lobby), like
// a sports site's row of scores: one tile per running game with its status,
// time left, top two teams and what's waiting. The open game's tile is
// highlighted; clicking another tile switches to that game. It sits above the
// game rather than over it, and scrolls sideways (arrows or trackpad) when the
// tiles don't fit. A "+ New game" tile ends the row. Hidden unless the GM
// has another game running.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRunningGames, waitingCount, type RunningGame } from '../hooks/useRunningGames'
import { STATUS_LABEL, isUnderway, plural, timeLeft, waitingParts } from '../lib/runningGameFormat'

export default function GameStrip({ currentGameId }: { currentGameId: string | undefined }) {
  const games = useRunningGames()
  const navigate = useNavigate()
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const [more, setMore] = useState({ left: false, right: false })
  const show = games.some((g) => g.id !== currentGameId)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  // Arrows only when there are tiles out of view on that side. The observer
  // also fires once right away, which sets the starting state.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = () => setMore({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    })
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [show, games.length])

  // Bring the open game's tile into view if the strip starts scrolled past it.
  useEffect(() => {
    const el = scroller.current
    const tile = el?.querySelector<HTMLElement>('[data-current="true"]')
    if (el && tile && tile.offsetLeft + tile.offsetWidth > el.clientWidth) {
      el.scrollLeft = tile.offsetLeft - 8
    }
  }, [currentGameId, show])

  if (!show) return null

  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0, background: 'rgba(var(--ink-rgb), 0.025)', borderBottom: '1px solid var(--line)' }}>
      <div ref={scroller} style={{ display: 'flex', overflowX: 'auto', scrollbarWidth: 'none', position: 'relative' }}>
        {games.map((g) => (
          <Tile
            key={g.id}
            game={g}
            now={now}
            current={g.id === currentGameId}
            onOpen={() => navigate(g.status === 'lobby' ? `/lobby/${g.id}` : `/gm/${g.id}`)}
          />
        ))}
        {/* Closes the row, and starts another game without a trip home */}
        <button
          onClick={() => navigate('/create')}
          style={{
            flex: '0 0 auto',
            width: 120,
            margin: 8,
            borderRadius: 8,
            border: '1px dashed var(--line-strong)',
            background: 'transparent',
            color: 'var(--ink-muted)',
            fontSize: '0.75rem',
            fontWeight: 700,
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          + New game
        </button>
      </div>
      {more.left && <Arrow side="left" onClick={() => scrollBy(-1)} />}
      {more.right && <Arrow side="right" onClick={() => scrollBy(1)} />}
    </div>
  )
}

function Tile({ game, now, current, onOpen }: { game: RunningGame; now: number; current: boolean; onOpen: () => void }) {
  const status = STATUS_LABEL[game.status]
  const waiting = waitingCount(game)
  const clock = timeLeft(game, now)

  return (
    <button
      data-current={current}
      aria-current={current ? 'page' : undefined}
      onClick={current ? undefined : onOpen}
      title={waiting > 0 ? waitingParts(game).join(', ') : undefined}
      style={{
        flex: '0 0 auto',
        width: 190,
        padding: '8px 12px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        textAlign: 'left',
        fontFamily: 'inherit',
        border: 'none',
        borderRadius: 0,
        borderRight: '1px solid var(--line)',
        background: current ? 'rgba(var(--marigold-rgb), 0.12)' : 'transparent',
        boxShadow: current ? 'inset 0 -3px 0 var(--marigold)' : 'none',
        cursor: current ? 'default' : 'pointer',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.78rem', fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {game.name}
        </span>
        {waiting > 0 && (
          <span style={{ flexShrink: 0, minWidth: 18, padding: '0 5px', borderRadius: 999, background: 'var(--marigold)', color: 'var(--ink)', fontSize: '0.66rem', fontWeight: 800, textAlign: 'center', lineHeight: '18px' }}>
            {waiting}
          </span>
        )}
      </span>

      <span style={{ fontSize: '0.66rem', color: 'var(--ink-muted)' }}>
        <strong style={{ color: status.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{status.label}</strong>
        {clock && ` · ${clock}`}
      </span>

      {isUnderway(game) ? (
        // Top two teams, like the two rows of a score.
        game.teams.slice(0, 2).map((t) => (
          <span key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            <strong style={{ color: 'var(--ink)' }}>{t.points}</strong>
          </span>
        ))
      ) : (
        <>
          <span style={{ fontSize: '0.74rem', color: 'var(--ink-soft)' }}>{plural(game.players, 'player')} joined</span>
          <span style={{ fontSize: '0.74rem', color: 'var(--ink-soft)' }}>{plural(game.teams.length, 'team')}</span>
        </>
      )}
    </button>
  )
}

function Arrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={side === 'left' ? 'Scroll games left' : 'Scroll games right'}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: 0,
        width: 32,
        padding: 0,
        border: 'none',
        borderRadius: 0,
        [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--line)',
        background: 'var(--paper)',
        color: 'var(--ink-muted)',
        fontSize: '1.2rem',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  )
}
