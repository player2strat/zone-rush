// =============================================================================
// Foray — OtherGamesMenu
//
// On a GM dashboard: a small tag for the GM's other running games ("3 waiting
// in other games", or "2 other games" when nothing's waiting). Clicking it
// drops down a GameSummaryCard per game (standings, time left, what's
// waiting); clicking a card opens that game.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { useRunningGames, waitingCount } from '../hooks/useRunningGames'
import GameSummaryCard from './GameSummaryCard'

export default function OtherGamesMenu({ currentGameId }: { currentGameId: string | undefined }) {
  const others = useRunningGames().filter((g) => g.id !== currentGameId)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Close on a click outside the menu, or Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (others.length === 0) return null

  const waiting = others.reduce((n, g) => n + waitingCount(g), 0)
  const label = waiting > 0
    ? `${waiting} waiting in other games`
    : `${others.length} other game${others.length === 1 ? '' : 's'}`

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          background: waiting > 0 ? 'rgba(var(--marigold-rgb), 0.15)' : 'rgba(var(--ink-rgb), 0.05)',
          border: 'none',
          color: waiting > 0 ? 'var(--marigold-deep)' : 'var(--ink-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: '0.7rem',
          fontWeight: 700,
          padding: '3px 8px',
          borderRadius: 4,
        }}
      >
        {label} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          left: 0,
          zIndex: 1000,
          width: 'min(320px, calc(100vw - 40px))',
          maxHeight: '70vh',
          overflowY: 'auto',
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {others.map((g) => (
            <GameSummaryCard key={g.id} game={g} onOpen={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  )
}
