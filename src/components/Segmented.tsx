// =============================================================================
// Foray — Segmented switch (admin screens)
//
// A quiet set of choices: a soft grey track with the chosen option on a white
// chip. Used for the Challenge Manager views and filters like the Side Quest
// Explorer's status. Clicking doesn't leave a focus ring; keyboard focus shows
// a soft one (.seg-btn in index.css).
// =============================================================================

/** A quiet two-way switch: a soft grey track with the chosen option on a white chip. */
export default function Segmented<T extends string>({ label, options, value, onChange, small = false }: {
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  onChange: (v: T) => void
  small?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', gap: 2, padding: 3, borderRadius: 10, background: 'rgba(var(--ink-rgb), 0.06)' }}>
      {options.map(([key, name]) => {
        const on = key === value
        return (
          <button
            key={key}
            role="radio"
            aria-checked={on}
            className="seg-btn"
            // Clicking shouldn't leave a focus ring; keyboard focus still shows one.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(key)}
            style={{
              border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              padding: small ? '5px 12px' : '7px 18px', fontSize: small ? '0.78rem' : '0.88rem', fontWeight: on ? 700 : 600,
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--ink)' : 'var(--ink-muted)',
              boxShadow: on ? '0 1px 2px rgba(0, 0, 0, 0.12)' : 'none',
            }}
          >
            {name}
          </button>
        )
      })}
    </div>
  )
}
