// =============================================================================
// Foray — Toast notifications
//
// Small, non-blocking messages that slide in at the top of the screen and
// go away on their own. Replaces the browser's alert() popups (which block
// the whole screen and look broken on phones) and the places where a
// failure used to be written only to the developer console.
//
// Usage:
//   const toast = useToast()
//   toast.error('Failed to send. Try again.', { retry: () => handleSend() })
//   toast.success('Broadcast sent')
//   toast.info('No replacement challenges available.')
// =============================================================================

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ToastContext, type Tone, type ToastApi, type ToastItem, type ToastOptions } from '../hooks/useToast'

const MAX_VISIBLE = 3

const TONE_STYLE: Record<Tone, { rgb: string; ink: string; icon: string }> = {
  error:   { rgb: 'var(--red-rgb)',      ink: 'var(--red)',      icon: '⚠️' },
  success: { rgb: 'var(--green-rgb)',    ink: 'var(--green)',    icon: '✅' },
  info:    { rgb: 'var(--marigold-rgb)', ink: 'var(--marigold)', icon: 'ℹ️' },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }, [])

  const push = useCallback((tone: Tone, message: string, opts?: ToastOptions) => {
    const id = nextId.current++
    const duration = opts?.duration ?? (tone === 'error' ? 7000 : 4500)
    setItems((prev) => {
      const next = [...prev, { id, tone, message, retry: opts?.retry }]
      // Drop the oldest if we're over the cap so the stack never takes over.
      while (next.length > MAX_VISIBLE) {
        const dropped = next.shift()!
        const t = timers.current.get(dropped.id)
        if (t) clearTimeout(t)
        timers.current.delete(dropped.id)
      }
      return next
    })
    timers.current.set(id, setTimeout(() => dismiss(id), duration))
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    error: (m, o) => push('error', m, o),
    success: (m, o) => push('success', m, o),
    info: (m, o) => push('info', m, o),
  }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
          left: 0, right: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          padding: '0 12px',
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        {items.map((item) => {
          const st = TONE_STYLE[item.tone]
          return (
            <div
              key={item.id}
              role={item.tone === 'error' ? 'alert' : 'status'}
              style={{
                pointerEvents: 'auto',
                width: '100%', maxWidth: 480,
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'var(--paper)',
                border: `1px solid rgba(${st.rgb}, 0.35)`,
                boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
                borderRadius: 10, padding: '10px 12px',
                animation: 'toastIn 180ms ease-out',
              }}
            >
              <span style={{ fontSize: '0.9rem', flexShrink: 0 }}>{st.icon}</span>
              <p style={{ flex: 1, margin: 0, color: 'var(--ink)', fontSize: '0.82rem', lineHeight: 1.45 }}>
                {item.message}
              </p>
              {item.retry && (
                <button
                  onClick={() => { dismiss(item.id); void item.retry!() }}
                  style={{
                    background: `rgba(${st.rgb}, 0.12)`, border: `1px solid rgba(${st.rgb}, 0.3)`,
                    color: st.ink, padding: '6px 10px', borderRadius: 8,
                    fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                    flexShrink: 0,
                  }}
                >
                  Retry
                </button>
              )}
              <button
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss"
                style={{
                  background: 'none', border: 'none', color: 'var(--ink-faint)',
                  fontSize: '0.95rem', cursor: 'pointer', padding: '4px 6px', lineHeight: 1, flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
        <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }`}</style>
      </div>
    </ToastContext.Provider>
  )
}
