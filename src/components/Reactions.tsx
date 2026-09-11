// =============================================================================
// Foray — Reaction bar (send) + floating overlay (receive)
//
// ReactionBar: fixed picker at the bottom of the player's results page while
// the reveal is running. One tap per REACTION_COOLDOWN_MS.
// ReactionOverlay: subscribes to the game's reactions and floats each one up
// the right edge of the screen in the sender's team color. Used by players
// and by the GM dashboard, which only watches.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import {
  REACTIONS, REACTION_COOLDOWN_MS, reactionByKey, sendReaction, subscribeToReactions,
  type Reaction,
} from '../lib/reactions'

const FLOAT_MS = 2600

function ReactionGlyph({ reactionKey, size }: { reactionKey: string; size: number }) {
  const def = reactionByKey(reactionKey)
  if (!def) return null
  if (def.icon) {
    return <img src={def.icon} alt={def.label} style={{ width: size, height: size, display: 'block' }} />
  }
  return <span style={{ fontSize: size * 0.82, lineHeight: 1 }} aria-label={def.label}>{def.emoji}</span>
}

// ---------------------------------------------------------------------------

interface ReactionBarProps {
  gameId: string
  team: { id: string; name: string; color: string }
  uid: string
}

export function ReactionBar({ gameId, team, uid }: ReactionBarProps) {
  const [coolingDown, setCoolingDown] = useState(false)
  const [pressed, setPressed] = useState<string | null>(null)

  const react = async (key: string) => {
    if (coolingDown) return
    setCoolingDown(true)
    setPressed(key)
    setTimeout(() => { setCoolingDown(false); setPressed(null) }, REACTION_COOLDOWN_MS)
    try {
      await sendReaction(gameId, key, team, uid)
    } catch (err) {
      console.error('Reaction failed:', err)
    }
  }

  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 150,
      padding: '10px 12px calc(10px + env(safe-area-inset-bottom))',
      background: 'rgba(var(--paper-rgb), 0.94)',
      borderTop: '1px solid var(--line)',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ maxWidth: 420, margin: '0 auto', display: 'flex', gap: 8, justifyContent: 'center' }}>
        {REACTIONS.map((r) => {
          const active = pressed === r.key
          return (
            <button
              key={r.key}
              onClick={() => react(r.key)}
              disabled={coolingDown}
              aria-label={r.label}
              title={r.label}
              style={{
                flex: '1 1 0', maxWidth: 72, height: 52,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: active ? `${team.color}30` : 'var(--surface)',
                border: `1px solid ${active ? team.color : 'var(--line-strong)'}`,
                borderRadius: 14, cursor: coolingDown ? 'default' : 'pointer',
                opacity: coolingDown && !active ? 0.55 : 1,
                transform: active ? 'scale(1.08)' : 'scale(1)',
                transition: 'transform 0.15s ease, opacity 0.2s ease',
                fontFamily: 'inherit',
              }}
            >
              <ReactionGlyph reactionKey={r.key} size={30} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface FloatingReaction extends Reaction {
  x: number          // horizontal jitter, 0–1
  drift: number      // sway direction, -1..1
}

interface ReactionOverlayProps {
  gameId: string
  /** Pause the subscription (e.g. before the reveal starts). */
  enabled?: boolean
}

export function ReactionOverlay({ gameId, enabled = true }: ReactionOverlayProps) {
  const [floating, setFloating] = useState<FloatingReaction[]>([])
  const timers = useRef<number[]>([])

  useEffect(() => {
    if (!enabled) return
    const unsub = subscribeToReactions(gameId, (r) => {
      const item: FloatingReaction = { ...r, x: Math.random(), drift: Math.random() * 2 - 1 }
      setFloating((prev) => [...prev.slice(-24), item])
      const t = window.setTimeout(() => {
        setFloating((prev) => prev.filter((f) => f.id !== item.id))
      }, FLOAT_MS)
      timers.current.push(t)
    })
    return () => {
      unsub()
      timers.current.forEach((t) => clearTimeout(t))
      timers.current = []
    }
  }, [gameId, enabled])

  if (floating.length === 0) return null

  return (
    <div style={{
      position: 'fixed', right: 8, bottom: 90, width: 120, height: '60vh',
      pointerEvents: 'none', zIndex: 160, overflow: 'visible',
    }}>
      <style>{`
        @keyframes reactionFloat {
          0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
          10%  { transform: translate(0, -20px) scale(1.15); opacity: 1; }
          60%  { opacity: 1; }
          100% { transform: translate(var(--sway), -58vh) scale(1); opacity: 0; }
        }
      `}</style>
      {floating.map((f) => (
        <div
          key={f.id}
          style={{
            position: 'absolute', bottom: 0, left: `${8 + f.x * 60}%`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            // @ts-expect-error — CSS custom property
            '--sway': `${Math.round(f.drift * 28)}px`,
            animation: `reactionFloat ${FLOAT_MS}ms ease-out forwards`,
            willChange: 'transform, opacity',
          }}
        >
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${f.team_color}26`, border: `2px solid ${f.team_color}`,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          }}>
            <ReactionGlyph reactionKey={f.key} size={26} />
          </div>
          <span style={{
            fontSize: '0.62rem', fontWeight: 800, color: f.team_color,
            background: 'rgba(var(--paper-rgb), 0.9)', padding: '1px 6px', borderRadius: 999,
            maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {f.team_name}
          </span>
        </div>
      ))}
    </div>
  )
}
