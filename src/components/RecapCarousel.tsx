// =============================================================================
// Foray — Recap carousel (results page, after the champion is revealed)
//
// A swipeable row of share cards (team recap, zone map, …). Each card is
// rendered to a PNG once on mount and shown as an image with its own Share
// button; "Share all" sends every card to the share sheet in one go. On
// phones the share sheet includes "Save Image", so this covers both saving
// and posting.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { shareImages, type ShareOutcome } from '../lib/shareImage'

export interface RecapCardSpec {
  key: string
  title: string
  filename: string
  render: () => Promise<Blob>
}

interface RecapCarouselProps {
  cards: RecapCardSpec[]
  accentColor: string
  shareTitle: string
}

interface Rendered { blob: Blob; url: string }

export default function RecapCarousel({ cards, accentColor, shareTitle }: RecapCarouselProps) {
  const [rendered, setRendered] = useState<Record<string, Rendered | 'error'>>({})
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  // Render every card once. Blob URLs are revoked on unmount.
  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    for (const card of cards) {
      card.render()
        .then((blob) => {
          if (cancelled) return
          const url = URL.createObjectURL(blob)
          urls.push(url)
          setRendered((prev) => ({ ...prev, [card.key]: { blob, url } }))
        })
        .catch((err) => {
          console.error(`Could not render ${card.key}:`, err)
          if (!cancelled) setRendered((prev) => ({ ...prev, [card.key]: 'error' }))
        })
    }
    return () => {
      cancelled = true
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.map((c) => c.key).join('|')])

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const i = Math.round(el.scrollLeft / el.clientWidth)
    if (i !== index) setIndex(i)
  }

  const report = (outcome: ShareOutcome) => {
    if (outcome === 'downloaded') setNote('Saved to your downloads.')
    else setNote(null)
  }

  const share = async (keys: string[]) => {
    if (busy) return
    const images = keys
      .map((k) => ({ card: cards.find((c) => c.key === k), r: rendered[k] }))
      .filter((x): x is { card: RecapCardSpec; r: Rendered } => !!x.card && !!x.r && x.r !== 'error')
      .map(({ card, r }) => ({ blob: r.blob, filename: card.filename }))
    if (images.length === 0) return
    setBusy(keys.join('|'))
    setNote(null)
    try {
      report(await shareImages(images, shareTitle))
    } catch (err) {
      setNote('Could not share: ' + (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const allReady = cards.every((c) => rendered[c.key] && rendered[c.key] !== 'error')

  return (
    <div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        style={{
          display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory',
          gap: 12, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch',
          margin: '0 -4px', padding: '0 4px',
        }}
      >
        {cards.map((card) => {
          const r = rendered[card.key]
          return (
            <div key={card.key} style={{ flex: '0 0 100%', scrollSnapAlign: 'center' }}>
              <div style={{
                borderRadius: 16, overflow: 'hidden', border: '1px solid var(--line)',
                background: 'var(--surface)', aspectRatio: '9 / 16',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {!r ? (
                  <span style={{ color: 'var(--ink-faint)', fontSize: '0.82rem' }}>Making your card…</span>
                ) : r === 'error' ? (
                  <span style={{ color: 'var(--red)', fontSize: '0.82rem' }}>Couldn't make this card</span>
                ) : (
                  <img src={r.url} alt={card.title} style={{ width: '100%', height: '100%', display: 'block' }} />
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 10 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--ink-soft)' }}>{card.title}</span>
                <button
                  onClick={() => share([card.key])}
                  disabled={!r || r === 'error' || !!busy}
                  style={{
                    background: accentColor, border: 'none', color: '#fff',
                    textShadow: '0 1px 2px rgba(0,0,0,0.25)',
                    padding: '10px 16px', borderRadius: 10, fontSize: '0.85rem', fontWeight: 800,
                    cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
                    opacity: !r || r === 'error' ? 0.5 : 1,
                  }}
                >
                  {busy === card.key ? 'Sharing…' : '📤 Share'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Dots + share all */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {cards.map((c, i) => (
            <span key={c.key} style={{
              width: 8, height: 8, borderRadius: '50%',
              background: i === index ? accentColor : 'var(--line-strong)',
              transition: 'background 0.2s',
            }} />
          ))}
        </div>
        {cards.length > 1 && (
          <button
            onClick={() => share(cards.map((c) => c.key))}
            disabled={!allReady || !!busy}
            style={{
              background: 'rgba(var(--ink-rgb), 0.04)', border: '1px solid var(--line-strong)',
              color: 'var(--ink-soft)', padding: '8px 14px', borderRadius: 10,
              fontSize: '0.8rem', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
              opacity: allReady ? 1 : 0.5,
            }}
          >
            Share all {cards.length}
          </button>
        )}
      </div>
      <p style={{ color: 'var(--ink-faint)', fontSize: '0.74rem', textAlign: 'center', margin: '10px 0 0', lineHeight: 1.5 }}>
        Swipe for more. Share opens your phone's share sheet — pick Save Image to keep it.
      </p>
      {note && (
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.78rem', textAlign: 'center', margin: '6px 0 0' }}>{note}</p>
      )}
    </div>
  )
}
