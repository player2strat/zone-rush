// =============================================================================
// Foray — Error boundary
//
// A React render crash anywhere below this component used to leave a blank
// page with the only clue in the developer console. This catches it and shows
// the error text plus a Reload button, so a GM mid-game can recover and can
// tell us exactly what broke.
// =============================================================================

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null; info: string }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render crash:', error, info.componentStack)
    this.setState({ info: info.componentStack ?? '' })
  }

  render() {
    if (!this.state.error) return this.props.children
    const { error, info } = this.state
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--paper, #fbfbf4)', color: 'var(--ink, #111)',
        padding: '32px 20px', fontFamily: 'inherit', boxSizing: 'border-box',
      }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <p style={{ fontSize: '1.1rem', fontWeight: 700, margin: '0 0 8px' }}>Something broke on this screen</p>
          <p style={{ fontSize: '0.88rem', color: 'var(--ink-soft, #444)', margin: '0 0 16px', lineHeight: 1.5 }}>
            Your game data is safe. Reload to get back in. If it happens again, send us the text below.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'var(--marigold, #e8b400)', border: 'none', color: '#111',
              padding: '12px 20px', borderRadius: 10, fontSize: '0.95rem', fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit', marginBottom: 20,
            }}
          >
            Reload
          </button>
          <pre style={{
            background: 'var(--surface, #f2f2ea)', border: '1px solid var(--line, #ddd)', borderRadius: 10,
            padding: 14, fontSize: '0.72rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            color: 'var(--red, #c0392b)', margin: 0, userSelect: 'text',
          }}>
            {error.name}: {error.message}
            {info ? `\n${info.trim().split('\n').slice(0, 8).join('\n')}` : ''}
          </pre>
        </div>
      </div>
    )
  }
}
