// =============================================================================
// Foray — useToast()
//
// The hook and context live here, separate from the <ToastProvider>
// component in components/Toast.tsx, so each file exports one kind of thing
// (React fast-refresh needs component files to export only components).
// =============================================================================

import { createContext, useContext } from 'react'

export type Tone = 'error' | 'success' | 'info'

export interface ToastOptions {
  /** Optional retry handler. Shows a "Retry" button that dismisses the toast and calls this. */
  retry?: () => void | Promise<unknown>
  /** How long the toast stays, in ms. Errors default to 7s, others 4.5s. */
  duration?: number
}

export interface ToastItem {
  id: number
  tone: Tone
  message: string
  retry?: () => void | Promise<unknown>
}

export interface ToastApi {
  error: (message: string, opts?: ToastOptions) => void
  success: (message: string, opts?: ToastOptions) => void
  info: (message: string, opts?: ToastOptions) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

/** Access the toast API. Must be used inside <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
