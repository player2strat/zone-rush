// =============================================================================
// Foray — GameStrip
//
// A scoreboard strip across the top of a GM's game (dashboard or lobby), like
// a sports site's row of scores: one tile per running game with its status,
// top two teams, time left and what's waiting (spelled out, or "All caught
// up"). The open game's tile is highlighted; clicking another tile switches
// to that game. It sits above the game rather than over it, and scrolls
// sideways (arrows or trackpad) when the tiles don't fit. A "+ New game" tile
// ends the row. Hidden unless the GM has another game running.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRunningGames, type RunningGame } from '../hooks/useRunningGames'
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
    <div style={{ position: 'relative', flexShrink: 0, background: 'rgba(var(--ink-rgb), 0.03)', borderBottom: '1px solid var(--line)' }}>
      <div ref={scroller} style={{ display: 'flex', gap: 8, padding: '8px 12px', overflowX: 'auto', scrollbarWidth: 'none', position: 'relative' }}>
        {games.map((g) => (
          <Tile
            key={g.id}
            game={g}
            now={now}
            current={g.id === currentGameId}
            onOpen={() => navigate(g.status === 'lobby' ? `/lobby/${g.id}` : `/gm/${g.id}`)}
          />
        ))}
        {/* Ends the row, and starts another game without a trip home */}
        <button
          onClick={() => navigate('/create')}
          style={{
            flex: '0 0 auto',
            width: 110,
            borderRadius: 10,
            border: '1px dashed var(--line-strong)',
            background: 'transparent',
            color: 'var(--ink-muted)',
            fontSize: '0.78rem',
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

// One game: name and status, the top two teams with their ranks (or who's
// joined, before it starts), the clock, and what's waiting spelled out, or
// "All caught up". The card is the same size whatever the number of teams.
function Tile({ game, now, current, onOpen }: { game: RunningGame; now: number; current: boolean; onOpen: () => void }) {
  const status = STATUS_LABEL[game.status]
  const waiting = waitingParts(game)
  const clock = timeLeft(game, now)
  const underway = isUnderway(game)
  const top = game.teams.slice(0, 2)
  const moreTeams = game.teams.length - top.length
  // Tied teams share a rank, so two teams on 27 both read "1".
  const rank = (points: number) => 1 + game.teams.filter((t) => t.points > points).length
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', minHeight: 18 }
  const clip: React.CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

  return (
    <button
      data-current={current}
      aria-current={current ? 'page' : undefined}
      onClick={current ? undefined : onOpen}
      // Hovering shows the full standings.
      title={underway && game.teams.length > 0
        ? game.teams.map((t) => `${rank(t.points)}. ${t.name}: ${t.points}`).join('\n')
        : undefined}
      style={{
        flex: '0 0 auto',
        // Wide enough for the clock plus two "waiting" chips on one line.
        width: 264,
        padding: '9px 12px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        textAlign: 'left',
        fontFamily: 'inherit',
        fontWeight: 400,
        borderRadius: 10,
        // The open game's outline is drawn twice as thick without changing
        // the card's size: an inner shadow on top of the 1px border.
        border: current ? '1px solid var(--marigold)' : '1px solid var(--line)',
        boxShadow: current ? 'inset 0 0 0 1px var(--marigold)' : 'none',
        background: current ? 'rgba(var(--marigold-rgb), 0.12)' : 'var(--paper)',
        cursor: current ? 'default' : 'pointer',
      }}
    >
      <span style={row}>
        <span style={{ ...clip, fontSize: '0.88rem', fontWeight: 700, color: 'var(--ink)' }}>{game.name}</span>
        <span style={{ flexShrink: 0, fontSize: '0.64rem', fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', padding: '2px 7px', borderRadius: 4, background: status.bg, color: status.color }}>
          {status.label}
        </span>
      </span>

      {underway ? (
        // Top two teams, like the two rows of a score. When there are more,
        // "+3" ends the second row (a matching blank keeps the points lined
        // up on the first), so the card never grows. Hover lists them all.
        top.map((t, i) => (
          <span key={t.id} style={row}>
            <span style={{ width: 10, flexShrink: 0, textAlign: 'right', fontSize: '0.68rem', fontWeight: 700, color: 'var(--ink-faint)' }}>{rank(t.points)}</span>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
            <span style={{ ...clip, color: 'var(--ink-soft)' }}>{t.name}</span>
            <strong style={{ color: 'var(--ink)' }}>{t.points}</strong>
            {moreTeams > 0 && (
              <span style={{ width: 22, flexShrink: 0, textAlign: 'right', fontSize: '0.68rem', fontWeight: 700, color: 'var(--ink-faint)' }}>
                {i === 1 ? `+${moreTeams}` : ''}
              </span>
            )}
          </span>
        ))
      ) : (
        <>
          <span style={{ ...row, color: 'var(--ink-soft)' }}>{plural(game.players, 'player')} joined</span>
          <span style={{ ...row, color: 'var(--ink-soft)' }}>{plural(game.teams.length, 'team')}</span>
        </>
      )}

      {/* The clock, then what's waiting for the GM here, spelled out */}
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', marginTop: 3, minHeight: 18 }}>
        <span style={{ marginRight: 'auto', paddingRight: 4, fontFamily: clock ? "'Martian Mono', monospace" : 'inherit', fontSize: '0.72rem', fontWeight: 700, color: clock ? 'var(--marigold-deep)' : 'var(--ink-faint)' }}>
          {clock ?? 'Not started'}
        </span>
        {waiting.length === 0 ? (
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--green)' }}>All caught up</span>
        ) : (
          waiting.map((w) => (
            <span key={w} style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(var(--marigold-rgb), 0.18)', color: 'var(--marigold-deep)' }}>
              {w}
            </span>
          ))
        )}
      </span>
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
